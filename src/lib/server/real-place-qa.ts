// Round 9.4 §Phase 0 — "OBSERVABILITY ONLY". This module adds NO planner
// behavior: every export here only records/reads/logs. It exists to answer
// one question from real production evidence (a successful 41-day/7-stay
// itinerary with 0 real activities and 0 real meals): WHERE do real places
// disappear? Every RealPlaceQA log below is gated behind the SAME existing
// QA/debug flag every other generation-time diagnostic in this codebase
// already uses (isPlannerQaTraceEnabled — QA_DEBUG_GEOGRAPHY/
// CAPTURE_FIXTURES/PLANNER_QA_TRACE) — silent by default, never spams real
// end-user traffic, and requires no new environment variable for the next
// real run to produce these logs.
//
// Module-level trace context (not a threaded function parameter): adding a
// new required/optional parameter to the dozens of functions across
// country-itinerary-generation.ts/stay-activity-pool.ts/
// stay-meal-venue-pool.ts this round needs to instrument would itself be an
// invasive, risky structural change for an "observability only" round. The
// SAME pattern planner-qa-trace.ts already uses (module-level mutable
// state, no signature changes to any planner function) is reused here:
// beginRealPlaceTrace() is called once, at the real entry point
// (generateAndStoreCountryItinerary, before generateCountryItineraryPlan is
// ever called), and every log call anywhere in the pipeline reads the same
// context automatically. Node module singletons are shared across every
// importer, so this works correctly across file boundaries.
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";

export interface RealPlaceTraceContext {
  traceId: string;
  countryIso: string;
  tripDays: number;
  travelerCount: number;
}

let currentContext: RealPlaceTraceContext | null = null;

/** `gen-<time36>-<random>` — unique enough to correlate one generation's logs, never a claim of global uniqueness beyond that. */
export function generateRealPlaceTraceId(): string {
  return `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function beginRealPlaceTrace(context: RealPlaceTraceContext): void {
  currentContext = context;
}

/** Called once the generation this trace covers has fully finished (success or failure) — never required for correctness, only to avoid a stale context leaking into unrelated logs. */
export function endRealPlaceTrace(): void {
  currentContext = null;
}

export function getRealPlaceTraceContext(): RealPlaceTraceContext | null {
  return currentContext;
}

/**
 * THE one shared logging helper (spec §S.2) every RealPlaceQA log in this
 * round goes through — never a scattered ad-hoc console.log. Automatically
 * injects traceId/countryIso/tripDays/travelerCount from the current
 * context so no call site has to thread them through. A no-op when the QA
 * flag is off (spec §S.3), so this can never affect production behavior or
 * performance, and never logs anything when tracing was never begun (e.g.
 * a unit test that calls a planner function directly without going through
 * generateAndStoreCountryItinerary).
 */
export function logRealPlaceQA(event: string, details: Record<string, unknown> = {}): void {
  if (!isPlannerQaTraceEnabled()) return;
  const context = currentContext;
  console.log(`[RealPlaceQA:${event}]`, {
    traceId: context?.traceId ?? "no-trace-context",
    countryIso: context?.countryIso,
    tripDays: context?.tripDays,
    travelerCount: context?.travelerCount,
    ...details,
  });
}

/**
 * The COMPACT tier (spec §S.4) — FinalResult/GenerationFailure/anomaly
 * signals that should remain visible in a routine dev run even when the
 * full verbose candidate-sample tracing is off. Still gated on
 * isPlannerQaTraceEnabled (spec §S.3 — reuse the existing mechanism, never
 * a second one) since this codebase has no separate "compact-only" flag;
 * the distinction from logRealPlaceQA is documentary (which logs are safe
 * to keep even if a future round adds a lighter separate flag), not
 * behavioral.
 */
export function logRealPlaceQACompact(event: string, details: Record<string, unknown> = {}): void {
  logRealPlaceQA(event, details);
}

/** Spec §S.7 — every candidate/rejection sample in this round is bounded through this one helper, never an ad-hoc `.slice(0, N)` repeated at each call site. */
export function boundSample<T>(items: readonly T[], max = 10): T[] {
  return items.slice(0, max);
}

/**
 * Spec §R — lightweight, additive stage timing. `time()` wraps an async
 * stage and reports elapsedMs via logRealPlaceQA regardless of the QA flag
 * check happening inside logRealPlaceQA itself (timing math is cheap
 * enough to always compute; only the LOG is gated). Never throws on behalf
 * of the wrapped stage — a rejection propagates unchanged, after still
 * recording how long the stage ran before failing.
 */
export async function timeRealPlaceStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logRealPlaceQA("Timing", { stage, elapsedMs: Date.now() - start, ok: true });
    return result;
  } catch (error) {
    logRealPlaceQA("Timing", { stage, elapsedMs: Date.now() - start, ok: false });
    throw error;
  }
}

/** Synchronous analogue of timeRealPlaceStage, for stages that are not async (e.g. pool/portfolio construction). */
export function timeRealPlaceStageSync<T>(stage: string, fn: () => T): T {
  const start = Date.now();
  try {
    const result = fn();
    logRealPlaceQA("Timing", { stage, elapsedMs: Date.now() - start, ok: true });
    return result;
  } catch (error) {
    logRealPlaceQA("Timing", { stage, elapsedMs: Date.now() - start, ok: false });
    throw error;
  }
}

/**
 * Spec §H — the zero-pool-reason enum. Never "just log 0": this is the
 * exact classification the round demands whenever a stay's activity pool
 * ends up empty, derived from the SAME diagnostics fields
 * StayActivityPool.diagnostics already carries (no new tracking state).
 */
export type ZeroPoolReason =
  | "NO_DISCOVERY_RESULTS"
  | "PROVIDER_FAILURE"
  | "ALL_FAILED_NORMALIZATION"
  | "ALL_FAILED_GEOGRAPHY"
  | "ALL_CLASSIFIED_AS_MEALS"
  | "ALL_DUPLICATES"
  | "NO_COORDINATES"
  | "UNKNOWN"
  /**
   * Round 9.6.2 §7 — a stay whose anchor never resolved at all (the
   * Round 9.6.1 root cause) must never be reported the same way as a stay
   * that WAS queried and genuinely came back empty. "NO_DISCOVERY_RESULTS"
   * means a provider was actually asked and had nothing; this means no
   * provider was ever asked, because there was nothing to query with —
   * a fundamentally different, upstream failure mode that needs a
   * different fix (stay-skeleton/anchor resolution, not provider supply).
   */
  | "DISCOVERY_NOT_ATTEMPTED_MISSING_ANCHOR";

export function classifyZeroPoolReason(diagnostics: {
  initialCandidateCount: number;
  providerFailures: number;
  dedupeRejected: number;
  geographyRejected: number;
  mealVenueExcluded?: number;
}): ZeroPoolReason {
  if (diagnostics.initialCandidateCount === 0) {
    return diagnostics.providerFailures > 0 ? "PROVIDER_FAILURE" : "NO_DISCOVERY_RESULTS";
  }
  const { initialCandidateCount, dedupeRejected, geographyRejected, mealVenueExcluded = 0 } = diagnostics;
  if (mealVenueExcluded >= initialCandidateCount) return "ALL_CLASSIFIED_AS_MEALS";
  if (dedupeRejected >= initialCandidateCount) return "ALL_DUPLICATES";
  if (geographyRejected >= initialCandidateCount) return "ALL_FAILED_GEOGRAPHY";
  if (dedupeRejected + geographyRejected + mealVenueExcluded >= initialCandidateCount) return "ALL_FAILED_NORMALIZATION";
  return "UNKNOWN";
}

/**
 * Spec §M/§N — a pure, generic before/after real-activity identity diff,
 * reused at every repair/finalization checkpoint this round instruments
 * (never a bespoke diff per call site). Never invents a removal reason —
 * a caller with no reason to report passes "UNKNOWN" (spec §M: "If the
 * repair primitive currently cannot provide the reason ... do not invent
 * one").
 */
export interface RealActivityIdentitySnapshot {
  id: string;
  name: string;
  dayNumber: number;
}

export interface RealActivityDelta {
  beforeCount: number;
  afterCount: number;
  addedIds: string[];
  removedIds: string[];
  removed: Array<{ id: string; name: string; dayNumber: number }>;
}

export function diffRealActivitySnapshots(
  before: RealActivityIdentitySnapshot[],
  after: RealActivityIdentitySnapshot[]
): RealActivityDelta {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterIds = new Set(after.map((item) => item.id));
  const addedIds = after.filter((item) => !beforeById.has(item.id)).map((item) => item.id);
  const removedEntries = before.filter((item) => !afterIds.has(item.id));
  return {
    beforeCount: before.length,
    afterCount: after.length,
    addedIds,
    removedIds: removedEntries.map((item) => item.id),
    removed: removedEntries.map((item) => ({ id: item.id, name: item.name, dayNumber: item.dayNumber })),
  };
}

/* ================================================================== *
 * Round 9.4.1 — REPAIRPLAN FORENSICS (still observability only).       *
 * Every real-place identity is tracked by its OWN canonical id         *
 * (recommendationId when present, else a stable coords+name key),      *
 * never by display name alone (spec §D) — a real candidate recreated   *
 * as a generic/synthetic item with no id counts as LOSS, and a         *
 * genuinely different real place must never be confused with it.       *
 * Deliberately kept pure/generic here: country-itinerary-generation.ts *
 * builds the actual RepairSnapshotItem[] from its OWN local             *
 * classification helpers (isScheduledRealPlace/isGenericMealOpportunity/
 * isSyntheticScheduleItem) — this module only ever receives already-    *
 * classified data, so it never needs to import from (and risk a         *
 * circular dependency with) country-itinerary-generation.ts.            *
 * ================================================================== */

export type RepairItemKind = "real_activity" | "real_meal" | "synthetic_activity" | "meal_opportunity" | "other";

export interface RepairSnapshotItem {
  /** recommendationId when the item genuinely has one; otherwise a coords+name key; NEVER name alone (spec §D). */
  id: string;
  name: string;
  category: string;
  itemRole: string | null;
  phaseId: string | null;
  dayNumber: number;
  lat: number | null;
  lon: number | null;
  kind: RepairItemKind;
  /** True only when this item genuinely carries a recommendationId — a coords-only or name-only identity is NOT the same as having a real id (spec §D: "recreated without their ID" is itself a loss, even at the same coordinates). */
  hasRecommendationId: boolean;
}

export interface RepairStepCounts {
  realActivities: number;
  realMeals: number;
  syntheticActivities: number;
  mealOpportunities: number;
  totalItems: number;
}

export interface RepairStepReclassification {
  id: string;
  name: string;
  beforeCategory: string;
  afterCategory: string;
  beforeItemRole: string | null;
  afterItemRole: string | null;
  beforePhaseId: string | null;
  afterPhaseId: string | null;
}

export interface RepairStepMove {
  id: string;
  name: string;
  fromDay: number;
  toDay: number;
  fromPhaseId: string | null;
  toPhaseId: string | null;
}

export interface RepairStepDeltaResult {
  before: RepairStepCounts;
  after: RepairStepCounts;
  delta: RepairStepCounts;
  removedRealActivities: RepairSnapshotItem[];
  addedRealActivities: RepairSnapshotItem[];
  reclassifiedItems: RepairStepReclassification[];
  movedItems: RepairStepMove[];
  /** True only when an item's identity (hasRecommendationId + coords) survived but it moved to a DIFFERENT day than a plain move would (spec §D: "recreated without their ID" — same id present before AND after, but the AFTER copy has hasRecommendationId:false, meaning something rebuilt it as a lookalike rather than truly keeping it). */
  identityDowngradedIds: string[];
}

function computeCounts(items: RepairSnapshotItem[]): RepairStepCounts {
  const counts: RepairStepCounts = { realActivities: 0, realMeals: 0, syntheticActivities: 0, mealOpportunities: 0, totalItems: items.length };
  for (const item of items) {
    if (item.kind === "real_activity") counts.realActivities += 1;
    else if (item.kind === "real_meal") counts.realMeals += 1;
    else if (item.kind === "synthetic_activity") counts.syntheticActivities += 1;
    else if (item.kind === "meal_opportunity") counts.mealOpportunities += 1;
  }
  return counts;
}

/**
 * Spec §B/§C/§D — the ONE shared diff every repair-step wrapper calls,
 * never a bespoke comparison per step. Matches items by canonical id
 * first; a real item whose id disappears entirely (not just moved/
 * reclassified) is a genuine removal, and one appearing with a
 * previously-unseen id is a genuine addition — reclassification and
 * moves are reported SEPARATELY from removed/added so a step that only
 * relabels or relocates real content is never confused with one that
 * actually destroys it.
 */
export function computeRepairStepDelta(before: RepairSnapshotItem[], after: RepairSnapshotItem[]): RepairStepDeltaResult {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const isRealKind = (kind: RepairItemKind) => kind === "real_activity" || kind === "real_meal";

  const removedRealActivities: RepairSnapshotItem[] = [];
  const reclassifiedItems: RepairStepReclassification[] = [];
  const movedItems: RepairStepMove[] = [];
  const identityDowngradedIds: string[] = [];

  for (const [id, beforeItem] of beforeById) {
    const afterItem = afterById.get(id);
    if (!afterItem) {
      if (isRealKind(beforeItem.kind)) removedRealActivities.push(beforeItem);
      continue;
    }
    if (beforeItem.hasRecommendationId && !afterItem.hasRecommendationId) {
      identityDowngradedIds.push(id);
    }
    if (beforeItem.category !== afterItem.category || beforeItem.itemRole !== afterItem.itemRole || beforeItem.phaseId !== afterItem.phaseId) {
      reclassifiedItems.push({
        id,
        name: afterItem.name,
        beforeCategory: beforeItem.category,
        afterCategory: afterItem.category,
        beforeItemRole: beforeItem.itemRole,
        afterItemRole: afterItem.itemRole,
        beforePhaseId: beforeItem.phaseId,
        afterPhaseId: afterItem.phaseId,
      });
      // A real item reclassified INTO a non-real kind is a loss (spec §D:
      // "A real candidate recreated as a generic/synthetic item counts as
      // LOSS") — reported alongside removedRealActivities so both a
      // vanished id AND a relabeled-into-synthetic id are visible in the
      // same bounded list.
      if (isRealKind(beforeItem.kind) && !isRealKind(afterItem.kind)) {
        removedRealActivities.push(beforeItem);
      }
    }
    if (beforeItem.dayNumber !== afterItem.dayNumber) {
      movedItems.push({ id, name: afterItem.name, fromDay: beforeItem.dayNumber, toDay: afterItem.dayNumber, fromPhaseId: beforeItem.phaseId, toPhaseId: afterItem.phaseId });
    }
  }

  const addedRealActivities = after.filter((item) => isRealKind(item.kind) && !beforeById.has(item.id));

  return {
    before: computeCounts(before),
    after: computeCounts(after),
    delta: (() => {
      const b = computeCounts(before);
      const a = computeCounts(after);
      return {
        realActivities: a.realActivities - b.realActivities,
        realMeals: a.realMeals - b.realMeals,
        syntheticActivities: a.syntheticActivities - b.syntheticActivities,
        mealOpportunities: a.mealOpportunities - b.mealOpportunities,
        totalItems: a.totalItems - b.totalItems,
      };
    })(),
    removedRealActivities,
    addedRealActivities,
    reclassifiedItems,
    movedItems,
    identityDowngradedIds,
  };
}

/**
 * Spec §C/§J — logs [RealPlaceQA:RepairStepDelta] for one mutating repair
 * primitive, and separately fires [RealPlaceQA:CATASTROPHIC_REPAIR_LOSS]
 * (observability only — never throws, never changes behavior) whenever a
 * SINGLE step loses all real activities or >= 50% of them. Returns the
 * computed delta so a caller (e.g. an attempt-level aggregator) can reuse
 * it without recomputing.
 */
/**
 * Spec §J — a pure predicate, exported directly testable and reused by
 * logRepairStepDelta below: a step is a catastrophic loss when it starts
 * with SOME real content (before > 0) and ends with either none at all,
 * or at most half of what it started with. Never fires on a step that
 * started at zero (nothing to lose), matching spec §12A's own "genuine
 * scarcity is not a failure" discipline applied here to a single step.
 */
export function isCatastrophicRepairLoss(beforeReal: number, afterReal: number): boolean {
  return beforeReal > 0 && (afterReal === 0 || afterReal <= beforeReal * 0.5);
}

export function logRepairStepDelta(attempt: number, stepIndex: number, stepName: string, before: RepairSnapshotItem[], after: RepairSnapshotItem[]): RepairStepDeltaResult {
  const result = computeRepairStepDelta(before, after);
  logRealPlaceQA("RepairStepDelta", {
    attempt,
    stepIndex,
    stepName,
    before: result.before,
    after: result.after,
    delta: result.delta,
    removedRealActivities: boundSample(result.removedRealActivities, 15),
    addedRealActivities: boundSample(result.addedRealActivities, 15),
    reclassifiedItems: boundSample(result.reclassifiedItems, 15),
    movedItems: boundSample(result.movedItems, 15),
    identityDowngradedIds: boundSample(result.identityDowngradedIds, 15),
  });

  const beforeReal = result.before.realActivities + result.before.realMeals;
  const afterReal = result.after.realActivities + result.after.realMeals;
  if (isCatastrophicRepairLoss(beforeReal, afterReal)) {
    logRealPlaceQACompact("CATASTROPHIC_REPAIR_LOSS", {
      stepName,
      attempt,
      beforeCount: beforeReal,
      afterCount: afterReal,
      removedIdsSample: boundSample([...result.removedRealActivities.map((i) => i.id)], 15),
    });
  }

  return result;
}

/** Spec §E — attempt boundaries, so a compounding-across-attempts loss (attempt 1 damages, attempt 2 ingests the damage, ...) can be told apart from one single primitive destroying everything in one attempt. */
export function logRepairAttemptStart(attempt: number, items: RepairSnapshotItem[]): void {
  logRealPlaceQA("RepairAttemptStart", { attempt, ...computeCounts(items) });
}

export function logRepairAttemptEnd(attempt: number, items: RepairSnapshotItem[]): void {
  logRealPlaceQA("RepairAttemptEnd", { attempt, ...computeCounts(items) });
}

/**
 * Spec §F — round-trip boundaries (toRawGeneratedPlan/enrichAiDay/
 * normalizeCategory/fallback reconstruction) that carry real-place
 * identity through a format that may not preserve every field (e.g.
 * RawGeneratedItem has no itemRole field at all — the exact "practical"->
 * "attraction" bug a previous round found). Reuses the SAME id-matching
 * computeRepairStepDelta already does, reported under a distinct event
 * name so a round-trip loss is never confused with an ordinary repair
 * step's own mutation.
 */
export function logRepairRoundTrip(boundaryName: string, before: RepairSnapshotItem[], after: RepairSnapshotItem[]): void {
  const beforeIds = new Set(before.map((item) => item.id));
  const afterIds = new Set(after.map((item) => item.id));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const lostIds = [...beforeIds].filter((id) => !afterIds.has(id));
  const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
  const categoryChanges: RepairStepReclassification[] = [];
  for (const [id, beforeItem] of beforeById) {
    const afterItem = afterById.get(id);
    if (!afterItem) continue;
    if (beforeItem.category !== afterItem.category || beforeItem.itemRole !== afterItem.itemRole || beforeItem.phaseId !== afterItem.phaseId) {
      categoryChanges.push({
        id,
        name: afterItem.name,
        beforeCategory: beforeItem.category,
        afterCategory: afterItem.category,
        beforeItemRole: beforeItem.itemRole,
        afterItemRole: afterItem.itemRole,
        beforePhaseId: beforeItem.phaseId,
        afterPhaseId: afterItem.phaseId,
      });
    }
  }
  logRealPlaceQA("RepairRoundTrip", {
    boundaryName,
    beforeRealActivityIds: boundSample(before.filter((i) => i.kind === "real_activity" || i.kind === "real_meal").map((i) => i.id), 30),
    afterRealActivityIds: boundSample(after.filter((i) => i.kind === "real_activity" || i.kind === "real_meal").map((i) => i.id), 30),
    lostIds: boundSample(lostIds, 15),
    newIds: boundSample(newIds, 15),
    categoryChanges: boundSample(categoryChanges, 15),
    itemRoleChanges: boundSample(categoryChanges.filter((c) => c.beforeItemRole !== c.afterItemRole), 15),
    phaseIdChanges: boundSample(categoryChanges.filter((c) => c.beforePhaseId !== c.afterPhaseId), 15),
  });
}

/* ================================================================== *
 * Round 9.6.4 §6 — MONOTONIC DUPLICATE-REPAIR INVARIANT.               *
 * D(n) = number of illegal duplicate real-place occurrences after      *
 * repair step n must never increase for a step intended to address     *
 * duplicates/geography. A minimal, structurally-typed input (rather    *
 * than importing RealPlaceDuplicateGroup, which lives in               *
 * country-itinerary-generation.ts and already imports FROM this        *
 * module — importing it back here would be circular) so any caller's   *
 * own duplicate-group array satisfies this by structure alone.         *
 * ================================================================== */

export interface DuplicateRepairDeltaResult {
  duplicatesBefore: number;
  duplicatesAfter: number;
  insertedIds: string[];
  removedIds: string[];
  nonMonotonic: boolean;
}

/**
 * Pure — computes the delta and returns it; logging is a separate,
 * explicit call (logDuplicateRepairDelta) so a caller that wants to
 * branch on nonMonotonic (e.g. the final cleanup pass deciding whether to
 * run at all) never has to parse its own log output to find out.
 */
export function computeDuplicateRepairDelta(
  step: string,
  before: Array<{ recommendationId: string }>,
  after: Array<{ recommendationId: string }>
): DuplicateRepairDeltaResult {
  const beforeIds = new Set(before.map((g) => g.recommendationId));
  const afterIds = new Set(after.map((g) => g.recommendationId));
  return {
    duplicatesBefore: before.length,
    duplicatesAfter: after.length,
    insertedIds: [...afterIds].filter((id) => !beforeIds.has(id)),
    removedIds: [...beforeIds].filter((id) => !afterIds.has(id)),
    nonMonotonic: after.length > before.length,
  };
}

export function logDuplicateRepairDelta(
  step: string,
  attempt: number | null,
  result: DuplicateRepairDeltaResult,
  movedIds: string[] = [],
  rejectedAlreadyUsedCandidateIds: string[] = []
): void {
  logRealPlaceQA("DuplicateRepairDelta", {
    step,
    attempt,
    duplicatesBefore: result.duplicatesBefore,
    duplicatesAfter: result.duplicatesAfter,
    insertedIds: boundSample(result.insertedIds, 15),
    removedIds: boundSample(result.removedIds, 15),
    movedIds: boundSample(movedIds, 15),
    rejectedAlreadyUsedCandidateIds: boundSample(rejectedAlreadyUsedCandidateIds, 15),
  });
  if (result.nonMonotonic) {
    logRealPlaceQACompact("DUPLICATE_REPAIR_NON_MONOTONIC", {
      step,
      attempt,
      duplicatesBefore: result.duplicatesBefore,
      duplicatesAfter: result.duplicatesAfter,
      newDuplicateIds: boundSample(result.insertedIds, 15),
    });
  }
}
