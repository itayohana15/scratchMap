import assert from "node:assert/strict";
import test from "node:test";

import { rankFoodPlaces, type FoodCandidate } from "../src/lib/food";

function buildCandidate(overrides: Partial<FoodCandidate> = {}): FoodCandidate {
  return {
    name: overrides.name ?? "Sample Restaurant",
    category: overrides.category ?? "restaurant",
    lat: overrides.lat ?? 35.6895,
    lon: overrides.lon ?? 139.6917,
    openingHours: overrides.openingHours ?? null,
    priceConfidence: "unavailable",
    ratingConfidence: "unavailable",
  };
}

test("rankFoodPlaces ranks a place closer to the day's route anchor above a farther one", () => {
  const routeAnchor = { lat: 35.6895, lon: 139.6917 };
  const near = buildCandidate({ name: "Near Cafe", lat: 35.69, lon: 139.692 });
  const far = buildCandidate({ name: "Far Cafe", lat: 35.9, lon: 139.9 });

  const ranked = rankFoodPlaces([far, near], routeAnchor, "lunch");
  assert.equal(ranked[0]?.name, "Near Cafe");
  assert.ok((ranked[0]?.travelMinutesFromRoute ?? Infinity) < (ranked[1]?.travelMinutesFromRoute ?? 0));
});

test("rankFoodPlaces never fabricates price or rating — always marked unavailable", () => {
  const [ranked] = rankFoodPlaces([buildCandidate()], { lat: 35.6895, lon: 139.6917 }, "dinner");
  assert.equal(ranked.priceConfidence, "unavailable");
  assert.equal(ranked.ratingConfidence, "unavailable");
});

test("rankFoodPlaces tags every result with the requested meal slot", () => {
  const ranked = rankFoodPlaces([buildCandidate(), buildCandidate({ name: "Other" })], { lat: 35.6895, lon: 139.6917 }, "dinner");
  assert.ok(ranked.every((place) => place.recommendedSlot === "dinner"));
});

test("rankFoodPlaces returns null travel time (never a fabricated one) when there is no real route anchor", () => {
  const [ranked] = rankFoodPlaces([buildCandidate()], null, "lunch");
  assert.equal(ranked.travelMinutesFromRoute, null);
});

// 25/32. a restaurant confidently closed at the target meal's usual time is rejected outright, never merely down-ranked.
test("rankFoodPlaces rejects a restaurant confidently closed at the target meal slot's usual time", () => {
  const openForLunch = buildCandidate({ name: "Open For Lunch", openingHours: "11:00-15:00" });
  const closedForLunch = buildCandidate({ name: "Only Open Evenings", openingHours: "18:00-23:00" });
  const ranked = rankFoodPlaces([openForLunch, closedForLunch], { lat: 35.6895, lon: 139.6917 }, "lunch");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.name, "Open For Lunch");
});

test("rankFoodPlaces never rejects a candidate whose opening hours can't be confidently parsed", () => {
  const ambiguous = buildCandidate({ name: "Ambiguous Hours", openingHours: "Mo-Su" });
  const unknown = buildCandidate({ name: "No Hours Listed", openingHours: null });
  const ranked = rankFoodPlaces([ambiguous, unknown], { lat: 35.6895, lon: 139.6917 }, "lunch");
  assert.equal(ranked.length, 2);
});
