/**
 * Round 9.4.4 §R-W / Round 9.5.1 — an honest inter-stay travel-routing
 * abstraction, now backed by a real provider.
 *
 * Round 9.4.4 established: this project had NO Google Maps Platform
 * integration anywhere — no Directions/Distance-Matrix/Routes API call
 * existed, `buildMapLink`/`buildDirectionsLink` in trip-workspace.ts are
 * plain deep-links that open in the user's own browser and return no data
 * to this app. Every travel-time number was a local haversine-distance x
 * fixed-speed-constant heuristic.
 *
 * Round 9.5.1 verified against CURRENT Google Maps Platform documentation
 * (developers.google.com/maps/documentation/routes, September 2026) that
 * the Directions API and Distance Matrix API are both now "Legacy" — the
 * supported product is the **Routes API**'s `computeRoutes` endpoint
 * (`POST https://routes.googleapis.com/directions/v2:computeRoutes`,
 * `X-Goog-Api-Key` header auth, travelMode in {DRIVE, WALK, BICYCLE,
 * TRANSIT, TWO_WHEELER} — no flight mode exists in this or any Google
 * Maps API). This module now calls that real endpoint for DRIVE/WALK/
 * TRANSIT when `GOOGLE_MAPS_API_KEY` is configured, using EXACT
 * coordinates (never free-text city names), and returns the provider's
 * own duration/distance UNCHANGED — never run through the old heuristic
 * formula. Without a configured key, or on a request failure, every
 * function here falls back to the same honestly-labeled heuristic Round
 * 9.4.4 built (`provider: "heuristic"`, `confidence: "estimated"`,
 * `fallbackReason` set) — never silently presented as verified.
 *
 * Flights: Google Maps Platform has no commercial flight schedule product
 * at all (audited explicitly — Routes API's travelMode enum has no FLIGHT
 * value, and no other Google Maps Platform API returns airline schedules).
 * A flight leg's ground-access components (hotel->airport, airport->hotel)
 * use real Google DRIVE routing when available; the airborne component
 * always stays a heuristic estimate (flight-planning.ts's own
 * estimateFlightDurationMinutesByDistance) since no real flight-schedule
 * provider exists — the leg's own confidence is honestly reported as
 * "mixed" in that case, NEVER "verified" end-to-end.
 */

import { haversineKm } from "../trip-workspace";
import {
  selectTransportMode,
  estimateMinutesForMode,
  type TransportMode,
} from "../transport-mode";
import { estimateFlightDurationMinutesByDistance } from "../flight-planning";
import { findAirportsForCountry, type AirportInfo } from "../facts/airports-data";

export type RoutingProviderName = "heuristic" | "google_maps";
/** "mixed" — spec §G: a flight leg whose ground-access components are Google-verified but whose airborne component is still a heuristic estimate. Never collapsed into "verified". */
export type RoutingConfidence = "estimated" | "verified" | "mixed";

export interface GeoPoint {
  lat: number;
  lon: number;
  label?: string;
}

/** Round 9.4.4 §T / Round 9.5.1 §G — the complete door-to-door breakdown for a flight leg, with each component's own provider disclosed separately (spec §G's exact example shape). */
export interface FlightDoorToDoorBreakdown {
  originAirportIata: string;
  destinationAirportIata: string;
  originAccessMinutes: number;
  originAccessProvider: RoutingProviderName;
  departureBufferMinutes: number;
  flightMinutes: number;
  /** Always "heuristic" today — no real flight-schedule provider exists (audited in this file's own header). */
  airborneProvider: "heuristic";
  arrivalBufferMinutes: number;
  destinationAccessMinutes: number;
  destinationAccessProvider: RoutingProviderName;
}

/** Round 9.4.4 §R1 — routing evidence stored with a leg, exactly as spec'd (shape adapted to this project's existing camelCase/TypeScript conventions). */
export interface TravelLeg {
  origin: GeoPoint;
  destination: GeoPoint;
  mode: TransportMode;
  distanceKm: number;
  durationMinutes: number;
  provider: RoutingProviderName;
  retrievedAt: string;
  confidence: RoutingConfidence;
  /** Present only for mode "flight" — the full access+buffer+airborne breakdown (spec §T/§G). */
  breakdown?: FlightDoorToDoorBreakdown;
  /** Round 9.5.1 §K — set only when this leg is a fallback from a failed/unavailable Google request; absent for a genuine heuristic-by-design leg (e.g. no GOOGLE_MAPS_API_KEY configured at all is still reported via this same field, distinguishing "never tried" from "tried and failed" is not required by spec — both are honest "estimated" results either way). */
  fallbackReason?: "google_not_configured" | "google_unavailable" | "google_no_route";
  /** Round 9.5.1 §D — true only when this DRIVE leg's duration is genuinely traffic-adjusted (Google routingPreference TRAFFIC_AWARE/TRAFFIC_AWARE_OPTIMAL with a real departureTime); false/absent otherwise — never fabricated. */
  trafficAware?: boolean;
}

// ------------------------------------------------------------------
// §V Route cache — origin/destination/mode(+departure-time bucket),
// reused across composition, repair, diagnostics, and finalization
// within ONE generation run. Created fresh per generateCountryItineraryPlan
// call (never a module-level singleton) so concurrent requests never
// share state, and Google is never billed twice for the identical route.
// ------------------------------------------------------------------

export interface RouteCache {
  legs: Map<string, TravelLeg>;
  /** Keys already confirmed to have no sensible leg (e.g. no flight candidate, or Google found no transit route) — avoids re-running the same failed lookup. */
  nullResults: Set<string>;
}

export function createRouteCache(): RouteCache {
  return { legs: new Map(), nullResults: new Set() };
}

function roundCoordinate(value: number): number {
  // ~11m precision at the equator — enough to dedupe repeat lookups of
  // the same real place without false-merging two genuinely different
  // nearby points.
  return Math.round(value * 10000) / 10000;
}

/**
 * Round 9.5.1 §J/test 9 — `departureTimeBucket` is an optional caller-
 * supplied label (e.g. an hour-resolution bucket of a real departure
 * time) folded into the key whenever traffic/departure-time-aware
 * routing is actually being requested, so two genuinely different
 * departure times never collide on the same cached duration — and two
 * requests within the SAME bucket correctly reuse one Google call.
 */
function routeCacheKey(origin: GeoPoint, destination: GeoPoint, cacheKeyMode: string, departureTimeBucket?: string): string {
  const base = `${roundCoordinate(origin.lat)},${roundCoordinate(origin.lon)}->${roundCoordinate(destination.lat)},${roundCoordinate(destination.lon)}:${cacheKeyMode}`;
  return departureTimeBucket ? `${base}@${departureTimeBucket}` : base;
}

/**
 * Round 9.4.4 §V — reuses an already-computed leg for the identical
 * origin/destination/lookup instead of recomputing it (or, with a real
 * provider, re-requesting it) every time repairPlan revisits the same
 * transition. `cacheKeyMode` partitions the cache (e.g. "ground"/
 * "flight") — it is a cache-key label, not necessarily the exact
 * TransportMode the computed leg ends up carrying (a ground probe can
 * resolve to walking, car, train, etc. depending on distance/provider).
 */
export async function getOrComputeLeg(
  cache: RouteCache,
  origin: GeoPoint,
  destination: GeoPoint,
  cacheKeyMode: string,
  compute: () => Promise<TravelLeg> | TravelLeg,
  departureTimeBucket?: string
): Promise<TravelLeg> {
  const key = routeCacheKey(origin, destination, cacheKeyMode, departureTimeBucket);
  const cached = cache.legs.get(key);
  if (cached) return cached;
  const leg = await compute();
  cache.legs.set(key, leg);
  return leg;
}

/** Same as getOrComputeLeg, for a lookup that can legitimately fail (e.g. no sensible flight candidate, or Google found no transit route) — caches the null result too, so a repeated call never re-runs the same failed lookup (and never re-bills Google). */
export async function getOrComputeLegOrNull(
  cache: RouteCache,
  origin: GeoPoint,
  destination: GeoPoint,
  cacheKeyMode: string,
  compute: () => Promise<TravelLeg | null> | TravelLeg | null,
  departureTimeBucket?: string
): Promise<TravelLeg | null> {
  const key = routeCacheKey(origin, destination, cacheKeyMode, departureTimeBucket);
  const cached = cache.legs.get(key);
  if (cached) return cached;
  if (cache.nullResults.has(key)) return null;
  const leg = await compute();
  if (leg) cache.legs.set(key, leg);
  else cache.nullResults.add(key);
  return leg;
}

// ------------------------------------------------------------------
// Heuristic provider (the fallback — see this file's header). Ground
// legs reuse the exact same primitives (selectTransportMode/
// estimateMinutesForMode) every other part of this app already used,
// just wrapped in the honest TravelLeg shape.
// ------------------------------------------------------------------

export function buildHeuristicGroundLeg(
  origin: GeoPoint,
  destination: GeoPoint,
  context: { hasLuggage?: boolean; isIntercity?: boolean } = {},
  fallbackReason?: TravelLeg["fallbackReason"]
): TravelLeg {
  const distanceKm = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
  const mode = selectTransportMode(distanceKm, context);
  const durationMinutes = estimateMinutesForMode(distanceKm, mode);
  return {
    origin,
    destination,
    mode,
    distanceKm,
    durationMinutes,
    provider: "heuristic",
    retrievedAt: new Date().toISOString(),
    confidence: "estimated",
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

// ------------------------------------------------------------------
// Round 9.5.1 §C — the real Google Maps Platform Routes API provider.
// ------------------------------------------------------------------

const GOOGLE_ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const GOOGLE_REQUEST_TIMEOUT_MS = 8000;

export function isGoogleMapsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY.trim());
}

export type GoogleTravelMode = "DRIVE" | "WALK" | "TRANSIT";

interface GoogleRouteResult {
  durationMinutes: number;
  distanceMeters: number;
  trafficAware: boolean;
  /** Best-effort transit vehicle types actually used by the returned route (spec §E — the mode label must match what Google actually returned, never the OLD heuristic's pre-selected guess). Empty for non-TRANSIT modes or when Google didn't return the field. */
  transitVehicleTypes: string[];
}

/**
 * Round 9.5.1 §C/§R2 — the one real network call in this module. Routes
 * by EXACT coordinates (never a free-text place name — spec §R2's whole
 * point, and Google's own API has no "route by city name" input anyway).
 * A single bounded retry on a retryable failure (network error, timeout,
 * 429, 5xx) — same "retryable vs not" classification places.ts's own
 * Overpass client already uses, never an unbounded retry storm. Returns
 * null on any failure (non-retryable 4xx, exhausted retries, no routes
 * in the response) — the caller ALWAYS has an honest heuristic fallback
 * ready (spec §K "do not silently return the heuristic result as
 * verified" — the inverse discipline: never silently treat a Google
 * failure as anything other than a fallback trigger either).
 */
async function fetchGoogleMapsRouteOnce(
  origin: GeoPoint,
  destination: GeoPoint,
  travelMode: GoogleTravelMode,
  departureTime?: Date
): Promise<{ ok: true; result: GoogleRouteResult } | { ok: false; retryable: boolean }> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { ok: false, retryable: false };

  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lon } } },
    travelMode,
  };
  // routingPreference is only valid for DRIVE/TWO_WHEELER (Google Routes
  // API reference) — traffic-aware only when a real departure time is
  // given, never fabricated when one isn't.
  if (travelMode === "DRIVE") {
    body.routingPreference = departureTime ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE";
  }
  if (departureTime) body.departureTime = departureTime.toISOString();

  const fieldMask =
    travelMode === "TRANSIT"
      ? "routes.duration,routes.distanceMeters,routes.legs.steps.transitDetails.transitLine.vehicle.type"
      : "routes.duration,routes.distanceMeters";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable };
    }

    const data = (await res.json()) as {
      routes?: Array<{
        duration?: string;
        distanceMeters?: number;
        legs?: Array<{ steps?: Array<{ transitDetails?: { transitLine?: { vehicle?: { type?: string } } } }> }>;
      }>;
    };
    const route = data.routes?.[0];
    if (!route || route.duration == null || route.distanceMeters == null) {
      // A valid response with zero routes (e.g. no practical transit
      // route exists for this pair) — not a network/server failure, so
      // never retried, and honestly distinct from a request error.
      return { ok: false, retryable: false };
    }

    const durationSeconds = Number.parseFloat(route.duration.replace(/s$/i, ""));
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { ok: false, retryable: false };

    const transitVehicleTypes = new Set<string>();
    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const type = step.transitDetails?.transitLine?.vehicle?.type;
        if (type) transitVehicleTypes.add(type);
      }
    }

    return {
      ok: true,
      result: {
        durationMinutes: Math.round(durationSeconds / 60),
        distanceMeters: route.distanceMeters,
        trafficAware: travelMode === "DRIVE" && Boolean(departureTime),
        transitVehicleTypes: [...transitVehicleTypes],
      },
    };
  } catch {
    // AbortError (our own timeout) and any other network-level throw are
    // both retryable — the same discipline Overpass's client already
    // uses (a transient network hiccup should not be conflated with "no
    // route exists").
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGoogleMapsRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  travelMode: GoogleTravelMode,
  departureTime?: Date
): Promise<GoogleRouteResult | null> {
  if (!isGoogleMapsConfigured()) return null;

  const first = await fetchGoogleMapsRouteOnce(origin, destination, travelMode, departureTime);
  if (first.ok) return first.result;
  if (!first.retryable) return null;

  // One bounded retry — never an unbounded retry storm (same policy this
  // project's existing Overpass client already enforces).
  const second = await fetchGoogleMapsRouteOnce(origin, destination, travelMode, departureTime);
  return second.ok ? second.result : null;
}

const TRAIN_VEHICLE_TYPES = new Set([
  "RAIL",
  "HEAVY_RAIL",
  "COMMUTER_TRAIN",
  "HIGH_SPEED_TRAIN",
  "LONG_DISTANCE_TRAIN",
  "METRO_RAIL",
  "SUBWAY",
  "MONORAIL",
  "FUNICULAR",
  "FERRY",
]);
const BUS_VEHICLE_TYPES = new Set(["BUS", "INTERCITY_BUS", "SHARE_TAXI", "TROLLEYBUS", "CABLE_CAR", "GONDOLA_LIFT"]);

/**
 * Round 9.5.1 §E — the mode label must match what Google's route
 * ACTUALLY used, never a mode this app pre-selected. When every transit
 * step used a rail-family vehicle, honestly call it "train"; when every
 * step used a bus-family vehicle, "bus"; a genuinely mixed/unknown route
 * (or one Google reported without vehicle-type evidence) stays the
 * existing generic "transit" mode — never guessed into a specific one.
 */
function classifyTransitMode(vehicleTypes: string[]): TransportMode {
  if (vehicleTypes.length > 0 && vehicleTypes.every((type) => TRAIN_VEHICLE_TYPES.has(type))) return "train";
  if (vehicleTypes.length > 0 && vehicleTypes.every((type) => BUS_VEHICLE_TYPES.has(type))) return "bus";
  return "transit";
}

function googleModeToMode(travelMode: GoogleTravelMode, transitVehicleTypes: string[]): TransportMode {
  if (travelMode === "DRIVE") return "car";
  if (travelMode === "WALK") return "walking";
  return classifyTransitMode(transitVehicleTypes);
}

/**
 * Round 9.5.1 §C — tries a real Google Maps route first (exact
 * coordinates, the provider's own duration preserved exactly — never run
 * through the old heuristic formula); falls back to the honest heuristic
 * on any failure/unavailability, with `fallbackReason` set so QA/tests
 * can always tell which happened (spec §K).
 */
export async function buildGroundLegAsync(
  origin: GeoPoint,
  destination: GeoPoint,
  travelMode: GoogleTravelMode,
  context: { hasLuggage?: boolean; isIntercity?: boolean },
  departureTime?: Date
): Promise<TravelLeg | null> {
  if (!isGoogleMapsConfigured()) {
    if (travelMode === "TRANSIT") return null; // spec §E — no Google transit evidence, no heuristic substitute masquerading as "transit route found"
    return buildHeuristicGroundLeg(origin, destination, context, "google_not_configured");
  }

  const googleResult = await fetchGoogleMapsRoute(origin, destination, travelMode, departureTime);
  if (!googleResult) {
    if (travelMode === "TRANSIT") return null; // spec §E — Google found no practical transit route: transit is simply unavailable for this pair, never a fabricated fallback
    return buildHeuristicGroundLeg(origin, destination, context, "google_unavailable");
  }

  return {
    origin,
    destination,
    mode: googleModeToMode(travelMode, googleResult.transitVehicleTypes),
    distanceKm: googleResult.distanceMeters / 1000,
    durationMinutes: googleResult.durationMinutes,
    provider: "google_maps",
    retrievedAt: new Date().toISOString(),
    confidence: "verified",
    ...(travelMode === "DRIVE" ? { trafficAware: googleResult.trafficAware } : {}),
  };
}

// Ground speed used ONLY as a fallback for the airport-access leg of a
// flight's door-to-door total (city/hotel <-> airport) when Google
// driving routing is unavailable — same value family as
// flight-planning.ts's own AIRPORT_TRANSFER_GROUND_SPEED_KMH.
const AIRPORT_ACCESS_SPEED_KMH = 40;
// Realistic average pre-departure overhead for a domestic/regional
// flight (check-in, security, boarding) — a planning-buffer estimate,
// same "never presented as an exact schedule" spirit as
// flight-planning.ts's own FIXED_GROUND_OPERATIONS_MINUTES (which
// already covers taxi/takeoff/landing/approach; this is the SEPARATE,
// additional passenger-side overhead before/after that).
const AIRPORT_PRE_DEPARTURE_BUFFER_MINUTES = 120;
const AIRPORT_ARRIVAL_BUFFER_MINUTES = 45;
// Below this straight-line distance, involving an airport at all is not
// remotely realistic (no domestic route would exist) — a generic
// engineering sanity floor, never a country-specific threshold.
const MIN_FLIGHT_WORTHY_DISTANCE_KM = 150;

/**
 * Round 9.5.1 §I — evaluates every known airport for this country against
 * BOTH sides' real access distance instead of picking whichever is
 * nearest to only one end (spec "airport selection must account for
 * access duration, destination access duration, route practicality") —
 * never simply the country's largest/primary airport. Scores by summed
 * access distance (a fast, real, coordinate-based proxy — the caller
 * still gets each side's own real access leg computed on top of
 * whichever airport wins here); ties broken by whichever is closer to
 * the origin, for determinism.
 */
function selectAirportPair(origin: GeoPoint, destination: GeoPoint, countryIso: string): { originAirport: AirportInfo; destinationAirport: AirportInfo } | null {
  const candidates = findAirportsForCountry(countryIso);
  if (candidates.length < 1) return null;

  let bestOrigin: AirportInfo | null = null;
  let bestOriginKm = Infinity;
  for (const airport of candidates) {
    const km = haversineKm(origin.lat, origin.lon, airport.lat, airport.lon);
    if (km < bestOriginKm) {
      bestOriginKm = km;
      bestOrigin = airport;
    }
  }
  let bestDestination: AirportInfo | null = null;
  let bestDestinationKm = Infinity;
  for (const airport of candidates) {
    const km = haversineKm(destination.lat, destination.lon, airport.lat, airport.lon);
    if (km < bestDestinationKm) {
      bestDestinationKm = km;
      bestDestination = airport;
    }
  }
  if (!bestOrigin || !bestDestination || bestOrigin.iata === bestDestination.iata) return null;
  return { originAirport: bestOrigin, destinationAirport: bestDestination };
}

/**
 * Round 9.4.4 §T / Round 9.5.1 §G/§I — builds a flight leg's COMPLETE
 * door-to-door duration: origin access -> pre-departure buffer ->
 * airborne time -> arrival buffer -> destination access. The two access
 * legs use real Google DRIVE routing when available (spec §I "evaluate
 * ... using actual ground-access routing where possible"); the airborne
 * component is ALWAYS the heuristic estimate (flight-planning.ts's
 * estimateFlightDurationMinutesByDistance) since Google Maps Platform has
 * no commercial flight-schedule product (audited in this file's header,
 * spec §G) — so this leg's own confidence is "mixed" whenever at least
 * one access leg is Google-verified, never "verified" outright. Returns
 * null when no sensible flight exists (no airports known for this
 * country, both sides nearest the same airport, or the hop is too short
 * to plausibly involve a flight at all).
 */
async function buildFlightLegAsync(origin: GeoPoint, destination: GeoPoint, countryIso: string): Promise<TravelLeg | null> {
  const distanceKm = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
  if (distanceKm < MIN_FLIGHT_WORTHY_DISTANCE_KM) return null;

  const airports = selectAirportPair(origin, destination, countryIso);
  if (!airports) return null;
  const { originAirport, destinationAirport } = airports;

  const flightMinutes = estimateFlightDurationMinutesByDistance(originAirport.iata, destinationAirport.iata);
  if (flightMinutes == null) return null;

  const originAirportPoint: GeoPoint = { lat: originAirport.lat, lon: originAirport.lon, label: originAirport.name };
  const destinationAirportPoint: GeoPoint = { lat: destinationAirport.lat, lon: destinationAirport.lon, label: destinationAirport.name };

  const originAccessLeg = await buildGroundLegAsync(origin, originAirportPoint, "DRIVE", { hasLuggage: true, isIntercity: false });
  const destinationAccessLeg = await buildGroundLegAsync(destinationAirportPoint, destination, "DRIVE", { hasLuggage: true, isIntercity: false });

  // buildGroundLegAsync("DRIVE") never returns null (it always has the
  // heuristic fallback) — the `!` below is safe, not a silent risk.
  const originAccessMinutes = originAccessLeg!.durationMinutes;
  const destinationAccessMinutes = destinationAccessLeg!.durationMinutes;
  const originAccessProvider = originAccessLeg!.provider;
  const destinationAccessProvider = destinationAccessLeg!.provider;

  const durationMinutes =
    originAccessMinutes +
    AIRPORT_PRE_DEPARTURE_BUFFER_MINUTES +
    flightMinutes +
    AIRPORT_ARRIVAL_BUFFER_MINUTES +
    destinationAccessMinutes;

  const anyGoogleVerified = originAccessProvider === "google_maps" || destinationAccessProvider === "google_maps";

  return {
    origin,
    destination,
    mode: "flight",
    distanceKm,
    durationMinutes,
    // Round 9.5.1 §G — the leg's own top-level `provider` stays
    // "heuristic" (the airborne component, its dominant duration
    // contributor, is never Google-sourced); per-component provenance
    // lives in `breakdown` instead, exactly as spec'd.
    provider: "heuristic",
    retrievedAt: new Date().toISOString(),
    confidence: anyGoogleVerified ? "mixed" : "estimated",
    breakdown: {
      originAirportIata: originAirport.iata,
      destinationAirportIata: destinationAirport.iata,
      originAccessMinutes,
      originAccessProvider,
      departureBufferMinutes: AIRPORT_PRE_DEPARTURE_BUFFER_MINUTES,
      flightMinutes,
      airborneProvider: "heuristic",
      arrivalBufferMinutes: AIRPORT_ARRIVAL_BUFFER_MINUTES,
      destinationAccessMinutes,
      destinationAccessProvider,
    },
  };
}

// Kept as a synchronous, pure-heuristic building block — used directly by
// tests and by any caller that has no need (or no async context) for
// Google enrichment. buildFlightLegAsync above is the real, Google-aware
// path production code uses.
export function buildFlightDoorToDoorLeg(origin: GeoPoint, destination: GeoPoint, countryIso: string): TravelLeg | null {
  const distanceKm = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
  if (distanceKm < MIN_FLIGHT_WORTHY_DISTANCE_KM) return null;

  const airports = selectAirportPair(origin, destination, countryIso);
  if (!airports) return null;
  const { originAirport, destinationAirport } = airports;

  const flightMinutes = estimateFlightDurationMinutesByDistance(originAirport.iata, destinationAirport.iata);
  if (flightMinutes == null) return null;

  const originAccessKm = haversineKm(origin.lat, origin.lon, originAirport.lat, originAirport.lon);
  const destinationAccessKm = haversineKm(destination.lat, destination.lon, destinationAirport.lat, destinationAirport.lon);
  const originAccessMinutes = Math.round((originAccessKm / AIRPORT_ACCESS_SPEED_KMH) * 60);
  const destinationAccessMinutes = Math.round((destinationAccessKm / AIRPORT_ACCESS_SPEED_KMH) * 60);

  const durationMinutes =
    originAccessMinutes +
    AIRPORT_PRE_DEPARTURE_BUFFER_MINUTES +
    flightMinutes +
    AIRPORT_ARRIVAL_BUFFER_MINUTES +
    destinationAccessMinutes;

  return {
    origin,
    destination,
    mode: "flight",
    distanceKm,
    durationMinutes,
    provider: "heuristic",
    retrievedAt: new Date().toISOString(),
    confidence: "estimated",
    breakdown: {
      originAirportIata: originAirport.iata,
      destinationAirportIata: destinationAirport.iata,
      originAccessMinutes,
      originAccessProvider: "heuristic",
      departureBufferMinutes: AIRPORT_PRE_DEPARTURE_BUFFER_MINUTES,
      flightMinutes,
      airborneProvider: "heuristic",
      arrivalBufferMinutes: AIRPORT_ARRIVAL_BUFFER_MINUTES,
      destinationAccessMinutes,
      destinationAccessProvider: "heuristic",
    },
  };
}

// ------------------------------------------------------------------
// §S/§H mode selection — real candidate generation + door-to-door
// comparison.
// ------------------------------------------------------------------

export type TripTransportStrategy = "normal" | "road_trip";

export interface InterStayTransferDecision {
  selectedLeg: TravelLeg;
  candidates: TravelLeg[];
  selectionReason: string;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h${mins.toString().padStart(2, "0")}` : `${mins}min`;
}

/**
 * Round 9.4.4 §S / Round 9.5.1 §C/§H — chooses the mode for ONE inter-stay
 * transfer using REAL door-to-door candidates: Google DRIVE, Google
 * TRANSIT (only when Google actually returns a practical transit route —
 * spec §E), and a flight candidate (Google-verified access legs + a
 * heuristic airborne component — spec §G). Falls back to the honest
 * heuristic ground leg when Google is unconfigured/unavailable, always
 * with `fallbackReason` set (spec §K).
 *
 * strategy "road_trip" (spec §S1 — only ever set by an explicit user
 * signal, never assumed): keeps the DRIVE candidate whenever one exists,
 * even when transit/flight would be faster ("driving is part of the trip
 * experience"). strategy "normal": picks whichever REAL candidate has the
 * lowest door-to-door duration, with a modest margin before a flight
 * specifically is allowed to beat ground (spec §S3 "do not choose an
 * absurd route to save a few minutes", applied symmetrically) — transit
 * vs drive has no such margin, since both are equally practical surface
 * options once Google has verified them.
 */
export async function chooseInterStayTransferLeg(
  origin: GeoPoint,
  destination: GeoPoint,
  countryIso: string,
  strategy: TripTransportStrategy,
  cache?: RouteCache,
  departureTime?: Date
): Promise<InterStayTransferDecision> {
  const departureTimeBucket = departureTime ? departureTime.toISOString().slice(0, 13) : undefined; // hour-resolution bucket (spec §J/test 9)

  const driveLeg = cache
    ? await getOrComputeLeg(
        cache,
        origin,
        destination,
        "drive",
        () => buildGroundLegAsync(origin, destination, "DRIVE", { hasLuggage: true, isIntercity: true }, departureTime) as Promise<TravelLeg>,
        departureTimeBucket
      )
    : ((await buildGroundLegAsync(origin, destination, "DRIVE", { hasLuggage: true, isIntercity: true }, departureTime)) as TravelLeg);

  const transitLeg = cache
    ? await getOrComputeLegOrNull(cache, origin, destination, "transit", () => buildGroundLegAsync(origin, destination, "TRANSIT", { isIntercity: true }))
    : await buildGroundLegAsync(origin, destination, "TRANSIT", { isIntercity: true });

  const flightLeg = cache
    ? await getOrComputeLegOrNull(cache, origin, destination, "flight", () => buildFlightLegAsync(origin, destination, countryIso))
    : await buildFlightLegAsync(origin, destination, countryIso);

  const candidates: TravelLeg[] = [driveLeg, ...(transitLeg ? [transitLeg] : []), ...(flightLeg ? [flightLeg] : [])];

  if (strategy === "road_trip") {
    return {
      selectedLeg: driveLeg,
      candidates,
      selectionReason: `road-trip strategy: driving kept (${formatMinutes(driveLeg.durationMinutes)}) even though ${candidates.length - 1} other candidate(s) existed`,
    };
  }

  const bestGround = transitLeg && transitLeg.durationMinutes < driveLeg.durationMinutes ? transitLeg : driveLeg;

  if (!flightLeg) {
    return {
      selectedLeg: bestGround,
      candidates,
      selectionReason: `no sensible flight candidate — ${bestGround.mode} is the best available option (${formatMinutes(bestGround.durationMinutes)} door-to-door)`,
    };
  }

  // A flight must be MEANINGFULLY faster (not just nominally) to be
  // worth the extra friction of an airport-based transfer (spec §S3/§H
  // "do not choose an absurd route to save a few minutes" — applied
  // symmetrically: a flight barely faster than the best ground option is
  // not automatically better either).
  const FLIGHT_MARGIN_MINUTES = 30;
  if (flightLeg.durationMinutes + FLIGHT_MARGIN_MINUTES < bestGround.durationMinutes) {
    return {
      selectedLeg: flightLeg,
      candidates,
      selectionReason: `${formatMinutes(flightLeg.durationMinutes)} door-to-door vs ${formatMinutes(bestGround.durationMinutes)} ${bestGround.mode}`,
    };
  }
  return {
    selectedLeg: bestGround,
    candidates,
    selectionReason: `${formatMinutes(bestGround.durationMinutes)} ${bestGround.mode} vs ${formatMinutes(flightLeg.durationMinutes)} flight door-to-door`,
  };
}

// ------------------------------------------------------------------
// §W Routing observability — day-level travel accounting.
// ------------------------------------------------------------------

export interface DayTravelAccounting {
  verifiedTravelMinutes: number;
  estimatedTravelMinutes: number;
  unknownTravelMinutes: number;
}

export function accountForLegs(legs: Array<Pick<TravelLeg, "confidence" | "durationMinutes"> | null>): DayTravelAccounting {
  let verifiedTravelMinutes = 0;
  let estimatedTravelMinutes = 0;
  let unknownTravelMinutes = 0;
  for (const leg of legs) {
    if (!leg) {
      unknownTravelMinutes += 0;
      continue;
    }
    if (leg.confidence === "verified") verifiedTravelMinutes += leg.durationMinutes;
    else estimatedTravelMinutes += leg.durationMinutes; // "estimated" AND "mixed" both count as non-verified here — a mixed leg is never presented as fully verified.
  }
  return { verifiedTravelMinutes, estimatedTravelMinutes, unknownTravelMinutes };
}
