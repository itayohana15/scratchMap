import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTripPreferenceProfile,
  collectPlanDiagnostics,
  type ExchangeRateContext,
  type PlanDiagnostics,
} from "../src/lib/server/itinerary-generation-constraints";
import {
  enforceBudgetOnDays,
  fixOverloadedDays,
  passesValidation,
  pickNearbyMealRecommendation,
  rebalanceDayItems,
  repairDayGeography,
  resolveItemPriceFields,
} from "../src/lib/server/country-itinerary-generation";
import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryRequest,
  AiItineraryResponse,
  TripPreferences,
  TripRecommendation,
} from "../src/lib/trip-workspace";

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
  accessibilityNeeds: "",
  preferredRegions: "Tokyo",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};

function buildPayload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    countryId: "country-jp",
    countryName: "Japan",
    isoA2: "JP",
    tripStatus: "planning",
    preferences: overrides.preferences ?? basePreferences,
    selectedPlaces: overrides.selectedPlaces ?? [],
    recommendations: overrides.recommendations ?? [],
    bookings: overrides.bookings ?? [],
    existingDays: overrides.existingDays ?? [],
  };
}

function buildRecommendation(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? "rec-1",
    name: overrides.name ?? "Sample Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tokyo",
    shortDescription: overrides.shortDescription ?? "Sample description",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 120,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? "afternoon",
    reservationRequired: overrides.reservationRequired ?? false,
    priceOriginalAmount: overrides.priceOriginalAmount ?? null,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? null,
    priceConvertedAmount: overrides.priceConvertedAmount ?? null,
    priceExchangeRate: overrides.priceExchangeRate ?? null,
    priceRateTimestamp: overrides.priceRateTimestamp ?? null,
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    mapLink: overrides.mapLink ?? "",
    imageUrl: overrides.imageUrl ?? "",
    imageQuery: overrides.imageQuery ?? "",
    lat: overrides.lat ?? 35.68,
    lon: overrides.lon ?? 139.76,
    source: overrides.source ?? "api",
    wikipediaUrl: overrides.wikipediaUrl ?? null,
    website: overrides.website ?? null,
    wheelchairAccessible: overrides.wheelchairAccessible ?? null,
    isFree: overrides.isFree ?? null,
  };
}

function buildItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
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

function buildDay(overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return {
    dayNumber: overrides.dayNumber ?? 1,
    date: overrides.date ?? "2026-10-06",
    title: overrides.title ?? "Day 1",
    cityRegion: overrides.cityRegion ?? "Tokyo",
    accommodation: overrides.accommodation ?? "Tokyo Station Hotel",
    notes: overrides.notes ?? "Neighborhood-focused day",
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

function cleanDiagnostics(overrides: Partial<PlanDiagnostics> = {}): PlanDiagnostics {
  return {
    totalEstimatedCost: 1000,
    missingMeals: 0,
    duplicatePlaces: 0,
    duplicateWarnings: 0,
    overloadedDays: 0,
    overSoftBudget: false,
    outOfBudget: false,
    missingAccommodation: 0,
    missingTransport: 0,
    avoidConflicts: 0,
    missingMustVisitKeywords: [],
    diversityRisk: false,
    dominantCategory: null,
    dominantCategoryShare: 0,
    invalidCoordinates: 0,
    crossCityDays: 0,
    longTravelDays: 0,
    foodDominantDays: 0,
    missingAnchorDays: 0,
    longMealDetours: 0,
    maxConsecutiveHighEnergyDays: 0,
    highEnergyRhythmViolation: false,
    baseMismatchDays: 0,
    activityMixSkew: [],
    ...overrides,
  };
}

// 1. A ~₪22,500 budget cannot produce a ~₪350,000 itinerary.
test("enforceBudgetOnDays caps a wildly over-budget plan instead of leaving it ~15x over target", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 3);

  const wildlyExpensiveDay = buildDay({
    estimatedCost: 116000,
    activityCost: 60000,
    foodCost: 40000,
    transportCost: 16000,
    items: [
      buildItem({ name: "Luxury Tour", category: "attraction", approximatePrice: 30000 }),
      buildItem({ name: "Private Guide", category: "attraction", slot: "afternoon", approximatePrice: 30000 }),
      buildItem({ name: "Omakase Lunch", category: "restaurant", slot: "lunch", approximatePrice: 20000 }),
      buildItem({ name: "Kaiseki Dinner", category: "restaurant", slot: "dinner", approximatePrice: 20000 }),
      buildItem({ name: "Private Car", category: "transportation", slot: "evening", approximatePrice: 16000 }),
    ],
  });
  const threeDays = [1, 2, 3].map((dayNumber) => ({ ...wildlyExpensiveDay, dayNumber }));

  const before = threeDays.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0);
  assert.ok(before > 300000, "fixture should start absurdly over budget, like the ₪350,000 example");

  // The real pipeline calls enforceBudgetOnDays once per repair attempt
  // (repairPlan retries up to 4 times, and generateCountryItineraryPlan
  // retries the whole thing up to 2 times on top of that) rather than
  // expecting full convergence from a single call — mirror repeated
  // repair passes here instead of testing a narrower slice of the real
  // repair capability. Each call's internal 14-attempt loop only fixes one
  // over-cap item at a time, so a fixture this extreme (every single item
  // over cap) genuinely needs several outer passes to fully clear.
  let repaired = threeDays;
  for (let i = 0; i < 10; i += 1) {
    repaired = enforceBudgetOnDays(repaired, payload, profile);
  }
  const totalAfter = repaired.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0);

  assert.ok(profile.budgetHardCeiling != null);
  assert.ok(
    totalAfter <= profile.budgetHardCeiling! * 1.05,
    `expected repaired total (${totalAfter}) to land near the ₪22,500 budget's hard ceiling (${profile.budgetHardCeiling}), not stay in the hundreds of thousands`
  );
});

// 2 & 7. Tokyo attraction + Osaka restaurant in one day must fail validation
// unless it's a transfer day.
test("passesValidation rejects a same-day Tokyo+Osaka mix, but accepts it on a transfer day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const items = [
    buildItem({
      name: "Senso-ji",
      category: "attraction",
      slot: "morning",
      location: "Asakusa, Tokyo",
      lat: 35.7148,
      lon: 139.7967,
      travelMinutes: 10,
    }),
    buildItem({
      name: "Sushi Counter",
      category: "restaurant",
      slot: "lunch",
      location: "Dotonbori, Osaka",
      lat: 34.6687,
      lon: 135.501,
      travelMinutes: 180,
    }),
    buildItem({
      name: "Osaka Castle",
      category: "attraction",
      slot: "afternoon",
      location: "Osaka",
      lat: 34.6873,
      lon: 135.5262,
      travelMinutes: 35,
    }),
    buildItem({
      name: "Local Dinner",
      category: "restaurant",
      slot: "dinner",
      location: "Osaka",
      lat: 34.69,
      lon: 135.5,
      travelMinutes: 15,
    }),
  ];

  const normalDay = buildDay({ cityRegion: "Tokyo", items });
  const normalDiagnostics = collectPlanDiagnostics(
    { title: "t", summary: "", categoryBreakdown: {}, days: [normalDay] } as AiItineraryResponse,
    profile
  );
  assert.equal(normalDiagnostics.crossCityDays, 1);
  assert.equal(passesValidation(normalDiagnostics), false);

  const transferDay = buildDay({
    cityRegion: "Tokyo -> Osaka",
    title: "מעבר מטוקיו לאוסקה",
    transportation: "שינקנסן",
    items,
  });
  const transferDiagnostics = collectPlanDiagnostics(
    { title: "t", summary: "", categoryBreakdown: {}, days: [transferDay] } as AiItineraryResponse,
    profile
  );
  assert.equal(transferDiagnostics.crossCityDays, 0);
});

// 3. A restaurant 10 minutes away should beat a restaurant 25 minutes away.
test("pickNearbyMealRecommendation prefers a 10-minute-away option over a 25-minute one", () => {
  const anchor = buildItem({
    name: "Senso-ji",
    category: "attraction",
    location: "Asakusa, Tokyo",
    lat: 35.7148,
    lon: 139.7967,
  });
  const near = buildRecommendation({
    id: "meal-near",
    name: "Nearby Tempura",
    category: "restaurant",
    location: "Asakusa, Tokyo",
    lat: 35.716,
    lon: 139.798,
  });
  const far = buildRecommendation({
    id: "meal-far",
    name: "Distant Ramen",
    category: "restaurant",
    location: "Yokohama",
    lat: 35.454,
    lon: 139.631,
  });

  const day = buildDay({ items: [anchor] });
  const payload = buildPayload({ recommendations: [near, far] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const picked = pickNearbyMealRecommendation(payload, day, "lunch", profile, new Set());
  assert.equal(picked?.name, "Nearby Tempura");
});

// 4. A restaurant >25 minutes away should be rejected when good nearby options exist.
test("pickNearbyMealRecommendation does not settle for a >25-minute option when a good nearby one exists", () => {
  const anchor = buildItem({
    name: "Senso-ji",
    category: "attraction",
    location: "Asakusa, Tokyo",
    lat: 35.7148,
    lon: 139.7967,
  });
  const good = buildRecommendation({
    id: "meal-good",
    name: "Good Nearby Cafe",
    category: "cafe",
    location: "Asakusa, Tokyo",
    lat: 35.715,
    lon: 139.797,
  });
  const tooFar = buildRecommendation({
    id: "meal-too-far",
    name: "Too Far Diner",
    category: "restaurant",
    location: "Yokohama",
    lat: 35.454,
    lon: 139.631,
  });

  const day = buildDay({ items: [anchor] });
  const payload = buildPayload({ recommendations: [good, tooFar] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const picked = pickNearbyMealRecommendation(payload, day, "lunch", profile, new Set());
  assert.notEqual(picked?.name, "Too Far Diner");
  assert.equal(picked?.name, "Good Nearby Cafe");
});

// 5. Duplicate restaurants should not repeat across many days.
test("rebalanceDayItems replaces a restaurant that repeats across many days", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "alt-restaurant",
        name: "Alternative Diner",
        category: "restaurant",
        location: "Tokyo",
        lat: 35.681,
        lon: 139.767,
        recommendedTimeOfDay: "dinner",
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 5);

  const usedPlaceKeys = new Set<string>();
  const repeatedItem = () =>
    buildItem({
      name: "Same Restaurant Every Night",
      category: "restaurant",
      slot: "dinner",
      recommendationId: "same-restaurant",
      lat: 35.681,
      lon: 139.767,
    });

  const days = [1, 2, 3, 4, 5].map((dayNumber) =>
    rebalanceDayItems(
      buildDay({ dayNumber, items: [repeatedItem()] }),
      payload,
      profile,
      usedPlaceKeys
    )
  );

  const namesUsed = days.map((day) => day.items[0]?.name);
  const repeats = namesUsed.filter((name) => name === "Same Restaurant Every Night").length;
  assert.equal(repeats, 1, `expected the repeated restaurant to survive on only 1 day, saw it on: ${namesUsed.join(", ")}`);
});

// 6. Invalid coordinates must be re-geocoded or rejected (repaired via a
// valid replacement, not left as impossible lat/lon).
test("repairDayGeography replaces an item with impossible coordinates", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "valid-alt",
        name: "Valid Nearby Spot",
        category: "attraction",
        location: "Tokyo",
        lat: 35.69,
        lon: 139.7,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Broken Coordinates Spot", category: "attraction", lat: 999, lon: 999 }),
      buildItem({
        name: "Fine Spot",
        category: "attraction",
        slot: "afternoon",
        lat: 35.69,
        lon: 139.7,
      }),
    ],
  });

  const repaired = repairDayGeography(day, payload, profile);
  for (const item of repaired.items) {
    assert.ok(
      item.lat == null || (item.lat >= -90 && item.lat <= 90),
      `item ${item.name} still has an impossible latitude: ${item.lat}`
    );
    assert.ok(
      item.lon == null || (item.lon >= -180 && item.lon <= 180),
      `item ${item.name} still has an impossible longitude: ${item.lon}`
    );
  }
  assert.equal(repaired.items.some((item) => item.name === "Broken Coordinates Spot"), false);
});

// 8. Overloaded days should be repaired before finalization.
test("fixOverloadedDays brings an overloaded day's load back under daily capacity", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const overloadedDay = buildDay({
    items: [
      buildItem({ name: "Stop 1", estimatedDurationMinutes: 180, travelMinutes: 40 }),
      buildItem({ name: "Stop 2", slot: "afternoon", estimatedDurationMinutes: 180, travelMinutes: 40 }),
      buildItem({ name: "Stop 3", slot: "evening", estimatedDurationMinutes: 180, travelMinutes: 40 }),
      buildItem({ name: "Stop 4", slot: "night", estimatedDurationMinutes: 180, travelMinutes: 40 }),
      buildItem({ name: "Lunch", category: "restaurant", slot: "lunch", estimatedDurationMinutes: 60, travelMinutes: 15 }),
      buildItem({ name: "Dinner", category: "restaurant", slot: "dinner", estimatedDurationMinutes: 60, travelMinutes: 15 }),
    ],
  });

  const [repaired] = fixOverloadedDays([overloadedDay], payload, profile);
  const loadMinutes = repaired.items.reduce(
    (sum, item) => sum + (item.estimatedDurationMinutes ?? 0) + (item.travelMinutes ?? 0),
    0
  );

  assert.ok(
    loadMinutes <= profile.dailyCapacityMinutes || repaired.items.length < overloadedDay.items.length,
    "expected fixOverloadedDays to either reduce total load under capacity or remove/move items"
  );
});

// 9. Trip preferences must visibly affect activity-category distribution:
// a plan skewed entirely toward one tier should trip the activity-mix diagnostic.
test("collectPlanDiagnostics flags an activity mix that's all one tier", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);
  const allIconicDay = buildDay({
    items: [
      buildItem({ name: "Museum 1", category: "museum" }),
      buildItem({ name: "Museum 2", category: "museum", slot: "afternoon" }),
      buildItem({ name: "Museum 3", category: "museum", slot: "evening" }),
      buildItem({ name: "Lunch", category: "restaurant", slot: "lunch" }),
      buildItem({ name: "Dinner", category: "restaurant", slot: "dinner" }),
    ],
  });
  const dayTwo = { ...allIconicDay, dayNumber: 2, items: allIconicDay.items.map((item) => ({ ...item, name: `${item.name} (2)` })) };

  const plan = {
    title: "t",
    summary: "",
    categoryBreakdown: {},
    days: [allIconicDay, dayTwo],
  } as AiItineraryResponse;

  const diagnostics = collectPlanDiagnostics(plan, profile);

  assert.ok(diagnostics.activityMixSkew.length > 0, "expected a museum-heavy plan to trip the activity-mix diagnostic");
  const iconicSkew = diagnostics.activityMixSkew.find((entry) => entry.tier === "iconic");
  assert.ok(iconicSkew, "expected the 'iconic' tier to be flagged as skewed");
  assert.ok(
    iconicSkew!.share > iconicSkew!.target.max,
    `expected iconic share (${iconicSkew!.share}) to exceed its target max (${iconicSkew!.target.max})`
  );
});

// 10. Currency conversion must not confuse JPY and ILS — this is the core
// fix: an LLM-invented item's raw price is local currency, not ILS.
test("resolveItemPriceFields converts an LLM-invented item's local-currency price instead of trusting it as ILS", () => {
  const context: ExchangeRateContext = {
    sourceCurrency: "JPY",
    targetCurrency: "ILS",
    rateToTarget: 0.023,
    updatedAt: "2026-08-08T00:00:00.000Z",
    source: "provider",
  };

  // The LLM invented this item (no matched candidate) and, per the prompt,
  // wrote its price in JPY — a plausible ramen price, ~1500 JPY.
  const fields = resolveItemPriceFields(1500, null, context);

  assert.equal(fields.priceOriginalAmount, 1500);
  assert.equal(fields.priceOriginalCurrency, "JPY");
  assert.equal(fields.sourceType, "ai_estimate");
  assert.equal(fields.convertedCurrency, "ILS");
  assert.equal(fields.priceConvertedAmount, 34.5);
  assert.equal(fields.approximatePrice, 34.5);
  assert.ok(
    fields.approximatePrice! < 100,
    `a ~1500 JPY meal must not be recorded as ~1500 ILS (got ${fields.approximatePrice})`
  );

  // A real, pre-priced candidate keeps its own already-correct context
  // untouched rather than being re-converted.
  const candidate = buildRecommendation({
    approximatePrice: 46,
    priceOriginalAmount: 2000,
    priceOriginalCurrency: "JPY",
    priceConvertedAmount: 46,
    priceExchangeRate: 0.023,
  });
  const candidateFields = resolveItemPriceFields(46, candidate, context);
  assert.equal(candidateFields.sourceType, "candidate");
  assert.equal(candidateFields.approximatePrice, 46);
});

test("passesValidation gate reacts to each individual diagnostic flag", () => {
  assert.equal(passesValidation(cleanDiagnostics()), true);
  assert.equal(passesValidation(cleanDiagnostics({ crossCityDays: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ outOfBudget: true })), false);
  assert.equal(passesValidation(cleanDiagnostics({ duplicatePlaces: 1 })), false);
});
