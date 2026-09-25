/**
 * Round 9.3 — AI-FIRST STAY SKELETON, THEN LOCAL POI DISCOVERY.
 *
 * ROOT CAUSE this module fixes (see the Round 9.3 final report for the
 * full trace): buildDeterministicTripFrame's own geographic clustering
 * (planClustersByRole -> clusterActivityCandidates, country-itinerary-
 * generation.ts) derives EVERY area it knows about from real coordinates
 * already present in payload.recommendations/selectedPlaces. Round 9.2
 * correctly removed the client's country-wide POI prefetch (that data was
 * never meant to be the planner's authoritative source), but nothing
 * replaced it as a source of GEOGRAPHIC STRUCTURE — with zero candidates,
 * clustering finds zero areas, `rankedAreas.length === 0`, and
 * buildDeterministicTripFrame's own documented fallback
 * (`rankedAreas = [countryName]`) becomes the ENTIRE trip: one phase,
 * "United States", spanning all 42 days, every day owned by the country
 * itself. This module is the missing layer: decide WHERE to base the trip
 * (cities/regions/national-park/island bases), resolved through REAL
 * geocoding, BEFORE any local POI discovery, activity pool, meal pool, or
 * portfolio work ever runs.
 *
 * Deliberately pure except `resolveProposedStay` (the one function that
 * makes a real network call, via the existing rate-limited Nominatim
 * client already used by city-normalization.ts — no new geocoding stack
 * invented here).
 */

import { searchPlaces, reverseGeocode, type GeocodedPlace } from "@/lib/places/nominatim";
import { buildCityCanonicalId } from "@/lib/city-normalization";
import { findAirportByIata } from "@/lib/facts/airports-data";
import {
  buildTripFramePhases,
  getTripLengthBucket,
  optimizeStayRouteSequence,
  OVERNIGHT_WORTHY_MINUTES,
  type StayRouteNode,
  type TripFrame,
  type TripFramePhase,
} from "@/lib/server/itinerary-planning-principles";
import { estimateDayActivityTarget, type StayActivityPool, type StayDayCapacityInput } from "@/lib/server/stay-activity-pool";
import type { StayMealVenuePool } from "@/lib/server/stay-meal-venue-pool";
import { haversineKm, type AiItineraryRequest } from "@/lib/trip-workspace";
import { logRealPlaceQA } from "@/lib/server/real-place-qa";

/* ------------------------------------------------------------------ *
 * 1. ProposedStay — Gemini's (or the deterministic fallback's) OWN     *
 *    high-level geographic proposal. No POI names, ever (spec §3).    *
 * ------------------------------------------------------------------ */

export interface ProposedStay {
  proposedId: string;
  areaName: string;
  nights: number;
  reasons: string[];
}

/* ------------------------------------------------------------------ *
 * 2. ResolvedStay — every proposed stay resolved through the EXISTING *
 *    geography stack (Nominatim, spec §6) — never Gemini text alone.  *
 * ------------------------------------------------------------------ */

export type StaySkeletonSource = "gemini_resolved" | "fallback_cluster" | "pinned" | "single_base_fallback" | "region_expansion";

export interface ResolvedStay {
  stayId: string;
  proposedId: string | null;
  areaLabel: string;
  lat: number;
  lon: number;
  nights: number;
  reasons: string[];
  source: StaySkeletonSource;
  confidence: "high" | "medium" | "low";
  countryIso: string;
  /** Round 9.4 §B — observability only, never read by any planning logic: what the geocoder actually returned, and via which admin path, so a shape like "White Mountains Community College" (amenity=college) becoming a stay can finally be told apart from a genuine place=town/city at the exact point it happens. */
  proposedName?: string;
  resolvedObjectType?: string;
  resolvedClass?: string;
  resolvedType?: string;
  adminPath?: string;
  /** Round 9.6.5 §A — observability only: set when this stay's anchor came from a derived practical base near a destination concept (a peninsula, island, mountain range, ...) rather than the destination's own direct geocode. */
  derivedBaseName?: string;
  derivedBaseSource?: "nominatim_reverse_geocode";
}

// Round 9.6.2 §4 / 9.6.5 §A — a broad region (New England, Tuscany, Kansai,
// Andalusia, Patagonia) must never silently become a lodging locality just
// because Nominatim returns SOME match for its name. Generic, worldwide,
// and based entirely on OSM's own standard semantics — never a specific
// place name.
const PARK_STAY_PLACE_TYPES = new Set(["national_park", "protected_area", "nature_reserve"]);
const SETTLEMENT_ADDRESS_KEYS = ["city", "town", "village", "municipality", "hamlet", "suburb", "borough", "island", "islet", "locality"];

/**
 * Round 9.16 §10 — the generic (never a specific place name) semantic guard
 * against the proven "White Mountains Community College" failure shape: a
 * match whose OWN Nominatim `class` is a specific point-of-interest,
 * institution, or individual business is never a lodging region, no matter
 * what settlement its own address happens to be located inside — the old
 * SETTLEMENT_ADDRESS_KEYS shortcut below used to grant `practical_base` to
 * ANY match with a "city"/"town"/etc. address key, which a college campus
 * (class="amenity", type="college") satisfies just as trivially as a real
 * settlement does, since it is genuinely located inside one. This is
 * Nominatim's own generic top-level class taxonomy — never an enumerated
 * list of specific venues/institutions by name, so it generalizes to any
 * country's data exactly like classifyStayDestination's other checks.
 */
const NON_SETTLEMENT_POI_PLACE_CLASSES = new Set(["amenity", "shop", "tourism", "office", "historic", "craft", "healthcare", "man_made"]);

/**
 * Round 9.6.5 §A — the destination-vs-lodging-base distinction. A stay
 * proposal can be:
 *  - "practical_base": already a real, lodging-ready locality (a
 *    settlement, or a park/protected-area gateway — travelers genuinely
 *    book lodging "in" a national park).
 *  - "destination_needs_base": a genuine, real, resolvable travel
 *    destination CONCEPT (Cape Cod, a peninsula; a named island's own
 *    coastline point; a mountain range; a bay; a wine/lake/coastal
 *    region resolving to a natural/water/landuse feature rather than an
 *    administrative boundary) — valid as a trip-phase concept, but never
 *    itself a hotel-search anchor. The caller must derive a real
 *    settlement near it before it can anchor discovery.
 *  - "rejected": an administrative boundary with no settlement-level
 *    address key (a state, a country, an informal multi-state region) —
 *    Round 9.6.2 §4's own protection, unchanged: these never
 *    automatically become a lodging base just because they geocode, and
 *    are never treated as an auto-derivable destination either (deriving
 *    "a" town for an entire state/country would be arbitrary, not a
 *    genuine destination resolution).
 *
 * The generic, non-hardcoded distinguishing signal: Nominatim's own
 * `class` field. "place" (settlements) and the specific park/protected-
 * area types are lodging-ready. "boundary" (administrative) with no
 * settlement key is a political division, not a destination. Every OTHER
 * classified match — natural, water, leisure (non-park), landuse, etc. —
 * is a genuine physical/geographic feature: exactly the space peninsulas,
 * islands-as-natural-features, mountain ranges, bays, and informal
 * region concepts occupy. This never enumerates specific destination
 * TYPES (no "peninsula" allowlist) — it is a structural class
 * distinction that generalizes to any country's data.
 */
export type StayDestinationClassification =
  | { kind: "practical_base" }
  | { kind: "destination_needs_base" }
  | { kind: "rejected"; reason: string };

export function classifyStayDestination(
  match: Pick<GeocodedPlace, "placeClass" | "placeType" | "addressComponents">
): StayDestinationClassification {
  // Fail-open by design (spec §5 "backward compatibility matters"): a
  // match carrying NONE of Nominatim's classification fields at all (a
  // test double, or any geocoder response shape that predates this
  // check) is never rejected on that basis alone.
  if (!match.placeClass && !match.placeType && !match.addressComponents) return { kind: "practical_base" };
  if (match.placeClass === "place") return { kind: "practical_base" };
  if (match.placeType && PARK_STAY_PLACE_TYPES.has(match.placeType)) return { kind: "practical_base" };
  // Round 9.16 §10 — checked BEFORE the settlement-address-key shortcut
  // below on purpose: an individual POI/institution/business must never
  // win that shortcut merely because it sits inside a real settlement.
  if (match.placeClass && NON_SETTLEMENT_POI_PLACE_CLASSES.has(match.placeClass)) {
    return {
      kind: "rejected",
      reason: `a specific point of interest/institution (${match.placeClass}${match.placeType ? `/${match.placeType}` : ""}) — never a lodging region merely because its own address happens to include a settlement field`,
    };
  }
  if (match.addressComponents) {
    const keys = Object.keys(match.addressComponents);
    if (SETTLEMENT_ADDRESS_KEYS.some((key) => keys.includes(key))) return { kind: "practical_base" };
  }
  if (match.placeClass === "boundary") {
    return { kind: "rejected", reason: "administrative boundary (state/country/region) with no settlement-level address — never an automatic lodging base" };
  }
  if (!match.placeClass) {
    return { kind: "rejected", reason: "no usable classification and no settlement-level address — cannot be verified as a real destination or base" };
  }
  return { kind: "destination_needs_base" };
}

/** Backward-compatible boolean view, kept for existing callers/tests that only need the base/not-base question. */
export function isPracticalStayLocality(match: Pick<GeocodedPlace, "placeClass" | "placeType" | "addressComponents">): boolean {
  return classifyStayDestination(match).kind === "practical_base";
}

/**
 * Round 9.6.5 §A.3 — derives a real, practical settlement near a
 * destination CONCEPT that resolved successfully but isn't itself a
 * lodging locality (a peninsula, a natural island point, a mountain
 * range, ...). Reverse-geocodes the destination's OWN coordinates at
 * city/town zoom (Nominatim's own "give me the containing settlement for
 * this point" granularity) — never a fabricated or arbitrary coordinate;
 * if Nominatim itself cannot resolve a real settlement there, this
 * returns null and the caller must treat the whole proposal as
 * unresolved, never silently using the destination's own coordinates as
 * a stand-in lodging anchor.
 */
export async function derivePracticalBaseNearDestination(
  destination: { lat: number; lon: number },
  reverseGeocodeOverride?: typeof reverseGeocode
): Promise<GeocodedPlace | null> {
  const reverse = reverseGeocodeOverride ?? reverseGeocode;
  const derived = await reverse(destination.lat, destination.lon, { zoom: 10 });
  if (!derived || !Number.isFinite(derived.lat) || !Number.isFinite(derived.lon)) return null;
  if (classifyStayDestination(derived).kind !== "practical_base") return null;
  return derived;
}

/**
 * Resolves ONE proposed area name through the real Nominatim geocoder
 * (identical call shape to city-normalization.ts's own canonicalizeItineraryCities
 * — same rate-limited client, same country-code bias, same "never throw,
 * return null on any failure" contract). A hallucinated/unresolvable area
 * name returns null — the caller must reject it, never substitute the
 * country centroid (spec §6/§7).
 */
export async function resolveProposedStay(
  proposed: ProposedStay,
  isoA2: string,
  source: StaySkeletonSource = "gemini_resolved",
  /** Injectable — tests pass a fake to avoid any real Nominatim network call; production omits this and gets the real searchPlaces-backed default (same function city-normalization.ts already uses). */
  searchPlacesOverride?: typeof searchPlaces,
  /** Injectable — tests pass a fake to avoid any real Nominatim reverse-geocode network call. */
  reverseGeocodeOverride?: typeof reverseGeocode
): Promise<ResolvedStay | null> {
  try {
    const search = searchPlacesOverride ?? searchPlaces;
    const [match] = await search(proposed.areaName, { countryCode: isoA2, limit: 1 });
    if (!match || !Number.isFinite(match.lat) || !Number.isFinite(match.lon)) return null;

    const classification = classifyStayDestination(match);

    if (classification.kind === "rejected") {
      logRealPlaceQA("StayDestinationResolution", {
        proposedStay: proposed.areaName,
        resolvedFeatureClass: match.placeClass,
        resolvedFeatureType: match.placeType,
        destinationValid: false,
        practicalBaseValid: false,
        derivedBase: null,
        derivedBaseSource: null,
        rejectionReason: classification.reason,
      });
      return null;
    }

    if (classification.kind === "destination_needs_base") {
      // Round 9.6.5 §A.3 — a valid destination CONCEPT (e.g. a peninsula,
      // island, mountain range, bay) that is not itself a lodging
      // locality: derive a real, practical settlement near it before
      // this can anchor discovery. Never uses the destination's own
      // coordinates directly as a stand-in lodging anchor.
      const derived = await derivePracticalBaseNearDestination(match, reverseGeocodeOverride);
      logRealPlaceQA("StayDestinationResolution", {
        proposedStay: proposed.areaName,
        resolvedFeatureClass: match.placeClass,
        resolvedFeatureType: match.placeType,
        destinationValid: true,
        practicalBaseValid: derived != null,
        derivedBase: derived?.name ?? null,
        derivedBaseSource: derived ? "nominatim_reverse_geocode" : null,
        rejectionReason: derived ? null : "destination is real but no practical settlement could be derived near it — never fabricated",
      });
      if (!derived) return null;
      return {
        stayId: buildCityCanonicalId(isoA2, derived.lat, derived.lon),
        proposedId: proposed.proposedId,
        // The destination's OWN name stays the traveler-facing area label
        // (spec §3: "a broad/area destination may be a valid trip phase
        // concept") — only the ANCHOR coordinates come from the derived
        // practical base, never the reverse.
        areaLabel: match.name || proposed.areaName,
        lat: derived.lat,
        lon: derived.lon,
        nights: Math.max(0, Math.round(proposed.nights)),
        reasons: proposed.reasons,
        source,
        confidence: "medium",
        countryIso: isoA2,
        proposedName: proposed.areaName,
        resolvedObjectType: match.osmType,
        resolvedClass: match.placeClass,
        resolvedType: match.placeType,
        adminPath: match.adminPath,
        derivedBaseName: derived.name,
        derivedBaseSource: "nominatim_reverse_geocode",
      };
    }

    logRealPlaceQA("StayDestinationResolution", {
      proposedStay: proposed.areaName,
      resolvedFeatureClass: match.placeClass,
      resolvedFeatureType: match.placeType,
      destinationValid: true,
      practicalBaseValid: true,
      derivedBase: null,
      derivedBaseSource: null,
      rejectionReason: null,
    });
    return {
      stayId: buildCityCanonicalId(isoA2, match.lat, match.lon),
      proposedId: proposed.proposedId,
      areaLabel: match.name || proposed.areaName,
      lat: match.lat,
      lon: match.lon,
      nights: Math.max(0, Math.round(proposed.nights)),
      reasons: proposed.reasons,
      source,
      confidence: "high",
      countryIso: isoA2,
      proposedName: proposed.areaName,
      resolvedObjectType: match.osmType,
      resolvedClass: match.placeClass,
      resolvedType: match.placeType,
      adminPath: match.adminPath,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves every proposed stay. Nominatim's own client-side throttle
 * (nominatim.ts's module-level request queue, ~1 req/sec) already
 * serializes every call regardless of how many are fired at once — a
 * second concurrency limiter here would just duplicate that bound, so this
 * is a plain Promise.all (spec §18: reuse the existing bound, never stack
 * a second one on top).
 */
export async function resolveStaySkeleton(
  proposedStays: ProposedStay[],
  isoA2: string,
  source: StaySkeletonSource = "gemini_resolved",
  searchPlacesOverride?: typeof searchPlaces,
  reverseGeocodeOverride?: typeof reverseGeocode
): Promise<{ resolved: ResolvedStay[]; unresolvedCount: number }> {
  const results = await Promise.all(proposedStays.map((proposed) => resolveProposedStay(proposed, isoA2, source, searchPlacesOverride, reverseGeocodeOverride)));
  const resolved = results.filter((stay): stay is ResolvedStay => stay != null);
  return { resolved, unresolvedCount: results.length - resolved.length };
}

/* ------------------------------------------------------------------ *
 * 3. Deduplication — spec §6/test F                                    *
 * ------------------------------------------------------------------ */

/**
 * Canonicalizes/dedupes resolved stays sharing the same real-world
 * location (same ~1km grid cell as buildCityCanonicalId already uses
 * trip-wide for cityRegion canonicalization) — two proposed stays that
 * geocode to the same place merge into one, summing their nights and
 * reasons rather than creating two competing phases for the same city.
 */
export function dedupeResolvedStays(stays: ResolvedStay[]): ResolvedStay[] {
  const byStayId = new Map<string, ResolvedStay>();
  for (const stay of stays) {
    const existing = byStayId.get(stay.stayId);
    if (!existing) {
      byStayId.set(stay.stayId, { ...stay });
      continue;
    }
    existing.nights += stay.nights;
    existing.reasons = [...new Set([...existing.reasons, ...stay.reasons])];
  }
  return [...byStayId.values()];
}

/* ------------------------------------------------------------------ *
 * 4. Deterministic fallback skeleton (spec §8) — Gemini must never be   *
 *    a single point of failure.                                        *
 * ------------------------------------------------------------------ */

const MUST_VISIT_SPLIT_PATTERN = /[,\n;]|(?:\s+ו-?\s+)|(?:\s+and\s+)/gi;

/**
 * Derives a real candidate list of PLACE NAMES worth geocoding — never
 * invented, always taken from something the traveler or the flight data
 * actually said: must-visit free text, the arrival airport's own city, and
 * the departure airport's own city (when different). Every one of these is
 * still resolved through resolveProposedStay below (spec §6) before it can
 * become a real stay — this function only proposes candidate NAMES.
 */
export function deterministicFallbackSkeleton(payload: AiItineraryRequest): ProposedStay[] {
  const proposals: ProposedStay[] = [];
  const seenNames = new Set<string>();
  let counter = 0;

  const addName = (areaName: string, reasons: string[]) => {
    const trimmed = areaName.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    counter += 1;
    proposals.push({ proposedId: `fallback-${counter}`, areaName: trimmed, nights: 1, reasons });
  };

  const arrivalIata = payload.preferences.flights?.outbound?.arrivalAirport || null;
  const arrivalAirport = arrivalIata ? findAirportByIata(arrivalIata) : null;
  if (arrivalAirport) addName(arrivalAirport.city, ["arrival"]);

  const departureIata = payload.preferences.flights?.return?.departureAirport || null;
  const departureAirport = departureIata ? findAirportByIata(departureIata) : null;
  if (departureAirport) addName(departureAirport.city, ["departure"]);

  const mustVisitText = payload.preferences.mustVisitPlaces?.trim();
  if (mustVisitText) {
    const names = mustVisitText.split(MUST_VISIT_SPLIT_PATTERN).map((s) => s.trim()).filter(Boolean);
    for (const name of names) addName(name, ["must_visit"]);
  }

  const preferredRegionsText = payload.preferences.preferredRegions?.trim();
  if (preferredRegionsText) {
    const names = preferredRegionsText.split(MUST_VISIT_SPLIT_PATTERN).map((s) => s.trim()).filter(Boolean);
    for (const name of names) addName(name, ["preferred_region"]);
  }

  // Weight explicit traveler intent (must_visit/preferred_region) above
  // pure structural anchors (arrival/departure) so a trip with real
  // must-visit content doesn't get diluted into equal-weight arrival/
  // departure stops it never actually asked for.
  for (const proposal of proposals) {
    if (proposal.reasons.includes("must_visit") || proposal.reasons.includes("preferred_region")) proposal.nights = 3;
  }

  return proposals;
}

/**
 * The absolute last resort (spec §8's own explicit floor — "do not use
 * country name as the only phase unless the trip genuinely warrants a
 * country-sized single base"): when NOTHING else yielded a single real
 * place name (no must-visit text, no preferred region, no flights at
 * all), this proposes the country's own name as ONE geocodable place —
 * still resolved through the real geocoder (so it becomes the country's
 * actual primary city/centroid coordinates, never a bare unresolved
 * string), and honestly tagged `single_base_fallback` rather than
 * disguised as a confident city-level resolution.
 */
export function buildSingleBaseFallbackProposal(payload: AiItineraryRequest): ProposedStay {
  return { proposedId: "single-base-fallback", areaName: payload.countryName, nights: 1, reasons: ["single_base_fallback"] };
}

/* ------------------------------------------------------------------ *
 * 5. Skeleton validation (spec §9) — accepted BEFORE POI discovery.    *
 * ------------------------------------------------------------------ */

export interface StaySkeletonValidationReport {
  resolvedStayCount: number;
  countryLevelStayCount: number;
  unresolvedStayCount: number;
  duplicateStayCount: number;
  zeroNightStayCount: number;
  uncoveredTripNights: number;
  /** True only when the skeleton is genuinely usable as-is — the caller still owns what to do on failure (retry/fallback/surface a structured error), this never mutates or repairs anything itself. */
  valid: boolean;
}

/**
 * Pure validator — never fabricates, never repairs. `dedupedCount` lets the
 * caller report how many raw resolved entries collapsed into
 * `stays.length` after dedupeResolvedStays, without this function needing
 * to re-run dedup logic itself.
 */
export function validateTripStaySkeleton(
  stays: ResolvedStay[],
  unresolvedCount: number,
  totalTripNights: number,
  countryName: string,
  dedupedCount = 0
): StaySkeletonValidationReport {
  const normalizedCountry = countryName.trim().toLowerCase();
  const countryLevelStayCount = stays.filter(
    (stay) => stay.areaLabel.trim().toLowerCase() === normalizedCountry && stay.source !== "single_base_fallback"
  ).length;
  const zeroNightStayCount = stays.filter((stay) => stay.nights <= 0).length;
  const totalAllocatedNights = stays.reduce((sum, stay) => sum + stay.nights, 0);
  // Nights are only really "allocated" once buildTripFrameFromResolvedStays
  // runs (this validator sees each stay's own PROPOSED weight, not its
  // final night count) — uncoveredTripNights here is a coarse pre-check
  // (is there enough combined proposed weight to plausibly cover the whole
  // trip), not the authoritative post-allocation figure.
  const uncoveredTripNights = Math.max(0, totalTripNights - totalAllocatedNights);

  const valid = stays.length > 0 && countryLevelStayCount === 0 && zeroNightStayCount === 0;

  return {
    resolvedStayCount: stays.length,
    countryLevelStayCount,
    unresolvedStayCount: unresolvedCount,
    duplicateStayCount: dedupedCount,
    zeroNightStayCount,
    uncoveredTripNights,
    valid,
  };
}

/* ------------------------------------------------------------------ *
 * 5b. Round 9.16 — TRIP-COVERAGE VALIDITY, a SEPARATE dimension from    *
 *     geographic validity (validateTripStaySkeleton above). A skeleton  *
 *     whose few stays all resolve to real, geocodable places is         *
 *     GEOGRAPHICALLY_VALID — Round 9.15.11's proven regression shows    *
 *     that alone is not enough: 2 real, valid stays covering only ~3 of *
 *     36 trip nights (each stay's own raw pre-allocation weight) is      *
 *     geographically fine and still a broken result once night-         *
 *     allocation stretches it to fill the whole trip. This is the       *
 *     missing invariant: TRIP_COVERAGE_VALID.                           *
 * ------------------------------------------------------------------ */

/** Round 9.16 §3/§4 — the hard safety ceiling for one lodging base in the current architecture. A MAXIMUM, never a default/desired duration — see StayCapacityProfile below for what actually decides a stay's recommended length within that ceiling. */
export const MAX_STAY_NIGHTS = 14;

/** Round 9.16 §5 — the one hard, non-negotiable LOWER bound the ceiling above implies (a trip this long cannot possibly fit inside fewer stays). Never used as the desired/default stay count — real coverage/capacity evidence decides that (evaluateStaySkeletonCoverage, region expansion). */
export function computeMinimumRequiredStayCount(tripNights: number): number {
  return Math.max(1, Math.ceil(Math.max(0, tripNights) / MAX_STAY_NIGHTS));
}

/** Round 9.16 §8 — a stay's real activity supply measured against what its OWN (proposed or allocated) night count actually needs: the "is this stay inventory-starved" signal the allocator/expansion stage must be able to see, rather than silently piling on more FreeTime. */
export interface StayInventoryPressure {
  stayId: string;
  areaLabel: string;
  nights: number;
  requiredActivityCapacity: number;
  availableRelevantActivityCapacity: number;
  capacityRatio: number;
  starved: boolean;
}

/** Same rough "~3 meaningful activities per night" scale computeStayValueProfile/adjustStayWeightForSupply already use elsewhere in this file — never a second, different constant. */
const REQUIRED_ACTIVITIES_PER_NIGHT = 3;
/** A stay counts as "starved" once its real supply covers meaningfully less than what its own night count needs — 0.7 leaves genuine room for a day or two of legitimate FreeTime without flagging every stay as starved. */
const INVENTORY_STARVATION_RATIO = 0.7;

export function computeStayInventoryPressure(
  stayId: string,
  areaLabel: string,
  nights: number,
  availableRelevantActivityCapacity: number
): StayInventoryPressure {
  const requiredActivityCapacity = Math.max(0, nights) * REQUIRED_ACTIVITIES_PER_NIGHT;
  const capacityRatio = requiredActivityCapacity > 0 ? availableRelevantActivityCapacity / requiredActivityCapacity : 1;
  return {
    stayId,
    areaLabel,
    nights,
    requiredActivityCapacity,
    availableRelevantActivityCapacity,
    capacityRatio: Math.round(capacityRatio * 100) / 100,
    starved: capacityRatio < INVENTORY_STARVATION_RATIO,
  };
}

export type StaySkeletonCoverageReasonCode =
  | "OK"
  | "TRIP_UNDER_COVERED"
  | "STAY_EXCEEDS_MAX_NIGHTS"
  | "BELOW_MINIMUM_REQUIRED_STAY_COUNT"
  | "INVENTORY_STARVED_STAY"
  /** Round 9.16.2.1 — the exact Round 9.16.3 production shape: coveredNights (36) > tripNights (35). Under-coverage and over-coverage are BOTH real accounting defects; neither may be silently accepted. */
  | "TRIP_OVER_ALLOCATED";

/**
 * Round 9.16.2.1 — explicit exact-allocation semantics, distinct from
 * coverageRatio (which can legitimately read >1.0 without this field
 * being consulted — the raw ratio is deliberately never clamped, see
 * evaluateStaySkeletonCoverage's own docstring). Computed from the RAW,
 * uncapped sum of every stay's own `nights` — never MAX_STAY_NIGHTS-capped
 * the way `coveredNights` is — so a genuinely over-allocated total is
 * caught even in the (rarer) case where per-stay capping would otherwise
 * make `coveredNights` alone look under- or exactly-covered.
 */
export type StayAllocationStatus = "UNDER_ALLOCATED" | "EXACTLY_ALLOCATED" | "OVER_ALLOCATED";

export interface StaySkeletonCoverage {
  tripNights: number;
  stayCount: number;
  minimumRequiredStayCount: number;
  /** Each stay's own contribution capped at MAX_STAY_NIGHTS — a stay proposed/allocated for more than the ceiling can never legitimately "cover" more than the ceiling on its own, which is exactly what forces a long trip toward more stays rather than one overlong one. */
  coveredNights: number;
  uncoveredNights: number;
  coverageRatio: number;
  maxStayNights: number;
  overlongStayCount: number;
  inventoryPressureByStay: StayInventoryPressure[];
  reasonCodes: StaySkeletonCoverageReasonCode[];
  /** True only when the trip's nights are genuinely, legitimately explained by this skeleton's stays — a SEPARATE, additional check from validateTripStaySkeleton's own geographic-resolution validity, never a replacement for it. */
  coverageValid: boolean;
  /** Round 9.16.2.1 — the RAW (never MAX_STAY_NIGHTS-capped) sum of every stay's own `nights` value — the exact quantity the Round 9.16.3 production trace proved could silently exceed tripNights (36 vs 35) while every other signal here still read as healthy. */
  totalAllocatedNights: number;
  allocationStatus: StayAllocationStatus;
}

/** How much of coverageRatio is required before a skeleton counts as trip-coverage-valid on its own (without needing region expansion). Deliberately not 1.0 — the existing post-discovery night-reallocation/reserve-promotion machinery already closes small real gaps; this exists to catch the GROSS Round 9.15.11 shape (uncoveredTripNights ~= 92% of the trip), not to demand pixel-perfect coverage before any real discovery has even run. */
const MIN_ACCEPTABLE_COVERAGE_RATIO = 0.8;

/**
 * Round 9.16 §2 — pure, non-mutating: proves whether a resolved stay
 * skeleton's nights actually explain the trip, and whether any stay
 * already exceeds the hard safety ceiling — the exact invariant Round
 * 9.15.11's "geographically fine, 33 of 36 nights uncovered, accepted
 * anyway" shape violated. `inventoryPressureByStay` is optional (real
 * per-stay supply is only known AFTER local discovery, which runs after
 * skeleton resolution) — omitted pre-discovery, populated post-discovery
 * by the caller once real StayActivityPool data exists.
 */
export function evaluateStaySkeletonCoverage(
  /** Round 9.16 §2 — deliberately narrowed to just `nights`: the same function is used both on pre-allocation ResolvedStay proposals AND on post-allocation TripFramePhase-shaped data (buildTripFrameFromSkeleton's own final-coverage recomputation), neither of which needs to satisfy ResolvedStay's full shape. */
  stays: Array<Pick<ResolvedStay, "nights">>,
  tripNights: number,
  inventoryPressureByStay: StayInventoryPressure[] = []
): StaySkeletonCoverage {
  const stayCount = stays.length;
  const minimumRequiredStayCount = computeMinimumRequiredStayCount(tripNights);
  const coveredNights = stays.reduce((sum, stay) => sum + Math.min(Math.max(0, stay.nights), MAX_STAY_NIGHTS), 0);
  const uncoveredNights = Math.max(0, tripNights - coveredNights);
  // Deliberately never clamped — an over-allocated raw ratio (e.g. 1.03,
  // the exact Round 9.16.3 shape) must stay observable, not hidden behind
  // a ceiling that would make an invalid plan look merely "fully covered."
  const coverageRatio = tripNights > 0 ? Math.round((coveredNights / tripNights) * 100) / 100 : 1;
  const maxStayNights = stays.reduce((max, stay) => Math.max(max, stay.nights), 0);
  const overlongStayCount = stays.filter((stay) => stay.nights > MAX_STAY_NIGHTS).length;
  // Round 9.16.2.1 — the RAW, uncapped total (never MAX_STAY_NIGHTS-capped
  // the way coveredNights is) is the exact quantity that read 36 against
  // a 35-night trip in the Round 9.16.3 production trace while every
  // other field here still looked healthy.
  const totalAllocatedNights = stays.reduce((sum, stay) => sum + Math.max(0, stay.nights), 0);
  const allocationStatus: StayAllocationStatus =
    totalAllocatedNights > tripNights ? "OVER_ALLOCATED" : totalAllocatedNights < tripNights ? "UNDER_ALLOCATED" : "EXACTLY_ALLOCATED";

  const reasonCodes: StaySkeletonCoverageReasonCode[] = [];
  if (coverageRatio < MIN_ACCEPTABLE_COVERAGE_RATIO) reasonCodes.push("TRIP_UNDER_COVERED");
  if (overlongStayCount > 0) reasonCodes.push("STAY_EXCEEDS_MAX_NIGHTS");
  if (stayCount < minimumRequiredStayCount) reasonCodes.push("BELOW_MINIMUM_REQUIRED_STAY_COUNT");
  if (inventoryPressureByStay.some((pressure) => pressure.starved)) reasonCodes.push("INVENTORY_STARVED_STAY");
  // Round 9.16.2.1 — the exact Round 9.16.3 gap: coveredNights (36) >
  // tripNights (35) previously tripped NONE of the checks above
  // (coverageRatio was comfortably >= 0.8, no stay individually exceeded
  // MAX_STAY_NIGHTS, stayCount already met the minimum) — over-allocation
  // is a genuinely SEPARATE failure mode from under-coverage and must be
  // its own explicit, named reason code.
  if (coveredNights > tripNights) reasonCodes.push("TRIP_OVER_ALLOCATED");
  if (reasonCodes.length === 0) reasonCodes.push("OK");

  const hasStarvedStay = inventoryPressureByStay.some((pressure) => pressure.starved);
  const coverageValid =
    coverageRatio >= MIN_ACCEPTABLE_COVERAGE_RATIO &&
    overlongStayCount === 0 &&
    stayCount >= minimumRequiredStayCount &&
    !hasStarvedStay &&
    coveredNights <= tripNights;

  return {
    tripNights,
    stayCount,
    minimumRequiredStayCount,
    coveredNights,
    uncoveredNights,
    coverageRatio,
    maxStayNights,
    overlongStayCount,
    inventoryPressureByStay,
    reasonCodes,
    coverageValid,
    totalAllocatedNights,
    allocationStatus,
  };
}

/* ------------------------------------------------------------------ *
 * 5c. Round 9.16 §7 — structured, provider-neutral interest demand.     *
 *     Never a specific-destination keyword list — a generic semantic    *
 *     category classifier that shapes WHAT KIND of region region        *
 *     expansion should look for, never fabricates WHICH region.        *
 * ------------------------------------------------------------------ */

export type StayDemandCategory =
  | "URBAN"
  | "CULTURE"
  | "HISTORY"
  | "FOOD"
  | "NIGHTLIFE"
  | "NATURE"
  | "HIKING"
  | "MOUNTAINS"
  | "COAST"
  | "BEACHES"
  | "VILLAGES"
  | "SCENIC";

// Bilingual (Hebrew/English — this app's own interests field is routinely
// submitted in Hebrew) keyword sets. Deliberately semantic-category-level,
// never a specific destination/city name — this is the ONE generic signal
// region expansion is allowed to use to shape WHAT it looks for.
const DEMAND_CATEGORY_KEYWORDS: Record<StayDemandCategory, string[]> = {
  URBAN: ["urban", "city", "cities", "downtown", "metropolis", "עיר", "עירוני", "מטרופולין"],
  CULTURE: ["culture", "art", "museum", "gallery", "theatre", "theater", "תרבות", "אמנות", "מוזיאון", "גלריה"],
  HISTORY: ["history", "historic", "heritage", "ancient", "היסטוריה", "היסטורי", "עתיק", "מורשת"],
  FOOD: [
    "food", "cuisine", "restaurant", "market", "street food", "bakery", "dessert",
    "אוכל", "מסעדה", "שווקים", "שוק", "אוכל רחוב", "מאפי", "קינוח", "בשר", "קפה", "אסייתי", "ים תיכוני",
  ],
  NIGHTLIFE: ["nightlife", "bar", "club", "party", "חיי לילה", "בר ", "מסיבה"],
  NATURE: ["nature", "outdoor", "wildlife", "טבע"],
  HIKING: ["hike", "hiking", "trek", "trekking", "trail", "טרק", "מסלול הליכה"],
  MOUNTAINS: ["mountain", "mountains", "alpine", "peak", "הר ", "הרים"],
  COAST: ["coast", "coastal", "seaside", "ocean", "חוף ים"],
  BEACHES: ["beach", "beaches", "חופים", "חוף"],
  VILLAGES: ["village", "villages", "countryside", "rural", "כפר", "כפרים"],
  SCENIC: ["scenic", "viewpoint", "landscape", "panoramic", "נופי", "תצפית"],
};

/**
 * Round 9.16 §7 — the exact fix for the proven Round 9.15.11 gap ("rich
 * mixed interests... did not influence deterministic fallback region
 * discovery"): a pure, generic classifier that turns free-text interests
 * into structured demand categories. Never returns a place name — only
 * what KIND of region is worth seeking (region-expansion's own job, using
 * real provider/geocoder evidence, decides WHICH real place satisfies it).
 */
export function classifyInterestDemand(interestsText: string | null | undefined): Set<StayDemandCategory> {
  const demand = new Set<StayDemandCategory>();
  if (!interestsText) return demand;
  const haystack = interestsText.toLowerCase();
  for (const [category, keywords] of Object.entries(DEMAND_CATEGORY_KEYWORDS) as [StayDemandCategory, string[]][]) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) demand.add(category);
  }
  return demand;
}

/* ------------------------------------------------------------------ *
 * Round 9.16.2 §2 — PROVIDER-NEUTRAL region candidate discovery.       *
 * Gemini proved it can be a single point of failure (Round 9.16.1's    *
 * own real trace: timeout, then a 503 on the retry). This is a real,   *
 * deterministic, NEVER-Gemini source of candidate NAMES — genuine      *
 * settlements reverse-geocoded along the real geographic line between  *
 * the trip's own arrival and departure anchors, through the SAME       *
 * Nominatim client every other candidate in this file already uses.    *
 * Never invents a name; every result still has to pass the exact same  *
 * classifyStayDestination locality gate as any other proposal.         *
 * ------------------------------------------------------------------ */

export async function discoverRouteCorridorCandidates(
  arrivalAnchor: { lat: number; lon: number },
  departureAnchor: { lat: number; lon: number },
  /** Already-known area labels (lowercased) — never re-propose a stay already in the skeleton. */
  existingAreaLabelsLower: Set<string>,
  sampleCount = 3,
  /** Injectable — tests pass a fake to avoid any real Nominatim reverse-geocode network call. */
  reverseGeocodeOverride?: typeof reverseGeocode
): Promise<ProposedStay[]> {
  const reverse = reverseGeocodeOverride ?? reverseGeocode;
  const candidates: ProposedStay[] = [];
  const seen = new Set<string>();
  const safeSampleCount = Math.max(1, Math.min(sampleCount, 6));

  for (let i = 1; i <= safeSampleCount; i += 1) {
    // Interior points only (never the endpoints themselves — those are
    // already the arrival/departure stays) — evenly spaced along the
    // straight geographic line between the two real anchors.
    const t = i / (safeSampleCount + 1);
    const lat = arrivalAnchor.lat + (departureAnchor.lat - arrivalAnchor.lat) * t;
    const lon = arrivalAnchor.lon + (departureAnchor.lon - arrivalAnchor.lon) * t;
    let place: GeocodedPlace | null;
    try {
      place = await reverse(lat, lon, { zoom: 10 });
    } catch {
      continue; // a single failed sample point never aborts the whole corridor scan.
    }
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon) || !place.name?.trim()) continue;
    const key = place.name.trim().toLowerCase();
    if (seen.has(key) || existingAreaLabelsLower.has(key)) continue;
    seen.add(key);
    candidates.push({ proposedId: `corridor-${i}`, areaName: place.name.trim(), nights: 5, reasons: ["route_corridor"] });
  }
  return candidates;
}

/* ------------------------------------------------------------------ *
 * 5d. Round 9.16 §3 — SIZE/CAPACITY-AWARE stay duration. Never a naive  *
 *     "split every 14 days" rule: a recommended MIN-MAX range per stay, *
 *     from whatever real evidence currently exists for it — a rough,    *
 *     generic pre-discovery scale proxy when that is all there is yet,  *
 *     genuinely measured post-discovery supply once local discovery has *
 *     run (the authoritative signal once it exists).                    *
 * ------------------------------------------------------------------ */

export type StayCapacityTier = "small" | "medium" | "large" | "exceptional";

const CAPACITY_TIER_RANGES: Record<StayCapacityTier, { min: number; max: number }> = {
  small: { min: 3, max: 5 },
  medium: { min: 5, max: 8 },
  large: { min: 7, max: 12 },
  exceptional: { min: 10, max: MAX_STAY_NIGHTS },
};

export interface StayCapacityProfile {
  stayId: string;
  areaLabel: string;
  tier: StayCapacityTier;
  recommendedMinNights: number;
  /** Always <= MAX_STAY_NIGHTS — a safety ceiling, never granted merely because it is permitted (spec §3's own explicit warning). */
  recommendedMaxNights: number;
  reasonCodes: string[];
}

export interface StayCapacityEvidence {
  /** Real, post-discovery meaningful-activity candidate count (StayActivityPool.candidates.length) — omitted before local discovery has run. */
  meaningfulActivitySupply?: number;
  /** Real, post-discovery diversity score (computeActivityDiversityScore) — omitted before local discovery has run. */
  diversityScore?: number;
  /** A real, verified count of legitimate nearby day-trip-worthy destinations reachable from this base — never invented, only ever a real measured count when the caller has one. */
  dayTripReachCount?: number;
}

/**
 * Round 9.16 §3 — the exact tiered targets the spec itself asks for (small
 * 3-5 / medium 5-8 / large 7-12 / exceptional up to 14, 14 as a HARD
 * ceiling never a default). Pre-discovery, the only honest signal
 * available is the geocoder's own resolved type (a park/protected-area
 * gateway skews toward "medium" rather than "small", never higher without
 * real supply evidence); post-discovery, real measured supply is
 * authoritative and can move the tier in either direction. Interests
 * broaden the traveler's OWN reason to linger (spec §7) — this only ever
 * nudges the ceiling of an already-non-small tier, never fabricates supply.
 */
export function estimateStayCapacityProfile(
  stay: Pick<ResolvedStay, "stayId" | "areaLabel" | "resolvedType">,
  demand: Set<StayDemandCategory>,
  evidence: StayCapacityEvidence = {}
): StayCapacityProfile {
  const reasonCodes: string[] = [];
  let tier: StayCapacityTier = "small";

  if (stay.resolvedType && PARK_STAY_PLACE_TYPES.has(stay.resolvedType)) {
    tier = "medium";
    reasonCodes.push("park_or_protected_area_gateway");
  }

  if (evidence.meaningfulActivitySupply != null) {
    if (evidence.meaningfulActivitySupply >= 60 || (evidence.diversityScore ?? 0) >= 12) {
      tier = "exceptional";
      reasonCodes.push("rich_measured_activity_supply");
    } else if (evidence.meaningfulActivitySupply >= 30) {
      tier = "large";
      reasonCodes.push("strong_measured_activity_supply");
    } else if (evidence.meaningfulActivitySupply >= 15) {
      tier = tier === "small" ? "medium" : tier;
      reasonCodes.push("moderate_measured_activity_supply");
    } else {
      tier = "small";
      reasonCodes.push("thin_measured_activity_supply");
    }
  }

  if ((evidence.dayTripReachCount ?? 0) >= 3 && (tier === "large" || tier === "medium")) {
    tier = "exceptional";
    reasonCodes.push("strong_day_trip_reach");
  }

  const range = CAPACITY_TIER_RANGES[tier];
  const broadInterestBonus = demand.size >= 4 && tier !== "small" ? 1 : 0;
  if (broadInterestBonus > 0) reasonCodes.push("broad_traveler_interest_profile");

  return {
    stayId: stay.stayId,
    areaLabel: stay.areaLabel,
    tier,
    recommendedMinNights: range.min,
    recommendedMaxNights: Math.min(MAX_STAY_NIGHTS, range.max + broadInterestBonus),
    reasonCodes,
  };
}

/* ------------------------------------------------------------------ *
 * 6. Feed resolved stays into the EXISTING, already-tested night-       *
 *    allocation/base-count machinery (spec §5/§14) — never a second,   *
 *    parallel algorithm.                                                *
 * ------------------------------------------------------------------ */

export interface StaySkeletonFrame {
  frame: TripFrame;
  anchors: Map<string, { lat: number; lon: number }>;
  /** Every resolved stay, selected AND reserve. */
  stays: ResolvedStay[];
  /** Round 9.3.2 §2 — resolved stays that did NOT make the initial active-stay cut (buildTripFramePhases's own bucket/significance selection). Preserved here rather than discarded, so they can later compete for trip days (spec §3) — never re-geocoded, since they're already fully resolved. */
  reserveStays: ResolvedStay[];
}

/**
 * Round 9.16 §4/§9 — the final safety net: buildTripFramePhases' own
 * allocateNightsForClusters (itinerary-planning-principles.ts, shared with
 * the POI-clustering path) has no concept of a per-phase ceiling, so this
 * runs AFTER it to guarantee no phase silently exceeds `maxNights` in the
 * frame this module hands back. Overflow is redistributed to phases with
 * real headroom, proportional to their own existing weight (a richer phase
 * absorbs more of it, never an equal split) — never invents a new phase.
 * `unallocatableNights > 0` in the result means even full redistribution
 * couldn't absorb everything (too few phases exist) — the caller's own
 * region-expansion step (buildTripFrameFromSkeleton) is what should have
 * prevented that by adding more real stays BEFORE this ever runs; this is
 * a last-resort structural guarantee, not a substitute for expansion.
 */
export function clampPhaseNightsToMaximum(
  phases: TripFramePhase[],
  maxNights: number
): { phases: TripFramePhase[]; redistributed: boolean; unallocatableNights: number } {
  if (phases.length === 0) return { phases, redistributed: false, unallocatableNights: 0 };

  const totalNights = phases.reduce((sum, phase) => sum + phase.nights, 0);
  const totalCapacity = phases.length * maxNights;
  // Round 9.16 §4 — the hard invariant this function must NEVER break: every
  // trip day still belongs to exactly one phase. When there is genuinely
  // not enough combined capacity (too few phases even at maxNights each) to
  // hold every trip night, capping everyone down to maxNights would silently
  // DROP trip days rather than merely exceed the safety ceiling — strictly
  // worse than the problem this function exists to catch. This is exactly
  // the "region expansion should have added more real stays before this
  // ever runs" case (buildTripFrameFromSkeleton's own job) — this function
  // only ever reports the shortfall, it never discards day coverage to
  // hide it.
  const trulyUnallocatable = Math.max(0, totalNights - totalCapacity);

  let overflow = 0;
  const capped = phases.map((phase) => {
    if (phase.nights > maxNights) {
      overflow += phase.nights - maxNights;
      return maxNights;
    }
    return phase.nights;
  });
  if (overflow === 0) return { phases, redistributed: false, unallocatableNights: 0 };

  const headroom = capped.map((nights) => Math.max(0, maxNights - nights));
  const totalHeadroom = headroom.reduce((sum, h) => sum + h, 0);
  const finalNights = [...capped];
  // Only ever attempt to move what genuinely HAS somewhere to go — the
  // truly-unallocatable remainder (if any) is handled separately below,
  // never silently absorbed into this redistribution pass.
  let toRedistribute = Math.min(overflow, totalHeadroom);
  const redistributeBudget = toRedistribute;

  if (totalHeadroom > 0) {
    for (let i = 0; i < finalNights.length && toRedistribute > 0; i += 1) {
      if (headroom[i] <= 0) continue;
      const proportionalShare = Math.round((headroom[i] / totalHeadroom) * redistributeBudget);
      const grant = Math.min(headroom[i], proportionalShare, toRedistribute);
      finalNights[i] += grant;
      toRedistribute -= grant;
    }
    // Rounding can leave a small remainder even with real headroom left —
    // a bounded round-robin top-up, never a second unbounded loop.
    for (let pass = 0; pass < finalNights.length && toRedistribute > 0; pass += 1) {
      for (let i = 0; i < finalNights.length && toRedistribute > 0; i += 1) {
        if (finalNights[i] < maxNights) {
          finalNights[i] += 1;
          toRedistribute -= 1;
        }
      }
    }
  }

  // Whatever could NOT be redistributed (trulyUnallocatable) is put back on
  // the phase(s) that originally overflowed, proportional to how much each
  // one originally exceeded the ceiling — total night count (and therefore
  // full trip-day coverage) is preserved exactly; only the safety ceiling
  // itself is exceeded, by the minimum amount structurally required, and
  // that fact is reported via `unallocatableNights` rather than hidden.
  if (trulyUnallocatable > 0) {
    const originalOverflowByIndex = phases.map((phase) => Math.max(0, phase.nights - maxNights));
    const originalOverflowTotal = originalOverflowByIndex.reduce((sum, o) => sum + o, 0);
    let toReturn = trulyUnallocatable;
    for (let i = 0; i < finalNights.length && toReturn > 0; i += 1) {
      if (originalOverflowByIndex[i] <= 0) continue;
      const share = Math.round((originalOverflowByIndex[i] / originalOverflowTotal) * trulyUnallocatable);
      const grant = Math.min(share, toReturn);
      finalNights[i] += grant;
      toReturn -= grant;
    }
    for (let i = 0; i < finalNights.length && toReturn > 0; i += 1) {
      if (originalOverflowByIndex[i] > 0) {
        finalNights[i] += 1;
        toReturn -= 1;
      }
    }
  }

  // Round 9.16.2.1 — the INCOMING phases' own day-range already reflects
  // the trip's true calendar span, which may legitimately exceed
  // sum(nights) by the departure-day slack (the sleeping-nights
  // convention: the trip's last phase's calendar span is nights+1). Never
  // assumed equal to sum(nights) — inferred from the phases actually
  // received, so this needs no new parameter and stays correct for both
  // the POI-clustering convention (span === sum(nights), slack 0, so this
  // is a complete no-op change for every existing caller/test) and the
  // stay-skeleton convention (span === sum(nights) + 1).
  const incomingCalendarSpan =
    Math.max(...phases.map((phase) => phase.endDayNumber)) - Math.min(...phases.map((phase) => phase.startDayNumber)) + 1;
  const newTotalNights = finalNights.reduce((sum, n) => sum + n, 0);
  const departureDaySlack = Math.max(0, incomingCalendarSpan - newTotalNights);

  let cursorDay = 1;
  const outPhases = phases.map((phase, index) => {
    const nights = finalNights[index];
    const isLast = index === phases.length - 1;
    const daySpan = nights + (isLast ? departureDaySlack : 0);
    const startDayNumber = cursorDay;
    const endDayNumber = cursorDay + daySpan - 1;
    cursorDay = endDayNumber + 1;
    return nights === phase.nights && startDayNumber === phase.startDayNumber && endDayNumber === phase.endDayNumber
      ? phase
      : { ...phase, nights, startDayNumber, endDayNumber };
  });

  return { phases: outPhases, redistributed: true, unallocatableNights: trulyUnallocatable };
}

/**
 * Builds the final TripFrame from a validated, resolved stay skeleton,
 * reusing buildTripFramePhases (itinerary-planning-principles.ts) exactly
 * as the POI-clustering path already does — same bucket-driven base-count
 * ceiling, same allocateNightsForClusters weight-proportional night split,
 * no second implementation. Each resolved stay's own proposed `nights`
 * value becomes its area weight (spec §14 — a stay explicitly proposed
 * with more nights, or later found to have richer real activity supply
 * via adjustStayWeightForSupply, gets proportionally more of the trip).
 */
export function buildTripFrameFromResolvedStays(
  stays: ResolvedStay[],
  dayCount: number,
  /** Round 9.3 §6/test G — the SAME global route-optimization primitive buildDeterministicTripFrame's own POI-clustering path already uses (itinerary-planning-principles.ts), reused here rather than a second ordering algorithm. */
  arrivalAnchor?: { lat: number; lon: number } | null,
  departureAnchor?: { lat: number; lon: number } | null
): StaySkeletonFrame {
  const bucket = getTripLengthBucket(dayCount);
  // Ranked by proposed nights, most significant first (same convention as
  // buildDeterministicTripFrame's own rankedAreas) — buildTripFramePhases
  // slices to its bucket-derived maxBasesForData, so when a proposal count
  // exceeds what the bucket allows, the stays actually worth keeping are
  // the ones proposed with more nights, never just insertion order. The
  // arrival/departure structural anchors are ranked first regardless of
  // their own (often minimal, 1-night) proposed weight — a real trip's
  // start/end city must never be the one a significance cut discards.
  const isStructuralAnchor = (stay: ResolvedStay) => stay.reasons.includes("arrival") || stay.reasons.includes("departure");
  const rankedAreas = [
    ...stays.filter(isStructuralAnchor).sort((a, b) => b.nights - a.nights),
    ...stays.filter((stay) => !isStructuralAnchor(stay)).sort((a, b) => b.nights - a.nights),
  ].map((stay) => stay.areaLabel);
  // buildTripFramePhases's own significantAreaCount check compares this
  // weight against OVERNIGHT_WORTHY_MINUTES (240) — a MINUTES-scaled bar
  // shared with decideClusterRole's own "worth a dedicated overnight base"
  // threshold. A real bug found writing this round's own live replay: a
  // plain nights count (1-10) never crosses that bar, so EVERY skeleton-
  // derived area silently read as "not significant" and baseCount always
  // collapsed to the bucket's bare minBases regardless of how many real
  // resolved stays existed — a 42-day trip with 6 real candidates kept
  // only 3. Scaling each proposed night into OVERNIGHT_WORTHY_MINUTES
  // units keeps this on the SAME significance scale the POI-clustering
  // path already uses, so a stay proposed for even 1 real night clears
  // the bar exactly as a cluster with "half a day's worth" of content would.
  const areaWeights = new Map<string, number>(stays.map((stay) => [stay.areaLabel, Math.max(1, stay.nights) * OVERNIGHT_WORTHY_MINUTES]));
  let phases = buildTripFramePhases(rankedAreas, areaWeights, dayCount, bucket, null);

  if ((arrivalAnchor || departureAnchor) && phases.length >= 2) {
    const stayByArea = new Map(stays.map((stay) => [stay.areaLabel, stay]));
    const routeNodes: StayRouteNode[] = phases.map((phase) => {
      const stay = stayByArea.get(phase.areaLabel);
      return { id: phase.areaLabel, lat: stay?.lat ?? 0, lon: stay?.lon ?? 0, hasAnchor: stay != null, value: areaWeights.get(phase.areaLabel) ?? 1 };
    });
    const optimized = optimizeStayRouteSequence(routeNodes, arrivalAnchor ?? null, departureAnchor ?? null);
    const finalOrder = optimized.map((node) => node.id);
    if (finalOrder.some((area, index) => area !== phases[index].areaLabel)) {
      const byArea = new Map(phases.map((phase) => [phase.areaLabel, phase]));
      const reordered = finalOrder.map((area) => byArea.get(area)).filter((phase): phase is TripFramePhase => phase != null);
      if (reordered.length === phases.length) {
        let cursorDay = 1;
        phases = reordered.map((phase) => {
          const startDayNumber = cursorDay;
          const endDayNumber = cursorDay + phase.nights - 1;
          cursorDay = endDayNumber + 1;
          return { ...phase, startDayNumber, endDayNumber };
        });
      }
    }
  }

  // Round 9.16.2.1 — DAYS_VS_NIGHTS_OFF_BY_ONE fix (the exact Round 9.16.3
  // production defect: 7 real stays summed to 36 nights against a 35-night
  // trip). buildTripFramePhases above (and the reorder just above) build
  // day-RANGES that correctly span all `dayCount` calendar days — that
  // part was never wrong and is left completely untouched here. The bug
  // was that its own nights allocation (via allocateNightsForClusters)
  // also sums to `dayCount`, one MORE than the established
  // "tripNights = dayCount - 1" sleeping-nights convention every other
  // stay-composition invariant (MAX_STAY_NIGHTS, evaluateStaySkeletonCoverage,
  // the final pre-persist firewall) already uses. The trip's very last
  // calendar day is a real day (someone owns it — checkout/departure) but
  // is not an ADDITIONAL sleeping night: only the trip's LAST phase (in
  // final route order, after any reorder above) has its `nights` field
  // reduced by that one departure-day slack. Its own day-range
  // (startDayNumber/endDayNumber) is left completely untouched — day
  // ownership (which calendar day belongs to which stay) is therefore
  // unaffected, exactly preserving the already-correct, already-tested
  // contiguous coverage of all `dayCount` days proven in the Round 9.16.3
  // forensic trace (no overlap, no gap, no duplicate endpoint).
  const tripNights = Math.max(1, dayCount - 1);
  if (phases.length > 0) {
    const currentTotalNights = phases.reduce((sum, phase) => sum + phase.nights, 0);
    const departureDaySlack = Math.max(0, currentTotalNights - tripNights);
    if (departureDaySlack > 0) {
      const lastIndex = phases.length - 1;
      const adjustedNights = Math.max(1, phases[lastIndex].nights - departureDaySlack);
      phases = phases.map((phase, index) => (index === lastIndex ? { ...phase, nights: adjustedNights } : phase));
    }
  }

  const anchors = new Map<string, { lat: number; lon: number }>();
  const stayByArea = new Map(stays.map((stay) => [stay.areaLabel, stay]));
  const phasesWithAnchors = phases.map((phase) => {
    const stay = stayByArea.get(phase.areaLabel);
    if (!stay) return phase;
    anchors.set(phase.areaLabel, { lat: stay.lat, lon: stay.lon });
    // The real geocoded coordinates, carried directly on the phase (spec
    // §6/§10) — see TripFramePhase.anchor's own docstring for why this
    // matters: without it, per-stay discovery has no anchor to query
    // around at all.
    return { ...phase, anchor: { lat: stay.lat, lon: stay.lon } };
  });

  const frame: TripFrame = {
    bucketId: bucket.id,
    phases: phasesWithAnchors,
    source: "ai",
    planningTrace: {
      clusterCount: stays.length,
      overnightClusterAreas: phases.map((p) => p.areaLabel),
      dayTripClusterAreas: [],
      mergedClusterAreas: [],
      skippedClusterAreas: [],
      backtrackingReordered: false,
      shortStayMerges: [],
    },
  };

  const selectedAreaLabels = new Set(phasesWithAnchors.map((p) => p.areaLabel));
  const reserveStays = stays.filter((stay) => !selectedAreaLabels.has(stay.areaLabel));

  // Round 9.4 §B — the FINAL stay skeleton, with exactly what the geocoder
  // returned for each stay still attached (resolvedObjectType/resolvedClass/
  // resolvedType/adminPath — see ResolvedStay's own docstring). This is
  // the log that must explain a shape like "White Mountains Community
  // College"/"Harbor Bar" becoming a stay: it exposes the raw resolver
  // output, never fixes it.
  logRealPlaceQA("TripFrame", {
    totalDays: dayCount,
    totalNights: phasesWithAnchors.reduce((sum, p) => sum + p.nights, 0),
    stays: phasesWithAnchors.map((phase) => {
      const stay = stayByArea.get(phase.areaLabel);
      return {
        stayId: stay?.stayId,
        phaseId: phase.id,
        proposedName: stay?.proposedName,
        canonicalName: phase.areaLabel,
        nights: phase.nights,
        anchor: phase.anchor,
        resolutionSource: stay?.source,
        resolvedObjectType: stay?.resolvedObjectType,
        resolvedClass: stay?.resolvedClass,
        resolvedType: stay?.resolvedType,
        adminPath: stay?.adminPath,
        isArrivalStay: stay?.reasons.includes("arrival") ?? false,
        isDepartureStay: stay?.reasons.includes("departure") ?? false,
        // Best-effort only — this function has no direct access to
        // profile.mustVisitKeywords, so this reflects whatever reason
        // strings the proposal itself carried, never an authoritative
        // must-visit resolution.
        isMustVisit: stay?.reasons.some((r) => r.toLowerCase().includes("must")) ?? false,
      };
    }),
  });

  return { frame, anchors, stays, reserveStays };
}

/**
 * Round 9.3 §14 — activity capacity influencing nights: given a stay's
 * measured real activity+meal supply (from its own StayActivityPool/
 * StayMealVenuePool, built AFTER local discovery), rescale its proposed
 * night weight before the frame is finalized. A stay with only enough
 * genuinely diverse supply for ~2 days should not anchor 7 nights; a
 * richly-supplied stay may reasonably support more than its initial
 * proposal. Purely a WEIGHT adjustment fed back into
 * buildTripFrameFromResolvedStays — never a hardcoded per-city rule.
 */
export function adjustStayWeightForSupply(stay: ResolvedStay, meaningfulActivityCandidates: number): ResolvedStay {
  // A stay needs roughly 2-3 meaningful activities per night to justify
  // that many nights (matches estimateDayActivityTarget's own "normal day"
  // midpoint in stay-activity-pool.ts) — capped to a gentle rescale rather
  // than an abrupt cliff, so one slightly-thin day of supply doesn't blow
  // away an otherwise reasonable stay.
  const supplyImpliedNights = Math.max(1, Math.round(meaningfulActivityCandidates / 2.5));
  const rescaledNights = Math.max(1, Math.min(stay.nights, Math.max(supplyImpliedNights, Math.ceil(stay.nights * 0.5))));
  return { ...stay, nights: rescaledNights };
}

/* ==================================================================== *
 * ROUND 9.3.1 — STAY DURATION AS A PLANNING RESULT, NOT A BUCKET        *
 *                                                                        *
 * adjustStayWeightForSupply above (Round 9.3) is a single-stay rescale — *
 * useful but not a real allocation: it never lets one stay's genuine    *
 * richness pull nights away from a comparatively weak one, and it has  *
 * no concept of diminishing returns (an 8th day in a rich destination   *
 * scored identically to its 2nd). This section is the real replacement: *
 * a joint, marginal-value, diminishing-returns allocation across every  *
 * stay at once (spec §5/§6/§9) — no "city = N nights" bucket, no       *
 * equal-share fallback.                                                 *
 * ==================================================================== */

export type StayDiscoveryConfidence = "high_confidence" | "provider_degraded" | "unknown";

/**
 * Deliberately leaner than the spec's own illustrative field list (its own
 * words: "Do not require these exact fields if equivalent project
 * primitives exist") — every field here is computed from a REAL,
 * already-existing signal (StayActivityPool/StayMealVenuePool diagnostics,
 * classification breakdowns, must-visit reasons), never fabricated.
 */
export interface StayValueProfile {
  stayId: string;
  areaLabel: string;
  /** Real, non-meal-venue candidates discovered for this stay (StayActivityPool.candidates.length). */
  meaningfulActivitySupply: number;
  /** Diminishing-returns-adjusted spread across activity families/subtypes (spec §8: 15 similar museums != 15 valuable candidates). */
  diversityScore: number;
  /** Real meal-venue candidates discovered (StayMealVenuePool.venues.length) — a real but secondary value signal (spec §7). */
  mealVenueSupply: number;
  /** 0 (no signal), 0.5 (a soft/preference-matched reason), or 1 (an explicit must-visit/preferred-region reason) — spec §13, never fabricated beyond what the skeleton/user actually said. */
  userPriority: number;
  /** Arrival/departure structural anchors get a protected minimum regardless of measured value (spec §14) — never cut by the marginal-value competition alone. */
  isStructuralAnchor: boolean;
  discoveryConfidence: StayDiscoveryConfidence;
  /**
   * Round 9.3.2 §7/§11 — 0-1, the fraction of this stay's own nights that
   * are genuinely full sightseeing days (computeStayUsableCapacity, below)
   * rather than diluted by a late arrival/early departure/transfer day.
   * 1 (the default when no usable-capacity signal was computed) means "no
   * discount" — every pre-Round-9.3.2 caller is unaffected.
   */
  usableCapacityFactor: number;
}

/**
 * Spec §8's own worked example: 15 similar art museums must contribute far
 * less than 8 genuinely different family/subtype candidates. Each
 * ADDITIONAL candidate within the SAME family contributes on a decaying
 * curve (sqrt) — a family's 4th candidate barely moves the score, but a
 * genuinely NEW family always adds a full unit before decaying itself.
 */
export function computeActivityDiversityScore(categorySupply: Partial<Record<string, number>>): number {
  let score = 0;
  for (const count of Object.values(categorySupply)) {
    if (!count) continue;
    score += Math.sqrt(count);
  }
  return Math.round(score * 10) / 10;
}

/**
 * Spec §12 — a stay whose low candidate count is explained by genuine
 * provider trouble (timeouts/failures/a degraded refill) must not be
 * mistaken for a genuinely low-value destination; its activity-supply
 * signal is deliberately NOT trusted at face value in that case (the
 * caller floors it to a neutral assumption instead — see
 * computeStayValueProfile below).
 */
export function classifyStayDiscoveryConfidence(pool: Pick<StayActivityPool["diagnostics"], "supplyDegraded" | "providerFailures" | "providerTimeouts"> | undefined): StayDiscoveryConfidence {
  if (!pool) return "unknown";
  if (pool.supplyDegraded || pool.providerFailures > 0 || pool.providerTimeouts > 0) return "provider_degraded";
  return "high_confidence";
}

/* ==================================================================== *
 * ROUND 9.3.2 §7-12 — USABLE SIGHTSEEING TIME, not raw nights.          *
 * Reuses estimateDayActivityTarget (stay-activity-pool.ts) exactly as   *
 * the pre-generation day-type/usableHours estimate already computes it —*
 * no new "minutes" abstraction invented (spec's own "do not redesign").*
 * ==================================================================== */

export type UsableTimeConfidence = "known" | "partial" | "unknown";

export interface StayUsableCapacity {
  /** Sum of estimateDayActivityTarget across every day this stay owns — a real, capacity-weighted "equivalent full sightseeing days" figure. Always <= the stay's own raw night count in spirit (an arrival/departure/transfer day scores below a normal day's own target), never fabricated above what the day types actually support. */
  equivalentSightseeingDays: number;
  /** "known" when every arrival/departure day in this stay had a real usableHours figure (from the real flight-derived ArrivalDepartureWindow); "partial" when at least one was unknown — spec §12: never fabricate full-day certainty for an unknown arrival/departure time; "unknown" when the stay has no day data at all. */
  confidence: UsableTimeConfidence;
}

/**
 * Spec §10 — an internal transfer day is never double-counted: each day
 * number belongs to exactly one phase's own day list (the SAME ownership
 * dayTypesByStay/estimatePreGenerationDayTypesByStay already establishes
 * elsewhere in this codebase), so a transfer day's own discounted target
 * (0.5, stay-activity-pool.ts's own estimateDayActivityTarget) is counted
 * for its ONE owning stay only — never invented as a full day in either
 * direction, and never re-counted for the other side of the transfer.
 */
export function computeStayUsableCapacity(phase: TripFramePhase, dayTypesByStay: Map<string, StayDayCapacityInput[]>): StayUsableCapacity {
  const days = dayTypesByStay.get(phase.id) ?? [];
  if (days.length === 0) return { equivalentSightseeingDays: 0, confidence: "unknown" };

  let total = 0;
  let hasUnknownTiming = false;
  for (const day of days) {
    total += estimateDayActivityTarget(day);
    // Spec §8/§9/§12 — an arrival/departure day with no real usableHours
    // figure (flight timing unknown) is never silently treated as a
    // confidently-known full day; estimateDayActivityTarget itself already
    // falls back to a conservative "1" for that case, this only tracks
    // that the fallback fired so the caller can surface "partial" honestly.
    if ((day.dayType === "arrival" || day.dayType === "departure") && day.usableHours == null) hasUnknownTiming = true;
  }
  return { equivalentSightseeingDays: Math.round(total * 10) / 10, confidence: hasUnknownTiming ? "partial" : "known" };
}

/**
 * Builds a stay's REAL value profile from its own discovered
 * StayActivityPool/StayMealVenuePool (spec §4: "after real stay resolution
 * and local candidate discovery"). `reasons`/`isStructuralAnchor` come from
 * the skeleton's own proposal — never re-derived from place-type text
 * (spec §3: no "city/region/park" bucket).
 */
export function computeStayValueProfile(
  stayId: string,
  areaLabel: string,
  activityPool: StayActivityPool | undefined,
  mealPool: StayMealVenuePool | undefined,
  reasons: string[],
  isStructuralAnchor: boolean,
  /** Round 9.3.2 §11 — optional; when the caller has real day-type/usableHours data for this stay, its own night-count-relative capacity discounts the stay's value (a stay bookended by a late arrival + early departure is worth less than the same night count with generous timing). Omitted (or an empty capacity) keeps the pre-9.3.2 behavior — factor 1, no discount. */
  usableCapacity?: StayUsableCapacity,
  /** The stay's own raw night count — only needed to turn equivalentSightseeingDays into a RATIO; omit along with usableCapacity for the pre-9.3.2 behavior. */
  nights?: number
): StayValueProfile {
  const confidence = classifyStayDiscoveryConfidence(activityPool?.diagnostics);
  // A provider-degraded stay's own raw count is not trustworthy evidence of
  // LOW value — floored to a neutral assumption (spec §12) rather than
  // letting a timeout masquerade as "this destination has nothing to do".
  const rawSupply = activityPool?.candidates.length ?? 0;
  const meaningfulActivitySupply = confidence === "provider_degraded" ? Math.max(rawSupply, 4) : rawSupply;
  const diversityScore =
    confidence === "provider_degraded"
      ? Math.max(computeActivityDiversityScore(activityPool?.categorySupply ?? {}), 2)
      : computeActivityDiversityScore(activityPool?.categorySupply ?? {});

  const userPriority = reasons.includes("must_visit") || reasons.includes("preferred_region") ? 1 : reasons.length > 0 ? 0.5 : 0;

  // A normal, unconstrained day's own target (stay-activity-pool.ts's
  // estimateDayActivityTarget, "normal"+no rest window) is the ceiling this
  // ratio is measured against — the SAME scale computeStayUsableCapacity's
  // own per-day sum already uses, never a second parallel constant.
  const NORMAL_DAY_TARGET = 3;
  const usableCapacityFactor =
    usableCapacity != null && nights != null && nights > 0
      ? Math.max(0.2, Math.min(1, usableCapacity.equivalentSightseeingDays / (nights * NORMAL_DAY_TARGET)))
      : 1;

  return {
    stayId,
    areaLabel,
    meaningfulActivitySupply,
    diversityScore,
    mealVenueSupply: mealPool?.venues.length ?? 0,
    userPriority,
    isStructuralAnchor,
    discoveryConfidence: confidence,
    usableCapacityFactor,
  };
}

/** Each additional day in the SAME stay is worth this fraction of the previous one (spec §6's own worked example: day 1 huge, day 2 still excellent, day 9 only if genuinely still valuable). Not tunable per destination — the profile's own supply/diversity is what makes a rich destination's curve stay high for longer, never this constant. */
const NIGHT_VALUE_DECAY = 0.72;

/**
 * The marginal value of allocating stay `profile` one MORE day, given it
 * already has `daysAlreadyAllocated`. Pure capacity/diversity/priority
 * combination (spec §5/§7 — supply is one input among several, never the
 * sole `nights = activities / perDay` formula) times a diminishing-returns
 * decay (spec §6). Never negative — a stay can always be "worth" a next
 * day in principle, just decreasingly so; the ALLOCATION loop is what
 * actually stops giving it more once a competitor is stronger.
 */
/**
 * The stay's own base capacity BEFORE the diminishing-returns decay is
 * applied — shared by marginalValueForNextDay and the QA `valueScore`
 * below so the two never drift apart. Multiplicative userPriority (spec
 * §13 — "strong user interests should influence marginal value" as REAL
 * structural weight, not a token tie-break bonus a middling supply
 * difference could wash out): a full must-visit priority scales the
 * WHOLE stay's value by 1.6x, so it meaningfully outcompetes an
 * otherwise-identical stay across the whole decay curve, not just once.
 */
function computeStayBaseCapacity(profile: StayValueProfile): number {
  const supplyCapacity = profile.meaningfulActivitySupply * 1.5 + profile.diversityScore * 4 + profile.mealVenueSupply * 0.5;
  // Round 9.3.2 §11 — a stay whose own nights are mostly diluted by
  // arrival/departure/transfer days (usableCapacityFactor < 1) is worth
  // proportionally less per ADDITIONAL night than the same raw supply
  // would be for a stay with generous timing; 1 (the default) is a no-op.
  return supplyCapacity * (1 + profile.userPriority * 0.6) * profile.usableCapacityFactor;
}

export function marginalValueForNextDay(profile: StayValueProfile, daysAlreadyAllocated: number): number {
  const baseCapacity = computeStayBaseCapacity(profile);
  const decay = Math.pow(NIGHT_VALUE_DECAY, daysAlreadyAllocated);
  // A first-day structural bonus (spec §14 — arrival/departure logistics
  // matter most on THEIR own first day), not a blanket exemption from
  // decay on every later day.
  const structuralFirstDayBonus = profile.isStructuralAnchor && daysAlreadyAllocated === 0 ? 3 : 0;
  return baseCapacity * decay + structuralFirstDayBonus;
}

export interface NightAllocationResult {
  nightsByStayId: Map<string, number>;
  /** QA/internal planning evidence per stay (spec §15) — never user-facing text. */
  allocationDetails: Map<
    string,
    { valueScore: number; firstDayMarginalValue: number; lastAllocatedDayMarginalValue: number; nextUnallocatedDayMarginalValue: number }
  >;
  /** Round 9.16 §4/§9 — nights that could NOT be legally allocated because every stay had already reached maxNightsPerStay (the hard ceiling). 0 whenever no cap was passed, or the cap was never actually reached — this is the honest "region expansion is genuinely needed" signal, never silently absorbed into an overlong stay. Optional so hand-built pre-9.16 test fixtures/callers keep compiling unchanged; allocateNightsByMarginalValue itself always sets it. */
  unallocatableNights?: number;
}

/**
 * THE joint global allocator (spec §9) — repeatedly gives the next
 * available trip-day to whichever stay's NEXT day currently has the
 * highest marginal value, never computing each stay's share independently
 * and normalizing afterward. `minNightsPerStay` is the one hard floor
 * (every included stay gets to exist at all, spec §14's "minimum viable
 * stay" and §10's "adding a stay has an activation/transfer cost" —
 * modeled here as a cost already paid once via this floor, not a
 * per-iteration penalty). No equal-share fallback: when every profile
 * happens to have genuinely equal value, the loop still allocates
 * round-robin by highest marginal value, which is simply equal in that
 * specific case — never a shortcut that fires BEFORE evaluating value.
 */
export function allocateNightsByMarginalValue(
  profiles: StayValueProfile[],
  totalNights: number,
  minNightsPerStay = 1,
  /** Round 9.16 §4/§9 — the hard safety ceiling (MAX_STAY_NIGHTS by default when the caller opts in via buildTripFrameFromResolvedStays/reallocateNightsAfterDiscovery). `undefined` preserves the exact pre-9.16 uncapped behavior for every existing caller that doesn't pass it. */
  maxNightsPerStay?: number
): NightAllocationResult {
  const nightsByStayId = new Map<string, number>(profiles.map((p) => [p.stayId, 0]));
  const floor = Math.min(minNightsPerStay, profiles.length > 0 ? Math.floor(totalNights / profiles.length) || 1 : 1);
  for (const p of profiles) nightsByStayId.set(p.stayId, floor);
  let remaining = totalNights - floor * profiles.length;

  const firstDayMarginalValue = new Map(profiles.map((p) => [p.stayId, marginalValueForNextDay(p, 0)]));

  while (remaining > 0 && profiles.length > 0) {
    let bestId: string | null = null;
    let bestValue = -Infinity;
    for (const p of profiles) {
      // Round 9.16 §4/§9 — a stay already at the hard ceiling is never a
      // candidate for one more night, regardless of how strong its own
      // marginal value still looks; excluded from the comparison entirely
      // rather than merely scored lower, so it can never win by default
      // when every OTHER stay is also capped.
      if (maxNightsPerStay != null && nightsByStayId.get(p.stayId)! >= maxNightsPerStay) continue;
      const value = marginalValueForNextDay(p, nightsByStayId.get(p.stayId)!);
      // A tie (real, not rare — every stay's supply can legitimately be
      // equal, or even all genuinely zero, e.g. discovery hasn't run yet)
      // must never silently collapse to whichever stay happens first in
      // array order — a real bug found via this round's own live replay:
      // with zero-everywhere supply, strict `>` let the first stay in the
      // list win literally every remaining night. On a tie, the stay with
      // FEWER nights so far wins, keeping the allocation fair/round-robin
      // rather than array-order-dependent.
      if (value > bestValue || (value === bestValue && bestId != null && nightsByStayId.get(p.stayId)! < nightsByStayId.get(bestId)!)) {
        bestValue = value;
        bestId = p.stayId;
      }
    }
    if (bestId == null) break; // every stay is at the ceiling — the loop stops rather than overflowing one of them.
    nightsByStayId.set(bestId, nightsByStayId.get(bestId)! + 1);
    remaining -= 1;
  }
  // Round 9.16 §4 — whatever remains unallocated once every stay is at its
  // ceiling is the honest "this skeleton cannot legally absorb the whole
  // trip" signal, surfaced to the caller rather than silently dropped or
  // forced onto one stay.
  const unallocatableNights = Math.max(0, remaining);

  const allocationDetails = new Map(
    profiles.map((p) => {
      const finalNights = nightsByStayId.get(p.stayId)!;
      return [
        p.stayId,
        {
          valueScore: Math.round(computeStayBaseCapacity(p) * 10) / 10,
          firstDayMarginalValue: Math.round((firstDayMarginalValue.get(p.stayId) ?? 0) * 10) / 10,
          lastAllocatedDayMarginalValue: Math.round(marginalValueForNextDay(p, Math.max(0, finalNights - 1)) * 10) / 10,
          nextUnallocatedDayMarginalValue: Math.round(marginalValueForNextDay(p, finalNights) * 10) / 10,
        },
      ];
    })
  );

  return { nightsByStayId, allocationDetails, unallocatableNights };
}

/**
 * Spec §4/§13 — rebuilds an EXISTING skeleton-derived TripFrame's night
 * allocation from REAL discovered supply (StayActivityPool/
 * StayMealVenuePool, built by refillTripRecommendationPool AFTER the
 * frame's phases already exist), preserving each phase's own area/order —
 * this only ever changes NIGHT COUNTS, never which stays are included or
 * their route order (stay SELECTION and ORDER stay exactly as
 * buildTripFrameFromResolvedStays already decided; this is duration only,
 * spec §4's "separate stay selection from night allocation").
 */
export function reallocateNightsAfterDiscovery(
  frame: TripFrame,
  dayCount: number,
  poolsByStay: Map<string, StayActivityPool>,
  mealPoolsByStay: Map<string, StayMealVenuePool>,
  /** Round 9.3.1 §13 — the trip's own already-computed must-visit keywords (TripPreferenceProfile.mustVisitKeywords), matched against each phase's own areaLabel. Reusing this existing signal avoids re-plumbing the skeleton's original per-stay `reasons` through buildTripFrame's return type just for this one check. */
  mustVisitKeywords: string[] = [],
  arrivalAnchor?: { lat: number; lon: number } | null,
  departureAnchor?: { lat: number; lon: number } | null,
  /** Round 9.3.2 §7/§11 — the caller's own estimatePreGenerationDayTypesByStay result (country-itinerary-generation.ts), keyed by phase.id, computed against this SAME frame's CURRENT (pre-reallocation) day ranges — reused rather than a second day-type estimator. Omitted preserves the exact pre-9.3.2 behavior (no usable-capacity discount). */
  dayTypesByStay?: Map<string, StayDayCapacityInput[]>
): TripFrame {
  if (frame.phases.length <= 1) return frame; // nothing to (re)allocate between

  const profiles = frame.phases.map((phase) => {
    const isFirst = phase === frame.phases[0];
    const isLast = phase === frame.phases[frame.phases.length - 1];
    const isStructuralAnchor = (isFirst && arrivalAnchor != null) || (isLast && departureAnchor != null);
    const areaHaystack = phase.areaLabel.trim().toLowerCase();
    const isMustVisit = mustVisitKeywords.some((keyword) => keyword.trim() && areaHaystack.includes(keyword.trim().toLowerCase()));
    const usableCapacity = dayTypesByStay ? computeStayUsableCapacity(phase, dayTypesByStay) : undefined;
    return computeStayValueProfile(
      phase.id,
      phase.areaLabel,
      poolsByStay.get(phase.id),
      mealPoolsByStay.get(phase.id),
      isMustVisit ? ["must_visit"] : [],
      isStructuralAnchor,
      usableCapacity,
      phase.nights
    );
  });

  // Round 9.16.2.1 — reallocate whatever NIGHTS TOTAL the incoming frame
  // actually carries (its own current sum of phase.nights), never blindly
  // `dayCount`. The two conventions differ by design: the deterministic
  // POI-clustering frame's own nights sum to `dayCount` (unmodified,
  // out of scope this round); the stay-skeleton frame (fixed this round in
  // buildTripFrameFromResolvedStays) correctly sums to `dayCount - 1`
  // sleeping nights. Deriving the target from the frame itself makes this
  // function self-adapting to whichever convention it's handed — for the
  // deterministic path the two values are already equal, so behavior is
  // completely unchanged; for the skeleton path this is what stops
  // reallocation from silently re-inflating an already-correct 35-night
  // total back to 36 (the exact Round 9.16.3 production defect, which
  // this function's OWN blind `dayCount` target would otherwise
  // reproduce even after the upstream fix).
  const targetNights = frame.phases.reduce((sum, phase) => sum + phase.nights, 0);

  // Round 9.16.2 §5 — a late allocator must never reintroduce an overlong
  // stay: this used to call allocateNightsByMarginalValue uncapped, so a
  // richly-supplied stay's marginal value could legitimately pull it past
  // MAX_STAY_NIGHTS once real post-discovery supply was known, silently
  // recreating the exact class of violation the initial skeleton stage
  // (buildTripFrameFromSkeleton) was already fixed to prevent.
  const { nightsByStayId } = allocateNightsByMarginalValue(profiles, targetNights, 1, MAX_STAY_NIGHTS);

  // Round 9.16.2 §5 (bug fix) — allocateNightsByMarginalValue's own hard
  // cap can leave real nights genuinely unallocated when total phases ×
  // MAX_STAY_NIGHTS is itself less than targetNights (e.g. 2 phases, a
  // 30-night trip, cap 14 -> only 28 allocatable). Building day ranges
  // directly off that short sum would leave real trip days owned by NO
  // phase at all — a worse defect than a soft over-cap quality violation.
  // The shortfall is added back (round-robin, largest allocation first)
  // BEFORE building day ranges, so clampPhaseNightsToMaximum below sees
  // genuinely-overflowing phases it can already correctly reason about,
  // rather than an already-short, already-capped list it has no way to
  // know is missing days.
  const allocatedTotal = frame.phases.reduce((sum, phase) => sum + (nightsByStayId.get(phase.id) ?? 0), 0);
  let shortfall = targetNights - allocatedTotal;
  if (shortfall > 0 && frame.phases.length > 0) {
    const byAllocationDesc = [...frame.phases].sort((a, b) => (nightsByStayId.get(b.id) ?? 0) - (nightsByStayId.get(a.id) ?? 0));
    let index = 0;
    while (shortfall > 0) {
      const phase = byAllocationDesc[index % byAllocationDesc.length];
      nightsByStayId.set(phase.id, (nightsByStayId.get(phase.id) ?? 0) + 1);
      shortfall -= 1;
      index += 1;
    }
  }

  // Round 9.16.2.1 — the trip's real calendar span (dayCount) may exceed
  // the reallocated NIGHTS total by exactly the departure-day slack
  // (dayCount - targetNights, 0 for the deterministic convention, 1 for
  // the sleeping-nights convention) — only the trip's LAST phase's day-
  // RANGE absorbs that slack (never its `nights` field), so every
  // calendar day through dayCount stays owned by exactly one phase,
  // exactly as proven contiguous/gap-free/overlap-free in the Round
  // 9.16.3 forensic trace.
  const departureDaySlack = Math.max(0, dayCount - targetNights);
  let cursorDay = 1;
  const phases = frame.phases.map((phase, index) => {
    const nights = nightsByStayId.get(phase.id) ?? phase.nights;
    const isLast = index === frame.phases.length - 1;
    const daySpan = nights + (isLast ? departureDaySlack : 0);
    const startDayNumber = cursorDay;
    const endDayNumber = cursorDay + daySpan - 1;
    cursorDay = endDayNumber + 1;
    return { ...phase, nights, startDayNumber, endDayNumber };
  });

  // Round 9.16.2 §5 — the same safety net buildTripFrameFromSkeleton uses:
  // if capping left nights genuinely unallocatable (too few phases even at
  // 14 each), full trip-day coverage is still preserved exactly — never
  // silently dropped — and the residual is visible via clampPhaseNightsToMaximum's
  // own unallocatableNights, not hidden inside this function's return value.
  const clamp = clampPhaseNightsToMaximum(phases, MAX_STAY_NIGHTS);
  return { ...frame, phases: clamp.redistributed ? clamp.phases : phases };
}

/* ==================================================================== *
 * ROUND 9.3.2 §2-6, §13-15 — RESERVE-STAY COMPETITION.                  *
 * A rejected-at-selection-time resolved stay is preserved (never re-    *
 * geocoded, spec §2) and may later compete for trip days against the   *
 * weakest currently-allocated day (spec §3), but only past a real,      *
 * meaningful margin (spec §3/§4) and only after the SAME two-stage      *
 * bounded-discovery discipline the rest of this codebase already uses   *
 * (spec §5 — cheap Stage-A ranking here, real Stage-B pool building is  *
 * the caller's job in country-itinerary-generation.ts, which already    *
 * owns all provider/discovery machinery).                               *
 * ==================================================================== */

export interface ReservePromotionCandidate {
  reserve: ResolvedStay;
  /** Straight-line km to the nearest currently-active stay — a cheap, discovery-free transfer-cost proxy (spec §5 Stage A). */
  transferCostKm: number;
  /** Cheap, skeleton-signal-only value estimate (proposed nights + must-visit/preference reasons) — never a substitute for a real post-discovery StayValueProfile. */
  stageAValue: number;
  /** stageAValue minus a distance-derived transfer penalty (capped so a reserve is never driven deeply negative by distance alone) — the ranking key. */
  netStageAScore: number;
}

/**
 * Spec §5 Stage A — ranks reserves by a CHEAP estimate so the caller only
 * spends a real (bounded) discovery pass on the strongest plausible
 * candidate(s), never every reserve. No network call, no pool — only
 * signals the skeleton already resolved (nights/reasons/coordinates).
 */
export function rankReserveStaysForPromotion(reserveStays: ResolvedStay[], activeStays: ResolvedStay[]): ReservePromotionCandidate[] {
  return reserveStays
    .map((reserve) => {
      const userPriority = reserve.reasons.includes("must_visit") || reserve.reasons.includes("preferred_region") ? 1 : reserve.reasons.length > 0 ? 0.5 : 0;
      const stageAValue = Math.max(1, reserve.nights) * 10 * (1 + userPriority * 0.6);
      const transferCostKm =
        activeStays.length > 0 ? Math.min(...activeStays.map((active) => haversineKm(active.lat, active.lon, reserve.lat, reserve.lon))) : 0;
      // Capped at 80% of the reserve's own value (spec §4 — real friction,
      // never enough on distance alone to manufacture a "this reserve is
      // actively harmful" reading before any real comparison happens).
      const transferPenalty = Math.min(stageAValue * 0.8, transferCostKm / 15);
      return { reserve, transferCostKm, stageAValue, netStageAScore: stageAValue - transferPenalty };
    })
    .sort((a, b) => b.netStageAScore - a.netStageAScore);
}

export interface ReservePromotionDecision {
  promote: boolean;
  reserveStayId: string;
  /** The active stay whose next unallocated day would be given up — null when promote is false. */
  demoteFromStayId: string | null;
  reason: string;
}

/**
 * Spec §3/§4 Stage B — the REAL decision, using the reserve's own
 * post-discovery StayValueProfile (built by the caller from a real,
 * bounded pool — never this function's job) against the weakest currently
 * active stay's own already-computed nextUnallocatedDayMarginalValue
 * (NightAllocationResult.allocationDetails, Round 9.3.1). Promotion
 * requires a REAL, meaningful margin (marginRatio > 1), never a
 * fixed-threshold-per-city-type rule (spec §3's own explicit ban) and
 * never a tiny theoretical edge (spec §4).
 */
export function decideReservePromotion(
  reserve: ResolvedStay,
  reserveProfile: StayValueProfile,
  transferCostKm: number,
  activeAllocation: NightAllocationResult,
  /** How much the reserve's own net value must exceed the weakest active day's value before promotion is justified — 1.2 = a real 20% margin, never a coin-flip swap (spec §3 "by a meaningful amount"). */
  minMeaningfulMarginRatio = 1.2
): ReservePromotionDecision {
  let weakestId: string | null = null;
  let weakestValue = Infinity;
  for (const [stayId, details] of activeAllocation.allocationDetails) {
    if (details.nextUnallocatedDayMarginalValue < weakestValue) {
      weakestValue = details.nextUnallocatedDayMarginalValue;
      weakestId = stayId;
    }
  }
  if (weakestId == null) {
    return { promote: false, reserveStayId: reserve.stayId, demoteFromStayId: null, reason: "no active stay available to compare against" };
  }

  const reserveFirstDayValue = marginalValueForNextDay(reserveProfile, 0);
  // Deliberately UNCAPPED here (unlike the Stage-A ranking's own softer
  // penalty, which only orders candidates and never blocks anything) — the
  // FINAL decision must let a genuinely extreme distance defeat even a
  // strong reserve (spec §3/§4's "small reserve advantage does not
  // overcome high transfer friction"), never a fixed per-city-type rule.
  const transferPenalty = transferCostKm / 15;
  const netReserveValue = reserveFirstDayValue - transferPenalty;
  const promote = weakestValue > 0 ? netReserveValue > weakestValue * minMeaningfulMarginRatio : netReserveValue > 0;

  return {
    promote,
    reserveStayId: reserve.stayId,
    demoteFromStayId: promote ? weakestId : null,
    reason: promote
      ? `reserve net value ${netReserveValue.toFixed(1)} exceeds the weakest active stay's next-day value ${weakestValue.toFixed(1)} by the required margin`
      : `reserve net value ${netReserveValue.toFixed(1)} does not meaningfully exceed the weakest active stay's next-day value ${weakestValue.toFixed(1)}`,
  };
}

/**
 * Spec §14/§15 — rebuilds the frame with exactly ONE night moved from the
 * demoted stay to the newly promoted reserve (bounded, single-promotion
 * scope — never a full re-run of stay selection). Total nights are
 * unchanged by construction (one stay's -1 is the new stay's +1); order is
 * re-decided via the SAME optimizeStayRouteSequence primitive every other
 * reorder in this file already uses. Refuses to demote a stay already at
 * its own minimum-viable single night (spec §4's "minimum viable stay").
 */
export function applyReservePromotion(
  frame: TripFrame,
  reserve: ResolvedStay,
  demoteFromStayId: string,
  arrivalAnchor?: { lat: number; lon: number } | null,
  departureAnchor?: { lat: number; lon: number } | null
): TripFrame {
  const demoteFromPhase = frame.phases.find((p) => p.id === demoteFromStayId);
  if (!demoteFromPhase || demoteFromPhase.nights <= 1) return frame;

  const newPhase: TripFramePhase = {
    id: reserve.stayId,
    areaLabel: reserve.areaLabel,
    nights: 1,
    startDayNumber: 0,
    endDayNumber: 0,
    intent: "mixed",
    anchor: { lat: reserve.lat, lon: reserve.lon },
  };
  const adjustedPhases = frame.phases.map((phase) => (phase.id === demoteFromStayId ? { ...phase, nights: phase.nights - 1 } : phase));
  const allPhases = [...adjustedPhases, newPhase];

  const routeNodes: StayRouteNode[] = allPhases.map((phase) => ({
    id: phase.id,
    lat: phase.anchor?.lat ?? 0,
    lon: phase.anchor?.lon ?? 0,
    hasAnchor: phase.anchor != null,
    value: phase.nights,
  }));
  const optimized = optimizeStayRouteSequence(routeNodes, arrivalAnchor ?? null, departureAnchor ?? null);
  const orderedIds = optimized.map((node) => node.id);
  const byId = new Map(allPhases.map((phase) => [phase.id, phase]));
  const reordered = orderedIds.map((id) => byId.get(id)).filter((phase): phase is TripFramePhase => phase != null);
  const finalOrder = reordered.length === allPhases.length ? reordered : allPhases;

  let cursorDay = 1;
  const phases = finalOrder.map((phase) => {
    const startDayNumber = cursorDay;
    const endDayNumber = cursorDay + phase.nights - 1;
    cursorDay = endDayNumber + 1;
    return { ...phase, startDayNumber, endDayNumber };
  });

  return { ...frame, phases };
}
