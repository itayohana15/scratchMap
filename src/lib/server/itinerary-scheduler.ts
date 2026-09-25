import type { ArrivalDepartureWindow } from "../flight-planning";
import type { AiGeneratedItem } from "../trip-workspace";
import { classifyVisitScale, resolveVisitDurationMinutes, type VisitScale } from "./itinerary-planning-principles";
import { logRealPlaceQA } from "./real-place-qa";

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
// Round 9.15.2 §G/§H/§I/§J — this is now split into two conceptually
// distinct pieces per exit buffer (never exposed as separate items to the
// user — both stay internal timeline spacing, spec §N):
//   - "operational" (spec §I): mandatory practical overhead (leaving the
//     venue, finding the exit) — small, and NEVER compressed, even for a
//     fixed-time event (spec §M point 2).
//   - "pacing" (spec §J): human breathing room — contextual by what the
//     PREVIOUS item actually was (coffee/ordinary attraction/lunch/dinner/
//     physically demanding), and the ONLY piece a fixed-time event may
//     compress (spec §L/§M point 3), never below a small residual.
// The old flat BUFFER_NORMAL_MINUTES(8)/BUFFER_RESERVATION_MINUTES(20)/
// BUFFER_LARGE_ATTRACTION_MINUTES(30) constants are gone — every case they
// covered is now one row in PACING_BUFFER_MINUTES_BY_REASON below (kept at
// or above the LOW end of spec §J's own ranges, deliberately conservative
// to bound how many pre-existing exact-time assertions shift).
const OPERATIONAL_BUFFER_MINUTES_ORDINARY = 5;
const OPERATIONAL_BUFFER_MINUTES_RESERVATION_OR_MAJOR = 10;
const MIN_COMPRESSED_PACING_MINUTES = 5;

export type PacingBufferReason = "COFFEE_CAFE" | "ORDINARY_ATTRACTION" | "LUNCH" | "DINNER" | "PHYSICALLY_DEMANDING" | "RESERVATION";

const PACING_BUFFER_MINUTES_BY_REASON: Record<PacingBufferReason, number> = {
  COFFEE_CAFE: 12,
  ORDINARY_ATTRACTION: 18,
  LUNCH: 30,
  DINNER: 35,
  PHYSICALLY_DEMANDING: 60,
  RESERVATION: 15,
};

/**
 * Round 9.15.2 §G/§J — classifies WHY a pacing buffer of a given size
 * applies, from the item that just ended. A meal's OWN `slot` (lunch vs
 * dinner) is the primary signal (never guessed from category name alone,
 * since a "cafe" category item can legitimately be either a quick coffee
 * stop or the day's lunch); a cafe-category item with no lunch/dinner slot
 * is treated as an ordinary quick coffee stop, never a full meal.
 */
export function classifyPacingBufferReason(item: AiGeneratedItem, scale: VisitScale | null): PacingBufferReason {
  if (item.reservationRequired) return "RESERVATION";
  const isMealCategory = item.category === "restaurant" || item.category === "cafe";
  if (isMealCategory) {
    if (item.slot === "dinner") return "DINNER";
    if (item.slot === "lunch") return "LUNCH";
    return "COFFEE_CAFE";
  }
  if (scale === "full_day" || scale === "half_day") return "PHYSICALLY_DEMANDING";
  return "ORDINARY_ATTRACTION";
}

export interface ExitBufferBreakdown {
  operationalMinutes: number;
  pacingMinutes: number;
  reason: PacingBufferReason;
}

function computeExitBufferBreakdown(item: AiGeneratedItem, scale: VisitScale | null): ExitBufferBreakdown {
  const reason = classifyPacingBufferReason(item, scale);
  const operationalMinutes =
    item.reservationRequired || scale === "full_day" || scale === "half_day"
      ? OPERATIONAL_BUFFER_MINUTES_RESERVATION_OR_MAJOR
      : OPERATIONAL_BUFFER_MINUTES_ORDINARY;
  return { operationalMinutes, pacingMinutes: PACING_BUFFER_MINUTES_BY_REASON[reason], reason };
}

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

/**
 * Round 9.15.2 §G/§L/§M — the exit buffer after an item ends, now
 * contextual (spec §J's "not hard constants" — see PACING_BUFFER_MINUTES_BY_REASON).
 * `compressForFixedEvent` (spec §L/§M): when the NEXT item is a fixed-time
 * commitment that would otherwise be missed, the OPTIONAL pacing portion
 * may shrink to a small residual — the MANDATORY operational portion never
 * does, and this function never touches real travel time (that stays a
 * separate addend at every call site, unchanged).
 */
export function bufferMinutesFor(item: AiGeneratedItem, scale: VisitScale | null, compressForFixedEvent = false): number {
  const { operationalMinutes, pacingMinutes } = computeExitBufferBreakdown(item, scale);
  const effectivePacing = compressForFixedEvent ? Math.min(pacingMinutes, MIN_COMPRESSED_PACING_MINUTES) : pacingMinutes;
  return operationalMinutes + effectivePacing;
}

/**
 * Round 9.4.4 §Q2 — a real arrival/entry buffer (queue, security, ticket
 * check-in) BEFORE a visit starts, distinct from bufferMinutesFor's own
 * EXIT buffer after it ends. Only applied where real evidence supports it
 * (a reservation requirement, or a half/full-day-scale major attraction —
 * the same two signals bufferMinutesFor already uses on the exit side) —
 * never for an ordinary short/medium stop, and never by shrinking the
 * visit's own duration (spec's explicit "do not solve fuller days by
 * shrinking activity durations" applies here too — this ADDS time, never
 * subtracts from resolveVisitDurationMinutes's own result).
 */
function entryBufferMinutesFor(item: AiGeneratedItem, scale: VisitScale | null): number {
  if (item.reservationRequired) return 15;
  if (scale === "half_day" || scale === "full_day") return 15;
  return 0;
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
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: null,
    openingHours: "",
    lastEntryTime: "",
    canonicalPlaceId: "",
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

/**
 * A user- or AI-fixed clock time (spec: "the activity start time may not be
 * shifted automatically") — a hard scheduling anchor, never recomputed from
 * the cursor. Requires a parseable plannedStartTime; a fixedTime item with
 * unparseable/missing time defensively falls back to normal flexible
 * scheduling rather than silently anchoring to a garbage time.
 */
function isFixedAnchor(item: AiGeneratedItem): boolean {
  return item.fixedTime === true && clockToMinutes(item.plannedStartTime) != null;
}

function resolveFixedAnchorTimes(item: AiGeneratedItem): { start: number; end: number } {
  const start = clockToMinutes(item.plannedStartTime)!;
  const existingEnd = item.endTime ? clockToMinutes(item.endTime) : null;
  const end =
    existingEnd != null && existingEnd > start
      ? existingEnd
      : start + resolveVisitDurationMinutes(item, classifyVisitScale(item));
  return { start, end };
}

/** A real, structural conflict between two fixed-time items themselves — spec item 7: a legitimate hard failure, never silently resolved by moving either one. */
export interface FixedTimeConflict {
  activityA: string;
  activityB: string;
  startA: string;
  endA: string;
  startB: string;
  travelMinutesRequired: number;
}

/**
 * Detects two fixed-time items on the same day whose own times (plus real
 * travel between them) genuinely cannot both be honored — checked
 * independently of scheduleDayItems's flexible-item placement, since this
 * is a hard failure regardless of what else is on the day.
 */
export function findFixedTimeConflicts(items: AiGeneratedItem[]): FixedTimeConflict[] {
  const fixedSorted = items
    .filter(isFixedAnchor)
    .map((item) => ({ item, ...resolveFixedAnchorTimes(item) }))
    .sort((a, b) => a.start - b.start);

  const conflicts: FixedTimeConflict[] = [];
  for (let index = 1; index < fixedSorted.length; index += 1) {
    const previous = fixedSorted[index - 1];
    const current = fixedSorted[index];
    const travelNeeded = Math.max(current.item.travelMinutes ?? 0, 0);
    if (current.start < previous.end + travelNeeded) {
      conflicts.push({
        activityA: previous.item.name,
        activityB: current.item.name,
        startA: minutesToClock(previous.start),
        endA: minutesToClock(previous.end),
        startB: minutesToClock(current.start),
        travelMinutesRequired: travelNeeded,
      });
    }
  }
  return conflicts;
}

export interface ScheduleResult {
  items: AiGeneratedItem[];
  /** Present only when the leftover window is worth a dedicated block (spec item 26). */
  freeTimeItem: AiGeneratedItem | null;
  /**
   * Flexible items that could not be placed without overlapping a
   * fixed-time anchor (or running past the day's end) — never silently
   * dropped and never allowed to overlap/shift the anchor (spec item 8).
   * The caller decides what to do with these (move elsewhere, replace,
   * or as a last resort drop to alternatives with a visible trace).
   */
  overflowItems: AiGeneratedItem[];
  /** See findFixedTimeConflicts — surfaced here too since scheduleDayItems already walks the fixed anchors. */
  fixedTimeConflicts: FixedTimeConflict[];
}

type ScheduleChunk =
  | { kind: "fixed"; item: AiGeneratedItem; start: number; end: number }
  | { kind: "flex"; items: AiGeneratedItem[] };

/**
 * Walks an already-ordered item list and assigns real, non-overlapping
 * plannedStartTime/endTime. A full_day-scale anchor consumes essentially
 * the rest of the window (spec item 12) — the caller (resequenceDayItems)
 * is responsible for not including a second anchor alongside one, same as
 * it already decides overall item order; this function only turns order
 * into real time.
 *
 * fixedTime items are the one exception to "turns order into time": their
 * own plannedStartTime (and endTime, if already set) is preserved exactly,
 * never recomputed from the cursor — a real, previously-reported bug: this
 * function used to schedule every item purely from a running cursor with
 * no awareness of fixedTime/locked at all, silently moving a 14:30 fixed
 * reservation to whatever slot the cursor happened to reach.
 */
export function scheduleDayItems(orderedItems: AiGeneratedItem[], window: DayTimeWindow, areaLabel: string): ScheduleResult {
  const fixedTimeConflicts = findFixedTimeConflicts(orderedItems);

  // Group into runs of flexible items separated by fixed anchors — a
  // flexible item never gets reassigned to a different position just
  // because of clock time; the caller already decided relative sequencing
  // (anchor, lunch, anchor, dinner, ...). Conflicting fixed anchors (see
  // above) still each keep their own declared time; scheduleDayItems does
  // not attempt to resolve the conflict itself, only reports it.
  const chunks: ScheduleChunk[] = [];
  for (const item of orderedItems) {
    if (isFixedAnchor(item)) {
      const resolved = resolveFixedAnchorTimes(item);
      chunks.push({ kind: "fixed", item, start: resolved.start, end: resolved.end });
      continue;
    }
    const last = chunks[chunks.length - 1];
    if (last && last.kind === "flex") last.items.push(item);
    else chunks.push({ kind: "flex", items: [item] });
  }

  const scheduled: AiGeneratedItem[] = [];
  const overflowItems: AiGeneratedItem[] = [];
  let cursor = window.startMinutes;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];

    if (chunk.kind === "fixed") {
      scheduled.push({ ...chunk.item, plannedStartTime: minutesToClock(chunk.start), endTime: minutesToClock(chunk.end) });
      cursor = Math.max(cursor, chunk.end + bufferMinutesFor(chunk.item, classifyVisitScale(chunk.item)));
      continue;
    }

    // The boundary this flex run must not cross: the next fixed anchor's
    // own start, if any — items are never allowed to overlap it, and the
    // anchor itself is never pushed later to make room.
    let boundary = window.endMinutes;
    for (let lookahead = chunkIndex + 1; lookahead < chunks.length; lookahead += 1) {
      const candidate = chunks[lookahead];
      if (candidate.kind === "fixed") {
        boundary = candidate.start;
        break;
      }
    }

    for (const item of chunk.items) {
      if (item.category === "transportation") {
        const duration = Math.max(item.travelMinutes ?? 15, 5);
        const start = cursor;
        const end = start + duration;
        if (end > boundary) {
          overflowItems.push(item);
          continue;
        }
        scheduled.push({ ...item, plannedStartTime: minutesToClock(start), endTime: minutesToClock(end) });
        cursor = end;
        continue;
      }

      let start = cursor;
      if (item.travelMinutes && item.travelMinutes > 0) start += item.travelMinutes;

      // A "practical" filler (buildFreeTimeItem, the arrival/departure
      // logistics item, ...) gets its own duration set deliberately —
      // exactly enough to fill whatever specific gap it was created for —
      // never a claim about how long a "typical visit" to it should be.
      // Real bug found while adding fixed-time-anchor support: running it
      // through classifyVisitScale like any other item is what let a
      // stale free-time block (inherited from an earlier resequencing
      // pass, often several hours long) get misread as a "full_day"-scale
      // attraction and swallow the rest of the day, overflowing whatever
      // came after it (here, a real dinner stop). Same reasoning as the
      // transportation branch just above — bypass the visit-scale system
      // entirely and trust the item's own number.
      const isFillerItem = item.category === "practical";
      const scale = isFillerItem ? null : classifyVisitScale(item);
      // Round 9.4.4 §Q2 — real entry/queue/security buffer, after travel
      // but before the visit itself starts (never applied to a filler
      // block, which has no "entry" of its own).
      if (!isFillerItem) start += entryBufferMinutesFor(item, scale);
      const remainingWindow = Math.max(boundary - start, 60);
      const resolvedDuration = isFillerItem
        ? Math.max(item.estimatedDurationMinutes ?? 30, 5)
        : resolveVisitDurationMinutes(item, scale!);
      const duration = scale === "full_day" ? Math.min(resolvedDuration, remainingWindow) : resolvedDuration;
      const end = start + duration;

      if (start >= boundary || end > boundary) {
        // Doesn't fit before the next fixed anchor (or the day's end) —
        // never overlap it, never pretend it fits (spec item 8).
        overflowItems.push(item);
        continue;
      }

      scheduled.push({ ...item, plannedStartTime: minutesToClock(start), endTime: minutesToClock(end) });
      // Round 9.15.2 §L/§M — a full pacing buffer here would push past the
      // upcoming fixed anchor's own start (or the day's end); the OPTIONAL
      // pacing portion compresses to make room, the MANDATORY operational
      // portion never does (bufferMinutesFor's own compressForFixedEvent
      // flag, never touching travel time, which is added separately at the
      // top of this same loop body).
      const wouldOverrunBoundary = end + bufferMinutesFor(item, scale) > boundary;
      // Round 9.15.2 §AE — bounded: only the compression case is logged
      // (an ordinary gap that never presses against the boundary is not
      // an "internal scoring attempt" worth a line for every item).
      if (wouldOverrunBoundary) {
        const breakdown = computeExitBufferBreakdown(item, scale);
        logRealPlaceQA("PacingBufferDecision", {
          reason: breakdown.reason,
          pacingMinutes: breakdown.pacingMinutes,
          compressedTo: Math.min(breakdown.pacingMinutes, MIN_COMPRESSED_PACING_MINUTES),
        });
        logRealPlaceQA("OperationalBufferDecision", {
          operationalMinutes: breakdown.operationalMinutes,
          preserved: true,
        });
      }
      cursor = end + bufferMinutesFor(item, scale, wouldOverrunBoundary);
    }
  }

  const leftover = window.endMinutes - cursor;
  const freeTimeItem = leftover >= MIN_FREE_TIME_BLOCK_MINUTES ? buildFreeTimeItem(cursor, window.endMinutes, areaLabel) : null;

  return { items: scheduled, freeTimeItem, overflowItems, fixedTimeConflicts };
}
