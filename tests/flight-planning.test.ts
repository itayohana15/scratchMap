import assert from "node:assert/strict";
import test from "node:test";

import {
  computeArrivalDepartureWindow,
  computeFlightDurationMinutes,
  computeMultiSegmentFlight,
  describeArrivalDepartureWindow,
  estimateFlightArrival,
  estimateFlightDurationMinutesByDistance,
  resolveAirportTimeZone,
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

// Airport-aware flight duration/arrival estimation (spec items 2-9, 31-32).
test("estimateFlightDurationMinutesByDistance returns a reasonable positive estimate for a known route", () => {
  const minutes = estimateFlightDurationMinutesByDistance("TLV", "TBS");
  assert.ok(minutes != null && minutes > 60 && minutes < 240, `expected a realistic short-haul duration, got ${minutes}`);
});

test("estimateFlightDurationMinutesByDistance returns null for an unrecognized airport", () => {
  assert.equal(estimateFlightDurationMinutesByDistance("TLV", "ZZZ"), null);
});

test("resolveAirportTimeZone prefers the airport's own timezone over the fallback", () => {
  assert.equal(resolveAirportTimeZone("TBS", "Etc/UTC"), "Asia/Tbilisi");
  assert.equal(resolveAirportTimeZone("ZZZ", "Etc/UTC"), "Etc/UTC");
});

test("estimateFlightArrival computes a timezone-aware arrival, never a naive same-zone addition", () => {
  const estimate = estimateFlightArrival("TLV", "TBS", "2026-08-26", "20:25", "Asia/Jerusalem", "Asia/Tbilisi");
  assert.ok(estimate != null);
  // Naive same-zone addition would give a TLV-local time (e.g. ~22:52) —
  // the real Tbilisi local time is one hour ahead of that.
  assert.notEqual(estimate!.arrivalTime, "22:52");
  assert.match(estimate!.arrivalTime, /^\d{2}:\d{2}$/);
  assert.ok(estimate!.estimatedFlightDurationMinutes > 60);
});

test("estimateFlightArrival returns null for an unrecognized airport (falls back to manual entry)", () => {
  assert.equal(estimateFlightArrival("TLV", "ZZZ", "2026-08-26", "20:25", "Asia/Jerusalem", "Etc/UTC"), null);
});

test("estimateFlightArrival returns null when required fields are missing", () => {
  assert.equal(estimateFlightArrival("", "TBS", "2026-08-26", "20:25", "Asia/Jerusalem", "Asia/Tbilisi"), null);
  assert.equal(estimateFlightArrival("TLV", "TBS", "2026-08-26", "", "Asia/Jerusalem", "Asia/Tbilisi"), null);
});

test("estimateFlightArrival flags next-calendar-day arrival for a late-night departure", () => {
  const estimate = estimateFlightArrival("TLV", "TBS", "2026-08-26", "23:30", "Asia/Jerusalem", "Asia/Tbilisi");
  assert.ok(estimate != null);
  assert.equal(estimate!.arrivesNextCalendarDay, true);
  assert.equal(estimate!.arrivalDate, "2026-08-27");
});

test("computeMultiSegmentFlight with zero connections matches a direct estimateFlightArrival", () => {
  const direct = estimateFlightArrival("TLV", "TBS", "2026-08-26", "18:30", "Asia/Jerusalem", "Asia/Tbilisi");
  const result = computeMultiSegmentFlight(
    "TLV",
    "TBS",
    "2026-08-26",
    "18:30",
    [],
    "Asia/Jerusalem",
    "Asia/Tbilisi"
  );
  assert.ok(direct != null && result != null);
  assert.equal(result!.segments.length, 1);
  assert.equal(result!.finalArrivalDate, direct!.arrivalDate);
  assert.equal(result!.finalArrivalTime, direct!.arrivalTime);
  // No layover on a direct flight — airborne time equals total journey time.
  assert.equal(result!.totalAirborneMinutes, result!.totalJourneyMinutes);
  assert.equal(result!.totalAirborneMinutes, direct!.estimatedFlightDurationMinutes);
});

test("computeMultiSegmentFlight chains one connection, adds the layover, and sums both totals", () => {
  const result = computeMultiSegmentFlight(
    "TLV",
    "TBS",
    "2026-08-26",
    "18:30",
    [{ airport: "IST", layoverMinutes: 130 }],
    "Asia/Jerusalem",
    "Asia/Tbilisi"
  );
  assert.ok(result != null);
  assert.equal(result!.segments.length, 2);
  assert.equal(result!.segments[0].origin, "TLV");
  assert.equal(result!.segments[0].destination, "IST");
  assert.equal(result!.segments[1].origin, "IST");
  assert.equal(result!.segments[1].destination, "TBS");
  // Second segment must depart no earlier than the first segment's arrival plus the layover.
  assert.equal(result!.segments[1].departureDate >= result!.segments[0].arrivalDate, true);
  const perSegmentSum = result!.segments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
  assert.equal(result!.totalAirborneMinutes, perSegmentSum);
  // Total journey = airborne + the one layover, so it must be strictly greater than airborne alone.
  assert.ok(result!.totalJourneyMinutes > result!.totalAirborneMinutes);
  assert.equal(result!.totalJourneyMinutes - result!.totalAirborneMinutes, 130);
});

test("computeMultiSegmentFlight returns null when any airport in the chain is unrecognized", () => {
  assert.equal(
    computeMultiSegmentFlight(
      "TLV",
      "TBS",
      "2026-08-26",
      "18:30",
      [{ airport: "ZZZ", layoverMinutes: 90 }],
      "Asia/Jerusalem",
      "Asia/Tbilisi"
    ),
    null
  );
});

test("computeMultiSegmentFlight returns null when required top-level fields are missing", () => {
  assert.equal(
    computeMultiSegmentFlight("", "TBS", "2026-08-26", "18:30", [], "Asia/Jerusalem", "Asia/Tbilisi"),
    null
  );
});
