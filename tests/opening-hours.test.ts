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
