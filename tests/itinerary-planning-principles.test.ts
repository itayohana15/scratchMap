import assert from "node:assert/strict";
import test from "node:test";

import { collectPlanDiagnostics, buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import type { TripFrame } from "../src/lib/server/itinerary-generation-constraints";
import {
  buildTripFramePhases,
  classifyItemEnergy,
  expectedBaseCountRange,
  getTripLengthBucket,
} from "../src/lib/server/itinerary-planning-principles";
import type { AiGeneratedDay, AiGeneratedItem, AiItineraryResponse, TripPreferences } from "../src/lib/trip-workspace";

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
  accommodationArea: "",
  dietaryPreferences: "",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};

function buildItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return {
    name: overrides.name ?? "Sample Stop",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tbilisi",
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
    travelMinutes: overrides.travelMinutes ?? 15,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    reservationRequired: overrides.reservationRequired ?? false,
    transportation: overrides.transportation ?? "הליכה",
    mapLink: overrides.mapLink ?? "",
    lat: overrides.lat ?? 41.7151,
    lon: overrides.lon ?? 44.8271,
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
    cityRegion: overrides.cityRegion ?? "Tbilisi",
    accommodation: overrides.accommodation ?? "Tbilisi hotel",
    notes: overrides.notes ?? "Neighborhood-focused day",
    transportation: overrides.transportation ?? "הליכה",
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

function buildPlan(days: AiGeneratedDay[]): AiItineraryResponse {
  return {
    title: "Test Plan",
    summary: "",
    totalEstimatedCost: null,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days,
  };
}

test("getTripLengthBucket / expectedBaseCountRange match the spec's trip-length algorithm table", () => {
  const shortBucket = getTripLengthBucket(5);
  assert.equal(shortBucket.id, "single_base");
  assert.deepEqual(expectedBaseCountRange(5), { min: 1, max: 2 });

  const mediumBucket = getTripLengthBucket(10);
  assert.equal(mediumBucket.id, "regional");
  assert.deepEqual(expectedBaseCountRange(10), { min: 1, max: 3 });

  const longBucket = getTripLengthBucket(21);
  assert.equal(longBucket.id, "extended_multi_phase");
  assert.deepEqual(expectedBaseCountRange(21), { min: 3, max: 6 });

  // Boundaries and the open-ended slow-travel bucket.
  assert.equal(getTripLengthBucket(1).id, "micro_city");
  assert.equal(getTripLengthBucket(30).id, "slow_travel");
});

test("classifyItemEnergy buckets representative low/medium/high stops", () => {
  assert.equal(
    classifyItemEnergy({
      category: "cafe",
      name: "Local Cafe",
      shortDescription: "עצירת קפה נעימה ורגועה",
    }),
    "low"
  );

  assert.equal(
    classifyItemEnergy({
      category: "museum",
      name: "City Museum",
      shortDescription: "סיור במוזיאון ההיסטוריה המקומית",
    }),
    "medium"
  );

  assert.equal(
    classifyItemEnergy({
      category: "day_trip",
      name: "Mountain Trek",
      shortDescription: "טיול יום מאורגן עם הליכה ארוכה בהרים",
    }),
    "high"
  );

  // A long duration alone should push an ambiguous stop toward high energy.
  assert.equal(
    classifyItemEnergy({
      category: "attraction",
      name: "Full Day Excursion",
      shortDescription: "פעילות מתמשכת באזור",
      estimatedDurationMinutes: 300,
    }),
    "high"
  );
});

test("buildTripFramePhases distributes days geography-first across weighted areas", () => {
  const bucket = getTripLengthBucket(10);
  const rankedAreas = ["Tbilisi", "Kutaisi", "Batumi"];
  const areaWeights = new Map([
    ["Tbilisi", 12],
    ["Kutaisi", 5],
    ["Batumi", 8],
  ]);

  const phases = buildTripFramePhases(rankedAreas, areaWeights, 10, bucket, null);

  assert.ok(phases.length >= 1 && phases.length <= bucket.maxBases);
  assert.equal(phases[0].startDayNumber, 1);
  assert.equal(phases.at(-1)!.endDayNumber, 10);
  assert.equal(
    phases.reduce((sum, phase) => sum + phase.nights, 0),
    10
  );

  for (let index = 1; index < phases.length; index += 1) {
    assert.equal(phases[index].startDayNumber, phases[index - 1].endDayNumber + 1);
  }

  // The heaviest-weighted area (real candidate density) should anchor phase one.
  assert.equal(phases[0].areaLabel, "Tbilisi");
});

test("buildTripFramePhases respects a pinned single area for short trips", () => {
  const bucket = getTripLengthBucket(4);
  const phases = buildTripFramePhases(["Berlin", "Potsdam"], new Map([["Berlin", 20], ["Potsdam", 2]]), 4, bucket, "Berlin");

  assert.equal(phases.length, 1);
  assert.equal(phases[0].areaLabel, "Berlin");
  assert.equal(phases[0].nights, 4);
});

test("collectPlanDiagnostics flags 3+ consecutive high-energy days and clears on a lighter rhythm", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 4);

  const highDay = (dayNumber: number) =>
    buildDay({
      dayNumber,
      date: `2026-10-0${5 + dayNumber}`,
      items: [
        buildItem({
          name: `Full-day mountain trek ${dayNumber}`,
          category: "day_trip",
          slot: "morning",
        }),
      ],
    });

  const lightDay = (dayNumber: number) =>
    buildDay({
      dayNumber,
      date: `2026-10-0${5 + dayNumber}`,
      items: [buildItem({ name: `Cafe stop ${dayNumber}`, category: "cafe", slot: "morning" })],
    });

  const heavyPlan = buildPlan([highDay(1), highDay(2), highDay(3), highDay(4)]);
  const heavyDiagnostics = collectPlanDiagnostics(heavyPlan, profile);
  assert.equal(heavyDiagnostics.maxConsecutiveHighEnergyDays, 4);
  assert.equal(heavyDiagnostics.highEnergyRhythmViolation, true);

  const balancedPlan = buildPlan([highDay(1), lightDay(2), highDay(3), lightDay(4)]);
  const balancedDiagnostics = collectPlanDiagnostics(balancedPlan, profile);
  assert.ok(balancedDiagnostics.maxConsecutiveHighEnergyDays <= 2);
  assert.equal(balancedDiagnostics.highEnergyRhythmViolation, false);
});

test("collectPlanDiagnostics flags days whose region doesn't match the locked trip frame", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Georgia", 4);
  const tripFrame: TripFrame = {
    bucketId: "single_base",
    source: "deterministic",
    phases: [
      { id: "phase-1", areaLabel: "Tbilisi", nights: 2, startDayNumber: 1, endDayNumber: 2, intent: "city" },
      { id: "phase-2", areaLabel: "Kutaisi", nights: 2, startDayNumber: 3, endDayNumber: 4, intent: "nature" },
    ],
  };

  const plan = buildPlan([
    buildDay({ dayNumber: 1, date: "2026-10-06", cityRegion: "Tbilisi" }),
    buildDay({ dayNumber: 2, date: "2026-10-07", cityRegion: "Batumi" }), // mismatched on purpose
    buildDay({ dayNumber: 3, date: "2026-10-08", cityRegion: "Kutaisi" }),
    buildDay({ dayNumber: 4, date: "2026-10-09", cityRegion: "Kutaisi" }),
  ]);

  const diagnostics = collectPlanDiagnostics(plan, profile, tripFrame);
  assert.equal(diagnostics.baseMismatchDays, 1);

  const diagnosticsWithoutFrame = collectPlanDiagnostics(plan, profile);
  assert.equal(diagnosticsWithoutFrame.baseMismatchDays, 0);
});
