import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateMinutesForMode,
  isImplausiblyFastTravelTime,
  resolveTransportModeFromLabel,
  selectTransportMode,
} from "../src/lib/transport-mode";

test("selectTransportMode picks walking under 1.5km", () => {
  assert.equal(selectTransportMode(0.3), "walking");
  assert.equal(selectTransportMode(1.4), "walking");
});

test("selectTransportMode picks transit between 1.5km and 5km without luggage", () => {
  assert.equal(selectTransportMode(2), "transit");
  assert.equal(selectTransportMode(5), "transit");
});

test("selectTransportMode prefers taxi over transit at the same distance when carrying luggage", () => {
  assert.equal(selectTransportMode(3, { hasLuggage: true }), "taxi");
});

test("selectTransportMode picks an intercity mode beyond 5km", () => {
  assert.equal(selectTransportMode(20), "bus");
  assert.equal(selectTransportMode(20, { hasLuggage: true }), "car");
  assert.equal(selectTransportMode(200), "train");
});

test("selectTransportMode skips straight to an intercity mode when isIntercity is set, even for a short distance", () => {
  assert.equal(selectTransportMode(3, { isIntercity: true }), "bus");
});

test("selectTransportMode treats zero/negative distance as walking", () => {
  assert.equal(selectTransportMode(0), "walking");
});

test("estimateMinutesForMode is proportional to distance and mode speed", () => {
  assert.equal(estimateMinutesForMode(4, "walking"), 60);
  assert.equal(estimateMinutesForMode(0, "car"), 0);
});

test("resolveTransportModeFromLabel respects an explicit הליכה/רכב label over the distance-based guess", () => {
  assert.equal(resolveTransportModeFromLabel("הליכה", 20), "walking");
  assert.equal(resolveTransportModeFromLabel("נסיעה ברכב", 0.5), "car");
});

test("resolveTransportModeFromLabel falls back to the distance-based guess for an unlabeled hop", () => {
  assert.equal(resolveTransportModeFromLabel("תחבורה מקומית", 0.5), "walking");
  assert.equal(resolveTransportModeFromLabel("תחבורה מקומית", 3), "transit");
});

// Spec test 83: Western Wall → Israel Museum (~2.3km walk) must never be
// displayed as ~20 minutes when the hop is actually assigned to walking.
test("isImplausiblyFastTravelTime flags a ~20 minute claim for a ~2.3km walk", () => {
  assert.equal(isImplausiblyFastTravelTime(2.3, 20, "walking"), true);
});

test("isImplausiblyFastTravelTime does not flag a realistic walking time for the same distance", () => {
  assert.equal(isImplausiblyFastTravelTime(2.3, 45, "walking"), false);
});

test("isImplausiblyFastTravelTime does not flag ordinary estimation noise (a slightly-fast but still plausible time)", () => {
  const plausible = estimateMinutesForMode(2.3, "walking");
  assert.equal(isImplausiblyFastTravelTime(2.3, Math.round(plausible * 0.9), "walking"), false);
});

test("isImplausiblyFastTravelTime never fires for zero distance", () => {
  assert.equal(isImplausiblyFastTravelTime(0, 1, "walking"), false);
});
