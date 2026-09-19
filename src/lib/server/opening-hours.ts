/**
 * Real time-window parsing for the free-text `openingHours` field (Overpass/
 * Gemini-sourced).
 *
 * Two layers live here:
 *
 *  1. The legacy `parseOpeningHoursWindow` / `violatesOpeningHours` pair —
 *     a deliberately narrow "first HH:MM–HH:MM range, ignore weekday, check
 *     the START time only" check. Kept for the food-candidate pre-filter
 *     (`src/lib/food.ts`), which has neither a concrete calendar date nor a
 *     resolved activity duration at the point it calls this.
 *
 *  2. Round 7 — a STRUCTURED model (`parseOpeningHours` →
 *     `evaluateOpeningHoursLegality`) that the itinerary generation pipeline
 *     uses. It understands split intervals, per-weekday rules, closed days,
 *     24/7, intervals crossing midnight, and — critically — judges the
 *     whole activity INTERVAL (`start … start + effectiveDuration`) against
 *     a real opening interval, not just the start instant. The formatted
 *     opening-hours string is DISPLAY ONLY; legality is decided on the
 *     structured representation.
 *
 * Shared rule across both layers: never reject what we cannot confidently
 * parse. Unknown hours are neither "closed" nor "legal evidence" — they are
 * surfaced as their own `UNKNOWN` status and counted separately.
 */

export interface OpeningHoursWindow {
  opensMinutes: number;
  closesMinutes: number;
}

const TIME_RANGE_PATTERN =
  /(\d{1,2}):(\d{2})\s*(?:-|–|—|עד)\s*(\d{1,2}):(\d{2})/;

const TIME_RANGE_GLOBAL_PATTERN =
  /(\d{1,2}):(\d{2})\s*(?:-|–|—|~|to|עד)\s*(\d{1,2}):(\d{2})/gi;

function toMinutes(hours: string, minutes: string): number | null {
  const h = Number(hours);
  const m = Number(minutes);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 24 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Extracts the first clear "HH:MM–HH:MM" range from free text. Multi-day
 * OSM strings ("Mo-Su 09:00-18:00") still match — the day-of-week prefix is
 * simply ignored here (the structured layer below does honor weekdays). An
 * overnight range (closes past midnight, e.g. "20:00–02:00") is represented
 * with `closesMinutes` past 1440 so comparisons stay simple.
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
 * Legacy START-only check (see the module header). True only when the hours
 * parse, the planned start parses, and that start is strictly outside the
 * window / past the last-entry bound. Any parse failure ⇒ "not a
 * violation". The itinerary pipeline no longer relies on this for its final
 * gate — it uses `evaluateOpeningHoursLegality` — but `src/lib/food.ts`
 * still uses it as a cheap candidate pre-filter.
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

/* ------------------------------------------------------------------ *
 * Round 7 — structured opening intervals + interval-aware legality    *
 * ------------------------------------------------------------------ */

/**
 * One concrete opening interval for one (or every) weekday.
 * `openMinute` is minutes past local midnight (0–1439). `closeMinute` is
 * also minutes past local midnight but may exceed 1440 when the interval
 * runs past midnight (`crossesMidnight`) — e.g. a bar open "18:00–02:00"
 * has `openMinute = 1080`, `closeMinute = 1560`, `crossesMidnight = true`.
 * `dayOfWeek` is 0=Sunday … 6=Saturday, or `null` meaning "applies every
 * day" (the OSM "Mo-Su" / "24/7" / bare-range case).
 */
export interface OpeningInterval {
  dayOfWeek: number | null;
  openMinute: number;
  closeMinute: number;
  crossesMidnight: boolean;
}

export type ParsedOpeningHours =
  | { kind: "known"; intervals: OpeningInterval[] }
  | { kind: "always" }
  | { kind: "closed" }
  | { kind: "unknown" };

export type OpeningHoursLegalityStatus =
  | "LEGAL"
  | "CLOSED_AT_START"
  | "OPENS_AFTER_START"
  | "CLOSES_BEFORE_END"
  | "CLOSED_ALL_DAY"
  | "UNKNOWN";

export interface OpeningHoursLegalityInput {
  /** The activity's own local calendar date, "yyyy-MM-dd". */
  localDate: string;
  /** Scheduled start, minutes past local midnight. */
  startMinutes: number;
  /** Effective activity duration (from the existing visit-duration model). */
  durationMinutes: number;
  parsed: ParsedOpeningHours;
  /** Optional hard "must have entered by" bound, minutes past local midnight. */
  lastEntryMinutes?: number | null;
}

export interface OpeningHoursLegalityResult {
  status: OpeningHoursLegalityStatus;
  /** The interval the activity was (or came closest to being) judged against. */
  intervalUsed?: OpeningInterval;
}

const DAY_TOKEN_TO_INDEX: Record<string, number> = {
  su: 0, sun: 0, sunday: 0,
  mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, weds: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

// Hebrew weekday letters (Sunday-first): א=0 … ו=5, ש=6 (Shabbat).
const HEBREW_DAY_LETTER_TO_INDEX: Record<string, number> = {
  "א": 0, "ב": 1, "ג": 2, "ד": 3, "ה": 4, "ו": 5, "ש": 6,
};
const HEBREW_DAY_WORD_TO_INDEX: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6,
};

const ALWAYS_OPEN_PATTERNS = [
  /24\s*\/\s*7/,
  /24\s*hours?/i,
  /around the clock/i,
  /פתוח\s*24/,
  /24\s*שעות/,
  /כל\s*היום/,
];

const EXPLICITLY_CLOSED_PATTERNS = [
  /^\s*closed\s*$/i,
  /permanently closed/i,
  /temporarily closed/i,
  /^\s*off\s*$/i,
  /סגור\s*לצמיתות/,
  /סגור\s*זמנית/,
  /^\s*סגור\s*$/,
];

function weekdayForLocalDate(localDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  const ms = Date.UTC(year, month - 1, day);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).getUTCDay();
}

function normalizeHoursText(raw: string): string {
  return raw
    .replace(/[–—]/g, "-")
    .replace(/׳/g, "'") // Hebrew geresh → apostrophe
    .replace(/’/g, "'")
    .replace(/\bfrom\b/gi, " ")
    .replace(/\bUhr\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Expands one day-spec token run ("mo-fr", "mo,we,fr", "ג'-ש'", "daily") to weekday indices, or null for "every day". */
function parseDaySpec(rawSpec: string): number[] | null {
  const spec = rawSpec.toLowerCase().trim();
  if (!spec) return null;
  if (/\b(daily|everyday|every day|all days|mo-su|su-sa|כל יום|כל הימים)\b/.test(spec)) return null;
  if (spec === "mo-su" || spec === "su-sa") return null;

  const indices = new Set<number>();

  // English ranges / lists: "mo-fr", "mon-fri", "mo,we,fr"
  const englishRange = /\b(su|sun|sunday|mo|mon|monday|tu|tue|tues|tuesday|we|wed|weds|wednesday|th|thu|thur|thurs|thursday|fr|fri|friday|sa|sat|saturday)\s*-\s*(su|sun|sunday|mo|mon|monday|tu|tue|tues|tuesday|we|wed|weds|wednesday|th|thu|thur|thurs|thursday|fr|fri|friday|sa|sat|saturday)\b/g;
  let rangeMatch: RegExpExecArray | null;
  let sawEnglish = false;
  while ((rangeMatch = englishRange.exec(spec)) != null) {
    const start = DAY_TOKEN_TO_INDEX[rangeMatch[1]];
    const end = DAY_TOKEN_TO_INDEX[rangeMatch[2]];
    if (start == null || end == null) continue;
    sawEnglish = true;
    for (let i = 0; i < 7; i += 1) {
      const d = (start + i) % 7;
      indices.add(d);
      if (d === end) break;
    }
  }
  const singleEnglish = /\b(su|sun|sunday|mo|mon|monday|tu|tue|tues|tuesday|we|wed|weds|wednesday|th|thu|thur|thurs|thursday|fr|fri|friday|sa|sat|saturday)\b/g;
  let singleMatch: RegExpExecArray | null;
  while ((singleMatch = singleEnglish.exec(spec)) != null) {
    const d = DAY_TOKEN_TO_INDEX[singleMatch[1]];
    if (d != null) {
      indices.add(d);
      sawEnglish = true;
    }
  }
  if (sawEnglish) return indices.size > 0 ? [...indices].sort((a, b) => a - b) : null;

  // Hebrew words: "ראשון-חמישי", "שישי"
  for (const [word, idx] of Object.entries(HEBREW_DAY_WORD_TO_INDEX)) {
    if (spec.includes(word)) indices.add(idx);
  }
  const hebrewWordRange = /(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\s*-\s*(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/.exec(rawSpec);
  if (hebrewWordRange) {
    const start = HEBREW_DAY_WORD_TO_INDEX[hebrewWordRange[1]];
    const end = HEBREW_DAY_WORD_TO_INDEX[hebrewWordRange[2]];
    if (start != null && end != null) {
      for (let i = 0; i < 7; i += 1) {
        const d = (start + i) % 7;
        indices.add(d);
        if (d === end) break;
      }
    }
  }
  if (indices.size > 0) return [...indices].sort((a, b) => a - b);

  // Hebrew single letters with a geresh or range: "א'-ה'", "ג'", "יום ב'"
  const hebrewLetterRange = /([אבגדהוש])\s*'?\s*-\s*([אבגדהוש])\s*'?/.exec(rawSpec);
  if (hebrewLetterRange) {
    const start = HEBREW_DAY_LETTER_TO_INDEX[hebrewLetterRange[1]];
    const end = HEBREW_DAY_LETTER_TO_INDEX[hebrewLetterRange[2]];
    if (start != null && end != null) {
      for (let i = 0; i < 7; i += 1) {
        const d = (start + i) % 7;
        indices.add(d);
        if (d === end) break;
      }
      return [...indices].sort((a, b) => a - b);
    }
  }
  const hebrewLetter = /(?:^|[\s,])([אבגדהוש])\s*'/g;
  let letterMatch: RegExpExecArray | null;
  while ((letterMatch = hebrewLetter.exec(rawSpec)) != null) {
    const d = HEBREW_DAY_LETTER_TO_INDEX[letterMatch[1]];
    if (d != null) indices.add(d);
  }
  if (indices.size > 0) return [...indices].sort((a, b) => a - b);

  return null;
}

function intervalsFromRanges(text: string, days: number[] | null): OpeningInterval[] {
  const intervals: OpeningInterval[] = [];
  const pattern = new RegExp(TIME_RANGE_GLOBAL_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    const open = toMinutes(match[1], match[2]);
    const closeRaw = toMinutes(match[3], match[4]);
    if (open == null || closeRaw == null) continue;
    const crossesMidnight = closeRaw <= open;
    const close = crossesMidnight ? closeRaw + 24 * 60 : closeRaw;
    const dayList = days ?? [null];
    for (const d of dayList) {
      intervals.push({ dayOfWeek: d as number | null, openMinute: open, closeMinute: close, crossesMidnight });
    }
  }
  return intervals;
}

/**
 * Structured parse of a free-text opening-hours string. Handles a single
 * interval, split intervals ("09:00-13:00, 15:00-19:00"), per-weekday
 * clauses ("Mo-Fr 09:00-17:00; Sa 10:00-14:00"), closed markers, 24/7,
 * intervals crossing midnight, and Hebrew day/geresh notation. Anything it
 * cannot confidently turn into at least one interval (and is not an
 * explicit closed / 24-7 marker) is `{ kind: "unknown" }` — never guessed
 * open, never guessed closed.
 */
export function parseOpeningHours(rawText: string | null | undefined): ParsedOpeningHours {
  if (rawText == null) return { kind: "unknown" };
  const text = normalizeHoursText(rawText);
  if (!text) return { kind: "unknown" };

  for (const pattern of EXPLICITLY_CLOSED_PATTERNS) {
    if (pattern.test(text)) return { kind: "closed" };
  }
  for (const pattern of ALWAYS_OPEN_PATTERNS) {
    if (pattern.test(text)) return { kind: "always" };
  }

  const clauses = text.split(/[;\n]+/).map((clause) => clause.trim()).filter(Boolean);
  const intervals: OpeningInterval[] = [];
  let sawClosedClause = false;

  for (const clause of clauses) {
    const hasTimeRange = new RegExp(TIME_RANGE_GLOBAL_PATTERN.source, "i").test(clause);
    // The day-spec is whatever precedes the first time range (or the whole
    // clause when it has no time range at all, e.g. "Su off").
    const firstTime = /\d{1,2}:\d{2}/.exec(clause);
    const daySpecText = firstTime ? clause.slice(0, firstTime.index) : clause;
    const days = parseDaySpec(daySpecText);

    if (!hasTimeRange) {
      if (/\b(off|closed|סגור)\b/i.test(clause)) sawClosedClause = true;
      continue;
    }
    intervals.push(...intervalsFromRanges(clause, days));
  }

  if (intervals.length > 0) return { kind: "known", intervals };
  if (sawClosedClause) return { kind: "closed" };
  return { kind: "unknown" };
}

/** All intervals that could cover an activity on `weekday` — including the previous day's cross-midnight tail. */
function applicableIntervals(intervals: OpeningInterval[], weekday: number): Array<{ interval: OpeningInterval; openOnDay: number; closeOnDay: number }> {
  const out: Array<{ interval: OpeningInterval; openOnDay: number; closeOnDay: number }> = [];
  for (const interval of intervals) {
    // Same-day (or every-day) interval.
    if (interval.dayOfWeek == null || interval.dayOfWeek === weekday) {
      out.push({ interval, openOnDay: interval.openMinute, closeOnDay: interval.closeMinute });
    }
    // Previous day's cross-midnight interval spilling into the small hours of `weekday`.
    if (interval.crossesMidnight) {
      const prev = (weekday + 6) % 7;
      if (interval.dayOfWeek == null || interval.dayOfWeek === prev) {
        out.push({ interval, openOnDay: 0, closeOnDay: interval.closeMinute - 24 * 60 });
      }
    }
  }
  return out;
}

/**
 * THE authoritative opening-hours legality check for a scheduled real venue
 * (Round 7). Judges the whole activity interval
 * `[startMinutes, startMinutes + durationMinutes]` against the structured
 * opening intervals for the activity's own local weekday.
 *
 *  - LEGAL              — the activity fits entirely inside an open interval
 *                         (and starts at/after opening, ends at/before close),
 *                         and is not past a known lastEntry bound.
 *  - OPENS_AFTER_START  — the venue's first opening that day is later than
 *                         the scheduled start.
 *  - CLOSES_BEFORE_END  — starts inside an interval but the activity's END
 *                         runs past that interval's close (the Statue-of-
 *                         Liberty case).
 *  - CLOSED_AT_START    — the start lands in a gap between intervals, or past
 *                         a lastEntry bound / an interval's close.
 *  - CLOSED_ALL_DAY     — no interval applies to this weekday at all, or the
 *                         venue is explicitly closed.
 *  - UNKNOWN            — hours could not be parsed / no local date. Never a
 *                         violation, never counted as "legal".
 */
export function evaluateOpeningHoursLegality(input: OpeningHoursLegalityInput): OpeningHoursLegalityResult {
  const { parsed, startMinutes, durationMinutes, localDate } = input;

  if (parsed.kind === "unknown") return { status: "UNKNOWN" };
  if (parsed.kind === "always") return { status: "LEGAL" };
  if (parsed.kind === "closed") return { status: "CLOSED_ALL_DAY" };

  const weekday = weekdayForLocalDate(localDate);
  if (weekday == null) return { status: "UNKNOWN" };

  const activityEnd = startMinutes + Math.max(durationMinutes, 0);
  const lastEntry = input.lastEntryMinutes ?? null;

  const applicable = applicableIntervals(parsed.intervals, weekday);
  if (applicable.length === 0) return { status: "CLOSED_ALL_DAY" };

  // 1) Fully-contained?
  for (const { interval, openOnDay, closeOnDay } of applicable) {
    const entryOk = lastEntry == null || startMinutes <= lastEntry;
    if (startMinutes >= openOnDay && activityEnd <= closeOnDay && entryOk) {
      return { status: "LEGAL", intervalUsed: interval };
    }
  }

  // 2) Classify the closest failure.
  const sorted = [...applicable].sort((a, b) => a.openOnDay - b.openOnDay);

  // Starts inside an interval but ends after it → duration overruns closing.
  for (const { interval, openOnDay, closeOnDay } of sorted) {
    if (startMinutes >= openOnDay && startMinutes < closeOnDay && activityEnd > closeOnDay) {
      return { status: "CLOSES_BEFORE_END", intervalUsed: interval };
    }
  }
  // Starts inside an interval but is past its last-entry bound.
  for (const { interval, openOnDay, closeOnDay } of sorted) {
    if (lastEntry != null && startMinutes > lastEntry && startMinutes >= openOnDay && startMinutes < closeOnDay) {
      return { status: "CLOSED_AT_START", intervalUsed: interval };
    }
  }
  // Everything opens later than the scheduled start.
  if (sorted.every(({ openOnDay }) => startMinutes < openOnDay)) {
    return { status: "OPENS_AFTER_START", intervalUsed: sorted[0].interval };
  }
  // Start is after the last interval's close, or in a gap between intervals.
  return { status: "CLOSED_AT_START", intervalUsed: sorted[sorted.length - 1].interval };
}

/** Convenience: the statuses that mean "a known-hours venue genuinely cannot legally contain its scheduled activity". */
export function isKnownHoursViolation(status: OpeningHoursLegalityStatus): boolean {
  return (
    status === "CLOSED_AT_START" ||
    status === "OPENS_AFTER_START" ||
    status === "CLOSES_BEFORE_END" ||
    status === "CLOSED_ALL_DAY"
  );
}

/**
 * The earliest start minute (on `weekday`) at which an activity of
 * `durationMinutes` fits entirely inside some applicable interval, at or
 * after `notBefore`. Used by the repair pass to try to keep the SAME venue
 * by moving it to a legal slot on the same day. Returns null when no
 * interval can contain the activity that day.
 */
export function earliestLegalStartMinute(
  parsed: ParsedOpeningHours,
  localDate: string,
  durationMinutes: number,
  notBefore: number,
  lastEntryMinutes?: number | null
): number | null {
  if (parsed.kind === "always") return Math.max(notBefore, 0);
  if (parsed.kind !== "known") return null;
  const weekday = weekdayForLocalDate(localDate);
  if (weekday == null) return null;
  const applicable = applicableIntervals(parsed.intervals, weekday);
  const duration = Math.max(durationMinutes, 0);
  let best: number | null = null;
  for (const { openOnDay, closeOnDay } of applicable) {
    let candidate = Math.max(openOnDay, notBefore);
    if (lastEntryMinutes != null) candidate = Math.min(candidate, lastEntryMinutes);
    if (candidate >= openOnDay && candidate + duration <= closeOnDay && (lastEntryMinutes == null || candidate <= lastEntryMinutes)) {
      best = best == null ? candidate : Math.min(best, candidate);
    }
  }
  return best;
}
