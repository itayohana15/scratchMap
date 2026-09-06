import assert from "node:assert/strict";
import test from "node:test";

import {
  resetPlannerQaTrace,
  resetPoolStageLogs,
  tracePlaceInsertion,
  tracePoolStage,
  findInsertionsByIdentity,
  buildDuplicateTraceReports,
  getPoolStageLogs,
  getPlannerQaTraceEvents,
} from "@/lib/planner-qa-trace";
import type { RecommendationCategory } from "@/lib/trip-workspace";

// This module's entire gate is process.env.PLANNER_QA_TRACE (or the other
// two env flags) — every test here turns tracing on for its own duration
// and resets both collectors before/after, so tests never see each other's
// events and never depend on execution order.
function withTraceEnabled(fn: () => void) {
  const original = process.env.PLANNER_QA_TRACE;
  process.env.PLANNER_QA_TRACE = "1";
  resetPlannerQaTrace();
  resetPoolStageLogs();
  try {
    fn();
  } finally {
    resetPlannerQaTrace();
    resetPoolStageLogs();
    if (original === undefined) delete process.env.PLANNER_QA_TRACE;
    else process.env.PLANNER_QA_TRACE = original;
  }
}

function realItem(overrides: Partial<{ recommendationId: string | null; name: string; lat: number | null; lon: number | null; category: RecommendationCategory; itemRole: "real_place" }> = {}) {
  return {
    recommendationId: "recommendationId" in overrides ? (overrides.recommendationId as string | null) : "rec-1",
    name: overrides.name ?? "Test Place",
    lat: overrides.lat ?? 34.0,
    lon: overrides.lon ?? -118.0,
    category: overrides.category ?? ("attraction" as RecommendationCategory),
    itemRole: overrides.itemRole ?? "real_place",
  };
}

test("planner-qa-trace: first insertion records its source", () => {
  withTraceEnabled(() => {
    const identity = tracePlaceInsertion({
      item: realItem(),
      normalizedName: "test-place",
      dayNumber: 3,
      source: "gemini_initial",
      action: "INSERT",
      ownerStay: "Los Angeles",
    });

    assert.equal(identity.kind, "real");
    const events = getPlannerQaTraceEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "gemini_initial");
    assert.equal(events[0].dayNumber, 3);
    assert.equal(events[0].action, "INSERT");
  });
});

test("planner-qa-trace: a duplicate insertion links back to the first occurrence", () => {
  withTraceEnabled(() => {
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-annapolis" }),
      normalizedName: "annapolis",
      dayNumber: 5,
      source: "gemini_initial",
      action: "INSERT",
      ownerStay: "Annapolis",
    });
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-annapolis" }),
      normalizedName: "annapolis",
      dayNumber: 12,
      source: "deterministic_template",
      action: "INSERT",
      ownerStay: "Los Angeles",
    });

    const reports = buildDuplicateTraceReports("id:rec-annapolis");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].firstOccurrence.dayNumber, 5);
    assert.equal(reports[0].firstOccurrence.source, "gemini_initial");
    assert.equal(reports[0].duplicateOccurrence.dayNumber, 12);
    assert.equal(reports[0].duplicateOccurrence.source, "deterministic_template");
    assert.equal(reports[0].sameRecommendationId, true);
  });
});

test("planner-qa-trace: a category alias with the same physical coordinates maps to the same canonical identity", () => {
  withTraceEnabled(() => {
    // The exact real bug this closes: a park scheduled once under category
    // "attraction" and once (via a different candidate list entry) under
    // "outdoor_recreation" is still one physical place — canonical identity
    // is coordinate/id-based and deliberately never takes category as an
    // input, so both insertions must collapse to the same identity string
    // and therefore the same duplicate-trace history.
    tracePlaceInsertion({
      item: realItem({ recommendationId: null, name: "Golden Gate Park", lat: 37.7694, lon: -122.4862, category: "attraction" as RecommendationCategory }),
      normalizedName: "golden-gate-park",
      dayNumber: 2,
      source: "gemini_initial",
      action: "INSERT",
      ownerStay: "San Francisco",
    });
    tracePlaceInsertion({
      item: realItem({ recommendationId: null, name: "Golden Gate Park", lat: 37.7694, lon: -122.4862, category: "outdoor_recreation" as RecommendationCategory }),
      normalizedName: "golden-gate-park",
      dayNumber: 6,
      source: "deterministic_template",
      action: "INSERT",
      ownerStay: "San Francisco",
    });

    const occurrences = findInsertionsByIdentity("coords:37.769:-122.486:golden-gate-park");
    assert.equal(occurrences.length, 2);
    assert.deepEqual(
      occurrences.map((event) => event.category),
      ["attraction", "outdoor_recreation"]
    );
  });
});

test("planner-qa-trace: a duplicate that bypassed the legal pool is visible in its forensic report", () => {
  withTraceEnabled(() => {
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-bypassed" }),
      normalizedName: "bypassed-place",
      dayNumber: 2,
      source: "deterministic_template",
      action: "INSERT",
      ownerStay: "Chicago",
      passedLegalPool: true,
    });
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-bypassed" }),
      normalizedName: "bypassed-place",
      dayNumber: 9,
      source: "locality_repair",
      action: "REPLACE",
      ownerStay: "Chicago",
      passedLegalPool: false,
    });

    const reports = buildDuplicateTraceReports("id:rec-bypassed");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].bypassedLegalPool, true);
  });
});

test("planner-qa-trace: legal pool exhaustion is a distinct, queryable trace event", () => {
  withTraceEnabled(() => {
    tracePoolStage({ dayNumber: 7, stage: "raw", size: 12 });
    tracePoolStage({ dayNumber: 7, stage: "after_global_used_filter", size: 4 });
    tracePoolStage({ dayNumber: 7, stage: "after_geography_filter", size: 0 });
    tracePoolStage({ dayNumber: 7, stage: "final_legal_pool", size: 0 });

    const logs = getPoolStageLogs();
    const exhausted = logs.filter((log) => log.stage === "final_legal_pool" && log.size === 0);
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0].dayNumber, 7);
  });
});

test("planner-qa-trace: synthetic items never pollute the real-place duplicate trace", () => {
  withTraceEnabled(() => {
    // The realistic failure shape this guards against (seen in a real
    // replay): a free-exploration/meal-opportunity block that DID get real
    // coordinates attached (e.g. anchored to a nearby real venue for map
    // display) must still never be trackable as a duplicate real place —
    // itemRole is authoritative over having lat/lon, not the other way
    // around. Both blocks below carry the SAME real coordinates a genuine
    // duplicate check would otherwise collide on.
    tracePlaceInsertion({
      item: { recommendationId: null, name: "זמן פנוי בשיקגו", lat: 41.8781, lon: -87.6298, category: "attraction" as RecommendationCategory, itemRole: "free_time" },
      normalizedName: "free-time-chicago",
      dayNumber: 4,
      source: "free_time",
      action: "INSERT",
      ownerStay: "Chicago",
    });
    tracePlaceInsertion({
      item: { recommendationId: null, name: "זמן פנוי בשיקגו", lat: 41.8781, lon: -87.6298, category: "attraction" as RecommendationCategory, itemRole: "free_time" },
      normalizedName: "free-time-chicago",
      dayNumber: 10,
      source: "free_time",
      action: "INSERT",
      ownerStay: "Los Angeles",
    });

    const events = getPlannerQaTraceEvents();
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.identity.kind === "synthetic"));
    assert.ok(events.every((event) => event.identity.identity === null));
    // The would-be real-place key these coordinates map to (had itemRole
    // been ignored) must return no history at all.
    assert.equal(findInsertionsByIdentity("coords:41.878:-87.630:free-time-chicago").length, 0);
  });
});

test("planner-qa-trace: aggregating duplicate sources across days matches each occurrence's real source", () => {
  withTraceEnabled(() => {
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-multi" }),
      normalizedName: "multi-place",
      dayNumber: 1,
      source: "gemini_initial",
      action: "INSERT",
      ownerStay: "California Coast",
    });
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-multi" }),
      normalizedName: "multi-place",
      dayNumber: 8,
      source: "duplicate_repair",
      action: "REPLACE",
      ownerStay: "California Coast",
    });
    tracePlaceInsertion({
      item: realItem({ recommendationId: "rec-multi" }),
      normalizedName: "multi-place",
      dayNumber: 15,
      source: "deterministic_template",
      action: "INSERT",
      ownerStay: "Chicago",
    });

    // This mirrors exactly what the [PlannerFailureSummary] block computes:
    // for a duplicated canonical identity, the distinct set of insertion
    // sources across every occurrence that produced it.
    const occurrences = findInsertionsByIdentity("id:rec-multi");
    const sources = new Set(occurrences.map((event) => event.source));
    assert.equal(occurrences.length, 3);
    assert.deepEqual([...sources].sort(), ["deterministic_template", "duplicate_repair", "gemini_initial"]);
  });
});
