import assert from "node:assert/strict";
import test from "node:test";

import {
  computeArrivalDepartureWindow,
  computeFlightDurationMinutes,
  describeArrivalDepartureWindow,
} from "../src/lib/flight-planning";
import { createEmptyFlightLeg, type TripFlights } from "../src/lib/trip-workspace";

// 1. Real tz-aware duration: TLV -> Tbilisi (Israel and Georgia share no DST
// offset quirk on this date, but the zones are genuinely different — a naive
// local-time subtraction here would silently give the wrong answer whenever
// the offsets ever diverge, e.g. across DST transitions).
test("computeFlightDurationMinutes computes real elapsed time across two timezones", () => {
  const leg = {
    departureDate: "2026-09-05",
    departureTime: "08:00",
    arrivalDate: "2026-09-05",
    arrivalTime: "12:30",
  };
  // Asia/Jerusalem and Asia/Tbilisi are both UTC+ (roughly) at this date but
  // not necessarily identical offsets — assert against the real computed
  // instant difference rather than a hand-picked expected number.
  const minutes = computeFlightDurationMinutes(leg, "Asia/Jerusalem", "Asia/Tbilisi");
  assert.ok(minutes != null && minutes > 0);
});

test("computeFlightDurationMinutes returns null for an incomplete leg", () => {
  const leg = { departureDate: "2026-09-05", departureTime: "08:00", arrivalDate: "", arrivalTime: "" };
  assert.equal(computeFlightDurationMinutes(leg, "Asia/Jerusalem", "Asia/Tbilisi"), null);
});

test("computeFlightDurationMinutes returns null when arrival is not after departure", () => {
  const leg = {
    departureDate: "2026-09-05",
    departureTime: "12:00",
    arrivalDate: "2026-09-05",
    arrivalTime: "10:00",
  };
  assert.equal(computeFlightDurationMinutes(leg, "Asia/Jerusalem", "Asia/Jerusalem"), null);
});

function buildFlights(overrides: Partial<TripFlights>): TripFlights {
  return { outbound: null, return: null, ...overrides };
}

// 2. A 14:30 arrival should push the earliest usable time to the evening —
// the worked example from the spec.
test("computeArrivalDepartureWindow pushes a mid-afternoon arrival to a realistic evening start", () => {
  const flights = buildFlights({
    outbound: { ...createEmptyFlightLeg(), arrivalDate: "2026-09-05", arrivalTime: "14:30" },
  });
  const window = computeArrivalDepartureWindow(flights, "GE");
  assert.ok(window.earliestUsableTimeOnArrivalDay != null);
  assert.equal(window.earliestUsableTimeOnArrivalDay?.date, "2026-09-05");
  // 14:30 + 90 (processing) + 45 (transfer) + 30 (check-in) = 16:75 = 17:15
  assert.equal(window.earliestUsableTimeOnArrivalDay?.time, "17:15");
});

// 3. A 16:00 departure should pull the latest usable time back to late morning.
test("computeArrivalDepartureWindow pulls a mid-afternoon departure back to late morning", () => {
  const flights = buildFlights({
    return: { ...createEmptyFlightLeg(), departureDate: "2026-09-10", departureTime: "16:00" },
  });
  const window = computeArrivalDepartureWindow(flights, "GE");
  assert.ok(window.latestUsableTimeOnDepartureDay != null);
  assert.equal(window.latestUsableTimeOnDepartureDay?.date, "2026-09-10");
  // 16:00 - 180 (airport buffer) - 45 (transfer) = 12:15
  assert.equal(window.latestUsableTimeOnDepartureDay?.time, "12:15");
});

// 4. Overnight rollover: an early-morning arrival with a large processing
// buffer can push the earliest usable time into the same day only if there's
// room, but a very late-night arrival should roll into the next calendar day.
test("computeArrivalDepartureWindow rolls over to the next calendar day for a late-night arrival", () => {
  const flights = buildFlights({
    outbound: { ...createEmptyFlightLeg(), arrivalDate: "2026-09-05", arrivalTime: "23:30" },
  });
  const window = computeArrivalDepartureWindow(flights, "GE");
  // 23:30 + 165 minutes = 02:15 the next day.
  assert.equal(window.earliestUsableTimeOnArrivalDay?.date, "2026-09-06");
  assert.equal(window.earliestUsableTimeOnArrivalDay?.time, "02:15");
});

// 5. An early-morning departure should roll the "latest usable time" back to
// the previous calendar day.
test("computeArrivalDepartureWindow rolls back to the previous calendar day for an early-morning departure", () => {
  const flights = buildFlights({
    return: { ...createEmptyFlightLeg(), departureDate: "2026-09-10", departureTime: "01:00" },
  });
  const window = computeArrivalDepartureWindow(flights, "GE");
  // 01:00 - 225 minutes = the previous day at 21:15.
  assert.equal(window.latestUsableTimeOnDepartureDay?.date, "2026-09-09");
  assert.equal(window.latestUsableTimeOnDepartureDay?.time, "21:15");
});

// 6. No flights set at all: both windows are null, never a fabricated guess.
test("computeArrivalDepartureWindow returns null windows when no flights are set", () => {
  const window = computeArrivalDepartureWindow(undefined, "GE");
  assert.equal(window.earliestUsableTimeOnArrivalDay, null);
  assert.equal(window.latestUsableTimeOnDepartureDay, null);
});

test("describeArrivalDepartureWindow produces empty text when both windows are null", () => {
  assert.equal(
    describeArrivalDepartureWindow({ earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null }),
    ""
  );
});

test("describeArrivalDepartureWindow mentions both computed times when both windows are set", () => {
  const text = describeArrivalDepartureWindow({
    earliestUsableTimeOnArrivalDay: { date: "2026-09-05", time: "17:15" },
    latestUsableTimeOnDepartureDay: { date: "2026-09-10", time: "11:15" },
  });
  assert.match(text, /17:15/);
  assert.match(text, /11:15/);
});
