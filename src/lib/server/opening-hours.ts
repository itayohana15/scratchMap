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

/**
 * Round 9.13.1 — OSM's open-ended time syntax: a single HH:MM immediately
 * followed by "+" (e.g. "17:30+"), meaning "known not to open before this
 * time; closing time unstated". Deliberately distinct from
 * TIME_RANGE_GLOBAL_PATTERN (which always requires a SECOND HH:MM) so the
 * two never ambiguously overlap on the same clause.
 */
const OPEN_ENDED_TIME_PATTERN = /(\d{1,2}):(\d{2})\s*\+/;

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
  /**
   * Round 9.13.1 — true for an OSM open-ended range ("17:30+": known NOT to
   * open before 17:30, closing time genuinely unstated). `openMinute` is a
   * real, enforced boundary; `closeMinute` here is only a computational
   * placeholder (`openMinute + OPEN_ENDED_PLACEHOLDER_MINUTES`) so this
   * interval still fits the existing bounded-range arithmetic below — it
   * must NEVER be read as a claimed real closing time. Every legality
   * branch that would otherwise reject on a CLOSING boundary checks this
   * flag first and skips that rejection instead of trusting the
   * placeholder number.
   */
  openEnded?: boolean;
}

/**
 * A generous placeholder span for an open-ended interval's internal
 * `closeMinute` — large enough that no real single-visit duration should
 * ever reach it (so the placeholder itself can never masquerade as a
 * closing-time violation), never presented to a caller as a real close
 * time (see `OpeningInterval.openEnded`).
 */
const OPEN_ENDED_PLACEHOLDER_MINUTES = 600;

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

/**
 * Round 9.15.10 §G — Google Places display-hours use a 12-hour clock with an
 * AM/PM suffix ("11:00 AM", "8:00 PM") — the structured parser only ever
 * understood 24-hour "HH:MM". Converted BEFORE the day-spec/time-range
 * regexes run, so every downstream consumer (OSM or Google) sees the same
 * plain "HH:MM" shape and never needs to know which provider it came from
 * (spec §B: normalize at the input boundary, never duplicate legality logic
 * downstream). Matches a bare "." after A/P too ("11:00 A.M.").
 */
const AMPM_TIME_PATTERN = /\b(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\b/g;

function convertAmPmTo24Hour(text: string): string {
  return text.replace(AMPM_TIME_PATTERN, (_match, hourText: string, minuteText: string, meridiemLetter: string) => {
    let hour = Number(hourText);
    if (Number.isNaN(hour)) return _match;
    const isPm = meridiemLetter.toUpperCase() === "P";
    if (hour === 12) hour = isPm ? 12 : 0;
    else if (isPm) hour += 12;
    return `${String(hour).padStart(2, "0")}:${minuteText}`;
  });
}

function normalizeHoursText(raw: string): string {
  return convertAmPmTo24Hour(
    raw
      .replace(/[‐-―−]/g, "-") // hyphen/en/em/figure/minus-sign variants → plain hyphen
      .replace(/[  -   　]/g, " ") // non-breaking / narrow / other Unicode spaces → plain space
      .replace(/׳/g, "'") // Hebrew geresh → apostrophe
      .replace(/’/g, "'")
      .replace(/\bfrom\b/gi, " ")
      .replace(/\bUhr\b/gi, " ")
  )
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

const ENGLISH_DAY_TOKEN_TEST_PATTERN = /\b(su|sun|sunday|mo|mon|monday|tu|tue|tues|tuesday|we|wed|weds|wednesday|th|thu|thur|thurs|thursday|fr|fri|friday|sa|sat|saturday)\b/i;
const HEBREW_LETTER_DAY_TOKEN_TEST_PATTERN = /(?:^|[\s,])([אבגדהוש])\s*'/;

/** Round 9.15.10 §F — does this text contain a recognizable day token at all (English, Hebrew word, or Hebrew geresh-letter)? The comma-disambiguation logic below uses this as its ONE lexical signal — never string-position heuristics. */
function hasDayToken(text: string): boolean {
  if (ENGLISH_DAY_TOKEN_TEST_PATTERN.test(text)) return true;
  if (HEBREW_LETTER_DAY_TOKEN_TEST_PATTERN.test(text)) return true;
  return Object.keys(HEBREW_DAY_WORD_TO_INDEX).some((word) => text.includes(word));
}

function hasTimeSignal(text: string): boolean {
  return new RegExp(TIME_RANGE_GLOBAL_PATTERN.source, "i").test(text) || OPEN_ENDED_TIME_PATTERN.test(text);
}

/**
 * Round 9.15.10 §F — THE comma-disambiguation fix. A comma inside one
 * semicolon-delimited segment can mean three different things, and this is
 * the one lexical rule (never a string-position/index heuristic) that tells
 * them apart:
 *
 *  1. A DAY LIST — "Mo,We,Fr 09:00-17:00": each of "Mo"/"We" carries a day
 *     token but no time of its own yet, so it's accumulated into the SAME
 *     still-open clause until a segment finally supplies the time range.
 *  2. MULTIPLE INTERVALS for the same days — "Mo-Fr 09:00-12:00,13:00-17:00":
 *     once a clause already has both a day-spec AND a time range (it is
 *     "closed"/complete), a further segment with NO day token of its own is
 *     an additional interval for the SAME days, not a new clause.
 *  3. GENUINELY SEPARATE DAY-RANGE CLAUSES — "Mo-We 17:00-01:00,Th-Sa
 *     12:00-02:00,Su 12:00-01:00": once a clause is already complete (day +
 *     time), a segment that itself carries a NEW day token starts a
 *     genuinely new clause.
 *
 * A single segment (no comma at all) is returned unchanged — this function
 * is a strict no-op for every already-supported single-clause form.
 */
function splitCommaSeparatedDayClauses(clauseText: string): string[] {
  const segments = clauseText.split(",").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length <= 1) return segments.length === 1 ? segments : [clauseText];

  const groups: string[][] = [];
  let current: string[] | null = null;
  let currentHasTime = false;

  for (const segment of segments) {
    const segmentHasDay = hasDayToken(segment);
    const segmentHasTime = hasTimeSignal(segment);

    if (current == null) {
      current = [segment];
      currentHasTime = segmentHasTime;
      continue;
    }

    if (currentHasTime && segmentHasDay) {
      // The current clause is already complete (day + time) and this
      // segment brings its OWN day token — a genuinely new clause.
      groups.push(current);
      current = [segment];
      currentHasTime = segmentHasTime;
    } else {
      // Either still building a day list (current has no time yet) or this
      // is a bare additional time interval for the current clause's days.
      current.push(segment);
      currentHasTime = currentHasTime || segmentHasTime;
    }
  }
  if (current) groups.push(current);

  return groups.map((group) => group.join(","));
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

/** Round 9.13.1 — the open-ended-syntax analogue of intervalsFromRanges: one interval per applicable day, `openEnded: true`, closeMinute a placeholder only. */
function intervalsFromOpenEnded(text: string, days: number[] | null): OpeningInterval[] {
  const intervals: OpeningInterval[] = [];
  const pattern = new RegExp(OPEN_ENDED_TIME_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) != null) {
    const open = toMinutes(match[1], match[2]);
    if (open == null) continue;
    const dayList = days ?? [null];
    for (const d of dayList) {
      intervals.push({ dayOfWeek: d as number | null, openMinute: open, closeMinute: open + OPEN_ENDED_PLACEHOLDER_MINUTES, crossesMidnight: false, openEnded: true });
    }
  }
  return intervals;
}

/**
 * Round 9.15.10 §G — a PER-CLAUSE "open 24 hours" marker (Google Places'
 * per-day display shape, e.g. "Monday: Open 24 hours" mixed among other
 * explicitly-timed weekdays). Deliberately separate from the top-level
 * ALWAYS_OPEN_PATTERNS shortcut in parseOpeningHours (which answers "is the
 * WHOLE string always-open" and must stay a whole-string decision — a
 * mid-string clause-level match here must never upgrade the entire parse to
 * `{kind:"always"}` when other clauses carry real, different hours).
 */
function intervalsFromAlwaysOpenClause(days: number[] | null): OpeningInterval[] {
  const dayList = days ?? [null];
  return dayList.map((d) => ({ dayOfWeek: d as number | null, openMinute: 0, closeMinute: 24 * 60, crossesMidnight: false }));
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
  // Round 9.15.10 §G — this WHOLE-STRING shortcut must only fire when the
  // string genuinely describes the whole week uniformly (a bare "24/7", or
  // a bare "Open 24 hours" with no other clause). Once a real per-day
  // breakdown exists (semicolon-separated clauses), "24 hours" appearing in
  // ONE of those clauses (Google's per-day "Monday: Open 24 hours" shape)
  // must never upgrade every OTHER day's own, different hours to "always
  // open" — that per-clause case is handled below instead, scoped to just
  // its own day(s).
  const topLevelClauseCount = text.split(/[;\n]+/).filter((segment) => segment.trim().length > 0).length;
  if (topLevelClauseCount <= 1) {
    for (const pattern of ALWAYS_OPEN_PATTERNS) {
      if (pattern.test(text)) return { kind: "always" };
    }
  }

  // Round 9.15.10 §F — semicolons are always an unambiguous top-level
  // separator; commas are not (a day list, multiple intervals for the same
  // days, and genuinely separate day-range clauses all use commas
  // differently) — splitCommaSeparatedDayClauses resolves that ambiguity
  // per semicolon-segment via the one lexical day-token signal, never a
  // naive global comma split.
  const clauses = text
    .split(/[;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap((clause) => splitCommaSeparatedDayClauses(clause));
  const intervals: OpeningInterval[] = [];
  let sawClosedClause = false;

  for (const clause of clauses) {
    const hasTimeRange = new RegExp(TIME_RANGE_GLOBAL_PATTERN.source, "i").test(clause);
    // Round 9.13.1 — only checked when there's no bounded range, so a
    // clause like "17:30-18:00" (which itself contains a bare "18:00"
    // that could otherwise coincidentally precede a stray "+") is never
    // double-parsed.
    const hasOpenEndedTime = !hasTimeRange && OPEN_ENDED_TIME_PATTERN.test(clause);
    // The day-spec is whatever precedes the first time range (or the whole
    // clause when it has no time range at all, e.g. "Su off").
    const firstTime = /\d{1,2}:\d{2}/.exec(clause);
    const daySpecText = firstTime ? clause.slice(0, firstTime.index) : clause;
    const days = parseDaySpec(daySpecText);

    if (!hasTimeRange && !hasOpenEndedTime) {
      // Round 9.15.10 §G — a PER-CLAUSE always-open marker ("Monday: Open
      // 24 hours") mixed among other explicitly-timed weekdays. Checked
      // only here (never upgrades the whole-string result — see
      // intervalsFromAlwaysOpenClause's own docstring).
      if (days != null && ALWAYS_OPEN_PATTERNS.some((pattern) => pattern.test(clause))) {
        intervals.push(...intervalsFromAlwaysOpenClause(days));
        continue;
      }
      if (/\b(off|closed|סגור)\b/i.test(clause)) sawClosedClause = true;
      continue;
    }
    intervals.push(...(hasTimeRange ? intervalsFromRanges(clause, days) : intervalsFromOpenEnded(clause, days)));
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

  // 1) Fully-contained? An open-ended interval (Round 9.13.1) has no real
  // closing bound to check against — its own known OPENING boundary is
  // still fully enforced (`startMinutes >= openOnDay`), but a start at or
  // after that boundary is never rejected merely for running past the
  // internal closeMinute placeholder.
  for (const { interval, openOnDay, closeOnDay } of applicable) {
    const entryOk = lastEntry == null || startMinutes <= lastEntry;
    if (startMinutes >= openOnDay && (interval.openEnded || activityEnd <= closeOnDay) && entryOk) {
      return { status: "LEGAL", intervalUsed: interval };
    }
  }

  // 2) Classify the closest failure.
  const sorted = [...applicable].sort((a, b) => a.openOnDay - b.openOnDay);

  // Starts inside an interval but ends after it → duration overruns closing.
  // Never applies to an open-ended interval (closeOnDay is a placeholder,
  // not a real closing time — see OpeningInterval.openEnded).
  for (const { interval, openOnDay, closeOnDay } of sorted) {
    if (!interval.openEnded && startMinutes >= openOnDay && startMinutes < closeOnDay && activityEnd > closeOnDay) {
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
  for (const { interval, openOnDay, closeOnDay } of applicable) {
    let candidate = Math.max(openOnDay, notBefore);
    if (lastEntryMinutes != null) candidate = Math.min(candidate, lastEntryMinutes);
    // Round 9.13.1 — an open-ended interval's closeOnDay is a placeholder,
    // never a real closing bound to fit the candidate's duration under.
    const fitsClose = interval.openEnded || candidate + duration <= closeOnDay;
    if (candidate >= openOnDay && fitsClose && (lastEntryMinutes == null || candidate <= lastEntryMinutes)) {
      best = best == null ? candidate : Math.min(best, candidate);
    }
  }
  return best;
}

/**
 * Round 9.15.10 §H — the real Round 9.15.9 forensic finding this closes: an
 * unparseable-but-non-empty `openingHours` string was indistinguishable
 * from a genuinely missing one — both collapsed into the same silent
 * `{kind:"unknown"}`, so the final firewall had no way to even SEE that a
 * real venue's real hours were being ignored. This is deliberately a
 * SEPARATE, additive function rather than a change to `ParsedOpeningHours`
 * itself — `parseOpeningHours`'s existing 4-way kind and every one of its
 * current callers are untouched; this exists purely for observability.
 *
 *  - PARSED               — produced known/always/closed (a real verdict).
 *  - UNKNOWN_OR_MISSING    — no real data was ever supplied (null/empty, or
 *                            this codebase's own "לא זמין" placeholder —
 *                            the exact same equivalence country-itinerary-
 *                            generation.ts already treats as "no hours").
 *                            This is normal, expected, NOT a parser gap.
 *  - MALFORMED             — non-empty, real-looking data (it contains a
 *                            recognizable day token or a HH:MM-shaped time
 *                            token) that still failed to produce any
 *                            interval — a genuine "we tried and it didn't
 *                            cohere" case.
 *  - UNSUPPORTED_FORMAT    — non-empty data with NEITHER signal at all — a
 *                            shape this parser has simply never been taught,
 *                            never a false claim about the underlying data.
 */
export type OpeningHoursParseQuality = "PARSED" | "UNKNOWN_OR_MISSING" | "MALFORMED" | "UNSUPPORTED_FORMAT";

const NOT_AVAILABLE_PLACEHOLDER = "לא זמין";

export function classifyOpeningHoursParseQuality(rawText: string | null | undefined): OpeningHoursParseQuality {
  if (rawText == null) return "UNKNOWN_OR_MISSING";
  const trimmedRaw = rawText.trim();
  if (!trimmedRaw || trimmedRaw === NOT_AVAILABLE_PLACEHOLDER) return "UNKNOWN_OR_MISSING";

  const parsed = parseOpeningHours(rawText);
  if (parsed.kind !== "unknown") return "PARSED";

  const normalized = normalizeHoursText(rawText);
  if (!normalized) return "UNKNOWN_OR_MISSING";
  const looksLikeRealData = hasDayToken(normalized) || /\d{1,2}\s*:\s*\d{2}/.test(normalized);
  return looksLikeRealData ? "MALFORMED" : "UNSUPPORTED_FORMAT";
}
