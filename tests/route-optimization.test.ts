import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateNightsForClusters,
  clusterActivityCandidates,
  computeItineraryTravelMetrics,
  DAY_TRIP_MIN_VALUE_RATIO,
  decideClusterRole,
  detectBacktracking,
  evaluateCluster,
  evaluateDayTripFeasibility,
  evaluateShortStayViability,
  evaluateTransferDetourFeasibility,
  type ActivityCluster,
} from "../src/lib/server/route-optimization";
import type { TripRecommendation } from "../src/lib/trip-workspace";

// Invented geography only — City A/B/C style points, same convention as
// stay-routing.test.ts/stay-activity-center.test.ts.
function buildRecommendation(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? `rec-${Math.random()}`,
    name: overrides.name ?? "Sample Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "",
    shortDescription: overrides.shortDescription ?? "",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: null,
    openingHours: "",
    recommendedTimeOfDay: "any",
    reservationRequired: false,
    mapLink: "",
    imageUrl: "",
    imageQuery: "",
    lat: overrides.lat ?? 1.0,
    lon: overrides.lon ?? 1.0,
    source: "database",
    wikipediaUrl: null,
    website: null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

function cluster(members: TripRecommendation[], center = { lat: 1, lon: 1 }): ActivityCluster {
  return { id: "test-cluster", center, members };
}

const NEUTRAL_PROFILE = { strongPreferences: [], softPreferences: [] };

test("1. clusterActivityCandidates groups nearby real candidates into one cluster", () => {
  const candidates = [
    buildRecommendation({ lat: 1.0, lon: 1.0 }),
    buildRecommendation({ lat: 1.002, lon: 1.0 }),
    buildRecommendation({ lat: 1.0, lon: 1.002 }),
  ];
  const clusters = clusterActivityCandidates(candidates, 25);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 3);
});

test("clusterActivityCandidates keeps genuinely distant candidates in separate clusters", () => {
  const candidates = [buildRecommendation({ lat: 1.0, lon: 1.0 }), buildRecommendation({ lat: 5.0, lon: 5.0 })];
  const clusters = clusterActivityCandidates(candidates, 25);
  assert.equal(clusters.length, 2);
});

// Cluster identity is coordinate-only: the same real place must merge even
// when its candidates carry labels in different languages, and two distant
// places must stay apart even when they happen to share a label.
//
// This exact geometry (not just "two nearby groups") is required to
// genuinely discriminate the fix: clusterActivityCandidates's first pass is
// greedy single-linkage growth, which already re-checks every remaining
// point against its *running* centroid on every growth iteration — so a
// naive "two nearby groups" fixture would already merge under the OLD
// single-pass code too, and the test would pass with or without the new
// merge step. Below, seed A (Hebrew label) sits >25km from BOTH B1 and B2
// individually (so growth never absorbs either into A's cluster), yet once
// B1+B2 merge into their own cluster (English label, 24.1km apart — inside
// the 25km radius), the COMBINED cluster's centroid lands 23.97km from A —
// inside the radius. Only a real agglomerative merge (comparing final
// centroids pairwise, not just each seed's own growth) catches this.
const RADIUS_KM = 25;
const CLUSTER_A_POINT = { lat: 10.0, lon: 10.0 };
const CLUSTER_B_POINT_1 = { lat: 10.108528533960387, lon: 10.218920577481656 };
const CLUSTER_B_POINT_2 = { lat: 9.891471466039613, lon: 10.218920577481656 };

test("clusterActivityCandidates merges the same real place split across language labels", () => {
  const candidates = [
    buildRecommendation({ ...CLUSTER_A_POINT, name: "מוזיאון", location: "ניו יורק" }),
    buildRecommendation({ ...CLUSTER_B_POINT_1, name: "Museum", location: "New York" }),
    buildRecommendation({ ...CLUSTER_B_POINT_2, name: "Park", location: "New York" }),
  ];
  const clusters = clusterActivityCandidates(candidates, RADIUS_KM);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 3);
});

test("clusterActivityCandidates keeps two genuinely distant places apart even when they share a label", () => {
  const candidates = [
    buildRecommendation({ lat: 38.9072, lon: -77.0369, name: "Capitol", location: "Washington" }),
    buildRecommendation({ lat: 47.7511, lon: -120.7401, name: "Trail", location: "Washington" }),
  ];
  const clusters = clusterActivityCandidates(candidates, RADIUS_KM);
  assert.equal(clusters.length, 2);
});

test("1b. a cluster with substantial real content is decided as overnight", () => {
  const members = Array.from({ length: 4 }, () => buildRecommendation({ estimatedDurationMinutes: 90 }));
  const evaluation = evaluateCluster(cluster(members), [], NEUTRAL_PROFILE);
  assert.equal(decideClusterRole(evaluation, 25), "overnight");
});

test("2. a weak cluster far from every other cluster becomes a day trip, not a forced overnight", () => {
  const weakCluster = cluster(
    [buildRecommendation({ estimatedDurationMinutes: 70 }), buildRecommendation({ estimatedDurationMinutes: 70 })],
    { lat: 5, lon: 5 }
  );
  const farNeighbor = cluster([buildRecommendation()], { lat: 1, lon: 1 });
  const evaluation = evaluateCluster(weakCluster, [weakCluster, farNeighbor], NEUTRAL_PROFILE);
  assert.equal(decideClusterRole(evaluation, 25), "day_trip");
});

test("3. a weak cluster near another cluster merges into it instead of standing alone", () => {
  const weakCluster = cluster(
    [buildRecommendation({ estimatedDurationMinutes: 70 }), buildRecommendation({ estimatedDurationMinutes: 70 })],
    { lat: 1.05, lon: 1.05 }
  );
  const nearNeighbor = cluster([buildRecommendation()], { lat: 1, lon: 1 });
  const evaluation = evaluateCluster(weakCluster, [weakCluster, nearNeighbor], NEUTRAL_PROFILE);
  assert.equal(decideClusterRole(evaluation, 25), "merge");
});

test("4. a remote cluster with substantial real content may still get its own overnight stay", () => {
  const members = Array.from({ length: 4 }, () => buildRecommendation({ estimatedDurationMinutes: 90 }));
  const remoteCluster = cluster(members, { lat: 10, lon: 10 });
  const evaluation = evaluateCluster(remoteCluster, [remoteCluster], NEUTRAL_PROFILE);
  assert.equal(decideClusterRole(evaluation, 25), "overnight");
});

test("5. a cluster with verified-unavailable accommodation becomes a day trip instead of a forced overnight", () => {
  const members = Array.from({ length: 4 }, () => buildRecommendation({ estimatedDurationMinutes: 90 }));
  const evaluation = evaluateCluster(cluster(members), [], NEUTRAL_PROFILE);
  assert.equal(evaluation.clusterAccommodationFeasibility, "unknown", "never fabricate a positive feasibility signal");
  assert.equal(decideClusterRole(evaluation, 25, { accommodationVerifiedUnavailable: true }), "day_trip");
});

test("6. fewer hotel changes are reflected directly in hotelChangeCount", () => {
  const days = [{ dayNumber: 1, items: [] }];
  const twoStays = computeItineraryTravelMetrics(days, () => "normal", [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]);
  const threeStays = computeItineraryTravelMetrics(days, () => "normal", [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }]);
  assert.equal(twoStays.hotelChangeCount, 1);
  assert.equal(threeStays.hotelChangeCount, 2);
});

test("7. an unnecessary 1-night stay is judged not worth the hotel change", () => {
  const result = evaluateShortStayViability({
    clusterRequiredTimeMinutes: 60,
    transferMinutesFromPrevious: 90,
    transferMinutesToNext: 90,
  });
  assert.equal(result.worthOvernight, false);
});

test("8. a legitimate 1-night stay (fixed reservation) is preserved regardless of transfer cost", () => {
  const result = evaluateShortStayViability({
    clusterRequiredTimeMinutes: 30,
    transferMinutesFromPrevious: 200,
    transferMinutesToNext: 200,
    isFixedReservation: true,
  });
  assert.equal(result.worthOvernight, true);
});

test("9. nights scale with each cluster's own real content, not evenly by cluster count", () => {
  const nights = allocateNightsForClusters(
    [{ clusterRequiredTimeMinutes: 60 }, { clusterRequiredTimeMinutes: 600 }],
    6
  );
  assert.equal(nights.reduce((sum, n) => sum + n, 0), 6);
  assert.ok(nights[1] > nights[0], "the cluster with far more real content should get more nights");
  assert.ok(nights.every((n) => n >= 1), "every cluster keeps at least 1 night");
});

test("12. a route that doubles back on itself scores real backtracking", () => {
  const A = { lat: 0, lon: 0 };
  const B = { lat: 0, lon: 1 };
  const C = { lat: 0, lon: 2 };
  const backtrackingRoute = detectBacktracking([A, C, A, B, C]);
  assert.ok(backtrackingRoute > 0);
});

test("13. a coherent forward route scores zero backtracking", () => {
  const A = { lat: 0, lon: 0 };
  const B = { lat: 0, lon: 1 };
  const C = { lat: 0, lon: 2 };
  assert.equal(detectBacktracking([A, B, C]), 0);
});

test("14. computeItineraryTravelMetrics sums real travelMinutes correctly and separates normal/day-trip segments", () => {
  const days = [
    { dayNumber: 1, items: [{ travelMinutes: 20 }, { travelMinutes: 30 }] },
    { dayNumber: 2, items: [{ travelMinutes: 150 }] },
  ];
  const metrics = computeItineraryTravelMetrics(
    days,
    (day) => (day.dayNumber === 2 ? "day_trip" : "normal"),
    [{ lat: 1, lon: 1 }]
  );
  assert.equal(metrics.totalGroundTravelMinutes, 200);
  assert.equal(metrics.maxNormalDayTravelSegment, 30);
  assert.equal(metrics.maxDayTripTravelSegment, 150);
  assert.equal(metrics.averageGroundTravelMinutesPerDay, 100);
});

// Day-trip round-trip feasibility (evaluateDayTripFeasibility) — pure
// arithmetic over already-known quantities, tested directly with plain
// numbers (no coordinates needed here; computeDayTripClusterFeasibility,
// the real coordinate-driven caller, is covered separately via
// buildDeterministicTripFrame's own integration test).

test("evaluateDayTripFeasibility: ample time budget and a nearby cluster is accepted", () => {
  const result = evaluateDayTripFeasibility({
    outboundTravelMinutes: 30,
    returnTravelMinutes: 30,
    internalTravelMinutes: 10,
    visitMinutes: 180,
    usableMinutes: 600,
  });
  assert.equal(result.feasible, true);
  assert.equal(result.reason, "ok");
  assert.equal(result.totalMinutes, 250);
});

test("evaluateDayTripFeasibility: round-trip travel alone dominates the day → rejected on low value ratio", () => {
  const result = evaluateDayTripFeasibility({
    outboundTravelMinutes: 200,
    returnTravelMinutes: 200,
    internalTravelMinutes: 10,
    visitMinutes: 90,
    usableMinutes: 600,
  });
  assert.equal(result.totalMinutes <= result.usableMinutes, true, "must fit the raw time budget");
  assert.equal(result.feasible, false);
  assert.equal(result.reason, "low_value_ratio");
});

test("evaluateDayTripFeasibility: asymmetric outbound/return legs are computed independently, never assumed equal", () => {
  const result = evaluateDayTripFeasibility({
    outboundTravelMinutes: 60,
    returnTravelMinutes: 120,
    internalTravelMinutes: 0,
    visitMinutes: 200,
    usableMinutes: 600,
  });
  assert.equal(result.outboundTravelMinutes, 60);
  assert.equal(result.returnTravelMinutes, 120);
  assert.notEqual(result.outboundTravelMinutes, result.returnTravelMinutes);
  assert.equal(result.totalMinutes, 60 + 120 + 0 + 200);
  assert.equal(result.feasible, true);
});

test("evaluateDayTripFeasibility: fits the raw time budget but fails the value-ratio threshold → rejected with a clear reason, not a silent drop", () => {
  const result = evaluateDayTripFeasibility({
    outboundTravelMinutes: 100,
    returnTravelMinutes: 100,
    internalTravelMinutes: 50,
    visitMinutes: 100,
    usableMinutes: 500,
  });
  assert.equal(result.totalMinutes, 350);
  assert.equal(result.totalMinutes <= result.usableMinutes, true, "must fit the raw time budget — this is not a budget failure");
  assert.equal(result.valueRatio < DAY_TRIP_MIN_VALUE_RATIO, true);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, "low_value_ratio", "the reason must distinguish this from exceeds_time_budget, not just report false");
});

// Transfer-day detour feasibility (evaluateTransferDetourFeasibility) —
// pure arithmetic, tested directly with plain numbers. The "near
// origin"/"near destination" bypass and the real coordinate-driven caller
// are covered separately via enforceNormalDayLocality's own integration
// tests (country-itinerary-generation.test.ts), since that bypass is a
// property of the integration, not this function.

test("evaluateTransferDetourFeasibility: an activity essentially on the direct route (detour ≈ 0) is accepted", () => {
  const result = evaluateTransferDetourFeasibility({
    outboundToCandidateMinutes: 150,
    candidateToDestinationMinutes: 150,
    directTransferMinutes: 296, // ~ outbound + candidateToDestination, so detour is ~0
    visitMinutes: 90,
    availableSlackMinutes: 300,
    usedSlackMinutes: 0,
  });
  assert.equal(result.detourMinutes, 4);
  assert.equal(result.feasible, true);
  assert.equal(result.reason, "ok");
});

test("evaluateTransferDetourFeasibility: a large detour that doesn't fit the slack is rejected", () => {
  const result = evaluateTransferDetourFeasibility({
    outboundToCandidateMinutes: 400,
    candidateToDestinationMinutes: 400,
    directTransferMinutes: 296,
    visitMinutes: 60,
    availableSlackMinutes: 300,
    usedSlackMinutes: 0,
  });
  assert.equal(result.detourMinutes, 504);
  assert.equal(result.feasible, false);
  assert.equal(result.reason, "exceeds_available_slack");
});

test("evaluateTransferDetourFeasibility: combining with an already-used slack correctly rejects a candidate that would fit alone", () => {
  // 200 minutes of detour+visit alone would fit within a 300-minute slack —
  // but not once 200 minutes are already committed to an earlier detour
  // activity the same day.
  const alone = evaluateTransferDetourFeasibility({
    outboundToCandidateMinutes: 100,
    candidateToDestinationMinutes: 100,
    directTransferMinutes: 200,
    visitMinutes: 200,
    availableSlackMinutes: 300,
    usedSlackMinutes: 0,
  });
  assert.equal(alone.feasible, true, "sanity: this candidate is fine on its own");

  const combined = evaluateTransferDetourFeasibility({
    outboundToCandidateMinutes: 100,
    candidateToDestinationMinutes: 100,
    directTransferMinutes: 200,
    visitMinutes: 200,
    availableSlackMinutes: 300,
    usedSlackMinutes: alone.totalMinutes,
  });
  assert.equal(combined.feasible, false);
  assert.equal(combined.reason, "exceeds_available_slack");
});
