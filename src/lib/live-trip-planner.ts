import { isIntercityTransferDay } from "@/lib/server/itinerary-generation-constraints";
import { optimizeDayItemOrder, type DayOptimizeMode, type TripItineraryDay, type TripItineraryItem } from "@/lib/trip-workspace";

// Duplicated from country-itinerary-generation.ts's isExplicitlyClosed
// rather than imported — that file pulls in the GoogleGenAI SDK and other
// server-only generation machinery, which must not end up in the client
// bundle that renders the Today screen.
const EXPLICITLY_CLOSED_SIGNALS = [
  "סגור לצמיתות",
  "סגור באופן זמני",
  "אינו פעיל יותר",
  "permanently closed",
  "temporarily closed",
  "no longer open",
  "closed down",
  "out of business",
];

export function isExplicitlyClosedText(openingHours: string): boolean {
  const text = openingHours.trim().toLowerCase();
  if (!text || text === "לא זמין") return false;
  return EXPLICITLY_CLOSED_SIGNALS.some((signal) => text.includes(signal));
}

/** Parses a "HH:mm" (or "H:mm") string to minutes since midnight, or null if unparseable. */
export function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function formatMinutesToTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Best-effort "HH:mm-HH:mm" opening-hours range parse. Free-text opening
 * hours (Overpass/Gemini) are too unreliable for a general schedule parser
 * (see country-itinerary-generation.ts's isExplicitlyClosed comment), but
 * the common single-range format is worth parsing when present since it
 * directly answers the spec's own delay-impact example ("Observatory
 * closes at 17:00 — risk").
 */
export function parseOpeningHoursRange(openingHours: string): { openMinutes: number; closeMinutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(openingHours.trim());
  if (!match) return null;
  const openMinutes = Number(match[1]) * 60 + Number(match[2]);
  const closeMinutes = Number(match[3]) * 60 + Number(match[4]);
  if (!Number.isFinite(openMinutes) || !Number.isFinite(closeMinutes)) return null;
  return { openMinutes, closeMinutes };
}

/** The item's "expected happening time" right now — a live reschedule if one exists, else the original plan. */
export function effectiveStartTime(item: Pick<TripItineraryItem, "plannedStartTime" | "liveScheduledStartTime">): string {
  return item.liveScheduledStartTime || item.plannedStartTime;
}

/**
 * Deterministic buffer tiers (spec §6) — ordinary/reserved/transit/airport,
 * never one identical buffer for everything.
 */
export function computeBufferMinutes(
  item: Pick<TripItineraryItem, "category" | "reservationRequired" | "fixedTime" | "name" | "location">
): number {
  const haystack = `${item.name} ${item.location}`.toLowerCase();
  if (/שדה תעופה|נמל תעופה|airport/.test(haystack)) return 45;
  if (item.category === "transportation" || /רכבת|train|תחנה|station/.test(haystack)) return 22;
  if (item.reservationRequired || item.fixedTime) return 15;
  return 8;
}

export type LeaveByStatus = "on_time" | "leave_now" | "late";

export interface LeaveByResult {
  leaveByTime: string | null;
  status: LeaveByStatus;
  lateByMinutes: number;
  bufferMinutes: number;
}

/** leave-by = planned/scheduled start − travel time − buffer (spec §5). */
export function computeLeaveBy(
  nextItem: Pick<TripItineraryItem, "plannedStartTime" | "liveScheduledStartTime" | "category" | "reservationRequired" | "fixedTime" | "name" | "location">,
  travelMinutes: number,
  nowMinutes: number
): LeaveByResult {
  const bufferMinutes = computeBufferMinutes(nextItem);
  const startMinutes = parseTimeToMinutes(effectiveStartTime(nextItem));
  if (startMinutes == null) {
    return { leaveByTime: null, status: "on_time", lateByMinutes: 0, bufferMinutes };
  }

  const leaveByMinutes = startMinutes - travelMinutes - bufferMinutes;
  const leaveByTime = formatMinutesToTime(leaveByMinutes);
  const lateBy = nowMinutes - leaveByMinutes;

  if (lateBy <= 0) return { leaveByTime, status: "on_time", lateByMinutes: 0, bufferMinutes };
  if (lateBy <= 5) return { leaveByTime, status: "leave_now", lateByMinutes: 0, bufferMinutes };
  return { leaveByTime, status: "late", lateByMinutes: lateBy, bufferMinutes };
}

/**
 * Ignores completed/skipped items and respects any live reschedule already
 * applied (spec §4: don't use planned order alone once actual changes have
 * occurred). Picks the first eligible item whose effective time hasn't
 * fully passed; falls back to the last eligible item (in progress) if every
 * remaining time has passed.
 */
export function computeNextActivity(day: Pick<TripItineraryDay, "items">, nowMinutes: number): TripItineraryItem | null {
  const eligible = day.items.filter((item) => item.name.trim() && !item.completed && !item.skipped);
  if (eligible.length === 0) return null;

  const withTimes = eligible
    .map((item) => ({ item, minutes: parseTimeToMinutes(effectiveStartTime(item)) }))
    .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));

  return (withTimes.find(({ minutes }) => minutes == null || minutes >= nowMinutes) ?? withTimes.at(-1))?.item ?? null;
}

export type DelayEffectStatus = "ok" | "risk" | "conflict";

export interface DelayEffect {
  itemId: string;
  itemName: string;
  status: DelayEffectStatus;
  detail: string;
  newTime: string | null;
}

export interface DelayImpactResult {
  isTransferDay: boolean;
  effects: DelayEffect[];
}

const DAY_END_MINUTES = 23 * 60;

/**
 * Deterministic delay-impact analysis (spec §13) — walks the remaining
 * (not completed/skipped) items after `fromItemId`, checking each against
 * fixed-time/locked status, opening-hours (where parseable), and day-end.
 * Specific per item, never a vague blanket warning.
 */
export function computeDelayImpact(day: TripItineraryDay, delayMinutes: number, fromItemId: string): DelayImpactResult {
  const fromIndex = day.items.findIndex((item) => item.id === fromItemId);
  if (fromIndex === -1) return { isTransferDay: false, effects: [] };

  const effects: DelayEffect[] = [];

  for (let index = fromIndex + 1; index < day.items.length; index += 1) {
    const item = day.items[index];
    if (item.completed || item.skipped) continue;

    const plannedMinutes = parseTimeToMinutes(effectiveStartTime(item));
    if (plannedMinutes == null) continue;
    const newMinutes = plannedMinutes + delayMinutes;
    const newTime = formatMinutesToTime(newMinutes);

    if (item.locked || item.fixedTime) {
      effects.push({
        itemId: item.id,
        itemName: item.name,
        status: "conflict",
        detail: `${item.name} קבוע ב-${item.plannedStartTime} ולא יכול לזוז — יש לבדוק את ההתנגשות ידנית.`,
        newTime: null,
      });
      continue;
    }

    if (isExplicitlyClosedText(item.openingHours)) {
      effects.push({
        itemId: item.id,
        itemName: item.name,
        status: "risk",
        detail: `${item.name} מסומן כסגור — כדאי לבדוק חלופה.`,
        newTime,
      });
      continue;
    }

    const range = parseOpeningHoursRange(item.openingHours);
    if (range) {
      const arrivalOk = newMinutes < range.closeMinutes;
      const durationFitsBeforeClose = newMinutes + (item.estimatedDurationMinutes ?? 0) <= range.closeMinutes;
      if (!arrivalOk) {
        effects.push({
          itemId: item.id,
          itemName: item.name,
          status: "conflict",
          detail: `${item.name} נסגר ב-${item.openingHours.split("-")[1]} — ההגעה ב-${newTime} תהיה אחרי הסגירה.`,
          newTime,
        });
        continue;
      }
      if (!durationFitsBeforeClose) {
        effects.push({
          itemId: item.id,
          itemName: item.name,
          status: "risk",
          detail: `${item.name} נסגר ב-${item.openingHours.split("-")[1]} — יישאר פחות זמן מהמתוכנן.`,
          newTime,
        });
        continue;
      }
    }

    if (newMinutes > DAY_END_MINUTES) {
      effects.push({
        itemId: item.id,
        itemName: item.name,
        status: "risk",
        detail: `${item.name} יעבור ל-${newTime} — מאוחר בלילה.`,
        newTime,
      });
      continue;
    }

    effects.push({
      itemId: item.id,
      itemName: item.name,
      status: "ok",
      detail: `${item.name} עובר ל-${newTime} — תקין.`,
      newTime,
    });
  }

  return { isTransferDay: isIntercityTransferDay(day), effects };
}

/**
 * Sets liveScheduledStartTime for shiftable remaining items (never
 * plannedStartTime — spec §37: planned data must never be destroyed).
 * Locked/fixed-time and already completed/skipped items never move.
 * Optionally reorders the shifted pool afterward via the existing Stage 2
 * optimizeDayItemOrder.
 */
/**
 * The live_replan merge rule (spec §14-15): completed/skipped/locked/
 * fixed-time items are untouchable and always survive exactly as they are;
 * everything the AI regenerated for a name that isn't untouchable is
 * accepted as the new remaining plan, sorted back into time order. Split
 * out as a pure function so both the server merge step and this test suite
 * exercise the exact same logic.
 */
export function mergeLiveReplanResult(
  originalItems: TripItineraryItem[],
  regeneratedItems: TripItineraryItem[],
  assignId: () => string
): { untouchable: TripItineraryItem[]; items: TripItineraryItem[] } {
  const untouchable = originalItems.filter((item) => item.completed || item.skipped || item.locked || item.fixedTime);
  const untouchableNames = new Set(untouchable.map((item) => item.name.trim().toLowerCase()));
  const eligibleRegenerated = regeneratedItems
    .filter((item) => !untouchableNames.has(item.name.trim().toLowerCase()))
    .map((item) => ({ ...item, id: assignId() }));

  const items = [...untouchable, ...eligibleRegenerated].sort((a, b) =>
    (a.plannedStartTime || "99:99").localeCompare(b.plannedStartTime || "99:99")
  );

  return { untouchable, items };
}

/**
 * Thread 1 (locked/fixed-time hard requirement), item 10: "regenerate day"
 * must preserve locked activities and fixed-time activities, generating
 * the rest of the day around them. Before this fix, regenerating a single
 * day (or the whole trip) replaced its items wholesale with whatever the
 * AI returned — the generation prompt asks Gemini to leave locked/
 * fixed-time items alone, but nothing in code actually guaranteed it; a
 * locked or fixed-time activity could simply be dropped if the AI didn't
 * comply. This is the same shape as mergeLiveReplanResult just above
 * (real ids and full state preserved, never trusting prompt compliance
 * alone), generalized to regenerate-day/regenerate-full rather than only
 * the live-replan path.
 *
 * Deliberately does not re-flow times through the AI-generation-side
 * scheduler (that operates on a distinct AiGeneratedItem type and would
 * mint brand-new items with no stable id) — the caller is expected to
 * recompute cost/travel totals (e.g. via recomputeDayEstimates) on the
 * returned item list.
 */
export function mergeProtectedItemsIntoRegeneratedDay(
  originalItems: TripItineraryItem[],
  regeneratedItems: TripItineraryItem[]
): TripItineraryItem[] {
  const protectedItems = originalItems.filter((item) => item.locked || item.fixedTime);
  if (protectedItems.length === 0) return regeneratedItems;

  const protectedIds = new Set(protectedItems.map((item) => item.id));
  // A regenerated item that happens to share a protected item's real
  // clock time is dropped in its favor, rather than left to sit alongside
  // it at (or near) the same moment — the protected item's time always
  // wins (spec: "fixed-time items act as timeline anchors... fill
  // compatible items around them").
  const protectedTimes = new Set(protectedItems.filter((item) => item.fixedTime).map((item) => item.plannedStartTime));
  const survivingRegeneratedItems = regeneratedItems.filter(
    (item) => !protectedIds.has(item.id) && !protectedTimes.has(item.plannedStartTime)
  );

  return [...survivingRegeneratedItems, ...protectedItems].sort((left, right) =>
    left.plannedStartTime.localeCompare(right.plannedStartTime)
  );
}

/**
 * Spec §D4 — a user-selected hotel is a strong constraint, never silently
 * replaced by whatever a regenerated day happens to suggest. A real
 * selection is identified the same way the rest of the accommodation UI
 * already treats it (per-day accommodationLat/Lon set) — no new field.
 * Regenerating a day is still allowed to update everything else about it
 * (activities, notes, cost); only the accommodation fields themselves are
 * carried over untouched.
 */
export function preserveUserSelectedHotel(
  originalDay: Pick<TripItineraryDay, "accommodation" | "accommodationLat" | "accommodationLon" | "accommodationMapLink">,
  regeneratedDay: TripItineraryDay
): TripItineraryDay {
  if (originalDay.accommodationLat == null || originalDay.accommodationLon == null) return regeneratedDay;

  return {
    ...regeneratedDay,
    accommodation: originalDay.accommodation,
    accommodationLat: originalDay.accommodationLat,
    accommodationLon: originalDay.accommodationLon,
    accommodationMapLink: originalDay.accommodationMapLink,
  };
}

export function shiftRemainingDay(
  day: TripItineraryDay,
  delayMinutes: number,
  fromItemId: string,
  reorderMode?: DayOptimizeMode
): TripItineraryDay {
  const fromIndex = day.items.findIndex((item) => item.id === fromItemId);
  if (fromIndex === -1) return day;

  const before = day.items.slice(0, fromIndex + 1);
  const remaining = day.items.slice(fromIndex + 1);

  const shiftedRemaining = remaining.map((item) => {
    if (item.completed || item.skipped || item.locked || item.fixedTime) return item;
    const minutes = parseTimeToMinutes(effectiveStartTime(item));
    if (minutes == null) return item;
    return { ...item, liveScheduledStartTime: formatMinutesToTime(minutes + delayMinutes) };
  });

  // Reordering (if requested) is scoped to the remaining slice only — an
  // already-completed/passed item earlier in the day must never move,
  // even positionally, regardless of optimizeDayItemOrder's own
  // locked/fixedTime-only pinning rules.
  const finalRemaining = reorderMode ? optimizeDayItemOrder(shiftedRemaining, reorderMode) : shiftedRemaining;

  return { ...day, items: [...before, ...finalRemaining] };
}
