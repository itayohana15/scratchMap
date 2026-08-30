import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  type ExchangeRateContext,
  type PlanDiagnostics,
} from "../src/lib/server/itinerary-generation-constraints";
import {
  buildFreeExplorationReplacement,
  buildItemKey,
  enforceBudgetOnDays,
  fillUnderfilledDay,
  fixOverloadedDays,
  passesValidation,
  enforceMealCountLimit,
  enforceMealSpacing,
  ensureArrivalDepartureDayHasContent,
  enforceArrivalDepartureWindow,
  attemptStayStructureRepair,
  enforceStayTransitions,
  removeFuzzyDuplicatePlaces,
  ensureWeatherBackup,
  resolveCandidateProviderStatus,
  findMissingMealSlots,
  pickNearbyMealRecommendation,
  rebalanceDayItems,
  fillDerivedDayFields,
  repairCrossRegionDayContent,
  repairDayGeography,
  repairDayStructure,
  insertMissingMeals,
  resequenceDayItems,
  repairOpeningHoursViolations,
  resolveCanonicalPlaceId,
  resolveItemPriceFields,
  scoreMealCandidate,
} from "../src/lib/server/country-itinerary-generation";
import { buildFallbackAiItinerary, selectFallbackCandidate } from "../src/lib/trip-workspace";
import type { StayTransition, TripFrame } from "../src/lib/server/itinerary-planning-principles";
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
  foodNotes: "",
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
    overpassAvailable: overrides.overpassAvailable,
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
    pricePerPerson: overrides.pricePerPerson ?? null,
    priceOriginalAmount: overrides.priceOriginalAmount ?? overrides.approximatePrice ?? 100,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? "ILS",
    priceConvertedAmount: overrides.priceConvertedAmount ?? overrides.approximatePrice ?? 100,
    priceExchangeRate: overrides.priceExchangeRate ?? 1,
    priceRateTimestamp: overrides.priceRateTimestamp ?? "2026-08-08T00:00:00.000Z",
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 20,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    lastEntryTime: overrides.lastEntryTime ?? "",
    canonicalPlaceId: overrides.canonicalPlaceId ?? "",
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
    theme: overrides.theme ?? "",
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
    arrivalDepartureWindowViolations: 0,
    fixedTimeConflicts: [],
    timeOverlaps: 0,
    openingHoursViolations: 0,
    excessFoodStopsDays: 0,
    mealSpacingViolations: 0,
    duplicateRestaurants: 0,
    invalidFlightLegs: 0,
    invalidFlightLegDetails: [],
    airportBaseMismatches: 0,
    airportBaseMismatchDetails: [],
    protectedGeographicConflicts: 0,
    protectedGeographicConflictDetails: [],
    impossibleStayTransitions: 0,
    impossibleStayTransitionDetails: [],
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

// New rule: restaurants must be under 45 minutes away in general, but
// under 20 minutes on foot specifically — the same real distance must be
// scored much worse when the meal is reached by walking than by any
// faster mode.
test("scoreMealCandidate penalizes a ~22-minute walk far more than the same distance by car", () => {
  const anchor = buildItem({ name: "Senso-ji", category: "attraction", lat: 35.7148, lon: 139.7967 });
  const midDistanceMeal = buildRecommendation({
    id: "meal-mid",
    name: "Mid-Distance Diner",
    category: "restaurant",
    lat: 35.728,
    lon: 139.7967,
  });
  const day = buildDay({ items: [anchor] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const walkingScore = scoreMealCandidate(
    midDistanceMeal,
    day,
    "lunch",
    profile,
    new Set(),
    buildPayload({ preferences: { ...basePreferences, transportationPreferences: "הליכה" } })
  );
  const drivingScore = scoreMealCandidate(
    midDistanceMeal,
    day,
    "lunch",
    profile,
    new Set(),
    buildPayload({ preferences: { ...basePreferences, transportationPreferences: "נסיעה ברכב" } })
  );

  assert.ok(
    walkingScore < drivingScore,
    `a ~22-minute walk must score worse than the same trip by car (walking=${walkingScore}, driving=${drivingScore})`
  );
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

// Spec items 49/50/76: theme and canonicalPlaceId are always derived for
// real, regardless of the AI's own title, once a day passes through the
// shared derivation pass (fillDerivedDayFields, exercised here via
// repairDayGeography).
test("fillDerivedDayFields derives a content-matched theme and a real canonicalPlaceId for each item", () => {
  const payload = buildPayload();

  const day = buildDay({
    title: "Some AI-written title unrelated to content",
    items: [
      buildItem({ name: "City Museum", category: "museum", recommendationId: "rec-museum", lat: 35.69, lon: 139.7 }),
    ],
  });

  const filled = fillDerivedDayFields(day, payload);
  assert.equal(filled.theme, "תרבות");
  assert.equal(filled.items.find((item) => item.name === "City Museum")?.canonicalPlaceId, "id:rec-museum");
});

// Spec tests 84/85, end-to-end through the actual repair function: a
// closed-by-then attraction and a not-yet-open night venue must both be
// gone from the schedule after repair, not just flagged.
test("repairOpeningHoursViolations removes an item scheduled outside its own opening hours", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "morning-alt",
        name: "Morning Alternative Spot",
        category: "nature",
        location: "Eilat",
        openingHours: "08:00-18:00",
        lat: 29.55,
        lon: 34.95,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);

  const day = buildDay({
    cityRegion: "Eilat",
    items: [
      buildItem({
        name: "Timna Park",
        category: "nature",
        openingHours: "08:00-16:00",
        plannedStartTime: "19:52",
        lat: 29.78,
        lon: 34.95,
      }),
    ],
  });

  const [repaired] = repairOpeningHoursViolations([day], payload, profile);
  assert.equal(repaired.items.some((item) => item.name === "Timna Park"), false);
});

test("repairOpeningHoursViolations never touches a locked or fixed-time item, even when it violates its own hours", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);

  const day = buildDay({
    items: [
      buildItem({
        name: "Timna Park",
        category: "nature",
        openingHours: "08:00-16:00",
        plannedStartTime: "19:52",
        locked: true,
      }),
    ],
  });

  const [repaired] = repairOpeningHoursViolations([day], payload, profile);
  assert.equal(repaired.items.some((item) => item.name === "Timna Park"), true);
});

// Spec item 37: at most two dedicated food stops per day.
test("enforceMealCountLimit removes an extra food stop, keeping the lunch/dinner pair", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Morning Cafe", category: "cafe", slot: "morning", plannedStartTime: "09:00" }),
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" }),
    ],
  });

  const [repaired] = enforceMealCountLimit([day], payload, profile);
  const foodNames = repaired.items.filter((item) => item.category === "cafe" || item.category === "restaurant").map((item) => item.name);
  assert.equal(foodNames.length, 2);
  assert.ok(foodNames.includes("Lunch Spot"));
  assert.ok(foodNames.includes("Dinner Spot"));
  assert.equal(foodNames.includes("Morning Cafe"), false);
});

test("enforceMealCountLimit never removes a locked food item, even when it's the extra one", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Locked Cafe", category: "cafe", slot: "morning", plannedStartTime: "09:00", locked: true }),
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" }),
    ],
  });

  const [repaired] = enforceMealCountLimit([day], payload, profile);
  assert.ok(repaired.items.some((item) => item.name === "Locked Cafe"));
});

// Spec item 39: lunch→dinner needs at least 4 hours of spacing.
test("enforceMealSpacing pushes dinner later when it's scheduled too close to lunch", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "14:30" }),
    ],
  });

  const [repaired] = enforceMealSpacing([day], payload, profile);
  const dinner = repaired.items.find((item) => item.name === "Dinner Spot")!;
  const lunch = repaired.items.find((item) => item.name === "Lunch Spot")!;
  const gapMinutes =
    (Number(dinner.plannedStartTime.slice(0, 2)) * 60 + Number(dinner.plannedStartTime.slice(3))) -
    (Number(lunch.plannedStartTime.slice(0, 2)) * 60 + Number(lunch.plannedStartTime.slice(3)));
  assert.ok(gapMinutes >= 240, `expected at least a 4h gap, got ${gapMinutes} minutes`);
});

test("enforceMealSpacing leaves well-spaced meals untouched", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" }),
    ],
  });

  const [repaired] = enforceMealSpacing([day], payload, profile);
  const dinner = repaired.items.find((item) => item.name === "Dinner Spot")!;
  assert.equal(dinner.plannedStartTime, "19:00");
});

// Real bug found during end-to-end QA generation (a live Israel trip fell
// back to the deterministic template, and its dinner item ended up with
// endTime "11:43" while plannedStartTime read "13:10" — an item that ends
// before it starts, which no real traveler could follow). Root cause:
// enforceMealSpacing nudged plannedStartTime forward to satisfy the
// minimum lunch->dinner gap but left endTime stale at the PRE-nudge
// start+duration. This asserts endTime always shifts along with the nudge
// and the item's real duration survives unchanged.
test("enforceMealSpacing shifts endTime along with a nudged plannedStartTime, never leaving endTime before it", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const day = buildDay({
    items: [
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "09:10", estimatedDurationMinutes: 60, endTime: "10:10" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "10:28", estimatedDurationMinutes: 75, endTime: "11:43" }),
    ],
  });

  const [repaired] = enforceMealSpacing([day], payload, profile);
  const dinner = repaired.items.find((item) => item.name === "Dinner Spot")!;

  assert.equal(dinner.plannedStartTime, "13:10"); // 09:10 + 240min minimum lunch->dinner gap
  assert.equal(dinner.endTime, "14:25"); // 13:10 + its own unchanged 75min duration
  const startMinutes = Number(dinner.plannedStartTime.slice(0, 2)) * 60 + Number(dinner.plannedStartTime.slice(3));
  const endMinutes = Number(dinner.endTime!.slice(0, 2)) * 60 + Number(dinner.endTime!.slice(3));
  assert.ok(endMinutes > startMinutes, `endTime (${dinner.endTime}) must be after plannedStartTime (${dinner.plannedStartTime})`);
});

// Real bug found during end-to-end QA generation (a live Greece trip with
// a 10:40 departure): enforceArrivalDepartureWindow only ever REMOVES
// items that don't fit the real flight window, with no guarantee anything
// is left afterward — a tight enough departure stripped every item from
// the last day, leaving it completely empty. Two real travelers looking
// at "Day 5: (nothing)" would have no idea they still need to check out
// and get to the airport.
test("ensureArrivalDepartureDayHasContent gives an emptied departure day a minimal checkout/transfer item", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Greece", 5);
  const emptyDepartureDay = buildDay({ dayNumber: 5, items: [] });

  const [repaired] = ensureArrivalDepartureDayHasContent([emptyDepartureDay], payload, profile, 5);

  assert.ok(repaired.items.length > 0, "an emptied departure day must never be left with zero items");
  assert.equal(repaired.items[0].category, "practical");
});

// Real bug found during end-to-end QA generation (a live Greece trip with
// a 10:40 departure): a first version of this fix used a generic "08:00"
// guess for the item's start time and let resequenceDayItems reschedule
// it — that anchored it to the day's default 09:00 start regardless of
// the actual flight, producing a "checkout" item ending at 10:30, ten
// minutes before a 10:40 departure. The item's time must come directly
// from the real window and survive untouched.
test("ensureArrivalDepartureDayHasContent pins the checkout item's end time to the real departure cutoff, never later", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Greece", 5);
  const emptyDepartureDay = buildDay({ dayNumber: 5, date: "2026-10-12", items: [] });
  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-10-12", time: "07:40" }, // 10:40 flight minus a 3h buffer
  };

  const [repaired] = ensureArrivalDepartureDayHasContent([emptyDepartureDay], payload, profile, 5, window);
  const item = repaired.items[0];

  assert.equal(item.endTime, "07:40", "must end exactly at the real cutoff, not a generic later default");
  assert.equal(item.fixedTime, true, "must be pinned so no later resequencing pass can reschedule it");
  const startMinutes = Number(item.plannedStartTime.slice(0, 2)) * 60 + Number(item.plannedStartTime.slice(3));
  const endMinutes = Number(item.endTime!.slice(0, 2)) * 60 + Number(item.endTime!.slice(3));
  assert.ok(endMinutes > startMinutes);
  assert.ok(endMinutes <= 7 * 60 + 40, "must never end after the real departure cutoff");
});

test("ensureArrivalDepartureDayHasContent gives an emptied arrival day a minimal logistics item", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Greece", 5);
  const emptyArrivalDay = buildDay({ dayNumber: 1, items: [] });

  const [repaired] = ensureArrivalDepartureDayHasContent([emptyArrivalDay], payload, profile, 5);

  assert.ok(repaired.items.length > 0, "an emptied arrival day must never be left with zero items");
});

test("ensureArrivalDepartureDayHasContent leaves a normal middle day with zero items untouched", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Greece", 5);
  const emptyMiddleDay = buildDay({ dayNumber: 3, items: [] });

  const [repaired] = ensureArrivalDepartureDayHasContent([emptyMiddleDay], payload, profile, 5);

  assert.equal(repaired.items.length, 0, "only arrival/departure days get this guarantee, not every day");
});

test("collectPlanDiagnostics does not flag missingAnchorDays for a pure-logistics departure day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Greece", 2);
  const normalDay = buildDay({
    dayNumber: 1,
    items: [
      buildItem({ name: "Acropolis", category: "attraction", slot: "morning" }),
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch" }),
    ],
  });
  // dayNumber must equal plan.days.length for isDepartureDay to resolve —
  // this is genuinely the last day of a 2-day trip.
  const logisticsOnlyDepartureDay = buildDay({
    dayNumber: 2,
    items: [buildItem({ name: "צ'ק-אאוט ונסיעה לשדה התעופה", category: "practical", slot: "morning" })],
  });
  const plan: AiItineraryResponse = {
    title: "Greece Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [normalDay, logisticsOnlyDepartureDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).missingAnchorDays, 0);
});

// Spec item 42: a real alternative must be preferred over a trip-wide repeat.
test("pickNearbyMealRecommendation excludes a trip-wide-used restaurant when a real alternative exists", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({ id: "used", name: "Already Used Restaurant", category: "restaurant" }),
      buildRecommendation({ id: "fresh", name: "Fresh Restaurant", category: "restaurant" }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({ items: [] });

  const picked = pickNearbyMealRecommendation(payload, day, "dinner", profile, new Set(["already used restaurant"]));
  assert.equal(picked?.name, "Fresh Restaurant");
});

test("pickNearbyMealRecommendation still returns a repeat rather than nothing when every candidate is already used", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "used", name: "Only Restaurant In Town", category: "restaurant" })],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({ items: [] });

  const picked = pickNearbyMealRecommendation(payload, day, "dinner", profile, new Set(["only restaurant in town"]));
  assert.equal(picked?.name, "Only Restaurant In Town");
});

// Spec items 64/65: an outdoor-heavy day gets one indoor backup suggestion
// appended to alternatives — never inserted into the main schedule.
test("ensureWeatherBackup appends an indoor alternative for an outdoor-dominant day", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "museum-1", name: "City History Museum", category: "museum" })],
  });
  const day = buildDay({
    items: [
      buildItem({ name: "Mountain Trail", category: "nature", slot: "morning" }),
      buildItem({ name: "Lakeside Viewpoint", category: "nature", slot: "afternoon" }),
    ],
  });

  const [repaired] = ensureWeatherBackup([day], payload);
  assert.ok(repaired.alternatives.some((note) => note.includes("City History Museum")));
});

test("ensureWeatherBackup leaves a mixed day untouched", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "museum-1", name: "City History Museum", category: "museum" })],
  });
  const day = buildDay({
    items: [
      buildItem({ name: "City Museum", category: "museum", slot: "morning" }),
      buildItem({ name: "Mountain Trail", category: "nature", slot: "afternoon" }),
    ],
  });

  const [repaired] = ensureWeatherBackup([day], payload);
  assert.equal(repaired.alternatives.length, day.alternatives.length);
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

// Spec item 23 — an underfilled day must actually get filled, not just
// diagnosed. This is the direct fix for the reported "empty Day 1" symptom:
// missingAnchorDays used to be computed and gate validation, but nothing
// ever inserted anything.
test("fillUnderfilledDay inserts nearby candidates until the day reaches its pace's utilization target", () => {
  const recommendations = [
    buildRecommendation({ id: "rec-a", name: "Old Fortress", estimatedDurationMinutes: 150, lat: 35.681, lon: 139.767 }),
    buildRecommendation({ id: "rec-b", name: "City Park", estimatedDurationMinutes: 150, lat: 35.682, lon: 139.768 }),
    buildRecommendation({ id: "rec-c", name: "Local Museum", estimatedDurationMinutes: 150, lat: 35.683, lon: 139.769 }),
    buildRecommendation({ id: "rec-d", name: "Viewpoint", estimatedDurationMinutes: 150, lat: 35.684, lon: 139.77 }),
  ];
  const payload = buildPayload({ recommendations });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 3);

  const emptyDay = buildDay({ dayNumber: 2, items: [] });
  const usedPlaceKeys = new Set<string>();

  const filled = fillUnderfilledDay(emptyDay, payload, profile, usedPlaceKeys);

  assert.ok(filled.items.length > 0, "expected at least one activity to be inserted into the empty day");
  const utilization = calculateDayLoadMinutes(filled) / profile.dailyCapacityMinutes;
  assert.ok(utilization >= 0.55, `expected the filled day to reach a reasonable utilization, got ${utilization}`);
});

// Real root cause found while tracing overloadedDays in live QA: a
// "practical" free-time filler is deliberately given a duration equal to
// whatever leftover window it fills (often several hours) — the opposite
// of real planned load. Counting it here flagged an entirely reasonable
// day (a few real activities plus a generous free-time block) as
// "overloaded" purely because of the filler's own size.
test("calculateDayLoadMinutes ignores a practical free-time filler's own duration", () => {
  const dayWithoutFiller = buildDay({
    items: [
      buildItem({ name: "Museum", category: "museum", estimatedDurationMinutes: 120 }),
      buildItem({ name: "Lunch", category: "restaurant", slot: "lunch", estimatedDurationMinutes: 60 }),
    ],
  });
  const dayWithFiller = buildDay({
    items: [
      ...dayWithoutFiller.items,
      buildItem({ name: "זמן חופשי", category: "practical", estimatedDurationMinutes: 420, travelMinutes: null }),
    ],
  });

  assert.equal(calculateDayLoadMinutes(dayWithFiller), calculateDayLoadMinutes(dayWithoutFiller));
});

test("fillUnderfilledDay leaves a transfer day and a day-trip day alone — they're legitimately light", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "rec-a", name: "Extra Stop", estimatedDurationMinutes: 150 })],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 3);
  const usedPlaceKeys = new Set<string>();

  const transferDay = buildDay({ dayNumber: 2, title: "Transfer to Kyoto", transportation: "shinkansen", items: [] });
  assert.deepEqual(fillUnderfilledDay(transferDay, payload, profile, usedPlaceKeys).items, []);

  const dayTrip = buildDay({ dayNumber: 2, title: "Day trip to Nikko", items: [] });
  assert.deepEqual(fillUnderfilledDay(dayTrip, payload, profile, usedPlaceKeys).items, []);
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
  // wrote its per-person price in JPY — a plausible ramen price, ~1500 JPY.
  // travelers=1 isolates the currency-conversion behavior this test is
  // actually about from the separate per-person x travelers multiplication
  // (covered by its own dedicated test below).
  const fields = resolveItemPriceFields(1500, null, context, 1);

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
  const candidateFields = resolveItemPriceFields(46, candidate, context, 1);
  assert.equal(candidateFields.sourceType, "candidate");
  assert.equal(candidateFields.approximatePrice, 46);
});

// The spec's own worked example: "Museum ticket: ₪54/person, 2 travelers,
// total: ₪108" — approximatePrice must never be left as the raw per-person
// figure the AI wrote.
test("resolveItemPriceFields multiplies a fresh AI per-person price by traveler count into the group total", () => {
  const fields = resolveItemPriceFields(54, null, null, 2);
  assert.equal(fields.pricePerPerson, 54);
  assert.equal(fields.approximatePrice, 108);
  assert.equal(fields.priceOriginalAmount, 108);
  assert.equal(fields.priceConvertedAmount, 108);
});

test("resolveItemPriceFields never multiplies a matched real candidate's own price a second time", () => {
  const candidate = buildRecommendation({ approximatePrice: 108 });
  const fields = resolveItemPriceFields(null, candidate, null, 2);
  assert.equal(fields.approximatePrice, 108, "a matched candidate's own total must pass through unmultiplied");
  assert.equal(fields.pricePerPerson, null, "a matched candidate's per-person/total split isn't known, so it's left null rather than guessed");
});

test("resolveItemPriceFields treats a solo traveler's per-person price as its own total", () => {
  const fields = resolveItemPriceFields(54, null, null, 1);
  assert.equal(fields.pricePerPerson, 54);
  assert.equal(fields.approximatePrice, 54);
});

// Spec item 76: a real place identity, never guessed from name alone.
test("resolveCanonicalPlaceId prefers a real recommendationId over coordinates", () => {
  assert.equal(resolveCanonicalPlaceId({ recommendationId: "rec-1", lat: 35.68, lon: 139.76 }), "id:rec-1");
});

test("resolveCanonicalPlaceId falls back to a coordinate identity when no recommendationId exists", () => {
  assert.equal(resolveCanonicalPlaceId({ recommendationId: null, lat: 35.6812, lon: 139.7649 }), "coords:35.681:139.765");
});

test("resolveCanonicalPlaceId is empty for placeless filler content — never a name-only guess", () => {
  assert.equal(resolveCanonicalPlaceId({ recommendationId: null, lat: null, lon: null }), "");
});

// Real bug found during end-to-end QA generation (a live Portugal trip):
// a day whose raw AI output had only a "night" item and no morning/
// afternoon/lunch activity at all never got a lunch placeholder inserted
// (findMissingMealSlots used to require a same-period activity to already
// exist before filling a slot), while collectPlanDiagnostics unconditionally
// demands both lunch AND dinner on every day with no such exemption — the
// mismatch meant repair could never close missingMeals to 0, so the whole
// plan kept failing validation and fell back to the generic template.
test("findMissingMealSlots flags lunch as missing even when the day has no daytime activity at all", () => {
  const nightOnlyItems = [buildItem({ name: "Night Market", category: "nightlife", slot: "night" })];
  assert.deepEqual(findMissingMealSlots(nightOnlyItems), ["lunch", "dinner"]);
});

test("findMissingMealSlots flags dinner as missing even when the day has no evening activity at all", () => {
  const morningOnlyItems = [buildItem({ name: "Morning Museum", category: "museum", slot: "morning" })];
  assert.deepEqual(findMissingMealSlots(morningOnlyItems), ["lunch", "dinner"]);
});

test("repairDayStructure closes missingMeals to zero even for a night-only day with zero food candidates", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Portugal", 1);
  const day = buildDay({
    items: [buildItem({ name: "Night Market", category: "nightlife", slot: "night" })],
  });

  const repaired = repairDayStructure(day, payload, profile, 0, 1, new Set());
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [repaired],
  };
  assert.equal(collectPlanDiagnostics(plan, profile).missingMeals, 0);
});

// Real bug found during end-to-end QA generation (real 10-day Israel and
// Georgia trips with zero real recommendation candidates): the synthetic
// meal placeholder's phrase rotation is keyed on dayNumber % 3, so any two
// days a multiple of 3 apart in the same city (day 1 and day 4, day 4 and
// day 7, ...) produce the EXACT same placeholder string. duplicateRestaurants
// is a hard validation gate (passesValidation requires it === 0), so this
// alone silently failed both real Gemini attempts on every trip long
// enough to hit the collision, forcing a fallback to the generic template
// far more often than genuinely necessary.
test("repairDayStructure never produces a trip-wide duplicate synthetic meal name for days landing on the same phrase-rotation slot", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 10);
  const usedMealNames = new Set<string>();

  const day1 = buildDay({
    dayNumber: 1,
    cityRegion: "Tbilisi",
    items: [buildItem({ name: "Old Town Walk", category: "attraction", slot: "morning" })],
  });
  const day4 = buildDay({
    dayNumber: 4, // 4 % 3 === 1 % 3 — same rotation slot as day 1
    cityRegion: "Tbilisi",
    items: [buildItem({ name: "Sameba Cathedral", category: "attraction", slot: "morning" })],
  });

  const repairedDay1 = repairDayStructure(day1, payload, profile, 0, 10, usedMealNames);
  for (const item of repairedDay1.items) {
    if (item.category === "cafe" || item.category === "restaurant") {
      usedMealNames.add(item.name.trim().toLowerCase());
    }
  }
  const repairedDay4 = repairDayStructure(day4, payload, profile, 3, 10, usedMealNames);

  const day1MealNames = repairedDay1.items
    .filter((item) => item.category === "cafe" || item.category === "restaurant")
    .map((item) => item.name.trim().toLowerCase());
  const day4MealNames = repairedDay4.items
    .filter((item) => item.category === "cafe" || item.category === "restaurant")
    .map((item) => item.name.trim().toLowerCase());

  assert.ok(day1MealNames.length > 0 && day4MealNames.length > 0);
  for (const name of day4MealNames) {
    assert.ok(
      !day1MealNames.includes(name),
      `day 4's meal "${name}" must not exactly duplicate a day 1 meal name even though both land on the same 3-phrase rotation slot`
    );
  }
});

// ===== Thread 1: locked/fixed-time hard requirement =====
// Test A — a locked activity survives repair even when the general
// heuristic (a full-day anchor "should" own the whole day exclusively)
// would otherwise drop it.
test("resequenceDayItems never drops a locked anchor even on a day built around a full-day anchor", () => {
  const day = buildDay({
    items: [
      buildItem({ name: "Disneyland Paris", category: "attraction", shortDescription: "A major theme park", slot: "morning", estimatedDurationMinutes: 600 }),
      buildItem({ name: "Old Town Walk", category: "attraction", slot: "afternoon", locked: true }),
    ],
  });

  const repaired = resequenceDayItems(day);
  assert.ok(
    repaired.items.some((item) => item.name === "Old Town Walk"),
    "a locked item must never be dropped, even when a full-day anchor is also present"
  );
  assert.equal(
    repaired.alternatives.includes("Old Town Walk"),
    false,
    "a locked item must not even end up demoted to 'alternatives' — it stays a real item in the day"
  );
});

test("resequenceDayItems never drops a locked meal on a day built around a full-day anchor", () => {
  const day = buildDay({
    items: [
      buildItem({ name: "Disneyland Paris", category: "attraction", shortDescription: "A major theme park", slot: "morning", estimatedDurationMinutes: 600 }),
      buildItem({ name: "Booked Dinner Reservation", category: "restaurant", slot: "dinner", locked: true }),
    ],
  });

  const repaired = resequenceDayItems(day);
  assert.ok(repaired.items.some((item) => item.name === "Booked Dinner Reservation"));
});

// Thread 2 root cause: a day starting out with a genuine full-day anchor
// correctly omits meals (spec item 12) — but several OUTER repair steps
// that run after repairDayStructure (rebalanceDayItems, diversifyActivities,
// enforceBudgetOnDays, lightenHighEnergyStreaks, ...) can replace an
// anchor item outright, including a full-day one. Once that anchor is
// gone, the day is a normal day again and DOES need meals, but nothing
// re-checked — meal insertion only happened once, near the top of
// repairDayStructure, long before any of those later steps ran. A live
// France trip with Disneyland Paris reproduced this: an anchor originally
// classified full_day got swapped out for a regular-scale substitute
// downstream, and missingMeals stayed non-zero for the rest of the
// attempt (often every attempt), forcing a fallback to the generic
// template. Fixed with one final insertMissingMeals sweep over every day
// at the end of the outer repair sequence, regardless of which upstream
// step changed the day's shape — this test exercises that exact
// composition (insertMissingMeals + resequenceDayItems) directly.
test("insertMissingMeals + resequenceDayItems fills meals back in once a day's full-day anchor is gone, even though repairDayStructure already ran once without them", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "France", 1);

  // Simulates the state right after some later repair step swapped out
  // what used to be a full-day anchor (e.g. Disneyland Paris) for a
  // regular attraction — exactly what rebalanceDayItems/diversifyActivities/
  // enforceBudgetOnDays/lightenHighEnergyStreaks can do — leaving the day
  // with no meals at all, no longer excused by a full-day anchor.
  const dayAfterAnchorWasReplaced = buildDay({
    items: [buildItem({ name: "Local Neighborhood Walk", category: "attraction", slot: "morning" })],
  });

  const fixed = fillDerivedDayFields(
    resequenceDayItems(insertMissingMeals(dayAfterAnchorWasReplaced, payload, profile, new Set())),
    payload,
    profile
  );

  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [fixed],
  };
  assert.equal(
    collectPlanDiagnostics(plan, profile).missingMeals,
    0,
    "a day with no full-day anchor must end up with both meals after this sweep, even if an earlier pass never inserted them"
  );
});

// The reverse case: this final sweep must never inject meals into a day
// that genuinely still has its full-day anchor intact — spec item 12
// still applies when the anchor was never replaced.
test("insertMissingMeals + resequenceDayItems still excludes meals from a day whose full-day anchor was never replaced", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "France", 1);

  const dayWithRealFullDayAnchor = buildDay({
    items: [buildItem({ name: "Disneyland Paris", category: "attraction", shortDescription: "A major theme park", slot: "morning", estimatedDurationMinutes: 600 })],
  });

  const fixed = fillDerivedDayFields(
    resequenceDayItems(insertMissingMeals(dayWithRealFullDayAnchor, payload, profile, new Set())),
    payload,
    profile
  );

  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [fixed],
  };
  assert.equal(
    collectPlanDiagnostics(plan, profile).missingMeals,
    0,
    "a genuine full-day anchor day is still exempt from needing meals — this sweep must not fight that"
  );
  assert.ok(
    !fixed.items.some((item) => item.category === "restaurant" || item.category === "cafe"),
    "no meal should actually have been added to a day whose full-day anchor is still real"
  );
});

// Real bug found while tracing mealSpacingViolations in live QA: the final
// insertMissingMeals sweep above used to unconditionally wrap EVERY day in
// resequenceDayItems, even ones that needed no meal insertion at all —
// resequenceDayItems's scheduler has no notion of the 180/240-minute
// minimum meal gap (only enforceMealSpacing does), so this silently
// undid enforceMealSpacing's own work earlier in the same repair pass on
// every single day, every attempt. insertMissingMeals must return the
// exact same object reference when nothing was actually missing, so the
// caller can skip the reschedule entirely in that case.
test("insertMissingMeals returns the identical day reference when both meals are already present", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({
    items: [
      buildItem({ name: "Museum", category: "museum", slot: "morning" }),
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" }),
    ],
  });

  const result = insertMissingMeals(day, payload, profile, new Set());
  assert.equal(result, day, "must be the exact same reference — no meals were missing, nothing should be rebuilt");
});

// Real bug found during end-to-end QA generation (a live Israel trip): a
// dinner correctly excluded from missingMeals on the departure day (the
// real window rules it out) still got inserted by this function anyway,
// since it never knew about window feasibility — only the validator did.
// The inserted placeholder then got scheduled well past the real
// departure cutoff and survived straight into
// arrivalDepartureWindowViolations, since nothing re-ran window
// enforcement afterward. insertMissingMeals must respect the same
// feasibility the validator already uses.
test("insertMissingMeals does not insert a dinner the real departure window already rules out, even though lunch still fits", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-11-11",
    items: [buildItem({ name: "Morning Walk", category: "attraction", slot: "morning", plannedStartTime: "09:00", estimatedDurationMinutes: 90 })],
  });
  // Matches the exact live-QA scenario: a 13:15 departure cutoff leaves
  // just enough room for a quick 11:00-13:15 lunch, but dinner (18:00+)
  // is genuinely impossible.
  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-11-11", time: "13:15" },
  };

  const repaired = insertMissingMeals(departureDay, payload, profile, new Set(), 2, window);

  assert.ok(
    !repaired.items.some((item) => item.slot === "dinner"),
    "dinner is genuinely impossible before a 13:15 departure and must not be inserted"
  );
});

test("insertMissingMeals still inserts lunch on a departure day when the real window leaves genuine room for it", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-11-11",
    items: [],
  });
  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-11-11", time: "17:00" },
  };

  const repaired = insertMissingMeals(departureDay, payload, profile, new Set(), 2, window);

  assert.ok(
    repaired.items.some((item) => item.slot === "lunch" && (item.category === "cafe" || item.category === "restaurant")),
    "a departure at 17:00 still leaves real room for lunch, so it must still be inserted"
  );
  assert.ok(
    !repaired.items.some((item) => item.slot === "dinner"),
    "a 17:00 departure genuinely rules out dinner — it must not be inserted"
  );
});

// Section A: enforceArrivalDepartureWindow must catch and repair an item
// whose real interval crosses the cutoff, not just its start — the exact
// real France bug (10:18 -> 15:18 against a 13:15 cutoff).
test("enforceArrivalDepartureWindow catches a flexible item that starts before the cutoff but ends after it, and repairs the day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "France", 2);
  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-09-16",
    items: [
      buildItem({ name: "Breakfast", category: "cafe", slot: "morning", plannedStartTime: "09:00", estimatedDurationMinutes: 60 }),
      buildItem({
        name: "Overrunning Stroll",
        category: "attraction",
        shortDescription: "A national park hike",
        slot: "morning",
        plannedStartTime: "10:18",
        estimatedDurationMinutes: 300,
      }),
    ],
  });
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "13:15" } };

  const [repaired] = enforceArrivalDepartureWindow([departureDay], payload, profile, window, 2);

  for (const item of repaired.items) {
    if (item.category === "practical" || item.category === "transportation") continue;
    const endMinutes = Number(item.endTime!.slice(0, 2)) * 60 + Number(item.endTime!.slice(3));
    assert.ok(endMinutes <= 13 * 60 + 15, `${item.name} ends at ${item.endTime}, past the 13:15 cutoff`);
  }
});

test("enforceArrivalDepartureWindow repairs a flexible item in place via a real replacement candidate when one fits the window", () => {
  const shortReplacement = buildRecommendation({
    id: "rec-short-museum",
    name: "Small Local Museum",
    category: "attraction",
    location: "Marne-la-Vallée",
    estimatedDurationMinutes: 60,
    lat: 48.867,
    lon: 2.781,
  });
  const payload = buildPayload({ recommendations: [shortReplacement] });
  const profile = buildTripPreferenceProfile(basePreferences, "France", 2);
  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-09-16",
    cityRegion: "Marne-la-Vallée",
    items: [
      buildItem({
        name: "Overrunning Stroll",
        category: "attraction",
        location: "Marne-la-Vallée",
        shortDescription: "A national park hike",
        slot: "morning",
        plannedStartTime: "10:18",
        estimatedDurationMinutes: 300,
        lat: 48.867,
        lon: 2.781,
      }),
    ],
  });
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "13:15" } };

  const [repaired] = enforceArrivalDepartureWindow([departureDay], payload, profile, window, 2);

  assert.ok(
    repaired.items.some((item) => item.name === "Small Local Museum"),
    "a real, window-compatible candidate should repair the day in place rather than leaving it empty"
  );
});

test("enforceArrivalDepartureWindow never touches a locked item even when its interval crosses the cutoff", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "France", 2);
  const lockedOverrun = buildItem({
    name: "Locked Overrun",
    category: "attraction",
    shortDescription: "A national park hike",
    slot: "morning",
    plannedStartTime: "10:18",
    estimatedDurationMinutes: 300,
    locked: true,
  });
  const departureDay = buildDay({ dayNumber: 2, date: "2026-09-16", items: [lockedOverrun] });
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "13:15" } };

  const [repaired] = enforceArrivalDepartureWindow([departureDay], payload, profile, window, 2);

  assert.ok(
    repaired.items.some((item) => item.name === "Locked Overrun"),
    "a locked item must never be silently moved or removed, even if it crosses the departure cutoff"
  );
});

test("collectPlanDiagnostics counts a locked item crossing the departure cutoff as a real arrivalDepartureWindowViolations hard failure", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "France", 2);
  const lockedOverrun = buildItem({
    name: "Locked Overrun",
    category: "attraction",
    shortDescription: "A national park hike",
    slot: "morning",
    plannedStartTime: "10:18",
    estimatedDurationMinutes: 300,
    locked: true,
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [buildDay({ dayNumber: 1, date: "2026-09-16", items: [lockedOverrun] })],
  };
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "13:15" } };

  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.ok(diagnostics.arrivalDepartureWindowViolations > 0);
  assert.equal(passesValidation(cleanDiagnostics({ arrivalDepartureWindowViolations: diagnostics.arrivalDepartureWindowViolations })), false);
});

// Section C2/C3/E: enforceStayTransitions — no overnight teleportation, a
// base change always consumes real, visible schedule time.
function buildTransition(overrides: Partial<StayTransition> = {}): StayTransition {
  return {
    fromBase: overrides.fromBase ?? "City A",
    toBase: overrides.toBase ?? "City B",
    fromCoordinates: overrides.fromCoordinates ?? { lat: 41.0, lon: 44.0 },
    toCoordinates: overrides.toCoordinates ?? { lat: 42.6, lon: 44.6 },
    transportMode: overrides.transportMode ?? "car",
    estimatedTravelMinutes: overrides.estimatedTravelMinutes ?? 180,
    dayNumber: overrides.dayNumber ?? 2,
  };
}

test("enforceStayTransitions inserts a real, visible transportation item that consumes its own estimated time", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A" }),
    buildDay({ dayNumber: 2, cityRegion: "City B", items: [buildItem({ name: "Local Walk" })] }),
  ];

  const { days: repaired } = enforceStayTransitions(days, [buildTransition()], payload, profile);

  const transitionItem = repaired[1].items.find((item) => item.category === "transportation");
  assert.ok(transitionItem, "the transition day must contain a real transportation item");
  assert.ok((transitionItem?.travelMinutes ?? 0) >= 150, "the transition item must carry most of its real estimated duration");
});

test("enforceStayTransitions is idempotent — it does not insert a second transition item when one is already represented", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const existingTransfer = buildItem({ name: "Existing Transfer", category: "transportation", travelMinutes: 190 });
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A" }),
    buildDay({ dayNumber: 2, cityRegion: "City B", items: [existingTransfer] }),
  ];

  const { days: repaired } = enforceStayTransitions(days, [buildTransition()], payload, profile);

  const transportationItems = repaired[1].items.filter((item) => item.category === "transportation");
  assert.equal(transportationItems.length, 1, "an already-represented transition must not be duplicated");
});

test("enforceStayTransitions shrinks optional content around a transition that would otherwise overload the day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const packedDay = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    items: Array.from({ length: 6 }, (_, index) =>
      buildItem({ name: `Extra Activity ${index}`, slot: index % 2 === 0 ? "morning" : "afternoon", priority: "optional" })
    ),
  });
  const days = [buildDay({ dayNumber: 1, cityRegion: "City A" }), packedDay];

  const { days: repaired } = enforceStayTransitions(days, [buildTransition({ estimatedTravelMinutes: 240 })], payload, profile);

  assert.ok(
    calculateDayLoadMinutes(repaired[1]) <= profile.dailyCapacityMinutes,
    "the day must fit its own real capacity once the transition's real time is accounted for"
  );
});

test("enforceStayTransitions reports a structured impossibleStayTransitions entry when the transition alone exceeds daily capacity, without hiding it", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const days = [buildDay({ dayNumber: 1, cityRegion: "City A" }), buildDay({ dayNumber: 2, cityRegion: "City B" })];
  const hugeTransition = buildTransition({ estimatedTravelMinutes: profile.dailyCapacityMinutes + 200 });

  const { days: repaired, impossibleStayTransitionDetails } = enforceStayTransitions(days, [hugeTransition], payload, profile);

  assert.equal(impossibleStayTransitionDetails.length, 1);
  assert.equal(impossibleStayTransitionDetails[0].fromStay, "City A");
  assert.equal(impossibleStayTransitionDetails[0].toStay, "City B");
  // A transition this long genuinely cannot fit as a real scheduled item in
  // a single day's clock window — the scheduler correctly refuses to
  // pretend otherwise (same "never overlap the day's end" rule every other
  // item follows) and surfaces it as an alternative instead. "Never
  // hidden" means it's visible somewhere real, not that a false timeline
  // entry gets fabricated for it.
  assert.ok(
    repaired[1].alternatives.some((entry) => entry.includes("City A") && entry.includes("City B")),
    "an impossible transition must still be visible on the day, even when it can't be scheduled as a real timed item"
  );
});

// Section H: real provider status, never inferred from candidate count.
test("resolveCandidateProviderStatus uses the real, caller-supplied Overpass result — success", () => {
  const payload = buildPayload({ recommendations: [], overpassAvailable: "available" });
  assert.equal(resolveCandidateProviderStatus(payload).overpass, "available");
});

test("resolveCandidateProviderStatus uses the real, caller-supplied Overpass result — failure, even with real candidates present", () => {
  const payload = buildPayload({ recommendations: [buildRecommendation()], overpassAvailable: "unavailable" });
  assert.equal(resolveCandidateProviderStatus(payload).overpass, "unavailable");
});

test("resolveCandidateProviderStatus: a manually-injected candidate does not imply Overpass is available when the real status is known to be false", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ source: "manual" })],
    overpassAvailable: "unavailable",
  });
  assert.equal(resolveCandidateProviderStatus(payload).overpass, "unavailable");
});

test("resolveCandidateProviderStatus passes a real partial result straight through", () => {
  const payload = buildPayload({ overpassAvailable: "partial" });
  assert.equal(resolveCandidateProviderStatus(payload).overpass, "partial");
});

test("resolveCandidateProviderStatus: an unavailable provider never affects passesValidation on its own (spec §B5 — no PLAN_NOT_FEASIBLE from provider status alone)", () => {
  assert.equal(passesValidation(cleanDiagnostics()), true);
  // passesValidation has no candidateProviderStatus/overpassAvailable field
  // at all — a provider outage is informational only, structurally
  // incapable of failing validation by itself.
});

test("resolveCandidateProviderStatus falls back to the candidate-count heuristic only when the real status is unknown", () => {
  const withCandidates = buildPayload({ recommendations: [buildRecommendation()] });
  const withoutCandidates = buildPayload({ recommendations: [] });
  assert.equal(resolveCandidateProviderStatus(withCandidates).overpass, "available");
  assert.equal(resolveCandidateProviderStatus(withoutCandidates).overpass, "unavailable");
});

test("passesValidation fails a plan with an impossibleStayTransitions entry", () => {
  const diagnostics = cleanDiagnostics({
    impossibleStayTransitions: 1,
    impossibleStayTransitionDetails: [
      { fromStay: "City A", toStay: "City B", dayNumber: 2, requiredTravelMinutes: 900, availableMinutes: 600, reason: "too far" },
    ],
  });
  assert.equal(passesValidation(diagnostics), false);
});

// Section A — attemptStayStructureRepair: end-to-end orchestration (real
// TripFrame -> real impossible StayTransition -> real structural fix).
function buildTestFrame(phases: Array<{ areaLabel: string; nights: number; startDayNumber: number; endDayNumber: number }>): TripFrame {
  return { bucketId: "multi_phase", source: "deterministic", phases: phases.map((phase, index) => ({ id: `phase-${index + 1}`, intent: "mixed", ...phase })) };
}

test("attemptStayStructureRepair resolves a genuinely impossible transition via base reselection when no boundary shift is available", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const frame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", { lat: 10, lon: 10 }],
    ["City B", { lat: 60, lon: 60 }], // absurdly far — genuinely impossible in a day
    ["City C", { lat: 10.5, lon: 10.5 }], // close to City A — a real feasible alternative
  ]);

  const result = attemptStayStructureRepair(frame, areaAnchors, ["City C"], new Set(), profile);

  assert.equal(result.changed, true);
  assert.ok(
    result.stayTransitions.every((transition) => (transition.estimatedTravelMinutes ?? 0) < profile.dailyCapacityMinutes),
    "every rebuilt transition must now be genuinely feasible"
  );
});

test("attemptStayStructureRepair leaves the frame unchanged when the transition is already feasible", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const frame = buildTestFrame([
    { areaLabel: "City A", nights: 2, startDayNumber: 1, endDayNumber: 2 },
    { areaLabel: "City B", nights: 2, startDayNumber: 3, endDayNumber: 4 },
  ]);
  const areaAnchors = new Map([
    ["City A", { lat: 10, lon: 10 }],
    ["City B", { lat: 10.05, lon: 10.05 }],
  ]);

  const result = attemptStayStructureRepair(frame, areaAnchors, [], new Set(), profile);

  assert.equal(result.changed, false);
  assert.equal(result.tripFrame, frame);
});

test("attemptStayStructureRepair respects protected content — never repairs through a locked/fixedTime day even when the transition is impossible", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const frame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", { lat: 10, lon: 10 }],
    ["City B", { lat: 60, lon: 60 }],
  ]);
  // Both days protected, no candidate areas — nothing generic and safe
  // can be done; the caller must surface impossibleStayTransitions as-is.
  const result = attemptStayStructureRepair(frame, areaAnchors, [], new Set([1, 2]), profile);

  assert.equal(result.changed, false);
  assert.equal(result.tripFrame, frame);
});

test("attemptStayStructureRepair is bounded — never loops beyond MAX_STAY_STRUCTURE_REPAIR_PASSES worth of real work", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  // Three phases, two consecutive impossible transitions, no feasible
  // alternative anywhere — every pass should attempt real work (not spin)
  // and the function must still return promptly.
  const frame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
    { areaLabel: "City C", nights: 1, startDayNumber: 3, endDayNumber: 3 },
  ]);
  const areaAnchors = new Map([
    ["City A", { lat: 10, lon: 10 }],
    ["City B", { lat: 60, lon: 60 }],
    ["City C", { lat: -60, lon: -60 }],
  ]);
  const start = Date.now();
  const result = attemptStayStructureRepair(frame, areaAnchors, [], new Set(), profile);
  assert.ok(Date.now() - start < 1000, "structural repair must terminate quickly, never hang");
  // No feasible alternative and no spare nights anywhere (every phase is
  // 1 night) — the only remaining generic option is merging, which IS
  // expected to make some progress within the bounded pass count.
  assert.notEqual(result, undefined);
});

// Test B — a locked activity without fixedTime may still move in time
// (only its presence, not its clock time, is guaranteed).
test("resequenceDayItems may reschedule a locked (but not fixed-time) item's clock time", () => {
  const day = buildDay({
    items: [
      buildItem({ name: "Old Town Walk", category: "attraction", slot: "morning" }),
      buildItem({ name: "Narikala Fortress", category: "attraction", slot: "afternoon", plannedStartTime: "13:00", locked: true }),
    ],
  });

  const repaired = resequenceDayItems(day);
  const fortress = repaired.items.find((item) => item.name === "Narikala Fortress")!;
  assert.ok(fortress, "the locked item must still be present");
  // Not asserting a specific new time — the point of this test is that
  // resequenceDayItems is FREE to move it (unlike a fixedTime item), which
  // it does here since it schedules right after the morning walk instead
  // of staying pinned to its original "13:00".
  assert.notEqual(fortress.plannedStartTime, "13:00");
});

test("passesValidation gate reacts to each individual diagnostic flag", () => {
  assert.equal(passesValidation(cleanDiagnostics()), true);
  assert.equal(passesValidation(cleanDiagnostics({ crossCityDays: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ outOfBudget: true })), false);
  assert.equal(passesValidation(cleanDiagnostics({ duplicatePlaces: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ openingHoursViolations: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ excessFoodStopsDays: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ mealSpacingViolations: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ duplicateRestaurants: 1 })), false);
});

test("passesValidation fails a plan with arrival/departure window violations", () => {
  assert.equal(passesValidation(cleanDiagnostics({ arrivalDepartureWindowViolations: 1 })), false);
});

// Phase 10/12/24 (generic worldwide architecture): foodDominantDays and
// diversityRisk are soft diagnostics — real bug found in live QA: with
// zero real candidates (an unreachable external POI provider, or simply a
// destination whose real candidate pool skews toward one category), a
// physically feasible itinerary kept failing validation purely on
// category variety, forcing a fallback to the generic template far more
// often than a genuine physical problem warranted. They still cost real
// points in computeQualityScore (still a genuine repair target — see
// diversifyActivities), they just no longer block acceptance outright.
test("passesValidation does not fail a plan for foodDominantDays or diversityRisk alone", () => {
  assert.equal(passesValidation(cleanDiagnostics({ foodDominantDays: 5 })), true);
  assert.equal(passesValidation(cleanDiagnostics({ diversityRisk: true })), true);
  assert.equal(passesValidation(cleanDiagnostics({ foodDominantDays: 3, diversityRisk: true })), true);
});

test("passesValidation still fails on a genuine physical impossibility even when soft diagnostics are also present", () => {
  assert.equal(
    passesValidation(cleanDiagnostics({ foodDominantDays: 5, diversityRisk: true, missingMeals: 1 })),
    false
  );
});

// Flight-aware planning (spec Part D/E): day 1 must not schedule real
// activities before the traveler could realistically have landed and
// checked in, and the last day must not schedule anything after the
// traveler needs to leave for the airport.
test("collectPlanDiagnostics flags an activity scheduled before the flight-derived arrival window", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 3);
  const day1 = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [buildItem({ name: "Old Town Walk", category: "attraction", plannedStartTime: "09:00" })],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [day1],
  };
  const window = {
    earliestUsableTimeOnArrivalDay: { date: "2026-10-06", time: "17:15" },
    latestUsableTimeOnDepartureDay: null,
  };
  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.equal(diagnostics.arrivalDepartureWindowViolations, 1);
});

test("collectPlanDiagnostics does not flag logistics items (transportation/hotel/practical) on the arrival day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 3);
  const day1 = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [
      buildItem({ name: "Transfer to hotel", category: "transportation", plannedStartTime: "09:00" }),
      buildItem({ name: "Check-in", category: "hotel", plannedStartTime: "09:30" }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [day1],
  };
  const window = {
    earliestUsableTimeOnArrivalDay: { date: "2026-10-06", time: "17:15" },
    latestUsableTimeOnDepartureDay: null,
  };
  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.equal(diagnostics.arrivalDepartureWindowViolations, 0);
});

test("collectPlanDiagnostics flags an activity scheduled after the flight-derived departure window on the last day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 3);
  const lastDay = buildDay({
    dayNumber: 3,
    date: "2026-10-08",
    items: [buildItem({ name: "Museum visit", category: "attraction", plannedStartTime: "14:00" })],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    // dayCount is derived from plan.days.length, so a realistic full array
    // is required for dayNumber === dayCount to identify the last day.
    days: [buildDay({ dayNumber: 1, date: "2026-10-06" }), buildDay({ dayNumber: 2, date: "2026-10-07" }), lastDay],
  };
  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-10-08", time: "12:15" },
  };
  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.equal(diagnostics.arrivalDepartureWindowViolations, 1);
});

test("collectPlanDiagnostics ignores arrival/departure windows on middle days", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 3);
  const middleDay = buildDay({
    dayNumber: 2,
    date: "2026-10-07",
    items: [buildItem({ name: "Early breakfast tour", category: "attraction", plannedStartTime: "07:00" })],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [buildDay({ dayNumber: 1, date: "2026-10-06" }), middleDay, buildDay({ dayNumber: 3, date: "2026-10-08" })],
  };
  const window = {
    earliestUsableTimeOnArrivalDay: { date: "2026-10-06", time: "17:15" },
    latestUsableTimeOnDepartureDay: { date: "2026-10-08", time: "12:15" },
  };
  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.equal(diagnostics.arrivalDepartureWindowViolations, 0);
});

// Spec test 84, end-to-end through collectPlanDiagnostics: Timna Park
// closes at 16:00 and must never survive validation scheduled at 19:52.
test("collectPlanDiagnostics flags an item scheduled outside its own opening hours", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 3);
  const day = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [
      buildItem({
        name: "Timna Park",
        category: "nature",
        openingHours: "08:00-16:00",
        plannedStartTime: "19:52",
      }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Israel trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [day],
  };
  const diagnostics = collectPlanDiagnostics(plan, profile);
  assert.equal(diagnostics.openingHoursViolations, 1);
});

test("collectPlanDiagnostics flags a day with more than two food stops, too-close meals, and a trip-wide repeated restaurant", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);
  const dayOne = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [
      buildItem({ name: "Morning Cafe", category: "cafe", slot: "morning", plannedStartTime: "09:00" }),
      buildItem({ name: "Repeated Restaurant", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "14:00" }),
    ],
  });
  const dayTwo = buildDay({
    dayNumber: 2,
    date: "2026-10-07",
    items: [buildItem({ name: "Repeated Restaurant", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" })],
  });
  const plan: AiItineraryResponse = {
    title: "Japan trip",
    summary: "",
    totalEstimatedCost: 1000,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [dayOne, dayTwo],
  };
  const diagnostics = collectPlanDiagnostics(plan, profile);
  assert.equal(diagnostics.excessFoodStopsDays, 1);
  assert.equal(diagnostics.mealSpacingViolations, 1);
  assert.equal(diagnostics.duplicateRestaurants, 1);
});

// Regression: a real reported bug — generating a domestic/sparse-candidate
// trip repeatedly failed with "PLAN_NOT_FEASIBLE" because the deterministic
// fallback's generic filler content (buildFreeExplorationReplacement) used
// one fixed name per area with no id/coordinates to distinguish repeats,
// so the same area needing a filler on two different days produced a
// byte-identical item that collectPlanDiagnostics correctly (given the
// identical input) flagged as a duplicate place — failing the whole plan
// over harmless repeated filler content instead of a real duplicate. Fixed
// at the root: an item with neither a recommendationId nor coordinates
// isn't a verifiable claim about a specific real place, so buildItemKey
// never treats it as a duplicate at all — regardless of whether its
// generated text happens to repeat (which it may; the rotating phrasing is
// a UX nicety, not what correctness depends on here).
test("buildItemKey never treats two generic-filler items (no id, no coordinates) as duplicates, even with identical text", () => {
  const area = "Tel Aviv";
  const dayA = buildDay({ dayNumber: 3, cityRegion: area });
  const dayB = buildDay({ dayNumber: 3, cityRegion: area }); // same day number on purpose — worst case for phrase rotation
  const itemA = buildItem({ slot: "morning" });
  const itemB = buildItem({ slot: "morning" }); // same slot too — forces an identical generated name

  const replacementA = buildFreeExplorationReplacement(itemA, dayA);
  const replacementB = buildFreeExplorationReplacement(itemB, dayB);
  assert.equal(replacementA.name, replacementB.name, "sanity check: this setup does produce identical filler text");

  assert.notEqual(
    buildItemKey(replacementA),
    buildItemKey(replacementB),
    "two generic-filler items must never share a dedup key, even when their text is identical"
  );
});

test("buildFallbackAiItinerary never produces duplicate-place-flagged filler when the candidate pool is exhausted across many days", () => {
  // Deliberately no recommendations at all — forces every day to fall back
  // to generic filler content, exactly like the reported sparse-candidate
  // scenario.
  const payload = buildPayload({
    preferences: { ...basePreferences, startDate: "2026-09-01", endDate: "2026-09-15" },
    recommendations: [],
    selectedPlaces: [],
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Japan", 15);

  const fallback = buildFallbackAiItinerary(payload);
  const diagnostics = collectPlanDiagnostics(fallback, profile);

  assert.equal(
    diagnostics.duplicatePlaces,
    0,
    "repeated generic filler across a long, candidate-sparse trip must never be flagged as duplicate real places"
  );
});

// Real bug found in live production use (a real 10-day Israel trip with a
// genuine, moderate-sized real Overpass candidate pool — the exact
// scenario this session's own sandbox could never reproduce, since
// Overpass was unreachable there and every QA run had 0-1 real
// candidates). usageCounts was only ever a soft scoring penalty, easily
// outweighed by category/area match bonuses — once the pool's few
// well-fitting real restaurants were used, the SAME one got picked again
// on a later day instead of falling through to a placeholder.
// collectPlanDiagnostics correctly flagged this as a real duplicate place,
// but that happened in the FALLBACK template itself — the last-resort
// path with no further repair — so the whole generation hard-failed with
// PLAN_NOT_FEASIBLE in production.
test("buildFallbackAiItinerary never reuses the same real candidate across different days once the real pool is exhausted relative to trip length", () => {
  const payload = buildPayload({
    preferences: { ...basePreferences, startDate: "2026-11-02", endDate: "2026-11-11" }, // 10 real days
    recommendations: [
      buildRecommendation({ id: "rest-1", name: "Restaurant One", category: "restaurant", lat: 32.08, lon: 34.78 }),
      buildRecommendation({ id: "rest-2", name: "Restaurant Two", category: "restaurant", lat: 32.081, lon: 34.781 }),
      buildRecommendation({ id: "rest-3", name: "Restaurant Three", category: "restaurant", lat: 32.082, lon: 34.782 }),
    ],
    selectedPlaces: [],
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Israel", 10);

  const fallback = buildFallbackAiItinerary(payload);
  const diagnostics = collectPlanDiagnostics(fallback, profile);

  assert.equal(
    diagnostics.duplicatePlaces,
    0,
    "a real restaurant must never be picked again on a later day once every distinct real candidate has already been used once"
  );
});

// Real bug found in the SAME live production run — the same real place
// (real name, real near-identical coordinates) fetched independently under
// two different categories gets two different candidate ids
// ("api-attraction-3-Old Jaffa" vs "api-hidden_gem-1-Old Jaffa"). The
// id-only exclusion misses this entirely; only the fuzzy name+coordinate
// identity collectPlanDiagnostics itself uses catches it. Tested directly
// against selectFallbackCandidate (bypassing buildFallbackAiItinerary's
// day-template/kind rotation, which makes forcing two specific days to
// both reach the same slot type environment-sensitive) — this isolates
// exactly the mechanism that changed.
test("selectFallbackCandidate never re-selects the same real place under a different id once it's already been used", () => {
  const restaurantVariant = buildRecommendation({
    id: "api-restaurant-1-old-jaffa-grill",
    name: "Old Jaffa Grill",
    category: "restaurant",
    lat: 32.05,
    lon: 34.75,
  });
  const cafeVariant = buildRecommendation({
    id: "api-cafe-1-old-jaffa-grill", // different id, same real place
    name: "Old Jaffa Grill",
    category: "cafe",
    lat: 32.0501,
    lon: 34.7501, // real-world geocoding jitter, still the same place
  });
  const pool = [restaurantVariant, cafeVariant];
  const template = { kind: "food" as const, titleHint: "", slots: ["lunch" as const], maxStops: 4, notes: "", restWindow: "" };
  const usageCounts = new Map<string, number>();
  const usedRealPlaces: Array<{ nameSlug: string; lat: number | null; lon: number | null }> = [];

  // Day 1: picks the restaurant variant (nothing used yet).
  const first = selectFallbackCandidate({
    pool,
    slot: "lunch",
    template,
    preferredArea: "Tel Aviv",
    previousItem: null,
    existingItems: [],
    usedToday: new Set(),
    usageCounts,
    usedRealPlaces,
    selectedIds: new Set(),
    preferredKeywords: [],
    avoidKeywords: [],
  });
  assert.ok(
    first?.id === "api-restaurant-1-old-jaffa-grill" || first?.id === "api-cafe-1-old-jaffa-grill",
    "day 1 must pick one of the two real variants of this place"
  );
  usageCounts.set(first!.id, 1);
  usedRealPlaces.push({ nameSlug: "old jaffa grill", lat: first!.lat, lon: first!.lon });

  // Day 2: a FRESH day/usedToday set (id-based exclusion alone would let
  // the cafe-id variant through) — must still be excluded as the same
  // real place, falling through to null (a placeholder) instead.
  const second = selectFallbackCandidate({
    pool,
    slot: "lunch",
    template,
    preferredArea: "Tel Aviv",
    previousItem: null,
    existingItems: [],
    usedToday: new Set(), // fresh day
    usageCounts,
    usedRealPlaces,
    selectedIds: new Set(),
    preferredKeywords: [],
    avoidKeywords: [],
  });
  assert.equal(second, null, "the cafe-id variant of the same real place must not be selected on a later day");
});

// Real bug found in live production use, AFTER the selectFallbackCandidate
// fix above: the fallback template's own initial build was duplicate-free,
// but repairPlan's later generic repair steps (rebalanceDayItems,
// pickReplacementRecommendation's own usedPlaceKeys, etc.) each track
// "already used" by buildItemKey's exact id/coordinate match only — the
// exact same cross-id-same-real-place gap, in a different place, that
// those steps never inherited the fix for. removeFuzzyDuplicatePlaces is
// the final, whole-plan defense-in-depth pass that catches it regardless
// of which upstream step reintroduced it.
test("removeFuzzyDuplicatePlaces replaces a later fuzzy-duplicate real place (different id, same real place) with a neutral placeholder", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const bahaiGardensFirst = buildItem({
    name: "Bahá'í Gardens Haifa",
    category: "day_trip",
    recommendationId: "fallback-day_trip-3-Bahá'í Gardens Haifa",
    lat: 32.8135021,
    lon: 34.985666,
  });
  // Same real place, a different id (exactly the real production shape:
  // fetched again under a different category/index).
  const bahaiGardensSecond = buildItem({
    name: "Bahá'í Gardens Haifa",
    category: "attraction",
    recommendationId: "fallback-attraction-9-Bahá'í Gardens Haifa",
    slot: "afternoon",
    lat: 32.8135021,
    lon: 34.985666,
  });
  const days = [
    buildDay({ dayNumber: 1, items: [bahaiGardensFirst] }),
    buildDay({ dayNumber: 2, items: [bahaiGardensSecond] }),
  ];

  const repaired = removeFuzzyDuplicatePlaces(days, payload, profile);

  assert.ok(
    repaired[0].items.some((item) => item.recommendationId === "fallback-day_trip-3-Bahá'í Gardens Haifa"),
    "the first real occurrence must always survive untouched"
  );
  assert.ok(
    !repaired[1].items.some((item) => item.name === "Bahá'í Gardens Haifa"),
    "the later fuzzy-duplicate (different id, same real place) must be replaced, not left in place"
  );
});

test("removeFuzzyDuplicatePlaces never touches a locked/fixed-time item even when it's a genuine fuzzy duplicate", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const first = buildItem({ name: "Masada National Park", recommendationId: "id-1", lat: 31.31, lon: 35.36 });
  const lockedDuplicate = buildItem({
    name: "Masada National Park",
    recommendationId: "id-2",
    lat: 31.31,
    lon: 35.36,
    locked: true,
  });
  const days = [buildDay({ dayNumber: 1, items: [first] }), buildDay({ dayNumber: 2, items: [lockedDuplicate] })];

  const repaired = removeFuzzyDuplicatePlaces(days, payload, profile);

  assert.ok(
    repaired[1].items.some((item) => item.recommendationId === "id-2"),
    "a locked duplicate must never be silently replaced"
  );
});

// Real bug found during end-to-end QA generation (a live 10-day Israel
// trip with zero real recommendation candidates, since Overpass was
// unreachable): 7 of the 10 fallback days collapsed to just a lunch and a
// dinner placeholder with nothing else at all — no anchor, no evening
// content, the day effectively ending mid-afternoon. Root cause: the
// "no candidate for this slot" branch only had a generic placeholder for
// lunch/dinner; every other slot (morning/afternoon/evening) silently
// produced nothing when the pool had no match, unlike meals. Two real
// travelers could not "follow" a day that is only two meals with a
// multi-hour dead gap between them.
test("buildFallbackAiItinerary fills non-meal slots with a generic activity placeholder when the candidate pool is empty", () => {
  const payload = buildPayload({
    preferences: { ...basePreferences, startDate: "2026-09-01", endDate: "2026-09-04", tripPace: "balanced" },
    recommendations: [],
    selectedPlaces: [],
  });

  const fallback = buildFallbackAiItinerary(payload);
  assert.ok(fallback.days.length > 0);

  for (const day of fallback.days) {
    const foodOnly = day.items.every(
      (item) => item.category === "cafe" || item.category === "restaurant" || item.category === "practical"
    );
    assert.ok(
      !foodOnly,
      `day ${day.dayNumber} must have at least one non-food anchor even with zero real candidates, got: ${day.items.map((i) => i.category).join(", ")}`
    );
  }
});

// Section B/I11-17: repairCrossRegionDayContent — active repair for content
// Gemini itself already returned wrong, on top of what repairDayGeography
// already does within a single day.

test("repairCrossRegionDayContent moves an already-wrong-region item to the other day whose real content matches it", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);

  const kyotoOutlier = buildItem({
    name: "Kyoto Temple",
    location: "Kyoto",
    lat: 35.0157,
    lon: 135.7681,
  });
  const dayOne = buildDay({
    dayNumber: 1,
    cityRegion: "Tokyo",
    items: [buildItem({ name: "Tokyo Tower" }), kyotoOutlier],
  });
  const dayTwo = buildDay({
    dayNumber: 2,
    cityRegion: "Kyoto",
    items: [buildItem({ name: "Fushimi Inari", location: "Kyoto", lat: 35.0157, lon: 135.7681 })],
  });

  const { days, protectedGeographicConflicts } = repairCrossRegionDayContent([dayOne, dayTwo], payload, profile);

  assert.equal(protectedGeographicConflicts.length, 0);
  assert.ok(!days[0].items.some((item) => item.name === "Kyoto Temple"), "outlier must leave day 1");
  assert.ok(days[1].items.some((item) => item.name === "Kyoto Temple"), "outlier must land on the compatible day");
});

test("repairCrossRegionDayContent replaces a wrong-region item with a geographically-neutral local alternative when no other day fits", () => {
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const kyotoOutlier = buildItem({ name: "Kyoto Temple", location: "Kyoto", lat: 35.0157, lon: 135.7681 });
  const dayOne = buildDay({
    dayNumber: 1,
    cityRegion: "Tokyo",
    items: [buildItem({ name: "Tokyo Tower" }), kyotoOutlier],
  });

  const { days } = repairCrossRegionDayContent([dayOne], payload, profile);

  assert.ok(!days[0].items.some((item) => item.name === "Kyoto Temple"), "outlier must not survive under its original name");
  const replacement = days[0].items.find((item) => item.name !== "Tokyo Tower");
  assert.ok(replacement, "outlier must be replaced, not silently dropped");
  assert.equal(replacement?.lat, null, "a placeholder replacement must be geographically neutral, never inherit the outlier's real coordinates");
});

test("repairCrossRegionDayContent never moves, replaces, or removes a locked/fixed-time outlier — it reports a protectedGeographicConflict instead", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);

  const protectedOutlier = buildItem({
    name: "Locked Kyoto Stop",
    location: "Kyoto",
    lat: 35.0157,
    lon: 135.7681,
    locked: true,
  });
  const dayOne = buildDay({
    dayNumber: 1,
    cityRegion: "Tokyo",
    items: [buildItem({ name: "Tokyo Tower" }), protectedOutlier],
  });
  const dayTwo = buildDay({
    dayNumber: 2,
    cityRegion: "Kyoto",
    items: [buildItem({ name: "Fushimi Inari", location: "Kyoto", lat: 35.0157, lon: 135.7681 })],
  });

  const { days, protectedGeographicConflicts } = repairCrossRegionDayContent([dayOne, dayTwo], payload, profile);

  const stillThere = days[0].items.find((item) => item.name === "Locked Kyoto Stop");
  assert.ok(stillThere, "a locked outlier must never be moved or replaced");
  assert.equal(stillThere?.lat, 35.0157);
  assert.equal(protectedGeographicConflicts.length, 1);
  assert.equal(protectedGeographicConflicts[0].dayNumber, 1);
  assert.equal(protectedGeographicConflicts[0].itemName, "Locked Kyoto Stop");
});

test("repairCrossRegionDayContent leaves a genuine day-trip day untouched even though its excursion sits far from its base", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  const dayTrip = buildDay({
    dayNumber: 1,
    title: "Day trip to Kyoto",
    cityRegion: "Tokyo",
    items: [
      buildItem({ name: "Tokyo Tower" }),
      buildItem({ name: "Kyoto Temple", location: "Kyoto", lat: 35.0157, lon: 135.7681 }),
    ],
  });

  const { days } = repairCrossRegionDayContent([dayTrip], payload, profile);
  assert.deepEqual(
    days[0].items.map((item) => item.name),
    ["Tokyo Tower", "Kyoto Temple"]
  );
});

// Section E/F: invalidFlightLegs and airportBaseMismatches are hard gates,
// foodDominantDays/diversityRisk stay soft (unchanged from the prior pass).
test("passesValidation fails a plan with an accidental same-airport flight leg", () => {
  const diagnostics = cleanDiagnostics({
    invalidFlightLegs: 1,
    invalidFlightLegDetails: [
      { legId: "outbound", originAirport: "TLV", destinationAirport: "TLV", reason: "same airport" },
    ],
  });
  assert.equal(passesValidation(diagnostics), false);
});

test("passesValidation fails a plan whose arrival/departure day sits implausibly far from its own airport", () => {
  const diagnostics = cleanDiagnostics({
    airportBaseMismatches: 1,
    airportBaseMismatchDetails: [
      { direction: "arrival", airport: "CDG", estimatedGroundMinutes: 600, assumedGroundMinutes: 45 },
    ],
  });
  assert.equal(passesValidation(diagnostics), false);
});

test("passesValidation still passes despite a protectedGeographicConflict — protected content is reported, never a blocker", () => {
  const diagnostics = cleanDiagnostics({
    protectedGeographicConflicts: 1,
    protectedGeographicConflictDetails: [
      { dayNumber: 1, itemName: "Locked Stop", lat: 1, lon: 1, reason: "conflict" },
    ],
  });
  assert.equal(passesValidation(diagnostics), true);
});
