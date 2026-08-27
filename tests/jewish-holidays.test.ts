import assert from "node:assert/strict";
import test from "node:test";

import {
  describeHolidayContext,
  findHolidayForDate,
  getHolidaysForYear,
  getHolidaysForYearRange,
  getHolidaysOverlappingRange,
  getHolidayTravelWarning,
} from "../src/lib/facts/jewish-holidays";

// Dates verified against a real @hebcal/core computation for 2026 (see
// scripts/generate-jewish-holidays.mjs) — Rosh Hashana 5787 falls Sept 11-12.
test("getHolidaysForYear finds Rosh Hashana on the real computed 2026 date", () => {
  const holidays = getHolidaysForYear(2026);
  const roshHashana = holidays.find((h) => h.date === "2026-09-11");
  assert.ok(roshHashana);
  assert.equal(roshHashana!.nameHe, "ראש השנה");
  assert.ok(roshHashana!.categories.includes("jewish_holiday"));
  assert.ok(roshHashana!.categories.includes("israeli_public_holiday"));
});

test("getHolidaysForYear excludes minor/regional lookalike observances", () => {
  const holidays = getHolidaysForYear(2026);
  // "Rosh Hashana LaBehemot" (Elul 1) must never be reported as ראש השנה.
  assert.equal(findHolidayForDate(holidays, "2026-08-13"), null);
  // "Pesach Sheni" must never be reported as פסח.
  assert.equal(findHolidayForDate(holidays, "2026-04-30"), null);
});

test("getHolidaysForYear categorizes a Jewish-only holiday (Chanukah) without the Israeli public-holiday tag", () => {
  const holidays = getHolidaysForYear(2026);
  const chanukah = findHolidayForDate(holidays, "2026-12-05");
  assert.ok(chanukah);
  assert.deepEqual(chanukah!.categories, ["jewish_holiday"]);
});

test("getHolidaysForYearRange spans a year boundary", () => {
  const holidays = getHolidaysForYearRange(2025, 2026);
  assert.ok(holidays.some((h) => h.date.startsWith("2025")));
  assert.ok(holidays.some((h) => h.date.startsWith("2026")));
});

test("getHolidayTravelWarning fires on the holiday's own date", () => {
  const warning = getHolidayTravelWarning("2026-09-20");
  assert.ok(warning?.includes("יום כיפור"));
});

test("getHolidayTravelWarning fires as an eve-of warning the day before a holiday", () => {
  const warning = getHolidayTravelWarning("2026-09-10");
  assert.ok(warning?.includes("ערב"));
  assert.ok(warning?.includes("ראש השנה"));
});

test("getHolidayTravelWarning returns null for an ordinary date", () => {
  assert.equal(getHolidayTravelWarning("2026-06-15"), null);
});

test("getHolidaysOverlappingRange includes only dates inside the trip range", () => {
  const overlapping = getHolidaysOverlappingRange("2026-09-24", "2026-09-26");
  assert.equal(overlapping.length, 1);
  assert.equal(overlapping[0].date, "2026-09-25");
});

test("describeHolidayContext returns an empty string when no holiday overlaps the range", () => {
  assert.equal(describeHolidayContext("2026-06-01", "2026-06-10"), "");
});

test("describeHolidayContext mentions the holiday name and is phrased as advisory, not a hard constraint", () => {
  const context = describeHolidayContext("2026-09-24", "2026-09-26");
  assert.ok(context.includes("סוכות"));
  assert.ok(context.toLowerCase().includes("not a hard constraint"));
});
