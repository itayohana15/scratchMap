import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOpeningHoursWindow,
  resolveLastEntryMinutes,
  violatesOpeningHours,
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
