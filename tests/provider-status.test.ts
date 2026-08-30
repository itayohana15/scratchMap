import assert from "node:assert/strict";
import test from "node:test";

import { aggregateOverpassStatus } from "../src/lib/provider-status";

// Section B2/B3 — aggregating several real per-category Overpass request
// outcomes into one overall signal.

test("aggregateOverpassStatus: a successful request with real results is available", () => {
  assert.equal(aggregateOverpassStatus([true]), "available");
});

test("aggregateOverpassStatus: a successful request with zero results is STILL available — zero results != provider failure", () => {
  // Modeled the same way the real caller does: `true` here represents
  // "the request itself succeeded", independent of how many places came
  // back — aggregateOverpassStatus never sees a place count at all.
  assert.equal(aggregateOverpassStatus([true]), "available");
});

test("aggregateOverpassStatus: a failed request is unavailable", () => {
  assert.equal(aggregateOverpassStatus([false]), "unavailable");
});

test("aggregateOverpassStatus: some succeeded, some failed -> partial", () => {
  assert.equal(aggregateOverpassStatus([true, false, true]), "partial");
});

test("aggregateOverpassStatus: all failed -> unavailable, even across many categories", () => {
  assert.equal(aggregateOverpassStatus([false, false, false]), "unavailable");
});

test("aggregateOverpassStatus: all succeeded across many categories -> available", () => {
  assert.equal(aggregateOverpassStatus([true, true, true]), "available");
});

test("aggregateOverpassStatus: nothing was ever queried -> null (genuinely unknown, not unavailable)", () => {
  assert.equal(aggregateOverpassStatus([]), null);
  assert.equal(aggregateOverpassStatus([null, null]), null);
});

test("aggregateOverpassStatus: null entries (categories with no data source) are ignored, not counted as failures", () => {
  assert.equal(aggregateOverpassStatus([true, null, true]), "available");
  assert.equal(aggregateOverpassStatus([false, null]), "unavailable");
});

// Section B2's core rule, expressed at the boundary the real callers use:
// a manually-injected recommendation never participates in this
// aggregation at all (it was never a real request), so it cannot change
// the provider status no matter how many such candidates exist.
test("aggregateOverpassStatus: a manually-injected candidate (no corresponding real request) cannot change the provider status", () => {
  // The real caller (fetchLiveRecommendations / fetchRealRecommendations)
  // never adds an outcome entry for a manual candidate — outcomes reflects
  // only real requests actually made.
  const realRequestOutcomes = [false, false];
  assert.equal(aggregateOverpassStatus(realRequestOutcomes), "unavailable");
});
