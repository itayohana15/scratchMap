import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import { buildUpgradeSuggestion, computeTripBudgetSummary } from "../src/lib/trip-budget";
import { createDefaultWorkspace, createEmptyDay, createEmptyItineraryItem } from "../src/lib/trip-workspace";

const BASE_PREFERENCES = createDefaultWorkspace("Georgia").preferences;

function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  return {
    id: "itin-1",
    countryId: "country-ge",
    isoA2: "GE",
    title: "Georgia trip",
    startDate: "2026-09-05",
    endDate: "2026-09-10",
    daysCount: 6,
    travelers: 2,
    budget: 25000,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: BASE_PREFERENCES,
    workspaceSnapshot: createDefaultWorkspace("Georgia"),
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 16580,
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

// 1. No actual spend tracked yet: remaining is budget minus planned cost.
test("computeTripBudgetSummary falls back to planned cost when no actual spend is tracked", () => {
  const itinerary = buildItinerary();
  const summary = computeTripBudgetSummary(itinerary);
  assert.equal(summary.originalBudget, 25000);
  assert.equal(summary.plannedCost, 16580);
  assert.equal(summary.actualCost.hasData, false);
  assert.equal(summary.remaining, 25000 - 16580);
  assert.equal(summary.isOverBudget, false);
  assert.equal(summary.overBudgetAmount, 0);
});

// 2. Actual spend tracked: remaining uses actual spend, not planned cost.
test("computeTripBudgetSummary prefers actual spend over planned cost once activities are completed", () => {
  const completedItem = { ...createEmptyItineraryItem("morning"), id: "a1", completed: true, actualCost: 30000 };
  const itinerary = buildItinerary({
    itineraryDays: [{ ...createEmptyDay(1, "2026-09-05"), items: [completedItem] }],
  });
  const summary = computeTripBudgetSummary(itinerary);
  assert.equal(summary.actualCost.hasData, true);
  assert.equal(summary.actualCost.value, 30000);
  assert.equal(summary.remaining, 25000 - 30000);
  assert.equal(summary.isOverBudget, true);
  assert.equal(summary.overBudgetAmount, 5000);
});

// 3. No budget set at all: remaining is null, never a misleading number.
test("computeTripBudgetSummary returns null remaining when no budget was set", () => {
  const itinerary = buildItinerary({ budget: null });
  const summary = computeTripBudgetSummary(itinerary);
  assert.equal(summary.remaining, null);
  assert.equal(summary.isOverBudget, false);
});

// 4. Upgrade suggestion only fires when remaining is meaningfully positive.
test("buildUpgradeSuggestion returns null when remaining is a small fraction of the budget", () => {
  const itinerary = buildItinerary({
    budget: 25000,
    costSummary: {
      totalEstimatedCost: 24000,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
  });
  const summary = computeTripBudgetSummary(itinerary);
  assert.equal(buildUpgradeSuggestion(summary), null);
});

test("buildUpgradeSuggestion suggests an upgrade when remaining is at least 15% of budget", () => {
  const itinerary = buildItinerary({ budget: 25000 }); // planned 16580, remaining 8420 (~33.7%)
  const summary = computeTripBudgetSummary(itinerary);
  const suggestion = buildUpgradeSuggestion(summary);
  assert.notEqual(suggestion, null);
  assert.match(suggestion ?? "", /8,420|8420/);
});

// 5. Over budget never produces a negative "remaining" suggestion.
test("buildUpgradeSuggestion returns null when over budget", () => {
  const completedItem = { ...createEmptyItineraryItem("morning"), id: "a1", completed: true, actualCost: 30000 };
  const itinerary = buildItinerary({
    itineraryDays: [{ ...createEmptyDay(1, "2026-09-05"), items: [completedItem] }],
  });
  const summary = computeTripBudgetSummary(itinerary);
  assert.equal(buildUpgradeSuggestion(summary), null);
});
