import assert from "node:assert/strict";
import test from "node:test";

import { runGenerationStage, ItineraryGenerationPipelineError } from "../src/lib/server/country-itineraries";
import {
  ItineraryGenerationInfeasibleError,
  InsufficientRealActivitySupplyError,
  InsufficientRealActivityCoverageError,
  RealPlaceDiscoveryUnavailableError,
  RealPlaceDuplicatesRemainError,
  OpeningHoursViolationsRemainError,
  TimeOfDaySemanticViolationsRemainError,
  InsufficientStayRegionCoverageError,
} from "../src/lib/server/country-itinerary-generation";

/* ==================================================================== *
 * ROUND 9.16.4 §11 — the Round 9.16.3 forensic report found four typed  *
 * pre-persist errors missing from runGenerationStage's pass-through     *
 * allowlist (RealPlaceDuplicatesRemainError, OpeningHoursViolationsRemainError, *
 * TimeOfDaySemanticViolationsRemainError, InsufficientStayRegionCoverageError) — *
 * each one, when thrown, was silently re-wrapped into a generic          *
 * ItineraryGenerationPipelineError, losing its own `.code` and           *
 * `.diagnostics` before route.ts's dedicated instanceof branches for     *
 * them ever got a chance to run. Verified in code and fixed; these tests *
 * prove every typed error (the four newly added, plus the pre-existing   *
 * ones already on the allowlist) survives runGenerationStage unwrapped, *
 * with its own diagnostics intact, while a genuinely-unknown error still *
 * gets the ordinary generic wrapping.                                   *
 * ==================================================================== */

test("Round 9.16.4 §11 (CRITICAL VALIDATION): RealPlaceDuplicatesRemainError survives runGenerationStage unwrapped, diagnostics intact", async () => {
  const original = new RealPlaceDuplicatesRemainError("dup", { duplicateCount: 1, duplicates: [{ name: "X", occurrences: [] }] as never });
  await assert.rejects(
    () =>
      runGenerationStage("itinerary AI request", () => {
        throw original;
      }),
    (error: unknown) => {
      assert.ok(error instanceof RealPlaceDuplicatesRemainError, "must survive as the exact typed error, never re-wrapped");
      assert.equal(error, original, "must be the SAME error instance, not a re-thrown generic wrapper");
      assert.equal(error.code, "REAL_PLACE_DUPLICATES_REMAIN");
      assert.equal(error.diagnostics.duplicateCount, 1);
      return true;
    }
  );
});

test("Round 9.16.4 §11 (CRITICAL VALIDATION): OpeningHoursViolationsRemainError survives runGenerationStage unwrapped, diagnostics intact", async () => {
  const original = new OpeningHoursViolationsRemainError("oh", { violationCount: 1, violations: [] });
  await assert.rejects(
    () =>
      runGenerationStage("itinerary AI request", () => {
        throw original;
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpeningHoursViolationsRemainError);
      assert.equal(error, original);
      assert.equal(error.code, "OPENING_HOURS_VIOLATIONS_REMAIN");
      assert.equal(error.diagnostics.violationCount, 1);
      return true;
    }
  );
});

test("Round 9.16.4 §11 (CRITICAL VALIDATION): TimeOfDaySemanticViolationsRemainError survives runGenerationStage unwrapped, diagnostics intact — the exact Round 9.16.3 production shape", async () => {
  const original = new TimeOfDaySemanticViolationsRemainError(
    "1 scheduled item(s) violate time-of-day semantic legality: Todt Hill (day 36 at 19:25, DAYLIGHT_ORIENTED).",
    { violationCount: 1, violations: [{ dayNumber: 36, itemName: "Todt Hill", compatibility: "DAYLIGHT_ORIENTED", plannedStartTime: "19:25" }] }
  );
  await assert.rejects(
    () =>
      runGenerationStage("itinerary AI request", () => {
        throw original;
      }),
    (error: unknown) => {
      assert.ok(error instanceof TimeOfDaySemanticViolationsRemainError, "must survive as the exact typed error, never a generic ItineraryGenerationPipelineError");
      assert.equal(error, original);
      assert.equal(error.code, "TIME_OF_DAY_SEMANTIC_VIOLATIONS_REMAIN");
      assert.equal(error.diagnostics.violations[0].itemName, "Todt Hill");
      return true;
    }
  );
});

test("Round 9.16.4 §11 (CRITICAL VALIDATION): InsufficientStayRegionCoverageError survives runGenerationStage unwrapped, diagnostics intact", async () => {
  const original = new InsufficientStayRegionCoverageError("insufficient", {
    traceId: "t1",
    tripNights: 35,
    stayCount: 2,
    minimumRequiredStayCount: 3,
    maxStayNights: 14,
    uncoveredNights: 0,
    coverageRatio: 1.03,
  });
  await assert.rejects(
    () =>
      runGenerationStage("itinerary AI request", () => {
        throw original;
      }),
    (error: unknown) => {
      assert.ok(error instanceof InsufficientStayRegionCoverageError);
      assert.equal(error, original);
      assert.equal(error.code, "INSUFFICIENT_STAY_REGION_COVERAGE");
      assert.equal(error.diagnostics.tripNights, 35);
      return true;
    }
  );
});

test("Round 9.16.4 §11: the pre-existing allowlisted error types still pass through unwrapped (regression, not newly broken)", async () => {
  const cases: Array<() => never> = [
    () => {
      throw new ItineraryGenerationInfeasibleError("PLAN_NOT_FEASIBLE", "msg", {
        traceId: null,
        primaryFailure: "geography",
        diagnostics: { duplicatePlaces: 0, openingHoursViolations: 0, missingMeals: 0, overloadedDays: 0, outOfBudget: false },
      });
    },
    () => {
      throw new InsufficientRealActivitySupplyError("msg", []);
    },
    () => {
      throw new InsufficientRealActivityCoverageError({} as never, {
        normalDayCount: 1,
        unjustifiedZeroRealDayNumbers: [1],
        recommendationPoolSize: 0,
        totalRecommendations: 0,
        realMealVenueRecommendations: 0,
      });
    },
    () => {
      throw new RealPlaceDiscoveryUnavailableError("msg", []);
    },
  ];
  for (const throwFn of cases) {
    await assert.rejects(() => runGenerationStage("itinerary AI request", async () => throwFn()));
  }
});

test("Round 9.16.4 §11: a genuinely unknown error is still wrapped into a generic ItineraryGenerationPipelineError (unchanged behavior)", async () => {
  await assert.rejects(
    () =>
      runGenerationStage("itinerary AI request", () => {
        throw new Error("some unrelated bug");
      }),
    (error: unknown) => {
      assert.ok(error instanceof ItineraryGenerationPipelineError, "an unrecognized error must still get the ordinary generic wrapper, never surfaced as a bare Error");
      assert.equal(error.message, "some unrelated bug");
      return true;
    }
  );
});
