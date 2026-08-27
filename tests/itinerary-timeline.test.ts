import assert from "node:assert/strict";
import test from "node:test";

import { buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import {
  diversifyActivities,
  enforceBudgetOnDays,
  fixOverloadedDays,
} from "../src/lib/server/country-itinerary-generation";
import {
  applyAiPlanToWorkspace,
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  optimizeDayItemOrder,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryResponse,
  type TripItineraryItem,
  type TripPreferences,
} from "../src/lib/trip-workspace";
import { computeDayIntensity } from "../src/lib/server/itinerary-generation-constraints";

const basePreferences: TripPreferences = {
  startDate: "2026-10-06",
  endDate: "2026-10-08",
  partialDate: "",
  travelers: 2,
  budget: 22500,
  tripStyle: "culture and food",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "food, neighborhoods, markets",
  transportationPreferences: "public transport",
  accommodationArea: "Tokyo Station",
  dietaryPreferences: "",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "Tokyo",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

function genItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return {
    name: overrides.name ?? "Sample Stop",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tokyo",
    shortDescription: overrides.shortDescription ?? "Sample stop",
    slot: overrides.slot ?? "morning",
    plannedStartTime: overrides.plannedStartTime ?? "09:00",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 100,
    priceOriginalAmount: overrides.priceOriginalAmount ?? overrides.approximatePrice ?? 100,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? "ILS",
    priceConvertedAmount: overrides.priceConvertedAmount ?? overrides.approximatePrice ?? 100,
    priceExchangeRate: overrides.priceExchangeRate ?? 1,
    priceRateTimestamp: overrides.priceRateTimestamp ?? "2026-08-08T00:00:00.000Z",
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 20,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    reservationRequired: overrides.reservationRequired ?? false,
    transportation: overrides.transportation ?? "הליכה",
    mapLink: overrides.mapLink ?? "",
    lat: overrides.lat ?? 35.68,
    lon: overrides.lon ?? 139.76,
    bookingWarning: overrides.bookingWarning ?? "",
    alternativeSuggestion: overrides.alternativeSuggestion ?? "",
    recommendationId: overrides.recommendationId ?? null,
    locked: overrides.locked ?? false,
    priority: overrides.priority ?? "preferred",
    fixedTime: overrides.fixedTime ?? false,
  };
}

function genDay(overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return {
    dayNumber: overrides.dayNumber ?? 1,
    date: overrides.date ?? "2026-10-06",
    title: overrides.title ?? "Day 1",
    cityRegion: overrides.cityRegion ?? "Tokyo",
    accommodation: overrides.accommodation ?? "Tokyo Station Hotel",
    notes: overrides.notes ?? "",
    transportation: overrides.transportation ?? "רכבת מקומית",
    estimatedCost: overrides.estimatedCost ?? 400,
    activityCost: overrides.activityCost ?? 220,
    foodCost: overrides.foodCost ?? 120,
    transportCost: overrides.transportCost ?? 60,
    accommodationCost: overrides.accommodationCost ?? 0,
    totalTravelMinutes: overrides.totalTravelMinutes ?? 70,
    warnings: overrides.warnings ?? [],
    alternatives: overrides.alternatives ?? [],
    bookingRequirements: overrides.bookingRequirements ?? [],
    safetyNotes: overrides.safetyNotes ?? [],
    restWindow: overrides.restWindow ?? "",
    transportSegments: overrides.transportSegments ?? [],
    items: overrides.items ?? [],
  };
}

// 1. Marker/segment order should follow the deterministic reorder, and a
// locked item never moves from its original slot.
test("optimizeDayItemOrder (less_walking) resequences movable items but pins a locked item in place", () => {
  const items = [
    item({ id: "start", name: "Start", lat: 35.0, lon: 139.0 }),
    item({ id: "far", name: "Far Stop", lat: 36.0, lon: 140.0 }),
    item({ id: "locked-mid", name: "Locked Mid", locked: true, lat: 35.5, lon: 139.5 }),
    item({ id: "near", name: "Near Stop", lat: 35.01, lon: 139.01 }),
  ];

  const reordered = optimizeDayItemOrder(items, "less_walking");

  assert.equal(reordered[2].id, "locked-mid", "locked item must stay at its original index");
  const movableIds = reordered.filter((entry) => entry.id !== "locked-mid").map((entry) => entry.id);
  assert.deepEqual(movableIds, ["start", "near", "far"], "nearest-neighbor should visit the close stop before the far one");
});

test("optimizeDayItemOrder never moves a fixedTime item even without a lock", () => {
  const items = [
    item({ id: "a", name: "A", lat: 35.0, lon: 139.0 }),
    item({ id: "b", name: "B", fixedTime: true, lat: 40.0, lon: 145.0 }),
    item({ id: "c", name: "C", lat: 35.02, lon: 139.02 }),
  ];

  const reordered = optimizeDayItemOrder(items, "less_walking");
  assert.equal(reordered[1].id, "b", "fixedTime item must stay pinned at its original index");
});

// 2. "fewer_transfers" groups geographically-clustered stops together even
// when a pure nearest-neighbor pass on "less_walking" might not.
test("optimizeDayItemOrder (fewer_transfers) keeps same-area stops adjacent", () => {
  const items = [
    item({ id: "cluster-a-1", name: "Cluster A 1", lat: 35.0, lon: 139.0 }),
    item({ id: "cluster-b-1", name: "Cluster B 1", lat: 36.0, lon: 140.0 }),
    item({ id: "cluster-a-2", name: "Cluster A 2", lat: 35.001, lon: 139.001 }),
    item({ id: "cluster-b-2", name: "Cluster B 2", lat: 36.001, lon: 140.001 }),
  ];

  const reordered = optimizeDayItemOrder(items, "fewer_transfers").map((entry) => entry.id);
  const indexOfA1 = reordered.indexOf("cluster-a-1");
  const indexOfA2 = reordered.indexOf("cluster-a-2");
  const indexOfB1 = reordered.indexOf("cluster-b-1");
  const indexOfB2 = reordered.indexOf("cluster-b-2");

  assert.equal(Math.abs(indexOfA1 - indexOfA2), 1, "cluster A's two stops should be visited back-to-back");
  assert.equal(Math.abs(indexOfB1 - indexOfB2), 1, "cluster B's two stops should be visited back-to-back");
});

// 3. Deterministic day intensity across light/medium/heavy synthetic days.
test("computeDayIntensity buckets a light, a medium, and a heavy day correctly", () => {
  const light = computeDayIntensity([
    { category: "cafe", name: "Coffee", shortDescription: "", estimatedDurationMinutes: 45, plannedStartTime: "10:00", travelMinutes: 10, lat: 35.0, lon: 139.0 },
    { category: "attraction", name: "Park", shortDescription: "", estimatedDurationMinutes: 60, plannedStartTime: "11:00", travelMinutes: 10, lat: 35.001, lon: 139.001 },
  ]);
  assert.equal(light.level, "קל");

  const heavy = computeDayIntensity([
    { category: "attraction", name: "Museum 1", shortDescription: "", estimatedDurationMinutes: 180, plannedStartTime: "07:00", travelMinutes: 40, lat: 35.0, lon: 139.0 },
    { category: "attraction", name: "Hike", shortDescription: "hiking summit", estimatedDurationMinutes: 240, plannedStartTime: "10:00", travelMinutes: 50, lat: 35.2, lon: 139.2 },
    { category: "restaurant", name: "Lunch", shortDescription: "", estimatedDurationMinutes: 60, plannedStartTime: "14:00", travelMinutes: 30, lat: 35.25, lon: 139.25 },
    { category: "attraction", name: "Tower", shortDescription: "", estimatedDurationMinutes: 120, plannedStartTime: "16:00", travelMinutes: 40, lat: 35.3, lon: 139.3 },
    { category: "nightlife", name: "Night market", shortDescription: "", estimatedDurationMinutes: 150, plannedStartTime: "20:00", travelMinutes: 30, lat: 35.35, lon: 139.35 },
    { category: "restaurant", name: "Dinner", shortDescription: "", estimatedDurationMinutes: 90, plannedStartTime: "23:00", travelMinutes: 20, lat: 35.4, lon: 139.4 },
  ]);
  assert.equal(heavy.level, "עמוס");

  assert.ok(
    ["קל", "בינוני", "עמוס"].indexOf(light.level) < ["קל", "בינוני", "עמוס"].indexOf(heavy.level),
    "the light day must classify as less intense than the heavy day"
  );
});

// 4 & 6. locked/priority/fixedTime and accommodation coordinates survive a
// simulated regeneration merge (applyAiPlanToWorkspace matches by
// recommendationId, else name+location, against the previous workspace).
test("applyAiPlanToWorkspace carries locked/priority/fixedTime and accommodation coordinates across regeneration", () => {
  const workspace = {
    ...createDefaultWorkspace("Japan"),
    itineraryDays: [
      {
        ...createEmptyDay(1, "2026-10-06"),
        accommodation: "Tokyo Station Hotel",
        accommodationLat: 35.681,
        accommodationLon: 139.767,
        accommodationMapLink: "https://maps.example/tokyo-hotel",
        items: [
          item({
            id: "existing-item",
            name: "Senso-ji",
            location: "Asakusa, Tokyo",
            locked: true,
            priority: "must",
            fixedTime: true,
          }),
        ],
      },
    ],
  };

  const regeneratedPlan: AiItineraryResponse = {
    summary: "regenerated",
    title: "Japan trip",
    totalEstimatedCost: null,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [
      genDay({
        dayNumber: 1,
        accommodation: "Tokyo Station Hotel",
        items: [genItem({ name: "Senso-ji", location: "Asakusa, Tokyo", locked: false, priority: "preferred", fixedTime: false })],
      }),
    ],
  };

  const next = applyAiPlanToWorkspace(workspace, regeneratedPlan);
  const nextDay = next.itineraryDays[0];
  const nextItem = nextDay.items[0];

  assert.equal(nextItem.locked, true, "lock must survive even though the freshly generated item came back unlocked");
  assert.equal(nextItem.priority, "must");
  assert.equal(nextItem.fixedTime, true);
  assert.equal(nextDay.accommodationLat, 35.681, "accommodation coordinates must survive regeneration");
  assert.equal(nextDay.accommodationLon, 139.767);
  assert.equal(nextDay.accommodationMapLink, "https://maps.example/tokyo-hotel");
});

// 5. A locked item is never chosen as the "worst" item to move/replace when
// a day is overloaded or over budget, even when it scores worst.
test("fixOverloadedDays and enforceBudgetOnDays never touch a locked item", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const overloadedDay = genDay({
    items: [
      genItem({ name: "Locked Expensive Stop", locked: true, slot: "evening", estimatedDurationMinutes: 300, travelMinutes: 90, approximatePrice: 50000 }),
      genItem({ name: "Movable Stop", slot: "afternoon", estimatedDurationMinutes: 180, travelMinutes: 40 }),
      genItem({ name: "Lunch", category: "restaurant", slot: "lunch", estimatedDurationMinutes: 60, travelMinutes: 15 }),
      genItem({ name: "Dinner", category: "restaurant", slot: "dinner", estimatedDurationMinutes: 60, travelMinutes: 15 }),
    ],
  });

  const payload = {
    countryId: "country-jp",
    countryName: "Japan",
    isoA2: "JP",
    tripStatus: "planning" as const,
    preferences: basePreferences,
    selectedPlaces: [],
    recommendations: [],
    bookings: [],
    existingDays: [],
  };

  const [overloadRepaired] = fixOverloadedDays([overloadedDay], payload, profile);
  assert.ok(
    overloadRepaired.items.some((entry) => entry.name === "Locked Expensive Stop"),
    "the locked item must still be present after overload repair"
  );

  const [budgetRepaired] = enforceBudgetOnDays([overloadedDay], payload, profile);
  const lockedAfterBudget = budgetRepaired.items.find((entry) => entry.name === "Locked Expensive Stop");
  assert.ok(lockedAfterBudget, "the locked item must still be present after budget repair");
  assert.equal(lockedAfterBudget!.approximatePrice, 50000, "the locked item's price must be untouched by budget repair");
});

// Priority ordering: an optional item is removed/replaced before a must-do
// item when both are over the per-item budget cap.
test("enforceBudgetOnDays prefers replacing an optional over-cap item before a must-do over-cap item", () => {
  const profile = buildTripPreferenceProfile(
    { ...basePreferences, budget: 3000 },
    "Japan",
    1
  );

  const day = genDay({
    estimatedCost: 5800,
    items: [
      genItem({ name: "Optional Splurge", priority: "optional", slot: "morning", approximatePrice: 5000 }),
      genItem({ name: "Must-Do Stop", priority: "must", slot: "afternoon", approximatePrice: 400 }),
      genItem({ name: "Lunch", category: "restaurant", slot: "lunch", approximatePrice: 200 }),
      genItem({ name: "Dinner", category: "restaurant", slot: "dinner", approximatePrice: 200 }),
    ],
  });

  const payload = {
    countryId: "country-jp",
    countryName: "Japan",
    isoA2: "JP",
    tripStatus: "planning" as const,
    preferences: { ...basePreferences, budget: 3000 },
    selectedPlaces: [],
    recommendations: [],
    bookings: [],
    existingDays: [],
  };

  const [repaired] = enforceBudgetOnDays([day], payload, profile);
  const mustStillThere = repaired.items.some((entry) => entry.name === "Must-Do Stop" && entry.approximatePrice === 400);
  const optionalStillThere = repaired.items.some((entry) => entry.name === "Optional Splurge");

  assert.equal(mustStillThere, true, "the must-do item should be preserved, untouched, once trimming the optional item is enough");
  assert.equal(optionalStillThere, false, "the optional item should be the one replaced first");
});

// diversifyActivities: a locked item of the dominant category must be
// skipped in favor of a non-locked one when trimming category dominance.
test("diversifyActivities skips a locked item of the dominant category", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const payload = {
    countryId: "country-jp",
    countryName: "Japan",
    isoA2: "JP",
    tripStatus: "planning" as const,
    preferences: basePreferences,
    selectedPlaces: [],
    recommendations: [
      {
        id: "alt-nature",
        name: "Alt Nature Spot",
        category: "nature" as const,
        location: "Tokyo",
        shortDescription: "",
        estimatedDurationMinutes: 90,
        approximatePrice: 0,
        openingHours: "",
        recommendedTimeOfDay: "afternoon" as const,
        reservationRequired: false,
        mapLink: "",
        imageUrl: "",
        imageQuery: "",
        lat: 35.69,
        lon: 139.7,
        source: "api" as const,
        wikipediaUrl: null,
        website: null,
        wheelchairAccessible: null,
        isFree: null,
      },
    ],
    bookings: [],
    existingDays: [],
  };

  const day = genDay({
    items: [
      genItem({ name: "Locked Museum", category: "museum", locked: true, approximatePrice: 500, travelMinutes: 60 }),
      genItem({ name: "Movable Museum", category: "museum", slot: "afternoon", approximatePrice: 800, travelMinutes: 80 }),
    ],
  });

  const repairedDays = diversifyActivities([day], payload, profile, "museum", []);
  const stillHasLockedMuseum = repairedDays[0].items.some((entry) => entry.name === "Locked Museum");
  assert.equal(stillHasLockedMuseum, true, "the locked museum item must never be swapped out by diversification");
});
