import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDayGeography, buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import {
  enforceArrivalDepartureWindow,
  lightenHighEnergyStreaks,
  resequenceDayItems,
} from "../src/lib/server/country-itinerary-generation";
import type { ArrivalDepartureWindow } from "../src/lib/flight-planning";
import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryRequest,
  TripPreferences,
  TripRecommendation,
} from "../src/lib/trip-workspace";

// This file is the "permanent regression test" the spec calls for (item
// 82) — one test per named scenario, exercising the real repair functions
// directly (no live LLM call), same style as country-itinerary-generation.test.ts.

const basePreferences: TripPreferences = {
  startDate: "2026-10-06",
  endDate: "2026-10-08",
  partialDate: "",
  travelers: 2,
  budget: 22500,
  tripStyle: "sightseeing",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "",
  transportationPreferences: "",
  accommodationArea: "",
  dietaryPreferences: "",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};

function buildPayload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    countryId: "country-il",
    countryName: "Israel",
    isoA2: "IL",
    tripStatus: "planning",
    preferences: overrides.preferences ?? basePreferences,
    selectedPlaces: overrides.selectedPlaces ?? [],
    recommendations: overrides.recommendations ?? [],
    bookings: overrides.bookings ?? [],
    existingDays: overrides.existingDays ?? [],
  };
}

function buildItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return {
    name: overrides.name ?? "Sample Stop",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tel Aviv",
    shortDescription: overrides.shortDescription ?? "",
    slot: overrides.slot ?? "morning",
    plannedStartTime: overrides.plannedStartTime ?? "10:00",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 0,
    pricePerPerson: overrides.pricePerPerson ?? null,
    priceOriginalAmount: overrides.priceOriginalAmount ?? 0,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? "ILS",
    priceConvertedAmount: overrides.priceConvertedAmount ?? 0,
    priceExchangeRate: overrides.priceExchangeRate ?? 1,
    priceRateTimestamp: overrides.priceRateTimestamp ?? "2026-08-08T00:00:00.000Z",
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 10,
    openingHours: overrides.openingHours ?? "",
    lastEntryTime: overrides.lastEntryTime ?? "",
    canonicalPlaceId: overrides.canonicalPlaceId ?? "",
    reservationRequired: overrides.reservationRequired ?? false,
    transportation: overrides.transportation ?? "הליכה",
    mapLink: overrides.mapLink ?? "",
    lat: overrides.lat ?? 32.08,
    lon: overrides.lon ?? 34.78,
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
    cityRegion: overrides.cityRegion ?? "Tel Aviv",
    accommodation: overrides.accommodation ?? "Tel Aviv hotel",
    notes: overrides.notes ?? "",
    transportation: overrides.transportation ?? "הליכה",
    estimatedCost: overrides.estimatedCost ?? 0,
    activityCost: overrides.activityCost ?? 0,
    foodCost: overrides.foodCost ?? 0,
    transportCost: overrides.transportCost ?? 0,
    accommodationCost: overrides.accommodationCost ?? 0,
    totalTravelMinutes: overrides.totalTravelMinutes ?? 0,
    warnings: overrides.warnings ?? [],
    alternatives: overrides.alternatives ?? [],
    bookingRequirements: overrides.bookingRequirements ?? [],
    safetyNotes: overrides.safetyNotes ?? [],
    restWindow: overrides.restWindow ?? "",
    transportSegments: overrides.transportSegments ?? [],
    items: overrides.items ?? [],
  };
}

function buildRecommendation(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? "rec-1",
    name: overrides.name ?? "Sample Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tel Aviv",
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
    lat: overrides.lat ?? 32.08,
    lon: overrides.lon ?? 34.78,
    source: overrides.source ?? "api",
    wikipediaUrl: overrides.wikipediaUrl ?? null,
    website: overrides.website ?? null,
    wheelchairAccessible: overrides.wheelchairAccessible ?? null,
    isFree: overrides.isFree ?? null,
  };
}

// Spec test 86: an Eilat sightseeing day must not include food in Tel Aviv
// or Acre unless it's explicitly a transfer route.
test("analyzeDayGeography flags Tel Aviv/Acre food dropped into an Eilat sightseeing day", () => {
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 1);
  const day = buildDay({
    cityRegion: "Eilat",
    transportation: "הליכה",
    items: [
      buildItem({
        name: "Coral Beach Nature Reserve",
        category: "nature",
        slot: "morning",
        location: "Eilat",
        lat: 29.5,
        lon: 34.92,
      }),
      buildItem({
        name: "Tel Aviv Beach Cafe",
        category: "cafe",
        slot: "lunch",
        location: "Tel Aviv",
        lat: 32.08,
        lon: 34.78,
      }),
      buildItem({
        name: "Acre Hummus Place",
        category: "restaurant",
        slot: "dinner",
        location: "Acre",
        lat: 32.93,
        lon: 35.08,
      }),
    ],
  });

  const diagnostics = analyzeDayGeography(day, profile);
  assert.ok(diagnostics.crossCityItems.includes("Tel Aviv Beach Cafe"));
  assert.ok(diagnostics.crossCityItems.includes("Acre Hummus Place"));
});

// Spec test 87: Disneyland-style full-day anchor blocks other major
// attractions that same day.
test("resequenceDayItems drops other major attractions when a full-day anchor is present (Disneyland + France)", () => {
  const day = buildDay({
    cityRegion: "Paris",
    items: [
      buildItem({
        name: "Disneyland Paris",
        category: "attraction",
        shortDescription: "Full day at the theme park",
        slot: "morning",
        estimatedDurationMinutes: 600,
      }),
      buildItem({ name: "The Louvre", category: "museum", slot: "afternoon" }),
      buildItem({ name: "Montmartre Walk", category: "attraction", slot: "evening" }),
    ],
  });

  const resequenced = resequenceDayItems(day);
  const names = resequenced.items.map((item) => item.name);
  assert.ok(names.includes("Disneyland Paris"));
  assert.equal(names.includes("The Louvre"), false);
  assert.equal(names.includes("Montmartre Walk"), false);
  // Dropped anchors are preserved as alternatives, not silently discarded.
  assert.ok(resequenced.alternatives.includes("The Louvre") || resequenced.alternatives.includes("Montmartre Walk"));
});

// Spec test 91: arrival at 18:00 must not leave daytime sightseeing on the schedule.
test("enforceArrivalDepartureWindow removes a daytime activity scheduled before a realistic 18:00 arrival", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const window: ArrivalDepartureWindow = {
    earliestUsableTimeOnArrivalDay: { date: "2026-10-06", time: "20:15" },
    latestUsableTimeOnDepartureDay: null,
  };

  const arrivalDay = buildDay({
    dayNumber: 1,
    date: "2026-10-06",
    items: [buildItem({ name: "Old City Walking Tour", category: "attraction", slot: "afternoon", plannedStartTime: "14:00" })],
  });

  const [repaired] = enforceArrivalDepartureWindow([arrivalDay], payload, profile, window, 2);
  assert.equal(repaired.items.some((item) => item.name === "Old City Walking Tour"), false);
});

// Spec test 92: departure at 11:00 must not leave a major morning activity on the schedule.
test("enforceArrivalDepartureWindow removes a morning activity that would risk missing an 11:00 departure", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 2);
  const window: ArrivalDepartureWindow = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-10-08", time: "08:00" },
  };

  const departureDay = buildDay({
    dayNumber: 2,
    date: "2026-10-08",
    items: [buildItem({ name: "Morning Market Tour", category: "attraction", slot: "morning", plannedStartTime: "09:00" })],
  });

  const [repaired] = enforceArrivalDepartureWindow([departureDay], payload, profile, window, 2);
  assert.equal(repaired.items.some((item) => item.name === "Morning Market Tour"), false);
});

// Spec test 94: a heavy day should be followed by a measurably lighter one.
test("lightenHighEnergyStreaks lightens a day after too many consecutive high-energy days", () => {
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 3);

  const heavyDay = (dayNumber: number, date: string) =>
    buildDay({
      dayNumber,
      date,
      items: [buildItem({ name: `Major Hike Day ${dayNumber}`, category: "day_trip", slot: "morning" })],
    });

  const days = [heavyDay(1, "2026-10-06"), heavyDay(2, "2026-10-07"), heavyDay(3, "2026-10-08")];
  const lightened = lightenHighEnergyStreaks(days, payload, profile);

  // No real replacement candidates exist in this payload, so the third
  // consecutive high-energy day falls back to a real rest-window note —
  // a genuinely lighter framing, not a silent no-op.
  assert.ok(lightened[2].restWindow.length > 0, "the third consecutive heavy day must be flagged for a lighter pace");
});

// Spec "תיקון גנרי, לא תיקון תשיעי" — lightenHighEnergyStreaks' own
// replacement call used to hand pickReplacementRecommendation a day view
// that still included the high-energy anchor being replaced, so a
// candidate close only to IT (never to the day's real other anchor)
// could pass.
test("lightenHighEnergyStreaks never selects a replacement close only to the high-energy anchor itself, not to the day's real other anchor", () => {
  const payload = buildPayload({
    recommendations: [
      buildRecommendation({
        id: "fake-near-hike",
        // Deliberately no energy-suggestive word in the name (found the
        // hard way: "...Hike Only" made classifyItemEnergy's own
        // keyword match reject this candidate regardless of geography,
        // via HIGH_ENERGY_KEYWORDS — masking whether the fix was really
        // what rejected it).
        name: "Fake Nearby To Far Anchor Only",
        category: "attraction",
        location: "Nowhere Real",
        // Close to the far hike (33.44, 34.78) — far from the real base (32.08, 34.78).
        lat: 33.441,
        lon: 34.781,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(basePreferences, "Israel", 3);

  // ~140km, explicit "רכב" — the real-walking-speed scheduling-overflow
  // trap found earlier this round; buildItem's own default transportation
  // in this file is "הליכה".
  const heavyDay = (dayNumber: number, date: string, includeFarAnchor: boolean) =>
    buildDay({
      dayNumber,
      date,
      transportation: "רכב",
      items: includeFarAnchor
        ? [
            buildItem({ name: "Base Anchor", category: "attraction", slot: "morning", lat: 32.08, lon: 34.78, transportation: "רכב" }),
            buildItem({ name: `Major Hike Day ${dayNumber}`, category: "day_trip", slot: "afternoon", lat: 33.44, lon: 34.78, transportation: "רכב" }),
          ]
        : [buildItem({ name: `Major Hike Day ${dayNumber}`, category: "day_trip", slot: "morning", transportation: "רכב" })],
    });

  const days = [heavyDay(1, "2026-10-06", false), heavyDay(2, "2026-10-07", false), heavyDay(3, "2026-10-08", true)];
  const lightened = lightenHighEnergyStreaks(days, payload, profile);

  assert.ok(
    !lightened[2].items.some((item) => item.name === "Fake Nearby To Far Anchor Only"),
    "a candidate close only to the high-energy anchor being replaced must never be selected"
  );
});
