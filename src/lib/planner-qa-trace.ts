// Spec "OBSERVABILITY ONLY" — a structured, in-memory QA trace of every
// real-place insertion/replacement/removal during generation, so a
// duplicatePlaces failure can be explained causally (which function
// inserted which place, on which day, whether it went through the legal
// pool, whether it was already used) instead of only showing the final
// aggregate count. Dev/QA-only: gated by isPlannerQaTraceEnabled below,
// never active in production, never spams normal logs. This module
// intentionally changes NO planner behavior — every export here only
// records or reads observations.
//
// Lives in src/lib/ (not src/lib/server/) deliberately: trip-workspace.ts
// is shared client/server code, and selectFallbackCandidate/
// buildLegalDayCandidatePool (the deterministic fallback's own
// server-only logic, but defined inside trip-workspace.ts) need to call
// into this — importing a src/lib/server/ file from there would leak a
// server-only import path into client bundles. Pure functions only, no
// Node-only APIs, genuinely safe to be isomorphic.
//
// Type-only import (erased at compile time, no runtime dependency): this
// module is imported BY trip-workspace.ts itself (selectFallbackCandidate/
// buildLegalDayCandidatePool tracing), so a VALUE import back from
// trip-workspace.ts (e.g. normalizePlaceNameSlug) would be a genuine
// runtime circular import. computeCanonicalPlaceIdentity below takes an
// already-normalized name from the caller instead — every real caller
// already has normalizePlaceNameSlug in scope (it's defined in
// trip-workspace.ts, re-exported from itinerary-generation-constraints.ts)
// so this never means a second, drifting normalization definition.
import type { AiGeneratedItem, ScheduleItemRole } from "@/lib/trip-workspace";

export function isPlannerQaTraceEnabled(): boolean {
  return process.env.QA_DEBUG_GEOGRAPHY === "1" || process.env.CAPTURE_FIXTURES === "1" || process.env.PLANNER_QA_TRACE === "1";
}

/**
 * Where a real-place insertion/replacement came from — explicit at the
 * call site, never inferred later from a stack trace (spec "do not infer
 * this later from stack traces — pass it explicitly at insertion time").
 */
export type PlaceInsertionSource =
  | "gemini_initial"
  | "gemini_retry"
  | "deterministic_template"
  | "duplicate_repair"
  | "locality_repair"
  | "opening_hours_repair"
  | "anchor_repair"
  | "meal_repair"
  | "day_fill"
  | "transfer_repair"
  | "other_existing_path";

export type SyntheticInsertionSource = "free_time" | "meal_opportunity" | "practical_block";

export type InsertionAction = "INSERT" | "REPLACE" | "REMOVE" | "MOVE" | "COPY" | "REINSERT";

/**
 * Canonical physical-place identity — the SAME semantics
 * collectPlanDiagnostics' own duplicate check (buildPlaceKey,
 * itinerary-generation-constraints.ts) already uses: a recommendationId
 * is a definite identity claim; otherwise real coordinates + normalized
 * name; otherwise this is not a real-place claim at all (never a random
 * id here — unlike buildPlaceKey's own generic:${uuid} branch, which
 * exists only to guarantee two filler items never collide as duplicates,
 * a trace needs the SAME synthetic item to report the SAME identity
 * every time it's observed, not a fresh random one).
 */
export interface CanonicalPlaceIdentity {
  kind: "real" | "synthetic";
  /** Stable string identity for a real place; null for synthetic (no physical identity to speak of). */
  identity: string | null;
  recommendationId: string | null;
  normalizedName: string;
  lat: number | null;
  lon: number | null;
}

export function computeCanonicalPlaceIdentity(
  item: Pick<AiGeneratedItem, "recommendationId" | "name" | "lat" | "lon" | "itemRole">,
  /** From the caller's own normalizePlaceNameSlug(item.name) — see this module's own header comment for why it isn't imported here directly. */
  normalizedName: string
): CanonicalPlaceIdentity {
  const isSynthetic = item.itemRole != null && item.itemRole !== "real_place";

  if (!isSynthetic && item.recommendationId) {
    return { kind: "real", identity: `id:${item.recommendationId}`, recommendationId: item.recommendationId, normalizedName, lat: item.lat, lon: item.lon };
  }
  if (!isSynthetic && item.lat != null && item.lon != null) {
    return {
      kind: "real",
      identity: `coords:${item.lat.toFixed(3)}:${item.lon.toFixed(3)}:${normalizedName}`,
      recommendationId: item.recommendationId ?? null,
      normalizedName,
      lat: item.lat,
      lon: item.lon,
    };
  }
  return { kind: "synthetic", identity: null, recommendationId: null, normalizedName, lat: item.lat, lon: item.lon };
}

export interface PlaceInsertionEvent {
  sequence: number;
  action: InsertionAction;
  source: PlaceInsertionSource | SyntheticInsertionSource;
  dayNumber: number;
  ownerStay: string;
  dayType: string | null;
  category: string;
  itemRole: ScheduleItemRole | null;
  identity: CanonicalPlaceIdentity;
  alreadyUsedAtInsertion: boolean;
  usedByDays: number[];
  candidatePoolSize: number | null;
  legalPoolSize: number | null;
  passedLegalPool: boolean | null;
  reason: string | null;
}

let events: PlaceInsertionEvent[] = [];
let sequenceCounter = 0;

export function resetPlannerQaTrace(): void {
  events = [];
  sequenceCounter = 0;
}

export function getPlannerQaTraceEvents(): readonly PlaceInsertionEvent[] {
  return events;
}

/**
 * Spec "ONE AUTHORITATIVE TRACE HELPER" — every real-place insertion,
 * replacement, removal, move, copy, or reinsertion goes through this one
 * function. A no-op (besides returning the identity, which callers may
 * still want) when tracing is disabled, so this never affects production
 * behavior or performance.
 */
export function tracePlaceInsertion(args: {
  item: Pick<AiGeneratedItem, "recommendationId" | "name" | "lat" | "lon" | "category" | "itemRole">;
  /** The caller's own normalizePlaceNameSlug(item.name) — see computeCanonicalPlaceIdentity's own note. */
  normalizedName: string;
  dayNumber: number;
  source: PlaceInsertionSource | SyntheticInsertionSource;
  action: InsertionAction;
  ownerStay: string;
  dayType?: string | null;
  alreadyUsedAtInsertion?: boolean;
  usedByDays?: number[];
  candidatePoolSize?: number | null;
  legalPoolSize?: number | null;
  passedLegalPool?: boolean | null;
  reason?: string | null;
}): CanonicalPlaceIdentity {
  const identity = computeCanonicalPlaceIdentity(args.item, args.normalizedName);
  if (!isPlannerQaTraceEnabled()) return identity;

  sequenceCounter += 1;
  events.push({
    sequence: sequenceCounter,
    action: args.action,
    source: args.source,
    dayNumber: args.dayNumber,
    ownerStay: args.ownerStay,
    dayType: args.dayType ?? null,
    category: args.item.category,
    itemRole: args.item.itemRole ?? null,
    identity,
    alreadyUsedAtInsertion: args.alreadyUsedAtInsertion ?? false,
    usedByDays: args.usedByDays ?? [],
    candidatePoolSize: args.candidatePoolSize ?? null,
    legalPoolSize: args.legalPoolSize ?? null,
    passedLegalPool: args.passedLegalPool ?? null,
    reason: args.reason ?? null,
  });
  return identity;
}

/** Spec "LEGAL POOL OBSERVABILITY" — logged at every real-place selection point, not just successful ones. */
export interface LegalPoolStageLog {
  dayNumber: number;
  stage: "raw" | "after_geography_filter" | "after_semantic_role_filter" | "after_global_used_filter" | "final_legal_pool";
  size: number;
}

const legalPoolStageLogs: LegalPoolStageLog[] = [];

export function tracePoolStage(log: LegalPoolStageLog): void {
  if (!isPlannerQaTraceEnabled()) return;
  legalPoolStageLogs.push(log);
}

export function getPoolStageLogs(): readonly LegalPoolStageLog[] {
  return legalPoolStageLogs;
}

export function resetPoolStageLogs(): void {
  legalPoolStageLogs.length = 0;
}

/**
 * Spec "EXPLAIN THE LEGAL-POOL EXHAUSTIONS" — a pure aggregate read of the
 * SAME pool-stage logs buildLegalDayCandidatePool already emits (no new
 * instrumentation, per "we do NOT need more per-item spam"). Each call to
 * buildLegalDayCandidatePool emits exactly 4 stage entries in order (raw,
 * after_global_used_filter, after_geography_filter, final_legal_pool), so
 * consecutive groups of 4 correspond 1:1 with one candidate-selection
 * attempt — grouped positionally, not by dayNumber, since one day can make
 * several attempts (different slots/replacements) in a single generation.
 */
export type PoolExhaustionReason =
  | "no_candidate_for_stay"
  | "already_used_filter"
  | "geography_filter"
  | "other";

export function classifyPoolExhaustionReasons(
  logs: readonly LegalPoolStageLog[] = getPoolStageLogs()
): Record<PoolExhaustionReason, number> {
  const counts: Record<PoolExhaustionReason, number> = {
    no_candidate_for_stay: 0,
    already_used_filter: 0,
    geography_filter: 0,
    other: 0,
  };

  for (let index = 0; index + 3 < logs.length; index += 4) {
    const [raw, afterUsedFilter, , finalPool] = logs.slice(index, index + 4);
    if (raw?.stage !== "raw" || finalPool?.stage !== "final_legal_pool") continue; // misaligned group — skip rather than misclassify
    if (finalPool.size > 0) continue; // not an exhaustion

    if (raw.size === 0) counts.no_candidate_for_stay += 1;
    else if (afterUsedFilter && afterUsedFilter.size === 0) counts.already_used_filter += 1;
    else if (afterUsedFilter && afterUsedFilter.size > 0) counts.geography_filter += 1;
    else counts.other += 1;
  }

  return counts;
}

/**
 * Spec "DUPLICATE FORENSIC REPORT" — for a given canonical identity,
 * finds the FIRST recorded real-place insertion and every subsequent
 * (duplicate) insertion of the same identity, in trace sequence order.
 * Never matches synthetic items (kind "synthetic" has no identity string
 * to collide on) — spec "synthetic items do not pollute real-place
 * duplicate trace".
 */
export function findInsertionsByIdentity(canonicalIdentity: string): PlaceInsertionEvent[] {
  return events
    .filter((event) => event.identity.kind === "real" && event.identity.identity === canonicalIdentity)
    .sort((a, b) => a.sequence - b.sequence);
}

export interface DuplicateTraceReport {
  canonicalIdentity: string;
  firstOccurrence: PlaceInsertionEvent;
  duplicateOccurrence: PlaceInsertionEvent;
  sameRecommendationId: boolean;
  bypassedLegalPool: boolean;
  alreadyUsedAtInsertion: boolean;
}

/** Builds one forensic report per duplicate occurrence (2nd+) of a real canonical identity, in insertion order. */
export function buildDuplicateTraceReports(canonicalIdentity: string): DuplicateTraceReport[] {
  const occurrences = findInsertionsByIdentity(canonicalIdentity);
  if (occurrences.length < 2) return [];
  const [first, ...rest] = occurrences;
  return rest.map((duplicateOccurrence) => ({
    canonicalIdentity,
    firstOccurrence: first,
    duplicateOccurrence,
    sameRecommendationId: Boolean(
      first.identity.recommendationId && first.identity.recommendationId === duplicateOccurrence.identity.recommendationId
    ),
    bypassedLegalPool: duplicateOccurrence.passedLegalPool === false || duplicateOccurrence.passedLegalPool === null,
    alreadyUsedAtInsertion: duplicateOccurrence.alreadyUsedAtInsertion,
  }));
}

/** Compact, human-readable rendering of one duplicate forensic report — dev-only console output. */
export function formatDuplicateTraceReport(report: DuplicateTraceReport): string {
  return [
    "[DuplicateTrace]",
    JSON.stringify(
      {
        canonicalIdentity: report.canonicalIdentity,
        firstOccurrence: {
          day: report.firstOccurrence.dayNumber,
          source: report.firstOccurrence.source,
          insertionSequence: report.firstOccurrence.sequence,
          ownerStay: report.firstOccurrence.ownerStay,
          category: report.firstOccurrence.category,
          recommendationId: report.firstOccurrence.identity.recommendationId,
        },
        duplicateOccurrence: {
          day: report.duplicateOccurrence.dayNumber,
          source: report.duplicateOccurrence.source,
          insertionSequence: report.duplicateOccurrence.sequence,
          ownerStay: report.duplicateOccurrence.ownerStay,
          category: report.duplicateOccurrence.category,
          recommendationId: report.duplicateOccurrence.identity.recommendationId,
        },
        sameRecommendationId: report.sameRecommendationId,
        samePhysicalIdentity: true,
        bypassedLegalPool: report.bypassedLegalPool,
        alreadyUsedAtInsertion: report.alreadyUsedAtInsertion,
        insertionFunction: report.duplicateOccurrence.source,
      },
      null,
      2
    ),
  ].join(" ");
}
