import { addMinutes, format } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import { findAirportByIata } from "@/lib/facts/airports-data";
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

/**
 * Chains estimateFlightArrival across zero or more intermediate connections
 * (spec items 17-21) — each segment is calculated independently, with the
 * layover added (in the connection airport's own local time) between one
 * segment's arrival and the next segment's departure. Zero connections is
 * the default, ordinary direct-flight path (spec item 22) and returns a
 * single-segment result identical in shape to a connecting itinerary.
 * Returns null if any airport in the chain can't be resolved — same
 * manual-entry fallback contract as estimateFlightArrival.
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

  const stops = [departureAirportIata, ...connections.map((connection) => connection.airport), finalArrivalAirportIata];
  if (stops.some((iata) => !iata)) return null;

  const segments: FlightSegmentResult[] = [];
  let currentDate = departureDate;
  let currentTime = departureTime;
  let totalAirborneMinutes = 0;
  let totalLayoverMinutes = 0;

  for (let index = 0; index < stops.length - 1; index += 1) {
    const origin = stops[index];
    const destination = stops[index + 1];
    const isFirstHop = index === 0;
    const isLastHop = index === stops.length - 2;

    const estimate = estimateFlightArrival(
      origin,
      destination,
      currentDate,
      currentTime,
      isFirstHop ? departureTimeZoneFallback : arrivalTimeZoneFallback,
      isLastHop ? arrivalTimeZoneFallback : arrivalTimeZoneFallback
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
      const layoverMinutes = Math.max(0, connections[index]?.layoverMinutes ?? 0);
      totalLayoverMinutes += layoverMinutes;
      const layoverTimeZone = resolveAirportTimeZone(destination, arrivalTimeZoneFallback);
      const next = shiftLocalDateTime(estimate.arrivalDate, estimate.arrivalTime, layoverTimeZone, layoverMinutes);
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
    totalJourneyMinutes: totalAirborneMinutes + totalLayoverMinutes,
  };
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
  window: ArrivalDepartureWindow
): boolean {
  const itemMinutes = parseClockTimeToMinutes(itemPlannedStartTime);
  if (itemMinutes == null) return false;

  if (isArrivalDay && window.earliestUsableTimeOnArrivalDay) {
    const { date, time } = window.earliestUsableTimeOnArrivalDay;
    if (date > dayDate) return true;
    if (date === dayDate) {
      const earliestMinutes = parseClockTimeToMinutes(time);
      if (earliestMinutes != null && itemMinutes < earliestMinutes) return true;
    }
  }

  if (isDepartureDay && window.latestUsableTimeOnDepartureDay) {
    const { date, time } = window.latestUsableTimeOnDepartureDay;
    if (date < dayDate) return true;
    if (date === dayDate) {
      const latestMinutes = parseClockTimeToMinutes(time);
      if (latestMinutes != null && itemMinutes > latestMinutes) return true;
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
