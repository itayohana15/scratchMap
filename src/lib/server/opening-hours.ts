/**
 * Real time-window parsing for the free-text `openingHours` field (Overpass/
 * Gemini-sourced). `isExplicitlyClosed` in country-itinerary-generation.ts
 * deliberately avoids this — its own comment calls real parsing "too
 * unreliable" — but that's true only for *inferring* a place is open from
 * ambiguous text. This module only ever acts on an UNAMBIGUOUS "HH:MM–HH:MM"
 * range; anything else (24/7, multi-day OSM syntax like "Mo-Su 09:00-18:00",
 * "closed", empty, garbled) returns null and is never treated as a
 * violation — same "never reject what we can't confidently parse" rule as
 * `validateFlightAirportCountries` never rejecting an unrecognized airport.
 */

export interface OpeningHoursWindow {
  opensMinutes: number;
  closesMinutes: number;
}

const TIME_RANGE_PATTERN =
  /(\d{1,2}):(\d{2})\s*(?:-|–|—|עד)\s*(\d{1,2}):(\d{2})/;

function toMinutes(hours: string, minutes: string): number | null {
  const h = Number(hours);
  const m = Number(minutes);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 24 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Extracts the first clear "HH:MM–HH:MM" range from free text. Multi-day
 * OSM strings ("Mo-Su 09:00-18:00") still match — the day-of-week prefix is
 * simply ignored, which is a deliberate simplification (this app has no
 * real per-weekday scheduling anywhere else either) rather than a silent
 * mistake. An overnight range (closes past midnight, e.g. "20:00–02:00")
 * is represented with `closesMinutes` past 1440 so comparisons stay simple.
 */
export function parseOpeningHoursWindow(openingHours: string): OpeningHoursWindow | null {
  const match = TIME_RANGE_PATTERN.exec(openingHours);
  if (!match) return null;

  const opensMinutes = toMinutes(match[1], match[2]);
  const closesRaw = toMinutes(match[3], match[4]);
  if (opensMinutes == null || closesRaw == null) return null;

  const closesMinutes = closesRaw <= opensMinutes ? closesRaw + 24 * 60 : closesRaw;
  return { opensMinutes, closesMinutes };
}

/**
 * The hard bound for "must have started your visit by" — a distinct
 * lastEntryTime when one is actually known (spec item 17), otherwise the
 * window's own closing time. Never fabricated: a missing/unparseable
 * lastEntryTime simply falls back to closesMinutes rather than guessing an
 * earlier cutoff.
 */
export function resolveLastEntryMinutes(
  item: { lastEntryTime: string },
  window: OpeningHoursWindow
): number {
  const trimmed = item.lastEntryTime.trim();
  if (!trimmed) return window.closesMinutes;
  const match = /^(\d{1,2}):(\d{2})/.exec(trimmed);
  if (!match) return window.closesMinutes;
  const lastEntry = toMinutes(match[1], match[2]);
  return lastEntry ?? window.closesMinutes;
}

function parseStartMinutes(plannedStartTime: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(plannedStartTime.trim());
  if (!match) return null;
  return toMinutes(match[1], match[2]);
}

/**
 * True only when the opening hours are confidently parsed AND the item's
 * planned start time is confidently parsed AND that start time falls
 * strictly outside the window (before opening, or at/after the last-entry
 * bound). Any parse failure on either side means "not a violation" — this
 * is a hard validator, so it must never fire on data it doesn't actually
 * understand.
 */
export function violatesOpeningHours(item: {
  openingHours: string;
  lastEntryTime: string;
  plannedStartTime: string;
}): boolean {
  const window = parseOpeningHoursWindow(item.openingHours);
  if (!window) return false;

  const startMinutes = parseStartMinutes(item.plannedStartTime);
  if (startMinutes == null) return false;

  const lastEntryMinutes = resolveLastEntryMinutes(item, window);
  return startMinutes < window.opensMinutes || startMinutes >= lastEntryMinutes;
}
