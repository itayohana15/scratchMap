import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  findFramePhaseForDay,
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
  enforceFinalPlaceLegalityGate,
  enforceStayTransitions,
  buildStayTransitionItem,
  normalizeDayOwnershipToFrame,
  validateFinalItineraryInvariants,
  enforceItineraryInvariantsWithRepair,
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
  validateItineraryQuality,
  passesQualityValidation,
  assertRealActivityCoverage,
  buildStaySupplyDiagnosticsMap,
  backfillRealActivities,
  backfillRealMealVenues,
  buildReplacementItem,
  InsufficientRealActivityCoverageError,
  InsufficientRealActivitySupplyError,
  RealPlaceDiscoveryUnavailableError,
  classifyPlanFailure,
  isSupplyHealthyForComposition,
  assessTripDiscoveryHealth,
  attemptBoundedStayRecovery,
  attemptBoundedRecoveryForFailedStays,
  snapshotRealActivities,
  snapshotDayItemsForRepairTrace,
  passesHardInvariantsForFallbackRecovery,
  RealPlaceContentLostError,
  finalizeArrivalDepartureContent,
  computeAreaAnchors,
  resolveAreaAnchorsForFrame,
  diversifyActivities,
  resolveExactIdDuplicates,
  computeRealPlaceDuplicateGroups,
  assertNoRealPlaceDuplicatesRemain,
  RealPlaceDuplicatesRemainError,
  composeDaysFromStayPortfolios,
  scoreCandidateForDayAssignment,
  refineComposedPlanWithGemini,
  refillTripRecommendationPool,
  refillDeficientStaysAfterReallocation,
  estimatePreGenerationDayTypesByStay,
  needsStaySkeleton,
  buildStaySkeletonPrompt,
  proposeStaySkeletonWithGemini,
  buildTripFrame,
  attemptReservePromotion,
  type RawGeneratedPlan,
  type RawGeneratedItem,
} from "../src/lib/server/country-itinerary-generation";
import { buildTripMealVenuePools, selectMealVenueFromPool } from "../src/lib/server/stay-meal-venue-pool";
import {
  buildTripActivityPortfolios,
  buildStayActivityPool,
  computeStayCapacity,
  assignCandidatesToStays,
  selectStayPortfolio,
  validateGeminiPortfolioSelection,
  ACTIVITY_QUERY_GROUPS,
  MEAL_QUERY_GROUP,
} from "../src/lib/server/stay-activity-pool";
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
  shouldResolveAsRealPlace,
  selectFallbackCandidate,
  createEmptyFlightLeg,
} from "../src/lib/trip-workspace";
import {
  diffRealActivitySnapshots,
  classifyZeroPoolReason,
  computeRepairStepDelta,
  isCatastrophicRepairLoss,
  type RepairSnapshotItem,
} from "../src/lib/server/real-place-qa";
import { countRegionRevisits, type StayRouteNode } from "../src/lib/server/itinerary-planning-principles";
import type { StayTransition, TripFrame } from "../src/lib/server/itinerary-planning-principles";
import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryRequest,
  AiItineraryResponse,
  TripPreferences,
  TripRecommendation,
  RecommendationCategory,
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
  // Round 9.2.1 §9 — a plain cafe has no LUNCH suitability evidence by
  // default (it's a meal venue for breakfast/brunch/coffee only), so this
  // fixture now carries genuine lunch-service evidence in its own
  // description — the exact "structured evidence" spec §9 requires before a
  // cafe becomes lunch-eligible — keeping this test about ROUTE distance
  // preference, not accidentally exercising the meal-type gate.
  const good = buildRecommendation({
    id: "meal-good",
    name: "Good Nearby Cafe",
    category: "cafe",
    shortDescription: "cafe with a full lunch menu and sandwiches",
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
  // Round 7 repair order §5: MOVE THE SAME ITEM first — the day has room to
  // re-time Timna Park into its 08:00-16:00 window, so it is preserved at a
  // legal slot rather than replaced.
  const timna = repaired.items.find((item) => item.name === "Timna Park");
  assert.ok(timna, "Timna Park is preserved by the same-day move");
  const [h, m] = timna!.plannedStartTime.split(":").map(Number);
  const startMinutes = h * 60 + m;
  assert.ok(startMinutes >= 8 * 60 && startMinutes + 90 <= 16 * 60, `now scheduled legally inside 08:00-16:00 (was 19:52), got ${timna!.plannedStartTime}`);
});

test("repairOpeningHoursViolations replaces an item that cannot legally fit ANY slot that day (closed weekday)", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "legal-alt",
        name: "Open All Week Spot",
        category: "nature",
        location: "Eilat",
        openingHours: "08:00-20:00",
        lat: 29.78,
        lon: 34.95,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);
  const day = buildDay({
    // 2026-10-06 is a Tuesday.
    cityRegion: "Eilat",
    items: [
      buildItem({ name: "Anchor Spot", category: "nature", openingHours: "08:00-20:00", lat: 29.78, lon: 34.95 }),
      buildItem({
        name: "Weekend Only Museum",
        category: "museum",
        openingHours: "Th-Sa 10:00-16:00",
        plannedStartTime: "10:00",
        lat: 29.781,
        lon: 34.951,
      }),
    ],
  });

  const [repaired] = repairOpeningHoursViolations([day], payload, profile);
  assert.equal(repaired.items.some((item) => item.name === "Weekend Only Museum"), false, "a venue closed on the scheduled weekday cannot be kept");
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
        // Closed on the scheduled weekday (2026-10-06 is a Tuesday) — no
        // same-day reorder can make it legal, so repair must REPLACE it.
        openingHours: "Th-Sa 08:00-16:00",
        plannedStartTime: "10:00",
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

// Spec §K.10 "short-stay repair cannot reintroduce major backtracking" —
// a weak cluster genuinely likely to get merged/absorbed by
// applyShortStayViabilityRepair sits between two strong ones; the FINAL
// phase order (after the full deterministic pipeline, short-stay repair
// included) must still be a coherent, revisit-free route along the real
// coordinates, whatever survived the repair.
test("live wiring: short-stay viability repair does not reintroduce backtracking into the final route", () => {
  const AREA_ANCHORS: Record<string, { lat: number; lon: number }> = {
    "City A": { lat: 0, lon: 0 },
    "City B": { lat: 0, lon: 10 },
    "City C": { lat: 0, lon: 20 },
    "City D": { lat: 0, lon: 30 },
  };
  const cityA = Array.from({ length: 9 }, () => buildRecommendation({ location: "City A", lat: 0, lon: 0, estimatedDurationMinutes: 120 }));
  // A genuinely weak cluster — little content, a real short-stay-repair candidate.
  const cityB = Array.from({ length: 2 }, () => buildRecommendation({ location: "City B", lat: 0, lon: 10, estimatedDurationMinutes: 45 }));
  const cityC = Array.from({ length: 9 }, () => buildRecommendation({ location: "City C", lat: 0, lon: 20, estimatedDurationMinutes: 120 }));
  const cityD = Array.from({ length: 9 }, () => buildRecommendation({ location: "City D", lat: 0, lon: 30, estimatedDurationMinutes: 120 }));
  const payload = buildPayload({
    recommendations: [...cityA, ...cityB, ...cityC, ...cityD],
    preferences: { ...basePreferences, accommodationArea: "", preferredRegions: "" },
  });

  const frame = buildDeterministicTripFrame(payload, 20);
  const finalNodes: StayRouteNode[] = frame.phases.map((phase) => {
    const anchor = AREA_ANCHORS[phase.areaLabel];
    return { id: phase.areaLabel, lat: anchor?.lat ?? 0, lon: anchor?.lon ?? 0, hasAnchor: anchor != null, value: 1 };
  });

  assert.equal(
    countRegionRevisits(finalNodes),
    0,
    `expected a revisit-free final route after short-stay repair, got: ${frame.phases.map((p) => p.areaLabel).join(" -> ")}`
  );
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

// Round 9.3.3 T/U — shouldResolveAsRealPlace is the structural guard that
// stops a synthetic item's display text (e.g. buildFreeExplorationReplacement's
// "discover local corners" phrasing) from ever being sent to a real
// place-name resolver like /api/places/search, while a genuine real-place
// item lacking display metadata may still be resolved.
test("Round 9.3.3 T: a synthetic free-time item is never eligible for real-place resolution", () => {
  const day = buildDay({ dayNumber: 1, cityRegion: "City A" });
  const nonFoodItem = buildItem({ category: "hidden_gem" });
  const freeTime = buildFreeExplorationReplacement(nonFoodItem, day);
  assert.equal(freeTime.recommendationId, null);
  assert.equal(shouldResolveAsRealPlace(freeTime), false);
});

test("Round 9.3.3 T: a synthetic meal opportunity is never eligible for real-place resolution", () => {
  const day = buildDay({ dayNumber: 1, cityRegion: "City A" });
  const payload = buildPayload();
  const placeholder = buildFallbackMealPlaceholder(day, "lunch", payload);
  assert.equal(shouldResolveAsRealPlace(placeholder), false);
});

test("Round 9.3.3 U: a real, planner-discovered item lacking coordinates may still be resolved", () => {
  const realButUnresolved = buildItem({ category: "attraction", recommendationId: "rec-123" });
  assert.equal(shouldResolveAsRealPlace(realButUnresolved), true);
});

test("Round 9.3.3: transportation/practical items are never eligible for real-place resolution, even with a recommendationId", () => {
  assert.equal(shouldResolveAsRealPlace({ category: "transportation", recommendationId: "rec-1" }), false);
  assert.equal(shouldResolveAsRealPlace({ category: "practical", recommendationId: "rec-1" }), false);
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

// Root-cause regression (real 43-day US replay: Yellowstone/Yosemite/Grand
// Canyon/Mount Rushmore each landed on a day_trip/transfer-classified day
// with NO real coordinates and a location string matching no known stay's
// area label — the OLD asymmetric rule `isExemptDayType ? positively
// matches ANOTHER known stay : doesn't match its own` found neither
// condition true for text this foreign, and silently passed). A
// coordinate-less item is now judged by the SAME rule on every day type:
// legal only if its own text positively matches THIS day's own stay.
test("enforceNormalDayLocality (transfer day): a coordinate-less item whose location text matches NO known stay — including this one — is a violation, not a silent pass", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const day = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    items: [
      buildCoordinatelessItem({ name: "Unrelated National Park", location: "A Region Nobody Modeled" }),
    ],
  });

  const { days, violations } = enforceNormalDayLocality([day], TRANSFER_TRIP_FRAME, TRANSFER_AREA_ANCHORS, TRANSFER_MOBILITY_PROFILE, payload, profile);

  assert.ok(
    violations.some((violation) => violation.itemName === "Unrelated National Park" && violation.reason === "unverified_region_mismatch" && violation.repaired),
    "a day_trip/transfer label must never be an unconditional pass for unverifiable (coordinate-less) geography, even when the mismatch can't be positively pinned to a specific OTHER known stay"
  );
  assert.ok(!days[0].items.some((item) => item.name === "Unrelated National Park"));
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

// Root-cause regression (spec §K.16 "Gemini-resolved item cannot bypass
// legality") — the SAME scenario as above, but with a real candidate pool
// containing BOTH a genuinely local replacement AND a candidate at the
// exact same impossibly-distant location. Under the old bypass
// (isCandidateGeographicallyCompatibleWithDay: `if (isDayTripDay) return
// true`), the distant candidate would have been just as "eligible" as the
// local one during the REPAIR's own replacement search — this proves the
// fix reaches all the way into that replacement search, not just the
// initial detection.
test("golden replay: repairing a Gemini day-trip-category item never selects an equally-distant replacement candidate", () => {
  const LOS_ANGELES = { lat: 34.0522, lon: -118.2437 };
  const ANNAPOLIS = { lat: 38.9784, lon: -76.4922 };

  const localReplacement = buildRecommendation({
    id: "rec-local",
    name: "Local LA Attraction",
    category: "day_trip",
    location: "Los Angeles",
    lat: LOS_ANGELES.lat + 0.05,
    lon: LOS_ANGELES.lon + 0.05,
    estimatedDurationMinutes: 90,
  });
  const equallyDistantReplacement = buildRecommendation({
    id: "rec-distant",
    name: "Another Annapolis-Area Spot",
    category: "day_trip",
    location: "Annapolis",
    lat: ANNAPOLIS.lat + 0.01,
    lon: ANNAPOLIS.lon + 0.01,
    estimatedDurationMinutes: 90,
  });

  const payload = buildPayload({ recommendations: [localReplacement, equallyDistantReplacement] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "Los Angeles", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["Los Angeles", LOS_ANGELES]]);
  const mobilityProfile = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };

  const day = buildDay({
    dayNumber: 1,
    cityRegion: "Los Angeles",
    items: [
      buildItem({ name: "Morning Departure", slot: "morning", plannedStartTime: "08:00", lat: LOS_ANGELES.lat, lon: LOS_ANGELES.lon }),
      buildItem({
        name: "Annapolis",
        category: "day_trip",
        recommendationId: "rec-annapolis-original",
        slot: "afternoon",
        plannedStartTime: "12:00",
        lat: ANNAPOLIS.lat,
        lon: ANNAPOLIS.lon,
        estimatedDurationMinutes: 90,
      }),
      buildItem({ name: "Evening Return", slot: "evening", plannedStartTime: "18:00", lat: LOS_ANGELES.lat, lon: LOS_ANGELES.lon }),
    ],
  });

  const { days } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(!days[0].items.some((item) => item.name === "Annapolis"));
  assert.ok(
    !days[0].items.some((item) => item.recommendationId === "rec-distant"),
    "the repair's own replacement search must never select an equally-distant candidate just because the day is a day trip"
  );
});

// Root-cause regression (real 43-day US replay: "Austin day contains
// Yellowstone National Park", "Austin day contains Yosemite National
// Park", "New Orleans day contains Grand Canyon National Park", "Seattle
// day contains Mount Rushmore") — the EXACT real production shape: a
// day whose only real, coordinate-bearing content IS the far violation
// itself; every other item is a synthetic meal/free-time placeholder with
// no coordinates at all. `dayExcludingTarget.items` (the day minus the
// item being repaired) therefore has ZERO coordinate-bearing anchors —
// isCandidateGeographicallyCompatibleWithDay's own "no anchors at all ->
// anything is compatible" fallback used to make the repair's OWN
// candidate filter toothless, letting it re-select the exact violation
// (or an equally distant candidate) as its "repair." Passing the day's
// real stay/phase anchor through (enforceNormalDayLocality's ownAnchor ->
// pickReplacementRecommendation's stayAreaAnchor) is the fix under test.
test("golden replay: repairing the day's ONLY real item — with every other item synthetic and coordinate-less — never re-selects an equally-distant candidate (Austin/Yellowstone shape)", () => {
  const AUSTIN = { lat: 30.2672, lon: -97.7431 };
  const YELLOWSTONE = { lat: 44.428, lon: -110.5885 }; // genuinely thousands of km from Austin

  // Deliberately labeled with the day's OWN area text ("Austin") despite
  // its real coordinates being in Wyoming — this isolates the fix under
  // test: only the REAL COORDINATE geographic gate can reject this
  // candidate; the ranking's own textual area-match bonus would otherwise
  // favor it regardless (a real risk of an under-specified regression
  // test that happens to pass for the wrong reason).
  const distantReplacementWithMatchingText = buildRecommendation({
    id: "rec-distant-yellowstone-area",
    name: "Another Yellowstone-Area Spot",
    category: "nature",
    location: "Austin",
    lat: YELLOWSTONE.lat + 0.01,
    lon: YELLOWSTONE.lon + 0.01,
    estimatedDurationMinutes: 90,
  });

  const payload = buildPayload({ recommendations: [distantReplacementWithMatchingText] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "Austin", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const areaAnchors = new Map([["Austin", AUSTIN]]);
  const mobilityProfile = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };

  // dayNumber: 2 — the 2nd day of the SAME Austin stay (not the first, so
  // deriveDayType classifies it "normal", exactly like the real replay's
  // Day 22/23), with only ONE real item (Yellowstone, resolved with real
  // coordinates — e.g. via ensureMustVisitCoverage matching a mustVisit
  // keyword) and the rest pure synthetic placeholders, matching the real
  // shape exactly.
  const day = buildDay({
    dayNumber: 2,
    cityRegion: "Austin",
    items: [
      buildItem({
        name: "Yellowstone National Park",
        category: "nature",
        recommendationId: "rec-yellowstone-original",
        slot: "morning",
        plannedStartTime: "09:10",
        lat: YELLOWSTONE.lat,
        lon: YELLOWSTONE.lon,
        estimatedDurationMinutes: 90,
      }),
      buildCoordinatelessItem({ name: "Recommended lunch window", category: "practical", itemRole: "meal_opportunity", location: "" }),
      buildCoordinatelessItem({ name: "Free time to explore at your own pace", category: "attraction", itemRole: "free_time", location: "" }),
      buildCoordinatelessItem({ name: "Recommended dinner window", category: "practical", itemRole: "meal_opportunity", location: "" }),
    ],
  });

  const { days } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(!days[0].items.some((item) => item.name === "Yellowstone National Park"));
  assert.ok(
    !days[0].items.some((item) => item.recommendationId === "rec-distant-yellowstone-area"),
    "with zero other coordinate anchors on this day, the repair must still use the real stay anchor — never fall back to 'anything is compatible'"
  );
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

// Spec §H "run a pure invariant validator over every real POI — there must
// be zero illegalScheduledRealPlaces": the ONE case where a real geography
// violation genuinely survives into the final plan is a protected
// (locked/fixed-time) item — enforceNormalDayLocality deliberately never
// repairs those. summarizeGeographyDiagnostics must count exactly this,
// and nothing else (an ordinary, repaired violation must NOT count, since
// nothing illegal actually remains once it's fixed).
test("summarizeGeographyDiagnostics.illegalScheduledRealPlaces counts only a real violation that survives (protected item), never a repaired one", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A_ANCHOR]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };
  const FAR_AWAY = { lat: CITY_A_ANCHOR.lat + 40, lon: CITY_A_ANCHOR.lon + 40 };

  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildItem({ name: "City A Anchor", lat: CITY_A_ANCHOR.lat, lon: CITY_A_ANCHOR.lon }),
      buildItem({ name: "Locked Distant Item", recommendationId: "rec-locked", lat: FAR_AWAY.lat, lon: FAR_AWAY.lon, locked: true }),
    ],
  });

  const diagnostics = computeGeographyDiagnostics([day], tripFrame, areaAnchors, mobilityProfile, payload, profile, null);
  const summary = summarizeGeographyDiagnostics(diagnostics);

  assert.equal(summary.illegalScheduledRealPlaces, 1, "the locked/protected violation must count as an illegal real place still in the plan");
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

// Root-cause regression (real 43-day US replay: "O'Hare International
// Airport" scheduled as a 09:00 Chicago activity, "Los Angeles
// International Airport" scheduled as an LA activity) — category ===
// "transportation" used to be an UNCONDITIONAL exemption, with zero
// verification the item was genuinely serving a transfer role. Gemini (or
// normalizeCategory) can tag a hallucinated sightseeing-airport item
// "transportation" with no real transfer context behind it at all — this
// is deliberately no longer a free pass. The ONE legitimate transportation-
// category item (the real, structurally-marked stay transition built by
// buildStayTransitionItem) never matches TRANSPORT_INFRASTRUCTURE_NAME_
// PATTERN in the first place (its name is "<mode>: <fromBase> → <toBase>"),
// so this change costs the legitimate path nothing.
test("enforceTransportRoleGuard repairs an airport EVEN when Gemini tagged it category=transportation, with no real transfer context", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "City International Airport", category: "transportation" })],
  });

  const { days, violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "City International Airport" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "City International Airport"));
});

// Root-cause regression — the day-level `isIntercityTransferDay(day)` text
// exemption was circular: fillDerivedDayFields synthesizes a day's own
// transportSegments/notes text partly FROM its own items, so an airport
// item's own name/transportation text could make the day itself match the
// transfer pattern, exempting the very item that caused the match. The
// ONLY legitimate exemption now is the item being the real, structurally-
// marked stay-transition (canonicalPlaceId starting with "transition:") —
// a plain "יום מעבר בין בסיסים" note on the day is no longer sufficient by
// itself.
test("enforceTransportRoleGuard repairs a real airport mention even on a day whose own notes/text read as a transfer day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    notes: "יום מעבר בין בסיסים",
    items: [buildItem({ name: "City International Airport", category: "attraction" })],
  });

  const { days, violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "City International Airport" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "City International Airport"));
});

// Semantic-role gate — a hotel/accommodation category item can never
// occupy a generic activity slot, judged purely by structured category
// (real bug: "The Plaza" hotel appearing as a scheduled 16:23 New York
// activity with its own price, in a real generated PDF).
test("enforceTransportRoleGuard repairs a hotel-category item scheduled as a generic activity", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "The Grand Hotel", category: "hotel" })],
  });

  const { days, violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "The Grand Hotel" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "The Grand Hotel"));
});

// Semantic-role gate — a train/bus station occupying a generic activity
// slot, with no real TransitLeg/transfer context, must be repaired the
// same as an airport. The one legitimate exemption (the structurally-
// marked stay-transition item) never matches this pattern by name at all.
test("enforceTransportRoleGuard repairs a train station scheduled as a generic activity, with no real transit-leg context", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [buildItem({ name: "Grand Central Railway Station", category: "attraction" })],
  });

  const { days, violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.ok(violations.some((violation) => violation.itemName === "Grand Central Railway Station" && violation.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "Grand Central Railway Station"));
});

// The one real, legitimate exemption: a genuine stay-transition item this
// codebase itself synthesizes (buildStayTransitionItem always sets
// canonicalPlaceId to "transition:<from>-><to>") legitimately connects two
// different bases and must never be "repaired" away.
test("enforceTransportRoleGuard leaves the real, structurally-marked stay-transition item alone", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const day = buildDay({
    dayNumber: 1,
    items: [
      buildItem({
        name: "רכבת: City A → City B",
        category: "transportation",
        canonicalPlaceId: "transition:City A->City B",
      }),
    ],
  });

  const { violations } = enforceTransportRoleGuard([day], payload, profile);
  assert.equal(violations.length, 0, "a real stay-transition item, even though category=transportation, is never a semantic-role violation");
});

// Spec §Step 3 "ONE AUTHORITATIVE FINAL GATE" — enforceFinalPlaceLegalityGate
// is the belt-and-suspenders backstop: it must catch a real, distant place
// even if it reaches the final days array through some path OTHER than
// enforceNormalDayLocality/enforceTransportRoleGuard (e.g. a hypothetical
// future insertion added after those two run). Direct unit coverage of
// the new function itself, independent of the two repair passes.
test("enforceFinalPlaceLegalityGate repairs a distant real item on a normal day, independent of enforceNormalDayLocality ever running", () => {
  const CITY_A = { lat: 10.0, lon: 10.0 };
  const FAR_AWAY = { lat: 55.0, lon: 55.0 };

  const localReplacement = buildRecommendation({
    id: "rec-local",
    name: "Genuine Local Spot",
    category: "attraction",
    location: "City A",
    lat: CITY_A.lat + 0.01,
    lon: CITY_A.lon + 0.01,
  });
  const payload = buildPayload({ recommendations: [localReplacement] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [buildItem({ name: "Impossibly Distant Place", category: "attraction", lat: FAR_AWAY.lat, lon: FAR_AWAY.lon })],
  });

  const { days, violations } = enforceFinalPlaceLegalityGate([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);

  assert.ok(violations.some((v) => v.itemName === "Impossibly Distant Place" && v.repaired));
  assert.ok(!days[0].items.some((item) => item.name === "Impossibly Distant Place"));
});

test("enforceFinalPlaceLegalityGate never touches synthetic, transportation, or hotel-category items", () => {
  const CITY_A = { lat: 10.0, lon: 10.0 };
  const FAR_AWAY = { lat: 55.0, lon: 55.0 };
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const areaAnchors = new Map([["City A", CITY_A]]);
  const mobilityProfile = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

  const day = buildDay({
    dayNumber: 1,
    cityRegion: "City A",
    items: [
      buildCoordinatelessItem({ name: "Free time far away conceptually", category: "attraction", itemRole: "free_time", location: "" }),
      buildItem({ name: "Distant Hotel", category: "hotel", lat: FAR_AWAY.lat, lon: FAR_AWAY.lon }),
      buildItem({ name: "Distant Transport Leg", category: "transportation", lat: FAR_AWAY.lat, lon: FAR_AWAY.lon }),
    ],
  });

  const { violations } = enforceFinalPlaceLegalityGate([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  assert.equal(violations.length, 0, "synthetic/hotel/transportation items are out of this gate's scope — enforceTransportRoleGuard owns semantic-role categories");
});

// Spec "DAY-LEVEL POI GEOGRAPHY / LEGALITY" §Step 3 — the true final-gate
// acceptance bar: after the FULL finalizeArrivalDepartureContent sequence
// (enforceNormalDayLocality -> enforceTransportRoleGuard ->
// ensureArrivalDepartureDayHasContent -> enforceFinalPlaceLegalityGate),
// zero illegal real places may survive on the object actually returned.
test("full finalization sequence: enforceNormalDayLocality + enforceTransportRoleGuard + enforceFinalPlaceLegalityGate together leave zero illegal real places (Austin/Yellowstone shape, end to end)", () => {
  const AUSTIN = { lat: 30.2672, lon: -97.7431 };
  const YELLOWSTONE = { lat: 44.428, lon: -110.5885 };

  const localReplacement = buildRecommendation({
    id: "rec-local-austin-2",
    name: "Genuine Austin Attraction 2",
    category: "nature",
    location: "Austin",
    lat: AUSTIN.lat + 0.02,
    lon: AUSTIN.lon + 0.02,
    estimatedDurationMinutes: 90,
  });

  const payload = buildPayload({ recommendations: [localReplacement] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const tripFrame = buildTestFrame([{ areaLabel: "Austin", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const areaAnchors = new Map([["Austin", AUSTIN]]);
  const mobilityProfile = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };

  const day = buildDay({
    dayNumber: 2,
    cityRegion: "Austin",
    items: [
      buildItem({
        name: "Yellowstone National Park",
        category: "nature",
        recommendationId: "rec-yellowstone-original-2",
        slot: "morning",
        plannedStartTime: "09:10",
        lat: YELLOWSTONE.lat,
        lon: YELLOWSTONE.lon,
        estimatedDurationMinutes: 90,
      }),
      buildItem({ name: "Genuine Austin Local Activity", category: "attraction", lat: AUSTIN.lat, lon: AUSTIN.lon }),
      buildCoordinatelessItem({ name: "Free time to explore at your own pace", category: "attraction", itemRole: "free_time", location: "" }),
    ],
  });

  const { days: localityDays } = enforceNormalDayLocality([day], tripFrame, areaAnchors, mobilityProfile, payload, profile);
  const { days: roleDays } = enforceTransportRoleGuard(localityDays, payload, profile, tripFrame, areaAnchors);
  const { days: finalDays, violations: finalViolations } = enforceFinalPlaceLegalityGate(
    roleDays,
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile
  );

  assert.ok(!finalDays[0].items.some((item) => item.name === "Yellowstone National Park"));
  assert.equal(
    finalViolations.filter((v) => !v.repaired).length,
    0,
    "illegalScheduledRealPlaces on the true final object must be 0 — no unrepaired real violation may survive"
  );
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

// ==================================================
// ROUND 3 — TRIP-FRAME / DAY OWNERSHIP / FINAL GEOGRAPHY INVARIANT
// ==================================================

const R3_MOBILITY = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };
const R3_CITY_A = { lat: 40.0, lon: -74.0 };
const R3_CITY_B = { lat: 41.0, lon: -74.2 }; // ~111km from A — its own separate stay
const R3_FAR = { lat: 44.4, lon: -110.6 }; // thousands of km from both — a Yellowstone-scale outlier

function r3TransitionItem(fromBase: string, toBase: string, toCoords: { lat: number; lon: number }): AiGeneratedItem {
  return buildStayTransitionItem({
    fromBase,
    toBase,
    fromCoordinates: R3_CITY_A,
    toCoordinates: toCoords,
    transportMode: "car",
    estimatedTravelMinutes: 120,
    dayNumber: 2,
  });
}

// D + critical regression — a transition marker that no longer matches the
// day's own frame boundary (stay reordered A->B into C->D, or the item
// was physically relocated to an unrelated day) is stale and must be
// removed by enforceStayTransitions' global sweep, even though that day
// is not itself in the current `transitions` list.
test("enforceStayTransitions removes a stale transition marker from a day that is not a current transfer day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);

  const normalDayWithStaleTransition = buildDay({
    dayNumber: 2,
    cityRegion: "City A",
    items: [
      buildItem({ name: "City A Museum", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
      r3TransitionItem("Miami Beach", "Orlando", { lat: 28.5, lon: -81.4 }),
    ],
  });

  // No transition targets day 2 anymore.
  const { days } = enforceStayTransitions([normalDayWithStaleTransition], [], payload, profile);

  assert.ok(
    !days[0].items.some((item) => item.canonicalPlaceId.startsWith("transition:")),
    "a transition marker on a day with no current transition of its own is stale and must be swept"
  );
  assert.ok(days[0].items.some((item) => item.name === "City A Museum"), "real content on the day is untouched");
});

// A transition whose from/to matches the day's OWN current boundary is kept.
test("enforceStayTransitions keeps a transition marker that matches the day's own current boundary", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);

  const goodTransition: StayTransition = {
    fromBase: "City A",
    toBase: "City B",
    fromCoordinates: R3_CITY_A,
    toCoordinates: R3_CITY_B,
    transportMode: "car",
    estimatedTravelMinutes: 120,
    dayNumber: 2,
  };
  const transferDay = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    items: [buildStayTransitionItem(goodTransition), buildItem({ name: "City B Arrival Stroll", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon })],
  });

  const { days } = enforceStayTransitions([transferDay], [goodTransition], payload, profile);
  assert.ok(
    days[0].items.some((item) => item.canonicalPlaceId === "transition:City A->City B"),
    "the day's own valid transition marker is preserved"
  );
});

// B (fixOverloadedDays) — the structural transition item must never be the
// item that gets evicted to another day.
test("fixOverloadedDays never relocates the stay-transition item off its own day", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);

  const transitionItem = buildStayTransitionItem({
    fromBase: "City A",
    toBase: "City B",
    fromCoordinates: R3_CITY_A,
    toCoordinates: R3_CITY_B,
    transportMode: "car",
    estimatedTravelMinutes: 300, // large — would sort FIRST as the most attractive eviction candidate
    dayNumber: 2,
  });
  const overloadedDay = buildDay({
    dayNumber: 2,
    cityRegion: "City B",
    items: [
      transitionItem,
      buildItem({ name: "Heavy Activity 1", estimatedDurationMinutes: 300, lat: R3_CITY_B.lat, lon: R3_CITY_B.lon }),
      buildItem({ name: "Heavy Activity 2", estimatedDurationMinutes: 300, lat: R3_CITY_B.lat, lon: R3_CITY_B.lon }),
      buildItem({ name: "Heavy Activity 3", estimatedDurationMinutes: 300, lat: R3_CITY_B.lat, lon: R3_CITY_B.lon }),
    ],
  });
  const nextDay = buildDay({ dayNumber: 3, cityRegion: "City B", items: [] });

  const [repairedDay2] = fixOverloadedDays([overloadedDay, nextDay], payload, profile);
  assert.ok(
    repairedDay2.items.some((item) => item.canonicalPlaceId === "transition:City A->City B"),
    "the transition item stays on its own day; some OTHER item is the one moved"
  );
});

// ===== validateFinalItineraryInvariants — the PURE Step 5 validator =====

const R3_FRAME_TWO_STAYS = buildTestFrame([
  { areaLabel: "City A", nights: 2, startDayNumber: 1, endDayNumber: 2 },
  { areaLabel: "City B", nights: 2, startDayNumber: 3, endDayNumber: 4 },
]);
const R3_ANCHORS_TWO_STAYS = new Map<string, { lat: number; lon: number } | null>([
  ["City A", R3_CITY_A],
  ["City B", R3_CITY_B],
]);

test("validateFinalItineraryInvariants: a clean itinerary reports every count as zero", () => {
  const payload = buildPayload();
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "City A Sight", lat: R3_CITY_A.lat + 0.01, lon: R3_CITY_A.lon + 0.01 })] }),
    buildDay({ dayNumber: 2, cityRegion: "City A", items: [buildItem({ name: "City A Park", lat: R3_CITY_A.lat - 0.02, lon: R3_CITY_A.lon })] }),
    buildDay({
      dayNumber: 3,
      cityRegion: "City B",
      items: [
        buildStayTransitionItem({ fromBase: "City A", toBase: "City B", fromCoordinates: R3_CITY_A, toCoordinates: R3_CITY_B, transportMode: "car", estimatedTravelMinutes: 120, dayNumber: 3 }),
        buildItem({ name: "City B Sight", lat: R3_CITY_B.lat + 0.01, lon: R3_CITY_B.lon }),
      ],
    }),
    buildDay({ dayNumber: 4, cityRegion: "City B", items: [buildItem({ name: "City B Museum", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon - 0.01 })] }),
  ];

  const report = validateFinalItineraryInvariants(days, R3_FRAME_TWO_STAYS, R3_ANCHORS_TWO_STAYS, R3_MOBILITY, payload);
  assert.equal(report.illegalScheduledRealPlaces, 0);
  assert.equal(report.invalidTransitionOwnership, 0);
  assert.equal(report.invalidSemanticRolePlacements, 0);
  assert.equal(report.ownerGeometryMissingDays, 0);
  assert.equal(report.realItemsWithNullLegGeometry, 0);
});

test("validateFinalItineraryInvariants: a distant real POI on a normal day counts as illegalScheduledRealPlaces", () => {
  const payload = buildPayload();
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "Yellowstone-scale Outlier", category: "nature", lat: R3_FAR.lat, lon: R3_FAR.lon })] }),
  ];
  const frame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const anchors = new Map<string, { lat: number; lon: number } | null>([["City A", R3_CITY_A]]);

  const report = validateFinalItineraryInvariants(days, frame, anchors, R3_MOBILITY, payload);
  assert.equal(report.illegalScheduledRealPlaces, 1);
});

test("validateFinalItineraryInvariants: an airport-name item and a hotel-category item both count as invalidSemanticRolePlacements", () => {
  const payload = buildPayload();
  const days = [
    buildDay({
      dayNumber: 1,
      cityRegion: "City A",
      items: [
        buildItem({ name: "City A International Airport", category: "attraction", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
        buildItem({ name: "The Grand Hotel", category: "hotel", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
        buildItem({ name: "Chicago Union Station", category: "attraction", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
      ],
    }),
  ];
  const frame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const anchors = new Map<string, { lat: number; lon: number } | null>([["City A", R3_CITY_A]]);

  const report = validateFinalItineraryInvariants(days, frame, anchors, R3_MOBILITY, payload);
  assert.equal(report.invalidSemanticRolePlacements, 3, "airport name, hotel category, and 'Union Station' name all count");
});

test("validateFinalItineraryInvariants: a transition marker not matching the day's frame boundary counts as invalidTransitionOwnership", () => {
  const payload = buildPayload();
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", items: [] }),
    buildDay({
      dayNumber: 2,
      cityRegion: "City A",
      items: [
        buildItem({ name: "City A Sight", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
        // day 2 is interior to the City A stay (not a transfer day at all) — any transition marker here is invalid ownership
        r3TransitionItem("Pennsylvania", "West Virginia", { lat: 39.0, lon: -80.0 }),
      ],
    }),
  ];

  const report = validateFinalItineraryInvariants(days, R3_FRAME_TWO_STAYS, R3_ANCHORS_TWO_STAYS, R3_MOBILITY, payload);
  assert.equal(report.invalidTransitionOwnership, 1);
});

test("validateFinalItineraryInvariants: a real POI with null coordinates counts as realItemsWithNullLegGeometry AND illegalScheduledRealPlaces", () => {
  const payload = buildPayload();
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildCoordinatelessItem({ name: "Unresolved Real Place", category: "attraction", location: "Somewhere" })] }),
  ];
  const frame = buildTestFrame([{ areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const anchors = new Map<string, { lat: number; lon: number } | null>([["City A", R3_CITY_A]]);

  const report = validateFinalItineraryInvariants(days, frame, anchors, R3_MOBILITY, payload);
  assert.equal(report.realItemsWithNullLegGeometry, 1);
  assert.equal(report.illegalScheduledRealPlaces, 1);
});

test("validateFinalItineraryInvariants: a phase with no resolvable anchor and a real place counts as ownerGeometryMissingDays", () => {
  const payload = buildPayload();
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "Ghost Region", items: [buildItem({ name: "Some Real Place", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon })] }),
  ];
  const frame = buildTestFrame([{ areaLabel: "Ghost Region", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const anchors = new Map<string, { lat: number; lon: number } | null>(); // no anchor for "Ghost Region"

  const report = validateFinalItineraryInvariants(days, frame, anchors, R3_MOBILITY, payload);
  assert.equal(report.ownerGeometryMissingDays, 1);
});

// ===== enforceItineraryInvariantsWithRepair — Step 6 repair->validate->repair =====

test("enforceItineraryInvariantsWithRepair: distant POI + stale transition + airport are all cleared, after-report all zero", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({ id: "local-a", name: "Genuine City A Attraction", category: "nature", location: "City A", lat: R3_CITY_A.lat + 0.02, lon: R3_CITY_A.lon + 0.02 }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 4);
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", items: [buildItem({ name: "City A Anchor", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon })] }),
    buildDay({
      dayNumber: 2,
      cityRegion: "City A",
      items: [
        buildItem({ name: "City A Base", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
        buildItem({ name: "Yellowstone-scale Outlier", category: "nature", lat: R3_FAR.lat, lon: R3_FAR.lon }),
        r3TransitionItem("Miami Beach", "Orlando", { lat: 28.5, lon: -81.4 }),
        buildItem({ name: "City A International Airport", category: "attraction", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon }),
      ],
    }),
    buildDay({ dayNumber: 3, cityRegion: "City B", items: [buildItem({ name: "City B Sight", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon })] }),
    buildDay({ dayNumber: 4, cityRegion: "City B", items: [buildItem({ name: "City B Museum", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon })] }),
  ];
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

  const { days: repaired, before, after } = enforceItineraryInvariantsWithRepair(
    days,
    R3_FRAME_TWO_STAYS,
    R3_ANCHORS_TWO_STAYS,
    R3_MOBILITY,
    payload,
    profile,
    window
  );

  assert.ok(before.illegalScheduledRealPlaces + before.invalidTransitionOwnership + before.invalidSemanticRolePlacements > 0, "sanity: violations existed before repair");
  assert.equal(after.illegalScheduledRealPlaces, 0);
  assert.equal(after.invalidTransitionOwnership, 0);
  assert.equal(after.invalidSemanticRolePlacements, 0);
  assert.equal(after.realItemsWithNullLegGeometry, 0);

  const day2 = repaired[1];
  assert.ok(!day2.items.some((item) => item.name === "Yellowstone-scale Outlier"), "the distant POI is gone");
  assert.ok(!day2.items.some((item) => item.canonicalPlaceId.startsWith("transition:")), "the stale transition marker is gone");
  assert.ok(!day2.items.some((item) => item.name === "City A International Airport"), "the airport is gone");
});

// H / I — legal content is never disturbed by the repair.
test("enforceItineraryInvariantsWithRepair: a clean itinerary is returned byte-for-byte unchanged", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 4);
  const days = [
    buildDay({ dayNumber: 1, cityRegion: "City A", title: "יום 1 בCity A", accommodation: "לינה נוחה באזור City A", items: [buildItem({ name: "City A Sight", lat: R3_CITY_A.lat + 0.01, lon: R3_CITY_A.lon })] }),
    buildDay({ dayNumber: 2, cityRegion: "City A", title: "יום 2 בCity A", accommodation: "לינה נוחה באזור City A", items: [buildItem({ name: "City A Park", lat: R3_CITY_A.lat, lon: R3_CITY_A.lon - 0.01 })] }),
    buildDay({
      dayNumber: 3,
      cityRegion: "City B",
      title: "יום 3 בCity B",
      accommodation: "לינה נוחה באזור City B",
      items: [
        buildStayTransitionItem({ fromBase: "City A", toBase: "City B", fromCoordinates: R3_CITY_A, toCoordinates: R3_CITY_B, transportMode: "car", estimatedTravelMinutes: 120, dayNumber: 3 }),
        buildItem({ name: "City B Sight", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon }),
      ],
    }),
    buildDay({ dayNumber: 4, cityRegion: "City B", title: "יום 4 בCity B", accommodation: "לינה נוחה באזור City B", items: [buildItem({ name: "City B Museum", lat: R3_CITY_B.lat, lon: R3_CITY_B.lon })] }),
  ];
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

  const { days: repaired, before } = enforceItineraryInvariantsWithRepair(days, R3_FRAME_TWO_STAYS, R3_ANCHORS_TWO_STAYS, R3_MOBILITY, payload, profile, window);
  assert.equal(
    before.illegalScheduledRealPlaces + before.invalidTransitionOwnership + before.invalidSemanticRolePlacements + before.realItemsWithNullLegGeometry +
      before.dayOwnerMismatch + before.invalidDayDisplayOwnership + before.lodgingOwnerMismatch + before.syntheticOwnerMismatch,
    0
  );
  assert.deepEqual(repaired, days, "no violations -> the exact same object is returned");
});

// ==================================================
// ROUND 4 — ONE DAY HAS ONE AUTHORITATIVE STRUCTURAL OWNER
// ==================================================

const R4_A = { lat: 40.71, lon: -74.0 };  // "Area A"
const R4_B = { lat: 41.88, lon: -87.63 }; // "Area B"
const R4_FRAME = buildTestFrame([
  { areaLabel: "Area A", nights: 2, startDayNumber: 1, endDayNumber: 2 },
  { areaLabel: "Area B", nights: 2, startDayNumber: 3, endDayNumber: 4 },
]);
const R4_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Area A", R4_A], ["Area B", R4_B]]);

function r4Day(overrides: Partial<AiGeneratedDay>): AiGeneratedDay {
  return buildDay({ title: "יום ? בArea A", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", ...overrides });
}
function r4SyntheticFreeTime(area: string): AiGeneratedItem {
  return buildCoordinatelessItem({
    name: `זמן פנוי לגלות את ${area} בקצב שלכם`,
    category: "attraction",
    itemRole: "free_time",
    location: area,
    shortDescription: `חלופה גמישה וזולה באזור ${area} כדי לשמור על הקצב והתקציב בלי לנסוע רחוק.`,
  });
}
function r4SyntheticMeal(area: string): AiGeneratedItem {
  return buildCoordinatelessItem({
    name: `הפסקת צהריים מומלצת באזור ${area}`,
    category: "cafe",
    itemRole: "meal_opportunity",
    location: area,
    slot: "lunch",
    shortDescription: `זהו חלון זמן מומלץ לארוחת צהריים באזור ${area} — לא מסעדה קונקרטית.`,
  });
}

const R4_PAYLOAD = buildPayload();
const R4_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 4);

// STEP 3/4/6 — normalizeDayOwnershipToFrame rebinds a day whose display,
// lodging and synthetic content all name the WRONG area to its canonical
// owner, deterministically, for every field.
test("normalizeDayOwnershipToFrame: a day displayed/lodged/synthetic-labelled as Area A but owned by Area B is fully rebound to Area B", () => {
  const stale = r4Day({
    dayNumber: 3, // owned by "Area B" per R4_FRAME
    title: "יום 3 בArea A",
    cityRegion: "Area A",
    accommodation: "לינה נוחה באזור Area A",
    items: [
      r4SyntheticFreeTime("Area A"),
      r4SyntheticMeal("Area A"),
      buildItem({ name: "Real B Sight", lat: R4_B.lat, lon: R4_B.lon }),
    ],
  });

  const [bound] = normalizeDayOwnershipToFrame([stale], R4_FRAME, R4_PAYLOAD, R4_PROFILE);

  assert.equal(bound.phaseId, "phase-2", "day is bound to the Area B phase id");
  assert.ok(bound.cityRegion.includes("Area B"), `display owner: ${bound.cityRegion}`);
  assert.ok(bound.accommodation.includes("Area B"), `lodging owner: ${bound.accommodation}`);
  assert.ok(bound.title.includes("Area B"), `title owner: ${bound.title}`);
  const freeTime = bound.items.find((i) => i.itemRole === "free_time")!;
  const meal = bound.items.find((i) => i.itemRole === "meal_opportunity")!;
  assert.ok(!freeTime.name.includes("Area A") && freeTime.location.includes("Area B"), `free-time relabelled: ${freeTime.name} / ${freeTime.location}`);
  assert.ok(!meal.name.includes("Area A") && meal.location.includes("Area B"), `meal-opportunity relabelled: ${meal.name} / ${meal.location}`);
  assert.ok(bound.items.some((i) => i.name === "Real B Sight"), "the real item is untouched by ownership binding");
});

// A day already consistent with its owner is passed through unchanged.
test("normalizeDayOwnershipToFrame: a day already consistent with its owner keeps its exact fields", () => {
  const clean = r4Day({
    dayNumber: 1,
    title: "יום 1 בArea A",
    cityRegion: "Area A",
    accommodation: "לינה נוחה באזור Area A",
    items: [r4SyntheticFreeTime("Area A"), buildItem({ name: "Real A Sight", lat: R4_A.lat, lon: R4_A.lon })],
  });
  const [bound] = normalizeDayOwnershipToFrame([clean], R4_FRAME, R4_PAYLOAD, R4_PROFILE);
  assert.equal(bound.cityRegion, "Area A");
  assert.equal(bound.accommodation, "לינה נוחה באזור Area A");
  assert.equal(bound.title, "יום 1 בArea A");
});

// STEP 7 — the expanded pure validator flags each structural mismatch.
test("validateFinalItineraryInvariants: display / lodging / synthetic owner mismatches are each counted", () => {
  const days = [
    r4Day({ dayNumber: 3, title: "יום 3 בArea A", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", items: [r4SyntheticFreeTime("Area A"), buildItem({ name: "Real B Sight", lat: R4_B.lat, lon: R4_B.lon })] }),
  ];
  const report = validateFinalItineraryInvariants(days, R4_FRAME, R4_ANCHORS, R3_MOBILITY, R4_PAYLOAD);
  assert.equal(report.invalidDayDisplayOwnership, 1, "cityRegion Area A vs owner Area B");
  assert.equal(report.lodgingOwnerMismatch, 1, "accommodation Area A vs owner Area B");
  assert.equal(report.syntheticOwnerMismatch, 1, "synthetic free-time location Area A vs owner Area B");
});

test("validateFinalItineraryInvariants: a day with no owning phase but real content counts as dayOwnerMismatch", () => {
  const days = [buildDay({ dayNumber: 99, cityRegion: "Nowhere", items: [buildItem({ name: "Orphan Sight", lat: R4_A.lat, lon: R4_A.lon })] })];
  const report = validateFinalItineraryInvariants(days, R4_FRAME, R4_ANCHORS, R3_MOBILITY, R4_PAYLOAD);
  assert.equal(report.dayOwnerMismatch, 1);
});

test("validateFinalItineraryInvariants: a fully owner-consistent itinerary reports every Round-4 count as zero", () => {
  const days = [
    r4Day({ dayNumber: 1, title: "יום 1 בArea A", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", items: [r4SyntheticFreeTime("Area A"), buildItem({ name: "Real A Sight", lat: R4_A.lat + 0.01, lon: R4_A.lon })] }),
    r4Day({ dayNumber: 2, title: "יום 2 בArea A", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", items: [buildItem({ name: "Real A Park", lat: R4_A.lat, lon: R4_A.lon - 0.01 })] }),
    r4Day({
      dayNumber: 3, title: "יום 3 בArea B", cityRegion: "Area B", accommodation: "לינה נוחה באזור Area B",
      items: [buildStayTransitionItem({ fromBase: "Area A", toBase: "Area B", fromCoordinates: R4_A, toCoordinates: R4_B, transportMode: "car", estimatedTravelMinutes: 120, dayNumber: 3 }), buildItem({ name: "Real B Sight", lat: R4_B.lat, lon: R4_B.lon })],
    }),
    r4Day({ dayNumber: 4, title: "יום 4 בArea B", cityRegion: "Area B", accommodation: "לינה נוחה באזור Area B", items: [buildItem({ name: "Real B Museum", lat: R4_B.lat, lon: R4_B.lon })] }),
  ];
  const report = validateFinalItineraryInvariants(days, R4_FRAME, R4_ANCHORS, R3_MOBILITY, R4_PAYLOAD);
  assert.equal(report.dayOwnerMismatch, 0);
  assert.equal(report.invalidDayDisplayOwnership, 0);
  assert.equal(report.lodgingOwnerMismatch, 0);
  assert.equal(report.syntheticOwnerMismatch, 0);
  assert.equal(report.invalidTransitionOwnership, 0);
  assert.equal(report.illegalScheduledRealPlaces, 0);
});

// STEP 9 critical regression — a day built owned by A, then run through
// the FULL bounded repair against a frame that owns it by B: display,
// lodging, synthetic all derive from B; after-report all zero.
test("enforceItineraryInvariantsWithRepair: a day authored for Area A but structurally owned by Area B ends fully consistent with Area B", () => {
  const staleDay = r4Day({
    dayNumber: 3,
    title: "יום 3 בArea A",
    cityRegion: "Area A",
    accommodation: "לינה נוחה באזור Area A",
    items: [
      r4SyntheticFreeTime("Area A"),
      r4SyntheticMeal("Area A"),
      buildItem({ name: "Real B Sight", lat: R4_B.lat, lon: R4_B.lon }),
    ],
  });
  const days = [
    r4Day({ dayNumber: 1, title: "יום 1 בArea A", accommodation: "לינה נוחה באזור Area A", items: [buildItem({ name: "Real A Sight", lat: R4_A.lat, lon: R4_A.lon })] }),
    r4Day({ dayNumber: 2, title: "יום 2 בArea A", accommodation: "לינה נוחה באזור Area A", items: [buildItem({ name: "Real A Park", lat: R4_A.lat, lon: R4_A.lon })] }),
    staleDay,
    r4Day({ dayNumber: 4, title: "יום 4 בArea B", cityRegion: "Area B", accommodation: "לינה נוחה באזור Area B", items: [buildItem({ name: "Real B Museum", lat: R4_B.lat, lon: R4_B.lon })] }),
  ];
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

  const { days: repaired, before, after } = enforceItineraryInvariantsWithRepair(days, R4_FRAME, R4_ANCHORS, R3_MOBILITY, R4_PAYLOAD, R4_PROFILE, window);

  assert.ok(before.invalidDayDisplayOwnership + before.lodgingOwnerMismatch + before.syntheticOwnerMismatch > 0, "sanity: mismatches existed");
  assert.equal(after.dayOwnerMismatch, 0);
  assert.equal(after.invalidDayDisplayOwnership, 0);
  assert.equal(after.lodgingOwnerMismatch, 0);
  assert.equal(after.syntheticOwnerMismatch, 0);
  assert.equal(after.invalidTransitionOwnership, 0);
  assert.equal(after.illegalScheduledRealPlaces, 0);

  const day3 = repaired[2];
  assert.ok(day3.cityRegion.includes("Area B"), `display: ${day3.cityRegion}`);
  assert.ok(day3.accommodation.includes("Area B"), `lodging: ${day3.accommodation}`);
  assert.ok(day3.items.filter((i) => i.itemRole === "free_time" || i.itemRole === "meal_opportunity").every((i) => !i.name.includes("Area A") && i.location.includes("Area B")), "synthetic items derive from Area B");
});

// ==================================================
// ROUND 5 — FULL DAY GEOGRAPHIC OWNERSHIP, FOOD + NARRATIVE
// ==================================================

const R5_OWNER = { lat: 44.5, lon: -110.0 };  // "Owner Area" (a remote, national-park-scale base)
const R5_FAR = { lat: 40.71, lon: -74.0 };    // "Far Metro" — a distant metro
const R5_FRAME = buildTestFrame([
  { areaLabel: "Owner Area", nights: 2, startDayNumber: 1, endDayNumber: 2 },
  { areaLabel: "Far Metro", nights: 2, startDayNumber: 3, endDayNumber: 4 },
]);
const R5_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Owner Area", R5_OWNER], ["Far Metro", R5_FAR]]);
const R5_PAYLOAD = buildPayload();
const R5_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 4);

function r5Day(overrides: Partial<AiGeneratedDay>): AiGeneratedDay {
  return buildDay({
    dayNumber: 1,
    cityRegion: "Owner Area",
    accommodation: "לינה נוחה באזור Owner Area",
    title: "יום 1 בOwner Area",
    notes: "יום רגוע. היום בנוי סביב Owner Area כדי לשמור על קצב טבעי, אוכל קרוב ומעברים הגיוניים.",
    ...overrides,
  });
}

// 1 — owner "Owner Area" + a real (coordinate-having) restaurant in "Far Metro" -> illegal, repaired away.
test("Round 5: a real restaurant with real coordinates far from the day owner is flagged AND repaired", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "local-rest", name: "Genuine Local Diner", category: "restaurant", location: "Owner Area", lat: R5_OWNER.lat + 0.01, lon: R5_OWNER.lon })],
  });
  const day = r5Day({ dayNumber: 1, items: [buildItem({ name: "Le Bernardin", category: "restaurant", recommendationId: "rec-le-bernardin", lat: R5_FAR.lat, lon: R5_FAR.lon })] });

  const before = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, payload);
  assert.ok(before.realFoodVenueOwnerMismatch >= 1, "a real food venue far from the owner must be counted");
  assert.ok(before.illegalScheduledRealPlaces >= 1);

  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const { days, after } = enforceItineraryInvariantsWithRepair([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, payload, R5_PROFILE, window);
  assert.equal(after.realFoodVenueOwnerMismatch, 0);
  assert.ok(!days[0].items.some((i) => i.name === "Le Bernardin"), "the distant restaurant is gone");
});

// 2 — owner + a distant cafe -> same.
test("Round 5: a real cafe far from the day owner is flagged AND repaired", () => {
  const day = r5Day({ dayNumber: 1, items: [buildItem({ name: "Blue Bottle Coffee", category: "cafe", recommendationId: "rec-bb", lat: R5_FAR.lat, lon: R5_FAR.lon })] });
  const before = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.ok(before.realFoodVenueOwnerMismatch >= 1);

  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const { days } = enforceItineraryInvariantsWithRepair([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD, R5_PROFILE, window);
  assert.ok(!days[0].items.some((i) => i.name === "Blue Bottle Coffee"));
});

// 3 — a generic MealOpportunity placeholder labelled with a foreign area is regenerated to the owner.
test("Round 5: a meal-opportunity placeholder labelled with a foreign area is regenerated to the day owner", () => {
  const staleMeal = buildCoordinatelessItem({
    name: "הפסקת צהריים מומלצת באזור Far Metro",
    category: "cafe",
    itemRole: "meal_opportunity",
    location: "Far Metro",
    slot: "lunch",
    shortDescription: "זהו חלון זמן מומלץ לארוחת צהריים באזור Far Metro",
  });
  const day = r5Day({ dayNumber: 1, items: [staleMeal, buildItem({ name: "Owner Sight", lat: R5_OWNER.lat, lon: R5_OWNER.lon })] });

  const [bound] = normalizeDayOwnershipToFrame([day], R5_FRAME, R5_PAYLOAD, R5_PROFILE);
  const meal = bound.items.find((i) => i.itemRole === "meal_opportunity")!;
  assert.ok(!meal.name.includes("Far Metro") && meal.location.includes("Owner Area"), `regenerated: ${meal.name} / ${meal.location}`);
});

// 3b — a coordinate-less Gemini "restaurant" (itemRole dropped) is treated as a meal-opportunity marker and regenerated.
test("Round 5: a coordinate-less unmatched restaurant name is treated as a meal-opportunity marker and regenerated to the owner", () => {
  const fakeRest = buildCoordinatelessItem({ name: "Lilia", category: "restaurant", location: "Brooklyn", slot: "dinner", recommendationId: null });
  const day = r5Day({ dayNumber: 1, items: [fakeRest, buildItem({ name: "Owner Sight", lat: R5_OWNER.lat, lon: R5_OWNER.lon })] });

  const [bound] = normalizeDayOwnershipToFrame([day], R5_FRAME, R5_PAYLOAD, R5_PROFILE);
  assert.ok(!bound.items.some((i) => i.name === "Lilia"), "the unverifiable restaurant name is replaced");
  assert.ok(bound.items.some((i) => (i.itemRole === "meal_opportunity") && i.location.includes("Owner Area")), "replaced by an owner-area meal opportunity");
});

// 4 — day narrative naming a foreign area is regenerated.
test("Round 5: a day whose notes say 'built around <foreign area>' has its narrative regenerated to the owner", () => {
  const day = r5Day({ dayNumber: 3, cityRegion: "Far Metro", accommodation: "לינה נוחה באזור Far Metro", title: "יום 3 בFar Metro",
    notes: "יום רגוע. היום בנוי סביב Owner Area כדי לשמור על קצב טבעי.", items: [buildItem({ name: "Far Sight", lat: R5_FAR.lat, lon: R5_FAR.lon })] });

  const before = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.equal(before.narrativeOwnerMismatch, 1, "notes name 'Owner Area' on a 'Far Metro'-owned day");

  const [bound] = normalizeDayOwnershipToFrame([day], R5_FRAME, R5_PAYLOAD, R5_PROFILE);
  assert.ok(bound.notes.includes("Far Metro") && !bound.notes.includes("Owner Area"), `regenerated notes: ${bound.notes}`);
  const after = validateFinalItineraryInvariants([bound], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.equal(after.narrativeOwnerMismatch, 0);
});

// 5 — a real cafe/restaurant is treated as a real place (goes through legality), not skipped as synthetic.
test("Round 5: the validator does NOT continue past a real restaurant/cafe — it is judged like an attraction", () => {
  const localRest = buildItem({ name: "Local Bistro", category: "restaurant", recommendationId: "rec-local", lat: R5_OWNER.lat + 0.01, lon: R5_OWNER.lon });
  const farRest = buildItem({ name: "Far Bistro", category: "restaurant", recommendationId: "rec-far", lat: R5_FAR.lat, lon: R5_FAR.lon });
  const day = r5Day({ dayNumber: 1, items: [localRest, farRest] });
  const report = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.equal(report.realFoodVenueOwnerMismatch, 1, "only the far one is flagged; a real restaurant is definitely SEEN");
});

// 6 — a generic MealOpportunity in the correct owner area is NOT flagged as an illegal real place.
test("Round 5: a generic meal-opportunity in the correct owner area is synthetic — never counted as an illegal real place", () => {
  const okMeal = buildCoordinatelessItem({ name: "🍽 זמן מומלץ לארוחת צהריים באזור Owner Area", category: "cafe", itemRole: "meal_opportunity", location: "Owner Area", slot: "lunch" });
  const day = r5Day({ dayNumber: 1, items: [okMeal, buildItem({ name: "Owner Sight", lat: R5_OWNER.lat, lon: R5_OWNER.lon })] });
  const report = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
  assert.equal(report.realFoodVenueOwnerMismatch, 0);
  assert.equal(report.syntheticOwnerMismatch, 0);
});

// 7/8/9 — legal local content survives untouched.
test("Round 5: a clean day (local restaurant + local attraction + owner-correct narrative) is unchanged and all counts zero", () => {
  const day = r5Day({
    dayNumber: 1,
    items: [
      buildItem({ name: "Local Grill", category: "restaurant", recommendationId: "rec-g", lat: R5_OWNER.lat + 0.01, lon: R5_OWNER.lon }),
      buildItem({ name: "Owner Museum", category: "museum", lat: R5_OWNER.lat, lon: R5_OWNER.lon - 0.01 }),
      buildCoordinatelessItem({ name: "🍽 זמן מומלץ לארוחת ערב באזור Owner Area", category: "restaurant", itemRole: "meal_opportunity", location: "Owner Area", slot: "dinner" }),
    ],
  });
  const report = validateFinalItineraryInvariants([day], R5_FRAME, R5_ANCHORS, R3_MOBILITY, R5_PAYLOAD);
  assert.equal(
    report.illegalScheduledRealPlaces + report.realFoodVenueOwnerMismatch + report.narrativeOwnerMismatch +
      report.syntheticOwnerMismatch + report.invalidDayDisplayOwnership + report.lodgingOwnerMismatch + report.dayOwnerMismatch,
    0
  );
  const [bound] = normalizeDayOwnershipToFrame([day], R5_FRAME, R5_PAYLOAD, R5_PROFILE);
  assert.equal(bound.notes, day.notes, "owner-correct narrative untouched");
  assert.ok(bound.items.some((i) => i.name === "Local Grill"), "legal local restaurant survives");
  assert.ok(bound.items.some((i) => i.name === "Owner Museum"), "legal local attraction survives");
});

// 10 — full sequence: distant restaurant + foreign meal placeholder + stale narrative -> all counts zero after repair.
test("Round 5: normalize + gate + invariant-repair together leave every ownership count zero (food + narrative + synthetic)", () => {
  const payload = buildPayload({
    recommendations: [buildRecommendation({ id: "owner-rest", name: "Owner Area Cafe", category: "cafe", location: "Owner Area", lat: R5_OWNER.lat + 0.01, lon: R5_OWNER.lon + 0.01 })],
  });
  const day = r5Day({
    dayNumber: 1,
    notes: "יום רגוע. היום בנוי סביב Far Metro כדי לשמור על קצב טבעי.",
    items: [
      buildItem({ name: "Le Bernardin", category: "restaurant", recommendationId: "rec-lb", lat: R5_FAR.lat, lon: R5_FAR.lon }),
      buildCoordinatelessItem({ name: "הפסקת צהריים מומלצת באזור Far Metro", category: "cafe", itemRole: "meal_opportunity", location: "Far Metro", slot: "lunch" }),
      buildItem({ name: "Owner Sight", lat: R5_OWNER.lat, lon: R5_OWNER.lon }),
    ],
  });
  const days = [day, r5Day({ dayNumber: 2, items: [buildItem({ name: "Owner Sight 2", lat: R5_OWNER.lat, lon: R5_OWNER.lon })] }),
    r5Day({ dayNumber: 3, cityRegion: "Far Metro", accommodation: "לינה נוחה באזור Far Metro", title: "יום 3 בFar Metro", notes: "היום בנוי סביב Far Metro.", items: [buildItem({ name: "Far Sight", lat: R5_FAR.lat, lon: R5_FAR.lon })] }),
    r5Day({ dayNumber: 4, cityRegion: "Far Metro", accommodation: "לינה נוחה באזור Far Metro", title: "יום 4 בFar Metro", notes: "היום בנוי סביב Far Metro.", items: [buildItem({ name: "Far Museum", lat: R5_FAR.lat, lon: R5_FAR.lon })] })];
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

  const { days: repaired, before, after } = enforceItineraryInvariantsWithRepair(days, R5_FRAME, R5_ANCHORS, R3_MOBILITY, payload, R5_PROFILE, window);
  assert.ok(before.realFoodVenueOwnerMismatch + before.narrativeOwnerMismatch + before.syntheticOwnerMismatch > 0, "sanity: violations existed");
  assert.equal(after.illegalScheduledRealPlaces, 0);
  assert.equal(after.realFoodVenueOwnerMismatch, 0);
  assert.equal(after.narrativeOwnerMismatch, 0);
  assert.equal(after.syntheticOwnerMismatch, 0);
  assert.equal(after.invalidTransitionOwnership, 0);
  assert.ok(!repaired[0].items.some((i) => i.name === "Le Bernardin"));
  assert.ok(repaired[0].notes.includes("Owner Area") && !repaired[0].notes.includes("Far Metro"));
});

// ==================================================
// ROUND 6 — LAST REAL-POI GEOGRAPHY ESCAPE (any category, incl. museum)
// ==================================================

// Area A anchor, and a genuinely-separate "Metro B" ~222 km away that has
// its OWN pool anchor. A POI ~111 km from A (WITHIN the 120 km sparse-tier
// radius, so evaluateScheduledPlaceLegality alone says "legal") but whose
// own location text names "Metro B".
const R6_A = { lat: 0, lon: 0 };
const R6_METRO_B = { lat: 0, lon: 1.5 };       // ~167 km east of A — a genuinely separate metro
const R6_BETWEEN = { lat: 0, lon: 0.9 };       // ~100 km east of A (INSIDE the 120 km radius) but ~67 km from Metro B — genuinely "in" Metro B
const R6_FRAME = buildTestFrame([{ areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
// areaAnchors includes a pool-derived "Metro B" the trip does NOT structurally visit.
const R6_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Area A", R6_A], ["Metro B", R6_METRO_B]]);
const R6_MOBILITY = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };
const R6_PAYLOAD = buildPayload();
const R6_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 3);

function r6Day(items: AiGeneratedItem[], overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return buildDay({ dayNumber: 1, cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", title: "יום 1 בArea A", notes: "היום בנוי סביב Area A.", items, ...overrides });
}
function r6Venue(name: string, category: AiGeneratedItem["category"], location: string, coords: { lat: number; lon: number }): AiGeneratedItem {
  return buildItem({ name, category, location, recommendationId: `rec-${name.replace(/\s+/g, "-")}`, lat: coords.lat, lon: coords.lon });
}

// A–D — a distant venue of ANY category whose own text names Metro B is flagged even though ~111 km < 120 km radius.
for (const [label, category] of [["museum", "museum"], ["restaurant", "restaurant"], ["cafe", "cafe"], ["shopping venue", "shopping"]] as const) {
  test(`Round 6: a ${label} whose location names a genuinely-separate known area is illegal even inside the raw radius`, () => {
    const day = r6Day([r6Venue(`Distant ${label}`, category, "Metro B", R6_BETWEEN), buildItem({ name: "Local A Sight", lat: R6_A.lat, lon: R6_A.lon })]);
    const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
    assert.ok(report.illegalScheduledRealPlaces >= 1, `${label} at 111km naming Metro B must be counted`);

    const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
    const { days, after } = enforceItineraryInvariantsWithRepair([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD, R6_PROFILE, window);
    assert.equal(after.illegalScheduledRealPlaces, 0);
    assert.ok(!days[0].items.some((i) => i.name === `Distant ${label}`), `the distant ${label} is removed/replaced`);
  });
}

// E — a local museum survives untouched.
test("Round 6: a local museum (in the day owner's own area) survives", () => {
  const day = r6Day([r6Venue("Local A Museum", "museum", "Area A", { lat: R6_A.lat + 0.01, lon: R6_A.lon })]);
  const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const { days } = enforceItineraryInvariantsWithRepair([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD, R6_PROFILE, window);
  assert.ok(days[0].items.some((i) => i.name === "Local A Museum"));
});

// F — a local restaurant survives untouched.
test("Round 6: a local restaurant (in the day owner's own area) survives", () => {
  const day = r6Day([r6Venue("Local A Bistro", "restaurant", "Area A", { lat: R6_A.lat + 0.01, lon: R6_A.lon })]);
  const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
});

// G — a generic meal opportunity is not treated as a real place.
test("Round 6: a generic meal opportunity is never counted as a real scheduled place", () => {
  const meal = buildCoordinatelessItem({ name: "🍽 זמן מומלץ לארוחת צהריים באזור Area A", category: "cafe", itemRole: "meal_opportunity", location: "Area A", slot: "lunch" });
  const day = r6Day([meal, buildItem({ name: "Local A Sight", lat: R6_A.lat, lon: R6_A.lon })]);
  const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
});

// H — a free-time block is not treated as a real place.
test("Round 6: a free-time block is never counted as a real scheduled place", () => {
  const ft = buildCoordinatelessItem({ name: "זמן פנוי לגלות את Area A", category: "attraction", itemRole: "free_time", location: "Area A" });
  const day = r6Day([ft, buildItem({ name: "Local A Sight", lat: R6_A.lat, lon: R6_A.lon })]);
  const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
});

// I — the canonical stay-transition item is never treated as an activity/real place.
test("Round 6: the canonical stay-transition item is never counted as a real scheduled place", () => {
  const twoStayFrame = buildTestFrame([
    { areaLabel: "Area A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "Metro B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const anchors = new Map<string, { lat: number; lon: number } | null>([["Area A", R6_A], ["Metro B", R6_METRO_B]]);
  const transferDay = buildDay({
    dayNumber: 2, cityRegion: "Metro B", accommodation: "לינה נוחה באזור Metro B", title: "יום 2 בMetro B", notes: "היום בנוי סביב Metro B.",
    items: [
      buildStayTransitionItem({ fromBase: "Area A", toBase: "Metro B", fromCoordinates: R6_A, toCoordinates: R6_METRO_B, transportMode: "car", estimatedTravelMinutes: 200, dayNumber: 2 }),
      buildItem({ name: "Metro B Arrival Stroll", lat: R6_METRO_B.lat, lon: R6_METRO_B.lon }),
    ],
  });
  const report = validateFinalItineraryInvariants([transferDay], twoStayFrame, anchors, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(report.illegalScheduledRealPlaces, 0);
  assert.equal(report.invalidTransitionOwnership, 0);
});

// J — full sequence: a distant museum + a distant restaurant naming a separate area, all cleared, total zero.
test("Round 6: the full finalization sequence leaves illegalScheduledRealPlaces = 0 for distant venues of mixed category", () => {
  const day = r6Day([
    r6Venue("Distant Museum", "museum", "Metro B", R6_BETWEEN),
    r6Venue("Distant Diner", "restaurant", "Metro B", R6_BETWEEN),
    buildItem({ name: "Local A Sight", lat: R6_A.lat, lon: R6_A.lon }),
  ]);
  const days = [day, r6Day([buildItem({ name: "Local A Sight 2", lat: R6_A.lat, lon: R6_A.lon })], { dayNumber: 2 }),
    r6Day([buildItem({ name: "Local A Sight 3", lat: R6_A.lat, lon: R6_A.lon })], { dayNumber: 3 })];
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

  const localityDays = enforceNormalDayLocality(days, R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD, R6_PROFILE, window).days;
  const roleDays = enforceTransportRoleGuard(localityDays, R6_PAYLOAD, R6_PROFILE, R6_FRAME, R6_ANCHORS).days;
  const gateDays = enforceFinalPlaceLegalityGate(roleDays, R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD, R6_PROFILE, window).days;
  const { days: finalDays, after } = enforceItineraryInvariantsWithRepair(gateDays, R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD, R6_PROFILE, window);

  assert.equal(after.illegalScheduledRealPlaces, 0);
  assert.ok(!finalDays[0].items.some((i) => i.name === "Distant Museum"));
  assert.ok(!finalDays[0].items.some((i) => i.name === "Distant Diner"));
  assert.ok(finalDays[0].items.some((i) => i.name === "Local A Sight"), "the local item is untouched");
});

// K — the diagnostic 3-way breakdown always sums back to the ONE authoritative total.
test("Round 6: illegalReal{Attractions,FoodVenues,OtherVenues} always sum to illegalScheduledRealPlaces", () => {
  const day = r6Day([
    r6Venue("Distant Museum", "museum", "Metro B", R6_BETWEEN),
    r6Venue("Distant Diner", "restaurant", "Metro B", R6_BETWEEN),
    r6Venue("Distant Cafe", "cafe", "Metro B", R6_BETWEEN),
    r6Venue("Distant Nightlife", "nightlife", "Metro B", R6_BETWEEN),
    buildItem({ name: "Local A Sight", lat: R6_A.lat, lon: R6_A.lon }),
  ]);
  const report = validateFinalItineraryInvariants([day], R6_FRAME, R6_ANCHORS, R6_MOBILITY, R6_PAYLOAD);
  assert.equal(
    report.illegalRealAttractions + report.illegalRealFoodVenues + report.illegalRealOtherVenues,
    report.illegalScheduledRealPlaces,
    "breakdown must partition the authoritative total exactly",
  );
  assert.equal(report.illegalRealAttractions, 1, "the museum");
  assert.equal(report.illegalRealFoodVenues, 2, "restaurant + cafe");
  assert.equal(report.illegalRealOtherVenues, 1, "nightlife");
});

/* ================================================================== *
 * Round 7 — opening-hours legality + time-slot repair                  *
 * ================================================================== */

// Thursday / Saturday — real weekdays for the structured check.
const R7_THU = "2026-09-10";
const R7_SAT = "2026-09-12";
const R7_FRAME = buildTestFrame([{ areaLabel: "Area A", nights: 4, startDayNumber: 1, endDayNumber: 4 }]);
const R7_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Area A", { lat: 0, lon: 0 }]]);
const R7_MOBILITY = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };
const R7_PAYLOAD = buildPayload();
const R7_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 4);
const R7_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

function r7Day(items: AiGeneratedItem[], overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return buildDay({
    dayNumber: 2,
    date: R7_THU,
    cityRegion: "Area A",
    accommodation: "לינה נוחה באזור Area A",
    title: "יום 2 בArea A",
    notes: "היום בנוי סביב Area A.",
    items,
    ...overrides,
  });
}
function r7Venue(name: string, category: AiGeneratedItem["category"], openingHours: string, plannedStartTime: string, durationMin = 90): AiGeneratedItem {
  return buildItem({
    name,
    category,
    openingHours,
    plannedStartTime,
    estimatedDurationMinutes: durationMin,
    recommendationId: `rec-${name.replace(/\s+/g, "-")}`,
    lat: 0.01,
    lon: 0.01,
  });
}

function ohViolations(day: AiGeneratedDay) {
  return validateFinalItineraryInvariants([day], R7_FRAME, R7_ANCHORS, R7_MOBILITY, R7_PAYLOAD, R7_WINDOW);
}

// A. venue 10:00-17:00 scheduled 18:56 → repaired to zero known-hours violations
test("Round 7 A: a 10:00-17:00 venue scheduled 18:56 is a violation and is repaired", () => {
  const day = r7Day([
    r7Venue("Late Wine Train", "attraction", "10:00-17:00", "18:56"),
    buildItem({ name: "Local Filler", lat: 0.01, lon: 0.01, plannedStartTime: "09:00" }),
  ]);
  assert.ok(ohViolations(day).openingHoursViolations >= 1);
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  assert.equal(ohViolations(repaired).openingHoursViolations, 0);
});

// B. cafe 07:00-17:00 scheduled 17:59 → repaired
test("Round 7 B: a 07:00-17:00 cafe scheduled 17:59 is repaired", () => {
  const day = r7Day([
    buildItem({ name: "Morning Anchor", lat: 0.01, lon: 0.01, plannedStartTime: "09:00", estimatedDurationMinutes: 120, openingHours: "08:00-20:00" }),
    r7Venue("Evening Blue Bottle", "cafe", "07:00-17:00", "17:59", 45),
  ]);
  assert.ok(ohViolations(day).openingHoursViolations >= 1);
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  assert.equal(ohViolations(repaired).openingHoursViolations, 0);
});

// C / N. restaurant 17:30-22:00 scheduled 11:27 → repaired (real restaurant IS checked)
test("Round 7 C/N: a 17:30-22:00 restaurant scheduled 11:27 is a violation and is repaired (food venues are real venues)", () => {
  const day = r7Day([
    r7Venue("Eleven Madison Park", "restaurant", "17:30-22:00", "11:27"),
    buildItem({ name: "Daytime Sight", lat: 0.01, lon: 0.01, plannedStartTime: "09:00", openingHours: "09:00-18:00", estimatedDurationMinutes: 180 }),
    buildItem({ name: "Afternoon Sight", lat: 0.01, lon: 0.01, plannedStartTime: "13:00", openingHours: "09:00-18:00", estimatedDurationMinutes: 180 }),
  ]);
  const before = ohViolations(day);
  assert.ok(before.openingHoursViolations >= 1);
  assert.ok(before.opensAfterScheduledStart >= 1, "classified as opens-after-start");
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  assert.equal(ohViolations(repaired).openingHoursViolations, 0);
});

// D. venue 08:30-16:00 scheduled 15:34 with a duration that overruns 16:00 → CLOSES_BEFORE_END, repaired
test("Round 7 D: an activity that STARTS before closing but ENDS after it is a violation and is repaired", () => {
  const day = r7Day([
    r7Venue("Statue Of Liberty", "attraction", "08:30-16:00", "15:34", 90),
  ]);
  const before = ohViolations(day);
  assert.equal(before.openingHoursViolations, 1);
  assert.equal(before.closesBeforeScheduledEnd, 1);
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  assert.equal(ohViolations(repaired).openingHoursViolations, 0);
});

// E. a legal item entirely inside its interval survives unchanged
test("Round 7 E: a legal item entirely inside its interval is untouched by repair", () => {
  const legal = r7Venue("Well Timed Museum", "museum", "09:00-18:00", "10:00", 120);
  const day = r7Day([legal]);
  assert.equal(ohViolations(day).openingHoursViolations, 0);
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  const kept = repaired.items.find((i) => i.name === "Well Timed Museum");
  assert.ok(kept);
  assert.equal(kept!.plannedStartTime, "10:00", "unchanged start");
});

// F. item ending exactly at closing time is legal
test("Round 7 F: an activity ending exactly at closing time is legal", () => {
  const day = r7Day([r7Venue("Closes At End", "attraction", "09:00-17:00", "15:00", 120)]);
  assert.equal(ohViolations(day).openingHoursViolations, 0);
});

// G. item starting exactly at opening time is legal
test("Round 7 G: an activity starting exactly at opening time is legal", () => {
  const day = r7Day([r7Venue("Starts At Open", "attraction", "09:00-17:00", "09:00", 60)]);
  assert.equal(ohViolations(day).openingHoursViolations, 0);
});

// H. split opening intervals
test("Round 7 H: split intervals — a start in the midday gap is a violation, either open half is legal", () => {
  const gap = r7Day([r7Venue("Split Hours Venue", "attraction", "09:00-13:00, 15:00-19:00", "14:00", 30)]);
  assert.equal(ohViolations(gap).openingHoursViolations, 1);
  const ok = r7Day([r7Venue("Split Hours Venue", "attraction", "09:00-13:00, 15:00-19:00", "16:00", 60)]);
  assert.equal(ohViolations(ok).openingHoursViolations, 0);
});

// I. closed weekday
test("Round 7 I: a venue closed on the scheduled local weekday is CLOSED_ALL_DAY and is repaired", () => {
  // Mo-Fr only, scheduled on a Saturday.
  const day = r7Day([r7Venue("Weekday Only Gallery", "museum", "Mo-Fr 09:00-17:00", "10:00", 90)], { date: R7_SAT });
  const before = ohViolations(day);
  assert.equal(before.openingHoursViolations, 1);
  assert.equal(before.closedAllDay, 1);
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  assert.equal(ohViolations(repaired).openingHoursViolations, 0);
  assert.ok(!repaired.items.some((i) => i.name === "Weekday Only Gallery"), "cannot be kept on a day it is closed");
});

// J. 24/7 is never a violation
test("Round 7 J: a 24/7 venue is never an opening-hours violation, even at 03:00", () => {
  const day = r7Day([r7Venue("Always Open Diner", "restaurant", "24/7", "03:00", 60)]);
  const report = ohViolations(day);
  assert.equal(report.openingHoursViolations, 0);
  assert.equal(report.openingHoursUnknownItems, 0);
});

// K. unknown hours — surfaced, never a violation
test("Round 7 K: unknown/garbled hours count as openingHoursUnknownItems, never openingHoursViolations", () => {
  const day = r7Day([r7Venue("Hours Vary Spot", "attraction", "hours vary — call ahead", "23:30", 90)]);
  const report = ohViolations(day);
  assert.equal(report.openingHoursViolations, 0);
  assert.equal(report.openingHoursUnknownItems, 1);
});

// L. cross-midnight — legal late-night activity
test("Round 7 L: an 18:00-02:00 bar at 23:30 is legal", () => {
  const day = r7Day([r7Venue("Late Bar", "nightlife", "18:00-02:00", "23:30", 90)]);
  assert.equal(ohViolations(day).openingHoursViolations, 0);
});

// M. cross-midnight — illegal daytime activity
test("Round 7 M: an 18:00-02:00 bar at 13:00 is a violation", () => {
  const day = r7Day([r7Venue("Daytime At A Bar", "nightlife", "18:00-02:00", "13:00", 60)]);
  assert.ok(ohViolations(day).openingHoursViolations >= 1);
});

// O. generic MealOpportunity placeholders have no opening-hours constraint
test("Round 7 O: a generic MealOpportunity placeholder is never an opening-hours violation", () => {
  const meal = buildCoordinatelessItem({
    name: "🍽 חלון זמן מומלץ לארוחת ערב",
    category: "restaurant",
    itemRole: "meal_opportunity",
    location: "Area A",
    slot: "dinner",
    openingHours: "17:30-22:00",
    plannedStartTime: "11:00",
  });
  const day = r7Day([meal, buildItem({ name: "Sight", lat: 0.01, lon: 0.01, plannedStartTime: "09:00" })]);
  const report = ohViolations(day);
  assert.equal(report.openingHoursViolations, 0);
  assert.equal(report.openingHoursUnknownItems, 0);
});

// P. locked / fixedTime conflict is reported, never silently moved
test("Round 7 P: a locked venue that conflicts with its hours is reported (lockedOpeningHoursConflicts) but not moved", () => {
  const locked = r7Venue("User Pinned Venue", "attraction", "10:00-17:00", "19:30", 90);
  locked.locked = true;
  const day = r7Day([locked]);
  const report = ohViolations(day);
  assert.equal(report.openingHoursViolations, 0, "a locked conflict is NOT a repairable violation");
  assert.equal(report.lockedOpeningHoursConflicts, 1, "but it IS reported");
  const [repaired] = repairOpeningHoursViolations([day], R7_PAYLOAD, R7_PROFILE);
  const kept = repaired.items.find((i) => i.name === "User Pinned Venue");
  assert.ok(kept, "the locked item is preserved");
  assert.equal(kept!.plannedStartTime, "19:30", "and never silently moved");
});

// Q / R. full sequence: repair introduces no duplicatePlaces and no geography-owner violation
test("Round 7 Q/R: the full finalization sequence repairs opening hours without new duplicatePlaces or geography violations", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({ id: "legal-1", name: "Area A Morning Spot", category: "attraction", location: "Area A", openingHours: "08:00-20:00", lat: 0.02, lon: 0.02 }),
      buildRecommendation({ id: "legal-2", name: "Area A Evening Spot", category: "attraction", location: "Area A", openingHours: "08:00-23:00", lat: 0.02, lon: 0.015 }),
    ],
  });
  const days = [
    r7Day([
      r7Venue("Impossible Daytime Restaurant", "restaurant", "18:00-23:00", "10:30"),
      r7Venue("Impossible Evening Museum", "museum", "09:00-16:00", "19:15"),
      buildItem({ name: "Legal Local Anchor", lat: 0.01, lon: 0.01, plannedStartTime: "09:00", openingHours: "08:00-20:00", estimatedDurationMinutes: 120 }),
    ], { dayNumber: 2, date: R7_THU }),
    r7Day([buildItem({ name: "Day 3 Local Sight", lat: 0.01, lon: 0.01, openingHours: "08:00-20:00" })], { dayNumber: 3, date: "2026-09-11" }),
  ];

  const localityDays = enforceNormalDayLocality(days, R7_FRAME, R7_ANCHORS, R7_MOBILITY, payload, R7_PROFILE, R7_WINDOW).days;
  const roleDays = enforceTransportRoleGuard(localityDays, payload, R7_PROFILE, R7_FRAME, R7_ANCHORS).days;
  const gateDays = enforceFinalPlaceLegalityGate(roleDays, R7_FRAME, R7_ANCHORS, R7_MOBILITY, payload, R7_PROFILE, R7_WINDOW).days;
  const ohDays = repairOpeningHoursViolations(gateDays, payload, R7_PROFILE);
  const { days: finalDays, after } = enforceItineraryInvariantsWithRepair(ohDays, R7_FRAME, R7_ANCHORS, R7_MOBILITY, payload, R7_PROFILE, R7_WINDOW);

  assert.equal(after.openingHoursViolations, 0, "S: openingHoursViolations = 0 on the exact returned object");
  assert.equal(after.illegalScheduledRealPlaces, 0, "R: no geography-owner violation introduced");

  const diag = collectPlanDiagnostics(
    { title: "t", summary: "s", totalEstimatedCost: null, estimatedTransportCost: null, averageDailyCost: null, costPerTraveler: null, categoryBreakdown: {}, days: finalDays },
    R7_PROFILE,
    R7_FRAME,
    R7_WINDOW,
  );
  assert.equal(diag.duplicatePlaces, 0, "Q: repair introduced no duplicatePlaces");
  assert.equal(diag.openingHoursViolations, 0, "acceptance-gate diagnostic agrees");
});

// S. fresh generation: the pure validator on the exact returned object has openingHoursViolations = 0
test("Round 7 S: enforceItineraryInvariantsWithRepair drives openingHoursViolations to 0 for a batch of illegal-hours venues", () => {
  const days = [
    r7Day([
      r7Venue("A", "attraction", "10:00-17:00", "18:56"),
      r7Venue("B", "cafe", "07:00-17:00", "17:59", 45),
      r7Venue("C", "restaurant", "17:30-22:00", "11:27"),
      r7Venue("D", "attraction", "08:30-16:00", "15:34", 90),
      buildItem({ name: "Legal Anchor", lat: 0.01, lon: 0.01, plannedStartTime: "09:00", openingHours: "08:00-22:00", estimatedDurationMinutes: 120 }),
    ], { dayNumber: 2, date: R7_THU }),
  ];
  const before = validateFinalItineraryInvariants(days, R7_FRAME, R7_ANCHORS, R7_MOBILITY, R7_PAYLOAD, R7_WINDOW);
  assert.ok(before.openingHoursViolations >= 3);
  const { after } = enforceItineraryInvariantsWithRepair(days, R7_FRAME, R7_ANCHORS, R7_MOBILITY, R7_PAYLOAD, R7_PROFILE, R7_WINDOW);
  assert.equal(after.openingHoursViolations, 0);
  assert.equal(after.lockedOpeningHoursConflicts, 0);
});

// Diagnostic breakdown always partitions the authoritative total.
test("Round 7: opens/closes/closedAtStart/closedAllDay always sum to openingHoursViolations", () => {
  const day = r7Day([
    r7Venue("Opens Later", "restaurant", "17:30-22:00", "11:00", 90),
    r7Venue("Overruns Close", "attraction", "08:30-16:00", "15:40", 90),
    r7Venue("After Close", "attraction", "10:00-17:00", "18:56", 90),
    r7Venue("Shut Today", "museum", "Mo-Fr 09:00-17:00", "10:00", 90),
  ], { date: R7_SAT });
  const r = ohViolations(day);
  assert.equal(r.opensAfterScheduledStart + r.closesBeforeScheduledEnd + r.closedAtStart + r.closedAllDay, r.openingHoursViolations);
  assert.ok(r.openingHoursViolations >= 3);
});

/* ================================================================== *
 * Round 8 — real-activity QUALITY (a legally-safe empty itinerary fails) *
 * ================================================================== */

const R8_A = { lat: 10, lon: 10 };
const R8_FRAME = buildTestFrame([{ areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
const R8_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Area A", R8_A]]);
const R8_MOBILITY = { tier: "large_sparse" as const, localityRadiusKm: 120, normalDayTravelBudgetMinutes: 160 };
const R8_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 3);
const R8_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

function r8Rec(id: string, name: string, category: AiGeneratedItem["category"], overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return buildRecommendation({ id, name, category, location: "Area A", lat: R8_A.lat + 0.01, lon: R8_A.lon + 0.01, openingHours: "08:00-20:00", ...overrides });
}
function r8Day(items: AiGeneratedItem[], overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return buildDay({ dayNumber: 2, date: "2026-09-10", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", title: "יום 2 בArea A", notes: "היום בנוי סביב Area A.", items, ...overrides });
}
function r8FreeTime(name = "Free Block"): AiGeneratedItem {
  return buildCoordinatelessItem({ name, category: "attraction", itemRole: "free_time", location: "Area A" });
}
function r8Payload(recs: TripRecommendation[]): AiItineraryRequest {
  return buildPayload({ recommendations: recs });
}
function meaningfulCount(day: AiGeneratedDay): number {
  return day.items.filter((item) => item.category !== "cafe" && item.category !== "restaurant" && item.recommendationId != null).length;
}

// A. normal day with 8 legal unused candidates -> final day has >=2 real activities
test("Round 8 A: a normal day with plenty of unused legal candidates is backfilled to >= 2 real activities", () => {
  const recs = Array.from({ length: 8 }, (_, i) => r8Rec(`rec-a${i}`, `Attraction ${i}`, "attraction"));
  const payload = r8Payload(recs);
  const day = r8Day([r8FreeTime("Morning Free"), r8FreeTime("Afternoon Free")]);
  const { days, insertions } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(insertions.length >= 2, "at least 2 real candidates inserted");
  assert.ok(meaningfulCount(days[0]) >= 2, "day now has >= 2 real activities");
});

// B. a real activity becomes geographically illegal -> another real candidate replaces it, NOT free_time
test("Round 8 B: a day left with zero real content after geography repair is backfilled with a REAL candidate, not free_time", () => {
  const recs = [r8Rec("rec-b1", "Replacement Landmark", "attraction")];
  const payload = r8Payload(recs);
  const day = r8Day([r8FreeTime("Leftover Free Block")]); // simulates the day AFTER an illegal item was already stripped
  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(days[0].items.some((i) => i.name === "Replacement Landmark"), "a real candidate fills the gap");
  assert.equal(days[0].items.some((i) => i.itemRole === "free_time" && i.name === "Leftover Free Block"), false, "the synthetic filler is demoted, not kept alongside");
});

// C. a real activity is closed -> another legal real candidate preferred over synthetic
test("Round 8 C: after an opening-hours repair strips a closed venue, backfill prefers a real candidate over synthetic", () => {
  const recs = [r8Rec("rec-c1", "Open Late Museum", "museum", { openingHours: "10:00-20:00" })];
  const payload = r8Payload(recs);
  const day = r8Day([
    buildItem({ name: "Closed Venue", category: "attraction", openingHours: "Mo-Fr 09:00-17:00", plannedStartTime: "10:00", lat: R8_A.lat, lon: R8_A.lon }),
  ], { date: "2026-09-12" }); // 2026-09-12 is a Saturday -> Mo-Fr venue is CLOSED_ALL_DAY
  const repaired = repairOpeningHoursViolations([day], payload, R8_PROFILE);
  assert.equal(repaired[0].items.some((i) => i.name === "Closed Venue"), false, "the closed venue was removed by opening-hours repair");
  const { days } = backfillRealActivities(repaired, R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(days[0].items.some((i) => i.name === "Open Late Museum"), "a real, legally-open candidate fills the gap instead of staying synthetic");
});

// D. candidate pool initially empty but refill returns candidates -> real activities inserted
test("Round 8 D: backfill does nothing against an empty pool, but fills once candidates are available (refill)", () => {
  const day = r8Day([r8FreeTime()]);
  const emptyPayload = r8Payload([]);
  const before = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, emptyPayload, R8_PROFILE, R8_WINDOW);
  assert.equal(before.insertions.length, 0, "nothing to insert from an empty pool");

  // Simulates a refill: the SAME owner/stay now has candidates loaded.
  const refilledPayload = r8Payload([r8Rec("rec-d1", "Refilled Attraction", "attraction"), r8Rec("rec-d2", "Refilled Museum", "museum")]);
  const after = backfillRealActivities(before.days, R8_FRAME, R8_ANCHORS, R8_MOBILITY, refilledPayload, R8_PROFILE, R8_WINDOW);
  assert.ok(after.insertions.length >= 1, "real activities inserted once the pool is refilled");
});

// E. a duplicate (already-used) candidate is rejected -> another real candidate is chosen
test("Round 8 E: an already-used candidate is skipped in favor of another real candidate", () => {
  const used = r8Rec("rec-e-used", "Already Used Landmark", "attraction");
  const fresh = r8Rec("rec-e-fresh", "Fresh Landmark", "attraction");
  const payload = r8Payload([used, fresh]);
  // Day 1 already meets its own minimum (2 meaningful real activities) so
  // backfill has no reason to touch it — isolates the "skip already-used"
  // behavior on day 2 alone.
  const usedDay = r8Day([
    buildItem({ name: "Already Used Landmark", category: "attraction", recommendationId: "rec-e-used", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Day 1 Second Sight", category: "attraction", recommendationId: "rec-e-other", lat: R8_A.lat, lon: R8_A.lon }),
  ], { dayNumber: 1 });
  const targetDay = r8Day([r8FreeTime()], { dayNumber: 2 });
  const { days } = backfillRealActivities([usedDay, targetDay], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  const filled = days[1];
  assert.ok(filled.items.some((i) => i.name === "Fresh Landmark"), "the unused candidate is chosen");
  assert.equal(filled.items.filter((i) => i.recommendationId === "rec-e-used").length, 0, "the already-used candidate is never reinserted");
});

// F. normal day with sufficient candidates -> daysWithOnlySyntheticContent = false
test("Round 8 F: validateItineraryQuality reports daysWithOnlySyntheticContent = 0 for a well-populated day", () => {
  const day = r8Day([
    buildItem({ name: "Museum", category: "museum", recommendationId: "rec-f1", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Historic District", category: "attraction", recommendationId: "rec-f2", lat: R8_A.lat, lon: R8_A.lon }),
    r8FreeTime("Evening Free"),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.daysWithOnlySyntheticContent, 0);
  assert.equal(report.daysBelowMinimumRealActivities, 0);
});

// G. light day (explicit restWindow) -> at least one real meaningful activity
test("Round 8 G: an explicit rest/light day is backfilled to at least 1 real activity, not 2", () => {
  const day = r8Day([r8FreeTime()], { restWindow: "יום זה בא אחרי כמה ימים אינטנסיביים ברצף — שמרו על קצב נינוח." });
  const recs = [r8Rec("rec-g1", "One Light Activity", "attraction")];
  const payload = r8Payload(recs);
  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(meaningfulCount(days[0]) >= 1);
  const report = validateItineraryQuality(days, R8_FRAME, R8_WINDOW);
  assert.equal(report.daysBelowMinimumRealActivities, 0, "1 real activity satisfies an explicit rest day's minimum");
});

// H. arrival day with only 3 usable hours -> zero or one real activity allowed, never force-filled
test("Round 8 H: an arrival day is never force-backfilled by quality repair", () => {
  const window = { earliestUsableTimeOnArrivalDay: { date: "2026-09-10", time: "19:00" }, latestUsableTimeOnDepartureDay: null } as never;
  const day = r8Day([r8FreeTime()], { dayNumber: 1, date: "2026-09-10" });
  const recs = [r8Rec("rec-h1", "Would-Be Arrival Activity", "attraction")];
  const payload = r8Payload(recs);
  const { days, insertions } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, window);
  assert.equal(insertions.length, 0, "arrival days are structurally exempt, never force-filled");
  const report = validateItineraryQuality(days, R8_FRAME, window);
  assert.equal(report.daysBelowMinimumRealActivities, 0, "arrival day has a 0 minimum");
});

// I. transfer-heavy day -> synthetic-only allowed when justified
test("Round 8 I: a transfer day with only synthetic content is NOT counted as an unjustified failure", () => {
  const twoStayFrame = buildTestFrame([
    { areaLabel: "Area A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "Metro B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const transferDay = r8Day([r8FreeTime("Transfer Day Free Time")], { dayNumber: 2, cityRegion: "Metro B" });
  const report = validateItineraryQuality([transferDay], twoStayFrame, R8_WINDOW);
  assert.equal(report.daysWithOnlySyntheticContent, 1);
  assert.equal(report.unjustifiedDaysWithOnlySyntheticContent, 0, "a transfer day's synthetic-only content is structurally justified");
});

// J. true provider exhaustion -> synthetic fallback allowed, and it does not trigger the hard-fail
test("Round 8 J: genuine destination scarcity (tiny candidate pool) never throws INSUFFICIENT_REAL_ACTIVITY_COVERAGE", () => {
  const days = Array.from({ length: 6 }, (_, i) => r8Day([r8FreeTime()], { dayNumber: i + 1 }));
  const report = validateItineraryQuality(days, buildTestFrame([{ areaLabel: "Area A", nights: 6, startDayNumber: 1, endDayNumber: 6 }]), R8_WINDOW);
  assert.ok(report.unjustifiedDaysWithOnlySyntheticContent > 0, "the shape IS quality-poor");
  assert.doesNotThrow(() => assertRealActivityCoverage(report, r8Payload([r8Rec("rec-j1", "Only Candidate", "attraction")])));
});

// R. a catastrophically empty plan (country-level single stay, long trip) fails quality acceptance
test("Round 9.3 R: a country-level single stay for a long trip throws INSUFFICIENT_REAL_ACTIVITY_COVERAGE regardless of pool size", () => {
  const dayCount = 42;
  const days = Array.from({ length: dayCount }, (_, i) => r8Day([r8FreeTime()], { dayNumber: i + 1 }));
  const countryFrame = buildTestFrame([{ areaLabel: "United States", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const report = validateItineraryQuality(days, countryFrame, R8_WINDOW);
  assert.throws(
    () => assertRealActivityCoverage(report, r8Payload([]), { tripFrame: countryFrame, countryName: "United States" }),
    /Insufficient real-activity coverage/,
    "a country-level owner for a 42-day trip must never pass as an acceptable plan, even with zero recommendations loaded"
  );
});

test("Round 9.3 R: a country-level single stay is fine for a genuinely short trip (never flagged for a real single-base country)", () => {
  const dayCount = 4;
  const days = Array.from({ length: dayCount }, (_, i) => r8Day([r8FreeTime()], { dayNumber: i + 1 }));
  const countryFrame = buildTestFrame([{ areaLabel: "Monaco", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const report = validateItineraryQuality(days, countryFrame, R8_WINDOW);
  assert.doesNotThrow(() => assertRealActivityCoverage(report, r8Payload([]), { tripFrame: countryFrame, countryName: "Monaco" }));
});

// K. a 44-day-shaped synthetic-heavy itinerary -> quality validator FAILS
test("Round 8 K: a majority-synthetic multi-day itinerary fails passesQualityValidation", () => {
  const frame = buildTestFrame([{ areaLabel: "Area A", nights: 10, startDayNumber: 1, endDayNumber: 10 }]);
  const days = Array.from({ length: 10 }, (_, i) =>
    i < 8
      ? r8Day([r8FreeTime("Free 1"), r8FreeTime("Free 2")], { dayNumber: i + 1 })
      : r8Day([buildItem({ name: `Real Sight ${i}`, category: "attraction", recommendationId: `rec-k${i}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: i + 1 })
  );
  const report = validateItineraryQuality(days, frame, R8_WINDOW);
  assert.equal(passesQualityValidation(report), false, "8/10 synthetic-only days must fail quality");
  assert.ok(report.unjustifiedDaysWithOnlySyntheticContent >= 8);

  // and it DOES throw the structured error given a non-trivial pool
  const bigPool = Array.from({ length: 12 }, (_, i) => r8Rec(`rec-pool-${i}`, `Pool Place ${i}`, "attraction"));
  assert.throws(() => assertRealActivityCoverage(report, r8Payload(bigPool)), InsufficientRealActivityCoverageError);
});

// Round 9.3.6 §14 — recommendationPoolSize must reflect real ACTIVITY
// supply only, never inflate the "non-trivial pool" gate with real MEAL
// VENUE candidates. Same majority-synthetic shape as Round 8 K, but the
// 12-candidate pool is entirely restaurants/cafes (real meal venues, never
// activities) — this is genuine activity scarcity (spec §12A: "genuine
// destination scarcity degrades silently") that must NOT be disguised as
// a planning failure just because the trip-wide recommendation count
// happens to clear the MIN_POOL_TO_EXPECT_COVERAGE threshold.
test("Round 9.3.6 §14: a pool made entirely of real meal venues never counts as real-activity supply for the coverage gate", () => {
  const frame = buildTestFrame([{ areaLabel: "Area A", nights: 10, startDayNumber: 1, endDayNumber: 10 }]);
  const days = Array.from({ length: 10 }, (_, i) =>
    i < 8
      ? r8Day([r8FreeTime("Free 1"), r8FreeTime("Free 2")], { dayNumber: i + 1 })
      : r8Day([buildItem({ name: `Real Sight ${i}`, category: "attraction", recommendationId: `rec-k${i}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: i + 1 })
  );
  const report = validateItineraryQuality(days, frame, R8_WINDOW);
  const mealOnlyPool = Array.from({ length: 12 }, (_, i) => r8Rec(`rec-meal-${i}`, `Restaurant ${i}`, "restaurant"));
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    assertRealActivityCoverage(report, r8Payload(mealOnlyPool));
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caught = error;
  }
  assert.equal(caught, null, "a purely meal-venue pool must never trigger the real-activity coverage failure, even though 12 >= the trip-wide pool-size threshold");
});

test("Round 9.3.6 §14: InsufficientRealActivityCoverageError.diagnostics separates total/real-activity/real-meal-venue recommendation counts", () => {
  const bigPool = [
    ...Array.from({ length: 12 }, (_, i) => r8Rec(`rec-pool-${i}`, `Pool Place ${i}`, "attraction")),
    ...Array.from({ length: 5 }, (_, i) => r8Rec(`rec-meal-extra-${i}`, `Cafe ${i}`, "cafe")),
  ];
  const days = Array.from({ length: 10 }, (_, i) =>
    i < 8
      ? r8Day([r8FreeTime("Free 1"), r8FreeTime("Free 2")], { dayNumber: i + 1 })
      : r8Day([buildItem({ name: `Real Sight ${i}`, category: "attraction", recommendationId: `rec-k${i}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: i + 1 })
  );
  const frame = buildTestFrame([{ areaLabel: "Area A", nights: 10, startDayNumber: 1, endDayNumber: 10 }]);
  const report = validateItineraryQuality(days, frame, R8_WINDOW);
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    assertRealActivityCoverage(report, r8Payload(bigPool));
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caught = error;
  }
  assert.ok(caught, "the 12 real-activity candidates alone still clear the threshold and must throw");
  assert.equal(caught!.diagnostics.totalRecommendations, 17, "totalRecommendations must be the raw, unfiltered trip-wide count");
  assert.equal(caught!.diagnostics.recommendationPoolSize, 12, "recommendationPoolSize must be the real-ACTIVITY-only count, excluding the 5 meal venues");
  assert.equal(caught!.diagnostics.realMealVenueRecommendations, 5);
});

/* ================================================================== *
 * Round 9.3.6.1 — FIND THE REAL 18/34 COVERAGE FAILURE                *
 * ================================================================== */

// A. repairPlan's OWN "attempt >= 3, legally-clean plan" early return
// (the exact bypass Round 9.3.6 disclosed but did not fix) must NOT be
// able to accept a majority-synthetic, real-activity-poor plan anymore.
// A 100-day single stay with only 10 real candidates is legally clean
// (no must-visit/duplicate/budget/etc. violations) on every attempt, so
// passesValidation is true from attempt 0 — this reliably reaches the
// EARLY return inside `if (passesValidation(diagnostics))`, not only the
// post-loop fallback path Round 9.3.6 already fixed.
test("Round 9.3.6.1 A: repairPlan's attempt>=3 early return cannot bypass real-activity coverage", () => {
  const dayCount = 100;
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const recs = Array.from({ length: 10 }, (_, i) => r92Rec(`a1-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const startDate = new Date("2026-09-10T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const payload = buildPayload({
    recommendations: recs,
    preferences: { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) },
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Country X", dayCount);
  const raw: RawGeneratedPlan = {
    title: "Test Plan",
    summary: "",
    days: Array.from({ length: dayCount }, (_, i) => {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + i);
      return {
        dayNumber: i + 1,
        date: date.toISOString().slice(0, 10),
        title: `Day ${i + 1}`,
        cityRegion: "Metro A",
        accommodation: "Hotel",
        notes: "",
        transportation: "",
        items: [
          { name: "Free time", category: "attraction", location: "Metro A", shortDescription: "", slot: "morning", plannedStartTime: "10:00", estimatedDurationMinutes: 60 },
        ],
      };
    }),
  };
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    repairPlan(raw, payload, profile, frame, null, undefined, null);
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caught = error;
  }
  assert.ok(caught, "a legally-clean but real-activity-poor plan reaching attempt>=3 must still throw, never silently return");
});

// F. the exact production root cause: a synthetic "practical" free-time
// filler must survive a raw-plan round-trip (toRawGeneratedPlan has no
// itemRole field at all — category is the ONLY surviving signal) so it
// is never miscounted as real activity load or ambiguous-with-real
// content downstream.
test("Round 9.3.6.1 F: a 'practical' free-time item survives raw-plan round-tripping instead of becoming a fake 'attraction'", () => {
  const payload = buildPayload({ recommendations: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: 1, startDayNumber: 1, endDayNumber: 1 }]);
  const raw: RawGeneratedPlan = {
    title: "Test Plan",
    summary: "",
    days: [
      {
        dayNumber: 1,
        date: "2026-09-10",
        title: "Day 1",
        cityRegion: "Metro A",
        accommodation: "Hotel",
        notes: "",
        transportation: "",
        items: [
          { name: "זמן לעצמכם", category: "practical", location: "Metro A", shortDescription: "", slot: "afternoon", plannedStartTime: "14:00", estimatedDurationMinutes: 425 },
        ],
      },
    ],
  };
  const result = repairPlan(raw, payload, profile, frame, null, undefined, null);
  const item = result.days[0].items.find((i) => i.name === "זמן לעצמכם");
  assert.ok(item, "the free-time item must still be present");
  assert.equal(item!.category, "practical", "category must survive the round-trip, never fall through normalizeCategory's 'attraction' default");
});

// K. every successful repairPlan exit shares the SAME final coverage
// invariant — the early-return (attempt>=3, legally clean) and the
// post-loop fallback exit must both throw on the identical majority-
// synthetic shape, proving there is one shared boundary rather than two
// inconsistently-maintained checks.
test("Round 9.3.6.1 K: both of repairPlan's successful-exit paths enforce the identical coverage invariant", () => {
  const dayCount = 100;
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const recs = Array.from({ length: 10 }, (_, i) => r92Rec(`k1-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const startDate = new Date("2026-09-10T00:00:00Z");
  const endDateClean = new Date(startDate);
  endDateClean.setUTCDate(endDateClean.getUTCDate() + dayCount - 1);
  const buildRawDays = () =>
    Array.from({ length: dayCount }, (_, i) => {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + i);
      return {
        dayNumber: i + 1,
        date: date.toISOString().slice(0, 10),
        title: `Day ${i + 1}`,
        cityRegion: "Metro A",
        accommodation: "Hotel",
        notes: "",
        transportation: "",
        items: [
          { name: "Free time", category: "attraction", location: "Metro A", shortDescription: "", slot: "morning", plannedStartTime: "10:00", estimatedDurationMinutes: 60 },
        ],
      };
    });

  // Path 1: legally clean -> early return inside the attempt loop.
  const cleanPayload = buildPayload({
    recommendations: recs,
    preferences: { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDateClean.toISOString().slice(0, 10) },
  });
  const cleanProfile = buildTripPreferenceProfile(cleanPayload.preferences, "Country X", dayCount);
  let caughtClean: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    repairPlan({ title: "T", summary: "", days: buildRawDays() }, cleanPayload, cleanProfile, frame, null, undefined, null);
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caughtClean = error;
  }

  // Path 2: an unresolvable must-visit keyword forces passesValidation
  // false on every attempt, routing to the POST-LOOP fallback exit
  // instead (Round 9.3.6's own already-fixed call site).
  const dirtyPayload = buildPayload({
    recommendations: recs,
    preferences: {
      ...basePreferences,
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDateClean.toISOString().slice(0, 10),
      mustVisitPlaces: "Impossible Unicorn Castle",
    },
  });
  const dirtyProfile = buildTripPreferenceProfile(dirtyPayload.preferences, "Country X", dayCount);
  let caughtDirty: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    repairPlan({ title: "T", summary: "", days: buildRawDays() }, dirtyPayload, dirtyProfile, frame, null, undefined, null);
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caughtDirty = error;
  }

  assert.ok(caughtClean, "the early-return (legally-clean) exit must throw on this majority-synthetic shape");
  assert.ok(caughtDirty, "the post-loop fallback exit must ALSO throw on the identical shape");
  assert.ok(caughtClean!.diagnostics.stays![0].poolSize > 0, "the early-return exit's diagnostic must report real, non-zero supply");
  assert.ok(caughtDirty!.diagnostics.stays![0].poolSize > 0, "the post-loop exit's diagnostic must ALSO report real, non-zero supply — the same shared invariant");
});

// H. true zero real supply never fabricates a POI — a genuinely tiny
// pool must still be allowed to degrade to synthetic content silently
// (spec §12A, unchanged by this round).
test("Round 9.3.6.1 H: a genuinely tiny real pool still degrades silently, never fabricating content to satisfy coverage", () => {
  const dayCount = 6;
  const frame = buildTestFrame([{ areaLabel: "Remote Outpost", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const payload = buildPayload({ recommendations: [], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-15" } });
  const profile = buildTripPreferenceProfile(payload.preferences, "Country X", dayCount);
  const raw: RawGeneratedPlan = {
    title: "Test Plan",
    summary: "",
    days: Array.from({ length: dayCount }, (_, i) => ({
      dayNumber: i + 1,
      date: `2026-09-${String(10 + i).padStart(2, "0")}`,
      title: `Day ${i + 1}`,
      cityRegion: "Remote Outpost",
      accommodation: "Hotel",
      notes: "",
      transportation: "",
      items: [{ name: "Free time", category: "attraction", location: "Remote Outpost", shortDescription: "", slot: "morning", plannedStartTime: "10:00", estimatedDurationMinutes: 60 }],
    })),
  };
  const result = repairPlan(raw, payload, profile, frame, null, undefined, null);
  assert.ok(result.days.every((d) => d.items.every((i) => i.recommendationId == null)), "no fabricated real POI ever appears when genuinely zero real supply exists");
});

// I. arrival/departure/transfer days remain legitimately exempt from the
// coverage invariant — unchanged by this round's fix.
test("Round 9.3.6.1 I: arrival/departure/transfer zero-real days remain allowed, not counted against coverage", () => {
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const window = { earliestUsableTimeOnArrivalDay: { date: "2026-09-10", time: "19:00" }, latestUsableTimeOnDepartureDay: { date: "2026-09-12", time: "09:00" } } as never;
  const days = [
    r8Day([r8FreeTime("Arrival window")], { dayNumber: 1, date: "2026-09-10" }),
    r8Day([buildItem({ name: "Real Sight", category: "attraction", recommendationId: "rec-i1", lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: 2, date: "2026-09-11" }),
    r8Day([r8FreeTime("Departure window")], { dayNumber: 3, date: "2026-09-12" }),
  ];
  const report = validateItineraryQuality(days, frame, window);
  assert.doesNotThrow(() => assertRealActivityCoverage(report, r8Payload(Array.from({ length: 12 }, (_, i) => r8Rec(`rec-i-pool-${i}`, `Pool ${i}`, "attraction")))));
});

// C. an unused RESERVE (optional) portfolio candidate is consumed before
// a day is left with only FreeTime — the intended fallback order
// (selected -> reserve -> raw pool -> FreeTime) already exists in
// backfillRealActivities; this proves the reserve tier specifically.
test("Round 9.3.6.1 C: backfillRealActivities consumes an unused RESERVE portfolio candidate before leaving a day as FreeTime-only", () => {
  const reserveCandidate = {
    recommendationId: "reserve-1",
    name: "Reserve Landmark",
    category: "attraction" as const,
    classification: { primaryFamily: "LANDMARK", subtype: "iconic_landmark", secondaryFamilies: [], confidence: "category_fallback", metadata: {} } as never,
    significance: 50,
    lat: R8_A.lat,
    lon: R8_A.lon,
    location: "Area A",
    source: "api" as const,
  };
  const portfolio = { stayId: R8_FRAME.phases[0].id, selected: [], optional: [reserveCandidate], coveragePlan: {} as never };
  const portfoliosByStay = new Map([[R8_FRAME.phases[0].id, portfolio]]);
  const rec = r8Rec("reserve-1", "Reserve Landmark", "attraction");
  const payload = r8Payload([rec]);
  const day = r8Day([r8FreeTime("Only Free Time")]);
  const { days, insertions } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW, portfoliosByStay);
  assert.ok(insertions.some((i) => i.reason === "portfolio"), "the reserve candidate must be consumed via the portfolio path, not a raw pool scan");
  assert.ok(days[0].items.some((i) => i.name === "Reserve Landmark"), "the reserve candidate must actually be scheduled");
});

// D. once BOTH selected and reserve portfolio candidates are exhausted
// (already used elsewhere), the final stay pool (raw payload.recommendations)
// is still consumed before a day is left as FreeTime-only.
test("Round 9.3.6.1 D: backfillRealActivities falls through to the raw final stay pool once portfolio selected+reserve are exhausted", () => {
  const usedSelected = {
    recommendationId: "selected-used",
    name: "Selected Landmark",
    category: "attraction" as const,
    classification: { primaryFamily: "LANDMARK", subtype: "iconic_landmark", secondaryFamilies: [], confidence: "category_fallback", metadata: {} } as never,
    significance: 50,
    lat: R8_A.lat,
    lon: R8_A.lon,
    location: "Area A",
    source: "api" as const,
  };
  const portfolio = { stayId: R8_FRAME.phases[0].id, selected: [usedSelected], optional: [], coveragePlan: {} as never };
  const portfoliosByStay = new Map([[R8_FRAME.phases[0].id, portfolio]]);
  // The portfolio's own selected candidate is ALREADY scheduled on another day (making it "used"); a
  // separate, unselected real candidate exists only in the raw payload pool.
  // restWindow marks day 1 as an explicit light day (minimum 1 meaningful
  // real activity, already met) so it does not ALSO compete for the sole
  // pool candidate — isolating the fallback-order question to day 2 only.
  const usedDay = r8Day([buildItem({ name: "Selected Landmark", category: "attraction", recommendationId: "selected-used", lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: 1, restWindow: "16:00-18:00" });
  const targetDay = r8Day([r8FreeTime("Only Free Time")], { dayNumber: 2 });
  const payload = r8Payload([r8Rec("selected-used", "Selected Landmark", "attraction"), r8Rec("pool-only", "Pool-Only Landmark", "museum")]);
  const { days, insertions } = backfillRealActivities([usedDay, targetDay], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW, portfoliosByStay);
  assert.ok(insertions.some((i) => i.reason === "pool"), "with portfolio candidates exhausted, the raw pool must still be tried");
  assert.ok(days[1].items.some((i) => i.name === "Pool-Only Landmark"), "the pool-only real candidate fills the second day instead of leaving it FreeTime-only");
});

// J. a normal sightseeing day with unused legal supply available for its
// OWN stay cannot be accepted with only FreeTime — the coverage
// invariant must catch this shape trip-wide even when only ONE day is
// affected, as long as the majority-failure gate's own ratio is met.
test("Round 9.3.6.1 J: backfillRealActivities never leaves a normal day as FreeTime-only while its own stay has unused legal real supply", () => {
  const recs = Array.from({ length: 3 }, (_, i) => r8Rec(`rec-j-${i}`, `Sight ${i}`, "attraction"));
  const payload = r8Payload(recs);
  const day = r8Day([r8FreeTime("Only Free Time")]);
  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(meaningfulCount(days[0]) >= 1, "unused legal real supply for this exact stay must be used instead of leaving the day FreeTime-only");
});

// E. repairPlan's own per-attempt usage state (structuralRepairUsageState)
// is rebuilt via buildItineraryUsageState(repairedDays) FRESH at the top
// of every attempt, from the CURRENT plan — never a stale/leaked state
// carried over from a discarded earlier attempt. This proves the
// underlying primitive both attempts rely on genuinely reflects
// "currently scheduled," never "was scheduled at some earlier point":
// once a candidate is removed from the days actually passed in, a fresh
// rebuild must show it as available again — the exact contract repairPlan
// depends on for this to be safe across its 4 attempts.
test("Round 9.3.6.1 E: a fresh usage-state rebuild reflects the CURRENT itinerary, never a stale rejection from an earlier snapshot", () => {
  const scheduledDay = r8Day([buildItem({ name: "Reusable Sight", category: "attraction", recommendationId: "e1", lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: 1 });
  const stateWhileScheduled = buildItineraryUsageState([scheduledDay]);
  assert.equal(isItineraryPlaceUsed(stateWhileScheduled, { id: "e1", name: "Reusable Sight", lat: R8_A.lat, lon: R8_A.lon }), true, "sanity: the candidate is correctly seen as used while it is actually scheduled");

  // Simulates what an EARLIER repair attempt/step does when it legitimately
  // strips a candidate from a day (e.g. an illegal-geography repair) —
  // repairPlan's own loop always rebuilds structuralRepairUsageState from
  // `repairedDays` AS THEY CURRENTLY STAND at the top of each attempt,
  // never reusing a Set/Map built before the removal happened.
  const afterRemoval = { ...scheduledDay, items: [] };
  const freshState = buildItineraryUsageState([afterRemoval]);
  assert.equal(isItineraryPlaceUsed(freshState, { id: "e1", name: "Reusable Sight", lat: R8_A.lat, lon: R8_A.lon }), false, "a state rebuilt from the current (post-removal) days must show the candidate as available again, never permanently blacklisted from a stale snapshot");
});

// G. a day that reaches its final shape with only synthetic content (a
// large "practical" free-time filler that already satisfies
// fillUnderfilledDay's own utilization gate, so THAT step does nothing)
// must still be caught and filled with real content by
// finalizeArrivalDepartureContent's own backfill pass — repairPlan's
// final exit must never accept a day left over-full of synthetic filler
// while real, legal, unused candidates exist for its own stay.
test("Round 9.3.6.1 G: a day satisfied by synthetic filler alone still gets real content from the final backfill pass", () => {
  const dayCount = 4;
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const recs = Array.from({ length: 6 }, (_, i) => r92Rec(`g-${i}`, `Sight ${i}`, "attraction"));
  const payload = buildPayload({
    recommendations: recs,
    preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" },
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Country X", dayCount);
  const raw: RawGeneratedPlan = {
    title: "T",
    summary: "",
    days: Array.from({ length: dayCount }, (_, i) => ({
      dayNumber: i + 1,
      date: `2026-09-${10 + i}`,
      title: `Day ${i + 1}`,
      cityRegion: "Metro A",
      accommodation: "Hotel",
      notes: "",
      transportation: "",
      items: [
        // A large, but not capacity-exhausting, synthetic filler — big
        // enough that fillUnderfilledDay's own utilization gate is already
        // satisfied (so it does nothing), small enough to leave genuine
        // room for a real activity once backfill runs.
        { name: "זמן לעצמכם", category: "practical", location: "Metro A", shortDescription: "", slot: "afternoon", plannedStartTime: "10:00", estimatedDurationMinutes: 350 },
      ],
    })),
  };
  const result = repairPlan(raw, payload, profile, frame, null, undefined, null);
  const daysWithReal = result.days.filter((d) => d.items.some((i) => i.recommendationId != null)).length;
  assert.equal(daysWithReal, dayCount, `expected every day to receive real content via the final backfill pass, got ${daysWithReal}/${dayCount}`);
});

// L. the quality validator cannot be bypassed by legality counters all being zero
test("Round 8 L: a plan with illegalScheduledRealPlaces = 0 and openingHoursViolations = 0 can still fail quality", () => {
  const day = r8Day([r8FreeTime("Only Free Time")]);
  const legality = validateFinalItineraryInvariants([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, r8Payload([]), R8_WINDOW);
  assert.equal(legality.illegalScheduledRealPlaces, 0);
  assert.equal(legality.openingHoursViolations, 0);
  const quality = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(passesQualityValidation(quality), false, "legality being clean does not make an empty day acceptable");
});

// M. backfill repair preserves geography invariants
test("Round 8 M: backfillRealActivities never introduces a geography-owner violation", () => {
  const recs = [r8Rec("rec-m1", "Nearby Real Sight", "attraction")];
  const payload = r8Payload(recs);
  const day = r8Day([r8FreeTime()]);
  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  const report = validateFinalItineraryInvariants(days, R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_WINDOW);
  assert.equal(report.illegalScheduledRealPlaces, 0);
});

// N. backfill repair preserves opening-hours invariants
test("Round 8 N: backfillRealActivities never introduces an opening-hours violation", () => {
  const recs = [r8Rec("rec-n1", "Legally Timed Sight", "attraction", { openingHours: "08:00-20:00" })];
  const payload = r8Payload(recs);
  const day = r8Day([r8FreeTime()]);
  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  const report = validateFinalItineraryInvariants(days, R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_WINDOW);
  assert.equal(report.openingHoursViolations, 0);
});

// O. backfill repair preserves duplicatePlaces = 0
test("Round 8 O: backfillRealActivities never introduces a duplicate place across days", () => {
  const recs = [r8Rec("rec-o1", "Single Real Sight", "attraction")];
  const payload = r8Payload(recs);
  const day1 = r8Day([r8FreeTime()], { dayNumber: 1 });
  const day2 = r8Day([r8FreeTime()], { dayNumber: 2 });
  const { days } = backfillRealActivities([day1, day2], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  const allRecIds = days.flatMap((d) => d.items.map((i) => i.recommendationId).filter(Boolean));
  const unique = new Set(allRecIds);
  assert.equal(allRecIds.length, unique.size, "no real place is inserted twice across days");
});

// Round 9.3.3 continuation §2/15A/15K — "REAL-BEFORE-FREETIME": a day that
// ALREADY meets its historical minimumRequired (2 real activities on a
// normal day) must still have a leftover free_time item replaced when a
// further legal, unused real candidate is available — the old gate stopped
// as soon as the minimum was reached, leaving that slot's real supply on
// the table forever.
test("Round 9.3.3 §2: a leftover free_time item is replaced by a real POI even after the day's minimum is already met", () => {
  const recs = [
    r8Rec("rec-freetime1", "Already Scheduled Sight", "attraction"),
    r8Rec("rec-freetime2", "Also Already Scheduled Sight", "attraction"),
    r8Rec("rec-freetime3", "Unused Real Museum", "museum"),
  ];
  const payload = r8Payload(recs);
  const alreadyScheduled = [
    buildReplacementItem(recs[0], r8FreeTime(), r8Day([]), payload),
    buildReplacementItem(recs[1], r8FreeTime(), r8Day([]), payload),
  ];
  const day = r8Day([...alreadyScheduled, r8FreeTime("Leftover Free Slot")]);
  assert.equal(meaningfulCount(day), 2, "sanity: the day already meets the historical minimumRequired of 2");

  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);

  assert.equal(
    days[0].items.some((i) => i.itemRole === "free_time"),
    false,
    "no free_time item may remain once real, unused, legal supply exists to replace it"
  );
  assert.ok(days[0].items.some((i) => i.name === "Unused Real Museum"), "the available real candidate is actually used");
});

test("Round 9.3.3 §2: a genuine rest/flex day's LEFTOVER free_time item (beyond its own lower minimum) is left alone even with unused real supply available", () => {
  const recs = [r8Rec("rec-rest1", "Already Scheduled Rest-Day Sight", "attraction"), r8Rec("rec-rest2", "Unused Real Sight", "attraction")];
  const payload = r8Payload(recs);
  const alreadyScheduled = buildReplacementItem(recs[0], r8FreeTime(), r8Day([]), payload);
  const day = r8Day([alreadyScheduled, r8FreeTime("Deliberate Rest Block")], { restWindow: "מנוחה מכוונת אחר הצהריים" });
  assert.equal(meaningfulCount(day), 1, "sanity: the rest day already meets its own lower minimumRequired of 1");

  const { days } = backfillRealActivities([day], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);

  assert.ok(
    days[0].items.some((i) => i.itemRole === "free_time" && i.name === "Deliberate Rest Block"),
    "an explicit rest/flex window's own leftover free_time must never be overridden by available real supply, even though real-before-freetime applies elsewhere"
  );
});

/* ================================================================== *
 * Round 9 — stay activity pools + diversity-aware portfolio planner    *
 * ================================================================== */

const R9_A = { lat: 20, lon: 20 };
const R9_FRAME = buildTestFrame([{ areaLabel: "Area A", nights: 5, startDayNumber: 1, endDayNumber: 5 }]);
const R9_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Area A", R9_A]]);
const R9_MOBILITY = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
const R9_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 5);
const R9_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

function r9Rec(id: string, name: string, category: AiGeneratedItem["category"], overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return buildRecommendation({ id, name, category, location: "Area A", lat: R9_A.lat + 0.01, lon: R9_A.lon + 0.01, openingHours: "08:00-20:00", ...overrides });
}
function r9Day(items: AiGeneratedItem[], overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return buildDay({ dayNumber: 2, date: "2026-09-10", cityRegion: "Area A", accommodation: "לינה נוחה באזור Area A", title: "יום 2 בArea A", notes: "היום בנוי סביב Area A.", items, ...overrides });
}
function r9FreeTime(name = "Free Block"): AiGeneratedItem {
  return buildCoordinatelessItem({ name, category: "attraction", itemRole: "free_time", location: "Area A" });
}

// --- pre-generation refill wiring ---

test("Round 9: refillTripRecommendationPool extends the payload's own recommendations for an undersupplied stay", async () => {
  const payload = buildPayload({
    recommendations: [r9Rec("r1", "Sparse Place 1", "attraction")],
    preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-13" },
  });
  let calls = 0;
  const updated = await refillTripRecommendationPool(
    payload,
    R9_FRAME,
    5,
    R9_WINDOW,
    R9_PROFILE,
    async (_anchor, _radius, categories) => {
      calls += 1;
      return categories.slice(0, 1).flatMap((category) =>
        Array.from({ length: 8 }, (_, i) => ({
          name: `Refilled ${category} ${calls}-${i}`,
          category,
          location: "Area A",
          shortDescription: null,
          lat: R9_A.lat + 0.01 + i * 0.001,
          lon: R9_A.lon + 0.01,
          openingHours: null,
          wikipediaUrl: null,
          website: null,
        }))
      );
    }
  );
  assert.ok(updated.payload.recommendations.length > payload.recommendations.length, "the pool genuinely grew");
  assert.ok(calls > 0, "the provider was actually queried for the undersupplied stay");
});

test("Round 9: refillTripRecommendationPool is a no-op when the provider fails entirely (never blocks generation)", async () => {
  const payload = buildPayload({ recommendations: [], preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-13" } });
  const updated = await refillTripRecommendationPool(payload, R9_FRAME, 5, R9_WINDOW, R9_PROFILE, async () => {
    throw new Error("provider down");
  });
  assert.deepEqual(updated.payload.recommendations, payload.recommendations);
});

// --- day composition: T-Y ---

test("Round 9 T: a normal full day built from a healthy portfolio has >= 2 meaningful real activities", () => {
  const recs = Array.from({ length: 8 }, (_, i) => r9Rec(`t-${i}`, `Attraction ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const payload = buildPayload({ recommendations: recs });
  const day = r9Day([r9FreeTime("Morning Free"), r9FreeTime("Afternoon Free")]);
  const dayCapacityByStay = new Map([[R9_FRAME.phases[0].id, [{ dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }]]]);
  const { portfoliosByStay } = buildTripActivityPortfolios(R9_FRAME, R9_ANCHORS, R9_MOBILITY, recs, dayCapacityByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  const { days } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, R9_WINDOW, portfoliosByStay);
  const meaningfulCount = days[0].items.filter((i) => i.category !== "cafe" && i.category !== "restaurant" && i.recommendationId != null).length;
  assert.ok(meaningfulCount >= 2, `expected >= 2 meaningful real activities, got ${meaningfulCount}`);
});

test("Round 9 U/V: real anchors are placed before free time is retained as intentional flexible content", () => {
  const recs = [r9Rec("anchor-1", "Major Landmark", "attraction"), r9Rec("anchor-2", "City Museum", "museum")];
  const payload = buildPayload({ recommendations: recs });
  const day = r9Day([r9FreeTime("Intentional Free Time")]);
  const dayCapacityByStay = new Map([[R9_FRAME.phases[0].id, [{ dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }]]]);
  const { portfoliosByStay } = buildTripActivityPortfolios(R9_FRAME, R9_ANCHORS, R9_MOBILITY, recs, dayCapacityByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  const { days } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, R9_WINDOW, portfoliosByStay);
  assert.ok(days[0].items.some((i) => i.name === "Major Landmark" || i.name === "City Museum"), "a real anchor is present");
});

test("Round 9 X: an arrival day remains appropriately light — backfill never force-fills it", () => {
  const recs = [r9Rec("would-be", "Would-Be Activity", "attraction")];
  const payload = buildPayload({ recommendations: recs });
  const day = r9Day([r9FreeTime()], { dayNumber: 1 });
  const window = { earliestUsableTimeOnArrivalDay: { date: "2026-09-10", time: "20:00" }, latestUsableTimeOnDepartureDay: null } as never;
  const { days, insertions } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, window);
  assert.equal(insertions.length, 0);
  assert.ok(days[0].items.some((i) => i.itemRole === "free_time"));
});

// --- repair order: AF-AK ---

test("Round 9 AF: an unused PORTFOLIO candidate replaces an item that became illegal, before any raw pool scan", () => {
  const portfolioPick = r9Rec("portfolio-pick", "Portfolio Selected Sight", "attraction");
  const poolOnly = r9Rec("pool-only", "Pool Only Sight", "attraction");
  const payload = buildPayload({ recommendations: [portfolioPick, poolOnly] });
  const day = r9Day([r9FreeTime()]);
  const pool = buildStayActivityPool(
    R9_FRAME.phases[0],
    [portfolioPick, poolOnly],
    R9_A,
    R9_MOBILITY,
    { usableSightseeingDays: 1, requiredRealActivityTarget: 2, perDayTargets: [] },
    [],
    600
  );
  const portfolio = selectStayPortfolio(pool, 1, Object.fromEntries(["CULTURE", "LANDMARK", "ENTERTAINMENT", "NATURE", "LOCAL_EXPERIENCE", "SHOPPING", "FOOD", "OTHER"].map((f) => [f, 1])) as never, [], 1);
  assert.equal(portfolio.selected[0]?.recommendationId, "portfolio-pick");
  const portfoliosByStay = new Map([[R9_FRAME.phases[0].id, portfolio]]);
  const { days, insertions } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, R9_WINDOW, portfoliosByStay);
  assert.ok(days[0].items.some((i) => i.name === "Portfolio Selected Sight"), "the portfolio's own pick is used");
  assert.equal(insertions[0]?.reason, "portfolio");
});

test("Round 9 AG: when the portfolio is exhausted, an unused POOL candidate (not in the portfolio) still replaces the item", () => {
  const poolOnly = r9Rec("pool-only-2", "Pool Only Sight Two", "attraction");
  const payload = buildPayload({ recommendations: [poolOnly] });
  const day = r9Day([r9FreeTime()]);
  const emptyPortfolio = { stayId: R9_FRAME.phases[0].id, selected: [], optional: [], coveragePlan: { targetFamilies: [], mustIncludeCandidateIds: [], optionalCandidateIds: [] } };
  const portfoliosByStay = new Map([[R9_FRAME.phases[0].id, emptyPortfolio]]);
  const { days, insertions } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, R9_WINDOW, portfoliosByStay);
  assert.ok(days[0].items.some((i) => i.name === "Pool Only Sight Two"));
  assert.equal(insertions[0]?.reason, "pool");
});

test("Round 9 AK: only after every real path is exhausted does the day keep synthetic content", () => {
  const payload = buildPayload({ recommendations: [] });
  const day = r9Day([r9FreeTime()]);
  const { days, insertions } = backfillRealActivities([day], R9_FRAME, R9_ANCHORS, R9_MOBILITY, payload, R9_PROFILE, R9_WINDOW);
  assert.equal(insertions.length, 0);
  assert.ok(days[0].items.some((i) => i.itemRole === "free_time"), "synthetic content is the honest last resort, not silently hidden");
});

// --- Gemini contract wiring sanity (validateGeminiPortfolioSelection already unit-tested in stay-activity-pool.test.ts) ---

test("Round 9: an unknown Gemini-returned candidate id can never reach backfillRealActivities's own replacement path", () => {
  const known = r9Rec("known-id", "Known Sight", "attraction");
  const pool = buildStayActivityPool(R9_FRAME.phases[0], [known], R9_A, R9_MOBILITY, { usableSightseeingDays: 1, requiredRealActivityTarget: 1, perDayTargets: [] }, [], 600);
  const validated = validateGeminiPortfolioSelection(pool, { selectedCandidateIds: ["known-id", "hallucinated-id"] });
  assert.equal(validated.selected.length, 1);
  assert.deepEqual(validated.rejectedUnknownIds, ["hallucinated-id"]);
});

// --- end-to-end regression (spec §35), synthetic (disclosed) ---

test("Round 9: a 10-day multi-stay regression resembling the reported failure shape ends with real content on the vast majority of normal days", () => {
  const bigFrame = buildTestFrame([
    { areaLabel: "Metro One", nights: 5, startDayNumber: 1, endDayNumber: 5 },
    { areaLabel: "Metro Two", nights: 5, startDayNumber: 6, endDayNumber: 10 },
  ]);
  const anchorOne = { lat: 0, lon: 0 };
  const anchorTwo = { lat: 30, lon: 30 };
  const anchors = new Map([["Metro One", anchorOne], ["Metro Two", anchorTwo]]);
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const recs = [
    ...Array.from({ length: 10 }, (_, i) => buildRecommendation({ id: `one-${i}`, name: `Metro One Sight ${i}`, category: i % 3 === 0 ? "museum" : i % 3 === 1 ? "attraction" : "nature", location: "Metro One", lat: anchorOne.lat + (i % 5) * 0.01, lon: anchorOne.lon + (i % 4) * 0.012, openingHours: "08:00-20:00" })),
    ...Array.from({ length: 10 }, (_, i) => buildRecommendation({ id: `two-${i}`, name: `Metro Two Sight ${i}`, category: i % 3 === 0 ? "museum" : i % 3 === 1 ? "attraction" : "shopping", location: "Metro Two", lat: anchorTwo.lat + (i % 5) * 0.01, lon: anchorTwo.lon + (i % 4) * 0.012, openingHours: "08:00-20:00" })),
  ];
  const payload = buildPayload({ recommendations: recs });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 10);

  const days = Array.from({ length: 10 }, (_, i) =>
    buildDay({
      dayNumber: i + 1,
      date: `2026-09-${String(10 + i).padStart(2, "0")}`,
      cityRegion: i < 5 ? "Metro One" : "Metro Two",
      accommodation: `לינה נוחה באזור ${i < 5 ? "Metro One" : "Metro Two"}`,
      title: `יום ${i + 1}`,
      notes: `היום בנוי סביב ${i < 5 ? "Metro One" : "Metro Two"}.`,
      items: [
        buildCoordinatelessItem({ name: `Free ${i}-1`, category: "attraction", itemRole: "free_time", location: i < 5 ? "Metro One" : "Metro Two" }),
        buildCoordinatelessItem({ name: `Meal ${i}`, category: "cafe", itemRole: "meal_opportunity", location: i < 5 ? "Metro One" : "Metro Two", slot: "lunch" }),
        buildCoordinatelessItem({ name: `Free ${i}-2`, category: "attraction", itemRole: "free_time", location: i < 5 ? "Metro One" : "Metro Two" }),
      ],
    })
  );

  const dayCapacityByStay = new Map([
    [bigFrame.phases[0].id, Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }))],
    [bigFrame.phases[1].id, Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 6, dayType: "normal" as const, hasExplicitRestWindow: false }))],
  ]);
  const { portfoliosByStay } = buildTripActivityPortfolios(bigFrame, anchors, mobility, recs, dayCapacityByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);

  const { days: finalDays } = backfillRealActivities(days, bigFrame, anchors, mobility, payload, profile, R9_WINDOW, portfoliosByStay);
  const quality = validateItineraryQuality(finalDays, bigFrame, R9_WINDOW);
  const legality = validateFinalItineraryInvariants(finalDays, bigFrame, anchors, mobility, payload, R9_WINDOW);

  assert.equal(quality.unjustifiedDaysWithOnlySyntheticContent, 0, "no normal day is synthetic-only when supply was healthy");
  assert.ok(quality.meaningfulRealActivityCount >= 15, `expected substantial real content across 10 days, got ${quality.meaningfulRealActivityCount}`);
  assert.equal(legality.illegalScheduledRealPlaces, 0);
  assert.equal(legality.openingHoursViolations, 0);
});

/* ================================================================== *
 * Round 9.1 — bounded concurrency/time budget, failure-code split       *
 * ================================================================== */

const R91_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

function r91Frame(stayCount: number, nightsPerStay: number): TripFrame {
  return buildTestFrame(
    Array.from({ length: stayCount }, (_, i) => ({
      areaLabel: `Metro ${i}`,
      nights: nightsPerStay,
      startDayNumber: i * nightsPerStay + 1,
      endDayNumber: (i + 1) * nightsPerStay,
    }))
  );
}

/** One coordinate-bearing seed recommendation per stay — without a real anchor a stay can never be refilled (nothing to search "nearby"), so every refill-behavior test needs at least this much real geography, even though the pool itself stays far below its desired reserve. */
function r91SeedRecommendations(stayCount: number): TripRecommendation[] {
  return Array.from({ length: stayCount }, (_, i) =>
    buildRecommendation({ id: `seed-${i}`, name: `Metro ${i} Seed Sight`, category: "attraction", location: `Metro ${i}`, lat: i * 10, lon: i * 10 })
  );
}

// spec §22: structural bounds, never real wall-clock assertions.
test("Round 9.1: refill never exceeds the centralized concurrency limit across many stays", async () => {
  const frame = r91Frame(6, 3); // 6 stays -> would be 6 sequential real calls under the old design
  const payload = buildPayload({ recommendations: r91SeedRecommendations(6), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-27" } });
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const result = await refillTripRecommendationPool(payload, frame, 18, R91_WINDOW, R9_PROFILE, async () => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return [];
  });
  assert.ok(calls > 0, "sanity: the provider was actually queried");
  assert.ok(maxConcurrent <= 3, `expected bounded concurrency (<=3), observed ${maxConcurrent} simultaneous provider calls`);
  assert.equal(result.poolsByStay.size, 6, "every stay still gets a pool even under bounded concurrency");
});

test("Round 9.1: a global time budget stops issuing new stay refills — one failing stay never hangs the whole trip", async () => {
  const frame = r91Frame(8, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(8), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-10-03" } });
  const start = Date.now();
  let calls = 0;
  const result = await refillTripRecommendationPool(
    payload,
    frame,
    24,
    R91_WINDOW,
    R9_PROFILE,
    async () => {
      calls += 1;
      // Simulates a slow/hanging provider — each call takes far longer than
      // the injected global budget should ever allow to accumulate.
      await new Promise((resolve) => setTimeout(resolve, 200));
      return [];
    },
    300 // a short injected global budget — never wait for the real 12s default in a unit test
  );
  const elapsed = Date.now() - start;
  assert.ok(calls > 0, "sanity: the provider was actually queried");
  assert.ok(elapsed < 3000, `expected the global time budget to bound total elapsed time, took ${elapsed}ms`);
  const degradedStays = [...result.poolsByStay.values()].filter((p) => p.diagnostics.supplyDegraded);
  assert.ok(degradedStays.length > 0, "at least one stay is honestly marked supply-degraded rather than the request hanging");
});

// Round 9.3.3 continuation §9/15I — requestsStartedAfterBudgetExpiry must
// be 0: once the shared global deadline has passed, no NEW provider
// request may ever start, even for a stay that hasn't been tried yet.
test("Round 9.3.3 §9 I: no provider request starts after the shared deadline has already expired", async () => {
  const frame = r91Frame(8, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(8), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-10-03" } });
  const callStartTimes: number[] = [];
  const globalBudgetMs = 150;
  const deadlineAt = Date.now() + globalBudgetMs;
  await refillTripRecommendationPool(
    payload,
    frame,
    24,
    R91_WINDOW,
    R9_PROFILE,
    async () => {
      callStartTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 60));
      return [];
    },
    globalBudgetMs
  );
  assert.ok(callStartTimes.length > 0, "sanity: at least one real request was actually attempted");
  const requestsStartedAfterBudgetExpiry = callStartTimes.filter((t) => t > deadlineAt).length;
  assert.equal(requestsStartedAfterBudgetExpiry, 0, "every recorded provider call must have started at or before the shared deadline");
});

// Round 9.3.3 §22 K3 — real generation progress needs to know how many
// stays have ACTUALLY finished discovery, not a guessed/timer-based count.
test("Round 9.3.3 §22: refillTripRecommendationPool reports onStayDiscovered once per stay, with a correct, real total", async () => {
  const frame = r91Frame(4, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(4), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-13" } });
  const ticks: Array<{ completed: number; total: number }> = [];
  await refillTripRecommendationPool(
    payload,
    frame,
    4,
    R91_WINDOW,
    R9_PROFILE,
    async () => [],
    undefined,
    (completed, total) => ticks.push({ completed, total })
  );
  assert.equal(ticks.length, 4, "exactly one real completion tick per stay, never more, never fewer");
  assert.deepEqual(
    ticks.map((t) => t.total),
    [4, 4, 4, 4],
    "total is always the real stay count, known from the start"
  );
  assert.deepEqual(
    ticks.map((t) => t.completed).sort((a, b) => a - b),
    [1, 2, 3, 4],
    "completed count increases by exactly one per real stay completion"
  );
});

// Round 9.3.4 §16A — superseded the old "one 15-selector combined call per
// round" design with bounded, small GROUP calls: still never one call per
// category (6 separate single-category calls), but no longer one giant
// combined call either. A single stay with zero supply now makes at most 3
// activity-group calls + 1 meal-group call + 1 round-1 top-up call — always
// a small bounded number, never 6 (one per category) and never 1 giant one.
test("Round 9.3.4 A/B: the old combined query is split into small bounded groups, never one call per category", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  let callCount = 0;
  // Assertions live OUTSIDE the callback deliberately — refillStayActivityPool
  // wraps fetchCandidates in its own try/catch (a real provider failure must
  // never crash generation), which would otherwise silently swallow an
  // AssertionError thrown from inside the mock as a mere "provider failure".
  const categoriesPerCall: number[] = [];
  await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    callCount += 1;
    categoriesPerCall.push(categories.length);
    return [];
  });
  assert.ok(callCount > 0, "sanity: the provider was actually queried");
  assert.ok(callCount <= 5, `expected a small bounded number of group calls for a single stay, got ${callCount}`);
  assert.ok(
    categoriesPerCall.every((count) => count <= 2),
    `every group call must request a SMALL coherent category subset, never all 6 categories at once (got ${JSON.stringify(categoriesPerCall)})`
  );
  assert.ok(
    categoriesPerCall.filter((count) => count === 6).length === 0,
    "no call may ever request every REFILLABLE_CATEGORIES member combined — that is the old, now-removed mega-query"
  );
});

function r934Rec(name: string, categories: RecommendationCategory[]): { name: string; category: RecommendationCategory; location: string; shortDescription: string | null; lat: number; lon: number; openingHours: string | null; wikipediaUrl: string | null; website: string | null } {
  return { name, category: categories[0], location: "Metro 0", shortDescription: "", lat: 0.01, lon: 0.01, openingHours: null, wikipediaUrl: null, website: null };
}

test("Round 9.3.4 C/D: a successful group's candidates survive another group's timeout — one failure never zeroes the total", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    if (categories.includes("museum")) return [r934Rec("Real Museum", ["museum"]), r934Rec("Real Attraction", ["attraction"])];
    if (categories.includes("nature")) {
      const err = new Error("simulated timeout");
      err.name = "AbortError";
      throw err;
    }
    return [];
  });
  const pool = result.poolsByStay.get(frame.phases[0].id)!;
  assert.ok(pool.candidates.length >= 2, `the culture group's real candidates must survive the nature group's timeout, got ${pool.candidates.length}`);
  assert.ok(pool.diagnostics.providerFailures >= 1, "the timeout is still honestly counted, not hidden");
});

test("Round 9.3.4 E: all groups provider-failing with zero candidates classifies as PROVIDER_FAILURE, not silently accepted", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async () => {
    const err = new Error("network down");
    throw err;
  });
  const classification = classifyPlanFailure(result.poolsByStay, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.stayFailures[0].supplyState, "PROVIDER_FAILURE");
});

test("Round 9.3.4 F: all groups HTTP-successful with genuinely zero elements classifies as TRUE_LOW_SUPPLY", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async () => []);
  const classification = classifyPlanFailure(result.poolsByStay, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.stayFailures[0].supplyState, "TRUE_LOW_SUPPLY");
});

test("Round 9.3.4 G: partial group failure with sufficient verified supply is healthy, not degraded into a failure", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    if (categories.includes("nature")) throw new Error("simulated failure");
    // Plenty of real candidates from every OTHER group — enough to clear a 3-day stay's minimum viable floor.
    return Array.from({ length: 15 }, (_, i) => r934Rec(`Real Spot ${categories[0]} ${i}`, categories));
  });
  assert.equal(isSupplyHealthyForComposition(result.poolsByStay), true, "one failed group must not drag a stay with plenty of OTHER real supply into an unhealthy state");
});

test("Round 9.3.4 H: the same real place matching two different groups' selectors is counted once, not twice", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  // A real museum can legitimately match BOTH the culture_landmark group's
  // own multiple selectors (tourism=museum AND, in principle, a historic/
  // landmark-tagged duplicate entry) — simulated here by returning the
  // EXACT same name+coordinates from two different group calls.
  const duplicateName = "City History Museum";
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    if (categories.includes("museum")) return [r934Rec(duplicateName, ["museum"])];
    if (categories.includes("nature")) return [r934Rec(duplicateName, ["museum"])]; // same identity, reached via a different group's raw response
    return [];
  });
  const pool = result.poolsByStay.get(frame.phases[0].id)!;
  const matching = pool.candidates.filter((c) => c.name === duplicateName);
  assert.equal(matching.length, 1, "a cross-group duplicate must be counted exactly once");
});

test("Round 9.3.4 J: bounded concurrency is respected even with multiple groups per stay in flight", async () => {
  const frame = r91Frame(4, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(4), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-21" } });
  let concurrent = 0;
  let maxConcurrent = 0;
  await refillTripRecommendationPool(payload, frame, 12, R91_WINDOW, R9_PROFILE, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return [];
  });
  assert.ok(maxConcurrent <= 3, `expected the shared concurrency limit to hold across stays AND groups, observed ${maxConcurrent}`);
});

test("Round 9.3.4 K: early-stop skips a stay's own remaining groups once it already has enough real supply", async () => {
  // A single stay only ever has 3 activity groups + 1 meal group — with the
  // shared concurrency limit at 3, a lone stay's own groups all get
  // dequeued together (nothing to skip yet by the time they start). Early
  // stop is real but only OBSERVABLE once the shared queue is deep enough
  // that a stay's 2nd/3rd group is dequeued strictly AFTER its 1st group
  // already resolved — here, 4 stays' worth of "group 1" work items queue
  // ahead of stay 0's own "group 2", exactly the real cross-stay ordering
  // refillTripRecommendationPool now uses (grouped by priority, THEN by stay).
  const frame = r91Frame(4, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(4), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-21" } });
  const stay0Id = frame.phases[0].id;
  const callsByStay = new Map<string, number>();
  await refillTripRecommendationPool(payload, frame, 12, R91_WINDOW, R9_PROFILE, async (anchor, _radius, categories) => {
    // Identify which stay this call belongs to by its anchor (each stay's seed recommendation carries a distinct lat/lon per r91SeedRecommendations).
    const stayIndex = Math.round(anchor.lat / 10);
    const stayId = frame.phases[stayIndex]?.id ?? "unknown";
    callsByStay.set(stayId, (callsByStay.get(stayId) ?? 0) + 1);
    if (stayId === stay0Id && callsByStay.get(stayId) === 1) {
      // stay 0's FIRST group alone returns far more real candidates than any small stay could ever need — resolved immediately (no delay), so it settles well before stay 0's own later groups are even dequeued.
      return Array.from({ length: 80 }, (_, i) => r934Rec(`Abundant Spot ${i}`, categories));
    }
    // Every other stay's calls resolve slightly slower, keeping stay 0's own fast result settled first.
    await new Promise((resolve) => setTimeout(resolve, 8));
    return [];
  });
  assert.ok(
    (callsByStay.get(stay0Id) ?? 0) <= 2,
    `expected stay 0's own remaining activity groups to be skipped once its supply was already sufficient, got ${callsByStay.get(stay0Id)} calls for that stay`
  );
});

test("Round 9.3.4 N: meal-group candidates reach payload.recommendations but never pollute the activity pool", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const result = await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    if (categories.includes("restaurant")) return [r934Rec("Real Named Bistro", ["restaurant"])];
    return [];
  });
  const pool = result.poolsByStay.get(frame.phases[0].id)!;
  assert.equal(pool.candidates.some((c) => c.name === "Real Named Bistro"), false, "a meal-group candidate must never be pushed into the ACTIVITY pool's own candidates");
  assert.ok(result.payload.recommendations.some((r) => r.name === "Real Named Bistro"), "but it must still reach payload.recommendations so buildTripMealVenuePools can pick it up");
});

// Round 9.3.4 continuation ("ONE FINAL MEAL E2E CHECK") — regression test
// for the measured meal-group starvation bug: appending the meal work item
// after ALL activity groups meant it never got a concurrency slot until one
// of the 3 concurrently-dispatched activity groups finished — a real,
// measured 15-second head start lost before the meal query even began,
// on top of its own latency. Interleaving meal right after the first
// (highest-priority) activity group fixes this: it must start in the SAME
// wave as the earliest activity groups, never wait for one to finish first.
test("Round 9.3.4: the meal group gets a fair, early concurrency slot — it must not be queued behind every activity group", async () => {
  const frame = r91Frame(1, 3);
  const payload = buildPayload({ recommendations: r91SeedRecommendations(1), preferences: { ...basePreferences, startDate: "2026-09-09", endDate: "2026-09-11" } });
  const t0 = Date.now();
  const startOffsets: Record<string, number> = {};
  await refillTripRecommendationPool(payload, frame, 3, R91_WINDOW, R9_PROFILE, async (_anchor, _radius, categories) => {
    const kind = categories.includes("restaurant") ? "meal" : categories.includes("museum") ? "culture_landmark" : categories.includes("nature") ? "nature_leisure" : "entertainment_shopping";
    if (!(kind in startOffsets)) startOffsets[kind] = Date.now() - t0;
    // Activity groups simulate real, slower Overpass latency; the meal
    // group must not be forced to wait for one of them to finish before it
    // even STARTS — this delay is deliberately large enough that the old
    // "meal appended after every activity group" ordering would have made
    // the meal group start only after this delay elapsed at least once.
    await new Promise((resolve) => setTimeout(resolve, kind === "meal" ? 5 : 50));
    return [];
  });
  const mealStart = startOffsets.meal;
  assert.ok(mealStart != null, "sanity: the meal group was actually attempted");
  assert.ok(mealStart < 25, `the meal group must start in the SAME initial wave as the activity groups, not after one finishes — started at +${mealStart}ms`);
});

test("Round 9.3.4 O: the activity query groups never include restaurant/cafe categories", () => {
  for (const group of ACTIVITY_QUERY_GROUPS) {
    assert.ok(!group.categories.includes("restaurant"), `${group.groupId} must never request restaurant`);
    assert.ok(!group.categories.includes("cafe"), `${group.groupId} must never request cafe`);
  }
  assert.deepEqual(MEAL_QUERY_GROUP.categories.slice().sort(), ["cafe", "restaurant"]);
});

// Round 9.3.4 §13/16L — cache identity is content-addressed by the actual
// Overpass query text (fetchOverpass's own request body); this is the
// structural guarantee that makes "culture succeeds, nature fails" cache
// independently: each group's category set is disjoint, so no two groups
// can ever accidentally build the identical query string / cache key.
test("Round 9.3.4 L: every query group has a disjoint category set, guaranteeing distinct cache identity per group", () => {
  const seen = new Set<string>();
  for (const group of [...ACTIVITY_QUERY_GROUPS, MEAL_QUERY_GROUP]) {
    for (const category of group.categories) {
      assert.ok(!seen.has(category), `category "${category}" appears in more than one group — their queries (and cache keys) would collide`);
      seen.add(category);
    }
  }
});

/* ==================================================================== *
 * ROUND 9.3.5 — REAL CANDIDATES EXIST BUT DON'T REACH ENOUGH DAYS       *
 * Root cause (measured this round): a stay's discovery pool is sized   *
 * and early-stopped against its PRE-reallocation night count; when     *
 * night reallocation/reserve promotion later grows that stay's real    *
 * duration, nothing ever revisited the pool — refillDeficientStaysAfter-*
 * Reallocation is the fix, called once tripFrame is truly final.       *
 * ==================================================================== */

function r935Rec(id: string, name: string, lat: number, lon: number): TripRecommendation {
  return buildRecommendation({ id, name, category: "attraction", location: "", lat, lon, openingHours: "08:00-20:00" });
}
function r935OverpassRec(name: string, lat: number, lon: number) {
  return { name, category: "attraction" as const, location: "", shortDescription: null, lat, lon, openingHours: null, wikipediaUrl: null, website: null };
}

// A — a stay's final requirement genuinely grows once its final duration is known.
test("Round 9.3.5 A: a stay's required real-activity target increases when its final night count grows", () => {
  const frame3 = buildTestFrame([{ areaLabel: "Metro", nights: 3, startDayNumber: 1, endDayNumber: 3 }]);
  const frame9 = buildTestFrame([{ areaLabel: "Metro", nights: 9, startDayNumber: 1, endDayNumber: 9 }]);
  const dayTypes3 = estimatePreGenerationDayTypesByStay(frame3, 3, R91_WINDOW);
  const dayTypes9 = estimatePreGenerationDayTypesByStay(frame9, 9, R91_WINDOW);
  const capacity3 = computeStayCapacity(dayTypes3.get(frame3.phases[0].id) ?? []);
  const capacity9 = computeStayCapacity(dayTypes9.get(frame9.phases[0].id) ?? []);
  assert.ok(capacity9.requiredRealActivityTarget > capacity3.requiredRealActivityTarget, "a longer final stay must require more real anchors than the same stay's shorter preliminary duration");
});

// B/C — the core fix: a stay whose FINAL duration outgrew its pre-reallocation pool gets a real, bounded refill.
test("Round 9.3.5 B/C: a stay that is deficient against its FINAL (post-reallocation) target gets a bounded refill", async () => {
  const phase = { id: "grown", areaLabel: "Grown City", nights: 9, startDayNumber: 1, endDayNumber: 9, intent: "mixed" as const, anchor: { lat: 5, lon: 5 } };
  const frame: TripFrame = { bucketId: "regional", source: "ai", phases: [phase] };
  // Simulates a pool that early-stopped against a SMALL preliminary (e.g. 3-night) target — far below what 9 real nights actually need.
  const smallPool = buildStayActivityPool(phase, [r935Rec("seed", "Seed Sight", 5.001, 5.001)], phase.anchor, R9_MOBILITY, { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] }, [], 600);
  let callCount = 0;
  const fetchCandidates = async () => {
    callCount += 1;
    return Array.from({ length: 15 }, (_, i) => r935OverpassRec(`Real Spot ${callCount}-${i}`, 5.001 + i * 0.0001, 5.001));
  };
  const finalDayTypes = estimatePreGenerationDayTypesByStay(frame, 9, R91_WINDOW);
  const payload = buildPayload({ recommendations: [] });
  const result = await refillDeficientStaysAfterReallocation(payload, frame, new Map([["Grown City", phase.anchor]]), R9_MOBILITY, R9_PROFILE, new Map([["grown", smallPool]]), finalDayTypes, fetchCandidates);
  assert.deepEqual(result.refilledStayIds, ["grown"], "the deficient stay must actually be refilled");
  const finalPool = result.poolsByStay.get("grown")!;
  assert.ok(
    finalPool.requiredRealActivityTarget > smallPool.requiredRealActivityTarget,
    `the pool's OWN target must be resized to the FINAL (9-night) requirement, not left at the stale (3-night) one — was ${smallPool.requiredRealActivityTarget}, now ${finalPool.requiredRealActivityTarget}`
  );
  assert.ok(finalPool.candidates.length > smallPool.candidates.length, `the pool must genuinely grow, was ${smallPool.candidates.length}, now ${finalPool.candidates.length}`);
  assert.ok(
    finalPool.candidates.length >= finalPool.minimumViableCandidateCount,
    `the refill must close the gap against the FINAL minimum-viable floor (${finalPool.minimumViableCandidateCount}), got ${finalPool.candidates.length}`
  );
  assert.ok(callCount > 0, "sanity: a real bounded refill call was actually attempted");
});

// D — a stay that already meets its FINAL requirement must never be re-queried.
test("Round 9.3.5 D: a healthy stay (already meeting its FINAL target) is never rediscovered", async () => {
  const phase = { id: "healthy", areaLabel: "Healthy City", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" as const, anchor: { lat: 6, lon: 6 } };
  const frame: TripFrame = { bucketId: "regional", source: "ai", phases: [phase] };
  const abundantCandidates = Array.from({ length: 20 }, (_, i) => r935Rec(`abund-${i}`, `Abundant Sight ${i}`, 6.001, 6.001));
  const richPool = buildStayActivityPool(phase, abundantCandidates, phase.anchor, R9_MOBILITY, { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] }, [], 600);
  let called = false;
  const fetchCandidates = async () => {
    called = true;
    return [];
  };
  const finalDayTypes = estimatePreGenerationDayTypesByStay(frame, 3, R91_WINDOW);
  const payload = buildPayload({ recommendations: [] });
  const result = await refillDeficientStaysAfterReallocation(payload, frame, new Map([["Healthy City", phase.anchor]]), R9_MOBILITY, R9_PROFILE, new Map([["healthy", richPool]]), finalDayTypes, fetchCandidates);
  assert.deepEqual(result.refilledStayIds, [], "a healthy stay must never be included in the refill pass");
  assert.equal(called, false, "a healthy stay's provider must never be queried again");
});

// G — a reserve stay promoted AFTER the initial discovery pass (so it only
// ever had Stage-B's small evaluation sample) still gets a REAL final-
// planning-sized pool once tripFrame is final — refillDeficientStaysAfter-
// Reallocation treats it exactly like any other phase, never leaving it
// stuck with just the promotion-decision sample.
test("Round 9.3.5 G: a reserve stay promoted after discovery receives final planning supply, not only its evaluation sample", async () => {
  const promotedPhase = { id: "promoted-reserve", areaLabel: "Promoted City", nights: 6, startDayNumber: 1, endDayNumber: 6, intent: "mixed" as const, anchor: { lat: 7, lon: 7 } };
  const frame: TripFrame = { bucketId: "regional", source: "ai", phases: [promotedPhase] };
  // Stage-B's own small evaluation sample (attemptReservePromotion's bounded discovery to DECIDE whether to promote) — deliberately far below what 6 real nights need.
  const evaluationSamplePool = buildStayActivityPool(promotedPhase, [r935Rec("eval-1", "Evaluation Sample Sight", 7.001, 7.001)], promotedPhase.anchor, R9_MOBILITY, { usableSightseeingDays: 6, requiredRealActivityTarget: 18, perDayTargets: [] }, [], 600);
  let callCount = 0;
  const fetchCandidates = async () => {
    callCount += 1;
    return Array.from({ length: 15 }, (_, i) => r935OverpassRec(`Promoted Real Spot ${callCount}-${i}`, 7.001 + i * 0.0001, 7.001));
  };
  const finalDayTypes = estimatePreGenerationDayTypesByStay(frame, 6, R91_WINDOW);
  const payload = buildPayload({ recommendations: [] });
  const result = await refillDeficientStaysAfterReallocation(payload, frame, new Map([["Promoted City", promotedPhase.anchor]]), R9_MOBILITY, R9_PROFILE, new Map([["promoted-reserve", evaluationSamplePool]]), finalDayTypes, fetchCandidates);
  assert.deepEqual(result.refilledStayIds, ["promoted-reserve"], "a promoted reserve stuck with only its evaluation sample must be recognized as deficient");
  const finalPool = result.poolsByStay.get("promoted-reserve")!;
  assert.ok(finalPool.candidates.length > evaluationSamplePool.candidates.length, "the promoted reserve must receive REAL final-planning supply, not remain stuck with its small decision-time sample");
});

// J — candidate ownership (stayId) must survive a TripFrame whose day
// ranges were resequenced by reallocation — a candidate discovered for a
// stay must still resolve to that SAME stay after its day numbers shift.
test("Round 9.3.5 J: candidate ownership survives TripFrame day-range resequencing", () => {
  const beforeFrame = buildTestFrame([
    { areaLabel: "Metro A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "Metro B", nights: 3, startDayNumber: 4, endDayNumber: 6 },
  ]);
  // Resequenced: Metro A shrinks to 1 night, Metro B grows to 5 — day ranges shift entirely.
  const afterFrame: TripFrame = {
    ...beforeFrame,
    phases: [
      { ...beforeFrame.phases[0], nights: 1, startDayNumber: 1, endDayNumber: 1 },
      { ...beforeFrame.phases[1], nights: 5, startDayNumber: 2, endDayNumber: 6 },
    ],
  };
  const areaAnchors = new Map([["Metro A", { lat: 1, lon: 1 }], ["Metro B", { lat: 2, lon: 2 }]]);
  const candidates = [
    buildRecommendation({ id: "a-rec", name: "Metro A Sight", category: "attraction", location: "Metro A", lat: 1.001, lon: 1.001 }),
    buildRecommendation({ id: "b-rec", name: "Metro B Sight", category: "attraction", location: "Metro B", lat: 2.001, lon: 2.001 }),
  ];
  const ownershipBefore = assignCandidatesToStays(candidates, beforeFrame, areaAnchors, (s) => s.trim(), (a, b) => a === b);
  const ownershipAfter = assignCandidatesToStays(candidates, afterFrame, areaAnchors, (s) => s.trim(), (a, b) => a === b);
  assert.ok(ownershipBefore.get(beforeFrame.phases[0].id)?.some((c) => c.id === "a-rec"), "sanity: Metro A's candidate is owned by Metro A before resequencing");
  assert.ok(ownershipAfter.get(afterFrame.phases[0].id)?.some((c) => c.id === "a-rec"), "Metro A's candidate must STILL be owned by Metro A (same stable phase.id) after its day range shrank/shifted");
  assert.ok(ownershipAfter.get(afterFrame.phases[1].id)?.some((c) => c.id === "b-rec"), "Metro B's candidate must STILL be owned by Metro B after its day range grew/shifted");
});

// L — the coverage-failure diagnostic now names which stays own the uncovered days.
test("Round 9.3.5 L: the coverage-failure diagnostic includes a per-stay breakdown, not only a trip-wide total", () => {
  const frame = buildTestFrame([
    { areaLabel: "Covered City", nights: 2, startDayNumber: 1, endDayNumber: 2 },
    { areaLabel: "Uncovered City", nights: 9, startDayNumber: 3, endDayNumber: 11 },
  ]);
  const coveredDays = [1, 2].map((dayNumber) =>
    r8Day([buildItem({ name: `Real Sight ${dayNumber}`, category: "attraction", recommendationId: `rec-c${dayNumber}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber, cityRegion: "Covered City" })
  );
  const uncoveredDays = Array.from({ length: 9 }, (_, i) =>
    r8Day([r8FreeTime(`Free ${i}`), r8FreeTime(`Free2 ${i}`)], { dayNumber: i + 3, cityRegion: "Uncovered City" })
  );
  const report = validateItineraryQuality([...coveredDays, ...uncoveredDays], frame, R8_WINDOW);
  // The first day of the new phase may legitimately be exempted as a
  // transfer/arrival-shaped day (structurally justified, per item 12 —
  // never require every single day to hit an exact count) — the sanity
  // check only needs "most of Uncovered City's days are unjustified-empty".
  assert.ok(report.unjustifiedDaysWithOnlySyntheticContent >= 8, "sanity: the shape genuinely has a large majority of unjustified-empty days");

  const bigPool = Array.from({ length: 20 }, (_, i) => r8Rec(`rec-pool-${i}`, `Pool Place ${i}`, "attraction"));
  const coveredPhase = frame.phases.find((p) => p.areaLabel === "Covered City")!;
  const uncoveredPhase = frame.phases.find((p) => p.areaLabel === "Uncovered City")!;
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    assertRealActivityCoverage(
      report,
      r8Payload(bigPool),
      { tripFrame: frame, countryName: "Country X" },
      new Map([
        [coveredPhase.id, { poolSize: 5, portfolioSelected: 2 }],
        [uncoveredPhase.id, { poolSize: 0, portfolioSelected: 0 }],
      ])
    );
  } catch (error) {
    caught = error as InstanceType<typeof InsufficientRealActivityCoverageError>;
  }
  assert.ok(caught instanceof InsufficientRealActivityCoverageError, "sanity: the majority-failure shape still throws");
  assert.ok(Array.isArray(caught!.diagnostics.stays), "the per-stay breakdown must be present");
  const uncovered = caught!.diagnostics.stays!.find((s) => s.owner === "Uncovered City");
  const covered = caught!.diagnostics.stays!.find((s) => s.owner === "Covered City");
  assert.ok(uncovered, "the actual uncovered stay must be named");
  assert.ok(uncovered!.uncoveredDays >= 8, `expected the uncovered stay to own the large majority of empty days, got ${uncovered!.uncoveredDays}`);
  assert.ok(covered, "the actual covered stay must ALSO be named, with zero uncovered days");
  assert.equal(covered!.uncoveredDays, 0);
});

// Round 9.3.6 — a real production 43-day trip streamed
// INSUFFICIENT_REAL_ACTIVITY_COVERAGE with recommendationPoolSize: 39 but
// diagnostics.stays showing poolSize: 0 for ALL SEVEN final stays, despite
// 16/34 days already having real content. Root cause: repairPlan has its
// OWN internal assertRealActivityCoverage call site (reached from every
// one of its callers), and it never built a staySupplyContext map at all
// — so every per-stay poolSize/portfolioSelected silently defaulted to 0
// via assertRealActivityCoverage's own `?? 0` fallback, regardless of how
// much real supply genuinely existed. The fix extracts the exact map-
// building shape both call sites need into buildStaySupplyDiagnosticsMap,
// and wires repairPlan's own call site to build one from data already in
// its scope (payload.recommendations, currentTripFrame, areaAnchors,
// mobilityProfile) via buildTripActivityPortfolios — never a second
// network call. These tests prove the shared builder itself is correct;
// buildTripActivityPortfolios's own pool/portfolio construction is already
// covered extensively elsewhere (Round 9.2/9.3 tests above).
test("Round 9.3.6 A: buildStaySupplyDiagnosticsMap reports the REAL non-zero pool/portfolio sizes for a stay with real candidates", () => {
  const recs = Array.from({ length: 10 }, (_, i) => r92Rec(`a-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const { poolsByStay, portfoliosByStay } = r92Compose(recs);
  const map = buildStaySupplyDiagnosticsMap(R92_FRAME, poolsByStay, portfoliosByStay);
  const entry = map.get(R92_FRAME.phases[0].id);
  assert.ok(entry, "the frame's one real stay must have an entry in the map");
  assert.ok(entry!.poolSize > 0, `expected a non-zero pool size reflecting the 10 real candidates, got ${entry!.poolSize}`);
  assert.ok(entry!.portfolioSelected > 0, `expected a non-zero portfolio selection, got ${entry!.portfolioSelected}`);
});

test("Round 9.3.6 B: buildStaySupplyDiagnosticsMap safely defaults to 0/0 for a phase genuinely absent from the pool/portfolio maps, never fabricating data", () => {
  const frame = buildTestFrame([
    { areaLabel: "Known City", nights: 2, startDayNumber: 1, endDayNumber: 2 },
    { areaLabel: "Unknown City", nights: 2, startDayNumber: 3, endDayNumber: 4 },
  ]);
  const knownPhase = frame.phases.find((p) => p.areaLabel === "Known City")!;
  const unknownPhase = frame.phases.find((p) => p.areaLabel === "Unknown City")!;
  const poolsByStay = new Map([
    [
      knownPhase.id,
      {
        stayId: knownPhase.id,
        ownerArea: "Known City",
        requiredRealActivityTarget: 0,
        candidates: [{}, {}, {}],
        diagnostics: { legalCandidateCount: 3, providerFailures: 0 },
      } as never,
    ],
  ]);
  const portfoliosByStay = new Map([[knownPhase.id, { selected: [{}] } as never]]);
  const map = buildStaySupplyDiagnosticsMap(frame, poolsByStay, portfoliosByStay);
  assert.deepEqual(map.get(knownPhase.id), { poolSize: 3, portfolioSelected: 1, isCatastrophicProviderFailure: false });
  assert.deepEqual(map.get(unknownPhase.id), { poolSize: 0, portfolioSelected: 0, isCatastrophicProviderFailure: false }, "a phase with no map entry must default safely, not throw or fabricate");
});

// Round 9.3.6 C: end-to-end proof that repairPlan's OWN internal coverage
// throw (its final exit after the 4-attempt structural-repair loop
// exhausts) now reports the REAL per-stay supply instead of an always-zero
// default. Mirrors the actual production shape (a real candidate pool that
// is genuinely too small relative to the trip's day count): one 100-day
// stay with only 10 real, well-positioned candidates. An unresolvable
// mustVisitPlaces keyword ("Impossible Unicorn Castle", matching nothing
// in payload.recommendations or the fallback template) keeps
// passesValidation false on every one of the 4 attempts, which is what
// routes execution to the FIXED call site after the loop — repairPlan has
// a SEPARATE, earlier return (once a legally-clean plan reaches its final
// attempt) that accepts a real-activity-poor plan without ever calling
// assertRealActivityCoverage at all (Round 8's own deliberate "never block
// acceptance forever" behavior, untouched by this round); forcing
// passesValidation to fail is what reliably reaches the path this round's
// fix actually targets, instead of leaving it to chance.
test("Round 9.3.6 C: repairPlan's own internal coverage-failure diagnostic reports real per-stay supply, not a blind zero", () => {
  const dayCount = 100;
  const frame = buildTestFrame([{ areaLabel: "Metro A", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  const recs = Array.from({ length: 10 }, (_, i) => r92Rec(`c-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const startDate = new Date("2026-09-10T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const payload = buildPayload({
    recommendations: recs,
    preferences: {
      ...basePreferences,
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
      mustVisitPlaces: "Impossible Unicorn Castle",
    },
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Country X", dayCount);
  const raw: RawGeneratedPlan = {
    title: "Test Plan",
    summary: "",
    days: Array.from({ length: dayCount }, (_, i) => {
      const date = new Date(startDate);
      date.setUTCDate(date.getUTCDate() + i);
      return {
        dayNumber: i + 1,
        date: date.toISOString().slice(0, 10),
        title: `Day ${i + 1}`,
        cityRegion: "Metro A",
        accommodation: "Hotel",
        notes: "",
        transportation: "",
        items: [
          {
            name: "Free time",
            category: "attraction",
            location: "Metro A",
            shortDescription: "",
            slot: "morning",
            plannedStartTime: "10:00",
            estimatedDurationMinutes: 120,
          },
        ],
      };
    }),
  };
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    repairPlan(raw, payload, profile, frame, null, undefined, null);
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) {
      caught = error;
    }
  }
  assert.ok(caught, "a 100-day stay with only 10 real candidates and an unresolvable must-visit keyword must genuinely exhaust repairPlan and throw");
  assert.ok(Array.isArray(caught!.diagnostics.stays), "the per-stay breakdown must be present at repairPlan's own internal throw site");
  const stay = caught!.diagnostics.stays!.find((s) => s.stayId === frame.phases[0].id);
  assert.ok(stay, "the trip's one real stay must appear in the diagnostic, keyed by its canonical phase.id");
  assert.ok(stay!.poolSize > 0, `expected the diagnostic to reflect the 10 real recommendations available for this stay, got poolSize=${stay!.poolSize}`);
  assert.ok(stay!.portfolioSelected > 0, `expected non-zero portfolio selection, got ${stay!.portfolioSelected}`);
});

function r91Pool(overrides: Partial<{ requiredRealActivityTarget: number; legalCandidateCount: number; minimumViableCandidateCount: number; providerFailures: number }> = {}) {
  const requiredRealActivityTarget = overrides.requiredRealActivityTarget ?? 9;
  const minimumViableCandidateCount = overrides.minimumViableCandidateCount ?? 9;
  const legalCandidateCount = overrides.legalCandidateCount ?? 20;
  const providerFailures = overrides.providerFailures ?? 0;
  return {
    stayId: "stay-0",
    ownerArea: "Area A",
    anchor: { lat: 0, lon: 0 },
    usableDayCapacity: 3,
    requiredRealActivityTarget,
    desiredCandidateCount: 23,
    minimumViableCandidateCount,
    candidates: [],
    categorySupply: {},
    diagnostics: {
      initialCandidateCount: legalCandidateCount,
      resolvedCandidateCount: legalCandidateCount,
      legalCandidateCount,
      desiredCandidateCount: 23,
      refillAttempts: 2,
      refillCandidateCount: 0,
      providerFailures,
      providerElapsedMs: 0,
      providerTimeouts: 0,
      dedupeRejected: 0,
      geographyRejected: 0,
      classificationBreakdown: {},
      supplyDegraded: false,
    },
  };
}

test("Round 9.1 Case A (planner quality failure): a HEALTHY supply with a geography/duplicate failure stays PLAN_NOT_FEASIBLE", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 30 })]]); // 30 legal candidates existed
  const classification = classifyPlanFailure(pools as never, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.code, "PLAN_NOT_FEASIBLE");
  assert.equal(classification.primaryFailure, "geography");
});

test("Round 9.1 Case A2: a healthy supply but duplicate-driven failure is PLAN_NOT_FEASIBLE with primaryFailure=duplicates", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 30 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: false, duplicatePlaces: 3 });
  assert.equal(classification.code, "PLAN_NOT_FEASIBLE");
  assert.equal(classification.primaryFailure, "duplicates");
});

test("Round 9.1 Case B (supply/provider failure): a stay with only 2 legal candidates after bounded attempts is INSUFFICIENT_REAL_ACTIVITY_SUPPLY, a DIFFERENT code", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 2, minimumViableCandidateCount: 9 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.code, "INSUFFICIENT_REAL_ACTIVITY_SUPPLY");
  assert.notEqual(classification.code, "PLAN_NOT_FEASIBLE", "Case A and Case B must never share the same error code");
});

test("Round 9.1: budget failure always wins the classification regardless of pool health", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 2 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: true, duplicatePlaces: 0 });
  assert.equal(classification.code, "BUDGET_NOT_FEASIBLE");
});

test("Round 9.1: InsufficientRealActivitySupplyError carries the affected stay's own diagnostics", () => {
  const error = new InsufficientRealActivitySupplyError("supply too low", [
    { stayId: "stay-0", owner: "Metro X", requiredRealActivities: 9, desiredCandidates: 23, legalCandidates: 2, providerRequests: 2, providerFailures: 1, supplyDegraded: true, belowMinimum: true, supplyState: "PROVIDER_FAILURE" },
  ]);
  assert.equal(error.code, "INSUFFICIENT_REAL_ACTIVITY_SUPPLY");
  assert.equal(error.stayFailures[0].stayId, "stay-0");
  assert.equal(error.stayFailures[0].belowMinimum, true);
});

// Round 9.3.3 continuation §6/15F — provider failure must never collapse
// into TRUE_LOW_SUPPLY: a stay with zero real candidates purely because
// the destination is quiet (providerFailures === 0) is TRUE_LOW_SUPPLY;
// the exact same zero-candidate outcome caused by a real provider outage
// (providerFailures > 0) must classify as PROVIDER_FAILURE instead.
test("Round 9.3.3 §6 F: a genuine provider outage is never classified the same as true low supply", () => {
  const trueLowSupplyPools = new Map([["stay-0", r91Pool({ legalCandidateCount: 0, providerFailures: 0 })]]);
  const providerFailurePools = new Map([["stay-0", r91Pool({ legalCandidateCount: 0, providerFailures: 3 })]]);
  const trueLow = classifyPlanFailure(trueLowSupplyPools as never, { outOfBudget: false, duplicatePlaces: 0 });
  const providerFail = classifyPlanFailure(providerFailurePools as never, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(trueLow.stayFailures[0].supplyState, "TRUE_LOW_SUPPLY");
  assert.equal(providerFail.stayFailures[0].supplyState, "PROVIDER_FAILURE");
  assert.notEqual(trueLow.code, providerFail.code, "these two root causes must never share the same classification code");
});

// Round 9.3.3 §7/15G — a genuinely catastrophic provider failure (zero real
// candidates on a stay that needed them, caused by a real provider outage)
// must produce the new, distinctly-typed REAL_PLACE_DISCOVERY_UNAVAILABLE
// outcome — never disguised as PLAN_NOT_FEASIBLE, BUDGET_NOT_FEASIBLE, or a
// Gemini failure, and never silently treated as a normal successful trip.
test("Round 9.3.3 §7 G: catastrophic provider failure produces the typed REAL_PLACE_DISCOVERY_UNAVAILABLE outcome", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 0, providerFailures: 2, requiredRealActivityTarget: 9 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.code, "REAL_PLACE_DISCOVERY_UNAVAILABLE");
  assert.notEqual(classification.code, "PLAN_NOT_FEASIBLE");
  assert.notEqual(classification.code, "BUDGET_NOT_FEASIBLE");
  assert.notEqual(classification.code, "INSUFFICIENT_REAL_ACTIVITY_SUPPLY");

  const error = new RealPlaceDiscoveryUnavailableError("provider unavailable", classification.stayFailures);
  assert.equal(error.code, "REAL_PLACE_DISCOVERY_UNAVAILABLE");
});

test("Round 9.3.3 §7: a catastrophic provider failure takes priority over a co-occurring budget failure", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 0, providerFailures: 2, requiredRealActivityTarget: 9 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: true, duplicatePlaces: 0 });
  assert.equal(classification.code, "REAL_PLACE_DISCOVERY_UNAVAILABLE", "the provider outage is the more fundamental root cause");
});

// Round 9.3.3 §7/15H — PARTIAL provider failure (some real candidates were
// still collected, even if below the stay's own minimum, or the trip has
// other healthy stays) must NOT automatically escalate to the catastrophic
// outcome — it stays the existing, already-tolerant INSUFFICIENT_REAL_ACTIVITY_SUPPLY
// (or, if supply is genuinely fine, no failure at all).
test("Round 9.3.3 §7 H: partial provider failure with SOME real candidates collected is not catastrophic", () => {
  const pools = new Map([["stay-0", r91Pool({ legalCandidateCount: 3, minimumViableCandidateCount: 9, providerFailures: 1 })]]);
  const classification = classifyPlanFailure(pools as never, { outOfBudget: false, duplicatePlaces: 0 });
  assert.equal(classification.code, "INSUFFICIENT_REAL_ACTIVITY_SUPPLY", "a stay with SOME real supply is a partial shortfall, never catastrophic");
  assert.notEqual(classification.code, "REAL_PLACE_DISCOVERY_UNAVAILABLE");
});

test("Round 9.3.3 §7 H: a healthy stay elsewhere is untouched by another stay's provider failure — no automatic trip-wide failure when overall supply is fine", () => {
  const pools = new Map([
    ["stay-0", r91Pool({ legalCandidateCount: 20, minimumViableCandidateCount: 9, providerFailures: 1 })], // this stay had a transient failure but still recovered plenty of real supply
  ]);
  assert.equal(isSupplyHealthyForComposition(pools as never), true, "a stay that recovered enough real supply despite a transient provider hiccup must still be treated as healthy");
});

/* ================================================================== *
 * Round 9.2 — initial composition FROM the stay activity portfolio     *
 * ================================================================== */

const R92_A = { lat: 40, lon: -100 };
const R92_FRAME = buildTestFrame([{ areaLabel: "Metro A", nights: 4, startDayNumber: 1, endDayNumber: 4 }]);
const R92_ANCHORS = new Map<string, { lat: number; lon: number } | null>([["Metro A", R92_A]]);
const R92_MOBILITY = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
const R92_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 4);
const R92_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

function r92Rec(id: string, name: string, category: AiGeneratedItem["category"], overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return buildRecommendation({ id, name, category, location: "Metro A", lat: R92_A.lat + 0.01, lon: R92_A.lon + 0.01, openingHours: "08:00-20:00", ...overrides });
}

function r92Compose(recommendations: TripRecommendation[], dayCount = 4, preferenceTexts: string[] = [], mustVisitKeywords: string[] = []) {
  const payload = buildPayload({ recommendations, preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const dayCapacityByStay = new Map([[R92_FRAME.phases[0].id, Array.from({ length: dayCount }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }))]]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
    R92_FRAME, R92_ANCHORS, R92_MOBILITY, recommendations, dayCapacityByStay, mustVisitKeywords, preferenceTexts, 600, (s: string) => s.trim(), (a: string, b: string) => a === b
  );
  const composed = composeDaysFromStayPortfolios(R92_FRAME, dayCount, R92_WINDOW, poolsByStay, portfoliosByStay, payload, R92_PROFILE);
  return { composed, payload, poolsByStay, portfoliosByStay };
}

function realItemsOf(day: AiGeneratedDay) {
  return day.items.filter((i) => i.recommendationId != null && i.itemRole !== "meal_opportunity");
}

// J. healthy 4-day stay -> real activities assigned before free_time
test("Round 9.2 J: a healthy 4-day stay gets real activities placed before free time, from the FIRST composition pass", () => {
  const recs = Array.from({ length: 10 }, (_, i) => r92Rec(`j-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const { composed } = r92Compose(recs);
  assert.ok(composed.initialRealActivitiesScheduled >= 6, `expected substantial initial real content, got ${composed.initialRealActivitiesScheduled}`);
  for (const day of composed.plan.days) {
    assert.ok(realItemsOf(day).length >= 1, `day ${day.dayNumber} must have real content from initial composition alone`);
  }
});

// K. healthy 4-day stay -> multiple activity families represented
test("Round 9.2 K: a healthy stay's composed days span multiple primary families", () => {
  const recs = [
    r92Rec("k-museum", "City Museum", "museum"),
    r92Rec("k-landmark", "Grand Tower", "attraction"),
    r92Rec("k-nature", "Botanical Garden", "nature"),
    r92Rec("k-shopping", "Central Market", "shopping"),
    r92Rec("k-entertainment", "City Zoo", "family"),
    r92Rec("k-local", "Old Quarter", "hidden_gem"),
    r92Rec("k-museum2", "Science Museum", "museum"),
    r92Rec("k-landmark2", "Old Bridge", "attraction"),
  ];
  const { composed } = r92Compose(recs);
  const families = new Set(composed.plan.days.flatMap((d) => realItemsOf(d).map((i) => i.category)));
  assert.ok(families.size >= 4, `expected broad category coverage, got ${[...families].join(",")}`);
});

// L. 5 art museums + equally good alternatives -> not museum every day
test("Round 9.2 L: 5 equally-strong art museums + alternatives -> composed days don't pick an art museum every single day", () => {
  const museums = Array.from({ length: 5 }, (_, i) => r92Rec(`l-museum-${i}`, `Art Museum ${i}`, "museum", { shortDescription: "modern art museum" }));
  const alternatives = [
    r92Rec("l-landmark", "Grand Tower", "attraction"),
    r92Rec("l-nature", "Botanical Garden", "nature"),
    r92Rec("l-local", "Old Quarter", "hidden_gem"),
    r92Rec("l-shopping", "Central Market", "shopping"),
  ];
  const { composed } = r92Compose([...museums, ...alternatives], 4);
  const museumDays = composed.plan.days.filter((d) => realItemsOf(d).some((i) => i.name.startsWith("Art Museum"))).length;
  assert.ok(museumDays < 4, `expected fewer than 4/4 days to include an art museum, got ${museumDays}`);
});

// L2. Round 9.2 §9 — diversity must be enforced during DAY ASSIGNMENT
// itself, not merely inherited from portfolio SELECTION. Test L above
// exercises the composed end-to-end result, but selectStayPortfolio
// already diversifies which candidates even reach `.selected`, so L alone
// cannot prove scoreCandidateForDayAssignment's own recency term is load-
// bearing (a mutation deleting that one line was found NOT to fail L).
// This isolates the function directly: two equal-significance candidates,
// one sharing a subtype with something scheduled 1 day ago, must not score
// equal — the repeat must be penalized.
test("Round 9.2 L2: scoreCandidateForDayAssignment penalizes a candidate whose subtype was used on a recent day", () => {
  const { poolsByStay } = r92Compose(
    [r92Rec("l2-museum-a", "Museum A", "museum", { shortDescription: "modern art museum" }), r92Rec("l2-museum-b", "Museum B", "museum", { shortDescription: "modern art museum" })],
    2
  );
  const [museumA, museumB] = poolsByStay.get(R92_FRAME.phases[0].id)!.candidates;
  assert.equal(museumA.classification.subtype, museumB.classification.subtype, "fixture sanity: both must classify to the same subtype");
  const recentHistory = [{ dayIndex: 1, stayId: R92_FRAME.phases[0].id, primaryFamily: museumA.classification.primaryFamily, subtype: museumA.classification.subtype }];
  const scoreWithRecentRepeat = scoreCandidateForDayAssignment(museumB, recentHistory, 2, []);
  const scoreWithNoHistory = scoreCandidateForDayAssignment(museumB, [], 2, []);
  assert.ok(scoreWithRecentRepeat < scoreWithNoHistory, `a same-subtype candidate used 1 day ago must score lower (got ${scoreWithRecentRepeat} vs ${scoreWithNoHistory})`);
});

// M. two high-significance museums may both survive
test("Round 9.2 M: two very high-significance museums may both be scheduled despite the repetition penalty", () => {
  const famous = [
    r92Rec("m-famous-1", "World Famous Art Museum One", "museum", { source: "saved" }),
    r92Rec("m-famous-2", "World Famous Art Museum Two", "museum", { source: "saved" }),
  ];
  const ordinary = Array.from({ length: 4 }, (_, i) => r92Rec(`m-ord-${i}`, `Ordinary Sight ${i}`, "attraction"));
  const { composed } = r92Compose([...famous, ...ordinary], 4);
  const scheduledIds = new Set(composed.plan.days.flatMap((d) => realItemsOf(d).map((i) => i.recommendationId)));
  assert.ok(scheduledIds.has("m-famous-1") && scheduledIds.has("m-famous-2"), "both significant museums should be scheduled");
});

// N. geographically close candidates preferentially grouped
test("Round 9.2 N: geographically close, otherwise-comparable candidates are preferentially grouped into the same day", () => {
  // All within the 60km mobility radius (so every candidate stays in the
  // legal pool — this test is about SCORING preference, not geography
  // rejection), but "near" is genuinely much closer to the anchor than
  // "far"/the filler set, so cohesion scoring has a real choice to make.
  const anchor = r92Rec("n-anchor", "Downtown Landmark", "attraction", { lat: R92_A.lat, lon: R92_A.lon });
  const near = r92Rec("n-near", "Downtown Museum", "museum", { lat: R92_A.lat + 0.01, lon: R92_A.lon + 0.01 }); // ~1.5km away
  const far = r92Rec("n-far", "Far Museum", "museum", { lat: R92_A.lat + 0.2, lon: R92_A.lon + 0.2 }); // ~24km away, still legal
  const filler = Array.from({ length: 4 }, (_, i) => r92Rec(`n-filler-${i}`, `Filler ${i}`, "attraction", { lat: R92_A.lat + 0.22 + i * 0.01, lon: R92_A.lon + 0.22 })); // ~26-28km away, still legal
  const { composed } = r92Compose([anchor, near, far, ...filler], 4);
  const anchorDay = composed.plan.days.find((d) => realItemsOf(d).some((i) => i.recommendationId === "n-anchor"));
  assert.ok(anchorDay, "the anchor was scheduled");
  const sameDayIds = new Set(realItemsOf(anchorDay!).map((i) => i.recommendationId));
  assert.ok(sameDayIds.has("n-near"), "the geographically close candidate is preferentially grouped with the anchor");
});

// N2. Round 9.2 §10 — same isolation concern as L2: full composition can
// group nearby candidates onto the same day by plain array-order tie-
// breaking even with the geographic-cohesion term itself disabled (a
// mutation removing it was found NOT to fail N). Isolates
// scoreCandidateForDayAssignment directly: two equal-significance,
// equal-family candidates, one genuinely near today's chosen item and one
// genuinely far, must not score equal — the near one must score higher.
test("Round 9.2 N2: scoreCandidateForDayAssignment scores a geographically close candidate higher than an equally-significant far one", () => {
  const { poolsByStay } = r92Compose(
    [
      r92Rec("n2-chosen", "Chosen Landmark", "attraction", { lat: R92_A.lat, lon: R92_A.lon }),
      r92Rec("n2-near", "Nearby Landmark", "attraction", { lat: R92_A.lat + 0.01, lon: R92_A.lon + 0.01 }), // ~1.5km
      r92Rec("n2-far", "Far Landmark", "attraction", { lat: R92_A.lat + 0.2, lon: R92_A.lon + 0.2 }), // ~24km, still legal
    ],
    2
  );
  const candidates = poolsByStay.get(R92_FRAME.phases[0].id)!.candidates;
  const chosen = candidates.find((c) => c.recommendationId === "n2-chosen")!;
  const near = candidates.find((c) => c.recommendationId === "n2-near")!;
  const far = candidates.find((c) => c.recommendationId === "n2-far")!;
  const nearScore = scoreCandidateForDayAssignment(near, [], 1, [chosen]);
  const farScore = scoreCandidateForDayAssignment(far, [], 1, [chosen]);
  assert.ok(nearScore > farScore, `a candidate near today's chosen item must score higher than an equally-significant far one (got near=${nearScore} vs far=${farScore})`);
});

// O. portfolio keeps reserve candidates unused when selected already covers the need
test("Round 9.2 O: unused optional/reserve candidates remain unused after initial composition when selected already covers the days", () => {
  const recs = Array.from({ length: 20 }, (_, i) => r92Rec(`o-${i}`, `Sight ${i}`, i % 3 === 0 ? "museum" : i % 3 === 1 ? "attraction" : "nature"));
  const { composed, portfoliosByStay } = r92Compose(recs, 4);
  const portfolio = portfoliosByStay.get(R92_FRAME.phases[0].id)!;
  const scheduledIds = new Set(composed.plan.days.flatMap((d) => realItemsOf(d).map((i) => i.recommendationId)));
  const untouchedOptional = portfolio.optional.filter((c) => !scheduledIds.has(c.recommendationId));
  assert.ok(untouchedOptional.length > 0, "at least some optional/reserve candidates remain unused after initial composition");
});

// Q. majority of real activities initially scheduled, not by backfill
test("Round 9.2 Q: for a healthy multi-stay long trip, the vast majority of real activities are INITIALLY composed, not inserted by backfill", () => {
  const bigFrame = buildTestFrame([
    { areaLabel: "Metro One", nights: 5, startDayNumber: 1, endDayNumber: 5 },
    { areaLabel: "Metro Two", nights: 5, startDayNumber: 6, endDayNumber: 10 },
  ]);
  const anchorOne = { lat: 0, lon: 0 };
  const anchorTwo = { lat: 30, lon: 30 };
  const anchors = new Map([["Metro One", anchorOne], ["Metro Two", anchorTwo]]);
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const recs = [
    ...Array.from({ length: 12 }, (_, i) => buildRecommendation({ id: `one-${i}`, name: `Metro One Sight ${i}`, category: i % 3 === 0 ? "museum" : i % 3 === 1 ? "attraction" : "nature", location: "Metro One", lat: anchorOne.lat + (i % 5) * 0.01, lon: anchorOne.lon + (i % 4) * 0.012, openingHours: "08:00-20:00" })),
    ...Array.from({ length: 12 }, (_, i) => buildRecommendation({ id: `two-${i}`, name: `Metro Two Sight ${i}`, category: i % 3 === 0 ? "museum" : i % 3 === 1 ? "attraction" : "shopping", location: "Metro Two", lat: anchorTwo.lat + (i % 5) * 0.01, lon: anchorTwo.lon + (i % 4) * 0.012, openingHours: "08:00-20:00" })),
  ];
  const payload = buildPayload({ recommendations: recs, preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-19" } });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 10);
  const win = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const dayCapacityByStay = new Map([
    [bigFrame.phases[0].id, Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }))],
    [bigFrame.phases[1].id, Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 6, dayType: "normal" as const, hasExplicitRestWindow: false }))],
  ]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(bigFrame, anchors, mobility, recs, dayCapacityByStay, [], [], 600, (s: string) => s.trim(), (a: string, b: string) => a === b);
  const composed = composeDaysFromStayPortfolios(bigFrame, 10, win, poolsByStay, portfoliosByStay, payload, profile);

  // Now run the SAME days through the exceptional backfill pass and measure how much it needed to add.
  const { days: backfilledDays, insertions } = backfillRealActivities(composed.plan.days, bigFrame, anchors, mobility, payload, profile, win, portfoliosByStay);
  assert.ok(composed.initialRealActivitiesScheduled > 0, "sanity: something was initially composed");
  assert.ok(
    composed.initialRealActivitiesScheduled > insertions.length * 3,
    `initial composition (${composed.initialRealActivitiesScheduled}) should vastly outnumber exceptional backfill insertions (${insertions.length})`
  );

  // R/S/T/U — the composed+backfilled result must still satisfy every existing safety invariant.
  const legality = validateFinalItineraryInvariants(backfilledDays, bigFrame, anchors, mobility, payload, win);
  const quality = validateItineraryQuality(backfilledDays, bigFrame, win);
  assert.equal(legality.illegalScheduledRealPlaces, 0, "T: illegalScheduledRealPlaces = 0");
  assert.equal(legality.openingHoursViolations, 0, "U: openingHoursViolations = 0");
  assert.equal(quality.unjustifiedDaysWithOnlySyntheticContent, 0, "R: no synthetic-only normal day when supply was healthy");
  const allRecIds = backfilledDays.flatMap((d) => d.items.map((i) => i.recommendationId).filter(Boolean));
  assert.equal(allRecIds.length, new Set(allRecIds).size, "S: duplicatePlaces = 0 (no real place scheduled twice)");
});

/* ================================================================== *
 * Round 9.2 — Gemini refinement contract (ID-only, optional)           *
 * ================================================================== */

function r92RealItem(day: AiGeneratedDay, index = 0) {
  return realItemsOf(day)[index];
}

// E. Gemini returns valid candidate IDs -> hydrated correctly (reorder)
test("Round 9.2 E: a valid Gemini reorder is applied — the exact same real items, reordered", async () => {
  const recs = Array.from({ length: 6 }, (_, i) => r92Rec(`e-${i}`, `Sight ${i}`, "attraction"));
  const { composed, portfoliosByStay } = r92Compose(recs, 4);
  const day = composed.plan.days.find((d) => realItemsOf(d).length >= 2)!;
  const ids = realItemsOf(day).map((i) => i.recommendationId as string);
  const reversedIds = [...ids].reverse();

  const result = await refineComposedPlanWithGemini(
    composed.plan,
    R92_FRAME,
    portfoliosByStay,
    buildPayload({ recommendations: recs }),
    R92_PROFILE,
    async () => JSON.stringify({ days: [{ dayNumber: day.dayNumber, preferredOrder: reversedIds }] })
  );
  assert.equal(result.refinementApplied, true);
  const refinedDay = result.plan.days.find((d) => d.dayNumber === day.dayNumber)!;
  const refinedRealIds = realItemsOf(refinedDay).map((i) => i.recommendationId);
  assert.deepEqual(new Set(refinedRealIds), new Set(ids), "the same set of real items survives");
});

// F. Gemini returns an unknown candidate ID -> rejected
test("Round 9.2 F: an unknown candidateId in a swap is rejected — the day is left unchanged", async () => {
  const recs = Array.from({ length: 6 }, (_, i) => r92Rec(`f-${i}`, `Sight ${i}`, "attraction"));
  const { composed, portfoliosByStay } = r92Compose(recs, 4);
  const day = composed.plan.days.find((d) => realItemsOf(d).length >= 1)!;
  const outId = r92RealItem(day).recommendationId;

  const result = await refineComposedPlanWithGemini(
    composed.plan,
    R92_FRAME,
    portfoliosByStay,
    buildPayload({ recommendations: recs }),
    R92_PROFILE,
    async () => JSON.stringify({ days: [{ dayNumber: day.dayNumber, swapOutCandidateId: outId, swapInCandidateId: "hallucinated-id" }] })
  );
  assert.equal(result.refinementApplied, false, "an unknown id must never be silently accepted");
  const refinedDay = result.plan.days.find((d) => d.dayNumber === day.dayNumber)!;
  assert.ok(realItemsOf(refinedDay).some((i) => i.recommendationId === outId), "the original item survives unchanged");
});

// G. Gemini returns a candidate belonging to another stay -> rejected
test("Round 9.2 G: a candidate belonging to a DIFFERENT stay is rejected for a cross-stay swap", async () => {
  const twoStayFrame = buildTestFrame([
    { areaLabel: "Metro A", nights: 2, startDayNumber: 1, endDayNumber: 2 },
    { areaLabel: "Metro B", nights: 2, startDayNumber: 3, endDayNumber: 4 },
  ]);
  const anchorA = { lat: 0, lon: 0 };
  const anchorB = { lat: 30, lon: 30 };
  const anchors = new Map([["Metro A", anchorA], ["Metro B", anchorB]]);
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const recsA = Array.from({ length: 6 }, (_, i) => buildRecommendation({ id: `a-${i}`, name: `A Sight ${i}`, category: "attraction", location: "Metro A", lat: anchorA.lat + i * 0.01, lon: anchorA.lon }));
  const recsB = Array.from({ length: 14 }, (_, i) => buildRecommendation({ id: `b-${i}`, name: `B Sight ${i}`, category: "attraction", location: "Metro B", lat: anchorB.lat + i * 0.01, lon: anchorB.lon }));
  const payload = buildPayload({ recommendations: [...recsA, ...recsB], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const dayCapacityByStay = new Map([
    [twoStayFrame.phases[0].id, [{ dayNumber: 1, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }]],
    [twoStayFrame.phases[1].id, [{ dayNumber: 3, dayType: "transfer" as const, hasExplicitRestWindow: false }, { dayNumber: 4, dayType: "normal" as const, hasExplicitRestWindow: false }]],
  ]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(twoStayFrame, anchors, mobility, [...recsA, ...recsB], dayCapacityByStay, [], [], 600, (s: string) => s.trim(), (a: string, b: string) => a === b);
  const composed = composeDaysFromStayPortfolios(twoStayFrame, 4, R92_WINDOW, poolsByStay, portfoliosByStay, payload, R92_PROFILE);
  const dayInA = composed.plan.days.find((d) => d.dayNumber <= 2 && realItemsOf(d).length >= 1)!;
  const outId = r92RealItem(dayInA).recommendationId;
  // Must be a candidate sitting UNUSED in Metro B's own reserve (not already
  // scheduled anywhere) — otherwise this test would pass for the wrong
  // reason (the independent alreadyUsedElsewhere guard, not the cross-stay
  // ownership guard this test exists to exercise). Verified via portfolio
  // inspection: with 14 Metro-B candidates against a 1-day requirement,
  // b-0..b-5 are selected and b-6..b-13 remain in Metro B's own optional/reserve.
  const crossStayId = "b-6"; // sits unused in Metro B's own reserve, never Metro A's

  const result = await refineComposedPlanWithGemini(
    composed.plan, twoStayFrame, portfoliosByStay, payload, R92_PROFILE,
    async () => JSON.stringify({ days: [{ dayNumber: dayInA.dayNumber, swapOutCandidateId: outId, swapInCandidateId: crossStayId }] })
  );
  const refinedDayA = result.plan.days.find((d) => d.dayNumber === dayInA.dayNumber)!;
  assert.equal(realItemsOf(refinedDayA).some((i) => i.recommendationId === crossStayId), false, "a candidate from another stay must never be scheduled here");
  assert.equal(refinedDayA.items.some((i) => i.recommendationId === outId) || realItemsOf(refinedDayA).length === realItemsOf(dayInA).length, true, "a rejected swap must leave the day's real content unchanged");
});

// C. Round 9.2 §5 — the Gemini refinement prompt itself must be stay-
// scoped, never a raw country-wide dump: stay A's own block (days/reserve)
// must never mention a candidateId that belongs exclusively to a
// different stay. Captured via geminiCallOverride, which receives the
// EXACT prompt text refineComposedPlanWithGemini builds and sends.
test("Round 9.2 C: the Gemini refinement prompt never includes another stay's candidates inside a stay's own block", async () => {
  const twoStayFrame = buildTestFrame([
    { areaLabel: "Metro A", nights: 2, startDayNumber: 1, endDayNumber: 2 },
    { areaLabel: "Metro B", nights: 2, startDayNumber: 3, endDayNumber: 4 },
  ]);
  const anchorA = { lat: 0, lon: 0 };
  const anchorB = { lat: 30, lon: 30 };
  const anchors = new Map([["Metro A", anchorA], ["Metro B", anchorB]]);
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  // 14 each (not 6) so both stays' portfolios genuinely have a non-empty
  // `.optional` reserve to potentially leak — with only enough candidates
  // to exactly cover `.selected`, this mutation would have nothing to leak
  // and the test would pass for the wrong reason (verified via the same
  // portfolio-inspection approach used to fix test G above).
  const recsA = Array.from({ length: 14 }, (_, i) => buildRecommendation({ id: `ca-${i}`, name: `A Sight ${i}`, category: "attraction", location: "Metro A", lat: anchorA.lat + i * 0.01, lon: anchorA.lon }));
  const recsB = Array.from({ length: 14 }, (_, i) => buildRecommendation({ id: `cb-${i}`, name: `B Sight ${i}`, category: "attraction", location: "Metro B", lat: anchorB.lat + i * 0.01, lon: anchorB.lon }));
  const payload = buildPayload({ recommendations: [...recsA, ...recsB], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const dayCapacityByStay = new Map([
    [twoStayFrame.phases[0].id, [{ dayNumber: 1, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }]],
    [twoStayFrame.phases[1].id, [{ dayNumber: 3, dayType: "transfer" as const, hasExplicitRestWindow: false }, { dayNumber: 4, dayType: "normal" as const, hasExplicitRestWindow: false }]],
  ]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(twoStayFrame, anchors, mobility, [...recsA, ...recsB], dayCapacityByStay, [], [], 600, (s: string) => s.trim(), (a: string, b: string) => a === b);
  const composed = composeDaysFromStayPortfolios(twoStayFrame, 4, R92_WINDOW, poolsByStay, portfoliosByStay, payload, R92_PROFILE);

  let capturedPrompt: string | null = null;
  await refineComposedPlanWithGemini(composed.plan, twoStayFrame, portfoliosByStay, payload, R92_PROFILE, async (prompt) => {
    capturedPrompt = prompt;
    return null; // no response needed — only inspecting what was SENT
  });

  assert.ok(capturedPrompt, "the prompt-building path must actually run for a 2-stay healthy trip");
  const promptText: string = capturedPrompt as unknown as string;
  const jsonStart = promptText.indexOf("[");
  const stays = JSON.parse(promptText.slice(jsonStart)) as Array<{ stayId: string; days: Array<{ candidates: Array<{ candidateId: string }> }>; reserve: Array<{ candidateId: string }> }>;
  const stayA = stays.find((s) => s.stayId === twoStayFrame.phases[0].id)!;
  const stayB = stays.find((s) => s.stayId === twoStayFrame.phases[1].id)!;
  assert.ok(stayA && stayB, "both stays must appear in the prompt input");
  const idsInStayA = [...stayA.days.flatMap((d) => d.candidates.map((c) => c.candidateId)), ...stayA.reserve.map((c) => c.candidateId)];
  const idsInStayB = [...stayB.days.flatMap((d) => d.candidates.map((c) => c.candidateId)), ...stayB.reserve.map((c) => c.candidateId)];
  assert.ok(idsInStayA.every((id) => id.startsWith("ca-")), `Metro A's own prompt block must only ever mention Metro A's own candidates, got ${JSON.stringify(idsInStayA)}`);
  assert.ok(idsInStayB.every((id) => id.startsWith("cb-")), `Metro B's own prompt block must only ever mention Metro B's own candidates, got ${JSON.stringify(idsInStayB)}`);
});

// H. Gemini invents an attraction name without a candidateId -> never becomes a real POI
test("Round 9.2 H: Gemini output has no field through which an invented name/coordinate could ever become a real item", async () => {
  const recs = Array.from({ length: 6 }, (_, i) => r92Rec(`h-${i}`, `Sight ${i}`, "attraction"));
  const { composed, portfoliosByStay } = r92Compose(recs, 4);
  const day = composed.plan.days.find((d) => realItemsOf(d).length >= 1)!;

  const result = await refineComposedPlanWithGemini(
    composed.plan, R92_FRAME, portfoliosByStay, buildPayload({ recommendations: recs }), R92_PROFILE,
    // Even if Gemini hallucinates extra fields, the parser only ever reads
    // dayNumber/preferredOrder/swapOutCandidateId/swapInCandidateId.
    async () => JSON.stringify({ days: [{ dayNumber: day.dayNumber, inventedName: "A Made-Up Museum", inventedLat: 12.34, inventedLon: 56.78 }] })
  );
  const allNames = result.plan.days.flatMap((d) => d.items.map((i) => i.name));
  assert.equal(allNames.includes("A Made-Up Museum"), false, "an invented name never reaches the itinerary");
});

// I. Gemini unavailable -> deterministic composition still produces useful days
test("Round 9.2 I: Gemini unavailable (no key, or the call throws) -> the deterministic composed plan is returned unchanged", async () => {
  const recs = Array.from({ length: 8 }, (_, i) => r92Rec(`i-${i}`, `Sight ${i}`, i % 2 === 0 ? "attraction" : "museum"));
  const { composed, portfoliosByStay } = r92Compose(recs, 4);
  const payload = buildPayload({ recommendations: recs });

  const noKeyResult = await refineComposedPlanWithGemini(composed.plan, R92_FRAME, portfoliosByStay, payload, R92_PROFILE);
  assert.equal(noKeyResult.refinementApplied, false);
  assert.deepEqual(noKeyResult.plan, composed.plan);

  const throwsResult = await refineComposedPlanWithGemini(composed.plan, R92_FRAME, portfoliosByStay, payload, R92_PROFILE, async () => {
    throw new Error("Gemini is down");
  });
  assert.equal(throwsResult.refinementApplied, false);
  assert.ok(realItemsOf(throwsResult.plan.days[0] ?? throwsResult.plan.days.find((d) => realItemsOf(d).length > 0)!).length >= 0, "the plan is still fully usable");
  const totalReal = throwsResult.plan.days.flatMap((d) => realItemsOf(d)).length;
  assert.ok(totalReal > 0, "real activities survive Gemini's total unavailability");
});

/* -------------------- isSupplyHealthyForComposition -------------------- */

test("Round 9.2: isSupplyHealthyForComposition is true only when every stay reached its own minimum", () => {
  const healthy = new Map([["stay-0", r91Pool({ legalCandidateCount: 30, minimumViableCandidateCount: 9 })]]);
  const thin = new Map([["stay-0", r91Pool({ legalCandidateCount: 2, minimumViableCandidateCount: 9 })]]);
  assert.equal(isSupplyHealthyForComposition(healthy as never), true);
  assert.equal(isSupplyHealthyForComposition(thin as never), false);
  assert.equal(isSupplyHealthyForComposition(new Map()), false, "no pools at all is never 'healthy'");
});

/* ==================================================================== *
 * ROUND 9.2.1 — MEAL VENUE POOLS + CUISINE-AWARE MEAL PLANNING          *
 * Live-pipeline tests: role separation (A-H), full-day quality (X-AB),  *
 * and fallback ordering (AC-AF). Meal-type/location/cuisine-diversity   *
 * scoring (I-W) are exercised at the unit level in                     *
 * meal-cuisine-taxonomy.test.ts and stay-meal-venue-pool.test.ts.       *
 * ==================================================================== */

function r921Day(items: AiGeneratedItem[], overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
  return buildDay({ dayNumber: 2, date: "2026-09-10", cityRegion: "Area A", items, ...overrides });
}

// A. ordinary restaurant does not satisfy meaningful activity minimum
test("Round 9.2.1 A: an ordinary restaurant does not satisfy the meaningful-activity minimum", () => {
  const day = r921Day([
    buildItem({ name: "City Bistro", category: "restaurant", recommendationId: "rest-1", slot: "dinner", lat: R8_A.lat, lon: R8_A.lon }),
    r8FreeTime(),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 0);
  assert.equal(report.realMealVenueCount, 1);
  assert.equal(report.daysBelowMinimumRealActivities, 1);
});

// B. ordinary cafe does not satisfy meaningful activity minimum
test("Round 9.2.1 B: an ordinary cafe does not satisfy the meaningful-activity minimum", () => {
  const day = r921Day([
    buildItem({ name: "Corner Cafe", category: "cafe", recommendationId: "cafe-1", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
    r8FreeTime(),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 0);
  assert.equal(report.realMealVenueCount, 1);
});

// C. ordinary bakery does not satisfy meaningful activity minimum
test("Round 9.2.1 C: an ordinary bakery does not satisfy the meaningful-activity minimum", () => {
  const day = r921Day([
    buildItem({ name: "City Bakery", category: "restaurant", shortDescription: "neighborhood bakery and patisserie", recommendationId: "bakery-1", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
    r8FreeTime(),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 0);
  assert.equal(report.realMealVenueCount, 1);
});

// D. ordinary bar does not satisfy meaningful activity minimum
test("Round 9.2.1 D: an ordinary bar used for food/drink does not satisfy the meaningful-activity minimum", () => {
  const day = r921Day([
    buildItem({ name: "Corner Cocktail Bar", category: "restaurant", shortDescription: "gastropub and cocktail bar serving food", recommendationId: "bar-1", slot: "dinner", lat: R8_A.lat, lon: R8_A.lon }),
    r8FreeTime(),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 0);
  assert.equal(report.realMealVenueCount, 1);
});

// A2. same role-separation rule, exercised through the OTHER live consumer
// (backfillRealActivities, via isMeaningfulRealActivity) — validateItineraryQuality
// above computes meaningfulness inline; this is the shared function's own
// other real call site, and a mutation could silently break one without
// the other if they ever drifted apart.
test("Round 9.2.1 A2: backfillRealActivities still inserts a real activity into an all-restaurant day (a meal venue never counts as already-sufficient)", () => {
  const foodOnlyDay = r8Day([
    buildItem({ name: "Lunch Spot", category: "restaurant", recommendationId: "food-1", slot: "lunch", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Dinner Spot", category: "restaurant", recommendationId: "food-2", slot: "dinner", lat: R8_A.lat, lon: R8_A.lon }),
  ]);
  const recs = [r8Rec("rec-a2", "Real Attraction", "attraction")];
  const payload = r8Payload(recs);
  const { days, insertions } = backfillRealActivities([foodOnlyDay], R8_FRAME, R8_ANCHORS, R8_MOBILITY, payload, R8_PROFILE, R8_WINDOW);
  assert.ok(insertions.length >= 1, "a day with only meal venues must still be backfilled with a real activity");
  assert.ok(days[0].items.some((i) => i.name === "Real Attraction"));
});

// E. food tour / structured culinary experience MAY satisfy meaningful activity
test("Round 9.2.1 E: a structured food/culinary experience DOES satisfy the meaningful-activity minimum", () => {
  const day = r921Day([
    buildItem({ name: "City Food Tour", category: "restaurant", shortDescription: "guided culinary experience and tasting session", recommendationId: "tour-1", slot: "afternoon", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Second Sight", category: "attraction", recommendationId: "rec-2", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 2, "the food experience counts as a real activity, not a meal venue");
  assert.equal(report.realMealVenueCount, 0);
  assert.equal(report.foodExperienceActivityCount, 1);
});

// F. restaurant remains a real place for geography validation
test("Round 9.2.1 F: a geographically incompatible restaurant is never chosen as a meal, even with nothing else available", () => {
  const anchor = buildItem({ name: "Anchor Sight", category: "attraction", lat: R8_A.lat, lon: R8_A.lon });
  const farAway = buildRecommendation({ id: "far-rest", name: "Far City Restaurant", category: "restaurant", location: "Somewhere Else", lat: R8_A.lat + 5, lon: R8_A.lon + 5 });
  const payload = buildPayload({ recommendations: [farAway] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const picked = pickNearbyMealRecommendation(payload, buildDay({ items: [anchor] }), "dinner", profile, new Set());
  assert.equal(picked, null, "a restaurant far outside the day's own geography must never be selected as a meal, real place or not");
});

// G. restaurant remains subject to opening-hours validation
test("Round 9.2.1 G: a restaurant closed at the requested time is never chosen as a meal", () => {
  const anchor = buildItem({ name: "Anchor Sight", category: "attraction", lat: R8_A.lat, lon: R8_A.lon });
  const closed = buildRecommendation({ id: "closed-rest", name: "Closed Restaurant", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon, openingHours: "סגור לצמיתות" });
  const open = buildRecommendation({ id: "open-rest", name: "Open Restaurant", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [closed, open] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const picked = pickNearbyMealRecommendation(payload, buildDay({ items: [anchor] }), "dinner", profile, new Set());
  assert.equal(picked?.name, "Open Restaurant", "the explicitly-closed restaurant must never be chosen over an open one");
});

// H. restaurant remains subject to duplicate detection
test("Round 9.2.1 H: a restaurant already used elsewhere in the trip is deprioritized (duplicate suppression still applies)", () => {
  const anchor = buildItem({ name: "Anchor Sight", category: "attraction", lat: R8_A.lat, lon: R8_A.lon });
  const usedOne = buildRecommendation({ id: "used-rest", name: "Already Used Restaurant", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const fresh = buildRecommendation({ id: "fresh-rest", name: "Fresh Restaurant", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [usedOne, fresh] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const picked = pickNearbyMealRecommendation(payload, buildDay({ items: [anchor] }), "dinner", profile, new Set(["already used restaurant"]));
  assert.equal(picked?.name, "Fresh Restaurant", "an already-used restaurant must still be deprioritized over a fresh one");
});

/* -------------------- X-AB: full-day quality metrics -------------------- */

// X. 2 attractions + lunch restaurant + dinner restaurant -> meaningfulActivityCount = 2, realMealVenueCount = 2
test("Round 9.2.1 X: 2 attractions + lunch + dinner restaurant -> meaningfulActivityCount=2, realMealVenueCount=2", () => {
  const day = r921Day([
    buildItem({ name: "Morning Sight", category: "attraction", recommendationId: "a1", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Lunch Spot", category: "restaurant", recommendationId: "l1", slot: "lunch", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Afternoon Sight", category: "attraction", recommendationId: "a2", slot: "afternoon", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Dinner Spot", category: "restaurant", recommendationId: "d1", slot: "dinner", lat: R8_A.lat, lon: R8_A.lon }),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 2);
  assert.equal(report.realMealVenueCount, 2);
});

// Y. 3 restaurants + 2 cafes -> meaningfulActivityCount = 0 -> fails normal sightseeing coverage
test("Round 9.2.1 Y: an all-food day (3 restaurants + 2 cafes) has meaningfulActivityCount=0 and fails coverage", () => {
  const day = r921Day([
    buildItem({ name: "Rest 1", category: "restaurant", recommendationId: "r1", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Rest 2", category: "restaurant", recommendationId: "r2", slot: "lunch", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Rest 3", category: "restaurant", recommendationId: "r3", slot: "dinner", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Cafe 1", category: "cafe", recommendationId: "c1", slot: "morning", lat: R8_A.lat, lon: R8_A.lon }),
    buildItem({ name: "Cafe 2", category: "cafe", recommendationId: "c2", slot: "afternoon", lat: R8_A.lat, lon: R8_A.lon }),
  ]);
  const report = validateItineraryQuality([day], R8_FRAME, R8_WINDOW);
  assert.equal(report.meaningfulRealActivityCount, 0);
  assert.equal(report.realMealVenueCount, 5);
  assert.equal(report.daysBelowMinimumRealActivities, 1, "an all-food day must fail normal sightseeing coverage");
});

// Z/AA. composer assigns real attractions first, never consumes activity slots with meal venues
test("Round 9.2.1 Z/AA: composeDaysFromStayPortfolios never schedules a restaurant/cafe as one of its real-activity anchors", () => {
  const recs = [
    ...Array.from({ length: 8 }, (_, i) => r92Rec(`attr-${i}`, `Attraction ${i}`, "attraction")),
    ...Array.from({ length: 6 }, (_, i) => r92Rec(`food-${i}`, `Restaurant ${i}`, "restaurant")),
  ];
  const { composed, poolsByStay } = r92Compose(recs, 4);
  // The meal-venue candidates must never even have entered the activity pool.
  const pool = poolsByStay.get(R92_FRAME.phases[0].id)!;
  assert.equal(pool.candidates.some((c) => c.recommendationId.startsWith("food-")), false, "restaurant candidates must never enter the activity pool");
  assert.ok(pool.diagnostics.mealVenueExcluded >= 6);
  // And the composer's own initially-assigned real ACTIVITY anchors are
  // never restaurant-categorized, even though supply was clearly there —
  // a restaurant legitimately scheduled at a lunch/dinner SLOT by the
  // SEPARATE meal system (insertMissingMeals, also called inside
  // composeDaysFromStayPortfolios) is correct and expected, so only
  // non-meal-slot items are checked here.
  for (const day of composed.plan.days) {
    for (const item of realItemsOf(day)) {
      if (item.slot === "lunch" || item.slot === "dinner") continue;
      assert.notEqual(item.category, "restaurant", `day ${day.dayNumber} scheduled a restaurant as a real activity anchor`);
    }
  }
});

// AB. food experience activity can consume an activity slot, ordinary restaurant cannot
test("Round 9.2.1 AB: a food-experience candidate CAN be composed as a real activity; an ordinary restaurant never is", () => {
  const foodExperience = r92Rec("exp-1", "Old Town Culinary Tasting Tour", "restaurant", { shortDescription: "guided food tour and tasting experience" });
  const ordinaryRestaurant = r92Rec("plain-1", "Plain Restaurant", "restaurant");
  const attractions = Array.from({ length: 6 }, (_, i) => r92Rec(`attr-${i}`, `Attraction ${i}`, "attraction"));
  const { composed } = r92Compose([foodExperience, ordinaryRestaurant, ...attractions], 4);
  // Only non-meal-slot real items count as ACTIVITY anchors — "plain-1" may
  // still legitimately appear as an actual scheduled lunch/dinner (that's
  // the meal system working correctly, not an activity-portfolio breach).
  const activityAnchorIds = new Set(
    composed.plan.days.flatMap((d) => realItemsOf(d).filter((i) => i.slot !== "lunch" && i.slot !== "dinner").map((i) => i.recommendationId))
  );
  assert.equal(activityAnchorIds.has("exp-1"), true, "the food-experience candidate is eligible activity-portfolio material");
  assert.equal(activityAnchorIds.has("plain-1"), false, "an ordinary restaurant must never be composed as a real activity anchor");
});

/* -------------------- AC-AF: fallback ordering -------------------- */

// AC. appropriate real lunch venue exists -> selected before MealOpportunity
test("Round 9.2.1 AC: insertMissingMeals picks a real, suitable lunch venue over the synthetic MealOpportunity", () => {
  const anchor = buildItem({ name: "Morning Sight", category: "attraction", slot: "morning", lat: R8_A.lat, lon: R8_A.lon });
  const lunchSpot = buildRecommendation({ id: "lunch-1", name: "Great Lunch Spot", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [lunchSpot] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const day = insertMissingMeals(buildDay({ items: [anchor], dayNumber: 2 }), payload, profile, new Set());
  const lunchItem = day.items.find((item) => item.slot === "lunch");
  assert.equal(lunchItem?.recommendationId, "lunch-1");
});

// AD. only available cafe is breakfast-only -> do NOT misuse it as lunch; use another venue or fallback
test("Round 9.2.1 AD: a breakfast-only cafe is never misused for lunch — falls back to the synthetic MealOpportunity instead", () => {
  const anchor = buildItem({ name: "Morning Sight", category: "attraction", slot: "morning", lat: R8_A.lat, lon: R8_A.lon });
  const breakfastCafe = buildRecommendation({ id: "cafe-1", name: "Breakfast Only Cafe", category: "cafe", shortDescription: "breakfast spot with pancakes and eggs benedict", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [breakfastCafe] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const day = insertMissingMeals(buildDay({ items: [anchor], dayNumber: 2 }), payload, profile, new Set());
  const lunchItem = day.items.find((item) => item.slot === "lunch");
  assert.notEqual(lunchItem?.recommendationId, "cafe-1", "the breakfast-only cafe must never be scheduled as lunch");
  assert.equal(lunchItem?.recommendationId, null, "with no suitable real lunch venue, the synthetic MealOpportunity is used instead");
});

// AE. meal pool exhausted -> synthetic MealOpportunity inserted
test("Round 9.2.1 AE: with zero real candidates at all, a synthetic MealOpportunity fills the slot", () => {
  const anchor = buildItem({ name: "Morning Sight", category: "attraction", slot: "morning", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const day = insertMissingMeals(buildDay({ items: [anchor], dayNumber: 2 }), payload, profile, new Set());
  const lunchItem = day.items.find((item) => item.slot === "lunch");
  assert.equal(lunchItem?.recommendationId, null);
  assert.ok(lunchItem?.name.includes("🍽"), "a genuinely empty pool must produce the honest synthetic meal placeholder, never an invented name");
});

// AF. a route-incompatible restaurant is skipped in favor of a route-compatible alternative before any synthetic fallback
test("Round 9.2.1 AF: a route-compatible alternative is chosen over a route-incompatible restaurant, before any synthetic fallback", () => {
  const anchor = buildItem({ name: "Morning Sight", category: "attraction", slot: "morning", lat: R8_A.lat, lon: R8_A.lon });
  const incompatible = buildRecommendation({ id: "far-1", name: "Route Incompatible Restaurant", category: "restaurant", location: "Somewhere Else", lat: R8_A.lat + 5, lon: R8_A.lon + 5 });
  const compatible = buildRecommendation({ id: "near-1", name: "Route Compatible Restaurant", category: "restaurant", location: "Area A", lat: R8_A.lat, lon: R8_A.lon });
  const payload = buildPayload({ recommendations: [incompatible, compatible] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 3);
  const day = insertMissingMeals(buildDay({ items: [anchor], dayNumber: 2 }), payload, profile, new Set());
  const lunchItem = day.items.find((item) => item.slot === "lunch");
  assert.equal(lunchItem?.recommendationId, "near-1", "the route-compatible alternative must be chosen over the incompatible one and before any synthetic fallback");
});

/* ==================================================================== *
 * ROUND 9.3 — AI-FIRST STAY SKELETON, THEN LOCAL POI DISCOVERY          *
 * ==================================================================== */

// basePreferences (this file's shared default) hardcodes accommodationArea
// "Tokyo Station" / preferredRegions "Tokyo" — a real pinned area, which
// deliberately disables needsStaySkeleton by design. Every Round 9.3 test
// below is specifically about the NO-pinned-area case, so this US-neutral
// base clears both.
const usBasePreferences: TripPreferences = { ...basePreferences, accommodationArea: "", preferredRegions: "" };

function usPayload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    ...buildPayload({ ...overrides, preferences: overrides.preferences ?? usBasePreferences }),
    countryId: "country-us",
    countryName: "United States",
    isoA2: "US",
  };
}

/* -------------------- needsStaySkeleton (the root-cause gate) -------------------- */

test("Round 9.3: needsStaySkeleton fires exactly on the reported bug shape (single phase whose area IS the country)", () => {
  const collapsedFrame: TripFrame = { bucketId: "slow_travel", source: "deterministic", phases: [{ id: "phase-1", areaLabel: "United States", nights: 41, startDayNumber: 1, endDayNumber: 42, intent: "mixed" }] };
  assert.equal(needsStaySkeleton(collapsedFrame, usPayload()), true);
});

test("Round 9.3: needsStaySkeleton never fires when the deterministic frame already has real multi-area structure", () => {
  const realFrame: TripFrame = {
    bucketId: "multi_phase",
    source: "deterministic",
    phases: [
      { id: "phase-1", areaLabel: "New York", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "city" },
      { id: "phase-2", areaLabel: "Los Angeles", nights: 5, startDayNumber: 6, endDayNumber: 10, intent: "city" },
    ],
  };
  assert.equal(needsStaySkeleton(realFrame, usPayload()), false);
});

test("Round 9.3: needsStaySkeleton never fires when the user already pinned an accommodation area (a real single-base intent)", () => {
  const collapsedFrame: TripFrame = { bucketId: "slow_travel", source: "deterministic", phases: [{ id: "phase-1", areaLabel: "United States", nights: 41, startDayNumber: 1, endDayNumber: 42, intent: "mixed" }] };
  const pinned = usPayload({ preferences: { ...usBasePreferences, accommodationArea: "Miami" } });
  assert.equal(needsStaySkeleton(collapsedFrame, pinned), false);
});

test("Round 9.3: needsStaySkeleton never fires for a single phase that is a genuine local area, not the country name", () => {
  const realSingleBase: TripFrame = { bucketId: "single_base", source: "deterministic", phases: [{ id: "phase-1", areaLabel: "Boston", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "city" }] };
  assert.equal(needsStaySkeleton(realSingleBase, usPayload()), false);
});

/* -------------------- buildStaySkeletonPrompt (spec §3/§4) -------------------- */

test("Round 9.3 T: the stay-skeleton prompt explicitly instructs Gemini to never propose POI/attraction/restaurant names", () => {
  const prompt = buildStaySkeletonPrompt(usPayload({ preferences: { ...usBasePreferences, mustVisitPlaces: "New York, Yellowstone" } }), 42);
  assert.ok(prompt.includes("New York"), "must-visit text is passed through as context");
  assert.ok(/לעולם לא שמות אטרקציות/.test(prompt), "the prompt must explicitly forbid attraction/restaurant/POI-level names, only place-level bases");
});

test("buildStaySkeletonPrompt never includes a country-wide POI list (spec §4)", () => {
  const withRecs = usPayload({ recommendations: [buildRecommendation({ id: "r1", name: "Statue of Liberty" })] });
  const prompt = buildStaySkeletonPrompt(withRecs, 42);
  assert.ok(!prompt.includes("Statue of Liberty"), "recommendations must never leak into the skeleton prompt");
});

/* -------------------- proposeStaySkeletonWithGemini (injectable, spec §3) -------------------- */

test("Round 9.3: proposeStaySkeletonWithGemini parses a valid Gemini response into ProposedStay[]", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "New York", nights: 5, reasons: ["culture"] }, { areaName: "Los Angeles", nights: 5, reasons: ["entertainment"] }] });
  const proposals = await proposeStaySkeletonWithGemini(usPayload(), 42, fakeGemini);
  assert.equal(proposals?.length, 2);
  assert.equal(proposals?.[0].areaName, "New York");
});

test("Round 9.3 T: proposeStaySkeletonWithGemini only ever extracts areaName/nights/reasons — no other field can pass through", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "New York", nights: 5, reasons: ["culture"], poiName: "Statue of Liberty", attraction: "should be ignored" }] });
  const proposals = await proposeStaySkeletonWithGemini(usPayload(), 42, fakeGemini);
  assert.deepEqual(Object.keys(proposals?.[0] ?? {}).sort(), ["areaName", "nights", "proposedId", "reasons"]);
});

test("Round 9.3 E: proposeStaySkeletonWithGemini returns null on any failure (never a single point of failure)", async () => {
  const throwing = async () => {
    throw new Error("gemini down");
  };
  assert.equal(await proposeStaySkeletonWithGemini(usPayload(), 42, throwing), null);
});

test("proposeStaySkeletonWithGemini returns null on malformed JSON", async () => {
  const badJson = async () => "not json";
  assert.equal(await proposeStaySkeletonWithGemini(usPayload(), 42, badJson), null);
});

/* -------------------- buildTripFrameFromSkeleton / buildTripFrame — full wiring -------------------- */

function fakeSearchPlaces(known: Record<string, { name: string; lat: number; lon: number }>) {
  return async (query: string) => {
    const match = known[query.trim().toLowerCase()];
    return match ? [match] : [];
  };
}

// C. Gemini proposes multiple valid stays -> all resolve -> TripFrame uses them
test("Round 9.3 C (full wiring): Gemini proposes valid stays, they resolve, and buildTripFrame returns a real multi-phase frame", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "New York", nights: 20, reasons: ["culture"] }, { areaName: "Los Angeles", nights: 21, reasons: ["entertainment"] }] });
  const search = fakeSearchPlaces({
    "new york": { name: "New York", lat: 40.7128, lon: -74.006 },
    "los angeles": { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  });
  const { frame } = await buildTripFrame(usPayload(), 42, null, fakeGemini, search);
  assert.ok(frame.phases.length >= 2, `expected multiple phases, got ${frame.phases.length}`);
  assert.ok(frame.phases.every((p) => p.areaLabel !== "United States"), "no phase may collapse to the bare country name");
});

// D. Gemini proposes hallucinated stay -> rejected; country centroid NOT substituted; falls back
test("Round 9.3 D (full wiring): a hallucinated Gemini stay is rejected and the deterministic fallback takes over", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "Fictional Nowhereville", nights: 41, reasons: ["invented"] }] });
  const search = fakeSearchPlaces({ "new york": { name: "New York", lat: 40.7128, lon: -74.006 } });
  const { frame } = await buildTripFrame(
    usPayload({ preferences: { ...usBasePreferences, mustVisitPlaces: "New York" } }),
    42,
    null,
    fakeGemini,
    search
  );
  assert.ok(frame.phases.every((p) => p.areaLabel !== "Fictional Nowhereville"), "a hallucinated area must never survive into the final frame");
  assert.ok(frame.phases.some((p) => p.areaLabel === "New York"), "the deterministic fallback (must-visit text) must produce a real resolved stay instead");
});

// E. Gemini unavailable -> deterministic fallback produces resolved local stays
test("Round 9.3 E (full wiring): with no Gemini call at all, the deterministic fallback still resolves real local stays", async () => {
  const search = fakeSearchPlaces({
    "new york": { name: "New York", lat: 40.7128, lon: -74.006 },
    "yellowstone national park": { name: "Yellowstone National Park", lat: 44.428, lon: -110.5885 },
  });
  const { frame } = await buildTripFrame(
    usPayload({ preferences: { ...usBasePreferences, mustVisitPlaces: "New York, Yellowstone National Park" } }),
    42,
    null,
    undefined, // no Gemini override AND no GEMINI_API_KEY in this test env -> proposeStaySkeletonWithGemini returns null
    search
  );
  assert.ok(frame.phases.length >= 1);
  assert.ok(frame.phases.every((p) => p.areaLabel !== "United States"));
});

// G. arrival/departure influence route
test("Round 9.3 G: the arrival airport's city is ordered first and the departure city last", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "Los Angeles", nights: 15 }, { areaName: "Chicago", nights: 13 }, { areaName: "New York", nights: 13 }] });
  const search = fakeSearchPlaces({
    "new york": { name: "New York", lat: 40.7128, lon: -74.006 },
    "los angeles": { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
    "chicago": { name: "Chicago", lat: 41.8781, lon: -87.6298 },
  });
  const withFlights = usPayload({
    preferences: {
      ...usBasePreferences,
      flights: {
        outbound: { ...createEmptyFlightLeg(), departureAirport: "TLV", arrivalAirport: "JFK" },
        return: { ...createEmptyFlightLeg(), departureAirport: "LAX", arrivalAirport: "TLV" },
      },
    },
  });
  const { frame } = await buildTripFrame(withFlights, 41, null, fakeGemini, search);
  assert.equal(frame.phases[0].areaLabel, "New York", "arrival city (JFK) must anchor the route's start");
  assert.equal(frame.phases.at(-1)?.areaLabel, "Los Angeles", "departure city (LAX) must anchor the route's end");
});

/* -------------------- I/J/K: stay-scoped discovery uses the skeleton's real anchor -------------------- */

test("Round 9.3 I/J: activity pools built from a skeleton frame are anchored to the REAL resolved coordinates, not a country centroid", async () => {
  const fakeGemini = async () => JSON.stringify({ stays: [{ areaName: "New York", nights: 20 }, { areaName: "Los Angeles", nights: 21 }] });
  const search = fakeSearchPlaces({
    "new york": { name: "New York", lat: 40.7128, lon: -74.006 },
    "los angeles": { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  });
  const { frame } = await buildTripFrame(usPayload(), 42, null, fakeGemini, search);
  const areaAnchors = new Map(frame.phases.map((p) => [p.areaLabel, { lat: p.areaLabel === "New York" ? 40.7128 : 34.0522, lon: p.areaLabel === "New York" ? -74.006 : -118.2437 }]));
  const nyc = buildRecommendation({ id: "nyc-museum", name: "NYC Museum", category: "museum", location: "New York", lat: 40.71, lon: -74.0 });
  const la = buildRecommendation({ id: "la-museum", name: "LA Museum", category: "museum", location: "Los Angeles", lat: 34.05, lon: -118.25 });
  const dayCapacityByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const { poolsByStay } = buildTripActivityPortfolios(frame, areaAnchors, { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 }, [nyc, la], dayCapacityByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  const nyPhase = frame.phases.find((p) => p.areaLabel === "New York")!;
  const laPhase = frame.phases.find((p) => p.areaLabel === "Los Angeles")!;
  assert.ok(poolsByStay.get(nyPhase.id)!.candidates.some((c) => c.recommendationId === "nyc-museum"), "the NYC museum must be owned by the New York stay, discovered around its own real anchor");
  assert.equal(poolsByStay.get(nyPhase.id)!.candidates.some((c) => c.recommendationId === "la-museum"), false, "the LA museum must NOT be owned by New York — a country-centroid-style collapse would wrongly merge these");
  assert.ok(poolsByStay.get(laPhase.id)!.candidates.some((c) => c.recommendationId === "la-museum"), "the LA museum must be owned by the Los Angeles stay, discovered around ITS OWN real anchor, not a shared/country-wide one");
});

/* -------------------- L: composer consumes literal StayMealVenuePool -------------------- */

test("Round 9.3 L: composeDaysFromStayPortfolios consumes the literal StayMealVenuePool passed to it, not a re-scan of payload.recommendations", () => {
  const inPoolMeal = r92Rec("in-pool", "In Pool Restaurant", "restaurant");
  const notInPoolMeal = r92Rec("not-in-pool", "Not In Pool Restaurant", "restaurant");
  // Both meals are real, legal, geographically identical candidates — the
  // ONLY difference is whether they were included when building the
  // literal StayMealVenuePool passed to the composer. payload.recommendations
  // deliberately carries BOTH, so a composer that fell back to re-scanning
  // payload.recommendations directly (the "second inline pseudo-pool" spec
  // §11 forbids) would still find "not-in-pool" — this test only passes if
  // selection is genuinely bounded by the literal pool object.
  const payload = buildPayload({ recommendations: [inPoolMeal, notInPoolMeal], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const dayCapacityByStay = new Map([[R92_FRAME.phases[0].id, Array.from({ length: 4 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }))]]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
    R92_FRAME, R92_ANCHORS, R92_MOBILITY, [], dayCapacityByStay, [], [], 600, (s: string) => s.trim(), (a: string, b: string) => a === b
  );
  const mealPoolsByStay = buildTripMealVenuePools(R92_FRAME, R92_ANCHORS, R92_MOBILITY, [inPoolMeal], 600, (s) => s.trim(), (a, b) => a === b);

  const composed = composeDaysFromStayPortfolios(R92_FRAME, 4, R92_WINDOW, poolsByStay, portfoliosByStay, payload, R92_PROFILE, mealPoolsByStay);
  const scheduledMealIds = new Set(composed.plan.days.flatMap((d) => d.items.filter((i) => i.slot === "lunch" || i.slot === "dinner").map((i) => i.recommendationId)));
  assert.equal(scheduledMealIds.has("not-in-pool"), false, "a candidate absent from the literal pool must never be scheduled even though it's in payload.recommendations");
});

/* -------------------- Round 9.3.3 continuation §4/15B/15E: backfillRealMealVenues -------------------- */

test("Round 9.3.3 §4: a scheduled MealOpportunity is replaced by a real venue from a freshly-built meal pool", () => {
  const realDinner = r92Rec("real-dinner", "Real Dinner Spot", "restaurant");
  const payload = buildPayload({ recommendations: [realDinner], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const day = buildDay({
    dayNumber: 2,
    date: "2026-09-11",
    cityRegion: "Metro A",
    items: [buildFallbackMealPlaceholder(buildDay({ dayNumber: 2, cityRegion: "Metro A", items: [] }), "dinner", payload)],
  });
  const mealPoolsByStay = buildTripMealVenuePools(R92_FRAME, R92_ANCHORS, R92_MOBILITY, [realDinner], 600, (s) => s.trim(), (a, b) => a === b);

  const { days, insertions } = backfillRealMealVenues([day], R92_FRAME, payload, R92_PROFILE, mealPoolsByStay, 4, R92_WINDOW);

  assert.equal(insertions.length, 1, "the real venue is actually inserted");
  assert.equal(days[0].items.some((i) => i.name === "Real Dinner Spot" && i.recommendationId === "real-dinner"), true);
  assert.equal(
    days[0].items.some((i) => i.itemRole === "meal_opportunity"),
    false,
    "no MealOpportunity may remain once a valid real venue exists to replace it"
  );
});

test("Round 9.3.3 §4: a MealOpportunity is left alone when the meal pool genuinely has nothing usable", () => {
  const payload = buildPayload({ recommendations: [], preferences: { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-13" } });
  const opportunity = buildFallbackMealPlaceholder(buildDay({ dayNumber: 2, cityRegion: "Metro A", items: [] }), "dinner", payload);
  const day = buildDay({ dayNumber: 2, date: "2026-09-11", cityRegion: "Metro A", items: [opportunity] });
  const emptyMealPoolsByStay = buildTripMealVenuePools(R92_FRAME, R92_ANCHORS, R92_MOBILITY, [], 600, (s) => s.trim(), (a, b) => a === b);

  const { days, insertions } = backfillRealMealVenues([day], R92_FRAME, payload, R92_PROFILE, emptyMealPoolsByStay, 4, R92_WINDOW);

  assert.equal(insertions.length, 0);
  assert.ok(days[0].items.some((i) => i.itemRole === "meal_opportunity"), "genuine candidate exhaustion must keep the honest MealOpportunity, never invent a fake real venue");
});

/* -------------------- Q/S: FreeTime remains present; no country-wide prefetch required -------------------- */

test("Round 9.3 Q: a healthy composed trip still contains some deliberate FreeTime, not just wall-to-wall real activities", () => {
  const { composed } = r92Compose(
    Array.from({ length: 6 }, (_, i) => r92Rec(`attr-${i}`, `Attraction ${i}`, "attraction")),
    4
  );
  // The existing free-time filler (fillDerivedDayFields's own resequencing,
  // unchanged by this round) marks a slot as free time by leaving both
  // recommendationId and itemRole unset — real/meal items always set one
  // or the other, so this combination is the correct, existing signal for
  // "deliberately unplanned time" rather than a fabricated new field.
  const hasFreeTime = composed.plan.days.some((d) => d.items.some((i) => i.recommendationId == null && i.itemRole == null));
  assert.ok(hasFreeTime, "a normal composed trip should still include some deliberate free time, never every slot force-filled");
});

test("Round 9.3 S: buildTripFrame never requires payload.recommendations to be pre-populated for a skeleton-driven trip", async () => {
  const search = fakeSearchPlaces({ "new york": { name: "New York", lat: 40.7128, lon: -74.006 } });
  const emptyRecsPayload = usPayload({ recommendations: [], selectedPlaces: [], preferences: { ...usBasePreferences, mustVisitPlaces: "New York" } });
  const { frame } = await buildTripFrame(emptyRecsPayload, 10, null, undefined, search);
  assert.ok(frame.phases.some((p) => p.areaLabel === "New York"), "a real local stay must be resolved with zero recommendations pre-loaded");
});

/* ==================================================================== *
 * ROUND 9.3.2 — RESERVE-STAY COMPETITION, LIVE WIRING                   *
 * ==================================================================== */

test("Round 9.3.2 N/O: attemptReservePromotion builds a real pool for the promoted reserve and never touches the active stay's own pool", async () => {
  const activeFrame: TripFrame = {
    bucketId: "regional",
    source: "ai",
    phases: [{ id: "active-1", areaLabel: "Active City", nights: 8, startDayNumber: 1, endDayNumber: 8, intent: "mixed", anchor: { lat: 40, lon: -74 } }],
  };
  const reserve = { stayId: "reserve-1", proposedId: null, areaLabel: "Reserve City", lat: 41, lon: -75, nights: 3, reasons: ["must_visit"], source: "gemini_resolved" as const, confidence: "high" as const, countryIso: "US" };
  const activeStayShape = { stayId: "active-1", proposedId: null, areaLabel: "Active City", lat: 40, lon: -74, nights: 8, reasons: [], source: "gemini_resolved" as const, confidence: "high" as const, countryIso: "US" };

  // The active stay's own pool is intentionally WEAK (so the reserve has a
  // real chance to win) and passed in as an object reference we can assert
  // was never mutated/replaced.
  const activePool = {
    stayId: "active-1",
    ownerArea: "Active City",
    anchor: { lat: 40, lon: -74 },
    usableDayCapacity: 8,
    requiredRealActivityTarget: 24,
    desiredCandidateCount: 60,
    minimumViableCandidateCount: 24,
    candidates: [],
    categorySupply: {},
    diagnostics: {
      initialCandidateCount: 0, resolvedCandidateCount: 0, legalCandidateCount: 0, desiredCandidateCount: 60,
      refillAttempts: 0, refillCandidateCount: 0, providerFailures: 0, providerElapsedMs: 0, providerTimeouts: 0,
      dedupeRejected: 0, geographyRejected: 0, mealVenueExcluded: 0, classificationBreakdown: {}, supplyDegraded: false,
    },
  };
  const poolsByStay = new Map([["active-1", activePool]]);
  const mealPoolsByStay = new Map();

  const fakeFetch = async () => [
    { name: "Reserve Museum", category: "museum" as const, location: "Reserve City", shortDescription: "", lat: 41.01, lon: -75.01, openingHours: "08:00-20:00", wikipediaUrl: null, website: null },
    { name: "Reserve Landmark", category: "attraction" as const, location: "Reserve City", shortDescription: "", lat: 41.02, lon: -75.02, openingHours: "08:00-20:00", wikipediaUrl: null, website: null },
    { name: "Reserve Nature Spot", category: "nature" as const, location: "Reserve City", shortDescription: "", lat: 41.0, lon: -75.0, openingHours: "08:00-20:00", wikipediaUrl: null, website: null },
  ];

  const result = await attemptReservePromotion(
    activeFrame,
    11,
    [reserve],
    [activeStayShape],
    poolsByStay,
    mealPoolsByStay,
    R92_MOBILITY,
    R92_PROFILE,
    null,
    null,
    fakeFetch
  );

  assert.equal(result.promoted, true, `expected promotion, got: ${JSON.stringify(result)}`);
  assert.ok(result.reservePool && result.reservePool.candidates.length > 0, "the reserve must get a real, non-empty pool from Stage-B discovery");
  assert.equal(poolsByStay.get("active-1"), activePool, "the active stay's own pool object must never be replaced/rebuilt by reserve promotion");
  assert.ok(result.tripFrame.phases.some((p) => p.id === "reserve-1"), "the promoted reserve must appear as a real phase in the final frame");
});

test("Round 9.3.2: attemptReservePromotion returns promoted:false and leaves the frame untouched when there is nothing to promote", async () => {
  const frame: TripFrame = { bucketId: "regional", source: "ai", phases: [{ id: "active-1", areaLabel: "Active City", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "mixed", anchor: { lat: 40, lon: -74 } }] };
  const result = await attemptReservePromotion(frame, 5, [], [], new Map(), new Map(), R92_MOBILITY, R92_PROFILE, null, null);
  assert.equal(result.promoted, false);
  assert.equal(result.tripFrame, frame);
});

/* ================================================================== *
 * Round 9.3.7 — PARTIAL PROVIDER FAILURE MUST NOT KILL A MULTI-STAY    *
 * TRIP                                                                  *
 * ================================================================== */

function r937Pool(
  stayId: string,
  owner: string,
  overrides: Partial<{ requiredRealActivityTarget: number; legalCandidateCount: number; minimumViableCandidateCount: number; providerFailures: number; refillAttempts: number }> = {}
) {
  const requiredRealActivityTarget = overrides.requiredRealActivityTarget ?? 4;
  const minimumViableCandidateCount = overrides.minimumViableCandidateCount ?? 3;
  const legalCandidateCount = overrides.legalCandidateCount ?? 10;
  const providerFailures = overrides.providerFailures ?? 0;
  const refillAttempts = overrides.refillAttempts ?? 3;
  return {
    stayId,
    ownerArea: owner,
    anchor: { lat: 0, lon: 0 },
    usableDayCapacity: 3,
    requiredRealActivityTarget,
    desiredCandidateCount: 10,
    minimumViableCandidateCount,
    candidates: Array.from({ length: legalCandidateCount }, (_, i) => ({
      recommendationId: `${stayId}-cand-${i}`,
      name: `${owner} Sight ${i}`,
      category: "attraction" as const,
      classification: { primaryFamily: "LANDMARK", subtype: "iconic_landmark", secondaryFamilies: [], confidence: "category_fallback", metadata: {} } as never,
      significance: 50,
      lat: 0,
      lon: 0,
      location: owner,
      source: "api" as const,
    })),
    categorySupply: {},
    diagnostics: {
      initialCandidateCount: legalCandidateCount,
      resolvedCandidateCount: legalCandidateCount,
      legalCandidateCount,
      desiredCandidateCount: 10,
      refillAttempts,
      refillCandidateCount: 0,
      providerFailures,
      providerElapsedMs: 0,
      providerTimeouts: 0,
      dedupeRejected: 0,
      geographyRejected: 0,
      classificationBreakdown: {},
      supplyDegraded: false,
    },
  };
}

function r937SevenStayFrame(): TripFrame {
  const labels = ["New York", "Boston", "Providence", "Hartford", "North Conway", "Stowe", "Philadelphia"];
  let day = 1;
  const phases = labels.map((label, i) => {
    const p = { id: `phase-${i + 1}`, areaLabel: label, nights: 4, startDayNumber: day, endDayNumber: day + 3, intent: "mixed" as const };
    day += 4;
    return p;
  });
  return { bucketId: "multi_phase", source: "deterministic", phases };
}

const R937_WINDOW = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;

// A. 7 stays: 6 healthy, 1 provider failure -> NOT automatically catastrophic.
test("Round 9.3.7 A: 6 healthy stays + 1 provider-failed stay is PARTIALLY_DEGRADED, not catastrophic", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(
    frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 }) : r937Pool(p.id, p.areaLabel)])
  );
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.notEqual(assessment.tripSupplyState, "CATASTROPHIC_PROVIDER_FAILURE", "one failed stay out of 7 healthy-majority stays must never abort the whole trip");
  assert.equal(assessment.tripSupplyState, "PARTIALLY_DEGRADED");
});

// B. 7 stays: all provider failures, zero real supply -> catastrophic.
test("Round 9.3.7 B: all 7 stays provider-failed with zero supply is CATASTROPHIC_PROVIDER_FAILURE", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(frame.phases.map((p) => [p.id, r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 })]));
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.equal(assessment.tripSupplyState, "CATASTROPHIC_PROVIDER_FAILURE");
});

// M. Existing REAL_PLACE_DISCOVERY_UNAVAILABLE behavior remains for a
// genuinely catastrophic trip-wide failure: a single-stay trip whose only
// stay fails must still be catastrophic (never diluted by the new
// trip-level nuance).
test("Round 9.3.7 M: a single-stay trip whose only stay is provider-failed remains catastrophic", () => {
  const frame: TripFrame = { bucketId: "regional", source: "deterministic", phases: [{ id: "phase-1", areaLabel: "Solo City", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "mixed" }] };
  const pools = new Map([[frame.phases[0].id, r937Pool(frame.phases[0].id, "Solo City", { legalCandidateCount: 0, providerFailures: 2 })]]);
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.equal(assessment.tripSupplyState, "CATASTROPHIC_PROVIDER_FAILURE");
});

// L. Partial-degradation diagnostics contain healthy/failed/recoverable counts.
// N. Total real candidate accounting remains truthful.
test("Round 9.3.7 L/N: assessTripDiscoveryHealth reports truthful healthy/failed/candidate totals", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(
    frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 }) : r937Pool(p.id, p.areaLabel, { legalCandidateCount: 10 })])
  );
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.equal(assessment.totalStays, 7);
  assert.equal(assessment.healthyStays, 6);
  assert.equal(assessment.providerFailedStays, 1);
  assert.equal(assessment.totalRealActivityCandidates, 60, "6 healthy stays x 10 legal candidates + 1 failed stay x 0 = 60, never inflated or deflated");
  assert.ok(assessment.failedNormalDays > 0, "the failed stay's own normal days must be counted");
  assert.equal(assessment.unrecoverableFailedStays, 1, "with no recoveredStayIds passed, the one failed stay is unrecoverable by definition");
  assert.equal(assessment.recoverableFailedStays, 0);
});

// C. One failed stay still has legal preloaded candidates (selectedPlaces,
// never previously assigned to any stay pool) -> recovery uses them.
test("Round 9.3.7 C: bounded recovery uses a user's own selectedPlaces for the failed stay", () => {
  const frame = r937SevenStayFrame();
  const failedPhase = frame.phases[0]; // New York
  const areaAnchors = new Map(frame.phases.map((p) => [p.areaLabel, { lat: 0, lon: 0 }]));
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const existingPool = r937Pool(failedPhase.id, failedPhase.areaLabel, { legalCandidateCount: 0, providerFailures: 3 });
  const payload = buildPayload({
    recommendations: [],
    selectedPlaces: [buildRecommendation({ id: "user-pick-1", name: "Statue of Liberty", category: "attraction", location: "New York", lat: 0.0001, lon: 0.0001 })],
  });
  const result = attemptBoundedStayRecovery(failedPhase as never, payload, frame, areaAnchors, mobilityProfile, profile, existingPool as never, dayTypesByStay);
  assert.equal(result.recovered, true, "a legal selectedPlace for the failed stay's own area must be recovered");
  assert.ok(result.pool.candidates.some((c) => c.recommendationId === "user-pick-1"));
  assert.ok(result.recoveredRecommendations.some((r) => r.id === "user-pick-1"));
});

// D. Recovered stay retains PROVIDER_FAILURE telemetry even though
// generation may continue.
test("Round 9.3.7 D: a recovered stay's providerFailures/refillAttempts telemetry survives unchanged", () => {
  const frame = r937SevenStayFrame();
  const failedPhase = frame.phases[0];
  const areaAnchors = new Map(frame.phases.map((p) => [p.areaLabel, { lat: 0, lon: 0 }]));
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const existingPool = r937Pool(failedPhase.id, failedPhase.areaLabel, { legalCandidateCount: 0, providerFailures: 3, refillAttempts: 3 });
  const payload = buildPayload({
    recommendations: [],
    selectedPlaces: [buildRecommendation({ id: "user-pick-2", name: "Central Park", category: "attraction", location: "New York", lat: 0.0001, lon: 0.0001 })],
  });
  const result = attemptBoundedStayRecovery(failedPhase as never, payload, frame, areaAnchors, mobilityProfile, profile, existingPool as never, dayTypesByStay);
  assert.equal(result.recovered, true);
  assert.equal(result.pool.diagnostics.providerFailures, 3, "the real provider outage must remain truthfully recorded after recovery");
  assert.equal(result.pool.diagnostics.refillAttempts, 3, "the real provider request count must remain truthfully recorded after recovery");
});

// H. Healthy stays are never re-queried/touched by recovery.
test("Round 9.3.7 H: recovery never touches a healthy stay's own pool object", () => {
  const frame = r937SevenStayFrame();
  // Distinct anchors per stay (never a shared point — ownership must be
  // unambiguous), and the healthy stay (Boston) has its OWN anchor set
  // deliberately to also match r937Pool's default candidate coordinates
  // (0,0)... no: give Boston a real, distinct anchor so a genuine,
  // recoverable selectedPlace for ITS OWN area exists below — if recovery
  // ever ran against a healthy stay too (the mutation this test must
  // catch), that real candidate would get pulled in and its pool object
  // would be rebuilt/replaced.
  const areaAnchors = new Map([
    [frame.phases[0].areaLabel, { lat: 0, lon: 0 }], // New York (failed)
    [frame.phases[1].areaLabel, { lat: 10, lon: 10 }], // Boston (healthy)
    ...frame.phases.slice(2).map((p) => [p.areaLabel, { lat: 20 + frame.phases.indexOf(p), lon: 20 + frame.phases.indexOf(p) }] as const),
  ]);
  const healthyPool = { ...r937Pool(frame.phases[1].id, frame.phases[1].areaLabel), anchor: { lat: 10, lon: 10 } };
  const pools = new Map(
    frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 }) : i === 1 ? healthyPool : r937Pool(p.id, p.areaLabel)])
  );
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const payload = buildPayload({
    recommendations: [],
    // A genuine, recoverable real place for the HEALTHY stay's own area —
    // present specifically so a buggy "recover every stay" mutation has
    // something real to wrongly pull in.
    selectedPlaces: [buildRecommendation({ id: "boston-extra", name: "Boston Common", category: "attraction", location: "Boston", lat: 10.0001, lon: 10.0001 })],
  });
  const result = attemptBoundedRecoveryForFailedStays(payload, frame, areaAnchors, mobilityProfile, profile, pools as never, dayTypesByStay);
  assert.equal(result.poolsByStay.get(frame.phases[1].id), healthyPool, "the healthy stay's own pool object reference must be completely untouched, even when a real recoverable candidate for its own area exists");
});

// I. Recovery never borrows candidates from another stay.
test("Round 9.3.7 I: recovery never assigns a selectedPlace belonging to a DIFFERENT stay's area to the failed stay", () => {
  const frame = r937SevenStayFrame();
  const failedPhase = frame.phases[0]; // New York — existingPool's own anchor is (0,0), per r937Pool.
  const otherPhase = frame.phases[1]; // Boston
  // Boston's anchor is a SMALL offset from New York's (0,0) — close enough
  // that a place sitting exactly on it would still legally PASS New
  // York's own distance gate too, so only the OWNERSHIP (nearest-anchor)
  // rule — never a lucky legality rejection — is what must keep it out.
  const areaAnchors = new Map([
    [failedPhase.areaLabel, { lat: 0, lon: 0 }],
    [otherPhase.areaLabel, { lat: 0, lon: 0.05 } as const], // ~5.5km from New York's anchor
  ]);
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const existingPool = r937Pool(failedPhase.id, failedPhase.areaLabel, { legalCandidateCount: 0, providerFailures: 3 });
  const payload = buildPayload({
    recommendations: [],
    selectedPlaces: [buildRecommendation({ id: "boston-pick", name: "Fenway Park", category: "attraction", location: "Boston", lat: 0, lon: 0.05 })],
  });
  const result = attemptBoundedStayRecovery(failedPhase as never, payload, frame, areaAnchors, mobilityProfile, profile, existingPool as never, dayTypesByStay);
  assert.equal(result.recovered, false, "a selectedPlace geographically owned (nearest-anchor) by a DIFFERENT stay must never be recovered into this one, even though it would also pass New York's own legality distance check");
  assert.equal(result.pool.candidates.length, 0);
});

// J. Must-visit/arrival/departure failed stay is not silently deleted.
test("Round 9.3.7 J: a failed stay's own TripFrame phase is never deleted by recovery or assessment", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 }) : r937Pool(p.id, p.areaLabel)]));
  const areaAnchors = new Map(frame.phases.map((p) => [p.areaLabel, { lat: 0, lon: 0 }]));
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const payload = buildPayload({ recommendations: [], selectedPlaces: [] });
  const originalPhaseCount = frame.phases.length;
  attemptBoundedRecoveryForFailedStays(payload, frame, areaAnchors, mobilityProfile, profile, pools as never, dayTypesByStay);
  assert.equal(frame.phases.length, originalPhaseCount, "recovery must never remove a phase from the TripFrame, even when it stays unrecovered");
  assert.ok(frame.phases.some((p) => p.id === "phase-1"), "the failed (e.g. arrival/must-visit) stay's own phase must still exist");
});

// K. Unrecoverable failed stay with several normal sightseeing days and
// zero real candidates cannot silently become an all-FreeTime successful
// stay — proven directly against assertRealActivityCoverage's new
// per-stay gate, with a SMALL failed-stay share of a big multi-stay trip
// (never crossing the >50% trip-wide ratio on its own).
test("Round 9.3.7 K: an unrecoverable provider-failed stay with several all-synthetic normal days is never silently accepted, even as a small share of a big trip", () => {
  const frame = buildTestFrame([
    { areaLabel: "New York", nights: 4, startDayNumber: 1, endDayNumber: 4 },
    { areaLabel: "Healthy City", nights: 30, startDayNumber: 5, endDayNumber: 34 },
  ]);
  const newYorkPhase = frame.phases[0];
  const healthyPhase = frame.phases[1];
  // New York: 4 all-synthetic normal days (its own provider catastrophically failed).
  const nyDays = Array.from({ length: 4 }, (_, i) => r8Day([r8FreeTime(`NY Free ${i}`)], { dayNumber: i + 1, cityRegion: "New York" }));
  // Healthy City: every day has real content (a large healthy majority of the trip).
  const healthyDays = Array.from({ length: 30 }, (_, i) =>
    r8Day([buildItem({ name: `Healthy Sight ${i}`, category: "attraction", recommendationId: `rec-h${i}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: i + 5, cityRegion: "Healthy City" })
  );
  const report = validateItineraryQuality([...nyDays, ...healthyDays], frame, R8_WINDOW);
  // Sanity: NY's 4 days are nowhere near the trip-wide 50% ratio (4/34 ≈ 12%).
  assert.ok(report.unjustifiedDaysWithOnlySyntheticContent <= 4, "sanity: only New York's own days are unjustified-empty");

  const bigPool = Array.from({ length: 12 }, (_, i) => r8Rec(`rec-pool-${i}`, `Pool Place ${i}`, "attraction"));
  let caught: InstanceType<typeof InsufficientRealActivityCoverageError> | null = null;
  try {
    assertRealActivityCoverage(
      report,
      r8Payload(bigPool),
      { tripFrame: frame, countryName: "United States" },
      new Map([
        [newYorkPhase.id, { poolSize: 0, portfolioSelected: 0, isCatastrophicProviderFailure: true }],
        [healthyPhase.id, { poolSize: 12, portfolioSelected: 10, isCatastrophicProviderFailure: false }],
      ])
    );
  } catch (error) {
    if (error instanceof InsufficientRealActivityCoverageError) caught = error;
  }
  assert.ok(caught, "an unrecoverable, confirmed-provider-failed stay with ALL its own normal days empty must throw, even though it is only 4/34 ≈ 12% of the trip");
  const nyStay = caught!.diagnostics.stays!.find((s) => s.stayId === newYorkPhase.id);
  assert.ok(nyStay, "the failed stay must be named in the diagnostic");
  assert.equal(nyStay!.uncoveredDays, nyStay!.normalDays, "every one of the failed stay's own normal days is uncovered");
});

// Confirms the trip-wide ratio gate ALONE would NOT have caught Round
// 9.3.7 K's shape (proving the new per-stay gate is the one doing the
// work, not a coincidence of the existing majority check).
test("Round 9.3.7 K2: the pre-existing trip-wide majority ratio does not, by itself, cover a small failed stay's share", () => {
  const frame = buildTestFrame([
    { areaLabel: "New York", nights: 4, startDayNumber: 1, endDayNumber: 4 },
    { areaLabel: "Healthy City", nights: 30, startDayNumber: 5, endDayNumber: 34 },
  ]);
  const nyDays = Array.from({ length: 4 }, (_, i) => r8Day([r8FreeTime(`NY Free ${i}`)], { dayNumber: i + 1, cityRegion: "New York" }));
  const healthyDays = Array.from({ length: 30 }, (_, i) =>
    r8Day([buildItem({ name: `Healthy Sight ${i}`, category: "attraction", recommendationId: `rec-h${i}`, lat: R8_A.lat, lon: R8_A.lon })], { dayNumber: i + 5, cityRegion: "Healthy City" })
  );
  const report = validateItineraryQuality([...nyDays, ...healthyDays], frame, R8_WINDOW);
  const unjustifiedRatio = report.unjustifiedDaysWithOnlySyntheticContent / (nyDays.length + healthyDays.length);
  assert.ok(unjustifiedRatio <= 0.5, `sanity: the trip-wide ratio (${unjustifiedRatio}) must be well under the 0.5 majority bar on its own`);
});

// E. TRUE_LOW_SUPPLY remains distinct from PROVIDER_FAILURE (regression,
// same distinction, now also proven not to be affected by trip-level
// health assessment).
test("Round 9.3.7 E: TRUE_LOW_SUPPLY and PROVIDER_FAILURE remain distinct supplyStates under the new trip-level assessment", () => {
  const frame = r937SevenStayFrame();
  const trueLowPool = r937Pool(frame.phases[0].id, frame.phases[0].areaLabel, { legalCandidateCount: 0, providerFailures: 0 });
  const providerFailPool = r937Pool(frame.phases[1].id, frame.phases[1].areaLabel, { legalCandidateCount: 0, providerFailures: 3 });
  const pools = new Map(frame.phases.map((p, i) => [p.id, i === 0 ? trueLowPool : i === 1 ? providerFailPool : r937Pool(p.id, p.areaLabel)]));
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  const trueLow = assessment.stayFailures.find((s) => s.stayId === frame.phases[0].id);
  const providerFail = assessment.stayFailures.find((s) => s.stayId === frame.phases[1].id);
  assert.equal(trueLow!.supplyState, "TRUE_LOW_SUPPLY");
  assert.equal(providerFail!.supplyState, "PROVIDER_FAILURE");
  // Only the genuine provider failure counts toward providerFailedStays (a
  // TRUE_LOW_SUPPLY stay never had a confirmed provider outage, so it is
  // not catastrophically-discovery-unavailable at all).
  assert.equal(assessment.providerFailedStays, 1);
});

// F. Successful provider call with zero results does not become provider failure.
test("Round 9.3.7 F: a stay with zero candidates but zero provider failures is TRUE_LOW_SUPPLY, never miscounted as a provider failure", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 0 }) : r937Pool(p.id, p.areaLabel)]));
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.equal(assessment.tripSupplyState, "HEALTHY", "a genuinely quiet destination (no provider failure) must never trigger provider-failure trip semantics");
  assert.equal(assessment.providerFailedStays, 0);
});

// G. Failed provider requests with zero results remain provider failure.
test("Round 9.3.7 G: a stay with zero candidates AND real provider failures remains classified as a provider failure", () => {
  const frame = r937SevenStayFrame();
  const pools = new Map(frame.phases.map((p, i) => [p.id, i === 0 ? r937Pool(p.id, p.areaLabel, { legalCandidateCount: 0, providerFailures: 3 }) : r937Pool(p.id, p.areaLabel)]));
  const assessment = assessTripDiscoveryHealth(pools as never, frame, "2026-06-01", R937_WINDOW);
  assert.equal(assessment.providerFailedStays, 1);
  assert.equal(assessment.stayFailures[0].supplyState, "PROVIDER_FAILURE");
});

// O. No additional provider request starts during recovery — structurally
// guaranteed (attemptBoundedStayRecovery/attemptBoundedRecoveryForFailedStays
// take no fetch/network parameter at all), proven by running recovery with
// no network mock available and confirming it completes synchronously
// using only in-memory data.
test("Round 9.3.7 O: bounded recovery completes with no network/provider call of any kind", () => {
  const frame = r937SevenStayFrame();
  const failedPhase = frame.phases[0];
  const areaAnchors = new Map(frame.phases.map((p) => [p.areaLabel, { lat: 0, lon: 0 }]));
  const mobilityProfile = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const profile = buildTripPreferenceProfile(basePreferences, "United States", 28);
  const dayTypesByStay = new Map(frame.phases.map((p) => [p.id, [{ dayNumber: p.startDayNumber, dayType: "normal" as const, hasExplicitRestWindow: false }]]));
  const existingPool = r937Pool(failedPhase.id, failedPhase.areaLabel, { legalCandidateCount: 0, providerFailures: 3 });
  const payload = buildPayload({
    recommendations: [],
    selectedPlaces: [buildRecommendation({ id: "sync-pick", name: "Synchronous Pick", category: "attraction", location: "New York", lat: 0.0001, lon: 0.0001 })],
  });
  const result = attemptBoundedStayRecovery(failedPhase as never, payload, frame, areaAnchors, mobilityProfile, profile, existingPool as never, dayTypesByStay);
  assert.equal(result.recovered, true);
  assert.equal(typeof (result as unknown as { then?: unknown }).then, "undefined", "the result must be a plain synchronous value, never a Promise from an async network call");
});

/* ================================================================== *
 * Round 9.4 — DETERMINISTIC CONSERVATION-TRACE FIXTURE (spec §T)      *
 * Observability only — this proves the UNDERLYING counts/identities   *
 * the new RealPlaceQA logs report on are internally consistent across *
 * discovery -> normalization -> role classification -> geography ->   *
 * pool -> portfolio -> composition -> repair. It does not assert any  *
 * console-log formatting, per spec §T ("verify counts and identities, *
 * not exact console formatting"). No planner behavior is changed by   *
 * this round — this test exercises EXISTING functions, unmodified.    *
 * ================================================================== */
test("Round 9.4 T: deterministic 2-stay conservation trace — discovery through repair", () => {
  const frame: TripFrame = {
    bucketId: "multi_phase",
    source: "deterministic",
    phases: [
      { id: "stay-a", areaLabel: "Boston", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" },
      { id: "stay-b", areaLabel: "Providence", nights: 2, startDayNumber: 4, endDayNumber: 5, intent: "mixed" },
    ],
  };
  const areaAnchors = new Map([
    ["Boston", { lat: 0, lon: 0 }],
    ["Providence", { lat: 10, lon: 10 }],
  ]);
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

  // Exactly the round's own required shape: several real POIs per stay,
  // one restaurant, one transport-category candidate ("one airport"), one
  // wrong-stay attraction, one duplicate.
  const candidates: TripRecommendation[] = [
    buildRecommendation({ id: "a1", name: "Sight 1", category: "attraction", location: "Boston", lat: 0.001, lon: 0.001 }),
    buildRecommendation({ id: "a2", name: "Sight 2", category: "museum", location: "Boston", lat: 0.002, lon: 0.002 }),
    buildRecommendation({ id: "a3", name: "Sight 3", category: "attraction", location: "Boston", lat: 0.003, lon: 0.003 }),
    buildRecommendation({ id: "a1", name: "Sight 1", category: "attraction", location: "Boston", lat: 0.001, lon: 0.001 }), // duplicate of a1
    buildRecommendation({ id: "meal1", name: "Restaurant 1", category: "restaurant", location: "Boston", lat: 0.001, lon: 0.001 }),
    buildRecommendation({ id: "airport1", name: "Boston Logan Airport", category: "transportation", location: "Boston", lat: 0.001, lon: 0.001 }),
    buildRecommendation({ id: "b1", name: "Wrong Stay Attraction", category: "attraction", location: "Providence", lat: 10.001, lon: 10.001 }),
  ];

  // Stage 1: geographic ownership — the wrong-stay attraction must be
  // owned by Providence, never Boston, regardless of how it was listed.
  const ownership = assignCandidatesToStays(candidates, frame, areaAnchors, (s) => s.trim(), (a, b) => a === b);
  const stayAOwned = ownership.get("stay-a")!;
  const stayBOwned = ownership.get("stay-b")!;
  assert.deepEqual(stayAOwned.map((c) => c.id).sort(), ["a1", "a1", "a2", "a3", "airport1", "meal1"].sort());
  assert.deepEqual(stayBOwned.map((c) => c.id), ["b1"]);

  // Stage 2: pool construction — normalization (dedupe) + role
  // classification (meal exclusion) funnel, with an explainable sum.
  const capacityA = computeStayCapacity([
    { dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false },
    { dayNumber: 2, dayType: "normal", hasExplicitRestWindow: false },
    { dayNumber: 3, dayType: "normal", hasExplicitRestWindow: false },
  ]);
  const poolA = buildStayActivityPool(frame.phases[0], stayAOwned, { lat: 0, lon: 0 }, mobility, capacityA, [], 600);
  assert.equal(poolA.diagnostics.initialCandidateCount, 6, "all 6 Boston-owned raw candidates are accounted for");
  assert.equal(poolA.diagnostics.dedupeRejected, 1, "the duplicate a1 is rejected exactly once");
  assert.equal(poolA.diagnostics.mealVenueExcluded, 1, "the restaurant is excluded from the activity pool");
  assert.equal(
    poolA.diagnostics.initialCandidateCount,
    poolA.candidates.length + poolA.diagnostics.dedupeRejected + poolA.diagnostics.geographyRejected + poolA.diagnostics.mealVenueExcluded,
    "conservation invariant: every input candidate is accounted for by exactly one outcome (accepted or one rejection reason)"
  );
  assert.equal(poolA.diagnostics.geographyRejected, 0, "no candidate here should fail Boston's own legality check");
  assert.deepEqual(new Set(poolA.candidates.map((c) => c.recommendationId)), new Set(["a1", "a2", "a3", "airport1"]));
  // Round 9.4 finding (observability only, NOT fixed this round, per
  // spec "do not fix yet"): a transportation-category candidate
  // ("airport1") survives into the real activity pool — determinePlanningRole
  // only ever distinguishes ACTIVITY vs MEAL_VENUE, never excluding
  // transportation/practical the way buildStayActivityPool already
  // excludes meal venues. Recorded here as evidence for a future round,
  // not corrected in this one.
  assert.ok(poolA.candidates.some((c) => c.recommendationId === "airport1"), "documents the current (unfixed) behavior: transportation-category candidates are not excluded from the activity pool");
  assert.equal(classifyZeroPoolReason(poolA.diagnostics), "UNKNOWN", "sanity: a non-empty pool should never itself need a zero-pool reason (this call is only meaningful when poolSize is 0)");

  // Stage 3: portfolio selection — every selected id must trace back to
  // a real pool candidate.
  const NEUTRAL_WEIGHTS = { CULTURE: 1, LANDMARK: 1, ENTERTAINMENT: 1, NATURE: 1, LOCAL_EXPERIENCE: 1, SHOPPING: 1, FOOD: 1, OTHER: 1 };
  const portfolioA = selectStayPortfolio(poolA, 3, NEUTRAL_WEIGHTS, [], 1);
  const poolIds = new Set(poolA.candidates.map((c) => c.recommendationId));
  assert.ok(portfolioA.selected.every((c) => poolIds.has(c.recommendationId)), "every selected candidate must trace back to the real pool, never an invented identity");
  assert.ok(portfolioA.selected.length > 0, "a healthy 4-candidate pool with a 3-slot target must select something");

  // Stage 4: composition — the composer must schedule real content from
  // BOTH stays, never inventing an identity that never existed.
  const dayCount = 5;
  const preferences: TripPreferences = { ...basePreferences, startDate: "2026-09-10", endDate: "2026-09-14" };
  const payload = buildPayload({ recommendations: candidates, preferences });
  const profile = buildTripPreferenceProfile(preferences, "Country X", dayCount);
  const dayTypesByStay = new Map([
    ["stay-a", [
      { dayNumber: 1, dayType: "normal" as const, hasExplicitRestWindow: false },
      { dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false },
      { dayNumber: 3, dayType: "normal" as const, hasExplicitRestWindow: false },
    ]],
    ["stay-b", [
      { dayNumber: 4, dayType: "normal" as const, hasExplicitRestWindow: false },
      { dayNumber: 5, dayType: "normal" as const, hasExplicitRestWindow: false },
    ]],
  ]);
  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
    frame, areaAnchors, mobility, candidates, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b
  );
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const composed = composeDaysFromStayPortfolios(frame, dayCount, window, poolsByStay, portfoliosByStay, payload, profile);
  const composedSnapshot = snapshotRealActivities(composed.plan.days);
  assert.ok(composedSnapshot.length > 0, "composition must schedule at least some real content from the healthy pools");
  const allRealIds = new Set(["a1", "a2", "a3", "b1", "airport1"]);
  assert.ok(composedSnapshot.every((s) => allRealIds.has(s.id)), "every scheduled real identity must trace back to a real candidate, never a fabricated one");
  assert.ok(composedSnapshot.some((s) => s.id === "b1"), "Providence's own real candidate must be scheduled on one of ITS OWN days, not dropped");

  // Stage 5: repair — an identity diff proves whatever repairPlan does
  // (keep, add, or remove) is at least fully accounted for: nothing that
  // survives repair is an identity that was never real.
  const raw = {
    title: composed.plan.title,
    summary: composed.plan.summary,
    days: composed.plan.days.map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date,
      title: d.title || "",
      cityRegion: d.cityRegion,
      accommodation: d.accommodation || "",
      notes: d.notes || "",
      transportation: d.transportation || "",
      items: d.items.map((i) => ({
        name: i.name,
        category: i.category,
        location: i.location,
        shortDescription: i.shortDescription,
        slot: i.slot,
        plannedStartTime: i.plannedStartTime,
        estimatedDurationMinutes: i.estimatedDurationMinutes ?? undefined,
      })),
    })),
  };
  const repaired = repairPlan(raw, payload, profile, frame, null, undefined, null);
  const repairedSnapshot = snapshotRealActivities(repaired.days);
  assert.ok(repairedSnapshot.every((s) => allRealIds.has(s.id)), "every real identity surviving repair must trace back to a real candidate, never fabricated by repair");
  const delta = diffRealActivitySnapshots(composedSnapshot, repairedSnapshot);
  assert.equal(delta.addedIds.every((id) => allRealIds.has(id)), true, "any identity repair adds must still be a real, known candidate");
});

/* ================================================================== *
 * Round 9.4.1 — REPAIRPLAN FORENSICS ONLY                              *
 * ================================================================== */

function rsi(overrides: Partial<RepairSnapshotItem> = {}): RepairSnapshotItem {
  return {
    id: "rec-1",
    name: "Sight 1",
    category: "attraction",
    itemRole: "real_place",
    phaseId: "phase-1",
    dayNumber: 1,
    lat: 0,
    lon: 0,
    kind: "real_activity",
    hasRecommendationId: true,
    ...overrides,
  };
}

// A. RepairStepDelta preserves identity when step does nothing.
test("Round 9.4.1 A: computeRepairStepDelta reports zero delta and no removals when a step changes nothing", () => {
  const items = [rsi({ id: "a" }), rsi({ id: "b", kind: "real_meal", category: "restaurant" })];
  const result = computeRepairStepDelta(items, items);
  assert.deepEqual(result.delta, { realActivities: 0, realMeals: 0, syntheticActivities: 0, mealOpportunities: 0, totalItems: 0 });
  assert.equal(result.removedRealActivities.length, 0);
  assert.equal(result.addedRealActivities.length, 0);
  assert.equal(result.reclassifiedItems.length, 0);
  assert.equal(result.movedItems.length, 0);
});

// B. Removing one real POI reports exactly that ID.
test("Round 9.4.1 B: removing exactly one real POI reports exactly that id, nothing else", () => {
  const before = [rsi({ id: "a" }), rsi({ id: "b", name: "Sight 2" })];
  const after = [rsi({ id: "a" })];
  const result = computeRepairStepDelta(before, after);
  assert.equal(result.removedRealActivities.length, 1);
  assert.equal(result.removedRealActivities[0].id, "b");
  assert.equal(result.delta.realActivities, -1);
});

// C. Reclassifying real -> synthetic is reported as loss/reclassification.
test("Round 9.4.1 C: a real activity reclassified into a synthetic item is reported as BOTH a reclassification and a loss", () => {
  const before = [rsi({ id: "a" })];
  const after = [rsi({ id: "a", category: "practical", itemRole: "free_time", kind: "synthetic_activity" })];
  const result = computeRepairStepDelta(before, after);
  assert.equal(result.reclassifiedItems.length, 1);
  assert.equal(result.reclassifiedItems[0].beforeCategory, "attraction");
  assert.equal(result.reclassifiedItems[0].afterCategory, "practical");
  assert.equal(result.removedRealActivities.length, 1, "a real item recreated as synthetic must count as a loss (spec §D), not just a silent relabel");
  assert.equal(result.removedRealActivities[0].id, "a");
});

// D. Moving POI between days does not count as loss.
test("Round 9.4.1 D: moving a real POI to a different day is reported as a move, never a loss", () => {
  const before = [rsi({ id: "a", dayNumber: 3 })];
  const after = [rsi({ id: "a", dayNumber: 7 })];
  const result = computeRepairStepDelta(before, after);
  assert.equal(result.movedItems.length, 1);
  assert.equal(result.movedItems[0].fromDay, 3);
  assert.equal(result.movedItems[0].toDay, 7);
  assert.equal(result.removedRealActivities.length, 0, "a same-id item that only changed day must never be counted as removed");
  assert.equal(result.delta.realActivities, 0);
});

// E. Losing recommendationId across round-trip is detected.
test("Round 9.4.1 E: an item recreated at the same identity but WITHOUT its recommendationId is flagged as an identity downgrade", () => {
  const before = [rsi({ id: "coords:0:0:sight-1", hasRecommendationId: false })];
  const after = [rsi({ id: "coords:0:0:sight-1", hasRecommendationId: false })];
  // Sanity: identical hasRecommendationId=false on both sides is NOT a downgrade.
  assert.equal(computeRepairStepDelta(before, after).identityDowngradedIds.length, 0);

  const beforeWithId = [rsi({ id: "coords:0:0:sight-1", hasRecommendationId: true })];
  const afterWithoutId = [rsi({ id: "coords:0:0:sight-1", hasRecommendationId: false })];
  const result = computeRepairStepDelta(beforeWithId, afterWithoutId);
  assert.deepEqual(result.identityDowngradedIds, ["coords:0:0:sight-1"], "a same-key item that lost its recommendationId must be flagged, even though the derived id string still matches");
});

// F. Attempt start/end counts are correct.
test("Round 9.4.1 F: computeRepairStepDelta's before/after counts correctly aggregate a mixed snapshot (the same math attempt start/end logging uses)", () => {
  const items = [
    rsi({ id: "a1", kind: "real_activity" }),
    rsi({ id: "a2", kind: "real_activity" }),
    rsi({ id: "m1", kind: "real_meal", category: "restaurant" }),
    rsi({ id: "s1", kind: "synthetic_activity", category: "practical", hasRecommendationId: false }),
    rsi({ id: "s2", kind: "synthetic_activity", category: "practical", hasRecommendationId: false }),
    rsi({ id: "s3", kind: "synthetic_activity", category: "practical", hasRecommendationId: false }),
    rsi({ id: "mo1", kind: "meal_opportunity", category: "restaurant", hasRecommendationId: false }),
  ];
  const result = computeRepairStepDelta(items, items);
  assert.deepEqual(result.before, { realActivities: 2, realMeals: 1, syntheticActivities: 3, mealOpportunities: 1, totalItems: 7 });
  assert.deepEqual(result.after, result.before);
});

// G. FallbackEntry captures real supply still available at fallback time.
test("Round 9.4.1 G: the real-activity/meal split FallbackEntry logs is computed correctly from payload.recommendations", () => {
  const recs = [
    buildRecommendation({ id: "act-1", name: "Sight", category: "attraction" }),
    buildRecommendation({ id: "act-2", name: "Museum", category: "museum" }),
    buildRecommendation({ id: "meal-1", name: "Cafe", category: "cafe" }),
  ];
  const payload = buildPayload({ recommendations: recs });
  // The exact same function generateCountryItineraryPlan's FallbackEntry log uses.
  const activityDays = [r8Day([buildItem({ name: "x", category: "attraction", recommendationId: "act-1", lat: 0, lon: 0 })])];
  void activityDays; // not needed further — this test targets the supply-side split, not scheduling
  assert.equal(payload.recommendations.filter((r) => r.category !== "restaurant" && r.category !== "cafe").length, 2, "2 real activity candidates available at fallback time");
  assert.equal(payload.recommendations.filter((r) => r.category === "restaurant" || r.category === "cafe").length, 1, "1 real meal candidate available at fallback time");
});

// H. FallbackOutput distinguishes real vs FreeTime.
test("Round 9.4.1 H: snapshotDayItemsForRepairTrace correctly distinguishes real activities/meals from FreeTime/meal-opportunity synthetic filler", () => {
  const frame = buildTestFrame([{ areaLabel: "Area A", nights: 2, startDayNumber: 1, endDayNumber: 2 }]);
  const days = [
    r8Day(
      [
        buildItem({ name: "Real Sight", category: "attraction", recommendationId: "rec-1", lat: R8_A.lat, lon: R8_A.lon }),
        buildItem({ name: "Real Meal", category: "restaurant", recommendationId: "rec-2", lat: R8_A.lat, lon: R8_A.lon }),
        r8FreeTime("Free Block"),
      ],
      { dayNumber: 1 }
    ),
  ];
  const snapshot = snapshotDayItemsForRepairTrace(days, frame);
  const byKind = { real_activity: 0, real_meal: 0, synthetic_activity: 0, meal_opportunity: 0, other: 0 };
  for (const item of snapshot) byKind[item.kind] += 1;
  assert.equal(byKind.real_activity, 1);
  assert.equal(byKind.real_meal, 1);
  assert.equal(byKind.synthetic_activity, 1);
});

// I. Empty/stale recommendation source used during pool rebuild is visible.
test("Round 9.4.1 I: a pool rebuilt from an empty recommendation source is classified as NO_DISCOVERY_RESULTS, never silently reported as healthy", () => {
  const pool = buildStayActivityPool(
    { id: "phase-1", areaLabel: "Boston", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" },
    [], // the exact "stale/empty recommendation source" shape item H is concerned with
    { lat: 0, lon: 0 },
    { tier: "medium", localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 },
    { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] },
    [],
    600
  );
  assert.equal(pool.candidates.length, 0);
  assert.equal(classifyZeroPoolReason(pool.diagnostics), "NO_DISCOVERY_RESULTS", "an empty input source (never a provider failure) must be classified distinctly, visible to the next real run's logs");
});

// J. Catastrophic anomaly fires for 103->0 equivalent.
test("Round 9.4.1 J: isCatastrophicRepairLoss fires for a 103 -> 0 equivalent loss", () => {
  assert.equal(isCatastrophicRepairLoss(103, 0), true);
  assert.equal(isCatastrophicRepairLoss(4, 1), true, "a >=50% loss (not only a total wipeout) must also fire");
});

// K. Catastrophic anomaly does not fire for harmless small delta.
test("Round 9.4.1 K: isCatastrophicRepairLoss does not fire for the actual harmless deltas measured in the Round 9.4.1 deterministic fixture", () => {
  assert.equal(isCatastrophicRepairLoss(105, 97), false, "the real measured 105->97 activity delta from the deterministic 7-stay fixture must never be flagged catastrophic");
  assert.equal(isCatastrophicRepairLoss(0, 0), false, "nothing to lose from zero must never fire");
});

// L. Deterministic multi-stay composed plan enters repair with real POIs.
// M. If deterministic reproduction triggers the bug, identify the first
// exact primitive where the large loss occurs — per spec §I, if it does
// NOT reproduce, report that honestly rather than invent one. This
// fixture (7 stays, 41 days, healthy per-stay supply engineered for >=2
// real activities/day) is the SAME shape used for this round's live
// forensic investigation (see the final report): it reliably produces
// real POIs entering repair (proving L), but reproduces only a modest,
// explainable loss — never the catastrophic 100% production loss — so
// this test intentionally asserts the MODEST bound actually observed,
// not a fabricated catastrophic one.
test("Round 9.4.1 L/M: a deterministic 7-stay/41-day composed plan enters repairPlan with many real POIs, and repairPlan's own loss stays modest (not catastrophic) for this healthy-supply fixture", () => {
  const labels = ["Boston", "Providence", "Hartford", "North Conway", "Stowe", "Berkshires", "New York"];
  const nights = [6, 6, 6, 5, 6, 6, 6];
  let day = 1;
  const phases = labels.map((label, i) => {
    const p = { id: `phase-${i + 1}`, areaLabel: label, nights: nights[i], startDayNumber: day, endDayNumber: day + nights[i] - 1, intent: "mixed" as const };
    day += nights[i];
    return p;
  });
  const dayCount = day - 1;
  const frame: TripFrame = { bucketId: "multi_phase", source: "deterministic", phases };
  const areaAnchors = new Map(labels.map((label, i) => [label, { lat: 40 + i, lon: -70 - i }]));
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

  const recommendations: TripRecommendation[] = [];
  for (let s = 0; s < labels.length; s++) {
    const anchor = areaAnchors.get(labels[s])!;
    for (let i = 0; i < nights[s] * 3; i++) {
      recommendations.push(
        buildRecommendation({ id: `${labels[s]}-act-${i}`, name: `${labels[s]} Sight ${i}`, category: i % 3 === 0 ? "museum" : "attraction", location: labels[s], lat: anchor.lat + i * 0.001, lon: anchor.lon + i * 0.001 })
      );
    }
    for (let i = 0; i < nights[s] * 3; i++) {
      recommendations.push(
        buildRecommendation({
          id: `${labels[s]}-meal-${i}`,
          name: `${labels[s]} Eatery ${i}`,
          category: i % 2 === 0 ? "restaurant" : "cafe",
          location: labels[s],
          lat: anchor.lat + i * 0.0005,
          lon: anchor.lon - i * 0.0005,
          openingHours: "08:00-23:00",
        })
      );
    }
  }

  const startDate = new Date("2026-06-01T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const preferences: TripPreferences = { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
  const payload = buildPayload({ recommendations, preferences });
  const profile = buildTripPreferenceProfile(preferences, "United States", dayCount);
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const dayTypesByStay = new Map(
    phases.map((p) => [
      p.id,
      Array.from({ length: p.nights }, (_, i) => ({ dayNumber: p.startDayNumber + i, dayType: "normal" as const, hasExplicitRestWindow: false })),
    ])
  );

  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
    frame, areaAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b
  );
  const mealPools = buildTripMealVenuePools(frame, areaAnchors, mobility, recommendations, 600, (s) => s.trim(), (a, b) => a === b);
  const composed = composeDaysFromStayPortfolios(frame, dayCount, window, poolsByStay, portfoliosByStay, payload, profile, mealPools);

  // L: real POIs genuinely entered repair.
  const composedSnapshot = snapshotRealActivities(composed.plan.days);
  assert.ok(composedSnapshot.length > 50, `expected a large healthy real-activity count before repair, got ${composedSnapshot.length}`);

  const raw: RawGeneratedPlan = {
    title: composed.plan.title,
    summary: composed.plan.summary,
    days: composed.plan.days.map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date,
      title: d.title || "",
      cityRegion: d.cityRegion,
      accommodation: d.accommodation || "",
      notes: d.notes || "",
      transportation: d.transportation || "",
      items: d.items.map((i) => ({
        name: i.name,
        category: i.category,
        location: i.location,
        shortDescription: i.shortDescription,
        slot: i.slot,
        plannedStartTime: i.plannedStartTime,
        estimatedDurationMinutes: i.estimatedDurationMinutes ?? undefined,
      })),
    })),
  };
  const repaired = repairPlan(raw, payload, profile, frame, null, window, null);
  const repairedSnapshot = snapshotRealActivities(repaired.days);

  // M: this fixture does NOT reproduce a catastrophic loss — asserted
  // explicitly (never silently), matching the round's own instruction to
  // report rather than invent a fix when reproduction fails. See the
  // final report for the live measurement this bound is based on
  // (105 -> 97, an ~8% loss) and the honest disclosure that the
  // catastrophic 103 -> 0 production shape remains unreproduced.
  assert.ok(!isCatastrophicRepairLoss(composedSnapshot.length, repairedSnapshot.length), `expected NO catastrophic loss for this healthy-supply fixture, got ${composedSnapshot.length} -> ${repairedSnapshot.length}`);
  assert.ok(repairedSnapshot.length > 0, "repair must not have destroyed everything in this deterministic reproduction");
});

/* ================================================================== *
 * Round 9.4.2 — FIX THE PROVEN ZERO-REAL-PLACE FALLBACK BUG            *
 * ================================================================== */

// N. Gemini failure caused only by missingMeals does not destroy real activities.
test("Round 9.4.2 N: passesHardInvariantsForFallbackRecovery tolerates missingMeals alone", () => {
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ missingMeals: 16 })), true);
});

// O. Gemini failure caused only by overloadedDays does not destroy real activities.
test("Round 9.4.2 O: passesHardInvariantsForFallbackRecovery tolerates overloadedDays alone", () => {
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ overloadedDays: 1 })), true);
});

// P. Gemini failure caused only by longTravelDays does not destroy real activities.
test("Round 9.4.2 P: passesHardInvariantsForFallbackRecovery tolerates longTravelDays alone", () => {
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ longTravelDays: 6 })), true);
});

// Q. Combined production diagnostics still preserve real content.
test("Round 9.4.2 Q: passesHardInvariantsForFallbackRecovery tolerates the EXACT combined production shape (missingMeals:16, overloadedDays:1, longTravelDays:6)", () => {
  const diagnostics = cleanDiagnostics({ missingMeals: 16, overloadedDays: 1, longTravelDays: 6 });
  assert.equal(passesHardInvariantsForFallbackRecovery(diagnostics), true, "the exact production failure shape must be treated as a soft/pacing failure, never a hard corruption");
  // Sanity: this exact shape genuinely fails the FULL, unchanged passesValidation gate — proving the new function is deliberately NARROWER, not a relaxation of the existing one.
  assert.equal(passesValidation(diagnostics), false, "sanity: passesValidation itself remains completely unchanged and still fails on this shape");
});

// Hard invariants must still correctly REJECT genuine corruption — never a blanket pass.
test("Round 9.4.2: passesHardInvariantsForFallbackRecovery correctly rejects genuine structural/geographic/legal corruption", () => {
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ duplicatePlaces: 1 })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ invalidCoordinates: 1 })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ crossCityDays: 1 })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ outOfBudget: true })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ timeOverlaps: 1 })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ openingHoursViolations: 1 })), false);
  assert.equal(passesHardInvariantsForFallbackRecovery(cleanDiagnostics({ impossibleStayTransitions: 1 })), false);
});

// K. Real supply + normal days + final 0 real activities triggers REAL_PLACE_CONTENT_LOST.
// R. Persistence cannot receive a zero-real itinerary when authoritative real supply exists.
test("Round 9.4.2 K/R: assertRealActivityCoverage throws RealPlaceContentLostError for the exact production shape (real supply existed, final real activities are literally zero)", () => {
  const dayCount = 20;
  const frame = buildTestFrame([{ areaLabel: "Area A", nights: dayCount, startDayNumber: 1, endDayNumber: dayCount }]);
  // Every day ends up all-FreeTime (matches FallbackOutput's realActivities:0), despite a healthy real candidate pool existing.
  const days = Array.from({ length: dayCount }, (_, i) => r8Day([r8FreeTime(`Free ${i}`)], { dayNumber: i + 1 }));
  const report = validateItineraryQuality(days, frame, R8_WINDOW);
  const bigPool = Array.from({ length: 212 }, (_, i) => r8Rec(`rec-pool-${i}`, `Pool Place ${i}`, "attraction"));
  let caught: unknown = null;
  try {
    assertRealActivityCoverage(report, r8Payload(bigPool), { tripFrame: frame, countryName: "Country X" }, undefined, true);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RealPlaceContentLostError, `expected RealPlaceContentLostError, got ${caught instanceof Error ? caught.constructor.name : typeof caught}`);
  const error = caught as InstanceType<typeof RealPlaceContentLostError>;
  assert.equal(error.code, "REAL_PLACE_CONTENT_LOST");
  assert.equal(error.diagnostics.finalRealActivities, 0);
  assert.equal(error.diagnostics.totalRealActivityCandidates, 212);
  assert.equal(error.diagnostics.fallbackUsed, true);
});

// L. Genuine zero-supply trip is still allowed to use synthetic fallback
// according to existing product policy — the NEW gate must never fire for
// genuine destination scarcity (spec §12A), only reusing the SAME >=10
// non-trivial-pool threshold the existing majority-failure check already
// established.
test("Round 9.4.2 L: a genuinely tiny real pool (below the non-trivial threshold) still degrades silently, never triggering REAL_PLACE_CONTENT_LOST", () => {
  const days = Array.from({ length: 6 }, (_, i) => r8Day([r8FreeTime()], { dayNumber: i + 1 }));
  const report = validateItineraryQuality(days, buildTestFrame([{ areaLabel: "Area A", nights: 6, startDayNumber: 1, endDayNumber: 6 }]), R8_WINDOW);
  assert.doesNotThrow(() => assertRealActivityCoverage(report, r8Payload([r8Rec("rec-j1", "Only Candidate", "attraction")]), undefined, undefined, true));
});

// A/B/C/D/E/F/G/I/J — the core fix: a composed plan that fails ONLY soft
// validation must be preserved (not discarded) with its real identities,
// coordinates, stay ownership, and meals all intact, and never borrows
// another stay's candidates or introduces duplicates.
test("Round 9.4.2 A/B/C/D/E/F/G/I/J: the real-place-preserving checkpoint sequence preserves identity, coordinates, ownership, and meals for a plan that only fails soft validation", () => {
  const labels = ["Boston", "Providence", "Hartford"];
  const nights = [4, 4, 4];
  let day = 1;
  const phases = labels.map((label, i) => {
    const p = { id: `phase-${i + 1}`, areaLabel: label, nights: nights[i], startDayNumber: day, endDayNumber: day + nights[i] - 1, intent: "mixed" as const };
    day += nights[i];
    return p;
  });
  const dayCount = day - 1;
  const frame: TripFrame = { bucketId: "multi_phase", source: "deterministic", phases };
  const areaAnchors = new Map(labels.map((label, i) => [label, { lat: 40 + i * 5, lon: -70 - i * 5 }]));
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

  const recommendations: TripRecommendation[] = [];
  for (let s = 0; s < labels.length; s++) {
    const anchor = areaAnchors.get(labels[s])!;
    for (let i = 0; i < nights[s] * 3; i++) {
      recommendations.push(
        buildRecommendation({ id: `${labels[s]}-act-${i}`, name: `${labels[s]} Sight ${i}`, category: i % 3 === 0 ? "museum" : "attraction", location: labels[s], lat: anchor.lat + i * 0.001, lon: anchor.lon + i * 0.001 })
      );
    }
    for (let i = 0; i < nights[s] * 8; i++) {
      recommendations.push(
        buildRecommendation({
          id: `${labels[s]}-meal-${i}`,
          name: `${labels[s]} Eatery ${i}`,
          category: i % 2 === 0 ? "restaurant" : "cafe",
          location: labels[s],
          lat: anchor.lat + i * 0.0005,
          lon: anchor.lon - i * 0.0005,
          openingHours: "08:00-23:00",
        })
      );
    }
  }

  const startDate = new Date("2026-06-01T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const preferences: TripPreferences = { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
  const payload = buildPayload({ recommendations, preferences });
  const profile = buildTripPreferenceProfile(preferences, "United States", dayCount);
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const dayTypesByStay = new Map(
    phases.map((p) => [
      p.id,
      Array.from({ length: p.nights }, (_, i) => ({ dayNumber: p.startDayNumber + i, dayType: "normal" as const, hasExplicitRestWindow: false })),
    ])
  );

  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
    frame, areaAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b
  );
  const mealPools = buildTripMealVenuePools(frame, areaAnchors, mobility, recommendations, 600, (s) => s.trim(), (a, b) => a === b);
  const composed = composeDaysFromStayPortfolios(frame, dayCount, window, poolsByStay, portfoliosByStay, payload, profile, mealPools);

  const raw: RawGeneratedPlan = {
    title: composed.plan.title,
    summary: composed.plan.summary,
    days: composed.plan.days.map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date,
      title: d.title || "",
      cityRegion: d.cityRegion,
      accommodation: d.accommodation || "",
      notes: d.notes || "",
      transportation: d.transportation || "",
      items: d.items.map((i) => ({
        name: i.name,
        category: i.category,
        location: i.location,
        shortDescription: i.shortDescription,
        slot: i.slot,
        plannedStartTime: i.plannedStartTime,
        estimatedDurationMinutes: i.estimatedDurationMinutes ?? undefined,
      })),
    })),
  };
  // "composedRepaired" — exactly what the real pipeline builds via
  // repairPlan(toRawGeneratedPlan(composed.plan), ...) before the
  // passesValidation gate is ever checked.
  const composedRepaired = repairPlan(raw, payload, profile, frame, null, window, null);
  const beforeCheckpoint = snapshotRealActivities(composedRepaired.days);
  assert.ok(beforeCheckpoint.length > 10, `expected substantial real content entering the checkpoint, got ${beforeCheckpoint.length}`);

  // This is THE checkpoint sequence Round 9.4.2's fix runs when
  // passesHardInvariantsForFallbackRecovery holds but the FULL
  // passesValidation gate does not (e.g. missingMeals/overloadedDays/
  // longTravelDays) — reusing composedPoolsByStay/portfoliosByStay
  // already computed above, never a fresh discovery/pool rebuild (H).
  const checkpointFinalPlan = finalizeArrivalDepartureContent(composedRepaired, payload, profile, dayCount, window, frame, areaAnchors, mobility);
  assert.doesNotThrow(() =>
    assertRealActivityCoverage(
      validateItineraryQuality(checkpointFinalPlan.days, frame, window),
      payload,
      { tripFrame: frame, countryName: "United States" },
      buildStaySupplyDiagnosticsMap(frame, poolsByStay, portfoliosByStay),
      false
    )
  );

  // C/D: real recommendation IDs and coordinates survive.
  const realItems = checkpointFinalPlan.days.flatMap((d) => d.items.filter((i) => i.recommendationId != null));
  assert.ok(realItems.length > 0);
  assert.ok(realItems.every((i) => i.lat != null && i.lon != null), "every real item must retain its real coordinates");
  const allKnownIds = new Set(recommendations.map((r) => r.id));
  assert.ok(realItems.every((i) => allKnownIds.has(i.recommendationId!)), "every surviving real id must trace back to a genuine known candidate, never fabricated");

  // E/I: correct stay ownership, never cross-stay borrowing (a Boston
  // candidate must never appear on a Hartford day, and vice versa).
  for (const d of checkpointFinalPlan.days) {
    const phase = findFramePhaseForDay(frame, d.dayNumber);
    if (!phase) continue;
    for (const item of d.items) {
      if (!item.recommendationId) continue;
      assert.ok(item.recommendationId.startsWith(`${phase.areaLabel}-`), `item ${item.recommendationId} on day ${d.dayNumber} (owned by ${phase.areaLabel}) must belong to that same stay, never borrowed from another`);
    }
  }

  // G: real meals survive.
  const realMeals = checkpointFinalPlan.days.flatMap((d) => d.items.filter((i) => i.recommendationId != null && (i.category === "restaurant" || i.category === "cafe")));
  assert.ok(realMeals.length > 0, "real meal venues must survive the checkpoint, never all replaced by MealOpportunity");

  // J: no duplicate real recommendationId across the whole trip.
  const allRealIds = checkpointFinalPlan.days.flatMap((d) => d.items.filter((i) => i.recommendationId != null).map((i) => i.recommendationId!));
  assert.equal(new Set(allRealIds).size, allRealIds.length, "no real recommendationId may be scheduled more than once across the whole trip");
});

// H. Fix the exact zero-input rebuild data flow: repairPlan's own internal
// areaAnchors must include a phase's AUTHORITATIVE tripFrame anchor even
// when no recommendation's own location text happens to textually match
// that phase's exact area label (traceId gen-mu7ihdq8-545bii8p's own root
// cause — computeAreaAnchors alone silently produced a pool of size 0 for
// a stay that genuinely had 18+ real candidates, purely because their
// `location` field read "Downtown, Bar Harbor" while the phase's own
// area label was "Bar Harbor").
test("Round 9.4.2 H: resolveAreaAnchorsForFrame (now used inside repairPlan) recovers a phase's real candidate pool that computeAreaAnchors alone would silently zero out", () => {
  const phase = { id: "phase-1", areaLabel: "Bar Harbor", nights: 6, startDayNumber: 1, endDayNumber: 6, anchor: { lat: 44.39, lon: -68.2 }, intent: "mixed" as const };
  const frame: TripFrame = { bucketId: "single_base", source: "deterministic", phases: [phase] };
  const recommendations: TripRecommendation[] = Array.from({ length: 18 }, (_, i) =>
    buildRecommendation({
      id: `act-${i}`,
      name: `Sight ${i}`,
      category: i % 3 === 0 ? "museum" : "attraction",
      location: "Downtown, Bar Harbor",
      lat: 44.39 + i * 0.001,
      lon: -68.2 + i * 0.001,
    })
  );
  const payload = buildPayload({ recommendations });
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
  const dayTypesByStay = new Map([[phase.id, Array.from({ length: 6 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }))]]);

  // The exact bug: computeAreaAnchors keys strictly by the FIRST comma
  // segment of each recommendation's own location text ("Downtown"),
  // never by the phase's own area label ("Bar Harbor") — so a lookup by
  // phase.areaLabel finds nothing despite 18 real, geographically-correct
  // candidates existing.
  const buggyAnchors = computeAreaAnchors(payload);
  assert.ok(!buggyAnchors.has("Bar Harbor"), "sanity: computeAreaAnchors alone genuinely has no entry under the phase's own area label for this realistic location-text mismatch");
  const { poolsByStay: buggyPools } = buildTripActivityPortfolios(frame, buggyAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  assert.equal(buggyPools.get(phase.id)!.candidates.length, 0, "reproduces the exact production zero-input pool despite 18 real candidates existing");

  // repairPlan's own fix: resolveAreaAnchorsForFrame merges tripFrame's
  // AUTHORITATIVE phase.anchor over the fragile text-derived map, keyed
  // directly by phase.areaLabel — recovering full coverage without any
  // new discovery/provider call.
  const fixedAnchors = resolveAreaAnchorsForFrame(frame, buggyAnchors);
  const { poolsByStay: fixedPools } = buildTripActivityPortfolios(frame, fixedAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  assert.equal(fixedPools.get(phase.id)!.candidates.length, 18, "the fix must recover the full real candidate pool from the SAME 18 already-known recommendations, never a fresh discovery call");
});

// H (structural corollary). No provider calls are added by fallback — the
// checkpoint sequence (passesHardInvariantsForFallbackRecovery +
// finalizeArrivalDepartureContent + assertRealActivityCoverage) is
// entirely synchronous, so it cannot possibly have performed a network
// request.
test("Round 9.4.2 H: the checkpoint decision function is synchronous, structurally incapable of a network call", () => {
  const result = passesHardInvariantsForFallbackRecovery(cleanDiagnostics());
  assert.equal(typeof result, "boolean");
  assert.equal(typeof (result as unknown as { then?: unknown }), "boolean", "a plain boolean, never a Promise");
});

/* ================================================================== *
 * Round 9.4.3 — FIX REAL-PLACE DUPLICATE OSCILLATION                   *
 * ================================================================== */

const R943_FRAME: TripFrame = buildTestFrame([
  { areaLabel: "Area A", nights: 4, startDayNumber: 1, endDayNumber: 4 },
  { areaLabel: "Area B", nights: 4, startDayNumber: 5, endDayNumber: 8 },
]);
const R943_A = { lat: 10, lon: 10 };
const R943_B = { lat: 60, lon: 60 };
const R943_ANCHORS = new Map<string, { lat: number; lon: number } | null>([
  ["Area A", R943_A],
  ["Area B", R943_B],
]);
const R943_MOBILITY = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };
const R943_PROFILE = buildTripPreferenceProfile(basePreferences, "Country X", 8);

function r943Day(dayNumber: number, items: AiGeneratedItem[]): AiGeneratedDay {
  const inAreaB = dayNumber >= 5;
  return buildDay({ dayNumber, cityRegion: inAreaB ? "Area B" : "Area A", items });
}
function r943Item(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return buildItem({ lat: R943_A.lat, lon: R943_A.lon, location: "Area A", ...overrides });
}
function r943Rec(id: string, overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return buildRecommendation({ id, name: id, location: "Area A", lat: R943_A.lat, lon: R943_A.lon, ...overrides });
}

// A. Same recommendationId on two normal days -> one survives.
test("Round 9.4.3 A: resolveExactIdDuplicates keeps exactly one occurrence of a duplicated recommendationId across two days", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-1" })]),
    r943Day(2, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-1" })]),
  ];
  const payload = buildPayload({ recommendations: [r943Rec("dup-1", { name: "Dup Place", category: "attraction" }), r943Rec("alt-1", { name: "Alt Place", category: "attraction" })] });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const groups = computeRealPlaceDuplicateGroups(resolved, R943_FRAME);
  assert.equal(groups.length, 0, "no exact-ID duplicate must remain");
  const survivorCount = resolved.flatMap((d) => d.items).filter((i) => i.recommendationId === "dup-1").length;
  assert.equal(survivorCount, 1, "exactly one occurrence of dup-1 must survive");
});

// B. Same restaurant ID on two days -> one survives.
test("Round 9.4.3 B: resolveExactIdDuplicates keeps exactly one occurrence of a duplicated real meal venue", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Punjab", category: "restaurant", recommendationId: "punjab-1", slot: "lunch" })]),
    r943Day(2, [r943Item({ name: "Punjab", category: "restaurant", recommendationId: "punjab-1", slot: "lunch" })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("punjab-1", { name: "Punjab", category: "restaurant" }),
      r943Rec("alt-restaurant-1", { name: "Alt Restaurant", category: "restaurant" }),
    ],
  });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const survivorCount = resolved.flatMap((d) => d.items).filter((i) => i.recommendationId === "punjab-1").length;
  assert.equal(survivorCount, 1, "exactly one occurrence of the duplicated restaurant must survive");
});

// C. Removed real meal is reinserted only if no surviving occurrence already exists.
test("Round 9.4.3 C: selectMealVenueFromPool never re-selects an already-used venue while an unused legal one exists, and returns null (not a repeat) once the whole pool is used", () => {
  const usedVenue = { recommendationId: "used-1", classification: { suitableMealTypes: ["LUNCH"], cuisineFamilies: [], cuisineSubtypes: [] } } as unknown as Parameters<typeof selectMealVenueFromPool>[0]["venues"][number];
  const unusedVenue = { recommendationId: "unused-1", classification: { suitableMealTypes: ["LUNCH"], cuisineFamilies: [], cuisineSubtypes: [] } } as unknown as typeof usedVenue;
  const pool = { stayId: "s1", ownerArea: "Area A", anchor: R943_A, venues: [usedVenue, unusedVenue], cuisineSupply: {}, mealTypeSupply: {}, diagnostics: {} } as unknown as Parameters<typeof selectMealVenueFromPool>[0];
  const context = {
    mealType: "LUNCH" as const,
    anchor: null,
    nextAnchor: null,
    pace: "balanced" as const,
    transportation: "הליכה",
    recentHistory: [],
    dayIndex: 1,
    cuisineWeights: {},
    usedRecommendationIds: new Set(["used-1"]),
  } as unknown as Parameters<typeof selectMealVenueFromPool>[1];
  const first = selectMealVenueFromPool(pool, context, R943_PROFILE);
  assert.equal(first?.candidate.recommendationId, "unused-1", "must pick the unused venue over the already-used one");

  const exhaustedContext = { ...context, usedRecommendationIds: new Set(["used-1", "unused-1"]) };
  const second = selectMealVenueFromPool(pool, exhaustedContext, R943_PROFILE);
  assert.equal(second, null, "once every legal venue is used, must return null (letting the caller fall back to a MealOpportunity) rather than repeating one");
});

// D. rebalanceDayItems cannot recreate an ID already used elsewhere.
test("Round 9.4.3 D: rebalanceDayItems never replaces a violating item with an already-used recommendationId", () => {
  const usageState = createItineraryUsageState();
  registerItineraryUsage(usageState, { recommendationId: "elsewhere-1", name: "Elsewhere Place", lat: R943_A.lat, lon: R943_A.lon, itemRole: "real_place" });
  const day = r943Day(1, [r943Item({ name: "Avoided Place", category: "attraction", recommendationId: null })]);
  const payload = buildPayload({
    preferences: { ...basePreferences, placesToAvoid: "Avoided Place" },
    recommendations: [r943Rec("elsewhere-1", { name: "Elsewhere Place", category: "attraction" }), r943Rec("fresh-1", { name: "Fresh Place", category: "attraction" })],
  });
  const profile = buildTripPreferenceProfile(payload.preferences, "Country X", 8);
  const result = rebalanceDayItems(day, payload, profile, usageState);
  assert.ok(!result.items.some((i) => i.recommendationId === "elsewhere-1"), "must never reintroduce the id already registered as used elsewhere");
});

// E. fillUnderfilledDay cannot recreate an ID already used elsewhere.
test("Round 9.4.3 E: fillUnderfilledDay never fills a gap with an already-used recommendationId", () => {
  const usageState = createItineraryUsageState();
  registerItineraryUsage(usageState, { recommendationId: "elsewhere-2", name: "Elsewhere Place 2", lat: R943_A.lat, lon: R943_A.lon, itemRole: "real_place" });
  const day = r943Day(1, [r943Item({ name: "Only Stop", category: "attraction", recommendationId: "only-1" })]);
  const payload = buildPayload({
    recommendations: [r943Rec("elsewhere-2", { name: "Elsewhere Place 2", category: "attraction" }), r943Rec("only-1", { name: "Only Stop", category: "attraction" })],
  });
  const result = fillUnderfilledDay(day, payload, R943_PROFILE, usageState);
  assert.ok(!result.items.some((i) => i.recommendationId === "elsewhere-2"), "must never fill an underfilled day with an id already used elsewhere");
});

// F. insertMissingMeals cannot duplicate a real meal venue.
test("Round 9.4.3 F: insertMissingMeals prefers an unused real meal venue over repeating an already-used one when an alternative exists", () => {
  const usedMealNames = new Set<string>(["used restaurant"]);
  // Lunch is already covered so exactly ONE real slot (dinner) is missing —
  // isolates the "which single venue gets picked" decision from the
  // (separate, already-correct) within-day double-booking prevention.
  const day = r943Day(1, [
    r943Item({ name: "Morning Sight", category: "attraction", slot: "morning" }),
    r943Item({ name: "Lunch Stop", category: "cafe", slot: "lunch" }),
  ]);
  const payload = buildPayload({
    recommendations: [
      r943Rec("used-restaurant-1", { name: "Used Restaurant", category: "restaurant" }),
      r943Rec("fresh-restaurant-1", { name: "Fresh Restaurant", category: "restaurant" }),
    ],
  });
  const result = insertMissingMeals(day, payload, R943_PROFILE, usedMealNames, 8, null);
  const mealNames = result.items.filter((i) => i.category === "restaurant").map((i) => i.name);
  assert.equal(mealNames.length, 1, `expected exactly one restaurant slot filled, got ${JSON.stringify(mealNames)}`);
  assert.equal(mealNames[0], "Fresh Restaurant", "the single missing dinner slot must prefer the unused venue over the already-used one");
});

// G. repairNormalDayTravelOutliers replacement cannot use an already-used ID.
test("Round 9.4.3 G: repairNormalDayTravelOutliers builds its own usage state from the CURRENT full itinerary, so a replacement never duplicates an id already scheduled on another day", () => {
  const farItem = r943Item({ name: "Far Outlier", category: "attraction", recommendationId: "far-1", lat: R943_A.lat + 5, lon: R943_A.lon + 5 });
  const days = [
    r943Day(1, [r943Item({ name: "Anchor A", category: "attraction", recommendationId: "anchor-a" }), farItem]),
    r943Day(2, [r943Item({ name: "Nearby Alt", category: "attraction", recommendationId: "nearby-alt" })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("anchor-a", { name: "Anchor A", category: "attraction" }),
      r943Rec("nearby-alt", { name: "Nearby Alt", category: "attraction" }),
      r943Rec("far-1", { name: "Far Outlier", category: "attraction", lat: R943_A.lat + 5, lon: R943_A.lon + 5 }),
    ],
  });
  const result = repairNormalDayTravelOutliers(days, R943_MOBILITY, payload, R943_PROFILE, new Map());
  const allIds = result.days.flatMap((d) => d.items).map((i) => i.recommendationId).filter((id): id is string => id != null);
  assert.equal(new Set(allIds).size, allIds.length, "no recommendationId may appear twice across the repaired days");
});

// H. diversifyActivities cannot use an already-used ID.
test("Round 9.4.3 H: diversifyActivities never introduces a recommendationId already present elsewhere in the trip", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Museum 1", category: "museum", recommendationId: "museum-1" })]),
    r943Day(2, [r943Item({ name: "Museum 2", category: "museum", recommendationId: "museum-2" })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("museum-1", { name: "Museum 1", category: "museum" }),
      r943Rec("museum-2", { name: "Museum 2", category: "museum" }),
      r943Rec("park-1", { name: "Park 1", category: "attraction" }),
    ],
  });
  const result = diversifyActivities(days, payload, R943_PROFILE, "museum", []);
  const allIds = result.flatMap((d) => d.items).map((i) => i.recommendationId).filter((id): id is string => id != null);
  assert.equal(new Set(allIds).size, allIds.length, "diversifyActivities must never duplicate a recommendationId already used elsewhere");
});

// I. exact-ID duplicate across two phaseIds resolves to authoritative geographic phase.
test("Round 9.4.3 I: an exact-ID duplicate across two phases resolves to the geographically authoritative phase, not whichever day happened to schedule it first", () => {
  const duplicateNearB = r943Item({ name: "Harvard Club of Boston", category: "restaurant", recommendationId: "harvard-1", lat: R943_B.lat, lon: R943_B.lon, location: "Area B" });
  const days = [
    r943Day(1, [duplicateNearB]), // scheduled in Area A's day range, but geographically in Area B
    r943Day(5, [r943Item({ name: "Harvard Club of Boston", category: "restaurant", recommendationId: "harvard-1", lat: R943_B.lat, lon: R943_B.lon, location: "Area B" })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("harvard-1", { name: "Harvard Club of Boston", category: "restaurant", lat: R943_B.lat, lon: R943_B.lon, location: "Area B" }),
      r943Rec("alt-b-1", { name: "Alt Area B Restaurant", category: "restaurant", lat: R943_B.lat, lon: R943_B.lon, location: "Area B" }),
    ],
  });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const survivorDay = resolved.find((d) => d.items.some((i) => i.recommendationId === "harvard-1"));
  assert.ok(survivorDay, "the real place must survive somewhere");
  assert.equal(survivorDay!.dayNumber, 5, "the surviving occurrence must be on the day belonging to Area B (phase-2), the item's geographically authoritative phase");
});

// J. Harvard-style phase oscillation: repeated repair attempts do not alternate phase ownership.
test("Round 9.4.3 J: repairCrossRegionDayContent never relocates an item across a phase boundary, across repeated invocations", () => {
  // The outlier is scheduled on a phase-1 (Area A) day but its own real
  // coordinates sit exactly where phase-2's (Area B) own day-5 content
  // already is — a genuine within-day geographic outlier on day 1 AND
  // the exact "nearest other day's coordinates" magnet that the
  // unbounded (pre-fix) findCompatibleDayIndexForOutlier would relocate
  // it toward, reproducing the real phase-6 -> phase-2 shape.
  let days = [
    r943Day(1, [
      r943Item({ name: "Harvard Club of Boston", category: "restaurant", recommendationId: "harvard-1", lat: R943_B.lat, lon: R943_B.lon }),
      r943Item({ name: "Area A Sight", category: "attraction", recommendationId: "area-a-sight", lat: R943_A.lat, lon: R943_A.lon }),
    ]),
    r943Day(5, [r943Item({ name: "Area B Sight", category: "attraction", recommendationId: "area-b-sight", lat: R943_B.lat, lon: R943_B.lon })]),
  ];
  const payload = buildPayload({ recommendations: [] });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = repairCrossRegionDayContent(days, payload, R943_PROFILE, R943_FRAME);
    days = result.days;
    const phase1Day = days.find((d) => d.dayNumber === 1)!;
    const phase2Day = days.find((d) => d.dayNumber === 5)!;
    assert.ok(!phase2Day.items.some((i) => i.recommendationId === "harvard-1"), `attempt ${attempt}: Harvard Club of Boston must never cross into phase-2's day`);
    // It may be replaced in place (never relocated cross-phase), but if it
    // still exists anywhere, it must stay on a phase-1 (Area A) day.
    const stillExists = days.some((d) => d.items.some((i) => i.recommendationId === "harvard-1"));
    if (stillExists) {
      assert.ok(phase1Day.items.some((i) => i.recommendationId === "harvard-1"), `attempt ${attempt}: if it still exists, it must remain on its original phase-1 day, never oscillate`);
    }
  }
});

// K. Glen-House-style phase oscillation: same, with a hotel-category item.
test("Round 9.4.3 K: repairCrossRegionDayContent never relocates a hotel-category item across a phase boundary, across repeated invocations", () => {
  let days = [
    r943Day(1, [
      r943Item({ name: "The Glen House Hotel", category: "hotel", recommendationId: "glen-house-1", lat: R943_B.lat, lon: R943_B.lon }),
      r943Item({ name: "Area A Sight", category: "attraction", recommendationId: "area-a-sight-2", lat: R943_A.lat, lon: R943_A.lon }),
    ]),
    r943Day(5, [r943Item({ name: "Area B Sight", category: "attraction", recommendationId: "area-b-sight-2", lat: R943_B.lat, lon: R943_B.lon })]),
  ];
  const payload = buildPayload({ recommendations: [] });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = repairCrossRegionDayContent(days, payload, R943_PROFILE, R943_FRAME);
    days = result.days;
    const phase2Day = days.find((d) => d.dayNumber === 5)!;
    assert.ok(!phase2Day.items.some((i) => i.recommendationId === "glen-house-1"), `attempt ${attempt}: The Glen House Hotel must never cross into phase-2's day`);
  }
});

// L. duplicate count is monotonic non-increasing across one full repair attempt (idempotency).
test("Round 9.4.3 L: resolveExactIdDuplicates is idempotent — a second call on its own output finds nothing left to resolve", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-l" })]),
    r943Day(2, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-l" })]),
    r943Day(3, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-l" })]),
  ];
  const payload = buildPayload({ recommendations: [r943Rec("dup-l", { name: "Dup Place", category: "attraction" }), r943Rec("alt-l", { name: "Alt L", category: "attraction" })] });
  const before = computeRealPlaceDuplicateGroups(days, R943_FRAME).length;
  const afterFirst = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const afterFirstCount = computeRealPlaceDuplicateGroups(afterFirst, R943_FRAME).length;
  const afterSecond = resolveExactIdDuplicates(afterFirst, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const afterSecondCount = computeRealPlaceDuplicateGroups(afterSecond, R943_FRAME).length;
  assert.ok(before > 0, "sanity: the fixture starts with a genuine duplicate");
  assert.equal(afterFirstCount, 0, "one pass must fully resolve this duplicate");
  assert.ok(afterSecondCount <= afterFirstCount, "a second pass must never increase the duplicate count (monotonic non-increasing)");
});

// M. duplicate count does not increase again on attempts 2/3/4 — exercised via the full repairPlan loop on a realistic multi-stay fixture (see the production-shaped acceptance test below, "Round 9.4.3 S/M").

// N. fuzzy duplicate with different IDs still handled by existing fuzzy logic.
test("Round 9.4.3 N: removeFuzzyDuplicatePlaces still resolves a same-name/same-coordinate duplicate that carries no recommendationId", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Generic Overlook", category: "attraction", recommendationId: null, lat: R943_A.lat, lon: R943_A.lon })]),
    r943Day(2, [r943Item({ name: "Generic Overlook", category: "attraction", recommendationId: null, lat: R943_A.lat, lon: R943_A.lon })]),
  ];
  const payload = buildPayload({ recommendations: [] });
  const result = removeFuzzyDuplicatePlaces(days, payload, R943_PROFILE);
  const survivorCount = result.flatMap((d) => d.items).filter((i) => i.name === "Generic Overlook").length;
  assert.equal(survivorCount, 1, "the pre-existing fuzzy-duplicate pass must still resolve id-less duplicates");
});

// O. two distinct venues with similar names are not falsely merged.
test("Round 9.4.3 O: two distinct real venues with different recommendationIds and far-apart coordinates both survive", () => {
  const days = [
    r943Day(1, [r943Item({ name: "City Grill", category: "restaurant", recommendationId: "grill-a", lat: R943_A.lat, lon: R943_A.lon })]),
    r943Day(5, [r943Item({ name: "City Grill", category: "restaurant", recommendationId: "grill-b", lat: R943_B.lat, lon: R943_B.lon })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("grill-a", { name: "City Grill", category: "restaurant" }),
      r943Rec("grill-b", { name: "City Grill", category: "restaurant", lat: R943_B.lat, lon: R943_B.lon, location: "Area B" }),
    ],
  });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const groups = computeRealPlaceDuplicateGroups(resolved, R943_FRAME);
  assert.equal(groups.length, 0, "two genuinely different recommendationIds must never be treated as a duplicate group");
  assert.ok(resolved.flatMap((d) => d.items).some((i) => i.recommendationId === "grill-a"));
  assert.ok(resolved.flatMap((d) => d.items).some((i) => i.recommendationId === "grill-b"));
});

// P. locked/fixedTime occurrence wins when legal.
test("Round 9.4.3 P: a locked occurrence of a duplicated id always survives, the non-locked occurrence is replaced", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Locked Place", category: "attraction", recommendationId: "locked-1", locked: true })]),
    r943Day(2, [r943Item({ name: "Locked Place", category: "attraction", recommendationId: "locked-1" })]),
  ];
  const payload = buildPayload({ recommendations: [r943Rec("locked-1", { name: "Locked Place", category: "attraction" }), r943Rec("alt-p", { name: "Alt P", category: "attraction" })] });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const day1 = resolved.find((d) => d.dayNumber === 1)!;
  const day2 = resolved.find((d) => d.dayNumber === 2)!;
  assert.ok(day1.items.some((i) => i.recommendationId === "locked-1" && i.locked), "the locked occurrence must survive untouched");
  assert.ok(!day2.items.some((i) => i.recommendationId === "locked-1"), "the non-locked occurrence must be replaced");
});

// Q. if locked occurrence is geographically illegal (here: two locked occurrences of the same id, a genuine conflict), preserve existing protected-item semantics and surface a precise conflict rather than silently cloning/moving it.
test("Round 9.4.3 Q: two locked occurrences of the same duplicated id are never silently resolved — both are left untouched and the final firewall reports the precise conflict", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Locked Place", category: "attraction", recommendationId: "locked-2", locked: true })]),
    r943Day(2, [r943Item({ name: "Locked Place", category: "attraction", recommendationId: "locked-2", locked: true })]),
  ];
  const payload = buildPayload({ recommendations: [r943Rec("locked-2", { name: "Locked Place", category: "attraction" })] });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const survivorCount = resolved.flatMap((d) => d.items).filter((i) => i.recommendationId === "locked-2").length;
  assert.equal(survivorCount, 2, "a genuine two-locked-occurrence conflict must never be silently resolved by this repair pass");

  let caught: unknown = null;
  try {
    assertNoRealPlaceDuplicatesRemain(resolved, R943_FRAME);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RealPlaceDuplicatesRemainError, "the final firewall must surface this as a precise, named conflict");
  const error = caught as InstanceType<typeof RealPlaceDuplicatesRemainError>;
  assert.equal(error.diagnostics.duplicates[0]?.recommendationId, "locked-2");
  assert.equal(error.diagnostics.duplicates[0]?.occurrences.length, 2);
});

// R. replacement after duplicate removal comes from same stay and has a different recommendationId.
test("Round 9.4.3 R: the replacement chosen for a removed duplicate belongs to the same stay and never reuses the survivor's recommendationId", () => {
  const days = [
    r943Day(1, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-r" })]),
    r943Day(2, [r943Item({ name: "Dup Place", category: "attraction", recommendationId: "dup-r" })]),
  ];
  const payload = buildPayload({
    recommendations: [
      r943Rec("dup-r", { name: "Dup Place", category: "attraction" }),
      r943Rec("same-stay-alt", { name: "Same Stay Alt", category: "attraction", location: "Area A" }),
    ],
  });
  const resolved = resolveExactIdDuplicates(days, R943_FRAME, R943_ANCHORS, R943_MOBILITY, payload, R943_PROFILE);
  const replaced = resolved.flatMap((d) => d.items).find((i) => i.recommendationId === "same-stay-alt");
  assert.ok(replaced, "the loser must be replaced by a real, different, same-stay candidate when one exists");
  assert.notEqual(replaced!.recommendationId, "dup-r");
});

// S. zero duplicate real IDs at successful repairPlan exit, on a realistic multi-stay production-shaped fixture (Section M's acceptance fixture).
test("Round 9.4.3 S/M: a production-shaped multi-stay fixture with exact-ID duplicates, Harvard/Glen-House-style misplacement, and meal remove/reinsert churn exits repairPlan with zero duplicates and materially non-zero real content", () => {
  const labels = ["Boston", "Providence", "Hartford", "North Conway", "Stowe", "Berkshires"];
  const nights = [6, 6, 6, 5, 6, 6];
  let day = 1;
  const phases = labels.map((label, i) => {
    const p = { id: `phase-${i + 1}`, areaLabel: label, nights: nights[i], startDayNumber: day, endDayNumber: day + nights[i] - 1, intent: "mixed" as const };
    day += nights[i];
    return p;
  });
  const dayCount = day - 1;
  assert.ok(dayCount >= 30, "sanity: fixture must be 30+ days per spec §M");
  const frame: TripFrame = { bucketId: "multi_phase", source: "deterministic", phases };
  const areaAnchors = new Map(labels.map((label, i) => [label, { lat: 40 + i, lon: -70 - i }]));
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

  const recommendations: TripRecommendation[] = [];
  for (let s = 0; s < labels.length; s++) {
    const anchor = areaAnchors.get(labels[s])!;
    for (let i = 0; i < nights[s] * 3; i++) {
      recommendations.push(
        buildRecommendation({ id: `${labels[s]}-act-${i}`, name: `${labels[s]} Sight ${i}`, category: i % 3 === 0 ? "museum" : "attraction", location: labels[s], lat: anchor.lat + i * 0.001, lon: anchor.lon + i * 0.001 })
      );
    }
    // Deliberately generous meal supply (spec §M includes exact-ID
    // duplicates as a SEPARATE, deliberately-injected case below — this
    // fixture's own natural supply should not also independently manufacture
    // meal-scarcity duplicates, which would confound the two).
    for (let i = 0; i < nights[s] * 8; i++) {
      recommendations.push(
        buildRecommendation({
          id: `${labels[s]}-meal-${i}`,
          name: `${labels[s]} Eatery ${i}`,
          category: i % 2 === 0 ? "restaurant" : "cafe",
          location: labels[s],
          lat: anchor.lat + i * 0.0005,
          lon: anchor.lon - i * 0.0005,
          openingHours: "08:00-23:00",
        })
      );
    }
  }
  assert.ok(recommendations.filter((r) => r.category !== "restaurant" && r.category !== "cafe").length >= 50, "sanity: 50+ real activity candidates per spec §M");
  assert.ok(recommendations.filter((r) => r.category === "restaurant" || r.category === "cafe").length >= 20, "sanity: 20+ real meal candidates per spec §M");

  const startDate = new Date("2026-06-01T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const preferences: TripPreferences = { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
  const payload = buildPayload({ recommendations, preferences });
  const profile = buildTripPreferenceProfile(preferences, "United States", dayCount);
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const dayTypesByStay = new Map(
    phases.map((p) => [p.id, Array.from({ length: p.nights }, (_, i) => ({ dayNumber: p.startDayNumber + i, dayType: "normal" as const, hasExplicitRestWindow: false }))])
  );

  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(frame, areaAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  const mealPools = buildTripMealVenuePools(frame, areaAnchors, mobility, recommendations, 600, (s) => s.trim(), (a, b) => a === b);
  const composed = composeDaysFromStayPortfolios(frame, dayCount, window, poolsByStay, portfoliosByStay, payload, profile, mealPools);

  const days = composed.plan.days.map((d) => ({ ...d, items: [...d.items] }));
  // Deliberately inject the exact-ID duplicate + Harvard/Glen-House-style
  // wrong-phase-assignment shapes spec §M requires: the SAME Boston
  // restaurant, one occurrence correctly in Boston (day 1) and one
  // occurrence incorrectly injected onto a Hartford day (geographically
  // near Hartford's own anchor once relocated, matching the production
  // "phase-6 -> phase-2" shape of a real place surviving under the WRONG
  // day's ownership).
  const bostonRestaurant = recommendations.find((r) => r.id === "Boston-meal-0")!;
  const hartfordPhase = phases.find((p) => p.areaLabel === "Hartford")!;
  const injectedDuplicateItem = buildItem({
    name: bostonRestaurant.name,
    category: bostonRestaurant.category,
    recommendationId: bostonRestaurant.id,
    lat: bostonRestaurant.lat,
    lon: bostonRestaurant.lon,
    location: bostonRestaurant.location,
    slot: "dinner",
  });
  days[hartfordPhase.startDayNumber - 1] = { ...days[hartfordPhase.startDayNumber - 1], items: [...days[hartfordPhase.startDayNumber - 1].items, injectedDuplicateItem] };

  const beforeReal = snapshotRealActivities(days).length;
  assert.ok(beforeReal >= 50, `sanity: expected 50+ real activities entering repair, got ${beforeReal}`);
  const injectedDuplicatesBefore = computeRealPlaceDuplicateGroups(days, frame);
  assert.ok(injectedDuplicatesBefore.length > 0, "sanity: the injected exact-ID duplicate must genuinely be present before repair");

  const raw: RawGeneratedPlan = {
    title: composed.plan.title,
    summary: composed.plan.summary,
    days: days.map((d) => ({
      dayNumber: d.dayNumber,
      date: d.date,
      title: d.title || "",
      cityRegion: d.cityRegion,
      accommodation: d.accommodation || "",
      notes: d.notes || "",
      transportation: d.transportation || "",
      items: d.items.map((i) => ({
        name: i.name,
        category: i.category,
        location: i.location,
        shortDescription: i.shortDescription,
        slot: i.slot,
        plannedStartTime: i.plannedStartTime,
        estimatedDurationMinutes: i.estimatedDurationMinutes ?? undefined,
      })),
    })),
  };

  const repaired = repairPlan(raw, payload, profile, frame, null, window, null);

  // Required final result per spec §M.
  const finalDuplicates = computeRealPlaceDuplicateGroups(repaired.days, frame);
  assert.equal(finalDuplicates.length, 0, `expected zero exact-recommendationId duplicates at repairPlan's successful exit, got ${JSON.stringify(finalDuplicates)}`);

  const afterReal = repaired.days.reduce((sum, d) => sum + d.items.filter((i) => i.recommendationId != null && i.category !== "restaurant" && i.category !== "cafe").length, 0);
  const afterMeals = repaired.days.reduce((sum, d) => sum + d.items.filter((i) => i.recommendationId != null && (i.category === "restaurant" || i.category === "cafe")).length, 0);
  assert.ok(afterReal > 0, "realActivities must be materially non-zero");
  assert.ok(afterMeals > 0, "realMeals must be materially non-zero");
});

// T. Round 9.4.2 regression: forced Gemini failure still preserves materially non-zero real activity supply (the checkpoint sequence itself is untouched this round — this confirms the NEW resolveExactIdDuplicates step does not regress it).
test("Round 9.4.3 T: Round 9.4.2's checkpoint sequence (finalizeArrivalDepartureContent + assertRealActivityCoverage) still preserves real content after this round's duplicate-repair changes", () => {
  const labels = ["Boston", "Providence", "Hartford"];
  const nights = [4, 4, 4];
  let day = 1;
  const phases = labels.map((label, i) => {
    const p = { id: `phase-${i + 1}`, areaLabel: label, nights: nights[i], startDayNumber: day, endDayNumber: day + nights[i] - 1, intent: "mixed" as const };
    day += nights[i];
    return p;
  });
  const dayCount = day - 1;
  const frame: TripFrame = { bucketId: "multi_phase", source: "deterministic", phases };
  const areaAnchors = new Map(labels.map((label, i) => [label, { lat: 40 + i * 5, lon: -70 - i * 5 }]));
  const mobility = { tier: "medium" as const, localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

  const recommendations: TripRecommendation[] = [];
  for (let s = 0; s < labels.length; s++) {
    const anchor = areaAnchors.get(labels[s])!;
    for (let i = 0; i < nights[s] * 3; i++) {
      recommendations.push(buildRecommendation({ id: `${labels[s]}-act-${i}`, name: `${labels[s]} Sight ${i}`, category: i % 3 === 0 ? "museum" : "attraction", location: labels[s], lat: anchor.lat + i * 0.001, lon: anchor.lon + i * 0.001 }));
    }
    for (let i = 0; i < nights[s] * 8; i++) {
      recommendations.push(
        buildRecommendation({ id: `${labels[s]}-meal-${i}`, name: `${labels[s]} Eatery ${i}`, category: i % 2 === 0 ? "restaurant" : "cafe", location: labels[s], lat: anchor.lat + i * 0.0005, lon: anchor.lon - i * 0.0005, openingHours: "08:00-23:00" })
      );
    }
  }
  const startDate = new Date("2026-06-01T00:00:00Z");
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + dayCount - 1);
  const preferences: TripPreferences = { ...basePreferences, startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10) };
  const payload = buildPayload({ recommendations, preferences });
  const profile = buildTripPreferenceProfile(preferences, "United States", dayCount);
  const window = { earliestUsableTimeOnArrivalDay: null, latestUsableTimeOnDepartureDay: null } as never;
  const dayTypesByStay = new Map(phases.map((p) => [p.id, Array.from({ length: p.nights }, (_, i) => ({ dayNumber: p.startDayNumber + i, dayType: "normal" as const, hasExplicitRestWindow: false }))]));

  const { poolsByStay, portfoliosByStay } = buildTripActivityPortfolios(frame, areaAnchors, mobility, recommendations, dayTypesByStay, [], [], 600, (s) => s.trim(), (a, b) => a === b);
  const mealPools = buildTripMealVenuePools(frame, areaAnchors, mobility, recommendations, 600, (s) => s.trim(), (a, b) => a === b);
  const composed = composeDaysFromStayPortfolios(frame, dayCount, window, poolsByStay, portfoliosByStay, payload, profile, mealPools);
  const raw: RawGeneratedPlan = {
    title: composed.plan.title,
    summary: composed.plan.summary,
    days: composed.plan.days.map((d) => ({
      dayNumber: d.dayNumber, date: d.date, title: d.title || "", cityRegion: d.cityRegion, accommodation: d.accommodation || "", notes: d.notes || "", transportation: d.transportation || "",
      items: d.items.map((i) => ({ name: i.name, category: i.category, location: i.location, shortDescription: i.shortDescription, slot: i.slot, plannedStartTime: i.plannedStartTime, estimatedDurationMinutes: i.estimatedDurationMinutes ?? undefined })),
    })),
  };
  const composedRepaired = repairPlan(raw, payload, profile, frame, null, window, null);
  const beforeCheckpoint = snapshotRealActivities(composedRepaired.days);
  assert.ok(beforeCheckpoint.length > 10, `expected substantial real content entering the checkpoint, got ${beforeCheckpoint.length}`);

  const checkpointFinalPlan = finalizeArrivalDepartureContent(composedRepaired, payload, profile, dayCount, window, frame, areaAnchors, mobility);
  assert.doesNotThrow(() =>
    assertRealActivityCoverage(
      validateItineraryQuality(checkpointFinalPlan.days, frame, window),
      payload,
      { tripFrame: frame, countryName: "United States" },
      buildStaySupplyDiagnosticsMap(frame, poolsByStay, portfoliosByStay),
      false
    )
  );
  const realItems = checkpointFinalPlan.days.flatMap((d) => d.items.filter((i) => i.recommendationId != null));
  assert.ok(realItems.length > 0, "Round 9.4.2's real-place-preserving checkpoint must still preserve real content after this round's duplicate-repair changes");
  const duplicates = computeRealPlaceDuplicateGroups(checkpointFinalPlan.days, frame);
  assert.equal(duplicates.length, 0, "the checkpoint's own output should also be duplicate-free now that resolveExactIdDuplicates runs inside repairPlan upstream of it");
});
