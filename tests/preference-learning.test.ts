import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import {
  aggregateFeedbackByPlace,
  buildPersonalizationSummary,
  computeAlreadyVisited,
  computeBehaviorSignals,
  computeRecommendationScore,
  deriveInferredPreferences,
  explainRecommendation,
  mapItemToPreferenceCategories,
} from "../src/lib/preference-learning";
import {
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  type TripItineraryDay,
  type TripItineraryItem,
} from "../src/lib/trip-workspace";

const BASE_PREFERENCES = createDefaultWorkspace("Japan").preferences;

function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  return {
    id: overrides.id ?? "itin-1",
    countryId: "country-jp",
    isoA2: "JP",
    title: "Japan trip",
    startDate: "2026-01-01",
    endDate: "2026-01-05",
    daysCount: 5,
    travelers: 2,
    budget: null,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: BASE_PREFERENCES,
    workspaceSnapshot: createDefaultWorkspace("Japan"),
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 0,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
    status: "completed",
    version: 1,
    parentItineraryId: null,
    manuallyEdited: false,
    archived: false,
    generatedAt: "2020-01-01T00:00:00.000Z",
    deletedAt: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

function day(overrides: Partial<TripItineraryDay> = {}, items: TripItineraryItem[] = []): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-01-01"), ...overrides, items };
}

const RECENT_DATE = "2026-01-05"; // recent relative to `now` used below
const NOW = new Date("2026-02-01T00:00:00.000Z");

// Spec §35 feedback-loop scenario, split into its component assertions.

test("repeated favorited hiking/nature activities produce a rising nature inference with confidence", () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    item({ id: `hike-${i}`, category: "nature", name: "Mountain hike", completed: true, favorite: true, personalRating: 10 })
  );
  const itinerary = buildItinerary({ itineraryDays: [day({ date: RECENT_DATE }, items)] });
  const signals = computeBehaviorSignals([itinerary], [], NOW);
  const { inferred, suggestions } = deriveInferredPreferences(signals, {});
  assert.equal(inferred.nature?.direction, "up");
  assert.ok((inferred.nature?.confidence ?? 0) > 0);
  assert.ok(suggestions.some((s) => s.category === "nature"));
});

test("repeated 'not interested' museum skips lower the museum inference, but a 'closed' skip contributes nothing negative", () => {
  const notInterestedSkips = Array.from({ length: 4 }, (_, i) =>
    item({ id: `museum-${i}`, category: "museum", name: "Museum", skipped: true, skipReason: "לא מעניין" })
  );
  const closedSkip = item({ id: "museum-closed", category: "museum", name: "Museum Closed Today", skipped: true, skipReason: "סגור" });
  const itinerary = buildItinerary({ itineraryDays: [day({ date: RECENT_DATE }, [...notInterestedSkips, closedSkip])] });
  const signals = computeBehaviorSignals([itinerary], [], NOW);
  const museumSignal = signals.get("museums");
  assert.ok(museumSignal);
  // Only the 4 "not interested" skips contribute negative weight — the closed one contributes 0.
  assert.equal(museumSignal!.sampleSize, 4);
  const { inferred } = deriveInferredPreferences(signals, { museums: 4 });
  assert.equal(inferred.museums?.direction, "down");
});

// Spec §13: one dislike must not zero out an entire category — aggregate evidence required.
test("a single negative signal does not produce a suggestion (not enough evidence)", () => {
  const itinerary = buildItinerary({
    itineraryDays: [day({ date: RECENT_DATE }, [item({ id: "m1", category: "museum", skipped: true, skipReason: "לא מעניין" })])],
  });
  const signals = computeBehaviorSignals([itinerary], [], NOW);
  const { suggestions } = deriveInferredPreferences(signals, { museums: 4 });
  assert.equal(suggestions.length, 0);
});

// Spec §5: too little evidence overall produces no suggestion.
test("deriveInferredPreferences produces no suggestion for a category with zero signals", () => {
  const itinerary = buildItinerary({ itineraryDays: [day({ date: RECENT_DATE }, [])] });
  const signals = computeBehaviorSignals([itinerary], [], NOW);
  const { suggestions } = deriveInferredPreferences(signals, {});
  assert.equal(suggestions.length, 0);
});

// Spec §18/19/20/21: repeat-visit intelligence.
test("computeAlreadyVisited aggregates visit count/favorite/rating across multiple completed trips", () => {
  const tripA = buildItinerary({
    id: "a",
    itineraryDays: [day({ date: "2019-01-01" }, [item({ id: "x", name: "Anne Frank House", completed: true, personalRating: 8 })])],
  });
  const tripB = buildItinerary({
    id: "b",
    itineraryDays: [day({ date: "2018-01-01" }, [item({ id: "y", name: "Anne Frank House", completed: true, favorite: true, personalRating: 6 })])],
  });
  const visited = computeAlreadyVisited([tripA, tripB]);
  const key = [...visited.keys()][0];
  const info = visited.get(key)!;
  assert.equal(info.visitedCount, 2);
  assert.equal(info.favorite, true);
  assert.equal(info.lastVisitedAt, "2019-01-01");
});

test("computeRecommendationScore ranks an unvisited relevant place above a previously-visited non-favorite place, and doesn't exclude a visited favorite", () => {
  const alreadyVisited = new Map([
    ["name:old museum::tokyo", { visitedCount: 1, lastVisitedAt: "2019-01-01", favorite: false, avgRating: 4 }],
    ["name:favorite garden::tokyo", { visitedCount: 2, lastVisitedAt: "2019-01-01", favorite: true, avgRating: 9 }],
  ]);
  const context = {
    explicitPreferences: {},
    inferredPreferences: {},
    feedbackByPlaceKey: new Map(),
    alreadyVisited,
  };
  const newPlace = { name: "New Shrine", location: "Tokyo", category: "attraction" as const, shortDescription: "", approximatePrice: null, openingHours: "", lat: null, lon: null };
  const visitedNonFavorite = { name: "Old Museum", location: "Tokyo", category: "museum" as const, shortDescription: "", approximatePrice: null, openingHours: "", lat: null, lon: null };
  const visitedFavorite = { name: "Favorite Garden", location: "Tokyo", category: "nature" as const, shortDescription: "", approximatePrice: null, openingHours: "", lat: null, lon: null };

  const newScore = computeRecommendationScore(newPlace, context);
  const visitedScore = computeRecommendationScore(visitedNonFavorite, context);
  const favoriteScore = computeRecommendationScore(visitedFavorite, context);

  assert.ok(newScore.repeatVisitPenalty > visitedScore.repeatVisitPenalty);
  assert.ok(favoriteScore.repeatVisitPenalty > visitedScore.repeatVisitPenalty);
});

// Spec §15: explanation must be grounded — never mention a category with zero contributing signal.
test("explainRecommendation never mentions a preference category with no real signal", () => {
  const candidate = { name: "Random Cafe", location: "Tokyo", category: "cafe" as const, shortDescription: "", approximatePrice: null, openingHours: "", lat: null, lon: null };
  const breakdown = computeRecommendationScore(candidate, {
    explicitPreferences: {}, // nothing set explicitly
    inferredPreferences: {},
    feedbackByPlaceKey: new Map(),
    alreadyVisited: new Map(),
  });
  const explanation = explainRecommendation(candidate, breakdown, {});
  assert.ok(!explanation.includes("ג'אז"));
  assert.ok(!explanation.toLowerCase().includes("jazz"));
});

test("openingHoursFit collapses the total score for an explicitly closed place", () => {
  const closed = { name: "Closed Place", location: "Tokyo", category: "attraction" as const, shortDescription: "", approximatePrice: null, openingHours: "סגור לצמיתות", lat: null, lon: null };
  const open = { name: "Open Place", location: "Tokyo", category: "attraction" as const, shortDescription: "", approximatePrice: null, openingHours: "", lat: null, lon: null };
  const context = { explicitPreferences: {}, inferredPreferences: {}, feedbackByPlaceKey: new Map(), alreadyVisited: new Map() };
  const closedScore = computeRecommendationScore(closed, context);
  const openScore = computeRecommendationScore(open, context);
  assert.ok(closedScore.total < openScore.total);
});

// Spec §50/51: compact, capped personalization summary — not full history.
test("buildPersonalizationSummary stays compact even with a large explicit/feedback set", () => {
  const explicit = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`category-${i}`, 5]));
  const negatives = Array.from({ length: 30 }, (_, i) => ({ category: `cat-${i}`, reason: "reason" }));
  const summary = buildPersonalizationSummary(explicit, {}, negatives);
  assert.ok(summary != null);
  assert.ok(summary!.length < 2000);
});

test("buildPersonalizationSummary returns null when there is nothing meaningful to say", () => {
  const summary = buildPersonalizationSummary({}, {}, []);
  assert.equal(summary, null);
});

// Feedback aggregation isolation — up/down counts never bleed across different places.
test("aggregateFeedbackByPlace keeps counts isolated per place_key", () => {
  const rows = [
    { place_key: "a", feedback: "up" as const, reason: null },
    { place_key: "a", feedback: "up" as const, reason: null },
    { place_key: "b", feedback: "down" as const, reason: "יקר מדי" },
  ];
  const aggregate = aggregateFeedbackByPlace(rows);
  assert.equal(aggregate.get("a")?.upCount, 2);
  assert.equal(aggregate.get("a")?.downCount, 0);
  assert.equal(aggregate.get("b")?.downCount, 1);
});

// mapItemToPreferenceCategories — category + keyword heuristics.
test("mapItemToPreferenceCategories buckets a hiking-tagged nature item into both nature and hiking", () => {
  const categories = mapItemToPreferenceCategories({ category: "nature", name: "Mountain hiking trail", shortDescription: "" });
  assert.ok(categories.includes("nature"));
  assert.ok(categories.includes("hiking"));
});

test("mapItemToPreferenceCategories returns nothing for pure logistics categories", () => {
  assert.deepEqual(mapItemToPreferenceCategories({ category: "hotel", name: "Some Hotel", shortDescription: "" }), []);
  assert.deepEqual(mapItemToPreferenceCategories({ category: "transportation", name: "Train", shortDescription: "" }), []);
});
