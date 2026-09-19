/**
 * Round 9 — STAY ACTIVITY POOLS + DIVERSITY-AWARE PORTFOLIO PLANNER.
 *
 * The architectural change spec §"CORE ARCHITECTURAL PRINCIPLE" asks for:
 * stop constructing days independently and repairing them after the fact;
 * instead, BEFORE any day is scheduled, know how much real content a stay
 * needs, discover/classify/rank a real candidate pool for it, and select a
 * diverse portfolio the day-builder (and every later repair pass) draws
 * from. This module is that layer. It is deliberately pure/synchronous
 * except `refillStayActivityPool`, the one function that makes a real
 * network call — everything else operates on data the caller already has.
 *
 * Ownership is keyed by the STABLE TripFramePhase.id (spec §2: "Do NOT key
 * ownership by display strings") — never an area-label string.
 */

import {
  ACTIVITY_FAMILIES,
  buildPreferenceFamilyWeights,
  classifyActivity,
  determinePlanningRole,
  type ActivityClassification,
  type ActivityFamily,
  type ActivitySubtype,
} from "@/lib/server/activity-taxonomy";
import type { TripFrame, TripFramePhase } from "@/lib/server/itinerary-planning-principles";
import { queryNearbyRecommendationsDetailed, type FetchLike, type OverpassNearbyRecommendation } from "@/lib/places/overpass";
import {
  evaluateScheduledPlaceLegality,
  haversineKm,
  type DestinationMobilityProfile,
  type RecommendationCategory,
  type TripRecommendation,
} from "@/lib/trip-workspace";
import type { DerivedDayType } from "@/lib/server/country-itinerary-generation";
import { classifyZeroPoolReason, logRealPlaceQA } from "@/lib/server/real-place-qa";

/* ------------------------------------------------------------------ *
 * 1. Capacity-driven pool sizing (spec §3)                             *
 * ------------------------------------------------------------------ */

export interface StayDayCapacityInput {
  dayNumber: number;
  dayType: DerivedDayType;
  /** An explicit restWindow already on the day (post-generation), or a caller's pre-generation intent signal. */
  hasExplicitRestWindow: boolean;
  /** Usable hours for arrival/departure days only — omit/undefined when unknown (defaults conservatively). */
  usableHours?: number | null;
}

/**
 * The per-day REAL-activity TARGET (a midpoint estimate, not a hard rule —
 * the hard minimum lives in country-itinerary-generation.ts's own
 * minimumMeaningfulRealActivities; this is the richer, capacity-aware
 * number used to size the CANDIDATE POOL, spec §3's own worked examples).
 * Never a flat hardcoded "3/day" — scales with day type and, for arrival/
 * departure, with actual usable hours when known.
 */
export function estimateDayActivityTarget(input: StayDayCapacityInput): number {
  switch (input.dayType) {
    case "arrival":
    case "departure": {
      if (input.usableHours == null) return 1; // unknown usable time — a conservative single-activity assumption
      return Math.max(0, Math.min(2, input.usableHours / 4));
    }
    case "transfer":
      return 0.5;
    case "day_trip":
      return 2; // the anchor itself + a realistic chance of one more stop
    case "normal":
    default:
      return input.hasExplicitRestWindow ? 1.5 : 3; // midpoints of spec §3's 1-2 / 2-4 ranges
  }
}

export interface StayCapacityResult {
  usableSightseeingDays: number;
  requiredRealActivityTarget: number;
  perDayTargets: Array<{ dayNumber: number; dayType: DerivedDayType; targetRealActivities: number }>;
}

/**
 * Centralized reserve policy (spec §3: "Centralize the reserve policy. Do
 * not scatter magic numbers.") — candidates will be rejected downstream for
 * duplicates/geography/hours/budget/category repetition/schedule conflicts,
 * so the discovery target is always a multiple of what's actually required,
 * never a 1:1 count. A small stay still gets a usable floor (MIN_RESERVE)
 * so a 1-night stay isn't reduced to "find exactly 1 candidate."
 */
export const CANDIDATE_RESERVE_FACTOR = 2.5;
const MIN_DESIRED_CANDIDATE_COUNT = 4;

export function computeStayCapacity(days: StayDayCapacityInput[]): StayCapacityResult {
  const perDayTargets = days.map((day) => ({
    dayNumber: day.dayNumber,
    dayType: day.dayType,
    targetRealActivities: estimateDayActivityTarget(day),
  }));
  const requiredRealActivityTarget = Math.round(
    perDayTargets.reduce((sum, day) => sum + day.targetRealActivities, 0)
  );
  const usableSightseeingDays = days.filter((day) => day.dayType === "normal" || day.dayType === "day_trip").length;
  return { usableSightseeingDays, requiredRealActivityTarget, perDayTargets };
}

/** THE one place `desiredCandidateCount` is computed — every caller (initial discovery sizing, refill sizing, tests) goes through this. */
export function computeDesiredCandidateCount(requiredRealActivityTarget: number): number {
  return Math.max(MIN_DESIRED_CANDIDATE_COUNT, Math.ceil(requiredRealActivityTarget * CANDIDATE_RESERVE_FACTOR));
}

/**
 * Round 9.1 §16 — the OTHER pool-sizing number, deliberately smaller than
 * `desiredCandidateCount`: not "the healthy reserve we'd like", but "enough
 * real candidates to actually construct usable days at all". Missing the
 * TARGET (desiredCandidateCount) only degrades quality/reserve depth and is
 * never itself a generation failure; missing the MINIMUM is what
 * `InsufficientRealActivitySupplyError` actually gates on (spec §16/§17 —
 * "distinguish TARGET from MINIMUM").
 */
const MINIMUM_VIABLE_RESERVE_FACTOR = 1;
export function computeMinimumViableCandidateCount(requiredRealActivityTarget: number): number {
  return Math.max(1, Math.ceil(requiredRealActivityTarget * MINIMUM_VIABLE_RESERVE_FACTOR));
}

/* ------------------------------------------------------------------ *
 * 2. Canonical stay ownership (spec §2)                                *
 * ------------------------------------------------------------------ */

/**
 * Assigns every candidate with real coordinates to exactly ONE stay (the
 * geographically nearest phase anchor) — "nearby shared candidates may be
 * evaluated for multiple stays during discovery, but before portfolio
 * selection they must receive canonical ownership" (spec §2). A
 * coordinate-less candidate falls back to a normalized-area-label text
 * match against each phase's own areaLabel; one that matches none is
 * simply never owned by any stay pool (never guessed).
 */
export function assignCandidatesToStays(
  candidates: TripRecommendation[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  normalizeAreaLabelFn: (raw: string) => string,
  resolveTextualAreaMatchFn: (locationText: string, areaLabel: string) => boolean
): Map<string, TripRecommendation[]> {
  const byStay = new Map<string, TripRecommendation[]>();
  for (const phase of tripFrame.phases) byStay.set(phase.id, []);

  const phaseAnchors = tripFrame.phases.map((phase) => ({
    phase,
    anchor: areaAnchors.get(phase.areaLabel) ?? null,
  }));

  for (const candidate of candidates) {
    if (candidate.lat != null && candidate.lon != null) {
      let bestPhaseId: string | null = null;
      let bestDistanceKm = Infinity;
      for (const { phase, anchor } of phaseAnchors) {
        if (!anchor) continue;
        const distanceKm = haversineKm(anchor.lat, anchor.lon, candidate.lat, candidate.lon);
        if (distanceKm < bestDistanceKm) {
          bestDistanceKm = distanceKm;
          bestPhaseId = phase.id;
        }
      }
      if (bestPhaseId) {
        byStay.get(bestPhaseId)!.push(candidate);
        continue;
      }
    }
    // No coordinates (or no phase has a resolvable anchor at all) — fall
    // back to a text match against each phase's own area label.
    const normalizedLocation = normalizeAreaLabelFn(candidate.location);
    if (!normalizedLocation) continue;
    for (const phase of tripFrame.phases) {
      if (resolveTextualAreaMatchFn(normalizedLocation, phase.areaLabel)) {
        byStay.get(phase.id)!.push(candidate);
        break;
      }
    }
  }

  return byStay;
}

/* ------------------------------------------------------------------ *
 * 3. Significance (spec §8) — deterministic, no fabricated data        *
 * ------------------------------------------------------------------ */

/**
 * A 0-100 destination-significance score built ONLY from signals the
 * pipeline actually has: explicit user selection (source), a must-visit
 * keyword match, and a real "requires reservation" signal (a mild, honest
 * proxy — many destination-defining sites are reservation-gated; this is
 * never treated as a strong signal on its own). NEVER fabricates a
 * rating/review-count/popularity number the provider didn't supply.
 * `externalRankHint` is an explicit extension point (spec §8: "Gemini
 * ranking among a bounded legal pool") — 0-1, left undefined when no such
 * ranking was actually computed; this module never invents one itself.
 */
export function computeSignificance(
  candidate: TripRecommendation,
  mustVisitKeywords: string[],
  externalRankHint?: number
): number {
  let score = 40; // neutral baseline — every real candidate starts "ordinary"
  if (candidate.source === "saved" || candidate.source === "manual") score += 30;
  const haystack = `${candidate.name} ${candidate.shortDescription}`.toLowerCase();
  if (mustVisitKeywords.some((keyword) => keyword.trim() && haystack.includes(keyword.trim().toLowerCase()))) {
    score += 25;
  }
  if (candidate.reservationRequired) score += 5;
  if (externalRankHint != null) score += Math.round(externalRankHint * 30);
  return Math.max(0, Math.min(100, score));
}

/* ------------------------------------------------------------------ *
 * 4. StayActivityPool                                                  *
 * ------------------------------------------------------------------ */

export interface StayActivityPoolCandidate {
  recommendationId: string;
  name: string;
  category: RecommendationCategory;
  classification: ActivityClassification;
  significance: number;
  lat: number | null;
  lon: number | null;
  location: string;
  source: TripRecommendation["source"];
}

export type CategorySupply = Partial<Record<ActivityFamily, number>>;

export interface StayActivityPoolDiagnostics {
  initialCandidateCount: number;
  resolvedCandidateCount: number;
  legalCandidateCount: number;
  desiredCandidateCount: number;
  refillAttempts: number;
  refillCandidateCount: number;
  providerFailures: number;
  /** Round 9.1 §6 — wall-clock actually spent waiting on this stay's provider calls (refill only; initial discovery time isn't attributed here). */
  providerElapsedMs: number;
  /** Round 9.1 §6/§9 — a request that genuinely timed out (AbortError-shaped), as opposed to a clean non-timeout failure. */
  providerTimeouts: number;
  dedupeRejected: number;
  geographyRejected: number;
  /** Round 9.2.1 §1 — candidates excluded because determinePlanningRole classified them as MEAL_VENUE (ordinary restaurant/cafe/bakery/bar), never counted toward this pool's own targets/diagnostics — visible here only so "why is this pool smaller than the raw candidate count" is never a mystery. These candidates are not lost: the caller routes them to buildStayMealVenuePool instead. */
  mealVenueExcluded: number;
  classificationBreakdown: CategorySupply;
  /** Round 9.1 §9/§16 — true once the GLOBAL refill time budget was exhausted before this stay reached its own desired count; the stay proceeds with whatever it already collected rather than blocking further. */
  supplyDegraded: boolean;
  /** Round 9.3.4 §8 — per-group discovery accounting for THIS stay's round-0 grouped query pass. Optional so every pre-existing object literal built before this round (tests, fixtures) stays valid without updating each one — populated for real by refillStayActivityPool/refillTripRecommendationPool. */
  groupResults?: QueryGroupResult[];
}

export interface StayActivityPool {
  stayId: string;
  ownerArea: string;
  anchor: { lat: number; lon: number } | null;
  usableDayCapacity: number;
  requiredRealActivityTarget: number;
  desiredCandidateCount: number;
  /** Round 9.1 §16 — the smaller "can we build usable days at all" floor; see computeMinimumViableCandidateCount. */
  minimumViableCandidateCount: number;
  candidates: StayActivityPoolCandidate[];
  categorySupply: CategorySupply;
  diagnostics: StayActivityPoolDiagnostics;
}

/**
 * Builds ONE stay's pool from candidates already canonically assigned to it
 * (assignCandidatesToStays) — classifies, scores significance, and applies
 * the SAME geography legality rule the rest of the pipeline uses
 * (evaluateScheduledPlaceLegality against this stay's own anchor) so a pool
 * candidate is never a place enforceNormalDayLocality would reject anyway.
 */
export function buildStayActivityPool(
  phase: TripFramePhase,
  ownedCandidates: TripRecommendation[],
  anchor: { lat: number; lon: number } | null,
  mobilityProfile: DestinationMobilityProfile,
  capacity: StayCapacityResult,
  mustVisitKeywords: string[],
  dailyCapacityMinutes: number
): StayActivityPool {
  const initialCandidateCount = ownedCandidates.length;
  const desiredCandidateCount = computeDesiredCandidateCount(capacity.requiredRealActivityTarget);

  const seen = new Set<string>();
  let dedupeRejected = 0;
  let geographyRejected = 0;
  let mealVenueExcluded = 0;
  const classificationBreakdown: CategorySupply = {};
  const poolCandidates: StayActivityPoolCandidate[] = [];

  for (const candidate of ownedCandidates) {
    const dedupeKey = candidate.id || `${candidate.name}|${candidate.lat}|${candidate.lon}`;
    if (seen.has(dedupeKey)) {
      dedupeRejected += 1;
      continue;
    }
    seen.add(dedupeKey);

    const classification = classifyActivity({
      category: candidate.category,
      name: candidate.name,
      shortDescription: candidate.shortDescription,
      reservationRequired: candidate.reservationRequired,
      approximatePrice: candidate.approximatePrice,
      recommendedTimeOfDay: candidate.recommendedTimeOfDay,
    });

    // Round 9.2.1 §1/§19 — an ordinary meal venue (restaurant/cafe/bakery/
    // bar, never a food_experience) is NOT sightseeing-portfolio material;
    // it belongs to the separate StayMealVenuePool (stay-meal-venue-pool.ts)
    // instead. Excluded here, before geography/significance are ever
    // computed for it, so it can never satisfy requiredRealActivityTarget,
    // desiredCandidateCount, or portfolio selection.
    if (determinePlanningRole(candidate.category, classification) === "MEAL_VENUE") {
      mealVenueExcluded += 1;
      continue;
    }

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

    classificationBreakdown[classification.primaryFamily] = (classificationBreakdown[classification.primaryFamily] ?? 0) + 1;

    poolCandidates.push({
      recommendationId: candidate.id,
      name: candidate.name,
      category: candidate.category,
      classification,
      significance: computeSignificance(candidate, mustVisitKeywords),
      lat: candidate.lat,
      lon: candidate.lon,
      location: candidate.location,
      source: candidate.source,
    });
  }

  const pool: StayActivityPool = {
    stayId: phase.id,
    ownerArea: phase.areaLabel,
    anchor,
    usableDayCapacity: capacity.usableSightseeingDays,
    requiredRealActivityTarget: capacity.requiredRealActivityTarget,
    desiredCandidateCount,
    minimumViableCandidateCount: computeMinimumViableCandidateCount(capacity.requiredRealActivityTarget),
    candidates: poolCandidates,
    categorySupply: classificationBreakdown,
    diagnostics: {
      initialCandidateCount,
      resolvedCandidateCount: poolCandidates.length,
      legalCandidateCount: poolCandidates.length,
      desiredCandidateCount,
      refillAttempts: 0,
      refillCandidateCount: 0,
      providerFailures: 0,
      providerElapsedMs: 0,
      providerTimeouts: 0,
      dedupeRejected,
      geographyRejected,
      mealVenueExcluded,
      classificationBreakdown,
      supplyDegraded: false,
    },
  };

  // Round 9.4 §E/§F/§G/§H — one combined log covering the normalization/
  // geography/role-classification funnel (the SAME counters this function
  // already tracks — dedupeRejected/geographyRejected/mealVenueExcluded/
  // classificationBreakdown — never a second, parallel counting pass) and
  // the pool itself, with an explicit zeroPoolReason enum whenever the
  // pool ends up empty (spec §H: "do NOT just log 0").
  logRealPlaceQA("ActivityPool", {
    stayId: phase.id,
    ownerArea: phase.areaLabel,
    requiredRealActivities: capacity.requiredRealActivityTarget,
    inputCandidates: initialCandidateCount,
    poolSize: poolCandidates.length,
    rejectedDuplicate: dedupeRejected,
    rejectedTooFar: geographyRejected,
    rejectedMealRole: mealVenueExcluded,
    activityFamilies: classificationBreakdown,
    supplyState: pool.diagnostics.legalCandidateCount < pool.minimumViableCandidateCount ? "BELOW_MINIMUM" : "HEALTHY",
    providerRequests: pool.diagnostics.refillAttempts,
    providerFailures: pool.diagnostics.providerFailures,
    providerTimeouts: pool.diagnostics.providerTimeouts,
    candidateIds: poolCandidates.slice(0, 30).map((c) => c.recommendationId),
    candidateNames: poolCandidates.slice(0, 30).map((c) => c.name),
    zeroPoolReason: poolCandidates.length === 0 ? classifyZeroPoolReason(pool.diagnostics) : undefined,
  });

  return pool;
}

/* ------------------------------------------------------------------ *
 * 5. Real provider refill (spec §4)                                    *
 * ------------------------------------------------------------------ */

/** RecommendationCategory families this refill will actually ask Overpass for — the same categories queryOverpassPlaces already knows how to tag-filter (categoryHasOpenDataSource), never an invented tag set. */
const REFILLABLE_CATEGORIES: RecommendationCategory[] = [
  "attraction",
  "museum",
  "nature",
  "shopping",
  "nightlife",
  "family",
];

/**
 * Round 9.3.4 §3 — the single ~15-selector combined query
 * (all of REFILLABLE_CATEGORIES in one request) is what was observed to be
 * unreliable against the real public Overpass API (frequent timeouts /
 * empty responses under load). Split into 3 small, coherent groups instead
 * — never the old 13-category-per-call waterfall, never one call per
 * category either. Grouping is derived from the SAME category taxonomy
 * already established here (REFILLABLE_CATEGORIES/CATEGORY_TAG_FILTERS),
 * not a new one: culture/landmark (museum+attraction) is the single
 * highest-value "meaningful sightseeing" group; nature/leisure and
 * entertainment/shopping follow. No country/city-specific behavior.
 */
export type ActivityQueryGroupId = "culture_landmark" | "nature_leisure" | "entertainment_shopping" | "meal_venues";

export interface ActivityQueryGroupDefinition {
  groupId: ActivityQueryGroupId;
  categories: RecommendationCategory[];
  /** Which ActivityFamily this group's default priority is scored against (buildPreferenceFamilyWeights) — reuses the EXISTING preference-weighting mechanism (spec §4 "use existing preferences/taxonomy"), never a new one. */
  primaryFamily: ActivityFamily;
}

export const ACTIVITY_QUERY_GROUPS: ActivityQueryGroupDefinition[] = [
  { groupId: "culture_landmark", categories: ["museum", "attraction"], primaryFamily: "CULTURE" },
  { groupId: "nature_leisure", categories: ["nature", "family"], primaryFamily: "NATURE" },
  { groupId: "entertainment_shopping", categories: ["nightlife", "shopping"], primaryFamily: "ENTERTAINMENT" },
];

/** Round 9.3.4 §12 — meal venues get their OWN small, coherent group, never mixed into every sightseeing query and never previously discovered via Overpass refill at all (REFILLABLE_CATEGORIES excluded restaurant/cafe entirely). */
export const MEAL_QUERY_GROUP: ActivityQueryGroupDefinition = {
  groupId: "meal_venues",
  categories: ["restaurant", "cafe"],
  primaryFamily: "FOOD",
};

/**
 * Round 9.3.4 §4 — order the 3 activity groups by this trip's own real
 * preference weighting (buildPreferenceFamilyWeights, already used by
 * portfolio scoring elsewhere in this file) so the group most likely to
 * satisfy this specific traveler's interests is queried FIRST, both within
 * a stay and — because callers flatten (stay, group) into one shared
 * priority-ordered queue — across the whole trip's concurrency pool.
 * Computed once per trip (not per stay): preference text doesn't vary by
 * stay, and round-0 has no per-stay classificationBreakdown yet to weight
 * against.
 */
export function orderActivityQueryGroupsByPreference(preferenceTexts: string[]): ActivityQueryGroupDefinition[] {
  const weights = buildPreferenceFamilyWeights(preferenceTexts);
  return [...ACTIVITY_QUERY_GROUPS].sort((a, b) => (weights[b.primaryFamily] ?? 1) - (weights[a.primaryFamily] ?? 1));
}

export type QueryGroupOutcome =
  | "SUCCESS_WITH_RESULTS"
  | "SUCCESS_ZERO_RESULTS"
  | "TIMEOUT"
  | "HTTP_FAILURE"
  | "NETWORK_FAILURE"
  | "SKIPPED_ENOUGH_SUPPLY"
  | "SKIPPED_DEADLINE";

export interface QueryGroupResult {
  groupId: string;
  selectorCount: number;
  queryLength: number;
  attempts: number;
  endpointResults: string[];
  rawElementCount: number;
  normalizedCandidateCount: number;
  acceptedCandidateCount: number;
  elapsedMs: number;
  outcome: QueryGroupOutcome;
}

/** Round 9.3.4 §8/§16 — classifies a real fetch's raw outcome into one of the required, never-silently-grouped result shapes. Pure so it's directly testable without a network call. */
export function classifyQueryGroupOutcome(detail: {
  providerFailed: boolean;
  failureReason: string | null;
  results: unknown[];
}): QueryGroupOutcome {
  if (!detail.providerFailed) {
    return detail.results.length > 0 ? "SUCCESS_WITH_RESULTS" : "SUCCESS_ZERO_RESULTS";
  }
  const reason = detail.failureReason ?? "";
  if (/timeout/i.test(reason)) return "TIMEOUT";
  if (/^HTTP \d/.test(reason)) return "HTTP_FAILURE";
  return "NETWORK_FAILURE";
}

export interface RefillOptions {
  /** Injectable — defaults to the real Overpass-backed queryNearbyRecommendations. Tests inject a fake to avoid any real network call. */
  fetchCandidates?: (
    anchor: { lat: number; lon: number },
    radiusKm: number,
    categories: RecommendationCategory[],
    perCategoryLimit: number
  ) => Promise<OverpassNearbyRecommendation[]>;
  /** Bounded rounds (spec §4: "Do not repeatedly query forever"). */
  maxRounds?: number;
  /**
   * Round 9.1 §6/§9 — an absolute Date.now()-comparable deadline (ms). No
   * further round is even STARTED once past it — the real fix for the
   * observed ~11-minute hang: a sequential per-stay refill with no overall
   * time budget can wait out an entire Overpass outage stay-by-stay. When
   * omitted, no deadline is enforced (a caller that wants the safety net
   * must pass one — refillTripRecommendationPool, the real production
   * caller, always does).
   */
  deadline?: number;
  /**
   * Round 9.3.4 §3 — when true, round 0's OWN old single-combined-category
   * fetch is skipped entirely: the caller (refillTripRecommendationPool)
   * has already run the new grouped, cross-stay-concurrency-bounded
   * discovery pass and merged its accepted candidates directly into
   * `pool` before calling this function, which then only ever runs its
   * EXISTING, unchanged, already-small round-1+ single-most-undersupplied-
   * category top-up loop. Omitted (or false), this function behaves
   * exactly as it always has (used by every pre-existing direct caller/test).
   */
  skipRound0?: boolean;
}

export interface RefillResult {
  pool: StayActivityPool;
  addedRecommendations: TripRecommendation[];
}

export function toTripRecommendation(candidate: OverpassNearbyRecommendation): TripRecommendation {
  return {
    id: `overpass:${candidate.category}:${candidate.lat.toFixed(5)}:${candidate.lon.toFixed(5)}:${candidate.name}`,
    name: candidate.name,
    category: candidate.category,
    location: candidate.location,
    shortDescription: candidate.shortDescription ?? "",
    estimatedDurationMinutes: null,
    approximatePrice: null,
    openingHours: candidate.openingHours ?? "",
    recommendedTimeOfDay: "any",
    reservationRequired: false,
    mapLink: "",
    imageUrl: "",
    imageQuery: "",
    lat: candidate.lat,
    lon: candidate.lon,
    source: "api",
    wikipediaUrl: candidate.wikipediaUrl ?? null,
    website: candidate.website ?? null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

/**
 * Round 9.3.4 — extracted, UNCHANGED-BEHAVIOR acceptance logic (legality →
 * classification → significance → dedupe → push), previously inlined once
 * inside refillStayActivityPool's own round loop. Now shared by BOTH that
 * loop (round 1+ single-category top-up) and refillTripRecommendationPool's
 * new grouped round-0 discovery, so a candidate is judged by the EXACT same
 * rule regardless of which discovery path found it — no behavior drift, no
 * duplicated logic to keep in sync.
 */
export function acceptRawCandidatesIntoPool(
  fetched: OverpassNearbyRecommendation[],
  state: {
    candidates: StayActivityPoolCandidate[];
    seenKeys: Set<string>;
    diagnostics: StayActivityPoolDiagnostics;
  },
  context: {
    anchor: { lat: number; lon: number };
    mobilityProfile: DestinationMobilityProfile;
    dailyCapacityMinutes: number;
    mustVisitKeywords: string[];
    desiredCandidateCount: number;
  }
): { addedRecommendations: TripRecommendation[]; acceptedCount: number } {
  const addedRecommendations: TripRecommendation[] = [];
  let acceptedCount = 0;
  for (const raw of fetched) {
    if (state.candidates.length >= context.desiredCandidateCount) break;
    const recommendation = toTripRecommendation(raw);
    if (state.seenKeys.has(recommendation.id)) {
      state.diagnostics.dedupeRejected += 1;
      continue;
    }
    state.seenKeys.add(recommendation.id);

    const legal = evaluateScheduledPlaceLegality({
      placeLat: recommendation.lat,
      placeLon: recommendation.lon,
      dayType: "normal",
      stayAnchor: context.anchor,
      mobilityProfile: context.mobilityProfile,
      dailyCapacityMinutes: context.dailyCapacityMinutes,
      visitMinutes: recommendation.estimatedDurationMinutes,
    }).legal;
    if (!legal) {
      state.diagnostics.geographyRejected += 1;
      continue;
    }

    const classification = classifyActivity({
      category: recommendation.category,
      name: recommendation.name,
      shortDescription: recommendation.shortDescription,
      reservationRequired: recommendation.reservationRequired,
      approximatePrice: recommendation.approximatePrice,
      recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
    });
    state.candidates.push({
      recommendationId: recommendation.id,
      name: recommendation.name,
      category: recommendation.category,
      classification,
      significance: computeSignificance(recommendation, context.mustVisitKeywords),
      lat: recommendation.lat,
      lon: recommendation.lon,
      location: recommendation.location,
      source: recommendation.source,
    });
    state.diagnostics.classificationBreakdown[classification.primaryFamily] =
      (state.diagnostics.classificationBreakdown[classification.primaryFamily] ?? 0) + 1;
    state.diagnostics.refillCandidateCount += 1;
    addedRecommendations.push(recommendation);
    acceptedCount += 1;
  }
  return { addedRecommendations, acceptedCount };
}

/**
 * Round 9.3.4 §12 — the meal-discovery analogue of acceptRawCandidatesIntoPool:
 * real restaurant/cafe candidates only ever need geography legality + dedupe
 * before joining payload.recommendations (buildTripMealVenuePools already
 * does its OWN meal classification/scoring downstream, unchanged) — they
 * must never be pushed into an ACTIVITY pool's `candidates` array (that pool
 * has no MEAL_VENUE-exclusion step of its own; REFILLABLE_CATEGORIES simply
 * never included restaurant/cafe before, so this distinction was never
 * needed until meal discovery got its own query group).
 */
export function acceptRawMealCandidates(
  fetched: OverpassNearbyRecommendation[],
  seenKeys: Set<string>,
  context: { anchor: { lat: number; lon: number }; mobilityProfile: DestinationMobilityProfile; dailyCapacityMinutes: number }
): { addedRecommendations: TripRecommendation[]; acceptedCount: number } {
  const addedRecommendations: TripRecommendation[] = [];
  let acceptedCount = 0;
  for (const raw of fetched) {
    const recommendation = toTripRecommendation(raw);
    if (seenKeys.has(recommendation.id)) continue;
    seenKeys.add(recommendation.id);
    const legal = evaluateScheduledPlaceLegality({
      placeLat: recommendation.lat,
      placeLon: recommendation.lon,
      dayType: "normal",
      stayAnchor: context.anchor,
      mobilityProfile: context.mobilityProfile,
      dailyCapacityMinutes: context.dailyCapacityMinutes,
      visitMinutes: recommendation.estimatedDurationMinutes,
    }).legal;
    if (!legal) continue;
    addedRecommendations.push(recommendation);
    acceptedCount += 1;
  }
  return { addedRecommendations, acceptedCount };
}

/**
 * Round 9 §4/§33 — bounded, stay-scoped, geography-bounded provider refill.
 * Real rounds: initial pool → inspect supply gap (overall count AND, from
 * round 2 on, the single most-undersupplied family, spec §33 AD) → one
 * targeted Overpass query per round, radius-bounded by the stay's OWN
 * mobility profile (never widened to the whole country, spec §4) → dedupe
 * against everything already in the pool → re-run legality → stop once the
 * pool reaches `desiredCandidateCount` or `maxRounds` is exhausted (spec:
 * "do not repeatedly query forever"). A provider failure/timeout is
 * recorded, never silently swallowed into "the stay just has less".
 */
export async function refillStayActivityPool(
  pool: StayActivityPool,
  mobilityProfile: DestinationMobilityProfile,
  dailyCapacityMinutes: number,
  mustVisitKeywords: string[],
  options: RefillOptions = {}
): Promise<RefillResult> {
  if (!pool.anchor || pool.candidates.length >= pool.desiredCandidateCount) {
    return { pool, addedRecommendations: [] };
  }

  const fetchCandidates = options.fetchCandidates ?? defaultFetchNearbyRecommendations;
  const maxRounds = options.maxRounds ?? 2;
  const anchor = pool.anchor;

  const candidates = [...pool.candidates];
  let diagnostics = { ...pool.diagnostics };
  const addedRecommendations: TripRecommendation[] = [];
  const seenKeys = new Set(candidates.map((c) => c.recommendationId));

  const startRound = options.skipRound0 ? 1 : 0;
  for (let round = startRound; round < maxRounds && candidates.length < pool.desiredCandidateCount; round += 1) {
    // Round 9.1 — the deadline is checked BEFORE starting a round, never
    // mid-flight (a single fetchCandidates call is never itself aborted
    // here; its own transport, e.g. fetchOverpass, owns its own timeout).
    if (options.deadline != null && Date.now() >= options.deadline) {
      diagnostics.supplyDegraded = true;
      break;
    }
    diagnostics.refillAttempts += 1;
    // From round 2 onward, target the single most-undersupplied family
    // that actually has an Overpass mapping (spec §33 AD); round 1 asks
    // broadly across every refillable category. Round 9.3.4: round 0's OLD
    // single ~15-selector combined call is gone — that work now happens as
    // refillTripRecommendationPool's grouped, concurrency-bounded discovery
    // pass (skipRound0 skips straight to this round-1-style top-up).
    const categoriesForThisRound =
      round === 0 ? REFILLABLE_CATEGORIES : [pickUndersuppliedCategory(diagnostics.classificationBreakdown)].filter(
        (category): category is RecommendationCategory => category != null
      );
    if (categoriesForThisRound.length === 0) break;

    let fetched: OverpassNearbyRecommendation[];
    const callStartedAt = Date.now();
    try {
      fetched = await fetchCandidates(anchor, mobilityProfile.localityRadiusKm, categoriesForThisRound, 8);
    } catch (error) {
      diagnostics.providerElapsedMs += Date.now() - callStartedAt;
      diagnostics.providerFailures += 1;
      if (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
        diagnostics.providerTimeouts += 1;
      }
      continue; // this round failed — still bounded, try the next round (or stop at maxRounds)
    }
    diagnostics.providerElapsedMs += Date.now() - callStartedAt;
    if (fetched.length === 0) continue; // genuinely no more supply this round — not a failure, just exhausted

    acceptRawCandidatesIntoPool(
      fetched,
      { candidates, seenKeys, diagnostics },
      { anchor, mobilityProfile, dailyCapacityMinutes, mustVisitKeywords, desiredCandidateCount: pool.desiredCandidateCount }
    ).addedRecommendations.forEach((r) => addedRecommendations.push(r));
  }

  diagnostics = {
    ...diagnostics,
    resolvedCandidateCount: candidates.length,
    legalCandidateCount: candidates.length,
    supplyDegraded: diagnostics.supplyDegraded || candidates.length < pool.desiredCandidateCount,
  };

  return {
    pool: { ...pool, candidates, categorySupply: diagnostics.classificationBreakdown, diagnostics },
    addedRecommendations,
  };
}

function pickUndersuppliedCategory(breakdown: CategorySupply): RecommendationCategory | null {
  const familyToCategory: Partial<Record<ActivityFamily, RecommendationCategory>> = {
    CULTURE: "museum",
    NATURE: "nature",
    SHOPPING: "shopping",
    ENTERTAINMENT: "nightlife",
    LOCAL_EXPERIENCE: "hidden_gem",
    LANDMARK: "attraction",
  };
  let worstFamily: ActivityFamily | null = null;
  let worstCount = Infinity;
  for (const family of ACTIVITY_FAMILIES) {
    if (family === "FOOD" || family === "OTHER") continue; // food is handled by the food-specific pipeline; OTHER has no Overpass mapping
    const count = breakdown[family] ?? 0;
    if (count < worstCount) {
      worstCount = count;
      worstFamily = family;
    }
  }
  return worstFamily ? (familyToCategory[worstFamily] ?? null) : null;
}

/**
 * Round 9.3.3 — a genuine Overpass provider failure must never look
 * identical to "this stay's area genuinely has zero more candidates."
 * queryNearbyRecommendations itself never throws (existing callers/tests
 * rely on that), so this wrapper — the one actually plugged into
 * refillStayActivityPool — is what turns `providerFailed: true` into a
 * thrown OverpassProviderFailureError, which refillStayActivityPool's
 * existing try/catch already classifies into providerFailures/
 * providerTimeouts instead of silently `continue`-ing past it.
 */
export class OverpassProviderFailureError extends Error {
  constructor(reason: string) {
    super(`Overpass provider failure: ${reason}`);
    this.name = /timeout/i.test(reason) ? "AbortError" : "OverpassProviderFailureError";
  }
}

/**
 * Round 9.3.4 §10 — RADIUS AUDIT: the old 60km cap here was never actually
 * an activity-discovery requirement — it was the "medium" mobility tier's
 * OWN `localityRadiusKm` (computeDestinationMobilityProfile, trip-workspace.ts),
 * a value that exists to answer "how far can a normal DAY'S travel
 * legitimately reach for THIS destination's geography" (compact=25,
 * medium=60, large_sparse=120), i.e. a day-trip/regional LEGALITY radius —
 * not "how far from the lodging area should we search for real POIs to
 * discover." Reusing the legality radius directly for discovery meant a
 * large_sparse stay's 120km-capped-at-60km search circle covered a far
 * bigger, slower-to-query area than a stay's OWN lodging neighborhood ever
 * needs. This decouples the two: discovery now always searches within the
 * SAME radius the "compact" tier already treats as a normal local/walkable-
 * plus-quick-transit stay area (never a new, invented number), while
 * `evaluateScheduledPlaceLegality` (the actual day-trip/regional legality
 * check, unchanged) still uses the full, real mobilityProfile.localityRadiusKm
 * — a candidate discovered locally can still be legally scheduled on a
 * regional day exactly as before; only the SEARCH circle shrank.
 */
export const ACTIVITY_DISCOVERY_RADIUS_CAP_KM = 25;

export async function defaultFetchNearbyRecommendations(
  anchor: { lat: number; lon: number },
  radiusKm: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number,
  /** Injectable — tests pass a fake to exercise the failure-vs-empty distinction without a real network call; production omits this and gets the real Overpass transport. */
  fetchImpl?: FetchLike
): Promise<OverpassNearbyRecommendation[]> {
  const outcome = await queryNearbyRecommendationsDetailed(
    anchor.lat,
    anchor.lon,
    Math.min(radiusKm, ACTIVITY_DISCOVERY_RADIUS_CAP_KM) * 1000,
    categories,
    perCategoryLimit,
    fetchImpl ? { fetchImpl } : {}
  );
  if (outcome.providerFailed) {
    throw new OverpassProviderFailureError(outcome.failureReason ?? "unknown");
  }
  return outcome.results;
}

/* ------------------------------------------------------------------ *
 * 6. Trip-wide diversity memory (spec §12)                             *
 * ------------------------------------------------------------------ */

export interface RecentActivityHistoryEntry {
  dayIndex: number;
  stayId: string;
  primaryFamily: ActivityFamily;
  subtype: ActivitySubtype;
}

const RECENT_SUBTYPE_PENALTY_BASE = 22;
const RECENT_FAMILY_PENALTY_BASE = 6;
const RECENT_HISTORY_DECAY_DAYS = 6; // beyond this many days, the penalty is negligible

function recencyPenalty(dayDistance: number, base: number): number {
  if (dayDistance <= 0) return base;
  if (dayDistance >= RECENT_HISTORY_DECAY_DAYS) return 0;
  return base * (1 - dayDistance / RECENT_HISTORY_DECAY_DAYS);
}

/**
 * Round 9.2 — the trip-wide recency penalty, factored out so BOTH portfolio
 * SELECTION (selectStayPortfolio) and actual DAY ASSIGNMENT
 * (composeDaysFromStayPortfolios, country-itinerary-generation.ts) score
 * against the exact same decaying history rule — spec §7's "use the
 * Round-9 taxonomy during actual day assignment... do not merely select a
 * diverse portfolio and then distribute it badly" requires the SAME
 * penalty model at both stages, not two drifted copies.
 */
export function computeRecencyPenalty(
  classification: Pick<ActivityClassification, "primaryFamily" | "subtype">,
  recentHistory: RecentActivityHistoryEntry[],
  currentDayIndex: number
): number {
  let penalty = 0;
  for (const entry of recentHistory) {
    const dayDistance = Math.max(0, currentDayIndex - entry.dayIndex);
    if (entry.subtype === classification.subtype) {
      penalty += recencyPenalty(dayDistance, RECENT_SUBTYPE_PENALTY_BASE);
    } else if (entry.primaryFamily === classification.primaryFamily) {
      penalty += recencyPenalty(dayDistance, RECENT_FAMILY_PENALTY_BASE);
    }
  }
  return penalty;
}

/* ------------------------------------------------------------------ *
 * 7. Portfolio selection (spec §10-18)                                 *
 * ------------------------------------------------------------------ */

export interface StayCoveragePlan {
  targetFamilies: ActivityFamily[];
  mustIncludeCandidateIds: string[];
  optionalCandidateIds: string[];
}

export interface StayActivityPortfolio {
  stayId: string;
  selected: StayActivityPoolCandidate[];
  optional: StayActivityPoolCandidate[];
  coveragePlan: StayCoveragePlan;
}

const SIGNIFICANCE_HIGH_THRESHOLD = 80;
const SUBTYPE_REPEAT_PENALTY_BASE = 30;
const FAMILY_REPEAT_PENALTY_BASE = 8;

/**
 * Deterministic portfolio selection — spec §27's own required "no
 * generation should collapse into free_time merely because Gemini failed"
 * fallback IS this function; Gemini (when/if wired in later) only ever
 * reorders/restricts within what this same scoring would already produce.
 *
 * Score = significance (weighted by user-preference family weight) MINUS
 * penalties for: repeating a subtype already selected THIS stay (escalating
 * per repeat), repeating a primary family already selected this stay
 * (escalating per repeat, but SCALED DOWN toward zero when the stay
 * genuinely has no supply in any other family — spec §13), and repeating a
 * subtype/family seen recently elsewhere in the trip (decaying with day
 * distance — spec §12). A sufficiently high significance candidate can
 * still win despite a real penalty (spec §8/§11 — soft optimization, never
 * a hard ban): nothing here ever removes a category from consideration.
 */
export function selectStayPortfolio(
  pool: StayActivityPool,
  targetPortfolioSize: number,
  familyWeights: Record<ActivityFamily, number>,
  recentHistory: RecentActivityHistoryEntry[],
  currentStayStartDayIndex: number,
  excludeRecommendationIds: Set<string> = new Set()
): StayActivityPortfolio {
  const available = pool.candidates.filter((c) => !excludeRecommendationIds.has(c.recommendationId));
  const otherFamiliesHaveSupply = (family: ActivityFamily) =>
    ACTIVITY_FAMILIES.some((other) => other !== family && (pool.categorySupply[other] ?? 0) > 0);

  const selected: StayActivityPoolCandidate[] = [];
  const remaining = [...available];
  const subtypeCounts = new Map<ActivitySubtype, number>();
  const familyCounts = new Map<ActivityFamily, number>();

  const scoreCandidate = (candidate: StayActivityPoolCandidate): number => {
    const weight = familyWeights[candidate.classification.primaryFamily] ?? 1;
    let score = candidate.significance * weight;

    const subtypeRepeats = subtypeCounts.get(candidate.classification.subtype) ?? 0;
    score -= SUBTYPE_REPEAT_PENALTY_BASE * subtypeRepeats;

    const familyRepeats = familyCounts.get(candidate.classification.primaryFamily) ?? 0;
    const familyPenaltyScale = otherFamiliesHaveSupply(candidate.classification.primaryFamily) ? 1 : 0;
    score -= FAMILY_REPEAT_PENALTY_BASE * familyRepeats * familyPenaltyScale;

    score -= computeRecencyPenalty(candidate.classification, recentHistory, currentStayStartDayIndex);
    return score;
  };

  while (selected.length < targetPortfolioSize && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const score = scoreCandidate(remaining[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    subtypeCounts.set(chosen.classification.subtype, (subtypeCounts.get(chosen.classification.subtype) ?? 0) + 1);
    familyCounts.set(chosen.classification.primaryFamily, (familyCounts.get(chosen.classification.primaryFamily) ?? 0) + 1);
  }

  // The optional bucket — runner-ups beyond the selected set, sorted by
  // significance, capped generously (spec §10: "normally larger than the
  // exact final scheduled set so the scheduler has alternatives").
  const optional = remaining.sort((a, b) => b.significance - a.significance).slice(0, Math.max(targetPortfolioSize, 6));

  const mustIncludeCandidateIds = selected
    .filter((c) => c.significance >= SIGNIFICANCE_HIGH_THRESHOLD)
    .map((c) => c.recommendationId);

  // Round 9.4 §J — logged BEFORE the anomaly check below so the anomaly
  // (if any) always has its own accompanying data log right next to it.
  logRealPlaceQA("Portfolio", {
    stayId: pool.stayId,
    poolSize: pool.candidates.length,
    requiredRealActivityTarget: pool.requiredRealActivityTarget,
    selectedCount: selected.length,
    reserveCount: optional.length,
    selectedIds: selected.map((c) => c.recommendationId),
    reserveIds: optional.map((c) => c.recommendationId),
    familyDistribution: [...selected, ...optional].reduce<Record<string, number>>((acc, c) => {
      acc[c.classification.primaryFamily] = (acc[c.classification.primaryFamily] ?? 0) + 1;
      return acc;
    }, {}),
  });
  // Round 9.4 §J invariant — never fixed here, only surfaced: a non-empty
  // pool producing an empty selection would be an anomaly this phase must
  // make loudly visible, not silently absorbed downstream.
  if (pool.candidates.length > 0 && selected.length === 0) {
    logRealPlaceQA("ANOMALY", { stayId: pool.stayId, reason: "POOL_NONEMPTY_PORTFOLIO_EMPTY", poolSize: pool.candidates.length, targetPortfolioSize });
  }

  return {
    stayId: pool.stayId,
    selected,
    optional,
    coveragePlan: {
      targetFamilies: [...new Set(selected.map((c) => c.classification.primaryFamily))],
      mustIncludeCandidateIds,
      optionalCandidateIds: optional.map((c) => c.recommendationId),
    },
  };
}

/** Appends a stay's selected portfolio to the trip-wide recent-activity memory, tagged with each candidate's position within the stay's own day range (spec §12) — later stays' selectStayPortfolio calls see this. */
export function appendPortfolioToHistory(
  history: RecentActivityHistoryEntry[],
  portfolio: StayActivityPortfolio,
  stayStartDayIndex: number
): RecentActivityHistoryEntry[] {
  const additions = portfolio.selected.map((candidate, index) => ({
    dayIndex: stayStartDayIndex + index,
    stayId: portfolio.stayId,
    primaryFamily: candidate.classification.primaryFamily,
    subtype: candidate.classification.subtype,
  }));
  return [...history, ...additions];
}

/* ------------------------------------------------------------------ *
 * 8. Gemini candidate-ID contract (spec §25-27)                        *
 * ------------------------------------------------------------------ */

export interface GeminiPortfolioSelectionInput {
  selectedCandidateIds: string[];
  optionalCandidateIds?: string[];
}

export interface ValidatedGeminiPortfolioSelection {
  /** Only IDs that exist in the pool — an unknown ID is dropped, never scheduled (spec §25: "Unknown ID: reject"). */
  selected: StayActivityPoolCandidate[];
  optional: StayActivityPoolCandidate[];
  rejectedUnknownIds: string[];
}

/**
 * Round 9 §25-26 — Gemini may only ever choose AMONG the legal candidates
 * this module already resolved; it can never introduce a new unverified
 * POI into the schedule. Any id Gemini returns that isn't in `pool` is
 * dropped and reported, never silently accepted and never thrown as a hard
 * error (the deterministic portfolio — selectStayPortfolio — is always the
 * fallback, per spec §27).
 */
export function validateGeminiPortfolioSelection(
  pool: StayActivityPool,
  selection: GeminiPortfolioSelectionInput
): ValidatedGeminiPortfolioSelection {
  const byId = new Map(pool.candidates.map((c) => [c.recommendationId, c]));
  const rejectedUnknownIds: string[] = [];

  const resolve = (ids: string[]): StayActivityPoolCandidate[] => {
    const resolved: StayActivityPoolCandidate[] = [];
    for (const id of ids) {
      const candidate = byId.get(id);
      if (candidate) resolved.push(candidate);
      else rejectedUnknownIds.push(id);
    }
    return resolved;
  };

  return {
    selected: resolve(selection.selectedCandidateIds),
    optional: resolve(selection.optionalCandidateIds ?? []),
    rejectedUnknownIds,
  };
}

/* ------------------------------------------------------------------ *
 * 9. Trip-wide orchestration                                           *
 * ------------------------------------------------------------------ */

export interface TripActivityPortfolios {
  poolsByStay: Map<string, StayActivityPool>;
  portfoliosByStay: Map<string, StayActivityPortfolio>;
  recentHistory: RecentActivityHistoryEntry[];
}

/**
 * Builds every stay's pool + portfolio in trip (phase) order, threading
 * trip-wide diversity memory forward (spec §12) — this is the pure,
 * fully-testable heart of the new architecture. Ownership is resolved ONCE
 * up front (assignCandidatesToStays) so no candidate can be double-counted
 * across two stays.
 */
export function buildTripActivityPortfolios(
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  recommendations: TripRecommendation[],
  dayCapacityByStay: Map<string, StayDayCapacityInput[]>,
  mustVisitKeywords: string[],
  preferenceTexts: string[],
  dailyCapacityMinutes: number,
  normalizeAreaLabelFn: (raw: string) => string,
  resolveTextualAreaMatchFn: (locationText: string, areaLabel: string) => boolean,
  portfolioSizeMultiplier = 1.3
): TripActivityPortfolios {
  const ownershipByStay = assignCandidatesToStays(
    recommendations,
    tripFrame,
    areaAnchors,
    normalizeAreaLabelFn,
    resolveTextualAreaMatchFn
  );
  const familyWeights = buildPreferenceFamilyWeights(preferenceTexts);

  const poolsByStay = new Map<string, StayActivityPool>();
  const portfoliosByStay = new Map<string, StayActivityPortfolio>();
  let recentHistory: RecentActivityHistoryEntry[] = [];
  const usedAcrossTrip = new Set<string>();

  for (const phase of tripFrame.phases) {
    const days = dayCapacityByStay.get(phase.id) ?? [];
    const capacity = computeStayCapacity(days);
    const anchor = areaAnchors.get(phase.areaLabel) ?? null;
    const pool = buildStayActivityPool(
      phase,
      ownershipByStay.get(phase.id) ?? [],
      anchor,
      mobilityProfile,
      capacity,
      mustVisitKeywords,
      dailyCapacityMinutes
    );
    poolsByStay.set(phase.id, pool);

    const targetPortfolioSize = Math.max(capacity.requiredRealActivityTarget, 1) * portfolioSizeMultiplier;
    const portfolio = selectStayPortfolio(
      pool,
      Math.ceil(targetPortfolioSize),
      familyWeights,
      recentHistory,
      phase.startDayNumber,
      usedAcrossTrip
    );
    portfoliosByStay.set(phase.id, portfolio);
    for (const candidate of portfolio.selected) usedAcrossTrip.add(candidate.recommendationId);

    recentHistory = appendPortfolioToHistory(recentHistory, portfolio, phase.startDayNumber);
  }

  return { poolsByStay, portfoliosByStay, recentHistory };
}
