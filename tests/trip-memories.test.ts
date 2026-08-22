import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import {
  buildAiStoryContext,
  computeCategoryBreakdown,
  computeTripHighlights,
  computeTripMemoryStats,
  computeTripRouteStory,
} from "../src/lib/trip-memories";
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
    id: "itin-1",
    countryId: "country-jp",
    isoA2: "JP",
    title: "Japan trip",
    startDate: "2026-10-06",
    endDate: "2026-10-08",
    daysCount: 3,
    travelers: 2,
    budget: 5000,
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
    generatedAt: "2026-08-19T00:00:00.000Z",
    deletedAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

function day(overrides: Partial<TripItineraryDay> = {}, items: TripItineraryItem[] = []): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides, items };
}

// 1. Skipped attraction is not counted as visited.
test("computeTripMemoryStats excludes skipped items from placesVisited/activitiesCompleted", () => {
  const completed = item({ id: "done", completed: true });
  const skipped = item({ id: "skip", skipped: true });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [completed, skipped])] });
  const stats = computeTripMemoryStats(itinerary);
  assert.equal(stats.placesVisited, 1);
  assert.equal(stats.activitiesCompleted, 1);
  assert.equal(stats.activitiesSkipped, 1);
});

// 2. Spontaneous activity is counted.
test("computeTripMemoryStats counts spontaneous activities separately and within placesVisited", () => {
  const spontaneous = item({ id: "spont", spontaneous: true });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [spontaneous])] });
  const stats = computeTripMemoryStats(itinerary);
  assert.equal(stats.spontaneousActivities, 1);
  assert.equal(stats.placesVisited, 1);
});

// 3. computeTripRouteStory uses actual (falling back to planned) accommodation, collapsing consecutive duplicates.
test("computeTripRouteStory collapses consecutive duplicate bases and prefers actualAccommodation", () => {
  const tokyo1 = day({ dayNumber: 1, accommodation: "Tokyo Hotel" });
  const tokyo2 = day({ dayNumber: 2, accommodation: "Tokyo Hotel" });
  const nikko = day({ dayNumber: 3, accommodation: "Nikko Ryokan", actualAccommodation: "Nikko Actual Inn" });
  const itinerary = buildItinerary({ itineraryDays: [tokyo1, tokyo2, nikko] });
  const story = computeTripRouteStory(itinerary);
  assert.deepEqual(story, ["Tokyo Hotel", "Nikko Actual Inn"]);
});

// 4. Planned-only activity does not enter actual statistics.
test("a planned-only (not completed, not spontaneous) item is excluded from category breakdown", () => {
  const plannedOnly = item({ id: "planned", category: "museum" });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [plannedOnly])] });
  const breakdown = computeCategoryBreakdown(itinerary);
  assert.equal(breakdown.length, 0);
});

// 5. Unknown spending stays unknown.
test("computeTripMemoryStats.actualSpend is hasData:false when no completed item has an actualCost", () => {
  const completedNoActualCost = item({ id: "a", completed: true, actualCost: null });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [completedNoActualCost])] });
  const stats = computeTripMemoryStats(itinerary);
  assert.equal(stats.actualSpend.hasData, false);
  assert.equal(stats.actualSpend.value, 0);
});

// 6. AI story receives actual data only — a skipped or planned-only item's name never appears in the day activities.
test("buildAiStoryContext excludes skipped and planned-only items from day activities", () => {
  const completed = item({ id: "done", name: "Senso-ji", completed: true });
  const skipped = item({ id: "skip", name: "Skipped Museum", skipped: true });
  const plannedOnly = item({ id: "planned", name: "Never Happened Cafe" });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [completed, skipped, plannedOnly])] });
  const context = buildAiStoryContext(itinerary, "Japan", [], [], null);
  const activityNames = context.days.flatMap((d) => d.activities.map((a) => a.name));
  assert.deepEqual(activityNames, ["Senso-ji"]);
  assert.ok(!activityNames.includes("Skipped Museum"));
  assert.ok(!activityNames.includes("Never Happened Cafe"));
});

// Bonus: explicit favorites only, never inferred from personalRating alone below threshold.
test("computeTripHighlights only includes items marked favorite or rated >= 8", () => {
  const favorite = item({ id: "fav", name: "Fushimi Inari", completed: true, favorite: true });
  const highRated = item({ id: "high", name: "TeamLab", completed: true, personalRating: 9 });
  const lowRated = item({ id: "low", name: "Random Shop", completed: true, personalRating: 5 });
  const itinerary = buildItinerary({ itineraryDays: [day({}, [favorite, highRated, lowRated])] });
  const highlights = computeTripHighlights(itinerary, []);
  const names = highlights.favoriteActivities.map((i) => i.name);
  assert.ok(names.includes("Fushimi Inari"));
  assert.ok(names.includes("TeamLab"));
  assert.ok(!names.includes("Random Shop"));
});
