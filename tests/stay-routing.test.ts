import assert from "node:assert/strict";
import test from "node:test";

import { recalculateStayRouting, resolveStayAnchorCoordinates } from "../src/lib/stay-routing";

// Invented locations per the requested synthetic tests — City A/B/C,
// Airport A/C. Only real airport codes (CDG) carry real coordinates for
// the underlying distance/time math; the "cities" themselves are generic
// coordinate points, not real places.
const HOTEL_A = { lat: 48.86, lon: 2.35 }; // "Hotel A" — a real selected hotel, central Paris-ish
const CITY_A_CENTROID = { lat: 48.9, lon: 2.4 }; // City A's activity centroid, close to Hotel A but not identical
const CITY_B_CENTROID = { lat: 45.75, lon: 4.85 }; // City B — mid-distance
const CITY_C_CENTROID = { lat: 10, lon: 10 }; // City C — extreme distance
const AIRPORT_A = "CDG";

test("resolveStayAnchorCoordinates: a real selected hotel wins over everything else", () => {
  const anchor = resolveStayAnchorCoordinates({
    hotelCoordinates: HOTEL_A,
    activityCentroid: CITY_A_CENTROID,
    areaCentroid: CITY_B_CENTROID,
  });
  assert.deepEqual(anchor, HOTEL_A);
});

test("resolveStayAnchorCoordinates: falls back to activity centroid when no hotel is selected", () => {
  const anchor = resolveStayAnchorCoordinates({ hotelCoordinates: null, activityCentroid: CITY_A_CENTROID, areaCentroid: CITY_B_CENTROID });
  assert.deepEqual(anchor, CITY_A_CENTROID);
});

test("resolveStayAnchorCoordinates: falls back to area centroid when neither hotel nor activity centroid exist", () => {
  const anchor = resolveStayAnchorCoordinates({ hotelCoordinates: null, activityCentroid: null, areaCentroid: CITY_B_CENTROID });
  assert.deepEqual(anchor, CITY_B_CENTROID);
});

test("resolveStayAnchorCoordinates: null when nothing at all is known", () => {
  assert.equal(resolveStayAnchorCoordinates({}), null);
});

// Section C1/C2/C3/E — hotel used as stay anchor changes both adjacent transitions.
test("recalculateStayRouting: selected hotel is used as the stay anchor for both transitions", () => {
  const withCentroid = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    previousStayAnchor: CITY_B_CENTROID,
    nextStayAnchor: CITY_C_CENTROID,
    isFirstStay: false,
    isFinalStay: false,
  });
  const withHotel = recalculateStayRouting({
    stayAnchor: HOTEL_A,
    previousStayAnchor: CITY_B_CENTROID,
    nextStayAnchor: CITY_C_CENTROID,
    isFirstStay: false,
    isFinalStay: false,
  });
  assert.notEqual(withCentroid.inboundTransitionMinutes, withHotel.inboundTransitionMinutes);
  assert.notEqual(withCentroid.outboundTransitionMinutes, withHotel.outboundTransitionMinutes);
});

test("recalculateStayRouting: inbound transition changes when the hotel selection changes the anchor", () => {
  const before = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    previousStayAnchor: CITY_B_CENTROID,
    isFirstStay: false,
    isFinalStay: true,
  });
  const after = recalculateStayRouting({
    stayAnchor: HOTEL_A,
    previousStayAnchor: CITY_B_CENTROID,
    isFirstStay: false,
    isFinalStay: true,
  });
  assert.ok(before.inboundTransitionMinutes != null && after.inboundTransitionMinutes != null);
  assert.notEqual(before.inboundTransitionMinutes, after.inboundTransitionMinutes);
});

test("recalculateStayRouting: outbound transition changes when the hotel selection changes the anchor", () => {
  const before = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    nextStayAnchor: CITY_B_CENTROID,
    isFirstStay: true,
    isFinalStay: false,
  });
  const after = recalculateStayRouting({
    stayAnchor: HOTEL_A,
    nextStayAnchor: CITY_B_CENTROID,
    isFirstStay: true,
    isFinalStay: false,
  });
  assert.ok(before.outboundTransitionMinutes != null && after.outboundTransitionMinutes != null);
  assert.notEqual(before.outboundTransitionMinutes, after.outboundTransitionMinutes);
});

// Section C4 — first-stay hotel changes the arrival transfer.
test("recalculateStayRouting: a first-stay hotel close to the arrival airport has no arrival conflict", () => {
  const result = recalculateStayRouting({
    stayAnchor: HOTEL_A,
    isFirstStay: true,
    isFinalStay: false,
    arrivalAirportIata: AIRPORT_A,
  });
  assert.ok(result.arrivalTransferMinutes != null);
  assert.equal(result.hotelCausedAirportConflict, null);
});

test("recalculateStayRouting: a first-stay hotel far from the arrival airport produces a real arrival transfer conflict", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_C_CENTROID,
    isFirstStay: true,
    isFinalStay: false,
    arrivalAirportIata: AIRPORT_A,
  });
  assert.ok(result.hotelCausedAirportConflict != null);
  assert.equal(result.hotelCausedAirportConflict?.direction, "arrival");
});

// Section C5/D/F — final-stay hotel changes departure feasibility, real time budget.
test("recalculateStayRouting: a distant-but-feasible final-stay hotel on a late flight is not flagged as a conflict", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_B_CENTROID, // mid-distance from CDG
    isFirstStay: false,
    isFinalStay: true,
    departureAirportIata: AIRPORT_A,
    departureTime: "20:00",
  });
  assert.ok(result.departureTransferMinutes != null);
  assert.equal(result.hotelCausedAirportConflict, null, "a late flight tolerates this distance — quality note at most, not a hard conflict");
});

test("recalculateStayRouting: the SAME hotel becomes a real departure conflict for an early flight", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_B_CENTROID,
    isFirstStay: false,
    isFinalStay: true,
    departureAirportIata: AIRPORT_A,
    departureTime: "07:00",
  });
  assert.ok(result.hotelCausedAirportConflict != null);
  assert.equal(result.hotelCausedAirportConflict?.direction, "departure");
});

test("recalculateStayRouting: user selection is never overridden by a conflict — the caller still receives the real numbers to surface, not a rejection", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_C_CENTROID,
    isFirstStay: false,
    isFinalStay: true,
    departureAirportIata: AIRPORT_A,
    departureTime: "07:00",
  });
  // The function only ever reports facts — it has no ability to reject or
  // replace anything, by construction (no hotel field in its own return).
  assert.ok(result.hotelCausedAirportConflict != null);
  assert.ok(result.departureTransferMinutes != null);
});

// Section C6 — only the relevant stay's fields are computed; a middle stay
// with both neighbors gets both transitions and no airport fields at all.
test("recalculateStayRouting: a middle stay (not first, not final) never computes airport transfers", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    previousStayAnchor: CITY_B_CENTROID,
    nextStayAnchor: CITY_C_CENTROID,
    isFirstStay: false,
    isFinalStay: false,
    arrivalAirportIata: AIRPORT_A,
    departureAirportIata: AIRPORT_A,
  });
  assert.equal(result.arrivalTransferMinutes, null);
  assert.equal(result.departureTransferMinutes, null);
  assert.ok(result.inboundTransitionMinutes != null);
  assert.ok(result.outboundTransitionMinutes != null);
});

test("recalculateStayRouting: a first stay never computes an inbound transition (nothing comes before it)", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    previousStayAnchor: CITY_B_CENTROID, // should be ignored — isFirstStay is true
    nextStayAnchor: CITY_C_CENTROID,
    isFirstStay: true,
    isFinalStay: false,
  });
  assert.equal(result.inboundTransitionMinutes, null);
  assert.ok(result.outboundTransitionMinutes != null);
});

test("recalculateStayRouting: no hotel coordinates at all -> everything gracefully null, no crash", () => {
  const result = recalculateStayRouting({ stayAnchor: null, isFirstStay: true, isFinalStay: true, arrivalAirportIata: AIRPORT_A, departureAirportIata: AIRPORT_A });
  assert.equal(result.arrivalTransferMinutes, null);
  assert.equal(result.departureTransferMinutes, null);
  assert.equal(result.hotelCausedAirportConflict, null);
  assert.equal(result.hotelCausedTransitionConflict, null);
});

// Section A4-adjacent: an extremely long inbound/outbound transition is
// flagged as a real structural conflict, not silently accepted.
test("recalculateStayRouting: an extremely long transition (a hotel effectively in a different region) is flagged as a transition conflict", () => {
  const result = recalculateStayRouting({
    stayAnchor: CITY_A_CENTROID,
    previousStayAnchor: CITY_C_CENTROID,
    isFirstStay: false,
    isFinalStay: true,
  });
  assert.ok(result.hotelCausedTransitionConflict != null);
  assert.equal(result.hotelCausedTransitionConflict?.direction, "inbound");
});
