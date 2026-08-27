import type { ArrivalDepartureWindow } from "../flight-planning";
import type { AiGeneratedItem } from "../trip-workspace";
import { classifyVisitScale, resolveVisitDurationMinutes, type VisitScale } from "./itinerary-planning-principles";

/**
 * Real per-day clock-time scheduler — the missing piece that let two items
 * both land on "12:30" (spec item 58). Previously, item timing came from a
 * table of hardcoded literal clock times keyed to an item's *position*
 * (resequenceDayItems's inline slot-time table in
 * country-itinerary-generation.ts), with no notion of how long the
 * preceding item actually takes. This module turns an already-ordered list
 * of items (the caller still decides relative order — anchor, lunch,
 * anchor, dinner, etc.) into a real, non-overlapping timeline: each item's
 * start is the previous item's end + travel time + a buffer, and its own
 * duration comes from resolveVisitDurationMinutes (spec item 11's
 * visit-scale system) instead of a flat generic guess.
 */

export interface DayTimeWindow {
  startMinutes: number;
  endMinutes: number;
}

const DEFAULT_DAY_START_MINUTES = 9 * 60; // 09:00
const DEFAULT_DAY_END_MINUTES = 22 * 60; // 22:00
const MIN_WINDOW_MINUTES = 60;

// Realistic buffers between activities (spec item 17) — never back-to-back.
const BUFFER_NORMAL_MINUTES = 8; // 5-10 range
const BUFFER_RESERVATION_MINUTES = 20; // 15-30 range
const BUFFER_LARGE_ATTRACTION_MINUTES = 30;

// A leftover window shorter than this isn't worth a dedicated "זמן חופשי"
// block — it just becomes slack before the next scheduled thing.
const MIN_FREE_TIME_BLOCK_MINUTES = 45;

export function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * The plain normal-day window, exported for callers that schedule a day's
 * items without threading dayCount/the real arrival-departure window
 * through their own call chain — the existing, separate
 * enforceArrivalDepartureWindow repair pass still catches and fixes any
 * arrival/departure violations afterward exactly as it does today, so this
 * is a safe default rather than a gap.
 */
export const DEFAULT_DAY_WINDOW: DayTimeWindow = { startMinutes: DEFAULT_DAY_START_MINUTES, endMinutes: DEFAULT_DAY_END_MINUTES };

export function minutesToClock(totalMinutes: number): string {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * The day's real available window (spec item 14). Day 1 (arrival) and the
 * last day (departure) narrow to the existing, already-computed real
 * timezone-aware arrival/departure window; every other day gets the normal
 * 09:00-22:00 range. Never collapses to a degenerate/negative window.
 */
export function computeDayWindow(
  dayNumber: number,
  dayCount: number,
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
): DayTimeWindow {
  let start = DEFAULT_DAY_START_MINUTES;
  let end = DEFAULT_DAY_END_MINUTES;

  if (dayNumber === 1 && arrivalDepartureWindow?.earliestUsableTimeOnArrivalDay) {
    const parsed = clockToMinutes(arrivalDepartureWindow.earliestUsableTimeOnArrivalDay.time);
    if (parsed != null) start = Math.max(start, parsed);
  }
  if (dayNumber === dayCount && arrivalDepartureWindow?.latestUsableTimeOnDepartureDay) {
    const parsed = clockToMinutes(arrivalDepartureWindow.latestUsableTimeOnDepartureDay.time);
    if (parsed != null) end = Math.min(end, parsed);
  }

  if (end - start < MIN_WINDOW_MINUTES) end = start + MIN_WINDOW_MINUTES;
  return { startMinutes: start, endMinutes: end };
}

function bufferMinutesFor(item: AiGeneratedItem, scale: VisitScale): number {
  if (item.reservationRequired) return BUFFER_RESERVATION_MINUTES;
  if (scale === "half_day" || scale === "full_day") return BUFFER_LARGE_ATTRACTION_MINUTES;
  return BUFFER_NORMAL_MINUTES;
}

// Rotating phrasing (not one fixed name) — a multi-day trip based in one
// area can easily produce several free-time blocks across different days,
// and a byte-identical name+location with no id/coordinates would
// otherwise be indistinguishable from a genuine duplicate-place bug to
// buildItemKey's fallback tier. Keyed by the block's own start time, which
// is already effectively unique per occurrence since it comes from the
// real computed schedule.
const FREE_TIME_NAMES = ["זמן חופשי", "זמן פנוי", "הפסקה גמישה", "זמן לעצמכם"];

export function buildFreeTimeItem(startMinutes: number, endMinutes: number, areaLabel: string): AiGeneratedItem {
  const name = FREE_TIME_NAMES[startMinutes % FREE_TIME_NAMES.length];
  return {
    name,
    category: "practical",
    location: areaLabel,
    shortDescription: areaLabel
      ? `זמן פנוי באזור ${areaLabel} — בית קפה, מנוחה, קניות או טיול קצר לפי מה שבא לכם.`
      : "זמן פנוי — בית קפה, מנוחה, קניות או טיול קצר לפי מה שבא לכם.",
    slot: "afternoon",
    plannedStartTime: minutesToClock(startMinutes),
    endTime: minutesToClock(endMinutes),
    estimatedDurationMinutes: Math.max(endMinutes - startMinutes, 0),
    approximatePrice: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: null,
    openingHours: "",
    reservationRequired: false,
    transportation: "",
    mapLink: "",
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "optional",
    fixedTime: false,
  };
}

export interface ScheduleResult {
  items: AiGeneratedItem[];
  /** Present only when the leftover window is worth a dedicated block (spec item 26). */
  freeTimeItem: AiGeneratedItem | null;
}

/**
 * Walks an already-ordered item list and assigns real, non-overlapping
 * plannedStartTime/endTime. A full_day-scale anchor consumes essentially
 * the rest of the window (spec item 12) — the caller (resequenceDayItems)
 * is responsible for not including a second anchor alongside one, same as
 * it already decides overall item order; this function only turns order
 * into real time.
 */
export function scheduleDayItems(orderedItems: AiGeneratedItem[], window: DayTimeWindow, areaLabel: string): ScheduleResult {
  let cursor = window.startMinutes;
  const scheduled: AiGeneratedItem[] = [];

  for (const item of orderedItems) {
    if (item.category === "transportation") {
      // Connective, not content — anchored to the cursor with its own real
      // travel duration, no extra buffer stacked on top of it.
      const duration = Math.max(item.travelMinutes ?? 15, 5);
      const start = cursor;
      const end = start + duration;
      scheduled.push({ ...item, plannedStartTime: minutesToClock(start), endTime: minutesToClock(end) });
      cursor = end;
      continue;
    }

    // Real travel time from the previous stop occupies the timeline before
    // this item can start (spec item 16) — it's already resolved onto the
    // item's own travelMinutes elsewhere in the pipeline.
    if (item.travelMinutes && item.travelMinutes > 0) {
      cursor += item.travelMinutes;
    }

    const scale = classifyVisitScale(item);
    const remainingWindow = Math.max(window.endMinutes - cursor, 60);
    const resolvedDuration = resolveVisitDurationMinutes(item, scale);
    const duration = scale === "full_day" ? Math.min(resolvedDuration, remainingWindow) : resolvedDuration;

    const start = cursor;
    const end = start + duration;
    scheduled.push({ ...item, plannedStartTime: minutesToClock(start), endTime: minutesToClock(end) });
    cursor = end + bufferMinutesFor(item, scale);
  }

  const leftover = window.endMinutes - cursor;
  const freeTimeItem = leftover >= MIN_FREE_TIME_BLOCK_MINUTES ? buildFreeTimeItem(cursor, window.endMinutes, areaLabel) : null;

  return { items: scheduled, freeTimeItem };
}
