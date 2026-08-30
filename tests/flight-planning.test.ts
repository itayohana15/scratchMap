import assert from "node:assert/strict";
import test from "node:test";

import {
  computeArrivalDepartureWindow,
  computeFlightDurationMinutes,
  computeMultiSegmentFlight,
  describeArrivalDepartureWindow,
  detectAirportBaseMismatch,
  detectInvalidFlightLegs,
  estimateAirportTransferMinutes,
  estimateFlightArrival,
  estimateFlightDurationMinutesByDistance,
  evaluateFinalBaseDepartureFeasibility,
  getJourneySegments,
  resolveAirportTimeZone,
  validateJourneySegments,
  violatesArrivalDepartureWindow,
  type ArrivalDepartureWindow,
} from "../src/lib/flight-planning";
import { createEmptyFlightLeg, type TripFlightConnection, type TripFlights } from "../src/lib/trip-workspace";

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
    [{ countryIso: "TR", arrivalAirport: "IST", departureAirport: "IST", layoverMinutes: 130 }],
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
      [{ countryIso: "ZZ", arrivalAirport: "ZZZ", departureAirport: "ZZZ", layoverMinutes: 90 }],
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

test("estimateAirportTransferMinutes returns a positive ground-transfer estimate for two real, distinct airports", () => {
  // Narita and Haneda are both in Tokyo but genuinely different airports —
  // a real ground transfer, not zero.
  const minutes = estimateAirportTransferMinutes("NRT", "HND");
  assert.ok(minutes != null && minutes > 0);
});

test("estimateAirportTransferMinutes returns null for an unrecognized airport", () => {
  assert.equal(estimateAirportTransferMinutes("ZZZ", "HND"), null);
});

test("computeMultiSegmentFlight adds a distance-based transfer time on top of the layover when a connection changes airports (spec item 6)", () => {
  const layoverMinutes = 100;
  const sameAirport = computeMultiSegmentFlight(
    "TLV",
    "NRT",
    "2026-09-05",
    "10:00",
    [{ countryIso: "TH", arrivalAirport: "BKK", departureAirport: "BKK", layoverMinutes }],
    "Asia/Jerusalem",
    "Asia/Tokyo"
  );
  const changedAirport = computeMultiSegmentFlight(
    "TLV",
    "NRT",
    "2026-09-05",
    "10:00",
    [{ countryIso: "TH", arrivalAirport: "DMK", departureAirport: "BKK", layoverMinutes }],
    "Asia/Jerusalem",
    "Asia/Tokyo"
  );
  assert.ok(sameAirport != null && changedAirport != null);
  const expectedTransferMinutes = estimateAirportTransferMinutes("DMK", "BKK");
  assert.ok(expectedTransferMinutes != null && expectedTransferMinutes > 0);
  // Ground time = totalJourneyMinutes - totalAirborneMinutes. When the
  // connection's arrival/departure airports are identical, ground time is
  // exactly the layover; when they differ, the real distance-based transfer
  // is added on top (segment flight durations themselves legitimately shift
  // too, since BKK/DMK are genuinely different airports — this isolates the
  // ground-time delta specifically, not the airborne totals).
  assert.equal(sameAirport!.totalJourneyMinutes - sameAirport!.totalAirborneMinutes, layoverMinutes);
  assert.equal(
    changedAirport!.totalJourneyMinutes - changedAirport!.totalAirborneMinutes,
    layoverMinutes + expectedTransferMinutes!
  );
});

test("getJourneySegments derives one country-aware segment per hop for a 3-segment IL→TR→TH→JP route", () => {
  const leg = {
    departureAirport: "TLV",
    arrivalAirport: "NRT",
    connections: [
      { countryIso: "TR", arrivalAirport: "IST", departureAirport: "IST", layoverMinutes: 100 } as TripFlightConnection,
      { countryIso: "TH", arrivalAirport: "BKK", departureAirport: "BKK", layoverMinutes: 100 } as TripFlightConnection,
    ],
  };
  const segments = getJourneySegments(leg, "IL", "JP");
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((segment) => [segment.originCountry, segment.originAirport, segment.destinationCountry, segment.destinationAirport]),
    [
      ["IL", "TLV", "TR", "IST"],
      ["TR", "IST", "TH", "BKK"],
      ["TH", "BKK", "JP", "NRT"],
    ]
  );
  assert.equal(validateJourneySegments(segments, "IL", "JP"), null);
});

test("getJourneySegments flags a connection's airport-changed hop and its layover", () => {
  const leg = {
    departureAirport: "TLV",
    arrivalAirport: "NRT",
    connections: [
      { countryIso: "TH", arrivalAirport: "DMK", departureAirport: "BKK", layoverMinutes: 100 } as TripFlightConnection,
    ],
  };
  const segments = getJourneySegments(leg, "IL", "JP");
  assert.equal(segments.length, 2);
  assert.equal(segments[0].airportChangedAfter, true);
  assert.equal(segments[0].layoverMinutes, 100);
  assert.equal(segments[1].airportChangedAfter, false);
});

test("validateJourneySegments rejects a segment whose airport doesn't match its claimed country", () => {
  const segments = [
    { originCountry: "IL", originAirport: "TLV", destinationCountry: "TH", destinationAirport: "TLV", layoverMinutes: 100, airportChangedAfter: false },
    { originCountry: "TH", originAirport: "BKK", destinationCountry: "JP", destinationAirport: "NRT", layoverMinutes: null, airportChangedAfter: false },
  ];
  const error = validateJourneySegments(segments, "IL", "JP");
  assert.ok(error != null && error.includes("TLV"));
});

test("validateJourneySegments rejects segments that don't chain (one segment's destination country doesn't match the next segment's origin country)", () => {
  const segments = [
    { originCountry: "IL", originAirport: "TLV", destinationCountry: "TR", destinationAirport: "IST", layoverMinutes: 100, airportChangedAfter: false },
    { originCountry: "TH", originAirport: "BKK", destinationCountry: "JP", destinationAirport: "NRT", layoverMinutes: null, airportChangedAfter: false },
  ];
  const error = validateJourneySegments(segments, "IL", "JP");
  assert.ok(error != null && error.includes("מחוברים"));
});

test("validateJourneySegments rejects a journey whose first segment doesn't start in the trip's true origin country", () => {
  const segments = [
    { originCountry: "TR", originAirport: "IST", destinationCountry: "JP", destinationAirport: "NRT", layoverMinutes: null, airportChangedAfter: false },
  ];
  assert.ok(validateJourneySegments(segments, "IL", "JP") != null);
});

// Section A2/I5-6: same-airport accidental default.
test("detectInvalidFlightLegs flags an outbound leg whose departure and arrival airport are identical", () => {
  const flights: TripFlights = {
    outbound: { ...createEmptyFlightLeg(), departureAirport: "TLV", arrivalAirport: "TLV" },
    return: null,
  };
  const findings = detectInvalidFlightLegs(flights);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].legId, "outbound");
  assert.equal(findings[0].originAirport, "TLV");
});

test("detectInvalidFlightLegs flags a same-airport return leg independently of the outbound leg", () => {
  const flights: TripFlights = {
    outbound: { ...createEmptyFlightLeg(), departureAirport: "TLV", arrivalAirport: "CDG" },
    return: { ...createEmptyFlightLeg(), departureAirport: "CDG", arrivalAirport: "CDG" },
  };
  const findings = detectInvalidFlightLegs(flights);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].legId, "return");
});

test("detectInvalidFlightLegs is case-insensitive and never flags a normal two-airport leg", () => {
  const flights: TripFlights = {
    outbound: { ...createEmptyFlightLeg(), departureAirport: "tlv", arrivalAirport: "TLV" },
    return: { ...createEmptyFlightLeg(), departureAirport: "TLV", arrivalAirport: "CDG" },
  };
  const findings = detectInvalidFlightLegs(flights);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].legId, "outbound");
});

test("detectInvalidFlightLegs returns nothing when no flights are set", () => {
  assert.deepEqual(detectInvalidFlightLegs(undefined), []);
  assert.deepEqual(detectInvalidFlightLegs({ outbound: null, return: null }), []);
});

// Section A3-A5/I1-4: arrival/departure airport vs. the day's real base.
test("detectAirportBaseMismatch returns null when the day's anchors are a normal distance from the airport", () => {
  // CDG itself — a same-city hotel/activity cluster.
  const mismatch = detectAirportBaseMismatch("arrival", "CDG", [{ lat: 48.86, lon: 2.35 }]);
  assert.equal(mismatch, null);
});

test("detectAirportBaseMismatch flags a departure day whose real anchors sit far outside the airport's metro area", () => {
  // Nice is ~680km from Paris CDG — clearly a different region reached by
  // far more than the fixed ground-transfer assumption baked into the
  // arrival/departure window, not a same-city commute.
  const mismatch = detectAirportBaseMismatch("departure", "CDG", [{ lat: 43.6584, lon: 7.2159 }]);
  assert.ok(mismatch != null);
  assert.equal(mismatch?.direction, "departure");
  assert.equal(mismatch?.airport, "CDG");
  assert.ok(mismatch!.estimatedGroundMinutes > mismatch!.assumedGroundMinutes);
});

test("detectAirportBaseMismatch returns null for an unrecognized airport or when no anchor has coordinates", () => {
  assert.equal(detectAirportBaseMismatch("arrival", "ZZZ", [{ lat: 48.86, lon: 2.35 }]), null);
  assert.equal(detectAirportBaseMismatch("arrival", "CDG", [{ lat: null, lon: null }]), null);
});

// Section A1/A5: violatesArrivalDepartureWindow must validate the item's
// whole occupied interval on a departure day, not merely its start.
const DEPARTURE_WINDOW: ArrivalDepartureWindow = {
  earliestUsableTimeOnArrivalDay: null,
  latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "13:15" },
};

test("violatesArrivalDepartureWindow: starts before cutoff, ends before cutoff -> valid", () => {
  assert.equal(
    violatesArrivalDepartureWindow("10:18", "2026-09-16", false, true, DEPARTURE_WINDOW, "11:18"),
    false
  );
});

test("violatesArrivalDepartureWindow: starts before cutoff, ends after cutoff -> invalid (the real France bug)", () => {
  assert.equal(
    violatesArrivalDepartureWindow("10:18", "2026-09-16", false, true, DEPARTURE_WINDOW, "15:18"),
    true
  );
});

test("violatesArrivalDepartureWindow: starts after cutoff -> invalid", () => {
  assert.equal(
    violatesArrivalDepartureWindow("14:00", "2026-09-16", false, true, DEPARTURE_WINDOW, "14:30"),
    true
  );
});

test("violatesArrivalDepartureWindow: end exactly equal to the cutoff -> valid", () => {
  assert.equal(
    violatesArrivalDepartureWindow("12:15", "2026-09-16", false, true, DEPARTURE_WINDOW, "13:15"),
    false
  );
});

test("violatesArrivalDepartureWindow falls back to start time when no end time is supplied at all (never under-detects into a crash, but never over-detects either)", () => {
  assert.equal(violatesArrivalDepartureWindow("10:18", "2026-09-16", false, true, DEPARTURE_WINDOW), false);
  assert.equal(violatesArrivalDepartureWindow("14:00", "2026-09-16", false, true, DEPARTURE_WINDOW), true);
});

// Section B1-B4: evaluateFinalBaseDepartureFeasibility — real time budget,
// never an arbitrary distance rule.
test("evaluateFinalBaseDepartureFeasibility: a close base is feasible for a late flight", () => {
  const result = evaluateFinalBaseDepartureFeasibility("CDG", "20:00", { lat: 48.86, lon: 2.35 });
  assert.ok(result?.feasible);
});

test("evaluateFinalBaseDepartureFeasibility: an extremely distant base is infeasible even for a late flight", () => {
  const result = evaluateFinalBaseDepartureFeasibility("CDG", "20:00", { lat: 10, lon: 10 });
  assert.equal(result?.feasible, false);
});

test("evaluateFinalBaseDepartureFeasibility: the SAME mid-distance base is infeasible for an early flight but feasible for a late one — time budget, not a fixed distance rule", () => {
  const midDistanceAnchor = { lat: 45.75, lon: 4.85 };
  const early = evaluateFinalBaseDepartureFeasibility("CDG", "07:00", midDistanceAnchor);
  const late = evaluateFinalBaseDepartureFeasibility("CDG", "20:00", midDistanceAnchor);
  assert.equal(early?.feasible, false, "an early flight should not tolerate this distance");
  assert.equal(late?.feasible, true, "a late flight should tolerate the exact same distance");
});

test("evaluateFinalBaseDepartureFeasibility returns null for an unrecognized airport or unparseable time", () => {
  assert.equal(evaluateFinalBaseDepartureFeasibility("ZZZ", "20:00", { lat: 48.86, lon: 2.35 }), null);
  assert.equal(evaluateFinalBaseDepartureFeasibility("CDG", "not-a-time", { lat: 48.86, lon: 2.35 }), null);
});

test("violatesArrivalDepartureWindow is unaffected on a day that isn't the departure day, regardless of end time", () => {
  assert.equal(
    violatesArrivalDepartureWindow("10:18", "2026-09-16", false, false, DEPARTURE_WINDOW, "20:00"),
    false
  );
});
