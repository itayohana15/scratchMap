import assert from "node:assert/strict";
import test from "node:test";

import { formatTripDateRange } from "../src/lib/format";

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
