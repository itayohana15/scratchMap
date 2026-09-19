import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStayMealVenuePool,
  computeMealCuisineRecencyPenalty,
  appendMealToHistory,
  scoreMealVenueCandidate,
  selectMealVenueFromPool,
  validateGeminiMealSelection,
  type MealVenueCandidate,
  type StayMealVenuePool,
  type RecentMealHistoryEntry,
  type MealSelectionContext,
} from "../src/lib/server/stay-meal-venue-pool";
import type { MealVenueClassification } from "../src/lib/server/meal-cuisine-taxonomy";
import { CUISINE_FAMILIES } from "../src/lib/server/meal-cuisine-taxonomy";
import { buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import type { TripFramePhase } from "../src/lib/server/itinerary-planning-principles";
import type { TripPreferences, TripRecommendation, DestinationMobilityProfile } from "../src/lib/trip-workspace";

const MOBILITY: DestinationMobilityProfile = { tier: "medium", localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

const basePreferences: TripPreferences = {
  startDate: "2026-10-06",
  endDate: "2026-10-09",
  partialDate: "",
  travelers: 2,
  budget: 20000,
  tripStyle: "balanced",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "",
  transportationPreferences: "",
  accommodationArea: "",
  dietaryPreferences: "",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};
const PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 4);
const NEUTRAL_CUISINE_WEIGHTS = Object.fromEntries(CUISINE_FAMILIES.map((f) => [f, 1])) as Record<(typeof CUISINE_FAMILIES)[number], number>;

function phase(id = "stay-0", areaLabel = "Area A"): TripFramePhase {
  return { id, areaLabel, nights: 4, startDayNumber: 1, endDayNumber: 4, intent: "mixed" };
}

function rec(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? "rec-1",
    name: overrides.name ?? "Sample Restaurant",
    category: overrides.category ?? "restaurant",
    location: overrides.location ?? "Area A",
    shortDescription: overrides.shortDescription ?? "",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 60,
    approximatePrice: overrides.approximatePrice ?? 40,
    openingHours: overrides.openingHours ?? "11:00-23:00",
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? "any",
    reservationRequired: overrides.reservationRequired ?? false,
    mapLink: "",
    imageUrl: "",
    imageQuery: "",
    lat: overrides.lat ?? 10,
    lon: overrides.lon ?? 10,
    source: overrides.source ?? "api",
    wikipediaUrl: null,
    website: null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

function classification(overrides: Partial<MealVenueClassification> = {}): MealVenueClassification {
  return {
    venueType: "restaurant",
    cuisineFamilies: [],
    cuisineSubtypes: [],
    suitableMealTypes: ["LUNCH", "DINNER"],
    confidence: "category_fallback",
    priceLevel: null,
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<MealVenueCandidate> = {}): MealVenueCandidate {
  return {
    recommendationId: id,
    stayId: "stay-0",
    name: id,
    category: "restaurant",
    classification: classification(overrides.classification),
    lat: 10,
    lon: 10,
    location: "Area A",
    openingHours: "11:00-23:00",
    approximatePrice: 40,
    reservationRequired: false,
    source: "api",
    ...overrides,
  };
}

function poolOf(venues: MealVenueCandidate[]): StayMealVenuePool {
  return {
    stayId: "stay-0",
    ownerArea: "Area A",
    anchor: { lat: 10, lon: 10 },
    venues,
    cuisineSupply: {},
    mealTypeSupply: {},
    diagnostics: {
      initialCandidateCount: venues.length,
      resolvedCandidateCount: venues.length,
      legalCandidateCount: venues.length,
      dedupeRejected: 0,
      geographyRejected: 0,
      cuisineBreakdown: {},
      mealTypeBreakdown: {},
    },
  };
}

function context(overrides: Partial<MealSelectionContext> = {}): MealSelectionContext {
  return {
    mealType: "DINNER",
    anchor: null,
    nextAnchor: null,
    pace: "balanced",
    transportation: "תחבורה מקומית",
    recentHistory: [],
    dayIndex: 1,
    cuisineWeights: NEUTRAL_CUISINE_WEIGHTS,
    usedRecommendationIds: new Set(),
    ...overrides,
  };
}

/* -------------------- buildStayMealVenuePool -------------------- */

test("buildStayMealVenuePool classifies every owned candidate and tracks cuisine/mealType supply", () => {
  const pool = buildStayMealVenuePool(
    phase(),
    [rec({ id: "r1", name: "Sushi Place" }), rec({ id: "r2", category: "cafe", name: "Morning Cafe", openingHours: "07:00-16:00" })],
    { lat: 10, lon: 10 },
    MOBILITY,
    600
  );
  assert.equal(pool.venues.length, 2);
  assert.ok(pool.venues.find((v) => v.recommendationId === "r1")?.classification.cuisineSubtypes.includes("sushi"));
  assert.ok((pool.mealTypeSupply.BREAKFAST ?? 0) >= 1);
});

test("buildStayMealVenuePool rejects a geographically illegal candidate (outside the stay's mobility radius)", () => {
  const pool = buildStayMealVenuePool(
    phase(),
    [rec({ id: "far", lat: 40, lon: 40 })],
    { lat: 10, lon: 10 },
    MOBILITY,
    600
  );
  assert.equal(pool.venues.length, 0);
  assert.equal(pool.diagnostics.geographyRejected, 1);
});

test("buildStayMealVenuePool dedupes candidates sharing the same id", () => {
  const pool = buildStayMealVenuePool(phase(), [rec({ id: "dup" }), rec({ id: "dup" })], { lat: 10, lon: 10 }, MOBILITY, 600);
  assert.equal(pool.venues.length, 1);
  assert.equal(pool.diagnostics.dedupeRejected, 1);
});

/* -------------------- O/P/Q/R: geographic/route scoring -------------------- */

// O. activity A and B are geographically close; R1 near/between them; R2 far -> R1 preferred
// "far" is deliberately kept WITHIN the hard travel-limit (~5km / ~19min at
// the default pace/transportation) rather than absurdly distant — a truly
// extreme distance would trigger scoreRouteProximity's own binary
// exceedsLimit hard penalty regardless of the continuous route-fit term,
// which would let this test pass even with route-fit scoring itself
// removed (verified while writing mutation 3: a >50km "far" candidate kept
// scoring lower purely from exceedsLimit, hiding a real regression).
test("Round 9.2.1 O: a geographically close venue scores higher than an equally-suitable far one", () => {
  const near = candidate("near", { lat: 10.01, lon: 10.01 });
  const far = candidate("far", { lat: 10.045, lon: 10.045 });
  const ctx = context({ anchor: { name: "A", location: "Area A", lat: 10, lon: 10 } });
  const nearScore = scoreMealVenueCandidate(near, ctx, PROFILE).score;
  const farScore = scoreMealVenueCandidate(far, ctx, PROFILE).score;
  assert.ok(nearScore > farScore, `expected near (${nearScore}) > far (${farScore})`);
});

// P. dinner candidate near final evening activity beats one requiring a large backtrack
test("Round 9.2.1 P: a dinner venue near the day's final activity beats one requiring a big detour", () => {
  const nearFinal = candidate("near-final", { lat: 10.01, lon: 10.01 });
  const detour = candidate("detour", { lat: 10.045, lon: 10.045 });
  const ctx = context({ mealType: "DINNER", anchor: { name: "Final Stop", location: "Area A", lat: 10, lon: 10 } });
  const a = scoreMealVenueCandidate(nearFinal, ctx, PROFILE).score;
  const b = scoreMealVenueCandidate(detour, ctx, PROFILE).score;
  assert.ok(a > b, `expected near-final (${a}) > detour (${b})`);
});

// Q. breakfast near hotel/first activity preferred over equivalent distant venue
test("Round 9.2.1 Q: a breakfast venue near the anchor is preferred over an equally-suitable distant one", () => {
  const near = candidate("near", { lat: 10.01, lon: 10.01, classification: classification({ suitableMealTypes: ["BREAKFAST"] }) });
  const far = candidate("far", { lat: 10.045, lon: 10.045, classification: classification({ suitableMealTypes: ["BREAKFAST"] }) });
  const ctx = context({ mealType: "BREAKFAST", anchor: { name: "Hotel", location: "Area A", lat: 10, lon: 10 } });
  const a = scoreMealVenueCandidate(near, ctx, PROFILE).score;
  const b = scoreMealVenueCandidate(far, ctx, PROFILE).score;
  assert.ok(a > b);
});

// R. same-stay restaurant creating an unreasonable detour is penalized when a nearby alternative exists
test("Round 9.2.1 R: selectMealVenueFromPool prefers the nearby alternative over the same-stay far detour", () => {
  const near = candidate("near", { lat: 10.01, lon: 10.01 });
  const far = candidate("far", { lat: 11, lon: 11 });
  const pool = poolOf([near, far]);
  const ctx = context({ anchor: { name: "Anchor", location: "Area A", lat: 10, lon: 10 } });
  const best = selectMealVenueFromPool(pool, ctx, PROFILE);
  assert.equal(best?.candidate.recommendationId, "near");
});

/* -------------------- S/T/U/V/W: cuisine diversity -------------------- */

// S. multiple equally good cuisines available -> avoid identical cuisine every meal
test("Round 9.2.1 S: with equally good alternatives, a cuisine used yesterday scores lower today", () => {
  const japanese = candidate("jp", { classification: classification({ cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["japanese"] }) });
  const italian = candidate("it", { classification: classification({ cuisineFamilies: ["EUROPEAN"], cuisineSubtypes: ["italian"] }) });
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["japanese"] }];
  const ctx = context({ dayIndex: 2, recentHistory: history });
  const jpScore = scoreMealVenueCandidate(japanese, ctx, PROFILE).score;
  const itScore = scoreMealVenueCandidate(italian, ctx, PROFILE).score;
  assert.ok(itScore > jpScore, "the non-repeated cuisine should score higher than yesterday's repeated one");
});

// T. same cuisine yesterday -> soft repetition penalty today
test("Round 9.2.1 T: computeMealCuisineRecencyPenalty penalizes a same-subtype repeat more than a same-family one", () => {
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["sushi"] }];
  const sameSubtype = computeMealCuisineRecencyPenalty({ cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["sushi"] }, history, 2);
  const sameFamilyOnly = computeMealCuisineRecencyPenalty({ cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["ramen"] }, history, 2);
  const unrelated = computeMealCuisineRecencyPenalty({ cuisineFamilies: ["EUROPEAN"], cuisineSubtypes: ["italian"] }, history, 2);
  assert.ok(sameSubtype > sameFamilyOnly);
  assert.ok(sameFamilyOnly > unrelated);
  assert.equal(unrelated, 0);
});

test("Round 9.2.1 T: the recency penalty decays to zero after enough days", () => {
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: [], cuisineSubtypes: ["sushi"] }];
  const farAway = computeMealCuisineRecencyPenalty({ cuisineFamilies: [], cuisineSubtypes: ["sushi"] }, history, 30);
  assert.equal(farAway, 0);
});

// U. very strong user cuisine preference -> preferred cuisine can repeat more often
test("Round 9.2.1 U: a strongly preferred cuisine can still beat a repetition penalty", () => {
  const japanese = candidate("jp", { classification: classification({ cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["japanese"] }) });
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["japanese"] }];
  const withoutPreference = scoreMealVenueCandidate(japanese, context({ dayIndex: 2, recentHistory: history }), PROFILE).score;
  const strongWeights = { ...NEUTRAL_CUISINE_WEIGHTS, EAST_ASIAN: 3 };
  const withPreference = scoreMealVenueCandidate(japanese, context({ dayIndex: 2, recentHistory: history, cuisineWeights: strongWeights }), PROFILE).score;
  assert.ok(withPreference > withoutPreference, "a strong cuisine preference should meaningfully outweigh the repetition penalty");
});

// V. destination has limited cuisine supply -> repetition allowed rather than artificial failure
test("Round 9.2.1 V: selectMealVenueFromPool still returns a repeated cuisine when it's the only supply", () => {
  const onlyOption = candidate("only", { classification: classification({ cuisineFamilies: ["LOCAL_TRADITIONAL"], cuisineSubtypes: [] }) });
  const pool = poolOf([onlyOption]);
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: ["LOCAL_TRADITIONAL"], cuisineSubtypes: [] }];
  const best = selectMealVenueFromPool(pool, context({ dayIndex: 2, recentHistory: history }), PROFILE);
  assert.equal(best?.candidate.recommendationId, "only", "a scarce destination must still return its only real option, never nothing");
});

// W. high-value local cuisine option -> destination relevance can outweigh a small repetition penalty
test("Round 9.2.1 W: local-cuisine relevance bonus can outweigh a mild repetition penalty", () => {
  const localRepeat = candidate("local", { classification: classification({ cuisineFamilies: ["LOCAL_TRADITIONAL"], cuisineSubtypes: [] }) });
  const genericNew = candidate("generic", { classification: classification({ cuisineFamilies: [], cuisineSubtypes: [] }) });
  const history: RecentMealHistoryEntry[] = [{ dayIndex: 1, mealType: "DINNER", cuisineFamilies: ["LOCAL_TRADITIONAL"], cuisineSubtypes: [] }];
  const ctx = context({ dayIndex: 2, recentHistory: history });
  const localScore = scoreMealVenueCandidate(localRepeat, ctx, PROFILE).score;
  const genericScore = scoreMealVenueCandidate(genericNew, ctx, PROFILE).score;
  assert.ok(localScore > genericScore, "local-cuisine relevance (+10) outweighs the mild family-level repetition penalty here");
});

/* -------------------- meal-type-fit gate -------------------- */

test("scoreMealVenueCandidate excludes a candidate with no suitability evidence for the requested mealType", () => {
  const breakfastOnly = candidate("bfast", { classification: classification({ suitableMealTypes: ["BREAKFAST"] }) });
  const result = scoreMealVenueCandidate(breakfastOnly, context({ mealType: "LUNCH" }), PROFILE);
  assert.equal(result.mealTypeFit, false);
});

test("selectMealVenueFromPool never returns a mealTypeFit:false candidate even when it's the only one in the pool", () => {
  const breakfastOnly = candidate("bfast", { classification: classification({ suitableMealTypes: ["BREAKFAST"] }) });
  const pool = poolOf([breakfastOnly]);
  const best = selectMealVenueFromPool(pool, context({ mealType: "LUNCH" }), PROFILE);
  assert.equal(best, null);
});

/* -------------------- appendMealToHistory -------------------- */

test("appendMealToHistory returns a new array with the entry appended, never mutating the original", () => {
  const original: RecentMealHistoryEntry[] = [];
  const updated = appendMealToHistory(original, 1, "DINNER", classification({ cuisineFamilies: ["EAST_ASIAN"], cuisineSubtypes: ["sushi"] }));
  assert.equal(original.length, 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].cuisineSubtypes[0], "sushi");
});

/* -------------------- Gemini meal-selection contract (spec §23) -------------------- */

test("validateGeminiMealSelection accepts a candidateId that genuinely exists in this stay's pool", () => {
  const known = candidate("known-1");
  const pool = poolOf([known]);
  const result = validateGeminiMealSelection(pool, { selectedCandidateId: "known-1" });
  assert.equal(result.candidate?.recommendationId, "known-1");
  assert.equal(result.rejectedUnknownId, null);
});

test("validateGeminiMealSelection rejects an unknown candidateId, never guessing the nearest real one", () => {
  const known = candidate("known-1");
  const pool = poolOf([known]);
  const result = validateGeminiMealSelection(pool, { selectedCandidateId: "invented-id" });
  assert.equal(result.candidate, null);
  assert.equal(result.rejectedUnknownId, "invented-id");
});
