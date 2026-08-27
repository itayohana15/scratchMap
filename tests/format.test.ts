import assert from "node:assert/strict";
import test from "node:test";

import { formatElapsedDuration, formatTripDateRange, formatTripDateRangeExpanded } from "../src/lib/format";

test("same month + same year: 2026-10-05 -> 2026-10-27", () => {
  assert.equal(formatTripDateRange("2026-10-05", "2026-10-27"), "5-27 באוקטובר 2026");
});

test("different months, same year: 2026-06-05 -> 2026-07-27", () => {
  assert.equal(formatTripDateRange("2026-06-05", "2026-07-27"), "5.6-27.7 2026");
});

test("different years: 2026-12-01 -> 2027-01-25", () => {
  assert.equal(formatTripDateRange("2026-12-01", "2027-01-25"), "1.12.26-25.1.27");
});

test("different months, same year: 2018-06-24 -> 2018-07-02", () => {
  assert.equal(formatTripDateRange("2018-06-24", "2018-07-02"), "24.6-2.7 2018");
});

test("same month + same year: 2010-07-05 -> 2010-07-13", () => {
  assert.equal(formatTripDateRange("2010-07-05", "2010-07-13"), "5-13 ביולי 2010");
});

test("different years: 2026-12-28 -> 2027-01-04", () => {
  assert.equal(formatTripDateRange("2026-12-28", "2027-01-04"), "28.12.26-4.1.27");
});

test("partial (month/year only) date, no real start/end", () => {
  assert.equal(formatTripDateRange(null, null, "2022-09"), "ספטמבר 2022");
  assert.equal(formatTripDateRange(undefined, undefined, "2023-06"), "יוני 2023");
});

test("unknown dates -> ללא תאריכים, never 0/invented values", () => {
  assert.equal(formatTripDateRange(null, null), "ללא תאריכים");
  assert.equal(formatTripDateRange(null, null, null), "ללא תאריכים");
});

test("single-day trip does not render a redundant '5-5' range", () => {
  assert.equal(formatTripDateRange("2026-10-05", "2026-10-05"), "5 באוקטובר 2026");
});

test("only one of start/end known falls back to a single formatted date, not a range", () => {
  const result = formatTripDateRange("2026-10-05", null);
  assert.ok(result.includes("2026"));
  assert.ok(!result.includes("-27"));
});

test("expanded trip date range prefers readable month names across months", () => {
  assert.equal(
    formatTripDateRangeExpanded("2026-08-26", "2026-09-05"),
    "26 באוג׳ - 5 בספט׳ 2026"
  );
});

test("expanded trip date range keeps partial month-year dates readable", () => {
  assert.equal(formatTripDateRangeExpanded(null, null, "2023-06"), "יוני 2023");
});

test("formatElapsedDuration uses MM:SS under an hour", () => {
  assert.equal(formatElapsedDuration(0), "00:00");
  assert.equal(formatElapsedDuration(47_000), "00:47");
  assert.equal(formatElapsedDuration(3 * 60_000 + 42_000), "03:42");
  assert.equal(formatElapsedDuration(59 * 60_000 + 59_000), "59:59");
});

test("formatElapsedDuration switches to HH:MM:SS at an hour and beyond", () => {
  assert.equal(formatElapsedDuration(60 * 60_000), "01:00:00");
  assert.equal(formatElapsedDuration(60 * 60_000 + 4 * 60_000 + 21_000), "01:04:21");
});

test("formatElapsedDuration never goes negative", () => {
  assert.equal(formatElapsedDuration(-500), "00:00");
});
