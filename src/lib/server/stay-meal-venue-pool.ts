/**
 * Round 9.2.1 — STAY MEAL VENUE POOLS + CUISINE-AWARE MEAL PLANNING.
 *
 * A sibling to stay-activity-pool.ts, same architecture, same stable
 * TripFramePhase.id ownership — but for the OTHER half of "real places":
 * ordinary meal venues (restaurant/cafe, never a food_experience — those
 * stay in the activity pool, spec §18/§19). This module never decides
 * whether a candidate IS a meal venue (that's
 * activity-taxonomy.ts's determinePlanningRole, applied by the caller
 * before candidates ever reach buildStayMealVenuePool) — it only pools,
 * classifies (cuisine + meal-type suitability), scores, and tracks
 * diversity for the candidates it's given.
 *
 * Deliberately pure/synchronous, like stay-activity-pool.ts's own
 * non-refill exports — no network call lives here.
 */

import {
  classifyMealVenue,
  CUISINE_FAMILIES,
  type CuisineFamily,
  type CuisineSubtype,
  type MealType,
  type MealVenueClassification,
} from "@/lib/server/meal-cuisine-taxonomy";
import { scoreBudgetFitness, scoreRouteProximity, type TripPreferenceProfile } from "@/lib/server/itinerary-generation-constraints";
import type { TripFrame, TripFramePhase } from "@/lib/server/itinerary-planning-principles";
import { classifyActivity, determinePlanningRole } from "@/lib/server/activity-taxonomy";
import { assignCandidatesToStays } from "@/lib/server/stay-activity-pool";
import {
  evaluateScheduledPlaceLegality,
  type DestinationMobilityProfile,
  type RecommendationCategory,
  type TripPreferences,
  type TripRecommendation,
} from "@/lib/trip-workspace";
import { logRealPlaceQA } from "@/lib/server/real-place-qa";

/* ------------------------------------------------------------------ *
 * 1. MealVenueCandidate + StayMealVenuePool (spec §3/§4)               *
 * ------------------------------------------------------------------ */

export interface MealVenueCandidate {
  recommendationId: string;
  stayId: string;
  name: string;
  category: RecommendationCategory;
  classification: MealVenueClassification;
  lat: number | null;
  lon: number | null;
  location: string;
  openingHours: string;
  approximatePrice: number | null;
  reservationRequired: boolean | null;
  source: TripRecommendation["source"];
}

export type CuisineSupply = Partial<Record<CuisineFamily, number>>;
export type MealTypeSupply = Partial<Record<MealType, number>>;

export interface StayMealVenuePoolDiagnostics {
  initialCandidateCount: number;
  resolvedCandidateCount: number;
  legalCandidateCount: number;
  dedupeRejected: number;
  geographyRejected: number;
  cuisineBreakdown: CuisineSupply;
  mealTypeBreakdown: MealTypeSupply;
}

export interface StayMealVenuePool {
  stayId: string;
  ownerArea: string;
  anchor: { lat: number; lon: number } | null;
  venues: MealVenueCandidate[];
  cuisineSupply: CuisineSupply;
  mealTypeSupply: MealTypeSupply;
  diagnostics: StayMealVenuePoolDiagnostics;
}

/**
 * Builds ONE stay's meal-venue pool from candidates already canonically
 * assigned to it (the caller runs its own MEAL_VENUE-role filter — see
 * activity-taxonomy.ts's determinePlanningRole — before calling this, the
 * same way buildStayActivityPool receives only activity-role candidates).
 * Applies the SAME geography legality rule the activity pool uses
 * (evaluateScheduledPlaceLegality against this stay's own anchor) — a meal
 * venue outside the stay's real mobility radius is never pool-eligible
 * (spec §1: "They remain REAL PLACES for geography... scheduling").
 */
export function buildStayMealVenuePool(
  phase: TripFramePhase,
  ownedMealCandidates: TripRecommendation[],
  anchor: { lat: number; lon: number } | null,
  mobilityProfile: DestinationMobilityProfile,
  dailyCapacityMinutes: number
): StayMealVenuePool {
  const initialCandidateCount = ownedMealCandidates.length;
  const seen = new Set<string>();
  let dedupeRejected = 0;
  let geographyRejected = 0;
  const cuisineBreakdown: CuisineSupply = {};
  const mealTypeBreakdown: MealTypeSupply = {};
  const venues: MealVenueCandidate[] = [];

  for (const candidate of ownedMealCandidates) {
    const dedupeKey = candidate.id || `${candidate.name}|${candidate.lat}|${candidate.lon}`;
    if (seen.has(dedupeKey)) {
      dedupeRejected += 1;
      continue;
    }
    seen.add(dedupeKey);

    if (candidate.lat != null && candidate.lon != null && anchor) {
      const legal = evaluateScheduledPlaceLegality({
        placeLat: candidate.lat,
        placeLon: candidate.lon,
        dayType: "normal",
        stayAnchor: anchor,
        mobilityProfile,
        dailyCapacityMinutes,
        visitMinutes: candidate.estimatedDurationMinutes,
      }).legal;
      if (!legal) {
        geographyRejected += 1;
        continue;
      }
    }

    const classification = classifyMealVenue({
      category: candidate.category,
      name: candidate.name,
      shortDescription: candidate.shortDescription,
      openingHours: candidate.openingHours,
      recommendedTimeOfDay: candidate.recommendedTimeOfDay,
      approximatePrice: candidate.approximatePrice,
      reservationRequired: candidate.reservationRequired,
    });

    for (const family of classification.cuisineFamilies) {
      cuisineBreakdown[family] = (cuisineBreakdown[family] ?? 0) + 1;
    }
    for (const mealType of classification.suitableMealTypes) {
      mealTypeBreakdown[mealType] = (mealTypeBreakdown[mealType] ?? 0) + 1;
    }

    venues.push({
      recommendationId: candidate.id,
      stayId: phase.id,
      name: candidate.name,
      category: candidate.category,
      classification,
      lat: candidate.lat,
      lon: candidate.lon,
      location: candidate.location,
      openingHours: candidate.openingHours,
      approximatePrice: candidate.approximatePrice,
      reservationRequired: candidate.reservationRequired,
      source: candidate.source,
    });
  }

  // Round 9.4 §I — the meal analogue of the ActivityPool log; we
  // specifically need to explain why the recent production PDF also
  // reported zero real food stops, not only zero activities.
  logRealPlaceQA("MealPool", {
    stayId: phase.id,
    ownerArea: phase.areaLabel,
    inputCandidates: initialCandidateCount,
    poolSize: venues.length,
    rejectedDuplicate: dedupeRejected,
    rejectedTooFar: geographyRejected,
    cuisineDistribution: cuisineBreakdown,
    candidateSample: venues.slice(0, 10).map((v) => ({ id: v.recommendationId, name: v.name, category: v.category, lat: v.lat, lon: v.lon, source: v.source })),
  });

  return {
    stayId: phase.id,
    ownerArea: phase.areaLabel,
    anchor,
    venues,
    cuisineSupply: cuisineBreakdown,
    mealTypeSupply: mealTypeBreakdown,
    diagnostics: {
      initialCandidateCount,
      resolvedCandidateCount: initialCandidateCount - dedupeRejected,
      legalCandidateCount: venues.length,
      dedupeRejected,
      geographyRejected,
      cuisineBreakdown,
      mealTypeBreakdown,
    },
  };
}

/**
 * Round 9.3 §10/§11 — builds every stay's OWN meal-venue pool in one call,
 * the exact sibling of buildTripActivityPortfolios (stay-activity-pool.ts):
 * same assignCandidatesToStays ownership pass, same per-phase loop. This is
 * THE function the composer calls so it receives a literal
 * StayMealVenuePool per stay — never a second inline pseudo-pool built ad
 * hoc from payload.recommendations at selection time.
 */
export function buildTripMealVenuePools(
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  recommendations: TripRecommendation[],
  dailyCapacityMinutes: number,
  normalizeAreaLabelFn: (raw: string) => string,
  resolveTextualAreaMatchFn: (locationText: string, areaLabel: string) => boolean
): Map<string, StayMealVenuePool> {
  // Only MEAL_VENUE-role candidates are ever pool-eligible (spec §1/§19,
  // Round 9.2.1) — a food_experience-classified candidate belongs to the
  // activity pool instead, never double-counted here.
  const mealCandidates = recommendations.filter(
    (candidate) =>
      determinePlanningRole(
        candidate.category,
        classifyActivity({
          category: candidate.category,
          name: candidate.name,
          shortDescription: candidate.shortDescription,
          reservationRequired: candidate.reservationRequired,
          approximatePrice: candidate.approximatePrice,
          recommendedTimeOfDay: candidate.recommendedTimeOfDay,
        })
      ) === "MEAL_VENUE"
  );
  const ownershipByStay = assignCandidatesToStays(mealCandidates, tripFrame, areaAnchors, normalizeAreaLabelFn, resolveTextualAreaMatchFn);

  const poolsByStay = new Map<string, StayMealVenuePool>();
  for (const phase of tripFrame.phases) {
    const anchor = areaAnchors.get(phase.areaLabel) ?? null;
    poolsByStay.set(phase.id, buildStayMealVenuePool(phase, ownershipByStay.get(phase.id) ?? [], anchor, mobilityProfile, dailyCapacityMinutes));
  }
  return poolsByStay;
}

/* ------------------------------------------------------------------ *
 * 2. Trip-wide cuisine diversity memory (spec §12)                     *
 * ------------------------------------------------------------------ */

export interface RecentMealHistoryEntry {
  dayIndex: number;
  mealType: MealType;
  cuisineFamilies: CuisineFamily[];
  cuisineSubtypes: CuisineSubtype[];
}

const RECENT_CUISINE_SUBTYPE_PENALTY_BASE = 20;
const RECENT_CUISINE_FAMILY_PENALTY_BASE = 6;
export const RECENT_MEAL_HISTORY_DECAY_DAYS = 4;

function recencyPenalty(dayDistance: number, base: number): number {
  if (dayDistance >= RECENT_MEAL_HISTORY_DECAY_DAYS) return 0;
  return Math.round(base * (1 - dayDistance / RECENT_MEAL_HISTORY_DECAY_DAYS));
}

/**
 * Soft repetition penalty only (spec §12: "No hard cuisine bans") — a
 * cuisine SUBTYPE repeated on a recent day is penalized more than a shared
 * FAMILY (matches stay-activity-pool.ts's computeRecencyPenalty shape
 * exactly, same linear decay over a few days rather than the whole trip).
 */
export function computeMealCuisineRecencyPenalty(
  classification: Pick<MealVenueClassification, "cuisineFamilies" | "cuisineSubtypes">,
  recentHistory: RecentMealHistoryEntry[],
  currentDayIndex: number
): number {
  let penalty = 0;
  for (const entry of recentHistory) {
    const dayDistance = Math.max(0, currentDayIndex - entry.dayIndex);
    const sharedSubtype = classification.cuisineSubtypes.some((s) => entry.cuisineSubtypes.includes(s));
    const sharedFamily = classification.cuisineFamilies.some((f) => entry.cuisineFamilies.includes(f));
    if (sharedSubtype) penalty += recencyPenalty(dayDistance, RECENT_CUISINE_SUBTYPE_PENALTY_BASE);
    else if (sharedFamily) penalty += recencyPenalty(dayDistance, RECENT_CUISINE_FAMILY_PENALTY_BASE);
  }
  return penalty;
}

export function appendMealToHistory(
  recentHistory: RecentMealHistoryEntry[],
  dayIndex: number,
  mealType: MealType,
  classification: Pick<MealVenueClassification, "cuisineFamilies" | "cuisineSubtypes">
): RecentMealHistoryEntry[] {
  return [...recentHistory, { dayIndex, mealType, cuisineFamilies: classification.cuisineFamilies, cuisineSubtypes: classification.cuisineSubtypes }];
}

/* ------------------------------------------------------------------ *
 * 3. Deterministic meal-venue scoring (spec §10/§11)                   *
 * ------------------------------------------------------------------ */

export interface MealSelectionContext {
  mealType: MealType;
  anchor: Pick<TripRecommendation, "name" | "location" | "lat" | "lon"> | null;
  nextAnchor: Pick<TripRecommendation, "name" | "location" | "lat" | "lon"> | null;
  pace: TripPreferences["tripPace"];
  transportation: string;
  hardLimitMinutes?: number;
  idealLimitMinutes?: number;
  explicitRequest?: boolean;
  recentHistory: RecentMealHistoryEntry[];
  dayIndex: number;
  cuisineWeights: Record<CuisineFamily, number>;
  usedRecommendationIds: Set<string>;
}

export interface MealVenueScoreResult {
  score: number;
  /** False when the venue's own suitableMealTypes evidence does not support this exact mealType (spec §9's hard-ish gate — not a legality constraint, but excluded from selection all the same, never merely nudged down enough to still occasionally win). Unknown suitability (empty array) also counts as unfit — spec §8 "unknown must remain unknown", never treated as a match. */
  mealTypeFit: boolean;
}

/**
 * THE deterministic meal-venue score (spec §11's own worked formula) — every
 * term is either reused from an existing, already-tested helper
 * (scoreRouteProximity for geographic/route fit, scoreBudgetFitness for
 * price fit) or a new, narrow, disclosed term (cuisine preference/local
 * value/diversity, all soft). No fabricated rating/review signal anywhere.
 */
export function scoreMealVenueCandidate(
  candidate: MealVenueCandidate,
  context: MealSelectionContext,
  profile: TripPreferenceProfile
): MealVenueScoreResult {
  const mealTypeFit = candidate.classification.suitableMealTypes.includes(context.mealType);
  if (!mealTypeFit) {
    // Not an outright -Infinity: still a real, comparable number so callers
    // that want to see "least-bad" for diagnostics can, but no selection
    // path in this module ever picks a mealTypeFit:false candidate over a
    // fit:true one, or over the synthetic fallback (spec §9/§21).
    return { score: -1000, mealTypeFit: false };
  }

  let score = 0;
  const proximity = scoreRouteProximity(candidate, {
    anchor: context.anchor,
    nextStop: context.nextAnchor,
    pace: context.pace,
    transportation: context.transportation,
    hardLimitMinutes: context.hardLimitMinutes,
    idealLimitMinutes: context.idealLimitMinutes,
    explicitRequest: context.explicitRequest,
  });
  score += proximity.score;
  if (proximity.exceedsLimit && !context.explicitRequest) score -= 36;

  score += scoreBudgetFitness(candidate, context.mealType === "DINNER" ? "dinner" : "lunch", profile);

  // Cuisine preference fit (spec §11/§14) — weight-based, never exclusionary.
  const cuisineWeight = Math.max(1, ...candidate.classification.cuisineFamilies.map((f) => context.cuisineWeights[f] ?? 1), 1);
  score += Math.round((cuisineWeight - 1) * 20);

  // Local-cuisine relevance (spec §13) — a modest, always-available bonus,
  // never enough on its own to override a genuinely bad route/budget fit.
  if (candidate.classification.cuisineFamilies.includes("LOCAL_TRADITIONAL")) score += 10;

  // Cuisine diversity (spec §12) — soft repetition penalty only.
  score -= computeMealCuisineRecencyPenalty(candidate.classification, context.recentHistory, context.dayIndex);

  // Round 9.4.3 §D/§I — already-used exclusion moved to selectMealVenueFromPool
  // itself (a hard filter, before this function is even called) — see its
  // own docstring. A used candidate never reaches this scoring function at
  // all any more, so no penalty term for it belongs here.

  return { score, mealTypeFit: true };
}

/**
 * Picks the best-fit venue for one meal slot from a pool, or null when
 * nothing in the pool has real mealType-suitability evidence (spec §9/§21 —
 * the caller falls back to a synthetic MealOpportunity rather than misusing
 * an unsuitable venue). Never returns a mealTypeFit:false candidate.
 *
 * Round 9.4.3 §D/§I root-cause fix — proven production evidence
 * (traceId gen-mu7kn7ef-s9cg5z4x: "Punjab", "Pasha", "Venice Italian
 * Kitchen", "Gorham Dynasty Buffet", "Libby's Bistro" each duplicated
 * across two days). scoreMealVenueCandidate's own usedRecommendationIds
 * check was only ever a -25 SOFT score penalty, not an exclusion — an
 * objectively best-fit venue easily survives a -25 nudge and gets
 * selected AGAIN even though it is already scheduled elsewhere in this
 * exact trip, real-place-duplicating it outright. Every real caller of
 * this function (insertMealFromPool, backfillRealMealVenues) already
 * treats a null return as "fall back to a synthetic MealOpportunity /
 * placeholder", never as "leave the day with nothing" — so the correct
 * fix is a hard exclusion, not a softer penalty: only ever return a
 * venue not already used trip-wide (spec §I "unused legal real meal ->
 * another unused legal real meal -> MealOpportunity if supply
 * exhausted" — note a REPEAT is never one of the listed tiers). When the
 * whole pool is already used, this returns null exactly like the
 * mealTypeFit:false case, and the caller's own existing synthetic
 * fallback takes over — never a duplicated recommendationId.
 */
export function selectMealVenueFromPool(
  pool: StayMealVenuePool,
  context: MealSelectionContext,
  profile: TripPreferenceProfile
): { candidate: MealVenueCandidate; score: number } | null {
  let best: { candidate: MealVenueCandidate; score: number } | null = null;
  for (const candidate of pool.venues) {
    if (context.usedRecommendationIds.has(candidate.recommendationId)) continue;
    const result = scoreMealVenueCandidate(candidate, context, profile);
    if (!result.mealTypeFit) continue;
    if (!best || result.score > best.score) best = { candidate, score: result.score };
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 4. Optional Gemini meal-selection contract (spec §23)                *
 * ------------------------------------------------------------------ */

export interface GeminiMealSelectionInput {
  selectedCandidateId: string;
}

export interface ValidatedGeminiMealSelection {
  candidate: MealVenueCandidate | null;
  rejectedUnknownId: string | null;
}

/**
 * Same discipline as stay-activity-pool.ts's validateGeminiPortfolioSelection
 * — Gemini may only choose an ID that genuinely exists in THIS stay's own
 * meal pool; an unknown id is rejected, never scheduled, never guessed into
 * the nearest real name. The deterministic selectMealVenueFromPool above
 * works completely independently of this — Gemini is optional everywhere in
 * this module.
 */
export function validateGeminiMealSelection(
  pool: StayMealVenuePool,
  selection: GeminiMealSelectionInput
): ValidatedGeminiMealSelection {
  const candidate = pool.venues.find((v) => v.recommendationId === selection.selectedCandidateId) ?? null;
  return {
    candidate,
    rejectedUnknownId: candidate ? null : selection.selectedCandidateId,
  };
}

export { CUISINE_FAMILIES };
