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
  buildDeterministicTripFrame,
  buildFallbackMealPlaceholder,
  buildFreeExplorationReplacement,
  buildItemKey,
  computeAreaWeightsFromClusters,
  pickReplacementRecommendation,
  repairNormalDayTravelOutliers,
  enforceBudgetOnDays,
  fillUnderfilledDay,
  fixOverloadedDays,
  passesValidation,
  enforceMealCountLimit,
  enforceMealSpacing,
  ensureArrivalDepartureDayHasContent,
  enforceArrivalDepartureWindow,
  attemptStayStructureRepair,
  computeGeographyDiagnostics,
  summarizeGeographyDiagnostics,
  deriveDayType,
  enforceNormalDayLocality,
  enforceTransportRoleGuard,
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
  repairPlan,
  resolveCanonicalPlaceId,
  resolveItemPriceFields,
  scoreMealCandidate,
  type RawGeneratedPlan,
  type RawGeneratedItem,
} from "../src/lib/server/country-itinerary-generation";
import {
  buildFallbackAiItinerary,
  buildLegalDayCandidatePool,
  computeDestinationMobilityProfile,
  createItineraryUsageState,
  buildItineraryUsageState,
  isItineraryPlaceUsed,
  registerItineraryUsage,
  releaseItineraryUsage,
  isMealOpportunityMarker,
  selectFallbackCandidate,
} from "../src/lib/trip-workspace";
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
    itemRole: overrides.itemRole,
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

// Spec "תיקון גנרי, לא תיקון תשיעי" — enforceBudgetOnDays' own replacement
// call used to hand pickReplacementRecommendation a day view that still
// included the over-cap item being replaced, so a candidate close only
// to IT (never to the day's real anchor) could pass.
test("enforceBudgetOnDays never selects a replacement close only to the over-cap item itself, not to the day's real anchor", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "fake-near-overcap",
        name: "Fake Nearby To Over-Cap Item Only",
        category: "attraction",
        location: "Nowhere Real",
        approximatePrice: 10,
        // Close to the over-cap item (11.26, 10) — far from the real base (10, 10).
        lat: 11.261,
        lon: 10.001,
      }),
    ],
  });
  const day = buildDay({
    estimatedCost: 30010,
    activityCost: 30010,
    transportation: "רכב",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", approximatePrice: 10, lat: 10, lon: 10, transportation: "רכב" }),
      // ~140km from Base Anchor, explicit "רכב" to keep the recomputed
      // travel time schedulable rather than risking the scheduling-overflow
      // trap found earlier this round.
      buildItem({ name: "Over-Cap Item", category: "attraction", slot: "afternoon", approximatePrice: 30000, lat: 11.26, lon: 10, transportation: "רכב" }),
    ],
  });

  const [repaired] = enforceBudgetOnDays([day], payload, profile);

  assert.ok(
    !repaired.items.some((item) => item.name === "Fake Nearby To Over-Cap Item Only"),
    "a candidate close only to the over-cap item being replaced must never be selected"
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

  const usageState = createItineraryUsageState();
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
      usageState
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

// Spec "תיקון גנרי, לא תיקון תשיעי" — repairDayGeography's own cross-city
// outlier swap used to hand pickReplacementRecommendation a day view that
// still included the outlier being replaced, so a candidate close only to
// IT (never to the day's real primary anchor) could pass.
test("repairDayGeography's cross-city outlier swap never selects a replacement close only to the outlier itself", () => {
  // repairDayGeography retries internally up to 4 times — with only ONE
  // bad candidate in the pool, a first (buggy) selection gets "used up"
  // (usedPlaceKeys) and the SECOND attempt then has nothing left to pick,
  // falling to free exploration regardless of geography. That self-heals
  // the symptom on its own, silently passing this test even without the
  // real fix — several near-outlier-only candidates (one per possible
  // attempt) close that gap, since pool exhaustion alone can no longer
  // explain a passing result.
  const nearOutlierCandidates = Array.from({ length: 5 }, (_, index) =>
    buildRecommendation({
      id: `fake-near-outlier-${index}`,
      name: `Fake Nearby To Outlier Only ${index}`,
      category: "attraction",
      location: "Nowhere Real",
      // Close to the outlier (11.26, 10) — far from the real base (10, 10).
      lat: 11.261 + index * 0.001,
      lon: 10.001,
    })
  );
  const payload = buildPayload({ recommendations: nearOutlierCandidates });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  // ~140km (well past DISTANT_CITY_DISTANCE_KM=80) with explicit "רכב" —
  // real-world walking-speed distances risk a scheduling overflow that
  // would mask whether geography is what's actually rejecting the
  // candidate (the same trap found and worked around earlier this round).
  const day = buildDay({
    transportation: "רכב",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 10, lon: 10, transportation: "רכב" }),
      buildItem({ name: "Distant Outlier", category: "attraction", slot: "afternoon", lat: 11.26, lon: 10, transportation: "רכב" }),
    ],
  });

  const repaired = repairDayGeography(day, payload, profile);

  assert.ok(!repaired.items.some((item) => item.name === "Distant Outlier"), "outlier must not survive under its original name");
  assert.ok(
    !repaired.items.some((item) => item.name.startsWith("Fake Nearby To Outlier Only")),
    "a candidate close only to the outlier being replaced (not to the day's real primary anchor) must never be selected"
  );
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

// Spec "gav nv abrtv kl vfh yuc" (Phase B) — a Gemini-stated travelMinutes
// is invented text, not a real geographic computation; the model has no
// way to actually know the distance between two coordinates. Real
// coordinates must always win when both endpoints have them, and the
// result must scale with real distance across every order of magnitude —
// never saturate at a fixed ceiling regardless of how far apart the two
// points really are. Anchor point ("Point A") and three second points at
// increasing distance orders of magnitude — invented coordinates, not
// real named places, per this suite's own convention.
test("fillDerivedDayFields: real coordinates always win over a Gemini-stated travelMinutes, and the result is strictly monotonic across distance orders of magnitude", () => {
  const payload = buildPayload();
  const anchorLat = 10;
  const anchorLon = 10;

  function travelMinutesAtDistance(targetLat: number, targetLon: number): number {
    const day = buildDay({
      items: [
        buildItem({ name: "Point A (anchor)", lat: anchorLat, lon: anchorLon, travelMinutes: 20 }),
        // Every candidate here states the exact SAME Gemini-invented
        // travelMinutes (145) regardless of its real distance from the
        // anchor — reproducing the real-world symptom verbatim (Thor's
        // Well/Letchworth/Mendenhall/Magnificent Mile/Pioneer
        // Saloon/Mystery Spot all logged travelMinutes: 145 from the same
        // base, at wildly different real distances).
        buildItem({ name: "Point B (candidate)", lat: targetLat, lon: targetLon, travelMinutes: 145 }),
      ],
    });
    const filled = fillDerivedDayFields(day, payload);
    return filled.items.find((item) => item.name === "Point B (candidate)")!.travelMinutes!;
  }

  // Within-city order of magnitude (~2km).
  const withinCity = travelMinutesAtDistance(10.02, 10);
  // Between-nearby-cities order of magnitude (~50km).
  const betweenNearbyCities = travelMinutesAtDistance(10.45, 10);
  // Cross-continent order of magnitude (~8,000km — opposite hemisphere).
  const crossContinent = travelMinutesAtDistance(-60, 130);

  assert.notEqual(withinCity, 145, "the real, recomputed value must replace Gemini's invented 145, not just happen to also equal it");
  assert.notEqual(betweenNearbyCities, 145);
  assert.notEqual(crossContinent, 145);

  assert.ok(
    withinCity < betweenNearbyCities,
    `within-city (${withinCity}min) must be less than between-nearby-cities (${betweenNearbyCities}min)`
  );
  assert.ok(
    betweenNearbyCities < crossContinent,
    `between-nearby-cities (${betweenNearbyCities}min) must be less than cross-continent (${crossContinent}min)`
  );
  assert.notEqual(withinCity, betweenNearbyCities, "no two distance orders of magnitude may collapse to the same value");
  assert.notEqual(betweenNearbyCities, crossContinent);

  // The specific "3 hours vs 40 hours must not be equal" acceptance case:
  // cross-continent must be dramatically larger, not just marginally so
  // (a genuine saturation bug would show up as "barely bigger" or
  // identical, not proportbig to real distance).
  assert.ok(
    crossContinent > withinCity * 20,
    `a ~8,000km hop (${crossContinent}min) must be dramatically larger than a ~2km one (${withinCity}min), never saturated toward it`
  );
});

test("fillDerivedDayFields: a synthetic stay-transition item (canonicalPlaceId starting with 'transition:') keeps its own mode-aware travelMinutes, never recomputed from the generic haversine estimate", () => {
  const payload = buildPayload();
  const day = buildDay({
    items: [
      buildItem({ name: "Point A (anchor)", lat: 10, lon: 10 }),
      buildItem({
        name: "Flight: City A → City B",
        category: "transportation",
        canonicalPlaceId: "transition:City A->City B",
        // Real coordinates far enough away that the generic haversine
        // estimate would produce a very different number than this
        // already-correct, mode-aware value (e.g. a real flight duration
        // that a flat car/walking speed table would badly misjudge).
        lat: -60,
        lon: 130,
        travelMinutes: 480,
      }),
    ],
  });

  const filled = fillDerivedDayFields(day, payload);
  const transitionItem = filled.items.find((item) => item.canonicalPlaceId === "transition:City A->City B")!;
  assert.equal(transitionItem.travelMinutes, 480, "a marked transition item's own real, mode-aware estimate must never be second-guessed");
});

test("fillDerivedDayFields: falls back to the Gemini-stated travelMinutes only when real coordinates are genuinely unavailable on either end", () => {
  const payload = buildPayload();
  const day = buildDay({
    items: [
      buildItem({ name: "Point A (anchor)", lat: 10, lon: 10 }),
      // buildItem's own defaulting uses `??`, which treats an explicit
      // `lat: null` override as "not provided" and falls through to its
      // Tokyo default — spreading lat/lon over the built item afterward
      // is the only way to actually get a coordinateless item here.
      { ...buildItem({ name: "Coordinateless Stop", travelMinutes: 33 }), lat: null, lon: null },
    ],
  });

  const filled = fillDerivedDayFields(day, payload);
  assert.equal(
    filled.items.find((item) => item.name === "Coordinateless Stop")?.travelMinutes,
    33,
    "with no real coordinates to compute from, the last honest thing left is the stated value — never silently zeroed"
  );
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

// Spec "תיקון גנרי, לא תיקון תשיעי" — repairOpeningHoursViolations' own
// replacement call used to hand pickReplacementRecommendation a day view
// that still included the violating item being replaced, so a candidate
// close only to IT (never to the day's real anchor) could pass.
test("repairOpeningHoursViolations never selects a replacement close only to the violating item itself, not to the day's real anchor", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "fake-near-violator",
        name: "Fake Nearby To Violator Only",
        category: "attraction",
        location: "Nowhere Real",
        // Close to the violating item (11.26, 10) — far from the real base (10, 10).
        lat: 11.261,
        lon: 10.001,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    transportation: "רכב",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 10, lon: 10, transportation: "רכב" }),
      // ~140km real distance, explicit "רכב" — the same real-walking-speed
      // scheduling-overflow trap as the other new tests this round.
      buildItem({
        name: "Late Violating Spot",
        category: "attraction",
        slot: "afternoon",
        openingHours: "08:00-16:00",
        plannedStartTime: "19:52",
        lat: 11.26,
        lon: 10,
        transportation: "רכב",
      }),
    ],
  });

  const [repaired] = repairOpeningHoursViolations([day], payload, profile);

  assert.equal(repaired.items.some((item) => item.name === "Late Violating Spot"), false, "the violating item must not survive under its original name");
  assert.ok(
    !repaired.items.some((item) => item.name === "Fake Nearby To Violator Only"),
    "a candidate close only to the violating item being replaced must never be selected"
  );
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
  const usageState = createItineraryUsageState();

  const filled = fillUnderfilledDay(emptyDay, payload, profile, usageState);

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
  const usageState = createItineraryUsageState();

  const transferDay = buildDay({ dayNumber: 2, title: "Transfer to Kyoto", transportation: "shinkansen", items: [] });
  assert.deepEqual(fillUnderfilledDay(transferDay, payload, profile, usageState).items, []);

  const dayTrip = buildDay({ dayNumber: 2, title: "Day trip to Nikko", items: [] });
  assert.deepEqual(fillUnderfilledDay(dayTrip, payload, profile, usageState).items, []);
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

// Section Q — the exact real browser bug: "day base = Mitzpe Ramon,
// transportation item = Tel Aviv → Jerusalem" surviving a stay-structure
// change. A marked item from an earlier fromBase/toBase pair must be
// recognized as stale and rebuilt from the CURRENT transition.
test("enforceStayTransitions removes a stale marked transition item from a PREVIOUS fromBase/toBase pair and rebuilds the correct one", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const staleTransitionItem = buildItem({
    name: "Train: City X → City Y",
    category: "transportation",
    canonicalPlaceId: "transition:City X->City Y", // stale — the structure changed since this was generated
    travelMinutes: 200,
  });
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A" }),
    buildDay({ dayNumber: 2, cityRegion: "City B", items: [staleTransitionItem] }),
  ];

  const { days: repaired } = enforceStayTransitions(days, [buildTransition({ fromBase: "City A", toBase: "City B" })], payload, profile);

  assert.ok(
    !repaired[1].items.some((item) => item.canonicalPlaceId === "transition:City X->City Y"),
    "the stale marked transition (a different fromBase/toBase pair) must be removed"
  );
  assert.ok(
    repaired[1].items.some((item) => item.canonicalPlaceId === "transition:City A->City B"),
    "the correct, current transition must be present after the rebuild"
  );
});

test("enforceStayTransitions never deletes a Gemini-authored (unmarked) transportation item — only its OWN previously-marked stale items", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const geminiOwnTransport = buildItem({
    name: "רכבת מקומית",
    category: "transportation",
    canonicalPlaceId: "", // Gemini's own content never carries this marker
    travelMinutes: 60,
    // Real coordinates matching City B's own transition anchor (spec "כל
    // ערך אמיתי מנצח"), not buildItem's Tokyo default — otherwise, once
    // travelMinutes is genuinely recomputed from real coordinates instead
    // of trusted verbatim, "Tokyo" vs. City B's real (42.6, 44.6) anchor
    // reads as a fabricated 8,000km jump and overloads the day for a
    // reason that has nothing to do with what this test is actually
    // checking (deletion behavior, not distance).
    lat: 42.6,
    lon: 44.6,
  });
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A" }),
    buildDay({ dayNumber: 2, cityRegion: "City B", items: [geminiOwnTransport] }),
  ];

  const { days: repaired } = enforceStayTransitions(days, [buildTransition({ fromBase: "City A", toBase: "City B" })], payload, profile);

  assert.ok(
    repaired[1].items.some((item) => item.name === "רכבת מקומית"),
    "an unmarked (Gemini-authored) transport item must never be deleted by this pass"
  );
});

test("resolveCanonicalPlaceId preserves an existing transition marker instead of overwriting it from coordinates", () => {
  const marked = buildItem({
    name: "Train: City A → City B",
    canonicalPlaceId: "transition:City A->City B",
    lat: 32.5,
    lon: 34.9,
  });
  assert.equal(resolveCanonicalPlaceId(marked), "transition:City A->City B");
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

// Part A/D/E: generation-time stay-area weighting now comes from REAL
// geographic clustering, not a free-text location match — a candidate
// whose location text says "City A" but whose real coordinates sit far
// away in a different real cluster must not inflate City A's weight.
test("computeAreaWeightsFromClusters groups candidates by real coordinates, not by a possibly-wrong location label", () => {
  const cityACandidates = Array.from({ length: 3 }, () =>
    buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 })
  );
  // Mislabeled: text says "City A" but the real coordinates are a
  // different, distant real cluster entirely (the exact bug class this
  // fixes — a candidate's location text is not authoritative, its
  // coordinates are).
  const mislabeledCandidate = buildRecommendation({ location: "City A", lat: 5.0, lon: 5.0, estimatedDurationMinutes: 90 });

  const profile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const weights = computeAreaWeightsFromClusters([...cityACandidates, mislabeledCandidate], profile);

  // City A's own weight must reflect only its own real, nearby candidates
  // (3 x 90 = 270) — never inflated by the mislabeled far candidate just
  // because its text also says "City A".
  assert.equal(weights.get("City A"), 270);
});

test("computeAreaWeightsFromClusters weighs an area by real required visit time, not raw candidate count", () => {
  const manyShortVisits = Array.from({ length: 5 }, () =>
    buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 20 })
  );
  const fewLongVisits = Array.from({ length: 2 }, () =>
    buildRecommendation({ location: "City B", lat: 5.0, lon: 5.0, estimatedDurationMinutes: 240 })
  );
  const profile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const weights = computeAreaWeightsFromClusters([...manyShortVisits, ...fewLongVisits], profile);

  assert.ok((weights.get("City B") ?? 0) > (weights.get("City A") ?? 0), "2 long visits should outweigh 5 short ones by real time, not by count");
});

// ==================================================
// LIVE PRODUCTION WIRING — these call buildDeterministicTripFrame itself
// (the real function generation calls), never a standalone pure helper in
// isolation, to prove decideClusterRole/short-stay-viability/night-
// allocation/backtracking are actually load-bearing in production, not
// dead utilities. Invented geography (City A/B/C style) only.
// ==================================================

test("live wiring: a weak cluster near a strong one does not become its own overnight phase", () => {
  const strong = Array.from({ length: 6 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 }));
  const weakNearby = Array.from({ length: 2 }, () => buildRecommendation({ location: "City B", lat: 1.05, lon: 1.05, estimatedDurationMinutes: 60 }));
  const payload = buildPayload({ recommendations: [...strong, ...weakNearby], preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });

  const frame = buildDeterministicTripFrame(payload, 10);
  assert.ok(!frame.phases.some((phase) => phase.areaLabel === "City B"), "the weak nearby cluster must not become its own hotel base");
});

test("live wiring: a strong cluster, even a remote one, becomes its own overnight phase", () => {
  const strongA = Array.from({ length: 6 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 }));
  const strongRemoteC = Array.from({ length: 5 }, () => buildRecommendation({ location: "City C", lat: 10.0, lon: 10.0, estimatedDurationMinutes: 100 }));
  const payload = buildPayload({ recommendations: [...strongA, ...strongRemoteC], preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });

  const frame = buildDeterministicTripFrame(payload, 10);
  const areas = frame.phases.map((phase) => phase.areaLabel);
  assert.ok(areas.includes("City A") && areas.includes("City C"), `expected both strong clusters as bases, got: ${areas.join(", ")}`);
});

test("live wiring: a real but weak cluster far from everything becomes an explicit day trip, never a competing hotel base", () => {
  const strong = Array.from({ length: 6 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 }));
  // ~128km from City A — far enough to exceed this pool's own
  // locality radius (so it stays a separate cluster, not merged) but
  // close enough to clear the real round-trip day-trip feasibility gate
  // (evaluateDayTripFeasibility, route-optimization.ts) at "balanced" pace.
  // The original fixture (~785km) predates that gate and would now be
  // correctly rejected as an infeasible day trip — this is the fix for
  // that, not a workaround: the intent of this test ("a real but weak
  // cluster becomes a day trip, not a competing base") requires the day
  // trip to actually be a plausible one.
  const weakFar = Array.from({ length: 2 }, () => buildRecommendation({ location: "City D", lat: 2.15, lon: 1.0, estimatedDurationMinutes: 60 }));
  const payload = buildPayload({ recommendations: [...strong, ...weakFar], preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });

  const frame = buildDeterministicTripFrame(payload, 10);
  assert.ok(!frame.phases.some((phase) => phase.areaLabel === "City D"), "must never become its own overnight base");
  assert.ok(frame.dayTripHints?.some((hint) => hint.areaLabel === "City D"), "must be recorded as an explicit day trip instead");
});

// Real bug this closes: decideClusterRole only ever asked "is this cluster
// far enough / weak enough to be a day trip" — never "is the round trip
// from its actual base something a traveler could plausibly do in a day."
// A cluster ~785km from its nearest base earns "day_trip" role on content
// alone but is genuinely infeasible (1168 real round-trip minutes against a
// 600-minute "balanced"-pace budget) — it must never surface as a day-trip
// hint at all, not even a low-priority one.
test("live wiring: a weak cluster that is real-world too far for a day trip is never surfaced as a day-trip hint", () => {
  const strong = Array.from({ length: 6 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 }));
  const tooFar = Array.from({ length: 2 }, () => buildRecommendation({ location: "City Far", lat: 6.0, lon: 6.0, estimatedDurationMinutes: 60 }));
  const payload = buildPayload({ recommendations: [...strong, ...tooFar], preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });

  const frame = buildDeterministicTripFrame(payload, 10);
  assert.ok(!frame.phases.some((phase) => phase.areaLabel === "City Far"), "must never become its own overnight base either");
  assert.ok(
    !frame.dayTripHints?.some((hint) => hint.areaLabel === "City Far"),
    "a genuinely infeasible round trip must never surface as a day-trip hint"
  );
});

test("live wiring: allocateNightsForClusters' proportional-by-content-time rule is what actually sizes the generated phases", () => {
  const heavy = Array.from({ length: 8 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 90 }));
  const light = Array.from({ length: 3 }, () => buildRecommendation({ location: "City B", lat: 9.0, lon: 9.0, estimatedDurationMinutes: 90 }));
  const payload = buildPayload({ recommendations: [...heavy, ...light], preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });

  const frame = buildDeterministicTripFrame(payload, 10);
  const cityA = frame.phases.find((phase) => phase.areaLabel === "City A");
  const cityB = frame.phases.find((phase) => phase.areaLabel === "City B");
  assert.ok(cityA && cityB, "both clusters have enough real content to be their own base");
  assert.ok(cityA!.nights > cityB!.nights, "the cluster with far more real content must receive more nights");
  assert.equal(frame.phases.reduce((sum, phase) => sum + phase.nights, 0), 10);
});

test("live wiring: a cluster with enough content to qualify as overnight is still merged away when its real transfer cost is prohibitive", () => {
  const cityA = Array.from({ length: 5 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 150 }));
  // Just at the overnight-content threshold (240min) on its own, and
  // positioned BETWEEN A and C so it survives both cluster-role selection
  // (>=12% weight share) and the backtracking reorder (which places it in
  // the interior) — but its real transfer time from both real, extremely
  // distant neighbors (not mere cluster-distance geometry) makes it not
  // worth the hotel change.
  const cityM = Array.from({ length: 3 }, () => buildRecommendation({ location: "City M", lat: 45.0, lon: 45.0, estimatedDurationMinutes: 80 }));
  const cityC = Array.from({ length: 5 }, () => buildRecommendation({ location: "City C", lat: 89.0, lon: 89.0, estimatedDurationMinutes: 150 }));
  const payload = buildPayload({
    recommendations: [...cityA, ...cityM, ...cityC],
    preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" },
  });

  const frame = buildDeterministicTripFrame(payload, 10);
  assert.ok(!frame.phases.some((phase) => phase.areaLabel === "City M"), "a prohibitively expensive 1-night stay must be merged away, even though its own content cleared the overnight-content bar");
});

test("live wiring: a weight-only route order that would backtrack is reordered into a coherent A→B→C sequence", () => {
  // Weight order alone would visit heaviest-first: City C (heaviest, one
  // end), then City A (lighter, the OTHER end), then City M (lightest,
  // the real geographic midpoint) — a real backtrack (passing back near
  // the midpoint after already having gone past it). The coherent order
  // is City C -> City M -> City A.
  const cityA = Array.from({ length: 7 }, () => buildRecommendation({ location: "City A", lat: 1.0, lon: 1.0, estimatedDurationMinutes: 100 }));
  const cityM = Array.from({ length: 4 }, () => buildRecommendation({ location: "City M", lat: 25.0, lon: 25.0, estimatedDurationMinutes: 100 }));
  const cityC = Array.from({ length: 9 }, () => buildRecommendation({ location: "City C", lat: 50.0, lon: 50.0, estimatedDurationMinutes: 100 }));
  const payload = buildPayload({
    recommendations: [...cityA, ...cityM, ...cityC],
    preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" },
  });

  const frame = buildDeterministicTripFrame(payload, 15);
  assert.deepEqual(frame.phases.map((phase) => phase.areaLabel), ["City C", "City M", "City A"]);
});

test("live wiring: generation completes and stays bounded for a genuinely weak, scattered candidate pool", () => {
  const scattered = Array.from({ length: 6 }, (_, index) =>
    buildRecommendation({ location: `Spot ${index}`, lat: index * 5, lon: index * 5, estimatedDurationMinutes: 30 })
  );
  const payload = buildPayload({ recommendations: scattered, preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" } });
  const frame = buildDeterministicTripFrame(payload, 10);
  assert.equal(frame.phases.reduce((sum, phase) => sum + phase.nights, 0), 10);
  assert.ok(frame.phases.length >= 1);
});

// ==================================================
// PART A — "MAKE TRAVEL METRICS ACTUALLY ACTIVE": repairNormalDayTravelOutliers
// and its wiring into collectPlanDiagnostics/passesValidation. Invented
// geography only.
// ==================================================

const COMPACT_MOBILITY_PROFILE = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

test("A6.2/A6.4: repairNormalDayTravelOutliers replaces the offending item with a nearby real candidate when one exists, never a far red-herring also in the pool", () => {
  const nearbyCandidate = buildRecommendation({ id: "near-1", name: "Nearby Real Place", category: "attraction", location: "City A", lat: 1.001, lon: 1.001, estimatedDurationMinutes: 60 });
  // A second, genuinely real candidate that is far from EVERYTHING in the
  // day (not merely close to the outlier being replaced, which the
  // dedicated "close only to the outlier" test already covers) — closes
  // the mutation-audit gap where this test's own candidate pool held only
  // one option and so never actually proved a far candidate gets rejected.
  // ~47km (well past COMPACT's 25km radius) with explicit "רכב" — a real
  // intercontinental distance at buildItem's own default walking speed
  // would overflow the day's schedule regardless of geography, masking
  // whether the geographic check is what's actually rejecting it.
  const farRedHerring = buildRecommendation({ id: "far-1", name: "Far Red Herring", category: "attraction", location: "Nowhere Real", lat: 1.3, lon: 1.3, estimatedDurationMinutes: 60 });
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10, transportation: "רכב" }),
      buildItem({ name: "Distant Outlier", category: "attraction", lat: 3.0, lon: 3.0, travelMinutes: 200, transportation: "רכב" }),
    ],
  });
  const payload = buildPayload({ recommendations: [nearbyCandidate, farRedHerring] });
  const result = repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));

  assert.equal(result.outliers.length, 1);
  assert.equal(result.outliers[0].repaired, true);
  assert.ok(result.days[0].items.some((item) => item.name === "Nearby Real Place"), "the distant item should be replaced by the real nearby candidate");
  assert.ok(!result.days[0].items.some((item) => item.name === "Distant Outlier"));
  assert.ok(!result.days[0].items.some((item) => item.name === "Far Red Herring"), "a genuinely far candidate in the same pool must never win over the nearby one, or be picked at all");
});

// A6.4: underfilled day prefers free time over a distant POI when no real nearby candidate exists.
test("A6.4: repairNormalDayTravelOutliers falls back to free exploration (never a distant POI) when the only real candidate is genuinely far away", () => {
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10, transportation: "רכב" }),
      buildItem({ name: "Distant Outlier", category: "attraction", lat: 3.0, lon: 3.0, travelMinutes: 200, recommendationId: null, transportation: "רכב" }),
    ],
  });
  // The old version of this test used an EMPTY candidate pool, which never
  // actually proved a far candidate gets rejected — only that "nothing to
  // pick from" falls back correctly. A genuinely far, otherwise-eligible
  // candidate (not merely close to the outlier itself, and at a moderate
  // ~47km rather than intercontinental — see the sibling test's comment on
  // why) closes that gap.
  const farRedHerring = buildRecommendation({ id: "far-2", name: "Far Red Herring", category: "attraction", location: "Nowhere Real", lat: 1.3, lon: 1.3, estimatedDurationMinutes: 60 });
  const payload = buildPayload({ recommendations: [farRedHerring] });
  const result = repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));

  assert.equal(result.outliers[0].repaired, true);
  assert.ok(!result.days[0].items.some((item) => item.name === "Far Red Herring"), "a genuinely far real candidate must be rejected, never selected just because it's the only one available");
  const replaced = result.days[0].items.find((item) => item.name !== "Base Anchor");
  assert.ok(replaced && replaced.lat == null && replaced.lon == null, "must fall back to a coordinate-less free-exploration item, never leave the distant POI in place");
});

// Spec "gav nv abrtv kl vfh yuc" (Phase C, part א) — a candidate must pass
// the SAME distance-from-the-day's-real-anchors test the outlier itself
// failed. The real bug: pickReplacementRecommendation validated a
// candidate against a day view that STILL included the outlier, so a
// candidate merely close to the (already known wrong) outlier — never
// close to the day's actual base — slipped through as "compatible". Real
// symptom: Thor's Well (Oregon)/Mendenhall Ice Caves (Alaska) chosen as
// replacements for days nowhere near them, because the outlier itself
// counted as a valid anchor to be near. Tested directly against
// pickReplacementRecommendation (not the full repairNormalDayTravelOutliers
// pipeline) to isolate the exact mechanism from the scheduler's own
// unrelated overflow handling, which can independently reject a
// far-enough candidate for a different reason (its own huge recomputed
// travelMinutes not fitting the day's time window) and would otherwise
// mask whether THIS specific fix is what's doing the rejecting.
// Spec "תיקון גנרי, לא תיקון תשיעי" — REWRITTEN (reported separately, per
// instruction): the previous version of this test documented the OLD bug
// by proving a caller that forgot to exclude the target item got the
// wrong (buggy) result. That's no longer a real scenario to document —
// pickReplacementRecommendation now excludes args.item from its own
// internal anchor/scoring context itself, so there is no longer a
// "forgot to exclude" caller mistake possible at all. This version proves
// exactly that: the SAME buggy-shaped call (day still includes the
// target item) now gets the CORRECT result regardless, matching a call
// that already excluded it manually.
test("pickReplacementRecommendation: excludes the target item (args.item) from its own anchor/scoring context internally — a caller is never responsible for pre-filtering it out", () => {
  const fakeNearbyToOutlierOnly = buildRecommendation({
    id: "fake-near-1",
    name: "Fake Nearby To Outlier Only",
    category: "attraction",
    location: "Nowhere Real",
    // Close to the outlier (3.0, 3.0) — far from Base Anchor (1.0, 1.0).
    lat: 3.001,
    lon: 3.001,
  });
  const outlierItem = buildItem({ name: "Distant Outlier", category: "attraction", lat: 3.0, lon: 3.0, travelMinutes: 200, recommendationId: null });
  const baseAnchor = buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10 });
  const dayStillIncludingTarget = buildDay({ dayNumber: 1, cityRegion: "City A", items: [baseAnchor, outlierItem] });
  const dayAlreadyExcludingTarget = { ...dayStillIncludingTarget, items: [baseAnchor] };
  const payload = buildPayload({ recommendations: [fakeNearbyToOutlierOnly] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const resultWhenCallerForgotToExclude = pickReplacementRecommendation({
    payload,
    day: dayStillIncludingTarget,
    item: outlierItem,
    profile,
    usageState: createItineraryUsageState(),
    maxDistanceKm: COMPACT_MOBILITY_PROFILE.localityRadiusKm,
  });
  assert.equal(
    resultWhenCallerForgotToExclude,
    null,
    "the function's own internal exclusion must reject a candidate close only to the target item, even when the caller passed a day that still includes it"
  );

  const resultWhenCallerAlreadyExcluded = pickReplacementRecommendation({
    payload,
    day: dayAlreadyExcludingTarget,
    item: outlierItem,
    profile,
    usageState: createItineraryUsageState(),
    maxDistanceKm: COMPACT_MOBILITY_PROFILE.localityRadiusKm,
  });
  assert.equal(
    resultWhenCallerAlreadyExcluded,
    null,
    "a caller that already excludes the target item gets the identical (correct) result — the internal exclusion is a no-op there, never a behavior change"
  );
});

// The same fix exercised end-to-end through repairNormalDayTravelOutliers
// itself — distances kept moderate (unlike the unit test above) so the
// candidate's own recomputed travelMinutes stays well inside the day's
// schedulable window, and geographic compatibility alone is what decides
// the outcome, not an unrelated scheduling-overflow rejection.
test("repairNormalDayTravelOutliers: a replacement candidate close only to the OUTLIER itself (never to the day's real anchor) must be rejected, not chosen", () => {
  const fakeNearbyToOutlierOnly = buildRecommendation({
    id: "fake-near-2",
    name: "Fake Nearby To Outlier Only",
    category: "attraction",
    location: "Nowhere Real",
    // ~1km from the outlier (1.30, 1.31) — within COMPACT's 25km radius of
    // it, but ~47km from Base Anchor (1.0, 1.0) — outside that radius, and
    // a modest enough real distance (~50min at the generic estimate) that
    // it would still fit the day's schedule if accepted.
    lat: 1.301,
    lon: 1.311,
  });
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      // transportation explicitly "רכב" (car, 35km/h) — buildItem's own
      // default ("הליכה"/walking, 4km/h) would make a real ~47km distance
      // take over 11 hours even at the fixed, correct estimate, which
      // would overflow the day's schedule independent of geographic
      // compatibility and defeat the point of this test.
      buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10, transportation: "רכב" }),
      buildItem({ name: "Distant Outlier", category: "attraction", lat: 1.3, lon: 1.3, travelMinutes: 200, recommendationId: null, transportation: "רכב" }),
    ],
  });
  const payload = buildPayload({ recommendations: [fakeNearbyToOutlierOnly] });
  const result = repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));

  assert.ok(
    !result.days[0].items.some((item) => item.name === "Fake Nearby To Outlier Only"),
    "a candidate close only to the outlier being replaced (not to the day's real anchor) must never be selected"
  );
  const replaced = result.days[0].items.find((item) => item.name !== "Base Anchor");
  assert.ok(
    replaced && replaced.lat == null && replaced.lon == null,
    "with no candidate genuinely close to the day's real anchor, must fall back to free exploration — never 'closest among the far ones'"
  );
});

// Spec "נדנוד אינסופי" (Phase C, part ב) — a place already rejected from a
// given day earlier in the same repairPlan run must never come back as
// someone else's replacement on a later attempt. Real symptom: one real
// day cycled "free block -> Mystery Spot -> free block -> Mystery Spot"
// across 4 attempts, because usedPlaceKeys was rebuilt fresh every
// attempt with no memory of what had already been tried and rejected.
test("repairNormalDayTravelOutliers: a place already removed from this day earlier in the run is never re-selected for a later outlier on the SAME day", () => {
  const onlyRealCandidate = buildRecommendation({
    id: "near-1",
    name: "Nearby Real Place",
    category: "attraction",
    location: "City A",
    lat: 1.001,
    lon: 1.001,
    estimatedDurationMinutes: 60,
  });
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10 }),
      buildItem({ name: "Distant Outlier", category: "attraction", lat: 3.0, lon: 3.0, travelMinutes: 200, recommendationId: null }),
    ],
  });
  const payload = buildPayload({ recommendations: [onlyRealCandidate] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  // Pre-seeded as if an earlier attempt in the SAME repairPlan run already
  // tried "Nearby Real Place" on day 1 and it was removed again — the
  // memory a later attempt must respect.
  const removedItemKeysByDay = new Map<number, Set<string>>([[1, new Set([buildItemKey({ recommendationId: "near-1", name: "", lat: null, lon: null, location: "" })])]]);

  const result = repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, profile, removedItemKeysByDay);

  assert.ok(
    !result.days[0].items.some((item) => item.name === "Nearby Real Place"),
    "a place already removed from this exact day must never be re-offered as a replacement, even though it would otherwise be geographically valid"
  );
  const replaced = result.days[0].items.find((item) => item.name !== "Base Anchor");
  assert.ok(replaced && replaced.lat == null && replaced.lon == null, "with the only real candidate blacklisted for this day, must fall back to free exploration");
});

test("repairNormalDayTravelOutliers: records a removed item's key in removedItemKeysByDay, keyed by day number", () => {
  const day = buildDay({
    dayNumber: 7,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 1.0, lon: 1.0, travelMinutes: 10 }),
      buildItem({ name: "Distant Outlier", category: "attraction", lat: 3.0, lon: 3.0, travelMinutes: 200, recommendationId: "outlier-rec" }),
    ],
  });
  const payload = buildPayload({ recommendations: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const removedItemKeysByDay = new Map<number, Set<string>>();

  repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, profile, removedItemKeysByDay);

  assert.ok(removedItemKeysByDay.get(7)?.has("id:outlier-rec"), "the removed outlier's own key must be recorded under its real day number");
  assert.equal(removedItemKeysByDay.has(1), false, "must never bleed into an unrelated day number");
});

// A2: a genuine day trip's long travel is expected and must never be touched by this repair.
test("A2: repairNormalDayTravelOutliers never touches a genuine day-trip day's own long travel", () => {
  const dayTripDay = buildDay({
    dayNumber: 2,
    title: "Day trip to the mountains",
    notes: "יום טיול",
    cityRegion: "City A",
    items: [buildItem({ name: "Mountain Excursion", lat: 3.0, lon: 3.0, travelMinutes: 200 })],
  });
  const payload = buildPayload({ recommendations: [] });
  const result = repairNormalDayTravelOutliers([dayTripDay], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));

  assert.equal(result.outliers.length, 0);
  assert.ok(result.days[0].items.some((item) => item.name === "Mountain Excursion"), "a real day trip's own content must survive untouched");
});

// A3: a transfer day's long one-way travel is expected and must never be touched.
test("A3: repairNormalDayTravelOutliers never touches a genuine transfer day's own long travel", () => {
  const transferDay = buildDay({
    dayNumber: 3,
    transportation: "נסיעה בין בסיסים",
    notes: "יום מעבר בין בסיסים",
    cityRegion: "City B",
    items: [buildItem({ name: "Intercity Transfer", category: "transportation", lat: 3.0, lon: 3.0, travelMinutes: 300 })],
  });
  const payload = buildPayload({ recommendations: [] });
  const result = repairNormalDayTravelOutliers([transferDay], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));

  assert.equal(result.outliers.length, 0);
  assert.ok(result.days[0].items.some((item) => item.name === "Intercity Transfer"));
});

// A6.7: metrics are genuinely recomputed after repair, not stale before-values.
test("A6.7: travel metrics recomputed after repairNormalDayTravelOutliers show a real reduction", () => {
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", lat: 1.0, lon: 1.0, travelMinutes: 10 }),
      buildItem({ name: "Distant Outlier", lat: 3.0, lon: 3.0, travelMinutes: 200, recommendationId: null }),
    ],
  });
  const payload = buildPayload({ recommendations: [] });
  const before = day.items.reduce((max, item) => Math.max(max, item.travelMinutes ?? 0), 0);
  const result = repairNormalDayTravelOutliers([day], COMPACT_MOBILITY_PROFILE, payload, buildTripPreferenceProfile(basePreferences, "Country X", 1));
  const after = result.days[0].items.reduce((max, item) => Math.max(max, item.travelMinutes ?? 0), 0);
  assert.ok(after < before, `expected repaired max segment (${after}) below the original (${before})`);
});

// A6.1: collectPlanDiagnostics only exposes normalDayTravelOutliers when a real
// mobility profile is supplied — proving the diagnostic genuinely depends
// on the wiring, not a hardcoded value.
test("A6.1: collectPlanDiagnostics flags a real normal-day travel outlier only when a real mobility profile is supplied", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Base Anchor", lat: 1.0, lon: 1.0, travelMinutes: 10 }),
      buildItem({ name: "Distant Outlier", lat: 3.0, lon: 3.0, travelMinutes: 200, locked: true }), // locked: survives repair, still flagged
    ],
  });
  const plan = { title: "t", summary: "s", totalEstimatedCost: 100, estimatedTransportCost: 0, averageDailyCost: 100, costPerTraveler: 100, categoryBreakdown: {}, days: [day] };

  const withoutProfile = collectPlanDiagnostics(plan, profile, null, null, null, [], [], null);
  assert.equal(withoutProfile.normalDayTravelOutliers ?? 0, 0, "no profile supplied -> never flagged, matching every pre-existing caller");

  const withProfile = collectPlanDiagnostics(plan, profile, null, null, null, [], [], COMPACT_MOBILITY_PROFILE);
  assert.equal(withProfile.normalDayTravelOutliers, 1);
});

// A6.8: plan acceptance (passesValidation) genuinely uses normalDayTravelOutliers
// in isolation — an otherwise-clean diagnostics object is accepted with 0
// and rejected with a real outlier count, matching every other gate's
// existing test pattern (cleanDiagnostics).
test("A6.8: passesValidation rejects an otherwise-clean plan that still has a real normal-day travel outlier", () => {
  assert.equal(passesValidation(cleanDiagnostics({ normalDayTravelOutliers: 1 })), false);
  assert.equal(passesValidation(cleanDiagnostics({ normalDayTravelOutliers: 0 })), true);
  assert.equal(passesValidation(cleanDiagnostics()), true, "absent normalDayTravelOutliers must never regress a plan that was clean before this field existed");
});

// Part N/O: a fallback meal item — no real restaurant candidate exists —
// must read as a recommended TIME WINDOW, never an invented business.
test("18/19/20/21. buildFallbackMealPlaceholder produces a meal opportunity, never a fake restaurant card", () => {
  const day = buildDay({ dayNumber: 1, cityRegion: "City A" });
  const payload = buildPayload();
  const placeholder = buildFallbackMealPlaceholder(day, "lunch", payload);

  assert.ok(isMealOpportunityMarker(placeholder), "must be recognized as a meal opportunity, not a real place");
  assert.equal(placeholder.lat, null, "20. no coordinates");
  assert.equal(placeholder.lon, null, "20. no coordinates");
  assert.equal(placeholder.recommendationId, null);
  assert.equal(placeholder.approximatePrice, null, "21. no fabricated price");
  assert.ok(placeholder.name.startsWith("🍽"), "18. must not read as an invented business name");
});

test("22. a meal opportunity produced by buildFreeExplorationReplacement's food branch never fabricates a price", () => {
  const day = buildDay({ dayNumber: 1, cityRegion: "City A" });
  const foodItem = buildItem({ category: "restaurant", slot: "dinner" });
  const replacement = buildFreeExplorationReplacement(foodItem, day);

  assert.ok(isMealOpportunityMarker(replacement));
  assert.equal(replacement.approximatePrice, null);
  assert.equal(replacement.priceOriginalAmount, null);
  assert.ok(replacement.name.startsWith("🍽"));
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

// Section (browser QA): computeDestinationMobilityProfile — a real,
// density-derived locality radius, never one fixed worldwide km value.
// Invented "Country X"/"Country Y" coordinates only.
test("computeDestinationMobilityProfile classifies a dense candidate pool as compact with a tight locality radius", () => {
  // City A's real candidates, all within a couple of km of each other.
  const denseCandidates = Array.from({ length: 6 }, (_, index) => ({
    lat: 32.08 + index * 0.01,
    lon: 34.78 + index * 0.01,
  }));
  const profile = computeDestinationMobilityProfile(denseCandidates);
  assert.equal(profile.tier, "compact");
  assert.ok(profile.localityRadiusKm < 60);
});

test("computeDestinationMobilityProfile classifies a sparse candidate pool as large_sparse with a looser locality radius", () => {
  // Real candidates hundreds of km apart from each other.
  const sparseCandidates = [
    { lat: 10, lon: 10 },
    { lat: 12, lon: 12 },
    { lat: 30, lon: 30 },
    { lat: 32, lon: 33 },
    { lat: -20, lon: 100 },
  ];
  const profile = computeDestinationMobilityProfile(sparseCandidates);
  assert.equal(profile.tier, "large_sparse");
  assert.ok(profile.localityRadiusKm > 60);
});

test("computeDestinationMobilityProfile: a compact destination's radius is strictly tighter than a large sparse one's", () => {
  const compact = computeDestinationMobilityProfile(
    Array.from({ length: 5 }, (_, i) => ({ lat: 32 + i * 0.01, lon: 34 + i * 0.01 }))
  );
  const sparse = computeDestinationMobilityProfile([
    { lat: 10, lon: 10 },
    { lat: 15, lon: 20 },
    { lat: 40, lon: 60 },
    { lat: -10, lon: -30 },
  ]);
  assert.ok(compact.localityRadiusKm < sparse.localityRadiusKm);
});

test("computeDestinationMobilityProfile falls back to the pre-existing default when there isn't enough real geography to judge", () => {
  const profile = computeDestinationMobilityProfile([{ lat: null, lon: null }, { lat: 1, lon: 1 }]);
  assert.equal(profile.tier, "medium");
});

// Section (browser QA): enforceNormalDayLocality — the real bug from the
// browser report (a "Jerusalem" day containing Makhtesh Ramon activities,
// a "Tel Aviv" day containing Haifa content) reproduced with invented
// City A/B/C geography, never real place names.
const CITY_A_ANCHOR = { lat: 32.08, lon: 34.78 };
const CITY_B_ANCHOR = { lat: 31.77, lon: 35.22 }; // ~75km from City A
const CITY_C_ANCHOR = { lat: 30.6, lon: 34.8 }; // ~140km from City A — a distant future stay

// buildItem's own lat/lon defaulting uses `??`, which substitutes its
// default coordinate for an explicit `null` too — so a genuinely
// coordinate-less fixture (the exact real-world shape of a Gemini item
// with no lat/lon) must null them out AFTER construction, not through the
// helper's own overrides.
function buildCoordinatelessItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return { ...buildItem(overrides), lat: null, lon: null, recommendationId: overrides.recommendationId ?? null };
}

test("enforceNormalDayLocality repairs a normal day's item that is far outside its own stay's locality radius", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    title: "A normal City A day",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildItem({ name: "Far Crater", slot: "afternoon", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((violation) => violation.itemName === "Far Crater" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "Far Crater"));
});

test("enforceNormalDayLocality rejects an activity that genuinely belongs to a future stay's cluster, even if it's technically within this stay's own radius", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 90, normalDayTravelBudgetMinutes: 100 };
  // An item much closer to City B (the NEXT stay) than to City A (today's stay).
  const stolenItem = buildItem({ name: "City B Landmark", lat: CITY_B_ANCHOR.lat, lon: CITY_B_ANCHOR.lon });
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }), stolenItem],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((violation) => violation.reason === "belongs_to_another_stay"));
  assert.ok(!days[0].items.some((item) => item.name === "City B Landmark"));
});

// Transfer-day detour feasibility — real bug this closes: the old transfer
// exemption only rejected an item that POSITIVELY matched some OTHER
// modeled stay; an item simply far from everything (not near origin, not
// near destination, not a real match to any known stay, genuinely NOT on
// the way) sailed through with zero validation. City A (day 1) -> City B
// (day 2, the transfer day), ~444.8km apart (~296.5min direct transfer,
// leaving ~303.5min of real detour slack at "balanced" pace/600min daily
// capacity) — verified with the real haversineKm/selectTransportMode/
// estimateMinutesForMode primitives before writing these fixtures.
const TRANSFER_CITY_A_ANCHOR = { lat: 0, lon: 0 };
const TRANSFER_CITY_B_ANCHOR = { lat: 0, lon: 4.0 };
const TRANSFER_TRIP_FRAME = buildTestFrame([
  { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
  { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
]);
const TRANSFER_AREA_ANCHORS = new Map([
  ["City A", TRANSFER_CITY_A_ANCHOR],
  ["City B", TRANSFER_CITY_B_ANCHOR],
]);
const TRANSFER_MOBILITY_PROFILE = { tier: "medium" as const, localityRadiusKm: 30, normalDayTravelBudgetMinutes: 100 };

test("enforceNormalDayLocality (transfer day): an activity right next to the origin is accepted via the near-origin path, independent of detour math", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  // ~7.9km from City A (well within the 30km locality radius) but given a
  // duration (350min) that WOULD fail real detour math (available slack is
  // only ~303.5min) — if the near-origin bypass were broken and this fell
  // through to detour math instead, it would be wrongly rejected.
  const day = buildDay({
    dayNumber: 2,
    items: [buildItem({ name: "Near Origin Stop", lat: 0.05, lon: 0.05, estimatedDurationMinutes: 350 })],
  });

  const { days, violations } = enforceNormalDayLocality([day], TRANSFER_TRIP_FRAME, TRANSFER_AREA_ANCHORS, TRANSFER_MOBILITY_PROFILE, payload, profile);

  assert.ok(!violations.some((violation) => violation.itemName === "Near Origin Stop"));
  assert.ok(days[0].items.some((item) => item.name === "Near Origin Stop"));
});

test("enforceNormalDayLocality (transfer day): two individually-fine detour activities that together exceed the slack are correctly rejected in combination", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  // Both roughly on the direct A->B route (detour ~0), each well within the
  // ~303.5min slack alone (200min), but 200+200=400min together exceeds it.
  const day = buildDay({
    dayNumber: 2,
    items: [
      buildItem({ name: "On-Route Stop 1", lat: 0, lon: 2.0, estimatedDurationMinutes: 200 }),
      buildItem({ name: "On-Route Stop 2", lat: 0, lon: 2.0001, estimatedDurationMinutes: 200 }),
    ],
  });

  const { violations } = enforceNormalDayLocality([day], TRANSFER_TRIP_FRAME, TRANSFER_AREA_ANCHORS, TRANSFER_MOBILITY_PROFILE, payload, profile);

  const flagged = violations.filter((violation) => violation.reason === "infeasible_transfer_detour");
  assert.equal(flagged.length, 1, "exactly one of the two must be rejected once combined with the other");
});

test("enforceNormalDayLocality (transfer day): an activity requiring a large detour that doesn't fit the slack is rejected", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  // ~598.7km from BOTH A and B (real detour ~502min) — far beyond the
  // ~303.5min available slack.
  const day = buildDay({
    dayNumber: 2,
    items: [buildItem({ name: "Way Off Route Stop", lat: 5.0, lon: 2.0, estimatedDurationMinutes: 60 })],
  });

  const { days, violations } = enforceNormalDayLocality([day], TRANSFER_TRIP_FRAME, TRANSFER_AREA_ANCHORS, TRANSFER_MOBILITY_PROFILE, payload, profile);

  assert.ok(violations.some((violation) => violation.itemName === "Way Off Route Stop" && violation.reason === "infeasible_transfer_detour"));
  assert.ok(!days[0].items.some((item) => item.name === "Way Off Route Stop"));
});

// Spec "תיקון גנרי, לא תיקון תשיעי" — enforceNormalDayLocality is the
// terminal geographic gate every recent round has built around; its own
// repair step used to hand pickReplacementRecommendation a day view that
// still included the very item being repaired, so a candidate close only
// to THAT flagged item (never to the stay's real anchor) could pass.
test("enforceNormalDayLocality's own repair never selects a replacement that is close only to the flagged item, not to the stay's real anchor", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "fake-near-crater",
        name: "Fake Nearby To Flagged Item Only",
        category: "attraction",
        location: "Nowhere Real",
        // Close to Far Crater (City C, ~140km from City A) — far from the
        // stay's own real anchor (City A).
        lat: CITY_C_ANCHOR.lat + 0.001,
        lon: CITY_C_ANCHOR.lon + 0.001,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    title: "A normal City A day",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon, transportation: "רכב" }),
      // Explicit "רכב" — buildItem's own default ("הליכה") at ~140km real
      // distance would produce a travelMinutes so large the scheduler
      // drops any replacement as overflow regardless of geography, which
      // would mask whether the geographic check is what's really doing
      // the rejecting here.
      buildItem({ name: "Far Crater", slot: "afternoon", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon, transportation: "רכב" }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((violation) => violation.itemName === "Far Crater" && violation.repaired));
  assert.ok(
    !days[0].items.some((item) => item.name === "Fake Nearby To Flagged Item Only"),
    "a candidate close only to the flagged item being replaced must never be selected"
  );
});

test("enforceNormalDayLocality never touches a locked/fixed-time outlier — reports it instead of moving it", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const lockedFarItem = buildItem({ name: "Locked Far Reservation", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon, locked: true });
  const day = buildDay({ dayNumber: 1, items: [lockedFarItem] });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(days[0].items.some((item) => item.name === "Locked Far Reservation"), "a locked outlier must never be moved");
  assert.ok(violations.some((violation) => violation.itemName === "Locked Far Reservation" && !violation.repaired));
});

// Spec "א-סימטריה בין normal לday-trip/transfer" — this test previously
// relied on Gemini's own title text ("Day trip to the crater") to grant
// the exemption. Rewritten with a GENUINE round-trip structure (3+ real
// anchors, out and back to the same base) so it now proves the exemption
// survives on real geometry alone — see the new deriveDayType tests below
// for the acceptance criterion that a text label alone no longer works.
// Real bug this closes: a day_trip label used to be an UNCONDITIONAL pass
// on geography, regardless of how far or how thin the content actually
// was — the exact shape of a real QA replay bug (a day_trip-category item
// ~9459 minutes from its own day's base got verdict "passed" purely from
// its day-type label). day_trip/transfer-without-real-data days are now
// evaluated with the same real evaluateDayTripFeasibility math clusters
// already use — a day-trip label is permission to be away from base, not
// permission to skip geography. This test's original fixture (a single
// 90-minute stop, ~187min round trip) is a real but marginal day trip
// (valueRatio ~0.33, below the 0.4 threshold) — rewritten with a longer
// visit so the SAME distance is a genuinely feasible one, preserving the
// test's real intent ("a genuine day trip survives") rather than its
// pre-feasibility-math accident of always passing regardless of value.
test("enforceNormalDayLocality leaves a genuinely FEASIBLE day-trip day untouched even though its content sits far from the stay anchor", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const dayTrip = buildDay({
    dayNumber: 1,
    title: "A day out",
    items: [
      buildItem({ name: "Morning Departure", slot: "morning", plannedStartTime: "08:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      // ~140km from City A (~187min real round trip) with a substantial
      // 200min visit — valueRatio ~0.52, a genuinely worthwhile day trip.
      buildItem({
        name: "Far Crater",
        slot: "afternoon",
        plannedStartTime: "12:00",
        lat: CITY_C_ANCHOR.lat,
        lon: CITY_C_ANCHOR.lon,
        estimatedDurationMinutes: 200,
      }),
      buildItem({ name: "Evening Return", slot: "evening", plannedStartTime: "18:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
    ],
  });

  const { days } = enforceNormalDayLocality([dayTrip], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.deepEqual(days[0].items.map((item) => item.name), ["Morning Departure", "Far Crater", "Evening Return"]);
});

test("enforceNormalDayLocality repairs a day_trip-labeled item that is real-world infeasible from its own base (the Annapolis/Los-Angeles QA replay shape)", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  // A real, resolved POI (recommendationId + coordinates) thousands of km
  // from its own day's base, labeled category "day_trip" — the exact real
  // shape reported: a resolved place thousands of minutes away receiving
  // an unconditional pass purely because of its day-type/category label.
  // A genuine round-trip structure (isStructuralRoundTripDay: >=3 anchors,
  // first/last within 5km of each other, a middle item >60min one-way) —
  // the exact shape that earns real "day_trip" derivedDayType, matching
  // how the real replay's own item actually got there.
  const dayTrip = buildDay({
    dayNumber: 1,
    title: "A day out",
    items: [
      buildItem({ name: "Morning Departure", slot: "morning", plannedStartTime: "08:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildItem({
        name: "Impossibly Far Landmark",
        category: "day_trip",
        slot: "afternoon",
        plannedStartTime: "12:00",
        recommendationId: "rec-impossibly-far",
        lat: CITY_A_ANCHOR.lat + 40,
        lon: CITY_A_ANCHOR.lon + 40,
        estimatedDurationMinutes: 90,
      }),
      buildItem({ name: "Evening Return", slot: "evening", plannedStartTime: "18:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([dayTrip], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  const violation = violations.find((v) => v.itemName === "Impossibly Far Landmark");
  assert.ok(violation, "a real POI thousands of minutes from its own base must never receive an unconditional pass");
  assert.equal(violation?.reason, "infeasible_day_excursion");
  assert.ok(!days[0].items.some((item) => item.name === "Impossibly Far Landmark"));
});

// ==================================================
// PART: "GEMINI ITEMS ARE BYPASSING GEOGRAPHIC VALIDATION" — the real
// reported bug: a coordinate-LESS Gemini-authored item (e.g. "Golden Gate
// Bridge") used to skip enforceNormalDayLocality's whole check just
// because it had no lat/lon. Invented City A/B/C geography only.
// ==================================================

test("1. a coordinate-less item whose location text matches a DIFFERENT known stay is rejected by canonical region", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      // No coordinates at all — the exact real-world shape of the reported bug.
      buildCoordinatelessItem({ name: "Famous Bridge", location: "City B" }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((violation) => violation.itemName === "Famous Bridge" && violation.reason === "unverified_region_mismatch" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "Famous Bridge"));
});

test("2. a coordinate-less item whose location text matches its OWN stay is accepted through canonical region", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [buildCoordinatelessItem({ name: "Local Landmark", location: "City A" })],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.equal(violations.length, 0);
  assert.ok(days[0].items.some((item) => item.name === "Local Landmark"));
});

// Spec "GEOGRAPHIC CORRECTNESS REDESIGN" §4/§10 — "geography should be
// proven, not presumed." A normal-day item with no location text AND no
// match in the trip's own known candidates is unproven, not innocent —
// it is now repaired (real replacement first, free exploration second),
// never left in place on the strength of "it can't be disproven." This is
// a deliberate policy change from the previous pass (see git history).
test("3. a coordinate-less item with NO location text and no candidate match is unproven, not presumed local, on a normal day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    items: [buildCoordinatelessItem({ name: "Unlabeled Mystery Item", location: "" })],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((violation) => violation.itemName === "Unlabeled Mystery Item" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "Unlabeled Mystery Item"));
});

test("3b. a coordinate-less item that DOES match a real trip candidate by name is resolved to real coordinates and correctly kept", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ name: "Local Landmark", location: "City A", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon })],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  // The item arrived with no coordinates and no location text at all — it
  // can only survive by being genuinely resolved against the real pool.
  const day = buildDay({
    dayNumber: 1,
    items: [buildCoordinatelessItem({ name: "Local Landmark", location: "" })],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.equal(violations.length, 0, "a real, resolved-to-nearby candidate must not be treated as unproven");
  assert.ok(days[0].items.some((item) => item.name === "Local Landmark"));
});

test("3c. a coordinate-less item resolved to a real but genuinely distant candidate is still flagged as too far — resolution is not immunity", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ name: "Distant Landmark", location: "City B", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon })],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    items: [buildCoordinatelessItem({ name: "Distant Landmark", location: "" })],
  });

  const { violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(
    violations.some((violation) => violation.itemName === "Distant Landmark" && violation.reason === "too_far_from_base"),
    "resolving real coordinates must still subject the item to the normal distance check, not exempt it"
  );
});

// ==================================================
// PART: "RESOLVER FALSE POSITIVES" — ambiguity rejection. Invented
// geography only ("The Galleria" stands in for any generically-named real
// place that legitimately exists in more than one metro — no place names
// are hardcoded in the production logic itself, this is just the test's
// own illustrative name).
// ==================================================

test("(a) two distinct, similarly-named candidates both crossing the resolver's threshold => the item stays unresolved and is treated as unproven", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({ name: "The Galleria", location: "City A", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      // A genuinely different real place sharing the exact same name, far away — real ambiguity, not a duplicate tag of the same venue.
      buildRecommendation({ name: "The Galleria", location: "City C", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    items: [buildCoordinatelessItem({ name: "The Galleria", location: "" })],
  });

  const { violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(
    violations.some(
      (violation) => violation.itemName === "The Galleria" && violation.geographySource === "unresolved" && violation.reason === "unverified_region_mismatch"
    ),
    "an ambiguous match must be reported as unresolved, never as a confident resolution to whichever candidate happened to be nearest"
  );
});

test("(b) a single, certain recommendationId match resolves even when a similarly-named candidate also exists in the pool", () => {
  const localGalleria = buildRecommendation({
    id: "rec-local-galleria",
    name: "The Galleria",
    location: "City A",
    lat: CITY_A_ANCHOR.lat,
    lon: CITY_A_ANCHOR.lon,
  });
  const payload = buildPayload({
    recommendations: [
      localGalleria,
      // A same-named, genuinely different real place elsewhere — must not poison the certain id match.
      buildRecommendation({ name: "The Galleria", location: "City C", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 1,
    items: [buildCoordinatelessItem({ name: "The Galleria", location: "", recommendationId: "rec-local-galleria" })],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.equal(violations.length, 0, "a certain recommendationId match must resolve cleanly despite the ambiguous name elsewhere in the pool");
  assert.ok(days[0].items.some((item) => item.name === "The Galleria"));
});

// ==================================================
// PART: "א-סימטריה בין normal לday-trip/transfer" — deriveDayType must be
// derived from real TripFrame stay identity + coordinate geometry, never
// from Gemini's own title/notes/transportation wording. The Hebrew request
// asked for this to be verified explicitly; these are the acceptance tests.
// ==================================================

test("deriveDayType: a day whose real stay does not change is 'normal' even when Gemini's own text calls it a day trip", () => {
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const day = buildDay({
    dayNumber: 2,
    title: "Day trip to the crater", // Gemini's own words — must be ignored
    notes: "יום טיול מרגש",
    items: [buildItem({ name: "Only One Item", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon })], // too few anchors for genuine round-trip geometry
  });

  assert.equal(deriveDayType(day, tripFrame, null), "normal");
});

test("acceptance: a Gemini-labeled 'day trip' day whose real stay is unchanged is judged under full normal-day fail-closed rules", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day = buildDay({
    dayNumber: 2,
    title: "Day trip to the crater", // the label Gemini would use to try to escape the strict rule
    cityRegion: "City A",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildItem({ name: "Far Crater", slot: "afternoon", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(
    violations.some((violation) => violation.itemName === "Far Crater" && violation.repaired),
    "the day-trip label alone must not exempt a far item on a day whose real stay never changed"
  );
  assert.ok(!days[0].items.some((item) => item.name === "Far Crater"));
});

test("deriveDayType: a day whose real TripFrame stay DOES change is 'transfer', regardless of text", () => {
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const day = buildDay({ dayNumber: 2, title: "Just an ordinary day", notes: "", items: [] });
  assert.equal(deriveDayType(day, tripFrame, null), "transfer");
});

test("deriveDayType: a genuine coordinate round-trip is 'day_trip' even with no text hint at all", () => {
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const day = buildDay({
    dayNumber: 1,
    title: "",
    notes: "",
    items: [
      buildItem({ name: "A", plannedStartTime: "08:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildItem({ name: "B", plannedStartTime: "12:00", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
      buildItem({ name: "C", plannedStartTime: "18:00", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
    ],
  });
  assert.equal(deriveDayType(day, tripFrame, null), "day_trip");
});

test("deriveDayType: arrival/departure are derived from the real flight-leg date, never text", () => {
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const window = {
    earliestUsableTimeOnArrivalDay: { date: "2026-11-01", time: "14:00" },
    latestUsableTimeOnDepartureDay: { date: "2026-11-03", time: "10:00" },
  };
  const arrivalDay = buildDay({ dayNumber: 1, date: "2026-11-01", title: "Ordinary title" });
  const departureDay = buildDay({ dayNumber: 3, date: "2026-11-03", title: "Ordinary title" });
  const middleDay = buildDay({ dayNumber: 2, date: "2026-11-02", title: "Ordinary title" });

  assert.equal(deriveDayType(arrivalDay, tripFrame, window), "arrival");
  assert.equal(deriveDayType(departureDay, tripFrame, window), "departure");
  assert.equal(deriveDayType(middleDay, tripFrame, window), "normal");
});

// ==================================================
// PART: "מכני, לא קריאה ידנית" — computeGeographyDiagnostics acceptance.
// A real stay change (day 2) with NO transfer-sounding text at all (a
// real dayTypeMismatch), and a coordinate-less item that only resolves
// via a fuzzy name match against the trip's own candidate pool.
// ==================================================

test("computeGeographyDiagnostics: acceptance — shows a real dayTypeMismatch and a real fuzzyName resolution", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ name: "Old Town Market", location: "City A", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon })],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day1 = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [buildCoordinatelessItem({ name: "Old Town Market", location: "" })], // resolves via fuzzy name only
  });
  // Day 2 is a REAL stay change (City A -> City B) but its own text gives
  // no hint of that at all — exactly the asymmetry the report investigated.
  const day2 = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    title: "Just another day",
    notes: "",
    transportation: "הליכה",
    items: [buildItem({ name: "City B Anchor", lat: CITY_B_ANCHOR.lat, lon: CITY_B_ANCHOR.lon })],
  });

  const diagnostics = computeGeographyDiagnostics(
    [day1, day2],
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile,
    null
  );

  // Print the full table — the acceptance ask was "show me the rows."
  console.log("\n[computeGeographyDiagnostics acceptance demo]");
  for (const day of diagnostics) {
    console.log(
      `day ${day.dayNumber} | owner=${day.ownerStay} | derived=${day.derivedDayType} | textual=${day.textualDayType} | mismatch=${day.dayTypeMismatch} | totalLeg=${day.totalLegMinutes} | maxLeg=${day.maxLegMinutes} | unresolved=${day.unresolvedItemCount}`
    );
    for (const item of day.items) {
      console.log(
        `  - ${item.itemName} | geoSource=${item.geoSource} | precision=${item.precision} | ownerStay=${item.ownerStay} | legMinutes=${item.legMinutes} | verdict=${item.verdict} | rule=${item.verdictRule}`
      );
    }
  }

  const day1Diag = diagnostics.find((d) => d.dayNumber === 1)!;
  const day2Diag = diagnostics.find((d) => d.dayNumber === 2)!;

  assert.equal(day2Diag.derivedDayType, "transfer", "day 2's real stay change must be detected structurally");
  assert.equal(day2Diag.textualDayType, "normal", "day 2's own text gives no transfer hint at all");
  assert.equal(day2Diag.dayTypeMismatch, true, "the two classifiers must be shown to disagree");

  const fuzzyItem = day1Diag.items.find((item) => item.itemName === "Old Town Market")!;
  assert.equal(fuzzyItem.geoSource, "fuzzyName");
  assert.equal(fuzzyItem.precision, "point");
  assert.equal(fuzzyItem.verdict, "passed", "a correctly-resolved, in-radius item must show as passed, not flagged");
});

// ==================================================
// PART: real QA replay architectural pass — day-type authority, semantic
// role, and the golden-replay regression (Annapolis/Los-Angeles shape).
// ==================================================

// Point E — day-type invariant: authority must come from the STRUCTURAL
// classifier (derivedDayType), never the textual one, even when the two
// disagree. Reuses the exact day1/day2 dayTypeMismatch shape from the
// acceptance test above, but now also plants a genuinely wrong-owner item
// on day 2 — proving the mismatch itself never causes geography to be
// skipped (a mismatch used to be purely informational).
test("day-type authority: a real dayTypeMismatch (derived=transfer, textual=normal) does not exempt genuinely wrong-owner content from being flagged", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day1 = buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "City A Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon })] });
  // Day 2: a real stay change (derived=transfer) but its own text says
  // nothing of the sort (textual=normal) — the SAME mismatch shape as the
  // acceptance test — PLUS a genuinely wrong-owner item (belongs to
  // neither City A nor City B) that must still be caught.
  const day2 = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    title: "Just another day",
    notes: "",
    transportation: "הליכה",
    items: [
      buildItem({ name: "City B Anchor", lat: CITY_B_ANCHOR.lat, lon: CITY_B_ANCHOR.lon }),
      buildItem({ name: "Genuinely Unrelated Place", lat: CITY_A_ANCHOR.lat + 40, lon: CITY_A_ANCHOR.lon + 40, estimatedDurationMinutes: 90 }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day1, day2], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(
    violations.some((v) => v.itemName === "Genuinely Unrelated Place"),
    "a dayTypeMismatch must never itself be a reason to skip geography validation"
  );
  assert.ok(!days[1].items.some((item) => item.name === "Genuinely Unrelated Place"));
});

// The other, more dangerous direction of the SAME invariant: prose that
// FALSELY claims a transfer/day-trip (derived=normal — the real stay never
// changes — but textual=transfer, from Gemini's own notes text) must never
// grant the exemption. Authority must come from the real TripFrame stay
// structure, never generated prose — this is the exact case that would
// silently start passing if day-type authority were ever swapped from
// derivedDayType to textualDayType.
test("day-type authority: prose that falsely claims a transfer (textual=transfer, derived=normal — the real stay never changes) does not exempt wrong-owner content", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  // A SINGLE-phase trip — day 2 stays in the same real stay as day 1, so
  // derivedDayType must be "normal" regardless of what the day's own text
  // says.
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 2, startDayNumber: 1, endDayNumber: 2 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day1 = buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "City A Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon })] });
  const day2 = buildDay({
    dayNumber: 2,
    cityRegion: "City A",
    title: "יום מעבר", // falsely claims "transfer" — the real stay (tripFrame) never changes
    notes: "",
    transportation: "",
    items: [
      buildItem({ name: "City A Anchor 2", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      // ~70km — beyond this profile's own 25km locality radius (so the
      // correct "normal day" strict check flags it), but well within a
      // generous day-trip-style feasibility budget (so a wrongly-granted
      // exemption would let it through). A thousands-of-km distance
      // wouldn't discriminate this specific mutation: it's extreme enough
      // to fail EITHER check, correct or wrongly-exempted alike.
      buildItem({ name: "Genuinely Unrelated Place", lat: CITY_A_ANCHOR.lat + 0.63, lon: CITY_A_ANCHOR.lon, estimatedDurationMinutes: 90 }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day1, day2], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(
    violations.some((v) => v.itemName === "Genuinely Unrelated Place"),
    "prose falsely claiming a transfer must never exempt a day whose real stay never changed"
  );
  assert.ok(!days[1].items.some((item) => item.name === "Genuinely Unrelated Place"));
});

// Point B — semantic role: a synthetic free-time block (itemRole:
// "free_time") must never be reported as a real, verified place — even
// though its category ("attraction") is indistinguishable from a genuine
// one, and even though its Hebrew display text ("free time to explore...")
// is never inspected. This is exactly the reported shape: "זמן פנוי לגלות
// את שיקגו בקצב שלכם", category attraction, geoSource unresolved, verdict
// passed — the fix classifies it "n/a", not "unresolved"/"passed" as if it
// were a validated real POI.
test("semantic role: a synthetic free-time block is never classified as a real, verified place", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const freeTimeBlock = buildCoordinatelessItem({
    name: "Free time to explore at your own pace",
    category: "attraction",
    itemRole: "free_time",
    location: "",
  });
  const day = buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "City A Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }), freeTimeBlock] });

  const diagnostics = computeGeographyDiagnostics([day], tripFrame, areaAnchors, mobilityProfile, payload, profile, null);
  const item = diagnostics[0].items.find((entry) => entry.itemName === "Free time to explore at your own pace")!;

  assert.equal(item.geoSource, "n/a", "a synthetic free-time block is not a real place claim at all — never 'unresolved' (which implies an unverifiable real one)");
});

// Point I — golden replay: the real captured shape (a resolved real POI
// thousands of minutes from its assigned stay, receiving verdict
// "passed"). Uses the REAL Annapolis/Los Angeles coordinates from the
// actual QA replay (per the request's own allowance — the fixture may
// contain real captured data even though the unit invariants above use
// synthetic coordinates).
test("golden replay: a resolved real POI thousands of minutes from its assigned stay can never receive verdict 'passed' (Annapolis/Los Angeles shape)", () => {
  const LOS_ANGELES = { lat: 34.0522, lon: -118.2437 };
  const ANNAPOLIS = { lat: 38.9784, lon: -76.4922 };

  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "Los Angeles", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["Los Angeles", LOS_ANGELES]]);
  const mobilityProfile = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };

  // Same structural round-trip shape (departure/excursion/return) that
  // earns a real "day_trip" derivedDayType — matching the real replay's
  // own item category ("day_trip").
  const day = buildDay({
    dayNumber: 1,
    cityRegion: "Los Angeles",
    items: [
      buildItem({ name: "Morning Departure", slot: "morning", plannedStartTime: "08:00", lat: LOS_ANGELES.lat, lon: LOS_ANGELES.lon }),
      buildItem({
        name: "Annapolis",
        category: "day_trip",
        recommendationId: "rec-annapolis",
        slot: "afternoon",
        plannedStartTime: "12:00",
        lat: ANNAPOLIS.lat,
        lon: ANNAPOLIS.lon,
        estimatedDurationMinutes: 90,
      }),
      buildItem({ name: "Evening Return", slot: "evening", plannedStartTime: "18:00", lat: LOS_ANGELES.lat, lon: LOS_ANGELES.lon }),
    ],
  });

  const diagnostics = computeGeographyDiagnostics([day], tripFrame, areaAnchors, mobilityProfile, payload, profile, null);
  const annapolisDiag = diagnostics[0].items.find((entry) => entry.itemName === "Annapolis")!;

  console.log(`[golden replay] Annapolis: legMinutes=${annapolisDiag.legMinutes}, verdict=${annapolisDiag.verdict}, rule=${annapolisDiag.verdictRule}`);

  assert.ok((annapolisDiag.legMinutes ?? 0) > 5000, "sanity: this really is a cross-country, thousands-of-minutes distance");
  assert.notEqual(annapolisDiag.verdict, "passed", "a real POI thousands of minutes from its assigned stay must never receive verdict 'passed'");
  assert.equal(annapolisDiag.verdictRule, "enforceNormalDayLocality: infeasible_day_excursion");

  // And the real repair pipeline actually removes it, not just flags it.
  const { days } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.ok(!days[0].items.some((item) => item.name === "Annapolis"));
});

// ==================================================
// PART: "FAIL CLOSED ON MISSING COMPARISON GEOMETRY" — a second, separate
// real QA replay found the SAME symptom (ownerStay incompatible,
// legMinutes: null, verdict: passed) via a DIFFERENT mechanism than the
// day-trip exemption above: refineTripFrameWithGemini renamed a phase's
// areaLabel to a broad display name (a real example: a specific city
// relabeled to "California Coast") with no matching entry in areaAnchors
// (built independently from the pool's own raw location text, never
// re-derived after the rename) — the phase's anchor was silently
// orphaned, and enforceNormalDayLocality's own "no anchor -> skip the
// whole day" default let genuinely unrelated real POIs (New
// York/Chicago/Tennessee content in the real replay) "pass" purely
// because there was nothing to compare against. Synthetic City A/B — the
// real broad-label bug is reproduced generically, not by name-matching
// "California Coast".
// ==================================================

test("golden replay: a broad/relabeled stay with NO resolvable anchor cannot let a genuinely unrelated real POI 'pass'", () => {
  const CITY_B_FAR = { lat: 60.0, lon: 60.0 }; // genuinely unrelated real city, far from City A

  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  // The phase's OWN areaLabel ("Broad Regional Label") has NO entry in
  // areaAnchors — the exact real desync: a relabeled/broad stay whose
  // display name never matches any raw pool location text.
  const tripFrame = buildTestFrame([{ areaLabel: "Broad Regional Label", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map<string, { lat: number; lon: number } | null>(); // deliberately empty — no anchor for "Broad Regional Label" at all
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day = buildDay({
    dayNumber: 1,
    cityRegion: "Broad Regional Label",
    items: [
      buildItem({ name: "Unrelated Landmark 1", recommendationId: "rec-unrelated-1", lat: CITY_B_FAR.lat, lon: CITY_B_FAR.lon }),
      buildItem({ name: "Unrelated Landmark 2", recommendationId: "rec-unrelated-2", lat: CITY_B_FAR.lat + 0.01, lon: CITY_B_FAR.lon }),
    ],
  });

  const diagnostics = computeGeographyDiagnostics([day], tripFrame, areaAnchors, mobilityProfile, payload, profile, null);
  const item1 = diagnostics[0].items.find((entry) => entry.itemName === "Unrelated Landmark 1")!;

  assert.equal(item1.legMinutes, null, "sanity: with no owner anchor, legMinutes genuinely cannot be computed");
  assert.notEqual(item1.verdict, "passed", "a resolved real POI must never receive verdict 'passed' merely because its owning stay has no anchor to compare against");
  assert.equal(item1.verdictRule, "enforceNormalDayLocality: unresolved_owner_geometry");

  const summary = summarizeGeographyDiagnostics(diagnostics);
  assert.equal(summary.realItemsWithNullLegGeometry, 2);
  assert.equal(summary.realItemsWithUnresolvedOwnerGeometry, 2);
  assert.equal(summary.ownerGeometryMissingDays, 1);

  // The real repair pipeline actually flags/removes both — not a silent skip.
  const { violations } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.equal(violations.filter((v) => v.reason === "unresolved_owner_geometry").length, 2);
});

test("4. a future-stay item with no coordinates cannot leak into the current stay's normal day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const day1 = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildCoordinatelessItem({ name: "City B's Own Museum", location: "City B" }),
    ],
  });

  const { days } = enforceNormalDayLocality([day1], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.ok(!days[0].items.some((item) => item.name === "City B's Own Museum"));
});

test("day-trip day: a coordinate-less item matching a DIFFERENT known stay is rejected, even though day-trip content is otherwise exempt", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const dayTrip = buildDay({
    dayNumber: 1,
    title: "Day trip from City A",
    cityRegion: "City A",
    items: [
      buildItem({ name: "Local Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      // Really City B's own content, mislabeled as a City-A day trip — the Chicago -> Point Reyes shape.
      buildCoordinatelessItem({ name: "City B Landmark", location: "City B" }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([dayTrip], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "City B Landmark" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "City B Landmark"));
});

test("transfer day: an unrelated third-region item is rejected — the New Orleans -> Cleveland/Beverly-Hills/LAX shape", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const tripFrame = buildTestFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
    { areaLabel: "City C", nights: 1, startDayNumber: 3, endDayNumber: 3 },
  ]);
  const areaAnchors = new Map([
    ["City A", CITY_A_ANCHOR],
    ["City B", CITY_B_ANCHOR],
    ["City C", CITY_C_ANCHOR],
  ]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const transferDay = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    notes: "יום מעבר בין בסיסים",
    transportation: "טיסה",
    items: [
      // Neither City B (today's stay) nor City A/nothing — a genuine third-region detour, matching City C exactly.
      buildCoordinatelessItem({ name: "City C Detour", location: "City C" }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([transferDay], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "City C Detour" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "City C Detour"));
});

// ==================================================
// PART: "AIRPORTS ARE NOT ATTRACTIONS" — enforceTransportRoleGuard
// ==================================================

test("enforceTransportRoleGuard repairs an airport used as a normal sightseeing item", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "City International Airport", category: "attraction" })],
  });

  const { days, violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "City International Airport" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "City International Airport"));
});

test("enforceTransportRoleGuard leaves an airport alone when it's already the legitimate transportation category", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "City International Airport", category: "transportation" })],
  });

  const { violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.equal(violations.length, 0);
});

test("enforceTransportRoleGuard leaves a real airport mention alone on a genuine transfer day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    notes: "יום מעבר בין בסיסים",
    items: [buildItem({ name: "City International Airport", category: "attraction" })],
  });

  const { violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.equal(violations.length, 0);
});

// Spec "תיקון גנרי, לא תיקון תשיעי" — enforceTransportRoleGuard's own
// replacement call used to hand pickReplacementRecommendation a day view
// that still included the airport/station item being repaired, so a
// candidate close only to IT (never to the day's real anchor) could pass.
test("enforceTransportRoleGuard never selects a replacement close only to the airport item itself, not to the day's real anchor", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "fake-near-airport",
        name: "Fake Nearby To Airport Only",
        category: "attraction",
        location: "Nowhere Real",
        // Close to the airport (11.26, 10) — far from the real base (10, 10).
        lat: 11.261,
        lon: 10.001,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    transportation: "רכב",
    items: [
      buildItem({ name: "Base Anchor", category: "attraction", lat: 10, lon: 10, transportation: "רכב" }),
      // ~140km real distance, explicit "רכב" — the same real-walking-speed
      // scheduling-overflow trap as the other new tests this round.
      buildItem({ name: "City International Airport", category: "attraction", slot: "afternoon", lat: 11.26, lon: 10, transportation: "רכב" }),
    ],
  });

  const { days } = enforceTransportRoleGuard([day], payload, profile);

  assert.ok(!days[0].items.some((item) => item.name === "City International Airport"), "the airport item must not survive under its original name");
  assert.ok(
    !days[0].items.some((item) => item.name === "Fake Nearby To Airport Only"),
    "a candidate close only to the airport item being replaced must never be selected"
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

// Part "FOOD CLEANUP" — buildFallbackAiItinerary (trip-workspace.ts) has
// its own, entirely separate meal-placeholder path from country-
// itinerary-generation.ts's buildFallbackMealPlaceholder — a real gap
// found during audit where the old "מסעדה מקומית באזור..."-style fake
// business names still existed here even after the other path was fixed.
// This confirms ONE behavior across both fallback paths now.
test("buildFallbackAiItinerary's own meal fallback also produces a real meal opportunity, never an invented business name", () => {
  const payload = buildPayload({
    preferences: { ...basePreferences, startDate: "2026-09-01", endDate: "2026-09-02", tripPace: "balanced" },
    recommendations: [],
    selectedPlaces: [],
  });

  const fallback = buildFallbackAiItinerary(payload);
  const mealItems = fallback.days.flatMap((day) => day.items).filter((item) => item.category === "cafe" || item.category === "restaurant");
  assert.ok(mealItems.length > 0, "sanity check: this fixture does produce fallback meal items");
  for (const mealItem of mealItems) {
    assert.ok(isMealOpportunityMarker(mealItem), `"${mealItem.name}" must be recognized as a meal opportunity`);
    assert.ok(mealItem.name.startsWith("🍽"), `"${mealItem.name}" must not read as an invented business name`);
    assert.equal(mealItem.approximatePrice, null);
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
  // A real candidate that exists only in the mutation-audit's original
  // empty-pool version's blind spot: close only to the outlier itself,
  // never to the day's real anchor (Tokyo Tower) — the same "outlier
  // still counted as its own anchor" bug this function had, now fixed the
  // same way repairNormalDayTravelOutliers was. transportation is
  // explicitly "רכב" (car) and the distance kept moderate (~98km, still
  // well past the 80km default CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM)
  // rather than the real Tokyo-Kyoto ~370km — at buildItem's own default
  // walking speed, that real distance produces a multi-day travelMinutes
  // that the scheduler rejects as overflow regardless of geography,
  // which would silently mask whether the geographic check is what's
  // actually doing the rejecting here.
  const nearOutlierFarFromTokyo = buildRecommendation({
    id: "near-outlier-1",
    name: "Fake Nearby To Outlier Only",
    category: "attraction",
    location: "Nowhere Real",
    lat: 34.81,
    lon: 139.77,
  });
  const payload = buildPayload({ recommendations: [nearOutlierFarFromTokyo], selectedPlaces: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 1);

  // ~98km (well past the 80km default CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM)
  // rather than the real Tokyo-Kyoto ~370km — at buildItem's own default
  // walking speed, that real distance produces a multi-day travelMinutes
  // that the scheduler rejects as overflow regardless of geography, which
  // would silently mask whether the geographic check is what's actually
  // doing the rejecting here. Explicit "רכב" keeps the estimate realistic.
  const distantOutlier = buildItem({ name: "Distant Outlier", location: "Nowhere Real", lat: 34.8, lon: 139.76, transportation: "רכב" });
  // Tokyo Tower is locked — with only two items, analyzeDayGeography's
  // pairwise cross-city check flags BOTH sides of the mismatched pair (it
  // has no way to know which of the two is "the real base"), so
  // repairCrossRegionDayContent would also try to "repair" Tokyo Tower
  // itself first, against a day view that (correctly, per the fix) then
  // excludes Tokyo Tower — leaving only the outlier as the sole
  // "anchor" and letting a candidate close to the outlier slip through
  // for THAT round. Locking Tokyo Tower makes it a protectedGeographicConflict
  // instead (skipped, never removed as an anchor), so it stays the one
  // real anchor Distant Outlier's own replacement is judged against.
  const dayOne = buildDay({
    dayNumber: 1,
    cityRegion: "Tokyo",
    transportation: "רכב",
    items: [buildItem({ name: "Tokyo Tower", transportation: "רכב", locked: true }), distantOutlier],
  });

  const { days, protectedGeographicConflicts } = repairCrossRegionDayContent([dayOne], payload, profile);

  assert.ok(days[0].items.some((item) => item.name === "Tokyo Tower"), "the locked real anchor must survive untouched");
  assert.ok(!days[0].items.some((item) => item.name === "Distant Outlier"), "outlier must not survive under its original name");
  assert.ok(
    !days[0].items.some((item) => item.name === "Fake Nearby To Outlier Only"),
    "a candidate close only to the outlier being replaced (not to the day's real anchor) must never be selected"
  );
  const replacement = days[0].items.find((item) => item.name !== "Tokyo Tower");
  assert.ok(replacement, "outlier must be replaced, not silently dropped");
  assert.equal(replacement?.lat, null, "a placeholder replacement must be geographically neutral, never inherit the outlier's real coordinates");
  assert.ok(protectedGeographicConflicts.length >= 1, "Tokyo Tower being (mutually) flagged and locked must still surface as a protected conflict, not silently vanish");
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

// =====================================================================
// ITINERARY-WIDE USAGE STATE — root-cause fix for the real 43-day US
// replay (Times Square/Central Park first placed correctly by
// deterministic_template in New York, then RE-inserted by locality_repair
// into Austin/Philadelphia/Nashville/Chicago/Boston/etc., every one
// reporting alreadyUsedAtInsertion:false). Every repair pass used to
// rebuild its own "used" Set from only the single day it was actively
// repairing, discarding every other day's content — these tests prove
// the itinerary-wide ItineraryUsageState closes that gap for each of the
// named repair paths, per spec §H's 10 required scenarios.
// =====================================================================

const USAGE_CITY_ANCHOR = { lat: 41.5, lon: -75.5 };

// 1 & 4. A place already scheduled on day 1 must never be selected again
// by locality_repair on a later day, even when it's the ONLY
// geographically compatible candidate — same recommendationId collision.
test("enforceNormalDayLocality never reinserts a real place already scheduled on an earlier day (itinerary-wide usage)", () => {
  const placeA = buildRecommendation({
    id: "place-a",
    name: "Place A",
    category: "attraction",
    location: "City A",
    lat: USAGE_CITY_ANCHOR.lat,
    lon: USAGE_CITY_ANCHOR.lon,
  });
  const payload = buildPayload({ recommendations: [placeA] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 10);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 10, startDayNumber: 1, endDayNumber: 10 }]);
  const areaAnchors = new Map([["City A", USAGE_CITY_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day1 = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [buildItem({ name: "Place A", recommendationId: "place-a", lat: USAGE_CITY_ANCHOR.lat, lon: USAGE_CITY_ANCHOR.lon })],
  });
  const day10 = buildDay({
    dayNumber: 10,
    cityRegion: "City A",
    items: [
      buildItem({ name: "Local Anchor", lat: USAGE_CITY_ANCHOR.lat, lon: USAGE_CITY_ANCHOR.lon }),
      // Far outside the locality radius — must be repaired. Place A is the
      // ONLY candidate in the pool, so a broken "used" check would recycle it.
      buildItem({ name: "Far Outlier", slot: "afternoon", lat: CITY_C_ANCHOR.lat, lon: CITY_C_ANCHOR.lon }),
    ],
  });

  const { days } = enforceNormalDayLocality([day1, day10], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  const placeACount = days.flatMap((day) => day.items).filter((item) => item.recommendationId === "place-a").length;
  assert.equal(placeACount, 1, "Place A must appear exactly once across the whole itinerary, never recycled onto day 10");
  assert.ok(!days[1].items.some((item) => item.recommendationId === "place-a"));
});

// 2 & 3. Multiple sequential replacements in the SAME pass must see each
// other's insertions immediately — and releasing an item for its OWN
// replacement slot must never unblock a DIFFERENT identity.
test("pickReplacementRecommendation: sequential replacements in one pass immediately see each other's insertions, and releasing an item never unblocks a different one", () => {
  const placeB = buildRecommendation({ id: "place-b", name: "Place B", category: "attraction", location: "City A", lat: 10.001, lon: 10.001 });
  const placeC = buildRecommendation({ id: "place-c", name: "Place C", category: "attraction", location: "City A", lat: 10.002, lon: 10.002 });
  const payload = buildPayload({ recommendations: [placeB, placeC] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const anchor = buildItem({ name: "Anchor", lat: 10, lon: 10 });
  const outlier1 = buildItem({ name: "Outlier 1", lat: 90, lon: 90, recommendationId: null });
  const day = buildDay({ dayNumber: 1, items: [anchor, outlier1] });

  const usageState = createItineraryUsageState();

  // First repair selects a real candidate (Place B or C) and registers it.
  const firstPick = pickReplacementRecommendation({ payload, day, item: outlier1, profile, usageState });
  assert.ok(firstPick, "expected a real candidate to be found for the first replacement");
  registerItineraryUsage(usageState, { recommendationId: firstPick!.id, name: firstPick!.name, lat: firstPick!.lat, lon: firstPick!.lon, itemRole: "real_place" as const });

  // A second repair, same pass, same usageState, must immediately see the
  // first pick as used and be forced onto the OTHER real candidate.
  const outlier2 = buildItem({ name: "Outlier 2", lat: 91, lon: 91, recommendationId: null });
  const secondPick = pickReplacementRecommendation({ payload, day: { ...day, items: [anchor, outlier2] }, item: outlier2, profile, usageState });
  assert.ok(secondPick, "expected a real candidate to be found for the second replacement");
  assert.notEqual(secondPick!.id, firstPick!.id, "the second replacement must never repeat the first pass's own selection");
  registerItineraryUsage(usageState, { recommendationId: secondPick!.id, name: secondPick!.name, lat: secondPick!.lat, lon: secondPick!.lon, itemRole: "real_place" as const });

  // Now replace the FIRST pick's own slot: releasing it must allow IT
  // to be picked again (this is its own replacement slot), but the
  // second pick's identity must remain blocked throughout.
  releaseItineraryUsage(usageState, { recommendationId: firstPick!.id, name: firstPick!.name, lat: firstPick!.lat, lon: firstPick!.lon, itemRole: "real_place" as const });
  assert.equal(isItineraryPlaceUsed(usageState, { id: firstPick!.id, name: firstPick!.name, lat: firstPick!.lat, lon: firstPick!.lon }), false, "releasing an item for its own replacement slot must unblock exactly that identity");
  assert.equal(isItineraryPlaceUsed(usageState, { id: secondPick!.id, name: secondPick!.name, lat: secondPick!.lat, lon: secondPick!.lon }), true, "every OTHER identity must remain blocked while one specific item is being replaced");
});

// 5. A category alias — a different recommendationId claiming the same
// normalized name + real coordinates — must still count as already used.
test("isItineraryPlaceUsed rejects a category alias: different recommendationId, same normalized name + coordinates", () => {
  const usageState = createItineraryUsageState();
  registerItineraryUsage(usageState, {
    recommendationId: "attraction-id",
    name: "Golden Gate Park",
    lat: 37.7694,
    lon: -122.4862,
    itemRole: "real_place",
  });

  const outdoorRecreationAlias = { id: "outdoor-recreation-id", name: "Golden Gate Park", lat: 37.7694, lon: -122.4862 };
  assert.equal(
    isItineraryPlaceUsed(usageState, outdoorRecreationAlias),
    true,
    "a different id claiming the same real place by name+coordinates must still be treated as already used"
  );
});

// 6. When the legal pool is exhausted purely because every local candidate
// is already used, that is the CORRECT outcome — the caller falls to a
// placeholder, never a recycled real POI.
test("buildLegalDayCandidatePool returns empty (not a recycled real POI) when every local candidate is already used", () => {
  const onlyCandidate: TripRecommendation = buildRecommendation({ id: "only-one", name: "Only One", lat: 10, lon: 10 });
  const usageState = createItineraryUsageState();
  registerItineraryUsage(usageState, { recommendationId: "only-one", name: "Only One", lat: 10, lon: 10, itemRole: "real_place" as const });

  const legalPool = buildLegalDayCandidatePool({
    pool: [onlyCandidate],
    ownerAnchors: [{ lat: 10, lon: 10 }],
    usedToday: new Set(),
    usageCounts: usageState.usageCounts,
    usedRealPlaces: usageState.usedRealPlaces,
  });

  assert.deepEqual(legalPool, [], "the only real candidate is already used — an empty legal pool (leading to a placeholder) is the correct outcome, not recycling it");
});

// 7. opening_hours_repair must never reinsert a real POI already used
// elsewhere in the itinerary, even when it's the only real candidate that
// would otherwise fit.
test("repairOpeningHoursViolations never reinserts a real place already used on another day", () => {
  const placeA = buildRecommendation({
    id: "place-a",
    name: "Place A",
    category: "nature",
    location: "Eilat",
    openingHours: "08:00-18:00",
    lat: 29.55,
    lon: 34.95,
  });
  const payload = buildPayload({ recommendations: [placeA] });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);

  const usedDay = buildDay({
    dayNumber: 1,
    cityRegion: "Eilat",
    items: [buildItem({ name: "Place A", category: "nature", recommendationId: "place-a", lat: 29.55, lon: 34.95 })],
  });
  const violatingDay = buildDay({
    dayNumber: 2,
    cityRegion: "Eilat",
    items: [
      buildItem({ name: "Timna Park", category: "nature", openingHours: "08:00-16:00", plannedStartTime: "19:52", lat: 29.55, lon: 34.95 }),
    ],
  });

  const [, repairedViolatingDay] = repairOpeningHoursViolations([usedDay, violatingDay], payload, profile);

  assert.equal(
    repairedViolatingDay.items.some((item) => item.recommendationId === "place-a"),
    false,
    "Place A is already used on day 1 and must never be reinserted on day 2"
  );
});

// 8. day_fill must never reinsert a real POI already used elsewhere in the
// itinerary.
test("fillUnderfilledDay never reinserts a real place already used elsewhere (shared itinerary-wide usage state)", () => {
  const placeA = buildRecommendation({ id: "place-a", name: "Place A", estimatedDurationMinutes: 150, lat: 35.681, lon: 139.767 });
  const payload = buildPayload({ recommendations: [placeA] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 3);

  const usageState = buildItineraryUsageState([
    buildDay({ dayNumber: 1, items: [buildItem({ name: "Place A", recommendationId: "place-a", lat: 35.681, lon: 139.767 })] }),
  ]);
  const emptyDay = buildDay({ dayNumber: 2, items: [] });

  const filled = fillUnderfilledDay(emptyDay, payload, profile, usageState);

  assert.equal(
    filled.items.some((item) => item.recommendationId === "place-a"),
    false,
    "Place A is already used on day 1 (shared usageState) and must never be inserted into day 2's fill"
  );
});

// 9. transfer_repair (enforceArrivalDepartureWindow's replacement path)
// must never reinsert a real POI already used elsewhere in the itinerary.
test("enforceArrivalDepartureWindow's replacement path never reinserts a real place already used on another day", () => {
  const placeA = buildRecommendation({
    id: "place-a",
    name: "Place A",
    category: "attraction",
    location: "Marne-la-Vallée",
    lat: 48.867,
    lon: 2.781,
  });
  const payload = buildPayload({ recommendations: [placeA] });
  const profile = buildTripPreferenceProfile(basePreferences, "France", 3);
  const middleDay = buildDay({
    dayNumber: 2,
    date: "2026-09-16",
    items: [buildItem({ name: "Place A", recommendationId: "place-a", lat: 48.867, lon: 2.781 })],
  });
  const departureDay = buildDay({
    dayNumber: 3,
    date: "2026-09-17",
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
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: { date: "2026-09-17", time: "13:15" } };

  const [, repairedDeparture] = enforceArrivalDepartureWindow([middleDay, departureDay], payload, profile, window, 3);

  assert.equal(
    repairedDeparture.items.some((item) => item.recommendationId === "place-a"),
    false,
    "Place A is already used on day 2 and must never be reinserted on the departure day"
  );
});

// 10. A Gemini-resolved duplicate (the SAME real place authored on two
// different days by Gemini itself) must be caught and replaced at
// ingestion, before any downstream repair pass ever sees it.
test("repairPlan rejects a Gemini-authored duplicate at ingestion (same recommendationId across two days)", () => {
  const duplicatePlace = buildRecommendation({
    id: "dup-place",
    name: "Duplicate Place",
    category: "attraction",
    location: "Tokyo",
    lat: 35.681,
    lon: 139.767,
  });
  const payload = buildPayload({ recommendations: [duplicatePlace] });
  const profile = buildTripPreferenceProfile(basePreferences, "Japan", 3);
  const tripFrame = buildTestFrame([{ areaLabel: "Tokyo", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);

  const rawItem = (): RawGeneratedItem => ({
    name: "Duplicate Place",
    category: "attraction",
    location: "Tokyo",
    shortDescription: "A real place Gemini authored twice",
    slot: "morning",
    plannedStartTime: "10:00",
    estimatedDurationMinutes: 90,
  });
  const raw: RawGeneratedPlan = {
    title: "Test Plan",
    summary: "",
    days: [
      { dayNumber: 1, date: "2026-10-06", title: "Day 1", cityRegion: "Tokyo", accommodation: "Hotel", notes: "", transportation: "", items: [rawItem()] },
      { dayNumber: 2, date: "2026-10-07", title: "Day 2", cityRegion: "Tokyo", accommodation: "Hotel", notes: "", transportation: "", items: [rawItem()] },
      { dayNumber: 3, date: "2026-10-08", title: "Day 3", cityRegion: "Tokyo", accommodation: "Hotel", notes: "", transportation: "", items: [] },
    ],
  };

  const result = repairPlan(raw, payload, profile, tripFrame, null, undefined, 1);

  const duplicateCount = result.days.flatMap((day) => day.items).filter((item) => item.recommendationId === "dup-place").length;
  assert.equal(duplicateCount, 1, "the same Gemini-authored real place must survive on only ONE day, the second occurrence rejected at ingestion");
});
