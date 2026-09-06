import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHotelSelectionPatch,
  isHotelExplicitlySelected,
  pickHotelComparisonWinners,
  toggleHotelComparisonSelection,
} from "../src/lib/hotel-ui-helpers";
import type { RankedHotel } from "../src/lib/hotels";

function buildRanked(overrides: Partial<RankedHotel> = {}): RankedHotel {
  return {
    name: overrides.name ?? "Sample Hotel",
    lat: overrides.lat ?? 35.68,
    lon: overrides.lon ?? 139.76,
    openingHours: overrides.openingHours ?? null,
    priceConfidence: "unavailable",
    ratingConfidence: "unavailable",
    averageActivityTravelMinutes: overrides.averageActivityTravelMinutes ?? null,
    totalActivityTravelMinutes: overrides.totalActivityTravelMinutes ?? null,
    maxActivityTravelMinutes: overrides.maxActivityTravelMinutes ?? null,
    airportTravelMinutes: overrides.airportTravelMinutes ?? null,
    transferTravelMinutes: overrides.transferTravelMinutes ?? null,
    locationScore: overrides.locationScore ?? 50,
  };
}

test("isHotelExplicitlySelected is true once real coordinates are set", () => {
  assert.equal(isHotelExplicitlySelected({ accommodationLat: 35.68, accommodationLon: 139.76 }), true);
});

test("isHotelExplicitlySelected is false for a generic placeholder with no coordinates", () => {
  assert.equal(isHotelExplicitlySelected({ accommodationLat: null, accommodationLon: null }), false);
});

test("pickHotelComparisonWinners picks the higher locationScore and lower travel times", () => {
  const better = buildRanked({
    name: "Better",
    locationScore: 90,
    averageActivityTravelMinutes: 8,
    airportTravelMinutes: 25,
  });
  const worse = buildRanked({
    name: "Worse",
    locationScore: 60,
    averageActivityTravelMinutes: 20,
    airportTravelMinutes: 40,
  });

  const winners = pickHotelComparisonWinners([worse, better]);
  assert.equal(winners.locationScoreWinner, 1);
  assert.equal(winners.activityTravelWinner, 1);
  assert.equal(winners.airportTravelWinner, 1);
});

test("pickHotelComparisonWinners never picks a winner with fewer than two hotels", () => {
  const winners = pickHotelComparisonWinners([buildRanked({ locationScore: 90 })]);
  assert.equal(winners.locationScoreWinner, null);
  assert.equal(winners.activityTravelWinner, null);
  assert.equal(winners.airportTravelWinner, null);
});

test("pickHotelComparisonWinners never picks a winner for a metric no hotel actually has", () => {
  const a = buildRanked({ name: "A", averageActivityTravelMinutes: null });
  const b = buildRanked({ name: "B", averageActivityTravelMinutes: null });
  const winners = pickHotelComparisonWinners([a, b]);
  assert.equal(winners.activityTravelWinner, null);
});

test("pickHotelComparisonWinners still resolves the metrics it does know even when one metric is entirely unknown", () => {
  const a = buildRanked({ name: "A", locationScore: 70, averageActivityTravelMinutes: null });
  const b = buildRanked({ name: "B", locationScore: 85, averageActivityTravelMinutes: null });
  const winners = pickHotelComparisonWinners([a, b]);
  assert.equal(winners.locationScoreWinner, 1);
  assert.equal(winners.activityTravelWinner, null);
});

// Spec item 34: selecting a hotel is a pure data patch, never a
// regeneration call — this is the exact patch every day in the stay gets.
// Spec item 7/21: comparison is capped at 3 hotels.
test("toggleHotelComparisonSelection never grows the selection past 3", () => {
  let selection = new Set(["A", "B", "C"]);
  selection = toggleHotelComparisonSelection(selection, "D", true);
  assert.equal(selection.size, 3);
  assert.equal(selection.has("D"), false);
});

test("toggleHotelComparisonSelection allows unchecking even when already at the cap", () => {
  let selection = new Set(["A", "B", "C"]);
  selection = toggleHotelComparisonSelection(selection, "B", false);
  assert.equal(selection.size, 2);
  assert.equal(selection.has("B"), false);
});

test("toggleHotelComparisonSelection adds a hotel normally under the cap", () => {
  const selection = toggleHotelComparisonSelection(new Set(["A"]), "B", true);
  assert.deepEqual([...selection].sort(), ["A", "B"]);
});

test("buildHotelSelectionPatch sets accommodation name, coordinates, and a real map link", () => {
  const patch = buildHotelSelectionPatch({ name: "Park Hyatt Tokyo", lat: 35.6852, lon: 139.6906 });
  assert.equal(patch.accommodation, "Park Hyatt Tokyo");
  assert.equal(patch.accommodationLat, 35.6852);
  assert.equal(patch.accommodationLon, 139.6906);
  assert.ok(patch.accommodationMapLink.includes("35.6852"));
  assert.ok(patch.accommodationMapLink.includes("139.6906"));
});

// Section F2/F3/G: the live hotel-selection flow now runs
// detectHotelBaseMismatch against the stay's own activity clusters.
test("buildHotelSelectionPatch: a hotel inside the stay's activity cluster carries no mismatch warning", () => {
  const patch = buildHotelSelectionPatch(
    { name: "Central Hotel", lat: 35.6852, lon: 139.6906 },
    [{ lat: 35.69, lon: 139.69 }]
  );
  assert.equal(patch.accommodationBaseMismatch, null);
});

test("buildHotelSelectionPatch: the selection is always honored even when it's geographically distant, with a real warning attached instead of being blocked", () => {
  const patch = buildHotelSelectionPatch(
    { name: "Distant Hotel", lat: 35.0157, lon: 135.7681 },
    [{ lat: 35.6852, lon: 139.6906 }]
  );
  // The user's choice is never overridden — the hotel is still selected.
  assert.equal(patch.accommodation, "Distant Hotel");
  assert.equal(patch.accommodationLat, 35.0157);
  // But the mismatch is real and visible, not silently dropped.
  assert.ok(patch.accommodationBaseMismatch != null);
  assert.ok(patch.accommodationBaseMismatch!.nearestClusterKm > patch.accommodationBaseMismatch!.thresholdKm);
});

test("buildHotelSelectionPatch carries no mismatch warning when no activity cluster is known yet", () => {
  const patch = buildHotelSelectionPatch({ name: "Some Hotel", lat: 35.0157, lon: 135.7681 });
  assert.equal(patch.accommodationBaseMismatch, null);
});
