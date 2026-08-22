import { formatInTimeZone } from "date-fns-tz";

import { getCountryTimezone } from "@/lib/facts/country-timezones";
import type { TripItineraryDay } from "@/lib/trip-workspace";

export { getCountryTimezone };

/** Destination-local calendar date, "yyyy-MM-dd" — never UTC-blind, never server/browser-local. */
export function getDestinationDateString(isoA2: string, now: Date = new Date()): string {
  return formatInTimeZone(now, getCountryTimezone(isoA2), "yyyy-MM-dd");
}

/** Destination-local wall-clock time, "HH:mm". */
export function getDestinationTimeString(isoA2: string, now: Date = new Date()): string {
  return formatInTimeZone(now, getCountryTimezone(isoA2), "HH:mm");
}

/**
 * Same string-comparison logic as deriveItineraryStatus (itineraries.ts),
 * just against a timezone-correct destination-local "today" instead of a
 * frozen constant or the server/browser's own local date.
 */
export function isTripActiveNow(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  isoA2: string,
  now: Date = new Date()
): boolean {
  if (!startDate || !endDate) return false;
  const today = getDestinationDateString(isoA2, now);
  return startDate <= today && today <= endDate;
}

/**
 * Finds the itinerary day matching destination-local "today", falling back
 * to day-number arithmetic from the trip's start date when no day has a
 * matching `date` field yet (mirrors trip-hub.ts's determineCurrentDay
 * two-step fallback, made timezone-correct).
 */
export function getTripDayForNow(
  days: TripItineraryDay[],
  startDate: string | null | undefined,
  isoA2: string,
  now: Date = new Date()
): TripItineraryDay | null {
  if (days.length === 0) return null;
  const today = getDestinationDateString(isoA2, now);

  const byDate = days.find((day) => day.date === today);
  if (byDate) return byDate;

  if (!startDate) return null;
  const dayNumber = daysBetweenDestinationDates(startDate, today) + 1;
  return days.find((day) => day.dayNumber === dayNumber) ?? null;
}

function daysBetweenDestinationDates(fromDate: string, toDate: string): number {
  const from = Date.UTC(...parseDateParts(fromDate));
  const to = Date.UTC(...parseDateParts(toDate));
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function parseDateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, (month ?? 1) - 1, day ?? 1];
}

/** Milliseconds until the next destination-local midnight, for scheduling a rollover check. */
export function msUntilNextDestinationMidnight(isoA2: string, now: Date = new Date()): number {
  const timeZone = getCountryTimezone(isoA2);
  const [hours, minutes, seconds] = formatInTimeZone(now, timeZone, "HH:mm:ss").split(":").map(Number);
  const elapsedMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return 24 * 60 * 60 * 1000 - elapsedMs;
}
