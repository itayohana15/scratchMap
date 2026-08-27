import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDayGeography,
  buildBudgetAllocation,
  buildGenerationSummary,
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  countDayTimeOverlaps,
  isDayTripDay,
  normalizeCoordinatePair,
  normalizeActionableMessages,
  normalizePlaceNameSlug,
  scoreRouteProximity,
  withNormalizedRecommendationPrice,
  type ExchangeRateContext,
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
    allocation.buffer;

  assert.ok(Math.abs(total - 1) < 0.000001);
  assert.ok(allocation.food > 0.2);
  assert.ok(allocation.buffer >= 0.11);
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
