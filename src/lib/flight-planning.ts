import { addMinutes, format } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import { COUNTRY_NAMES_HE, findAirportByIata } from "@/lib/facts/airports-data";
import { getCountryTimezone } from "@/lib/facts/country-timezones";
import { haversineKm } from "@/lib/trip-workspace";
import type { TripFlightConnection, TripFlightLeg, TripFlights } from "@/lib/trip-workspace";

/** Israel is the fixed home base for every trip — never inferred from the destination. */
export const HOME_COUNTRY_ISO_A2 = "IL";
export const HOME_TIMEZONE = "Asia/Jerusalem";

// Fixed defaults for this pass (flagged in the plan as "configurable later").
const ARRIVAL_PROCESSING_MINUTES = 90; // immigration + luggage, worst-case
const AIRPORT_TO_ACCOMMODATION_MINUTES = 45;
const ACCOMMODATION_CHECKIN_MINUTES = 30;
const ACCOMMODATION_TO_AIRPORT_MINUTES = 45;
const INTERNATIONAL_DEPARTURE_BUFFER_MINUTES = 180; // ~3h before an international flight

export interface LocalDateTime {
  date: string;
  time: string;
}

export interface ArrivalDepartureWindow {
  /** Earliest realistic time to start any activity on day 1. Null when no outbound arrival is set. */
  earliestUsableTimeOnArrivalDay: LocalDateTime | null;
  /** Latest realistic time an activity may still be running on the last day. Null when no return flight is set. */
  latestUsableTimeOnDepartureDay: LocalDateTime | null;
}

function combineDateTime(date: string, time: string): string {
  return `${date}T${time}:00`;
}

export function shiftLocalDateTime(date: string, time: string, timeZone: string, minutesToAdd: number): LocalDateTime {
  const utcInstant = fromZonedTime(combineDateTime(date, time), timeZone);
  const shifted = addMinutes(utcInstant, minutesToAdd);
  const zoned = toZonedTime(shifted, timeZone);
  return { date: format(zoned, "yyyy-MM-dd"), time: format(zoned, "HH:mm") };
}

/**
 * Real timezone-aware duration — never a naive subtraction of local times,
 * since departure and arrival are local to two different airports/zones.
 * Returns null for incomplete legs or a non-positive computed duration.
 */
export function computeFlightDurationMinutes(
  leg: Pick<TripFlightLeg, "departureDate" | "departureTime" | "arrivalDate" | "arrivalTime">,
  departureTimeZone: string,
  arrivalTimeZone: string
): number | null {
  if (!leg.departureDate || !leg.departureTime || !leg.arrivalDate || !leg.arrivalTime) return null;
  const departureUtc = fromZonedTime(combineDateTime(leg.departureDate, leg.departureTime), departureTimeZone);
  const arrivalUtc = fromZonedTime(combineDateTime(leg.arrivalDate, leg.arrivalTime), arrivalTimeZone);
  const minutes = Math.round((arrivalUtc.getTime() - departureUtc.getTime()) / 60000);
  return minutes > 0 ? minutes : null;
}

// Reasonable-estimate fallback (spec item 3, tier 4 — no paid aviation API
// available in this project): average commercial-jet ground speed including
// climb/cruise/descent, plus a fixed taxi/takeoff/landing/approach overhead.
// Good enough for planning-buffer purposes, never presented as an exact
// schedule.
// Short/medium-haul routes spend proportionally more time climbing and
// descending than cruising, so a flat long-haul cruise speed overstates
// them — a single more conservative average (rather than exact cruise
// speed) fits both better than either extreme alone.
const AVERAGE_BLOCK_SPEED_KMH = 750;
const FIXED_GROUND_OPERATIONS_MINUTES = 35;

/** Great-circle distance between two known airports → a reasonable duration estimate. Null if either airport is unrecognized. */
export function estimateFlightDurationMinutesByDistance(
  departureAirportIata: string,
  arrivalAirportIata: string
): number | null {
  const departure = findAirportByIata(departureAirportIata);
  const arrival = findAirportByIata(arrivalAirportIata);
  if (!departure || !arrival) return null;

  const distanceKm = haversineKm(departure.lat, departure.lon, arrival.lat, arrival.lon);
  if (distanceKm <= 0) return null;

  return Math.round((distanceKm / AVERAGE_BLOCK_SPEED_KMH) * 60 + FIXED_GROUND_OPERATIONS_MINUTES);
}

/** The airport's own IANA timezone when known (spec item 4), else the fallback (typically the country-level zone). */
export function resolveAirportTimeZone(iata: string, fallbackTimeZone: string): string {
  return findAirportByIata(iata)?.timezone ?? fallbackTimeZone;
}

export interface FlightArrivalEstimate {
  arrivalDate: string;
  arrivalTime: string;
  estimatedFlightDurationMinutes: number;
  /** True when arrivalDate is a later calendar day than departureDate — spec item 5's "27.8 · 00:00" case. */
  arrivesNextCalendarDay: boolean;
}

/**
 * Deterministic arrival calculation (spec items 2-5) — never asks the AI to
 * invent this (spec item 31). Resolves each airport's own timezone from the
 * curated dataset when known, else falls back to the given country-level
 * zones, and estimates duration from great-circle distance when both
 * airports are recognized. Returns null when duration can't be determined
 * (airport not in the dataset) — callers should fall back to leaving
 * arrival time for manual entry in that case.
 */
export function estimateFlightArrival(
  departureAirportIata: string,
  arrivalAirportIata: string,
  departureDate: string,
  departureTime: string,
  fallbackDepartureTimeZone: string,
  fallbackArrivalTimeZone: string
): FlightArrivalEstimate | null {
  if (!departureAirportIata || !arrivalAirportIata || !departureDate || !departureTime) return null;

  const estimatedFlightDurationMinutes = estimateFlightDurationMinutesByDistance(
    departureAirportIata,
    arrivalAirportIata
  );
  if (estimatedFlightDurationMinutes == null) return null;

  const departureTimeZone = resolveAirportTimeZone(departureAirportIata, fallbackDepartureTimeZone);
  const arrivalTimeZone = resolveAirportTimeZone(arrivalAirportIata, fallbackArrivalTimeZone);

  // Convert departure wall-clock time to a real UTC instant, add the flight
  // duration, then convert that instant into the arrival airport's own
  // wall-clock time — never a naive same-zone addition across two zones.
  const departureInstant = fromZonedTime(combineDateTime(departureDate, departureTime), departureTimeZone);
  const arrivalInstant = addMinutes(departureInstant, estimatedFlightDurationMinutes);
  const arrivalZoned = toZonedTime(arrivalInstant, arrivalTimeZone);
  const arrivalDateResult = format(arrivalZoned, "yyyy-MM-dd");
  const arrivalTimeResult = format(arrivalZoned, "HH:mm");

  return {
    arrivalDate: arrivalDateResult,
    arrivalTime: arrivalTimeResult,
    estimatedFlightDurationMinutes,
    arrivesNextCalendarDay: arrivalDateResult > departureDate,
  };
}

export interface FlightSegmentResult {
  origin: string;
  destination: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  durationMinutes: number;
}

export interface MultiSegmentFlightResult {
  segments: FlightSegmentResult[];
  finalArrivalDate: string;
  finalArrivalTime: string;
  /** Sum of segment durations only — time actually airborne (spec item 38). */
  totalAirborneMinutes: number;
  /** Airborne time plus every layover — what actually determines usable-time-on-arrival (spec item 38/39). */
  totalJourneyMinutes: number;
}

// Ground transfer between two DIFFERENT airports at the same connection
// stop (spec item 6 — "arrived at HND, departing from NRT") — a real
// distance-based estimate (same family as estimateFlightDurationMinutesByDistance),
// on top of the layover itself, never silently treated as no time at all.
const AIRPORT_TRANSFER_GROUND_SPEED_KMH = 40;
const AIRPORT_TRANSFER_FIXED_OVERHEAD_MINUTES = 30;

export function estimateAirportTransferMinutes(fromIata: string, toIata: string): number | null {
  const from = findAirportByIata(fromIata);
  const to = findAirportByIata(toIata);
  if (!from || !to) return null;
  const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
  return Math.round(AIRPORT_TRANSFER_FIXED_OVERHEAD_MINUTES + (km / AIRPORT_TRANSFER_GROUND_SPEED_KMH) * 60);
}

/**
 * Chains estimateFlightArrival across zero or more intermediate connections
 * (spec items 17-21) — each REAL FLIGHT segment is calculated
 * independently. A connection contributes two airports to the chain (the
 * one it lands at, the one the next segment departs from — usually the
 * same one); when they differ, a real ground-transfer time is added on top
 * of the layover (spec item 6), computed and applied in the arrival
 * airport's own local time throughout — exact for the common case of an
 * airport change within the same city/timezone, a small known
 * simplification for the rare case of a cross-timezone connection change.
 * Zero connections is the default, ordinary direct-flight path (spec item
 * 22) and returns a single-segment result identical in shape to a
 * connecting itinerary. Returns null if any airport in the chain can't be
 * resolved — same manual-entry fallback contract as estimateFlightArrival.
 */
export function computeMultiSegmentFlight(
  departureAirportIata: string,
  finalArrivalAirportIata: string,
  departureDate: string,
  departureTime: string,
  connections: TripFlightConnection[],
  departureTimeZoneFallback: string,
  arrivalTimeZoneFallback: string
): MultiSegmentFlightResult | null {
  if (!departureAirportIata || !finalArrivalAirportIata || !departureDate || !departureTime) return null;
  if (connections.some((connection) => !connection.arrivalAirport || !connection.departureAirport)) return null;

  const flightOrigins = [departureAirportIata, ...connections.map((connection) => connection.departureAirport)];
  const flightDestinations = [...connections.map((connection) => connection.arrivalAirport), finalArrivalAirportIata];

  const segments: FlightSegmentResult[] = [];
  let currentDate = departureDate;
  let currentTime = departureTime;
  let totalAirborneMinutes = 0;
  let totalGroundMinutes = 0;

  for (let index = 0; index < flightOrigins.length; index += 1) {
    const origin = flightOrigins[index];
    const destination = flightDestinations[index];
    const isFirstHop = index === 0;
    const isLastHop = index === flightOrigins.length - 1;

    const estimate = estimateFlightArrival(
      origin,
      destination,
      currentDate,
      currentTime,
      isFirstHop ? departureTimeZoneFallback : arrivalTimeZoneFallback,
      arrivalTimeZoneFallback
    );
    if (!estimate) return null;

    segments.push({
      origin,
      destination,
      departureDate: currentDate,
      departureTime: currentTime,
      arrivalDate: estimate.arrivalDate,
      arrivalTime: estimate.arrivalTime,
      durationMinutes: estimate.estimatedFlightDurationMinutes,
    });
    totalAirborneMinutes += estimate.estimatedFlightDurationMinutes;

    if (!isLastHop) {
      const connection = connections[index];
      const layoverMinutes = Math.max(0, connection.layoverMinutes ?? 0);
      const transferMinutes =
        connection.arrivalAirport !== connection.departureAirport
          ? estimateAirportTransferMinutes(connection.arrivalAirport, connection.departureAirport) ?? 0
          : 0;
      const groundMinutes = layoverMinutes + transferMinutes;
      totalGroundMinutes += groundMinutes;

      const layoverTimeZone = resolveAirportTimeZone(destination, arrivalTimeZoneFallback);
      const next = shiftLocalDateTime(estimate.arrivalDate, estimate.arrivalTime, layoverTimeZone, groundMinutes);
      currentDate = next.date;
      currentTime = next.time;
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    segments,
    finalArrivalDate: lastSegment.arrivalDate,
    finalArrivalTime: lastSegment.arrivalTime,
    totalAirborneMinutes,
    totalJourneyMinutes: totalAirborneMinutes + totalGroundMinutes,
  };
}

/**
 * A country-aware view of a leg's route — one entry per real flight
 * segment, each carrying its own origin/destination country (not just
 * airport), derived on demand from the leg's existing flat fields +
 * connections rather than a separately stored duplicate. Used for the UI's
 * per-segment labels/route summary and for validation. Never persisted —
 * same "zero-migration" reasoning as the rest of this leg's design.
 */
export interface FlightJourneySegment {
  originCountry: string;
  originAirport: string;
  destinationCountry: string;
  destinationAirport: string;
  /** The connection immediately following this segment, if any (null for the last segment). */
  layoverMinutes: number | null;
  /** True when that connection's departure airport differs from its arrival airport (spec item 6). */
  airportChangedAfter: boolean;
}

export function getJourneySegments(
  leg: Pick<TripFlightLeg, "departureAirport" | "arrivalAirport" | "connections">,
  originCountryIso: string,
  destinationCountryIso: string
): FlightJourneySegment[] {
  if (!leg.departureAirport || !leg.arrivalAirport) return [];

  const connections = leg.connections ?? [];
  const segments: FlightJourneySegment[] = [];

  for (let index = 0; index <= connections.length; index += 1) {
    const isFirst = index === 0;
    const isLast = index === connections.length;
    const connectionAfter = isLast ? null : connections[index];

    segments.push({
      originCountry: isFirst ? originCountryIso : connections[index - 1].countryIso,
      originAirport: isFirst ? leg.departureAirport : connections[index - 1].departureAirport,
      destinationCountry: isLast ? destinationCountryIso : connections[index].countryIso,
      destinationAirport: isLast ? leg.arrivalAirport : connections[index].arrivalAirport,
      layoverMinutes: connectionAfter ? connectionAfter.layoverMinutes : null,
      airportChangedAfter: connectionAfter ? connectionAfter.arrivalAirport !== connectionAfter.departureAirport : false,
    });
  }

  return segments;
}

/**
 * Defensive, independent check (spec items 20/21) — even though
 * getJourneySegments's own output always chains by construction, this is
 * also meant to validate raw data reconstructed elsewhere (e.g.
 * server-side from a request payload). Only rejects an airport we actually
 * recognize and can place in the wrong country — same
 * never-reject-what-we-don't-know rule as validateFlightAirportCountries.
 */
export function validateJourneySegments(
  segments: FlightJourneySegment[],
  originCountryIso: string,
  destinationCountryIso: string
): string | null {
  if (segments.length === 0) return null;

  const originIso = originCountryIso.trim().toUpperCase();
  const destinationIso = destinationCountryIso.trim().toUpperCase();

  const first = segments[0];
  if (first.originCountry.trim().toUpperCase() !== originIso) {
    return "מקטע הטיסה הראשון חייב להתחיל במדינת המוצא של הטיול.";
  }
  const last = segments[segments.length - 1];
  if (last.destinationCountry.trim().toUpperCase() !== destinationIso) {
    return "מקטע הטיסה האחרון חייב להסתיים במדינת היעד של הטיול.";
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const originAirport = findAirportByIata(segment.originAirport);
    if (originAirport && originAirport.countryIso !== segment.originCountry.trim().toUpperCase()) {
      return `שדה התעופה ${segment.originAirport} אינו נמצא ב${COUNTRY_NAMES_HE[segment.originCountry.toUpperCase()] ?? segment.originCountry}.`;
    }
    const destinationAirport = findAirportByIata(segment.destinationAirport);
    if (destinationAirport && destinationAirport.countryIso !== segment.destinationCountry.trim().toUpperCase()) {
      return `שדה התעופה ${segment.destinationAirport} אינו נמצא ב${COUNTRY_NAMES_HE[segment.destinationCountry.toUpperCase()] ?? segment.destinationCountry}.`;
    }
    if (index > 0 && segments[index - 1].destinationCountry.trim().toUpperCase() !== segment.originCountry.trim().toUpperCase()) {
      return "מקטעי הטיסה אינם מחוברים — מדינת ההגעה של מקטע אחד חייבת להיות מדינת היציאה של המקטע הבא.";
    }
  }

  return null;
}

/** One structured, debuggable finding from detectInvalidFlightLegs — never a bare boolean, so a caller/log always has enough to act on. */
export interface InvalidFlightLegDiagnostic {
  legId: "outbound" | "return" | `connection-${number}`;
  originAirport: string;
  destinationAirport: string;
  reason: string;
}

/**
 * Generic, airport-agnostic sanity check (spec §A2) — a leg (or a
 * connection's own hop) whose origin and destination airport are identical
 * is never a real flight, regardless of which airport it happens to be.
 * Catches an accidental default surviving two dropdowns silently resolving
 * to the same value, without ever naming a specific airport/country.
 */
export function detectInvalidFlightLegs(flights: TripFlights | null | undefined): InvalidFlightLegDiagnostic[] {
  const findings: InvalidFlightLegDiagnostic[] = [];
  if (!flights) return findings;

  const checkLeg = (legId: InvalidFlightLegDiagnostic["legId"], leg: TripFlightLeg | null) => {
    if (!leg || !leg.departureAirport || !leg.arrivalAirport) return;
    if (leg.departureAirport.trim().toUpperCase() === leg.arrivalAirport.trim().toUpperCase()) {
      findings.push({
        legId,
        originAirport: leg.departureAirport,
        destinationAirport: leg.arrivalAirport,
        reason: "origin and destination airport are identical — this cannot be a real flight leg",
      });
    }
  };

  checkLeg("outbound", flights.outbound);
  checkLeg("return", flights.return);

  return findings;
}

/**
 * Destination-local windows a first/last itinerary day must respect, derived
 * from the outbound arrival and return departure times plus fixed processing
 * buffers (spec §D4/§D9/§D10). Pre-computed here so the AI planner never has
 * to redo this arithmetic itself (spec §D16).
 */
export function computeArrivalDepartureWindow(
  flights: TripFlights | undefined,
  destinationIsoA2: string
): ArrivalDepartureWindow {
  const destinationTimeZone = getCountryTimezone(destinationIsoA2);

  const outbound = flights?.outbound;
  const earliestUsableTimeOnArrivalDay =
    outbound?.arrivalDate && outbound.arrivalTime
      ? shiftLocalDateTime(
          outbound.arrivalDate,
          outbound.arrivalTime,
          resolveAirportTimeZone(outbound.arrivalAirport, destinationTimeZone),
          ARRIVAL_PROCESSING_MINUTES + AIRPORT_TO_ACCOMMODATION_MINUTES + ACCOMMODATION_CHECKIN_MINUTES
        )
      : null;

  const returnLeg = flights?.return;
  const latestUsableTimeOnDepartureDay =
    returnLeg?.departureDate && returnLeg.departureTime
      ? shiftLocalDateTime(
          returnLeg.departureDate,
          returnLeg.departureTime,
          resolveAirportTimeZone(returnLeg.departureAirport, destinationTimeZone),
          -(INTERNATIONAL_DEPARTURE_BUFFER_MINUTES + ACCOMMODATION_TO_AIRPORT_MINUTES)
        )
      : null;

  return { earliestUsableTimeOnArrivalDay, latestUsableTimeOnDepartureDay };
}

// computeArrivalDepartureWindow's AIRPORT_TO_ACCOMMODATION_MINUTES/
// ACCOMMODATION_TO_AIRPORT_MINUTES are fixed planning assumptions — real
// only when the day's actual base is a normal, nearby distance from the
// airport. Ground speed is a deliberately conservative average (city
// streets + some highway, not a real routing API — same reasoning as
// AVERAGE_BLOCK_SPEED_KMH above) used only to catch a base that's clearly
// a *different region* from the airport, not to time-box a normal commute.
const AVERAGE_GROUND_SPEED_KMH = 50;
const AIRPORT_BASE_MISMATCH_EXTRA_MINUTES = 45;

export interface AirportBaseMismatchDiagnostic {
  direction: "arrival" | "departure";
  airport: string;
  estimatedGroundMinutes: number;
  assumedGroundMinutes: number;
}

/**
 * Generic distance check (spec §A3-A5) — flags an airport whose real
 * great-circle distance from the day's own dominant anchor coordinates
 * implies meaningfully more ground travel than the fixed buffer the
 * arrival/departure window already assumes. Deliberately conservative
 * (only trips clearly past a different-region distance, never a normal
 * same-city commute) since haversine + a flat speed is an estimate, not a
 * real route. Structural inputs only (no AiGeneratedItem import), same
 * leaf-module convention as the rest of this file.
 */
export function detectAirportBaseMismatch(
  direction: "arrival" | "departure",
  airportIata: string,
  dayAnchors: Array<{ lat: number | null; lon: number | null }>
): AirportBaseMismatchDiagnostic | null {
  const airport = findAirportByIata(airportIata);
  if (!airport) return null;

  const anchorsWithCoordinates = dayAnchors.filter(
    (anchor): anchor is { lat: number; lon: number } => anchor.lat != null && anchor.lon != null
  );
  if (anchorsWithCoordinates.length === 0) return null;

  const nearestDistanceKm = Math.min(
    ...anchorsWithCoordinates.map((anchor) => haversineKm(airport.lat, airport.lon, anchor.lat, anchor.lon))
  );
  const estimatedGroundMinutes = Math.round((nearestDistanceKm / AVERAGE_GROUND_SPEED_KMH) * 60);
  const assumedGroundMinutes =
    direction === "arrival" ? AIRPORT_TO_ACCOMMODATION_MINUTES : ACCOMMODATION_TO_AIRPORT_MINUTES;

  if (estimatedGroundMinutes <= assumedGroundMinutes + AIRPORT_BASE_MISMATCH_EXTRA_MINUTES) return null;

  return { direction, airport: airportIata, estimatedGroundMinutes, assumedGroundMinutes };
}

// Not "a normal day must remain" (that's a quality preference, not a
// feasibility question) — this is the absolute floor: at least enough time
// to wake and get ready before the ground-transit-plus-buffer countdown to
// the flight has to start. Below this, the traveler would need to leave
// before a normal night's sleep even ends, regardless of which country/
// city/airport is involved (spec §B2's hard rejection). This is exactly
// what makes an early flight require a close base and a late flight
// tolerate a farther one (spec §B3/§B4) — the same real time budget,
// evaluated against a real distance, with no separate distance rule.
const MINIMUM_REASONABLE_DEPARTURE_DAY_MINUTES = 60;

export interface FinalBaseDepartureFeasibility {
  feasible: boolean;
  estimatedGroundMinutes: number;
  usableMinutesOfDay: number;
}

/**
 * Real time-based feasibility (spec §B1-B4) for choosing which candidate
 * area should be the trip's FINAL overnight base, given the actual return
 * flight — not a threshold applied after the fact, meant to run BEFORE
 * that base is committed to. Generic: works from coordinates and a clock
 * time only, no airport/city ever named in the logic itself.
 */
export function evaluateFinalBaseDepartureFeasibility(
  departureAirportIata: string,
  departureTime: string,
  areaAnchor: { lat: number; lon: number }
): FinalBaseDepartureFeasibility | null {
  const airport = findAirportByIata(departureAirportIata);
  const departureMinutes = parseClockTimeToMinutes(departureTime);
  if (!airport || departureMinutes == null) return null;

  const distanceKm = haversineKm(airport.lat, airport.lon, areaAnchor.lat, areaAnchor.lon);
  const estimatedGroundMinutes = Math.round((distanceKm / AVERAGE_GROUND_SPEED_KMH) * 60);
  const usableMinutesOfDay = departureMinutes - INTERNATIONAL_DEPARTURE_BUFFER_MINUTES - estimatedGroundMinutes;

  return {
    feasible: usableMinutesOfDay >= MINIMUM_REASONABLE_DEPARTURE_DAY_MINUTES,
    estimatedGroundMinutes,
    usableMinutesOfDay,
  };
}

/**
 * Shared by both the diagnostics counter (itinerary-generation-constraints.ts)
 * and the repair pass (country-itinerary-generation.ts) so the two never
 * drift out of sync on what counts as a violation. Deliberately structural
 * (no import of AiGeneratedItem/AiGeneratedDay) to keep this module a leaf
 * with no dependency on the generation engine.
 */
export function violatesArrivalDepartureWindow(
  itemPlannedStartTime: string,
  dayDate: string,
  isArrivalDay: boolean,
  isDepartureDay: boolean,
  window: ArrivalDepartureWindow,
  /**
   * The item's real occupied-until clock time (same day) — required to
   * correctly validate the departure-day check below, which must look at
   * when the item ENDS, not when it starts (spec §A1: "starts before
   * cutoff, ends after cutoff" must be invalid). Callers derive this via
   * itinerary-planning-principles.ts's resolveItemEffectiveEndTime — the
   * exact same canonical duration semantics used everywhere else — never a
   * second interpretation. Optional/omittable only for callers with no
   * item context at all (e.g. a bare clock-time probe); falls back to
   * treating start and end as identical in that case, which under-detects
   * rather than over-detects.
   */
  itemEffectiveEndTime?: string | null
): boolean {
  const itemStartMinutes = parseClockTimeToMinutes(itemPlannedStartTime);
  if (itemStartMinutes == null) return false;

  if (isArrivalDay && window.earliestUsableTimeOnArrivalDay) {
    const { date, time } = window.earliestUsableTimeOnArrivalDay;
    if (date > dayDate) return true;
    if (date === dayDate) {
      const earliestMinutes = parseClockTimeToMinutes(time);
      if (earliestMinutes != null && itemStartMinutes < earliestMinutes) return true;
    }
  }

  if (isDepartureDay && window.latestUsableTimeOnDepartureDay) {
    const { date, time } = window.latestUsableTimeOnDepartureDay;
    const itemEndMinutes =
      (itemEffectiveEndTime != null ? parseClockTimeToMinutes(itemEffectiveEndTime) : null) ?? itemStartMinutes;
    if (date < dayDate) return true;
    if (date === dayDate) {
      const latestMinutes = parseClockTimeToMinutes(time);
      if (latestMinutes != null && itemEndMinutes > latestMinutes) return true;
    }
  }

  return false;
}

function parseClockTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Folds flight cost into cost aggregation via the same generic
 * extraExpenses hook other one-off costs already use (summarizeItemCosts) —
 * no new aggregation system, per spec §D-budget.
 */
export function flightCostExpenses(flights: TripFlights | undefined): Array<{ category: "flights"; amount: number }> {
  const expenses: Array<{ category: "flights"; amount: number }> = [];
  if (flights?.outbound?.cost != null && flights.outbound.cost > 0) {
    expenses.push({ category: "flights", amount: flights.outbound.cost });
  }
  if (flights?.return?.cost != null && flights.return.cost > 0) {
    expenses.push({ category: "flights", amount: flights.return.cost });
  }
  return expenses;
}

/** Mirrors the existing describeTripFrame pattern: compute deterministically, describe as prompt text. */
export function describeArrivalDepartureWindow(window: ArrivalDepartureWindow): string {
  const parts: string[] = [];
  if (window.earliestUsableTimeOnArrivalDay) {
    const { date, time } = window.earliestUsableTimeOnArrivalDay;
    parts.push(
      `The traveler's outbound flight lands on day 1. After immigration, luggage, transfer to the accommodation, and check-in, nothing should realistically be scheduled before ${time} local time on ${date}. If that time is late in the day, day 1 should only include arrival, transfer, check-in, and — only if practical — dinner and rest, never a full activity itinerary.`
    );
  }
  if (window.latestUsableTimeOnDepartureDay) {
    const { date, time } = window.latestUsableTimeOnDepartureDay;
    parts.push(
      `The traveler's return flight departs on the last day. Once transfer to the airport and check-in buffer are accounted for, nothing should realistically be scheduled after ${time} local time on ${date}. If that time is early in the day, the last day should only include breakfast, checkout, and transfer to the airport, never a scheduled attraction.`
    );
  }
  return parts.join(" ");
}
