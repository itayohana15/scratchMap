import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateScheduledPlaceLegality,
  isCandidateGeographicallyCompatibleWithDay,
  type ScheduledPlaceLegalityInput,
} from "../src/lib/trip-workspace";

const COMPACT_MOBILITY_PROFILE = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

// Invented, generic coordinates — never a real named place.
const BASE_ANCHOR = { lat: 10.0, lon: 10.0 };
const NEARBY_POI = { lat: 10.02, lon: 10.02 }; // ~3km — clearly local
const VERY_DISTANT_POI = { lat: 55.0, lon: 55.0 }; // thousands of km — the real bug's exact shape
const MODERATE_DAY_TRIP_POI = { lat: 10.9, lon: 10.0 }; // ~100km — a real, plausible day-trip distance
const TRANSFER_ORIGIN = { lat: 0.0, lon: 0.0 };
const TRANSFER_DESTINATION = { lat: 5.0, lon: 0.0 }; // ~555km apart
const SMALL_DETOUR_POI = { lat: 2.5, lon: 0.3 }; // close to the direct corridor
const HUGE_DETOUR_POI = { lat: 2.5, lon: 40.0 }; // far off the corridor, thousands of km aside

function baseInput(overrides: Partial<ScheduledPlaceLegalityInput> = {}): ScheduledPlaceLegalityInput {
  return {
    placeLat: NEARBY_POI.lat,
    placeLon: NEARBY_POI.lon,
    dayType: "normal",
    stayAnchor: BASE_ANCHOR,
    mobilityProfile: COMPACT_MOBILITY_PROFILE,
    dailyCapacityMinutes: 600,
    ...overrides,
  };
}

// 1. Normal day, nearby POI -> legal.
test("normal day: a nearby real POI is legal", () => {
  const result = evaluateScheduledPlaceLegality(baseInput());
  assert.equal(result.legal, true);
  assert.equal(result.rule, "normal_day_local");
});

// 2. Normal day, very distant POI -> illegal.
test("normal day: a very distant real POI is illegal", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({ placeLat: VERY_DISTANT_POI.lat, placeLon: VERY_DISTANT_POI.lon })
  );
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_normal_day_distance");
});

// 3. category=day_trip on a normal day, distant POI -> still illegal
// (dayType is the ONLY structural signal evaluateScheduledPlaceLegality
// accepts — there is no "category" field in its input at all, so a
// category label cannot influence this decision by construction).
test("normal day: a distant POI stays illegal regardless of any category label — dayType is the only structural input", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({ dayType: "normal", placeLat: VERY_DISTANT_POI.lat, placeLon: VERY_DISTANT_POI.lon })
  );
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_normal_day_distance");
});

// 4. Real feasible round-trip day trip -> legal.
test("day trip: a real, feasible round-trip excursion is legal", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({
      dayType: "day_trip",
      placeLat: MODERATE_DAY_TRIP_POI.lat,
      placeLon: MODERATE_DAY_TRIP_POI.lon,
      visitMinutes: 240,
      dailyCapacityMinutes: 720,
    })
  );
  assert.equal(result.legal, true);
  assert.equal(result.rule, "day_trip_round_trip");
});

// 5. Infeasible round-trip day trip -> illegal. This is the EXACT real-bug
// shape: a Seattle-scale base and a Grand-Canyon-scale distant POI must
// fail generically because the travel math fails, never because of a name.
test("day trip: an infeasible round trip (the real Seattle/Grand-Canyon shape) is illegal", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({
      dayType: "day_trip",
      placeLat: VERY_DISTANT_POI.lat,
      placeLon: VERY_DISTANT_POI.lon,
      visitMinutes: 90,
      dailyCapacityMinutes: 720,
    })
  );
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_day_trip_feasibility");
});

// 6. Transfer POI with small detour -> legal.
test("transfer: a small detour off the direct corridor is legal", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({
      dayType: "transfer",
      stayAnchor: TRANSFER_ORIGIN,
      placeLat: SMALL_DETOUR_POI.lat,
      placeLon: SMALL_DETOUR_POI.lon,
      transferOrigin: TRANSFER_ORIGIN,
      transferDestination: TRANSFER_DESTINATION,
      directTransferMinutes: 400,
      dailyCapacityMinutes: 720,
      visitMinutes: 60,
    })
  );
  assert.equal(result.legal, true);
  assert.equal(result.rule, "transfer_corridor");
});

// 7. Transfer POI with huge detour -> illegal.
test("transfer: a huge detour off the corridor is illegal, even though the day is a transfer day", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({
      dayType: "transfer",
      stayAnchor: TRANSFER_ORIGIN,
      placeLat: HUGE_DETOUR_POI.lat,
      placeLon: HUGE_DETOUR_POI.lon,
      transferOrigin: TRANSFER_ORIGIN,
      transferDestination: TRANSFER_DESTINATION,
      directTransferMinutes: 400,
      dailyCapacityMinutes: 720,
      visitMinutes: 60,
    })
  );
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_transfer_detour");
});

// 8. Resolved POI but missing stay geometry -> fail closed.
test("missing stay anchor: fails closed, never defaults to legal", () => {
  const result = evaluateScheduledPlaceLegality(baseInput({ stayAnchor: null }));
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_missing_geometry");
});

// 9. Missing travel calculation for a real POI -> fail closed (a transfer
// day claimed with no real modeled origin/destination/directTransferMinutes
// must never be treated as automatically legal).
test("transfer day with no real modeled transition data fails closed", () => {
  const result = evaluateScheduledPlaceLegality(
    baseInput({ dayType: "transfer", placeLat: SMALL_DETOUR_POI.lat, placeLon: SMALL_DETOUR_POI.lon })
  );
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_missing_geometry");
});

test("missing place coordinates: fails closed, never defaults to legal", () => {
  const result = evaluateScheduledPlaceLegality(baseInput({ placeLat: null, placeLon: null }));
  assert.equal(result.legal, false);
  assert.equal(result.rule, "invalid_missing_geometry");
});

// 10. FreeTimeBlock/synthetic items bypass real-place legality correctly —
// evaluateScheduledPlaceLegality has no concept of "category" or
// "itemRole" at all; it is only ever invoked with a real place's own
// coordinates. This test documents that contract at the
// isCandidateGeographicallyCompatibleWithDay boundary: candidates come
// only from the real TripRecommendation pool, which never contains a
// synthetic FreeTimeBlock/MealOpportunity/practical block in the first
// place — there is no code path by which one could reach this function.
test("isCandidateGeographicallyCompatibleWithDay only ever judges real candidates from the recommendation pool, never a synthetic schedule item", () => {
  // A "candidate" shaped like a real TripRecommendation (the only shape
  // this function's contract accepts) is always judged on coordinates —
  // there is no itemRole/category field in its signature for a synthetic
  // item to be misidentified through.
  const farRealCandidate = { lat: VERY_DISTANT_POI.lat, lon: VERY_DISTANT_POI.lon };
  const compatible = isCandidateGeographicallyCompatibleWithDay(farRealCandidate, [BASE_ANCHOR], {});
  assert.equal(compatible, false);
});

// 11/12/13 (semantic role safety, spec §J) live in
// geographic-compatibility.test.ts, which already has
// pickReplacementRecommendation and its own test payload/day/item
// builders — see "semantic role: airport/hotel/station cannot fill an
// activity slot" there. evaluateScheduledPlaceLegality itself has no
// category field in its input at all, so it cannot grant or deny a
// semantic-role exemption either way; that gate is upstream (structured
// category + isAnchorDayItem/NON_ACTIVITY_CATEGORIES), never here.
