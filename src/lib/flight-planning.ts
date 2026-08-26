import { addMinutes, format } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import { getCountryTimezone } from "@/lib/facts/country-timezones";
import type { TripFlightLeg, TripFlights } from "@/lib/trip-workspace";

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

function shiftLocalDateTime(date: string, time: string, timeZone: string, minutesToAdd: number): LocalDateTime {
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
          destinationTimeZone,
          ARRIVAL_PROCESSING_MINUTES + AIRPORT_TO_ACCOMMODATION_MINUTES + ACCOMMODATION_CHECKIN_MINUTES
        )
      : null;

  const returnLeg = flights?.return;
  const latestUsableTimeOnDepartureDay =
    returnLeg?.departureDate && returnLeg.departureTime
      ? shiftLocalDateTime(
          returnLeg.departureDate,
          returnLeg.departureTime,
          destinationTimeZone,
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
