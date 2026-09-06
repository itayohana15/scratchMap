import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDayGeography,
  buildBudgetAllocation,
  buildGenerationSummary,
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  computeQualityScore,
  countDayTimeOverlaps,
  isDayTripDay,
  normalizeCoordinatePair,
  normalizeActionableMessages,
  normalizePlaceNameSlug,
  buildDayExplanation,
  buildRouteHealthIndicators,
  scoreRouteProximity,
  summarizeItemCosts,
  withNormalizedRecommendationPrice,
  MEAL_MAX_TRAVEL_MINUTES,
  MEAL_MAX_WALKING_MINUTES,
  type ExchangeRateContext,
  type PlanDiagnostics,
} from "../src/lib/server/itinerary-generation-constraints";
import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryResponse,
  TripPreferences,
  TripRecommendation,
} from "../src/lib/trip-workspace";

const basePreferences: TripPreferences = {
  startDate: "2026-10-06",
  endDate: "2026-10-07",
  partialDate: "",
  travelers: 2,
  budget: 22500,
  tripStyle: "culture and food",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "food, neighborhoods, markets",
  transportationPreferences: "public transport",
  accommodationArea: "Tokyo Station",
  dietaryPreferences: "vegetarian",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "Tokyo, Kyoto",
  mustVisitPlaces: "Senso-ji",
  placesToAvoid: "",
  safetyConstraints: "",
};

function buildRecommendation(
  overrides: Partial<TripRecommendation> = {}
): TripRecommendation {
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
    endTime: overrides.endTime,
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
    accommodation: overrides.accommodation ?? "Tokyo Station",
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

function baseDiagnostics(overrides: Partial<PlanDiagnostics> = {}): PlanDiagnostics {
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

test("computeQualityScore returns 100 for a diagnostics-clean plan", () => {
  assert.equal(computeQualityScore(baseDiagnostics()), 100);
});

test("computeQualityScore deducts for each non-zero diagnostic and never goes below 0", () => {
  const mildlyFlawed = computeQualityScore(baseDiagnostics({ crossCityDays: 1 }));
  assert.ok(mildlyFlawed < 100 && mildlyFlawed >= 0);

  const severelyFlawed = computeQualityScore(
    baseDiagnostics({
      crossCityDays: 20,
      longTravelDays: 20,
      openingHoursViolations: 20,
      outOfBudget: true,
      duplicatePlaces: 20,
    })
  );
  assert.equal(severelyFlawed, 0);
});

test("computeQualityScore scores a worse plan strictly lower than a better one", () => {
  const better = computeQualityScore(baseDiagnostics());
  const worse = computeQualityScore(baseDiagnostics({ openingHoursViolations: 2, mealSpacingViolations: 1 }));
  assert.ok(worse < better);
});

test("buildBudgetAllocation stays normalized and adjusts for food-heavy relaxed trips", () => {
  const allocation = buildBudgetAllocation(
    {
      ...basePreferences,
      generationMode: "relaxed",
      interests: "food, culinary markets, local gastronomy",
    },
    16
  );

  const total =
    allocation.accommodation +
    allocation.food +
    allocation.transportation +
    allocation.attractions +
    allocation.shopping +
    allocation.buffer;

  assert.ok(Math.abs(total - 1) < 0.000001);
  assert.ok(allocation.food > 0.2);
  assert.ok(allocation.buffer >= 0.11);
});

// Spec item 22 — shopping is its own budget line, not folded into attractions.
test("buildBudgetAllocation gives shopping a real, non-zero share that still sums to 1", () => {
  const allocation = buildBudgetAllocation(basePreferences, 10);
  assert.ok(allocation.shopping > 0);
  const total =
    allocation.accommodation +
    allocation.food +
    allocation.transportation +
    allocation.attractions +
    allocation.shopping +
    allocation.buffer;
  assert.ok(Math.abs(total - 1) < 0.000001);
});

test("buildBudgetAllocation increases shopping's share when the traveler's interests mention it", () => {
  // basePreferences' own default interests already mention "markets"
  // (triggers this same nudge), so the baseline here uses neutral
  // interests to actually isolate the effect being tested.
  const neutral = buildBudgetAllocation({ ...basePreferences, tripStyle: "sightseeing", interests: "museums, history" }, 10);
  const shoppingFocused = buildBudgetAllocation(
    { ...basePreferences, tripStyle: "sightseeing", interests: "shopping, malls, boutiques" },
    10
  );
  assert.ok(shoppingFocused.shopping > neutral.shopping);
});

test("summarizeItemCosts breaks shopping out as its own category instead of folding it into attractions", () => {
  const day = {
    items: [
      { category: "shopping" as const, approximatePrice: 300 },
      { category: "attraction" as const, approximatePrice: 100 },
    ],
    estimatedCost: 400,
    activityCost: 400,
    foodCost: 0,
    transportCost: 0,
    accommodationCost: 0,
  };
  const summary = summarizeItemCosts([day], 2);
  assert.equal(summary.categoryBreakdown.shopping, 300);
  assert.equal(summary.categoryBreakdown.attractions, 100);
});

test("withNormalizedRecommendationPrice preserves original currency and converts to ILS", () => {
  const context: ExchangeRateContext = {
    sourceCurrency: "JPY",
    targetCurrency: "ILS",
    rateToTarget: 0.023,
    updatedAt: "2026-08-08T00:00:00.000Z",
    source: "provider",
  };
  const recommendation = buildRecommendation({
    name: "Soba Lunch",
    category: "restaurant",
    approximatePrice: 2000,
  });

  const normalized = withNormalizedRecommendationPrice(recommendation, context);

  assert.equal(normalized.priceOriginalAmount, 2000);
  assert.equal(normalized.priceOriginalCurrency, "JPY");
  assert.equal(normalized.priceConvertedAmount, 46);
  assert.equal(normalized.approximatePrice, 46);
  assert.equal(normalized.priceExchangeRate, 0.023);
});

test("normalizeActionableMessages removes duplicates and generic cleanup warnings", () => {
  const normalized = normalizeActionableMessages([
    "יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה.",
    "יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה. ",
    "היום צפוף מדי וצריך להזיז פעילות",
    "Add a nearby food stop.",
    "יש מקטע מעבר ארוך במיוחד. כדאי לבדוק כרטיסים, עומסי דרך או חלופה קרובה יותר.",
  ]);

  assert.deepEqual(normalized, [
    "יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה.",
    "יש מקטע מעבר ארוך במיוחד. כדאי לבדוק כרטיסים, עומסי דרך או חלופה קרובה יותר.",
  ]);
});

test("calculateDayLoadMinutes includes travel, meal buffers, and rest windows", () => {
  const minutes = calculateDayLoadMinutes(
    buildDay({
      restWindow: "מנוחה קלה במלון",
      items: [
        buildItem({ slot: "morning", estimatedDurationMinutes: 120, travelMinutes: 30 }),
        buildItem({
          slot: "lunch",
          category: "restaurant",
          estimatedDurationMinutes: 60,
          travelMinutes: 10,
        }),
      ],
    })
  );

  assert.equal(minutes, 255);
});

test("collectPlanDiagnostics flags budget, duplicates, overload, avoid conflicts, and missing must-visits", () => {
  const profile = buildTripPreferenceProfile(
    {
      ...basePreferences,
      budget: 1000,
      tripPace: "relaxed",
      mustVisitPlaces: "Kyoto",
      placesToAvoid: "Narisawa",
    },
    "Japan",
    2
  );

  const duplicateAttraction = buildItem({
    name: "Tokyo Tower",
    location: "Minato",
    recommendationId: "tower-1",
    estimatedDurationMinutes: 150,
    approximatePrice: 180,
    lat: 35.6586,
    lon: 139.7454,
  });

  const dayOne = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    transportation: "",
    estimatedCost: 700,
    items: [
      duplicateAttraction,
      buildItem({
        name: "Shibuya Crossing",
        location: "Shibuya",
        estimatedDurationMinutes: 140,
        travelMinutes: 60,
        approximatePrice: 160,
        lat: 35.6595,
        lon: 139.7005,
      }),
      buildItem({
        name: "Meiji Shrine",
        location: "Shibuya",
        slot: "afternoon",
        estimatedDurationMinutes: 140,
        travelMinutes: 50,
        approximatePrice: 150,
        lat: 35.6764,
        lon: 139.6993,
      }),
      buildItem({
        name: "Narisawa",
        category: "restaurant",
        location: "Minato",
        slot: "dinner",
        estimatedDurationMinutes: 120,
        travelMinutes: 25,
        approximatePrice: 420,
        lat: 35.6641,
        lon: 139.7241,
      }),
    ],
    warnings: [
      "יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה.",
      "יש פעילויות עם סיכון לקונפליקט בשעות הפתיחה. בדקו מול המקום לפני היציאה.",
    ],
  });

  const dayTwo = buildDay({
    dayNumber: 2,
    date: "2026-10-07",
    accommodation: "",
    transportation: "",
    estimatedCost: 600,
    items: [
      buildItem({
        name: "Tokyo Tower",
        location: "Minato",
        recommendationId: "tower-1",
        estimatedDurationMinutes: 120,
        approximatePrice: 180,
        lat: 35.6586,
        lon: 139.7454,
      }),
      buildItem({
        name: "Ueno Park",
        location: "Ueno",
        slot: "lunch",
        category: "cafe",
        estimatedDurationMinutes: 60,
        travelMinutes: 15,
        approximatePrice: 70,
        lat: 35.7148,
        lon: 139.7745,
      }),
      buildItem({
        name: "Asakusa Walk",
        location: "Asakusa",
        slot: "afternoon",
        estimatedDurationMinutes: 110,
        travelMinutes: 30,
        approximatePrice: 80,
        lat: 35.7147,
        lon: 139.7967,
      }),
      buildItem({
        name: "Akihabara",
        location: "Chiyoda",
        slot: "evening",
        estimatedDurationMinutes: 110,
        travelMinutes: 30,
        approximatePrice: 90,
        lat: 35.6984,
        lon: 139.773,
      }),
      buildItem({
        name: "Yanaka",
        location: "Taito",
        slot: "night",
        estimatedDurationMinutes: 100,
        travelMinutes: 25,
        approximatePrice: 50,
        lat: 35.7277,
        lon: 139.7669,
      }),
      buildItem({
        name: "Odaiba Walk",
        location: "Odaiba",
        slot: "night",
        estimatedDurationMinutes: 90,
        travelMinutes: 35,
        approximatePrice: 60,
        lat: 35.6272,
        lon: 139.7768,
      }),
    ],
  });

  const plan: AiItineraryResponse = {
    title: "Tokyo Sampler",
    summary: "",
    totalEstimatedCost: 1300,
    estimatedTransportCost: 120,
    averageDailyCost: 650,
    costPerTraveler: 650,
    categoryBreakdown: {
      attractions: 1010,
      food: 490,
      transportation: 120,
      accommodation: 0,
      other: 0,
    },
    days: [dayOne, dayTwo],
  };

  const diagnostics = collectPlanDiagnostics(plan, profile);

  assert.equal(diagnostics.missingMeals, 2);
  assert.equal(diagnostics.duplicatePlaces, 1);
  assert.equal(diagnostics.duplicateWarnings, 1);
  assert.equal(diagnostics.overloadedDays, 2);
  assert.equal(diagnostics.missingAccommodation, 1);
  assert.equal(diagnostics.missingTransport, 2);
  assert.equal(diagnostics.avoidConflicts, 1);
  assert.deepEqual(diagnostics.missingMustVisitKeywords, ["kyoto"]);
  assert.equal(diagnostics.overSoftBudget, true);
  assert.equal(diagnostics.outOfBudget, true);
  assert.equal(diagnostics.diversityRisk, true);
  assert.equal(diagnostics.dominantCategory, "attraction");
  assert.equal(diagnostics.invalidCoordinates, 0);
  assert.equal(diagnostics.crossCityDays, 0);
  assert.equal(diagnostics.longTravelDays, 2);
  assert.equal(diagnostics.foodDominantDays, 0);
  assert.equal(diagnostics.missingAnchorDays, 0);
  assert.ok(diagnostics.longMealDetours >= 1);
});

// Section J: a genuine day trip's long outbound/return travel is
// intentional, not a suspicious detour — must not count toward
// longTravelDays the same way an ordinary day's unexpected long travel does.
test("collectPlanDiagnostics does not count a genuine day trip's long round-trip travel as longTravelDays", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);
  const dayTrip = buildDay({
    dayNumber: 1,
    title: "Day trip to the mountains",
    items: [
      buildItem({ name: "Base City Stop", location: "City", lat: 32.08, lon: 34.78 }),
      buildItem({ name: "Distant Excursion", location: "Mountains", slot: "afternoon", lat: 33.5, lon: 35.5 }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [dayTrip],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).longTravelDays, 0);
});

// Section I root cause (a real Georgia QA run): a day whose transportation
// text genuinely described a multi-stop intercity drive ("private car with
// stops along the way") matched none of TRANSFER_DAY_PATTERN's keywords,
// so it was scored as an ordinary day and its real transfer travel time
// wrongly tripped longTravelDays.
test("collectPlanDiagnostics recognizes a 'stops along the way' road-trip day as a transfer day, not an ordinary one", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 1);
  // Coordinate-less on purpose — matches the exact real case (this sandbox
  // had zero real Overpass candidates, so every item's distance is
  // unknown; only the AI's own stated travelMinutes is trusted).
  const transferDay = buildDay({
    dayNumber: 1,
    title: "יום 1 בGeorgia",
    transportation: "נסיעה ברכב פרטי עם עצירות בדרך.",
    items: [
      buildItem({ name: "Ananuri Fortress", location: "Ananuri", lat: null, lon: null, travelMinutes: 0 }),
      buildItem({ name: "Gudauri Monument", location: "Gudauri", slot: "afternoon", lat: null, lon: null, travelMinutes: 40 }),
      buildItem({ name: "Kazbegi Market", location: "Kazbegi", slot: "evening", lat: null, lon: null, travelMinutes: 50 }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [transferDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).longTravelDays, 0);
});

test("collectPlanDiagnostics still counts an unexpected long detour on an ordinary (non-day-trip, non-transfer) day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);
  const ordinaryDay = buildDay({
    dayNumber: 1,
    title: "A regular day in the city",
    items: [
      buildItem({ name: "Morning Stop", location: "City", lat: 32.08, lon: 34.78 }),
      buildItem({ name: "Unexpectedly Far Stop", location: "Far Region", slot: "afternoon", lat: 33.5, lon: 35.5 }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [ordinaryDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).longTravelDays, 1);
});

// Real bug found during end-to-end QA generation: a real 10-day Georgia
// trip's departure day (breakfast+checkout, airport transfer, a lunch
// stop, then flying home) has no realistic dinner — the traveler is
// mid-flight or already home by 19:00. missingMeals used to demand both
// meals on every day unconditionally, so this perfectly realistic
// departure day failed validation on both real Gemini attempts, forcing
// a fallback to the generic template on essentially every normal trip.
test("collectPlanDiagnostics does not demand a dinner on a departure day the arrival/departure window rules out", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-10-07",
    items: [
      buildItem({ name: "Breakfast & Checkout", category: "attraction", slot: "morning", plannedStartTime: "08:00" }),
      buildItem({ name: "Airport Transfer", category: "transportation", slot: "morning", plannedStartTime: "09:30" }),
      buildItem({ name: "Quick Lunch", category: "cafe", slot: "lunch", plannedStartTime: "11:00" }),
    ],
  });
  const firstDay = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [
      buildItem({ name: "Old Town Walk", category: "attraction", slot: "morning" }),
      buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" }),
      buildItem({ name: "Dinner Spot", category: "restaurant", slot: "dinner", plannedStartTime: "19:00" }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [firstDay, departureDay],
  };

  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-10-07", time: "13:00" },
  };

  const diagnostics = collectPlanDiagnostics(plan, profile, null, window);
  assert.equal(diagnostics.missingMeals, 0, "dinner is infeasible on this departure day and must not count as missing");
});

// Real bug found during end-to-end QA generation (a live France trip): a
// FIXED reference clock time (12:30) said lunch was feasible in principle
// on a departure day, but the day's own morning activity pushed real
// lunch-time content past the cutoff — repair's enforceArrivalDepartureWindow
// correctly strips anything scheduled that late, so missingMeals could
// never converge even though the validator thought the meal was fine.
// This checks the day's real remaining slack, not just a generic clock
// reference.
test("collectPlanDiagnostics does not demand lunch on a departure day whose own morning content already fills the window up to the cutoff", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "France", 2);
  const departureDay = buildDay({
    dayNumber: 1,
    date: "2026-09-16",
    items: [
      buildItem({
        name: "Morning Old Town Walk",
        category: "attraction",
        slot: "morning",
        plannedStartTime: "09:00",
        estimatedDurationMinutes: 210, // ends 12:30, right up against the cutoff
      }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "France Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [departureDay],
  };

  const window = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-09-16", time: "12:45" }, // only 15 real minutes left
  };

  assert.equal(
    collectPlanDiagnostics(plan, profile, null, window).missingMeals,
    0,
    "the morning activity leaves no real gap for lunch before the cutoff, even though 12:45 alone would look fine in isolation"
  );
});

test("collectPlanDiagnostics still flags a missing dinner on a normal day, or a departure day with plenty of usable time left", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 2);
  const normalDay = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [buildItem({ name: "Lunch Spot", category: "restaurant", slot: "lunch", plannedStartTime: "13:00" })],
  });
  const plan: AiItineraryResponse = {
    title: "Georgia Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [normalDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).missingMeals, 1);

  const lateDepartureWindow = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-10-06", time: "21:00" },
  };
  assert.equal(
    collectPlanDiagnostics(plan, profile, null, lateDepartureWindow).missingMeals,
    1,
    "a late-enough departure still leaves real time for dinner, so it must still be required"
  );
});

// Real bug found during end-to-end QA generation (a live France trip with
// Disneyland Paris): resequenceDayItems deliberately drops both meals from
// a day built around a genuine full-day anchor (spec item 12 — a full-day
// attraction already includes food on-site), but missingMeals had no
// matching exemption, so this perfectly realistic day kept failing
// validation and forced a fallback to the generic template.
test("collectPlanDiagnostics does not demand lunch/dinner on a day built around a genuine full-day anchor", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "France", 7);
  const disneylandDay = buildDay({
    dayNumber: 3,
    items: [
      buildItem({
        name: "Disneyland Paris",
        category: "attraction",
        shortDescription: "A major theme park",
        slot: "morning",
        plannedStartTime: "09:30",
        estimatedDurationMinutes: 600,
      }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "France Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [disneylandDay],
  };

  assert.equal(
    collectPlanDiagnostics(plan, profile).missingMeals,
    0,
    "a genuine full-day anchor day is not expected to have separate lunch/dinner stops"
  );
});

test("collectPlanDiagnostics still demands meals on a normal day with only regular-length anchors", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "France", 7);
  const normalDay = buildDay({
    dayNumber: 3,
    items: [buildItem({ name: "Louvre Museum", category: "museum", slot: "morning", estimatedDurationMinutes: 150 })],
  });
  const plan: AiItineraryResponse = {
    title: "France Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [normalDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).missingMeals, 2);
});

// Real bug found during end-to-end QA generation: isAnchorCategory here was
// a separate, drifted-apart copy of country-itinerary-generation.ts's
// isAnchorDayItem, missing the same "practical" exclusion — a day whose
// only item is a free-time filler wrongly read as "has an anchor".
test("collectPlanDiagnostics' missingAnchorDays does not count a bare practical filler item as a real anchor", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "France", 3);
  const fillerOnlyDay = buildDay({
    dayNumber: 2,
    items: [buildItem({ name: "זמן חופשי", category: "practical", slot: "afternoon" })],
  });
  const plan: AiItineraryResponse = {
    title: "France Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [fillerOnlyDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).missingAnchorDays, 1);
});

// Spec item 58's "three activities at 12:30" symptom — a structural check,
// independent of any scheduler having run, so it also catches raw AI output.
test("collectPlanDiagnostics flags overlapping items via timeOverlaps", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const overlappingDay = buildDay({
    dayNumber: 1,
    items: [
      buildItem({ name: "Museum", plannedStartTime: "12:30", estimatedDurationMinutes: 120 }),
      buildItem({ name: "Market", plannedStartTime: "12:30", estimatedDurationMinutes: 60 }),
      buildItem({ name: "Viewpoint", plannedStartTime: "13:00", estimatedDurationMinutes: 30 }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [overlappingDay],
  };

  const diagnostics = collectPlanDiagnostics(plan, profile);
  assert.ok(diagnostics.timeOverlaps >= 2, `expected at least 2 overlaps, got ${diagnostics.timeOverlaps}`);
});

test("collectPlanDiagnostics reports zero timeOverlaps for a real sequential timeline", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const sequentialDay = buildDay({
    dayNumber: 1,
    items: [
      buildItem({ name: "Museum", plannedStartTime: "09:00", estimatedDurationMinutes: 120 }),
      buildItem({ name: "Market", plannedStartTime: "11:30", estimatedDurationMinutes: 60 }),
      buildItem({ name: "Viewpoint", plannedStartTime: "13:00", estimatedDurationMinutes: 30 }),
    ],
  });
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [sequentialDay],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).timeOverlaps, 0);
});

// Section G regression: a real France QA run showed timeOverlaps: 1.
// Root cause — countDayTimeOverlaps recomputed every item's duration via
// resolveVisitDurationMinutes/classifyVisitScale, which floors a short
// item up to its visit-scale's minimum (quick_stop's floor is 15 minutes).
// A short "practical" gap-filler the scheduler legitimately gave only 5
// real minutes (itinerary-scheduler.ts's isFillerItem branch allows as
// little as 5) got its recomputed duration inflated to 15 — long enough to
// falsely collide with a tightly-scheduled next item that never actually
// overlapped on the real timeline.
test("countDayTimeOverlaps does not flag a short practical filler against its own real scheduled end time", () => {
  const day = buildDay({
    dayNumber: 1,
    items: [
      buildItem({
        name: "מעבר קצר",
        category: "practical",
        plannedStartTime: "12:00",
        endTime: "12:05",
        estimatedDurationMinutes: 5,
      }),
      buildItem({ name: "תצפית", category: "attraction", plannedStartTime: "12:10", estimatedDurationMinutes: 30 }),
    ],
  });

  assert.equal(countDayTimeOverlaps(day), 0);
});

test("countDayTimeOverlaps still catches a real overlap between two practical fillers", () => {
  const day = buildDay({
    dayNumber: 1,
    items: [
      buildItem({ name: "מנוחה", category: "practical", plannedStartTime: "12:00", endTime: "15:00" }),
      buildItem({ name: "שיטוט", category: "practical", plannedStartTime: "14:00", endTime: "16:00" }),
    ],
  });

  assert.equal(countDayTimeOverlaps(day), 1);
});

test("normalizePlaceNameSlug strips parenthetical suffixes and punctuation so near-duplicate names match", () => {
  assert.equal(normalizePlaceNameSlug("Mtatsminda Park (Funicular)"), normalizePlaceNameSlug("Mtatsminda Park"));
  assert.notEqual(normalizePlaceNameSlug("Mtatsminda Park"), normalizePlaceNameSlug("Rike Park"));
});

// Spec item 52/56's "duplicate Mtatsminda Park" symptom — the AI can easily
// hallucinate slightly different coordinates for the same real landmark
// across two mentions; the old 4-decimal (~11m) coordinate key missed that
// drift entirely.
test("collectPlanDiagnostics catches the same place mentioned twice with slightly drifted coordinates", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);
  const plan: AiItineraryResponse = {
    title: "Trip",
    summary: "",
    totalEstimatedCost: 0,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [
      buildDay({
        dayNumber: 1,
        items: [buildItem({ name: "Mtatsminda Park", lat: 41.693, lon: 44.789, recommendationId: null })],
      }),
      buildDay({
        dayNumber: 2,
        items: [
          // Same real place, ~50m away (well within the same ~111m grid
          // cell) and a slightly different mention of the name.
          buildItem({ name: "Mtatsminda Park (Funicular)", lat: 41.6934, lon: 44.7893, recommendationId: null }),
        ],
      }),
    ],
  };

  assert.equal(collectPlanDiagnostics(plan, profile).duplicatePlaces, 1);
});

// Spec item 13 — a day trip keeps its overnight base but its stops sit far
// away for the day; that must never be flagged as the "wrong-city
// restaurant"-style cross-city violation described in spec item 58.
test("isDayTripDay recognizes a day-trip title but not a plain sightseeing day or a transfer day", () => {
  assert.equal(isDayTripDay(buildDay({ title: "יום טיול לבורג'ומי", notes: "" })), true);
  assert.equal(isDayTripDay(buildDay({ title: "Day trip to Borjomi", notes: "" })), true);
  assert.equal(isDayTripDay(buildDay({ title: "טביליסי העתיקה", notes: "" })), false);
  assert.equal(isDayTripDay(buildDay({ title: "מעבר לבטומי", notes: "checkout and transfer" })), false);
});

// Spec item 48: a genuine round-trip structure (starts and ends near the
// same base, one genuinely far middle stop) is recognized as a day trip
// even with zero day-trip wording.
test("isDayTripDay recognizes a real round-trip structure without any day-trip wording", () => {
  const day = buildDay({
    title: "Tbilisi",
    notes: "",
    items: [
      buildItem({ name: "Tbilisi Old Town Morning", category: "attraction", slot: "morning", lat: 41.6934, lon: 44.8015 }),
      buildItem({ name: "Kazbegi Viewpoint", category: "nature", slot: "afternoon", lat: 42.6578, lon: 44.6427 }),
      buildItem({ name: "Tbilisi Old Town Evening", category: "attraction", slot: "evening", lat: 41.694, lon: 44.802 }),
    ],
  });
  assert.equal(isDayTripDay(day), true);
});

// The regression this structural check exists to protect: a same-day
// Tokyo+Osaka mix with no day-trip wording and no return to Tokyo must
// stay unrecognized as a day trip — distance between two anchors alone is
// never enough (see the docstring on isDayTripDay itself).
test("isDayTripDay does not recognize a same-day city mix that never returns to its base", () => {
  const day = buildDay({
    title: "Tokyo",
    notes: "",
    items: [
      buildItem({ name: "Senso-ji", category: "attraction", slot: "morning", lat: 35.7148, lon: 139.7967 }),
      buildItem({ name: "Osaka Castle", category: "attraction", slot: "afternoon", lat: 34.6873, lon: 135.5262 }),
    ],
  });
  assert.equal(isDayTripDay(day), false);
});

test("analyzeDayGeography does not flag a day trip's Tbilisi departure + Borjomi visit as cross-city mixing", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  // Real coordinates: Tbilisi ~41.72,44.83 vs. Borjomi ~41.84,43.39 — well
  // past DISTANT_CITY_DISTANCE_KM, which is exactly the "Borjomi and
  // Tbilisi mixed in one day" symptom from spec item 58, except here it's a
  // legitimate day trip, not a mistake.
  const sharedItems = [
    buildItem({ name: "Breakfast near the hotel", category: "cafe", location: "Tbilisi", lat: 41.7151, lon: 44.8271 }),
    buildItem({ name: "Borjomi Park", location: "Borjomi", lat: 41.8407, lon: 43.3921, travelMinutes: 150 }),
  ];

  const plainDay = buildDay({ title: "טביליסי העתיקה", accommodation: "Tbilisi Hotel", cityRegion: "Tbilisi", items: sharedItems });
  assert.ok(
    analyzeDayGeography(plainDay, profile).crossCityItems.length > 0,
    "sanity check: without day-trip recognition this mix would (correctly) be flagged"
  );

  const dayTrip = buildDay({
    title: "יום טיול לבורג'ומי",
    accommodation: "Tbilisi Hotel",
    cityRegion: "Tbilisi",
    items: sharedItems,
  });
  assert.equal(analyzeDayGeography(dayTrip, profile).crossCityItems.length, 0);
});

test("buildGenerationSummary highlights budget success and key trip counts", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 2);
  const plan: AiItineraryResponse = {
    title: "Japan Lite",
    summary: "",
    totalEstimatedCost: 21000,
    estimatedTransportCost: 3200,
    averageDailyCost: 10500,
    costPerTraveler: 10500,
    categoryBreakdown: {
      attractions: 9000,
      food: 5000,
      transportation: 3200,
      accommodation: 3800,
      other: 0,
    },
    days: [
      buildDay({
        dayNumber: 1,
        items: [
          buildItem({ name: "Senso-ji", category: "attraction", slot: "morning" }),
          buildItem({ name: "Nakamise", category: "shopping", slot: "afternoon" }),
          buildItem({ name: "Local Soba", category: "restaurant", slot: "dinner" }),
        ],
      }),
      buildDay({
        dayNumber: 2,
        date: "2026-10-07",
        cityRegion: "Kyoto",
        items: [
          buildItem({ name: "Fushimi Inari", category: "attraction", slot: "morning" }),
          buildItem({ name: "Tea House", category: "cafe", slot: "lunch" }),
          buildItem({ name: "Gion Walk", category: "hidden_gem", slot: "evening" }),
        ],
        restWindow: "אחר צהריים קל",
      }),
    ],
  };

  const summary = buildGenerationSummary(plan, profile);

  assert.match(summary, /בתוך יעד התקציב של ₪22500/);
  assert.match(summary, /2 ימים/);
  assert.match(summary, /2 אזורים/);
  assert.match(summary, /2 עצירות אוכל/);
});

test("normalizeCoordinatePair fixes obvious lat-lon swaps and rejects impossible pairs", () => {
  const swapped = normalizeCoordinatePair(139.6917, 35.6895);
  assert.equal(swapped.isValid, true);
  assert.equal(swapped.wasSwapped, true);
  assert.equal(swapped.lat, 35.6895);
  assert.equal(swapped.lon, 139.6917);

  const valid = normalizeCoordinatePair(35.6895, 139.6917);
  assert.equal(valid.isValid, true);
  assert.equal(valid.wasSwapped, false);

  const invalid = normalizeCoordinatePair(230, 410);
  assert.equal(invalid.isValid, false);
  assert.equal(invalid.lat, null);
  assert.equal(invalid.lon, null);
});

test("scoreRouteProximity strongly prefers nearby food over distant detours", () => {
  const anchor = buildItem({
    name: "Senso-ji",
    category: "attraction",
    location: "Asakusa, Tokyo",
    lat: 35.7148,
    lon: 139.7967,
  });
  const nextStop = buildItem({
    name: "Ueno Park",
    category: "nature",
    location: "Ueno, Tokyo",
    lat: 35.7147,
    lon: 139.7745,
  });
  const nearbyMeal = buildRecommendation({
    id: "meal-nearby",
    name: "Tempura Lunch",
    category: "restaurant",
    location: "Asakusa, Tokyo",
    lat: 35.7153,
    lon: 139.7972,
  });
  const farMeal = buildRecommendation({
    id: "meal-far",
    name: "Harbor Dinner",
    category: "restaurant",
    location: "Yokohama",
    lat: 35.454,
    lon: 139.631,
  });

  const nearby = scoreRouteProximity(nearbyMeal, {
    anchor,
    nextStop,
    pace: "balanced",
    transportation: "הליכה",
  });
  const far = scoreRouteProximity(farMeal, {
    anchor,
    nextStop,
    pace: "balanced",
    transportation: "הליכה",
  });

  assert.ok(nearby.score > far.score);
  assert.equal(nearby.exceedsLimit, false);
  assert.equal(far.exceedsLimit, true);
});

// New rule: a restaurant must be under 45 minutes away in general, but
// under 20 minutes specifically when reached on foot.
test("scoreRouteProximity's meal-specific hard caps flip exceedsLimit at 20 minutes walking and 45 minutes otherwise", () => {
  const anchor = buildItem({ name: "Senso-ji", category: "attraction", lat: 35.7148, lon: 139.7967 });
  // ~1.5km — about 22 minutes on foot (4km/h), well under 45 minutes by
  // any faster mode.
  const midDistanceMeal = buildRecommendation({
    id: "meal-mid",
    name: "Mid-Distance Diner",
    category: "restaurant",
    lat: 35.728,
    lon: 139.7967,
  });

  const walking = scoreRouteProximity(midDistanceMeal, {
    anchor,
    pace: "balanced",
    transportation: "הליכה",
    hardLimitMinutes: MEAL_MAX_WALKING_MINUTES,
  });
  assert.ok(
    walking.anchorTravelMinutes != null && walking.anchorTravelMinutes > MEAL_MAX_WALKING_MINUTES,
    "fixture must actually exceed the walking cap"
  );
  assert.equal(walking.exceedsLimit, true);

  const driving = scoreRouteProximity(midDistanceMeal, {
    anchor,
    pace: "balanced",
    transportation: "נסיעה ברכב",
    hardLimitMinutes: MEAL_MAX_TRAVEL_MINUTES,
  });
  assert.ok(driving.anchorTravelMinutes != null && driving.anchorTravelMinutes < MEAL_MAX_TRAVEL_MINUTES);
  assert.equal(driving.exceedsLimit, false);
});

// Spec item 96: a real, content-derived explanation, not invented flavor text.
test("buildDayExplanation mentions geographic clustering when the day has no long travel or cross-city mixing", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({
    cityRegion: "Asakusa",
    items: [buildItem({ name: "Senso-ji", category: "attraction", lat: 35.7148, lon: 139.7967 })],
  });
  const geography = analyzeDayGeography(day, profile);
  const explanation = buildDayExplanation(day, geography);
  assert.ok(explanation.includes("מרוכז"));
});

// Wiring guarantee for country-itinerary-details-dialog.tsx's "why this
// day works" section (spec Phase C item 1) — it renders unconditionally
// whenever the string is non-empty, so this must never actually be empty
// for a real day, across the same profile-building call the dialog makes.
test("buildDayExplanation is never empty for a real day, using the same profile-building call the UI makes", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 5);
  const day = buildDay({
    cityRegion: "Shinjuku",
    items: [buildItem({ name: "Shinjuku Gyoen", category: "nature", slot: "afternoon", lat: 35.6852, lon: 139.71 })],
  });
  const explanation = buildDayExplanation(day, analyzeDayGeography(day, profile));
  assert.ok(explanation.length > 0);
});

test("buildDayExplanation notes an evening outdoor activity when the day has one", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({
    items: [
      buildItem({ name: "Sunset Viewpoint", category: "nature", slot: "evening", lat: 35.7148, lon: 139.7967 }),
    ],
  });
  const geography = analyzeDayGeography(day, profile);
  const explanation = buildDayExplanation(day, geography);
  assert.ok(explanation.includes("ערב"));
});

// Spec item 97: only genuinely-true, positive-framed indicators — never a
// guess for a signal the caller doesn't actually know.
test("buildRouteHealthIndicators only returns indicators for signals it actually knows", () => {
  const indicators = buildRouteHealthIndicators({ longTravelSegments: 0, crossCityItems: 0, timeOverlaps: 0 });
  const labels = indicators.map((indicator) => indicator.label);
  assert.ok(labels.includes("מסלול יעיל"));
  assert.ok(labels.includes("אין התנגשויות"));
  assert.equal(labels.includes("מרווח ארוחות תקין"), false, "mealSpacingViolations was never provided");
  assert.equal(labels.includes("לינה ממוקמת היטב"), false, "hotelAverageTravelMinutes was never provided");
});

test("buildRouteHealthIndicators omits the efficient-route indicator when there's a real issue", () => {
  const indicators = buildRouteHealthIndicators({ longTravelSegments: 1, crossCityItems: 0 });
  assert.equal(indicators.some((indicator) => indicator.label === "מסלול יעיל"), false);
});

test("analyzeDayGeography detects cross-city mixing, long travel, and food-heavy days", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const day = buildDay({
    cityRegion: "Tokyo",
    transportation: "תחבורה מקומית",
    items: [
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
        name: "Late Cafe",
        category: "cafe",
        slot: "evening",
        location: "Namba, Osaka",
        lat: 34.6662,
        lon: 135.5003,
        travelMinutes: 20,
      }),
    ],
  });

  const diagnostics = analyzeDayGeography(day, profile);

  assert.ok(diagnostics.crossCityItems.includes("Osaka Castle"));
  assert.ok(diagnostics.longTravelSegments.some((segment) => segment.minutes >= 35));
  assert.ok(diagnostics.longMealDetours.some((segment) => segment.toName === "Sushi Counter"));
  assert.equal(diagnostics.foodDominant, true);
  assert.equal(diagnostics.isTransferDay, false);
});

// Real bug found via a real 44-day US QA run: duplicateRestaurants,
// foodDominant, and mealSpacingViolations all filtered by isFoodCategory
// alone, so a meal-opportunity placeholder (no recommendationId, no
// coordinates, by design — "not a real POI the traveler picks from the
// food tab") got validated as a real restaurant. Fixed by reusing
// duplicatePlaces' own real-place test (isRealPlaceCandidate). Invented
// synthetic geography ("Test City") — no real-world place name.
function buildPlanWithDay(day: AiGeneratedDay): AiItineraryResponse {
  return {
    title: "Test Trip",
    summary: "",
    totalEstimatedCost: 500,
    estimatedTransportCost: 0,
    averageDailyCost: 500,
    costPerTraveler: 500,
    categoryBreakdown: { attractions: 0, food: 0, transportation: 0, accommodation: 0, other: 0 },
    days: [day],
  };
}
const testProfile = buildTripPreferenceProfile(basePreferences, "Test Country", 1);

test("duplicateRestaurants: two identical meal-opportunity placeholders are not a duplicate restaurant", () => {
  const placeholderA = {
    ...buildItem({ name: "🍽 Recommended lunch spot", category: "cafe", slot: "lunch" }),
    lat: null,
    lon: null,
  };
  const placeholderB = {
    ...buildItem({ name: "🍽 Recommended lunch spot", category: "restaurant", slot: "dinner" }),
    lat: null,
    lon: null,
  };
  const day = buildDay({ items: [placeholderA, placeholderB] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.duplicateRestaurants, 0);
});

test("duplicateRestaurants: two identical real restaurants ARE a duplicate restaurant", () => {
  const realA = buildItem({
    name: "Test City Diner",
    category: "restaurant",
    slot: "lunch",
    recommendationId: "rec-diner-1",
    lat: 10.0,
    lon: 10.0,
  });
  const realB = buildItem({
    name: "Test City Diner",
    category: "restaurant",
    slot: "dinner",
    recommendationId: "rec-diner-2",
    lat: 10.0,
    lon: 10.0,
  });
  const day = buildDay({ items: [realA, realB] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.duplicateRestaurants, 1);
});

test("foodDominantDays: a day of only meal-opportunity placeholders is not food-dominant", () => {
  const placeholderLunch = {
    ...buildItem({ name: "🍽 Recommended lunch spot", category: "cafe", slot: "lunch" }),
    lat: null,
    lon: null,
  };
  const placeholderDinner = {
    ...buildItem({ name: "🍽 Recommended dinner spot", category: "restaurant", slot: "dinner" }),
    lat: null,
    lon: null,
  };
  const day = buildDay({ items: [placeholderLunch, placeholderDinner] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.foodDominantDays, 0);
});

test("foodDominantDays: a day of real food items with no real anchor IS food-dominant", () => {
  const realLunch = buildItem({
    name: "Test City Cafe",
    category: "cafe",
    slot: "lunch",
    recommendationId: "rec-cafe-1",
    lat: 10.0,
    lon: 10.0,
  });
  const realDinner = buildItem({
    name: "Test City Bistro",
    category: "restaurant",
    slot: "dinner",
    recommendationId: "rec-bistro-1",
    lat: 10.0,
    lon: 10.0,
  });
  const day = buildDay({ items: [realLunch, realDinner] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.foodDominantDays, 1);
});

test("mealSpacingViolations: two close-together meal-opportunity placeholders are not a spacing violation", () => {
  const placeholderLunch = {
    ...buildItem({ name: "🍽 Recommended lunch spot", category: "cafe", slot: "lunch", plannedStartTime: "12:00" }),
    lat: null,
    lon: null,
  };
  const placeholderDinner = {
    ...buildItem({ name: "🍽 Recommended dinner spot", category: "restaurant", slot: "dinner", plannedStartTime: "14:00" }),
    lat: null,
    lon: null,
  };
  const day = buildDay({ items: [placeholderLunch, placeholderDinner] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.mealSpacingViolations, 0);
});

test("mealSpacingViolations: two close-together REAL food items ARE a spacing violation", () => {
  const realLunch = buildItem({
    name: "Test City Cafe",
    category: "cafe",
    slot: "lunch",
    plannedStartTime: "12:00",
    recommendationId: "rec-cafe-2",
    lat: 10.0,
    lon: 10.0,
  });
  const realDinner = buildItem({
    name: "Test City Bistro",
    category: "restaurant",
    slot: "dinner",
    plannedStartTime: "14:00",
    recommendationId: "rec-bistro-2",
    lat: 10.0,
    lon: 10.0,
  });
  const day = buildDay({ items: [realLunch, realDinner] });
  const diagnostics = collectPlanDiagnostics(buildPlanWithDay(day), testProfile);
  assert.equal(diagnostics.mealSpacingViolations, 1);
});

// Spec test 83: Western Wall → Israel Museum (~2km apart in Jerusalem) must
// not be trusted as an implausibly fast walk just because the AI said so —
// the real distance-based estimate should surface it as a genuinely long
// local walk instead. (This haversine-based model has no real street
// routing/elevation data, so it can't reproduce the spec's own "real routes
// there take closer to an hour" framing exactly — the number below is
// chosen to be clearly below this model's own real estimate for the
// distance, which is what the implausibility check actually guards.)
test("analyzeDayGeography does not trust an implausibly fast stated travelMinutes for a real walking distance", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);
  const day = buildDay({
    cityRegion: "Jerusalem",
    transportation: "הליכה",
    items: [
      buildItem({
        name: "Western Wall",
        category: "attraction",
        slot: "morning",
        location: "Old City, Jerusalem",
        lat: 31.7767,
        lon: 35.2345,
      }),
      buildItem({
        name: "Israel Museum",
        category: "museum",
        slot: "afternoon",
        location: "Jerusalem",
        lat: 31.7702,
        lon: 35.2137,
        transportation: "הליכה",
        travelMinutes: 10,
      }),
    ],
  });

  const diagnostics = analyzeDayGeography(day, profile);
  assert.ok(
    diagnostics.longTravelSegments.some((segment) => segment.toName === "Israel Museum" && segment.minutes > 10),
    "a real ~2km walk must not be reported at the implausibly fast stated 10 minutes"
  );
});
