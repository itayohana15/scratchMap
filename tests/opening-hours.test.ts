import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOpeningHoursWindow,
  resolveLastEntryMinutes,
  violatesOpeningHours,
  parseOpeningHours,
  evaluateOpeningHoursLegality,
  isKnownHoursViolation,
  earliestLegalStartMinute,
  classifyOpeningHoursParseQuality,
} from "../src/lib/server/opening-hours";

test("parseOpeningHoursWindow extracts a plain HH:MM-HH:MM range", () => {
  assert.deepEqual(parseOpeningHoursWindow("09:00-16:00"), { opensMinutes: 540, closesMinutes: 960 });
});

test("parseOpeningHoursWindow handles an en dash and Hebrew 'עד'", () => {
  assert.deepEqual(parseOpeningHoursWindow("09:00–16:00"), { opensMinutes: 540, closesMinutes: 960 });
  assert.deepEqual(parseOpeningHoursWindow("09:00 עד 16:00"), { opensMinutes: 540, closesMinutes: 960 });
});

test("parseOpeningHoursWindow ignores a day-of-week prefix (OSM multi-day syntax)", () => {
  assert.deepEqual(parseOpeningHoursWindow("Mo-Su 09:00-18:00"), { opensMinutes: 540, closesMinutes: 1080 });
});

test("parseOpeningHoursWindow represents an overnight range past midnight", () => {
  assert.deepEqual(parseOpeningHoursWindow("20:00-02:00"), { opensMinutes: 1200, closesMinutes: 1560 });
});

test("parseOpeningHoursWindow returns null for anything not a clear time range", () => {
  assert.equal(parseOpeningHoursWindow(""), null);
  assert.equal(parseOpeningHoursWindow("לא זמין"), null);
  assert.equal(parseOpeningHoursWindow("24/7"), null);
  assert.equal(parseOpeningHoursWindow("closed"), null);
  assert.equal(parseOpeningHoursWindow("סגור לצמיתות"), null);
});

test("resolveLastEntryMinutes prefers a distinct lastEntryTime over the closing time", () => {
  const window = { opensMinutes: 540, closesMinutes: 960 };
  assert.equal(resolveLastEntryMinutes({ lastEntryTime: "15:00" }, window), 900);
});

test("resolveLastEntryMinutes falls back to closing time when lastEntryTime is empty or unparseable", () => {
  const window = { opensMinutes: 540, closesMinutes: 960 };
  assert.equal(resolveLastEntryMinutes({ lastEntryTime: "" }, window), 960);
  assert.equal(resolveLastEntryMinutes({ lastEntryTime: "garbled" }, window), 960);
});

// Spec test 84: Timna Park closes at 16:00 — must never be scheduled at 19:52.
test("violatesOpeningHours flags Timna Park scheduled at 19:52 when it closes at 16:00", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "08:00-16:00", lastEntryTime: "", plannedStartTime: "19:52" }),
    true
  );
});

test("violatesOpeningHours does not flag Timna Park scheduled at 10:00", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "08:00-16:00", lastEntryTime: "", plannedStartTime: "10:00" }),
    false
  );
});

// Spec test 85: a venue opening at 20:00 must never be scheduled at 09:00.
test("violatesOpeningHours flags a night venue (opens 20:00) scheduled at 09:00", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "20:00-02:00", lastEntryTime: "", plannedStartTime: "09:00" }),
    true
  );
});

test("violatesOpeningHours does not flag the same night venue scheduled at 21:00", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "20:00-02:00", lastEntryTime: "", plannedStartTime: "21:00" }),
    false
  );
});

test("violatesOpeningHours respects a distinct lastEntryTime as the hard bound, not the closing time", () => {
  // Closes at 18:00 but last entry is 16:30 — 17:00 is inside the closing
  // window but past last entry, so it's still a violation.
  assert.equal(
    violatesOpeningHours({ openingHours: "09:00-18:00", lastEntryTime: "16:30", plannedStartTime: "17:00" }),
    true
  );
  assert.equal(
    violatesOpeningHours({ openingHours: "09:00-18:00", lastEntryTime: "16:30", plannedStartTime: "16:00" }),
    false
  );
});

test("violatesOpeningHours never fires when the opening hours can't be confidently parsed", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "24/7", lastEntryTime: "", plannedStartTime: "03:00" }),
    false
  );
  assert.equal(
    violatesOpeningHours({ openingHours: "", lastEntryTime: "", plannedStartTime: "03:00" }),
    false
  );
});

test("violatesOpeningHours never fires when the item's own start time can't be confidently parsed", () => {
  assert.equal(
    violatesOpeningHours({ openingHours: "08:00-16:00", lastEntryTime: "", plannedStartTime: "" }),
    false
  );
});

/* ---------------- Round 7: structured intervals + interval-aware legality ---------------- */

const THU = "2026-09-10";
const FRI = "2026-09-11";
const SAT = "2026-09-12";
const SUN = "2026-09-13";
const MON = "2026-09-07";

test("parseOpeningHours: a single plain range → one every-day interval", () => {
  const parsed = parseOpeningHours("10:00-17:00");
  assert.equal(parsed.kind, "known");
  assert.deepEqual(parsed.kind === "known" && parsed.intervals, [
    { dayOfWeek: null, openMinute: 600, closeMinute: 1020, crossesMidnight: false },
  ]);
});

test("parseOpeningHours: split intervals in one clause", () => {
  const parsed = parseOpeningHours("09:00-13:00, 15:00-19:00");
  assert.equal(parsed.kind, "known");
  const intervals = parsed.kind === "known" ? parsed.intervals : [];
  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals.map((i) => [i.openMinute, i.closeMinute]), [[540, 780], [900, 1140]]);
});

test("parseOpeningHours: per-weekday clauses (Mo-Fr / Sa) map to the right day indices", () => {
  const parsed = parseOpeningHours("Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off");
  assert.equal(parsed.kind, "known");
  const intervals = parsed.kind === "known" ? parsed.intervals : [];
  // Mo-Fr = 1..5, Sa = 6
  assert.deepEqual(intervals.filter((i) => i.openMinute === 540).map((i) => i.dayOfWeek).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(intervals.filter((i) => i.openMinute === 600).map((i) => i.dayOfWeek), [6]);
});

test("parseOpeningHours: 24/7 → always; explicit closed → closed; garbled → unknown", () => {
  assert.equal(parseOpeningHours("24/7").kind, "always");
  assert.equal(parseOpeningHours("פתוח 24 שעות").kind, "always");
  assert.equal(parseOpeningHours("permanently closed").kind, "closed");
  assert.equal(parseOpeningHours("סגור לצמיתות").kind, "closed");
  assert.equal(parseOpeningHours("").kind, "unknown");
  assert.equal(parseOpeningHours("לא זמין").kind, "unknown");
  assert.equal(parseOpeningHours("call ahead").kind, "unknown");
});

test("parseOpeningHours: an overnight range is flagged crossesMidnight with closeMinute past 1440", () => {
  const parsed = parseOpeningHours("18:00-02:00");
  const interval = parsed.kind === "known" ? parsed.intervals[0] : null;
  assert.ok(interval);
  assert.equal(interval!.crossesMidnight, true);
  assert.equal(interval!.openMinute, 1080);
  assert.equal(interval!.closeMinute, 1560);
});

test("parseOpeningHours: Hebrew day letters with geresh (ג'-ש')", () => {
  const parsed = parseOpeningHours("ג'-ש' 17:30-22:00");
  const intervals = parsed.kind === "known" ? parsed.intervals : [];
  // ג=2 (Tue) .. ש=6 (Sat)
  assert.deepEqual(intervals.map((i) => i.dayOfWeek).sort((a, b) => (a ?? 0) - (b ?? 0)), [2, 3, 4, 5, 6]);
  assert.deepEqual([intervals[0].openMinute, intervals[0].closeMinute], [1050, 1320]);
});

// A. venue 10:00–17:00, activity 18:56 → OPENS/closed after start (start past close ⇒ CLOSED_AT_START)
test("evaluateOpeningHoursLegality: 10:00-17:00 venue scheduled 18:56 is illegal", () => {
  const parsed = parseOpeningHours("10:00-17:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 18 * 60 + 56, durationMinutes: 90, parsed });
  assert.equal(res.status, "CLOSED_AT_START");
  assert.ok(isKnownHoursViolation(res.status));
});

// B. cafe 07:00–17:00, activity 17:59 → CLOSED_AT_START
test("evaluateOpeningHoursLegality: 07:00-17:00 cafe scheduled 17:59 is illegal", () => {
  const parsed = parseOpeningHours("07:00-17:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 17 * 60 + 59, durationMinutes: 45, parsed });
  assert.equal(res.status, "CLOSED_AT_START");
});

// C. restaurant 17:30–22:00, activity 11:27 → OPENS_AFTER_START
test("evaluateOpeningHoursLegality: 17:30-22:00 restaurant scheduled 11:27 is illegal (opens later)", () => {
  const parsed = parseOpeningHours("17:30-22:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 11 * 60 + 27, durationMinutes: 90, parsed });
  assert.equal(res.status, "OPENS_AFTER_START");
});

// D. venue 08:30–16:00, activity 15:34 with duration extending past 16:00 → CLOSES_BEFORE_END
test("evaluateOpeningHoursLegality: starts before closing but the activity END overruns → CLOSES_BEFORE_END", () => {
  const parsed = parseOpeningHours("08:30-16:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 15 * 60 + 34, durationMinutes: 90, parsed });
  assert.equal(res.status, "CLOSES_BEFORE_END");
  assert.ok(isKnownHoursViolation(res.status));
});

// E. fully inside the interval → LEGAL
test("evaluateOpeningHoursLegality: an activity entirely inside the interval is LEGAL", () => {
  const parsed = parseOpeningHours("09:00-18:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 10 * 60, durationMinutes: 120, parsed });
  assert.equal(res.status, "LEGAL");
});

// F. ends exactly at closing → legal
test("evaluateOpeningHoursLegality: an activity ending exactly at closing time is LEGAL", () => {
  const parsed = parseOpeningHours("09:00-17:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 15 * 60, durationMinutes: 120, parsed });
  assert.equal(res.status, "LEGAL");
});

// G. starts exactly at opening → legal
test("evaluateOpeningHoursLegality: an activity starting exactly at opening time is LEGAL", () => {
  const parsed = parseOpeningHours("09:00-17:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 9 * 60, durationMinutes: 60, parsed });
  assert.equal(res.status, "LEGAL");
});

// H. split intervals — the midday gap is illegal, either side is legal
test("evaluateOpeningHoursLegality: split intervals — legal in each half, illegal in the midday gap", () => {
  const parsed = parseOpeningHours("09:00-13:00, 15:00-19:00");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 10 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 16 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 14 * 60, durationMinutes: 30, parsed }).status, "CLOSED_AT_START");
});

// I. closed weekday
test("evaluateOpeningHoursLegality: a venue closed on the scheduled weekday → CLOSED_ALL_DAY", () => {
  const parsed = parseOpeningHours("Mo-Fr 09:00-17:00");
  // SAT is 2026-09-12
  assert.equal(evaluateOpeningHoursLegality({ localDate: SAT, startMinutes: 10 * 60, durationMinutes: 60, parsed }).status, "CLOSED_ALL_DAY");
  // FRI is inside Mo-Fr
  assert.equal(evaluateOpeningHoursLegality({ localDate: FRI, startMinutes: 10 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
});

// J. 24/7
test("evaluateOpeningHoursLegality: 24/7 is always LEGAL, even at 03:00", () => {
  const parsed = parseOpeningHours("24/7");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 3 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
});

// K. unknown hours
test("evaluateOpeningHoursLegality: unknown hours → UNKNOWN (never a violation, never 'legal evidence')", () => {
  const parsed = parseOpeningHours("hours vary");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 3 * 60, durationMinutes: 60, parsed });
  assert.equal(res.status, "UNKNOWN");
  assert.equal(isKnownHoursViolation(res.status), false);
});

// L. cross-midnight — a legal late-night activity
test("evaluateOpeningHoursLegality: 18:00-02:00 bar, activity at 23:30 is LEGAL", () => {
  const parsed = parseOpeningHours("18:00-02:00");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 23 * 60 + 30, durationMinutes: 90, parsed }).status, "LEGAL");
});

test("evaluateOpeningHoursLegality: 18:00-02:00 bar, activity at 01:00 belongs to the previous evening's interval → LEGAL", () => {
  const parsed = parseOpeningHours("18:00-02:00");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 60, durationMinutes: 45, parsed }).status, "LEGAL");
});

// M. cross-midnight — an illegal daytime activity
test("evaluateOpeningHoursLegality: 18:00-02:00 bar, activity at 13:00 is illegal", () => {
  const parsed = parseOpeningHours("18:00-02:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 13 * 60, durationMinutes: 60, parsed });
  assert.ok(isKnownHoursViolation(res.status));
});

test("earliestLegalStartMinute: returns the first slot that fits the whole activity", () => {
  const parsed = parseOpeningHours("10:00-17:00");
  assert.equal(earliestLegalStartMinute(parsed, THU, 90, 9 * 60), 600);
  // duration would overrun 17:00 unless started by 15:30
  assert.equal(earliestLegalStartMinute(parsed, THU, 90, 16 * 60), null);
  assert.equal(earliestLegalStartMinute(parsed, THU, 90, 8 * 60), 600);
});

test("earliestLegalStartMinute: split intervals — jumps the midday gap", () => {
  const parsed = parseOpeningHours("09:00-13:00, 15:00-19:00");
  assert.equal(earliestLegalStartMinute(parsed, THU, 120, 12 * 60 + 30), 15 * 60);
});

test("evaluateOpeningHoursLegality: a distinct lastEntry bound makes a late-but-open start illegal", () => {
  const parsed = parseOpeningHours("09:00-18:00");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 17 * 60, durationMinutes: 30, parsed, lastEntryMinutes: 16 * 60 + 30 });
  assert.equal(res.status, "CLOSED_AT_START");
});

test("parseOpeningHours: Hebrew word ranges (ראשון-חמישי)", () => {
  const parsed = parseOpeningHours("ראשון-חמישי 08:00-16:00");
  const intervals = parsed.kind === "known" ? parsed.intervals : [];
  assert.deepEqual(intervals.map((i) => i.dayOfWeek).sort((a, b) => (a ?? 0) - (b ?? 0)), [0, 1, 2, 3, 4]);
});

test("evaluateOpeningHoursLegality: SUN/MON sanity against a Su-only rule", () => {
  const parsed = parseOpeningHours("Su 12:00-16:00");
  assert.equal(evaluateOpeningHoursLegality({ localDate: SUN, startMinutes: 13 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: MON, startMinutes: 13 * 60, durationMinutes: 60, parsed }).status, "CLOSED_ALL_DAY");
});

/* ==================================================================== *
 * ROUND 9.13.1 — OSM open-ended opening hours ("17:30+")                *
 * Real Round 9.12 evidence: Coda (openingHours "Mo-Sa 17:30+") was       *
 * scheduled at 12:40 because the parser silently dropped the whole      *
 * clause to `unknown` (no second HH:MM token to match). THU/FRI/SAT/SUN *
 * dates above are used as the applicable/non-applicable weekdays.       *
 * ==================================================================== */

// A/B/C/D — a bare "17:30+" (no day prefix -> applies every day).
test("Round 9.13.1 test A: 17:30+ rejects a 12:40 start as pre-opening", () => {
  const parsed = parseOpeningHours("17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 12 * 60 + 40, durationMinutes: 60, parsed });
  assert.equal(res.status, "OPENS_AFTER_START");
  assert.ok(isKnownHoursViolation(res.status));
});

test("Round 9.13.1 test B: 17:30+ rejects 17:29 as pre-opening (one minute early still illegal)", () => {
  const parsed = parseOpeningHours("17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 17 * 60 + 29, durationMinutes: 60, parsed });
  assert.equal(res.status, "OPENS_AFTER_START");
  assert.ok(isKnownHoursViolation(res.status));
});

test("Round 9.13.1 test C: 17:30+ does not reject a start exactly AT 17:30", () => {
  const parsed = parseOpeningHours("17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 17 * 60 + 30, durationMinutes: 60, parsed });
  assert.equal(res.status, "LEGAL");
  assert.ok(!isKnownHoursViolation(res.status));
});

test("Round 9.13.1 test D: 17:30+ does not reject a 19:00 start (well after the known opening boundary)", () => {
  const parsed = parseOpeningHours("17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 19 * 60, durationMinutes: 90, parsed });
  assert.equal(res.status, "LEGAL");
  assert.ok(!isKnownHoursViolation(res.status));
});

// E/F/G — day-prefixed open-ended rule.
test("Round 9.13.1 test E: Mo-Sa 17:30+ rejects a Thursday 12:40 start as pre-opening", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 12 * 60 + 40, durationMinutes: 60, parsed });
  assert.equal(res.status, "OPENS_AFTER_START");
});

test("Round 9.13.1 test F: Mo-Sa 17:30+ accepts the same Thursday after 17:30", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 18 * 60, durationMinutes: 60, parsed });
  assert.equal(res.status, "LEGAL");
});

test("Round 9.13.1 test G: Mo-Sa 17:30+ does not apply to Sunday — Sunday is CLOSED_ALL_DAY, never silently open", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  const res = evaluateOpeningHoursLegality({ localDate: SUN, startMinutes: 18 * 60, durationMinutes: 60, parsed });
  assert.equal(res.status, "CLOSED_ALL_DAY");
  assert.ok(isKnownHoursViolation(res.status));
});

// H — a day LIST (not a range) with an open-ended time.
test("Round 9.13.1 test H: Fr,Sa 18:00+ applies to Friday/Saturday only", () => {
  const parsed = parseOpeningHours("Fr,Sa 18:00+");
  assert.equal(evaluateOpeningHoursLegality({ localDate: FRI, startMinutes: 19 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: FRI, startMinutes: 12 * 60, durationMinutes: 60, parsed }).status, "OPENS_AFTER_START");
  assert.equal(evaluateOpeningHoursLegality({ localDate: SAT, startMinutes: 19 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 19 * 60, durationMinutes: 60, parsed }).status, "CLOSED_ALL_DAY");
});

// I — mixed open-ended + bounded rules across different day groups.
test("Round 9.13.1 test I: Mo-Th 17:30+; Fr-Sa 18:00+; Su 16:00-22:00 — each clause keeps its own semantics", () => {
  const parsed = parseOpeningHours("Mo-Th 17:30+; Fr-Sa 18:00+; Su 16:00-22:00");
  // Thursday: open-ended from 17:30.
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 12 * 60, durationMinutes: 60, parsed }).status, "OPENS_AFTER_START");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 20 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  // Friday: open-ended from 18:00.
  assert.equal(evaluateOpeningHoursLegality({ localDate: FRI, startMinutes: 17 * 60, durationMinutes: 30, parsed }).status, "OPENS_AFTER_START");
  assert.equal(evaluateOpeningHoursLegality({ localDate: FRI, startMinutes: 19 * 60, durationMinutes: 30, parsed }).status, "LEGAL");
  // Sunday: an ordinary BOUNDED range — a real close time IS enforced.
  assert.equal(evaluateOpeningHoursLegality({ localDate: SUN, startMinutes: 21 * 60 + 30, durationMinutes: 90, parsed }).status, "CLOSES_BEFORE_END");
  assert.equal(evaluateOpeningHoursLegality({ localDate: SUN, startMinutes: 17 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
});

// J — ordinary bounded hours must be completely unaffected by the new branch.
test("Round 9.13.1 test J: an ordinary 09:00-17:00 rule is unaffected by the open-ended addition", () => {
  const parsed = parseOpeningHours("09:00-17:00");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 10 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 16 * 60 + 30, durationMinutes: 60, parsed }).status, "CLOSES_BEFORE_END");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 8 * 60, durationMinutes: 30, parsed }).status, "OPENS_AFTER_START");
});

// K — 24/7 unaffected.
test("Round 9.13.1 test K: 24/7 is unaffected by the open-ended addition", () => {
  const parsed = parseOpeningHours("24/7");
  assert.equal(parsed.kind, "always");
  assert.equal(evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 3 * 60, durationMinutes: 60, parsed }).status, "LEGAL");
});

// L — the real Coda production shape, end-to-end through the structured layer.
test("Round 9.13.1 test L: Coda production-shaped regression — Mo-Sa 17:30+, scheduled 12:40, is a known violation", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  assert.equal(parsed.kind, "known", "the expression must no longer collapse to unknown");
  const preOpening = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 12 * 60 + 40, durationMinutes: 90, parsed });
  assert.ok(isKnownHoursViolation(preOpening.status), "12:40 must be a KNOWN violation, not silently permitted");
  const afterOpening = evaluateOpeningHoursLegality({ localDate: THU, startMinutes: 17 * 60 + 30, durationMinutes: 90, parsed });
  assert.ok(!isKnownHoursViolation(afterOpening.status), "17:30 itself must never be rejected for being before opening");
});

// M — earliestLegalStartMinute (the repair path's own slot-finder) correctly
// honors an open-ended interval: it can find 17:30 as the earliest legal
// slot when asked for something later than the naive default, and never
// rejects a reasonable duration for "running past" the internal placeholder.
test("Round 9.13.1 test M: earliestLegalStartMinute finds the open-ended boundary as the earliest legal slot", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  assert.equal(earliestLegalStartMinute(parsed, THU, 90, 12 * 60 + 40), 17 * 60 + 30);
  // A long visit (3 hours) starting right at the boundary must still be
  // accepted — never rejected against the internal closeMinute placeholder.
  assert.equal(earliestLegalStartMinute(parsed, THU, 180, 17 * 60 + 30), 17 * 60 + 30);
  // Sunday has no applicable rule at all.
  assert.equal(earliestLegalStartMinute(parsed, SUN, 90, 12 * 60), null);
});

/* ==================================================================== *
 * ROUND 9.15.10 — opening-hours parser correctness: the real production  *
 * regressions Round 9.15.9 proved (a comma-clause OSM string, and two    *
 * Google Places 12-hour display-hours strings) all silently defeated the *
 * final firewall Round 9.15.8 built. These fixtures are regression       *
 * evidence, never venue-specific production code.                       *
 * ==================================================================== */

// Real production dates from the Round 9.15.9 trace.
const WED_23_SEP = "2026-09-23";
const THU_24_SEP = "2026-09-24";
const WED_30_SEP = "2026-09-30";
const FRI_2_OCT = "2026-10-02";

const CANTAB_HOURS = "Mo-We 17:00-01:00,Th-Sa 12:00-02:00,Su 12:00-01:00";
const KNACK_HOURS =
  "Monday: 11:00 AM – 8:00 PM; Tuesday: 11:00 AM – 8:00 PM; Wednesday: 11:00 AM – 8:00 PM; Thursday: 11:00 AM – 8:00 PM; Friday: 11:00 AM – 8:00 PM; Saturday: 11:00 AM – 8:00 PM; Sunday: 11:00 AM – 8:00 PM";
const NINES_HOURS =
  "Monday: 6:30 AM – 5:00 PM; Tuesday: 6:30 AM – 5:00 PM; Wednesday: 6:30 AM – 5:00 PM; Thursday: 6:30 AM – 5:00 PM; Friday: 6:30 AM – 5:00 PM; Saturday: 6:30 AM – 5:00 PM; Sunday: 6:30 AM – 5:00 PM";

/* ---- §D FIXTURE 1 — Cantab Lounge: the OSM comma-clause bug ---- */

test("Round 9.15.10 FIXTURE 1 (Cantab Lounge): a comma-separated multi-day-range OSM string parses into three DISTINCT day clauses, not one polluted clause", () => {
  const parsed = parseOpeningHours(CANTAB_HOURS);
  assert.equal(parsed.kind, "known");
  if (parsed.kind !== "known") return;
  // Wednesday (dayOfWeek 3) must carry ONLY the "Mo-We 17:00-01:00" hours —
  // never the Th-Sa/Su ranges the old comma bug leaked onto it.
  const wednesdayIntervals = parsed.intervals.filter((i) => i.dayOfWeek === 3);
  assert.equal(wednesdayIntervals.length, 1, "Wednesday must carry exactly one interval, not three polluted ones");
  assert.equal(wednesdayIntervals[0].openMinute, 17 * 60);
  assert.equal(wednesdayIntervals[0].closeMinute, 25 * 60); // 01:00 next day
  // Thursday-Saturday and Sunday must carry their OWN distinct hours.
  const thursdayIntervals = parsed.intervals.filter((i) => i.dayOfWeek === 4);
  assert.equal(thursdayIntervals.length, 1);
  assert.equal(thursdayIntervals[0].openMinute, 12 * 60);
  const sundayIntervals = parsed.intervals.filter((i) => i.dayOfWeek === 0);
  assert.equal(sundayIntervals.length, 1);
  assert.equal(sundayIntervals[0].openMinute, 12 * 60);
});

test("Round 9.15.10 FIXTURE 1 (Cantab Lounge): 15:48 Wednesday is CLOSED, 17:00 and 23:30 are OPEN", () => {
  const parsed = parseOpeningHours(CANTAB_HOURS);
  assert.ok(isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: WED_23_SEP, startMinutes: 15 * 60 + 48, durationMinutes: 60, parsed }).status), "15:48 must be CLOSED — the exact proven production regression");
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: WED_23_SEP, startMinutes: 17 * 60, durationMinutes: 60, parsed }).status), "17:00 (opening) must be OPEN");
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: WED_23_SEP, startMinutes: 23 * 60 + 30, durationMinutes: 60, parsed }).status), "23:30 must be OPEN");
});

test("Round 9.15.10 FIXTURE 1 (Cantab Lounge, §C overnight): Thursday 00:30 is OPEN because it belongs to Wednesday's overnight interval", () => {
  const parsed = parseOpeningHours(CANTAB_HOURS);
  // A short (15min) visit fits entirely inside the carried-over Wed
  // 17:00-01:00 tail before the 01:00 close — proving 00:30 Thursday is
  // genuinely open, not merely "not yet classified".
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: THU_24_SEP, startMinutes: 30, durationMinutes: 15, parsed }).status), "00:30 Thursday must be OPEN — it belongs to Wednesday's overnight interval");
  // A 15:48 Wednesday-shaped mistake never happens on Thursday either: past
  // the 01:00 tail, Thursday's OWN hours (Th-Sa 12:00-02:00) govern, so an
  // early Thursday morning start (e.g. 05:00, well past the 01:00 overnight
  // tail and well before Thursday's own noon opening) must be CLOSED.
  assert.ok(isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: THU_24_SEP, startMinutes: 5 * 60, durationMinutes: 60, parsed }).status), "05:00 Thursday is in the gap between Wednesday's overnight tail and Thursday's own noon opening — must be CLOSED");
});

/* ---- §D FIXTURE 2 — the knack Orleans: Google 12-hour format ---- */

test("Round 9.15.10 FIXTURE 2 (the knack Orleans): Google-style 12-hour weekday hours now PARSE (never unknown)", () => {
  const parsed = parseOpeningHours(KNACK_HOURS);
  assert.equal(parsed.kind, "known", "Google Places' human-readable hours format must no longer collapse to unknown");
});

test("Round 9.15.10 FIXTURE 2 (the knack Orleans): 20:28 Wednesday is CLOSED, 19:59 is OPEN", () => {
  const parsed = parseOpeningHours(KNACK_HOURS);
  assert.ok(isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: WED_30_SEP, startMinutes: 20 * 60 + 28, durationMinutes: 60, parsed }).status), "20:28 must be CLOSED — the exact proven production regression");
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: WED_30_SEP, startMinutes: 19 * 60 + 59, durationMinutes: 1, parsed }).status), "19:59 must be OPEN");
});

/* ---- §D FIXTURE 3 — The Nines: Google 12-hour format, early open ---- */

test("Round 9.15.10 FIXTURE 3 (The Nines): Google-style 12-hour weekday hours now PARSE (never unknown)", () => {
  const parsed = parseOpeningHours(NINES_HOURS);
  assert.equal(parsed.kind, "known", "Google Places' human-readable hours format must no longer collapse to unknown");
});

test("Round 9.15.10 FIXTURE 3 (The Nines): 18:20 Friday is CLOSED, 16:59 is OPEN", () => {
  const parsed = parseOpeningHours(NINES_HOURS);
  assert.ok(isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: FRI_2_OCT, startMinutes: 18 * 60 + 20, durationMinutes: 60, parsed }).status), "18:20 must be CLOSED — the exact proven production regression");
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: FRI_2_OCT, startMinutes: 16 * 60 + 59, durationMinutes: 1, parsed }).status), "16:59 must be OPEN");
});

/* ---- §F comma disambiguation — day list vs multiple intervals vs separate clauses ---- */

test("Round 9.15.10 §F: a comma-separated DAY LIST ('Mo,We,Fr 09:00-17:00') is never split into malformed clauses", () => {
  const parsed = parseOpeningHours("Mo,We,Fr 09:00-17:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind !== "known") return;
  const days = new Set(parsed.intervals.map((i) => i.dayOfWeek));
  assert.deepEqual([...days].sort(), [1, 3, 5], "Monday, Wednesday, Friday must all carry the same 09:00-17:00 interval");
  assert.ok(parsed.intervals.every((i) => i.openMinute === 9 * 60 && i.closeMinute === 17 * 60));
});

test("Round 9.15.10 §F: MULTIPLE INTERVALS for the same day-range ('Mo-Fr 09:00-12:00,13:00-17:00') are never misread as a new day clause", () => {
  const parsed = parseOpeningHours("Mo-Fr 09:00-12:00,13:00-17:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind !== "known") return;
  const days = new Set(parsed.intervals.map((i) => i.dayOfWeek));
  assert.deepEqual([...days].sort(), [1, 2, 3, 4, 5], "the second interval must apply to the SAME Mo-Fr range, never become its own unday-scoped clause");
  const monday = parsed.intervals.filter((i) => i.dayOfWeek === 1);
  assert.equal(monday.length, 2, "Monday must carry BOTH the morning and afternoon intervals");
  // The classic lunch-break case: 12:30 (inside the gap) must be closed.
  assert.ok(isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: MON, startMinutes: 12 * 60 + 30, durationMinutes: 15, parsed }).status));
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: MON, startMinutes: 10 * 60, durationMinutes: 30, parsed }).status));
  assert.ok(!isKnownHoursViolation(evaluateOpeningHoursLegality({ localDate: MON, startMinutes: 14 * 60, durationMinutes: 30, parsed }).status));
});

test("Round 9.15.10 §F: GENUINELY SEPARATE day-range clauses joined by commas ('Mo-We .../Th-Sa .../Su ...') always split into distinct clauses", () => {
  const parsed = parseOpeningHours(CANTAB_HOURS);
  assert.equal(parsed.kind, "known");
  if (parsed.kind !== "known") return;
  const distinctDayCount = new Set(parsed.intervals.map((i) => i.dayOfWeek)).size;
  assert.equal(distinctDayCount, 7, "all seven weekdays must be individually represented, each with its own correct hours");
});

/* ---- §E — existing/required format audit (no regressions) ---- */

test("Round 9.15.10 §E: single day ('Mo 09:00-17:00')", () => {
  const parsed = parseOpeningHours("Mo 09:00-17:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") assert.deepEqual(parsed.intervals.map((i) => i.dayOfWeek), [1]);
});

test("Round 9.15.10 §E: day range ('Mo-Fr 09:00-17:00')", () => {
  const parsed = parseOpeningHours("Mo-Fr 09:00-17:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") assert.deepEqual(new Set(parsed.intervals.map((i) => i.dayOfWeek)), new Set([1, 2, 3, 4, 5]));
});

test("Round 9.15.10 §E: semicolon-separated clauses ('Mo-Fr 09:00-17:00; Sa 10:00-14:00')", () => {
  const parsed = parseOpeningHours("Mo-Fr 09:00-17:00; Sa 10:00-14:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") assert.deepEqual(new Set(parsed.intervals.map((i) => i.dayOfWeek)), new Set([1, 2, 3, 4, 5, 6]));
});

test("Round 9.15.10 §E: 24/7", () => {
  assert.equal(parseOpeningHours("24/7").kind, "always");
});

test("Round 9.15.10 §E: off / closed", () => {
  assert.equal(parseOpeningHours("off").kind, "closed");
  assert.equal(parseOpeningHours("closed").kind, "closed");
});

test("Round 9.15.10 §E: open-ended '+' syntax already used by the planner ('Mo-Sa 17:30+') is unaffected", () => {
  const parsed = parseOpeningHours("Mo-Sa 17:30+");
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") assert.ok(parsed.intervals.every((i) => i.openEnded === true));
});

test("Round 9.15.10 §E: overnight ('Fr-Sa 18:00-02:00') is unaffected", () => {
  const parsed = parseOpeningHours("Fr-Sa 18:00-02:00");
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") {
    assert.ok(parsed.intervals.every((i) => i.crossesMidnight === true));
    assert.deepEqual(new Set(parsed.intervals.map((i) => i.dayOfWeek)), new Set([5, 6]));
  }
});

test("Round 9.15.10 §E/§G: a per-day 'Open 24 hours' clause mixed with other explicit weekdays scopes ONLY to its own day, never upgrades the whole string", () => {
  const parsed = parseOpeningHours("Monday: Open 24 hours; Tuesday: 9:00 AM - 5:00 PM");
  assert.equal(parsed.kind, "known", "must NOT collapse to the whole-string 'always' shortcut");
  if (parsed.kind !== "known") return;
  const monday = parsed.intervals.filter((i) => i.dayOfWeek === 1);
  assert.equal(monday.length, 1);
  assert.equal(monday[0].openMinute, 0);
  assert.equal(monday[0].closeMinute, 24 * 60);
  const tuesday = parsed.intervals.filter((i) => i.dayOfWeek === 2);
  assert.equal(tuesday.length, 1);
  assert.equal(tuesday[0].openMinute, 9 * 60);
  assert.equal(tuesday[0].closeMinute, 17 * 60);
});

test("Round 9.15.10 §E: a bare 'Open 24 hours' with no other clause still shortcuts to always-open", () => {
  assert.equal(parseOpeningHours("Open 24 hours").kind, "always");
});

/* ---- §G — AM/PM normalization ---- */

test("Round 9.15.10 §G: 12:00 AM => 00:00, 12:00 PM => 12:00, 1:30 PM => 13:30", () => {
  const midnight = parseOpeningHours("Mo 12:00 AM - 06:00");
  assert.equal(midnight.kind, "known");
  if (midnight.kind === "known") assert.equal(midnight.intervals[0].openMinute, 0);

  const noon = parseOpeningHours("Mo 12:00 PM - 18:00");
  assert.equal(noon.kind, "known");
  if (noon.kind === "known") assert.equal(noon.intervals[0].openMinute, 12 * 60);

  const afternoon = parseOpeningHours("Mo 1:30 PM - 18:00");
  assert.equal(afternoon.kind, "known");
  if (afternoon.kind === "known") assert.equal(afternoon.intervals[0].openMinute, 13 * 60 + 30);
});

test("Round 9.15.10 §G: Unicode en-dash/em-dash and non-breaking space variants in Google-style hours are normalized correctly", () => {
  // en dash + a non-breaking space (U+00A0) before "PM", exactly as
  // provider data is observed to contain.
  const withNbsp = `Monday: 11:00 AM – 8:00 PM`;
  const parsed = parseOpeningHours(withNbsp);
  assert.equal(parsed.kind, "known");
  if (parsed.kind === "known") {
    assert.equal(parsed.intervals[0].openMinute, 11 * 60);
    assert.equal(parsed.intervals[0].closeMinute, 20 * 60);
  }
});

/* ---- §H — parse-quality observability ---- */

test("Round 9.15.10 §H: classifyOpeningHoursParseQuality distinguishes PARSED / UNKNOWN_OR_MISSING / MALFORMED / UNSUPPORTED_FORMAT", () => {
  assert.equal(classifyOpeningHoursParseQuality(null), "UNKNOWN_OR_MISSING");
  assert.equal(classifyOpeningHoursParseQuality(""), "UNKNOWN_OR_MISSING");
  assert.equal(classifyOpeningHoursParseQuality("לא זמין"), "UNKNOWN_OR_MISSING", "the codebase's own not-available placeholder must never be reported as a parser gap");
  assert.equal(classifyOpeningHoursParseQuality(CANTAB_HOURS), "PARSED");
  assert.equal(classifyOpeningHoursParseQuality(KNACK_HOURS), "PARSED");
  assert.equal(classifyOpeningHoursParseQuality("call for hours"), "UNSUPPORTED_FORMAT", "no day/time-shaped token at all — a genuinely novel shape, not a broken one");
  assert.equal(classifyOpeningHoursParseQuality("Mo 99:99-100:00"), "MALFORMED", "a real day token and a real HH:MM-shaped token are both present, but the values don't cohere");
});
