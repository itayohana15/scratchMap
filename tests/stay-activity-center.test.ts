import assert from "node:assert/strict";
import test from "node:test";

import { computeStayActivityCenter, isMeaningfulStayActivityItem } from "../src/lib/trip-workspace";
import { rankHotels, type HotelCandidate } from "../src/lib/hotels";
import { buildHotelSelectionPatch, deriveHotelLocationQualityLabel } from "../src/lib/hotel-ui-helpers";
import { recalculateStayRouting, resolveStayAnchorCoordinates } from "../src/lib/stay-routing";

// Invented geography only, same convention as stay-routing.test.ts — City A
// is a tight main cluster around {1,1}; City B ("Cluster Y"/day-trip/other
// stay) sits far away near {2,2}/{3,3}. Only the real airport code (CDG)
// carries real coordinates, used solely for the underlying distance math.
const CLUSTER_MAIN = [
  { lat: 1.0, lon: 1.0 },
  { lat: 1.005, lon: 1.0 },
  { lat: 1.0, lon: 1.005 },
  { lat: 1.005, lon: 1.005 },
  { lat: 0.995, lon: 1.0 },
];
const FAR_OUTLIER = { lat: 2.0, lon: 2.0 }; // ~157km from CLUSTER_MAIN — a different region entirely
const AIRPORT_A = "CDG";

function buildHotel(overrides: Partial<HotelCandidate> = {}): HotelCandidate {
  return {
    name: overrides.name ?? "Sample Hotel",
    lat: overrides.lat ?? 1.0,
    lon: overrides.lon ?? 1.0,
    openingHours: overrides.openingHours ?? null,
    priceConfidence: "unavailable",
    ratingConfidence: "unavailable",
  };
}

// 1. hotel near activity medoid beats hotel at far edge of same city
test("1. rankHotels ranks a hotel near the activity medoid above one at the far edge of the same city", () => {
  const nearMedoid = buildHotel({ name: "Near Medoid", lat: 1.001, lon: 1.001 });
  const farEdge = buildHotel({ name: "Far Edge", lat: 1.06, lon: 1.06 });
  const ranked = rankHotels([farEdge, nearMedoid], CLUSTER_MAIN, null);
  assert.equal(ranked[0]?.name, "Near Medoid");
  assert.ok(ranked[0]!.locationScore > ranked[1]!.locationScore);
});

// 2. one outlier activity does not shift hotel center
test("2. computeStayActivityCenter is not dragged off the main cluster by a single distant outlier", () => {
  const result = computeStayActivityCenter([...CLUSTER_MAIN, FAR_OUTLIER], 25);
  assert.ok(result.center != null);
  // Center must stay near the tight 5-point cluster, not be pulled toward
  // the outlier — real distance to the cluster's own first point stays small.
  const distanceFromClusterKm = haversine(result.center!, CLUSTER_MAIN[0]);
  assert.ok(distanceFromClusterKm < 2, `expected center near the main cluster, got ${distanceFromClusterKm}km away`);
  assert.equal(result.primaryClusterSize, 5);
  assert.equal(result.totalConsideredCount, 6);
  assert.equal(result.structureConcern, false);
});

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const earthRadiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

// 3. hotel ranking uses all stay days, not just day 1
test("3. rankHotels ranking flips once the whole stay's days are used instead of only day 1", () => {
  const day1Only = [{ lat: 1.1, lon: 1.1 }];
  const fullStay = [{ lat: 1.1, lon: 1.1 }, { lat: 0.9, lon: 0.9 }, { lat: 0.905, lon: 0.905 }, { lat: 0.9, lon: 0.905 }];
  const hotelEast = buildHotel({ name: "East Hotel", lat: 1.1, lon: 1.1 });
  const hotelWest = buildHotel({ name: "West Hotel", lat: 0.9, lon: 0.9 });

  const day1Ranking = rankHotels([hotelWest, hotelEast], day1Only, null);
  assert.equal(day1Ranking[0]?.name, "East Hotel", "day-1-only should favor the day-1 cluster");

  const fullStayRanking = rankHotels([hotelWest, hotelEast], fullStay, null);
  assert.equal(fullStayRanking[0]?.name, "West Hotel", "using every day should favor the majority (days 2-3) cluster");
});

// 4. multi-cluster nearby stay chooses efficient midpoint/medoid
test("4. two nearby sub-clusters do not trigger a structure concern and share one efficient center", () => {
  const subclusterOne = [{ lat: 1.0, lon: 1.0 }, { lat: 1.002, lon: 1.0 }, { lat: 1.0, lon: 1.002 }];
  const subclusterTwo = [{ lat: 1.03, lon: 1.03 }, { lat: 1.032, lon: 1.03 }, { lat: 1.03, lon: 1.032 }]; // ~4.7km away
  const result = computeStayActivityCenter([...subclusterOne, ...subclusterTwo], 25);
  assert.equal(result.structureConcern, false);
  assert.equal(result.primaryClusterSize, 6);
});

// 5. distant clusters trigger a stay-structure concern instead of a midpoint hotel
test("5. two genuinely distant sub-clusters trigger a structure concern rather than a midpoint center", () => {
  const subclusterOne = [{ lat: 1.0, lon: 1.0 }, { lat: 1.002, lon: 1.0 }, { lat: 1.0, lon: 1.002 }];
  const subclusterTwo = [FAR_OUTLIER, { lat: 2.002, lon: 2.0 }, { lat: 2.0, lon: 2.002 }]; // ~157km away
  const result = computeStayActivityCenter([...subclusterOne, ...subclusterTwo], 25);
  assert.equal(result.structureConcern, true);
  assert.equal(result.primaryClusterSize, 3);
});

// 6 & 7. compact vs. large/sparse destinations apply different locality expectations for the SAME real number
test("6-7. deriveHotelLocationQualityLabel applies a tighter bar for a compact destination than a large/sparse one", () => {
  const compactLabel = deriveHotelLocationQualityLabel(20, 60); // compact tier's own normalDayTravelBudgetMinutes
  const sparseLabel = deriveHotelLocationQualityLabel(20, 160); // large_sparse tier's own budget
  assert.ok(compactLabel.includes("טוב"), compactLabel);
  assert.ok(sparseLabel.includes("מצוין"), sparseLabel);
});

// 8. selected hotel's activity travel is recalculated against the real, whole-stay cluster list
test("8. buildHotelSelectionPatch finds no mismatch once the whole stay's real activities are considered, not just day 1", () => {
  const fullStay = [{ lat: 1.1, lon: 1.1 }, { lat: 0.9, lon: 0.9 }, { lat: 0.905, lon: 0.905 }, { lat: 0.9, lon: 0.905 }];
  const patch = buildHotelSelectionPatch({ name: "West Hotel", lat: 0.9, lon: 0.9 }, fullStay, 25);
  assert.equal(patch.accommodationBaseMismatch, null);
});

// 9. a poorly located user-selected hotel is still honored (never silently replaced)
test("9. buildHotelSelectionPatch keeps a poorly located hotel selection exactly as chosen", () => {
  const patch = buildHotelSelectionPatch({ name: "Poor Hotel", lat: FAR_OUTLIER.lat, lon: FAR_OUTLIER.lon }, CLUSTER_MAIN, 25);
  assert.equal(patch.accommodation, "Poor Hotel");
  assert.equal(patch.accommodationLat, FAR_OUTLIER.lat);
  assert.equal(patch.accommodationLon, FAR_OUTLIER.lon);
  assert.ok(patch.accommodationBaseMismatch != null, "a genuinely poor location must still produce a warning");
});

// 10. the mismatch warning threshold itself follows the destination's own mobility profile
test("10. a hotel ~50km away warns under a compact profile's threshold but not under a large/sparse one", () => {
  const midDistanceHotel = { name: "Mid-Distance Hotel", lat: 1.318, lon: 1.318 }; // ~50km from CLUSTER_MAIN
  const compactPatch = buildHotelSelectionPatch(midDistanceHotel, CLUSTER_MAIN, 25); // compact tier's radius
  const sparsePatch = buildHotelSelectionPatch(midDistanceHotel, CLUSTER_MAIN, 120); // large_sparse tier's radius
  assert.ok(compactPatch.accommodationBaseMismatch != null);
  assert.equal(sparsePatch.accommodationBaseMismatch, null);
});

// 11. first-stay hotel affects the real airport arrival transfer
test("11. the selected first-stay hotel becomes the real anchor used for the arrival transfer", () => {
  const activityCenter = computeStayActivityCenter(CLUSTER_MAIN, 25).center;
  const hotelAnchor = resolveStayAnchorCoordinates({ hotelCoordinates: { lat: 1.001, lon: 1.001 }, activityCentroid: activityCenter });
  const routing = recalculateStayRouting({
    stayAnchor: hotelAnchor,
    isFirstStay: true,
    isFinalStay: false,
    arrivalAirportIata: AIRPORT_A,
  });
  assert.ok(routing.arrivalTransferMinutes != null && routing.arrivalTransferMinutes > 0);
});

// 12. final-stay hotel affects the real airport departure transfer
test("12. the selected final-stay hotel becomes the real anchor used for the departure transfer", () => {
  const activityCenter = computeStayActivityCenter(CLUSTER_MAIN, 25).center;
  const hotelAnchor = resolveStayAnchorCoordinates({ hotelCoordinates: { lat: 1.001, lon: 1.001 }, activityCentroid: activityCenter });
  const routing = recalculateStayRouting({
    stayAnchor: hotelAnchor,
    isFirstStay: false,
    isFinalStay: true,
    departureAirportIata: AIRPORT_A,
  });
  assert.ok(routing.departureTransferMinutes != null && routing.departureTransferMinutes > 0);
});

// 13. hotel affects the incoming stay transition
test("13. changing the selected hotel changes the real inbound stay transition", () => {
  const previousStayAnchor = { lat: 5, lon: 5 };
  const routingNear = recalculateStayRouting({
    stayAnchor: { lat: 1.0, lon: 1.0 },
    previousStayAnchor,
    isFirstStay: false,
    isFinalStay: false,
  });
  const routingFar = recalculateStayRouting({
    stayAnchor: FAR_OUTLIER,
    previousStayAnchor,
    isFirstStay: false,
    isFinalStay: false,
  });
  assert.ok(routingNear.inboundTransitionMinutes != null && routingFar.inboundTransitionMinutes != null);
  assert.notEqual(routingNear.inboundTransitionMinutes, routingFar.inboundTransitionMinutes);
});

// 14. hotel affects the outgoing stay transition
test("14. changing the selected hotel changes the real outbound stay transition", () => {
  const nextStayAnchor = { lat: 5, lon: 5 };
  const routingNear = recalculateStayRouting({
    stayAnchor: { lat: 1.0, lon: 1.0 },
    nextStayAnchor,
    isFirstStay: false,
    isFinalStay: false,
  });
  const routingFar = recalculateStayRouting({
    stayAnchor: FAR_OUTLIER,
    nextStayAnchor,
    isFirstStay: false,
    isFinalStay: false,
  });
  assert.ok(routingNear.outboundTransitionMinutes != null && routingFar.outboundTransitionMinutes != null);
  assert.notEqual(routingNear.outboundTransitionMinutes, routingFar.outboundTransitionMinutes);
});

// 15. unrelated stays remain unchanged
test("15. one stay's activity center never depends on another stay's own points", () => {
  const stayAResultBefore = computeStayActivityCenter(CLUSTER_MAIN, 25);
  // Computing an entirely unrelated stay's center in between must not leak any state.
  computeStayActivityCenter([FAR_OUTLIER, { lat: 2.002, lon: 2.0 }, { lat: 2.0, lon: 2.002 }], 25);
  const stayAResultAfter = computeStayActivityCenter(CLUSTER_MAIN, 25);
  assert.deepEqual(stayAResultBefore, stayAResultAfter);
});

// 16. an activity reassigned to another stay is removed from the previous stay's hotel-center math
test("16. removing a reassigned activity tightens the previous stay's own activity center", () => {
  const before = computeStayActivityCenter([...CLUSTER_MAIN, FAR_OUTLIER], 25); // outlier still (mis)counted
  const after = computeStayActivityCenter(CLUSTER_MAIN, 25); // outlier reassigned away
  assert.equal(before.totalConsideredCount, 6);
  assert.equal(after.totalConsideredCount, 5);
  assert.ok(after.spreadKm <= before.spreadKm);
});

// 17. a day-trip destination does not pull the overnight hotel toward the excursion cluster
test("17. a minority day-trip cluster is excluded from the center instead of pulling the hotel toward it", () => {
  const homeBase = [
    { lat: 1.0, lon: 1.0 },
    { lat: 1.002, lon: 1.0 },
    { lat: 1.0, lon: 1.002 },
    { lat: 1.002, lon: 1.002 },
    { lat: 0.998, lon: 1.0 },
    { lat: 1.0, lon: 0.998 },
  ];
  const dayTripDestination = [{ lat: 3.0, lon: 3.0 }, { lat: 3.002, lon: 3.0 }]; // a genuine day trip, far away
  const result = computeStayActivityCenter([...homeBase, ...dayTripDestination], 25);
  assert.equal(result.primaryClusterSize, 6, "the day trip's own destination must not join the overnight cluster");
  assert.equal(result.structureConcern, false, "a normal minority day trip is not itself a bad stay structure");
  const distanceFromHomeKm = haversine(result.center!, homeBase[0]);
  assert.ok(distanceFromHomeKm < 2, `expected the center to stay at the home base, got ${distanceFromHomeKm}km away`);
});

// Bonus: the meaningful-activity filter itself (transportation/practical/placeholder exclusion)
test("isMeaningfulStayActivityItem excludes transportation, practical, and coordinate-less placeholder items", () => {
  assert.equal(isMeaningfulStayActivityItem({ category: "transportation", lat: 1, lon: 1 }), false);
  assert.equal(isMeaningfulStayActivityItem({ category: "practical", lat: 1, lon: 1 }), false);
  assert.equal(isMeaningfulStayActivityItem({ category: "attraction", lat: null, lon: null }), false);
  assert.equal(isMeaningfulStayActivityItem({ category: "attraction", lat: 1, lon: 1 }), true);
});
