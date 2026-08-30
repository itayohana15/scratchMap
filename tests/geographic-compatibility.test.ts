import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTripPreferenceProfile,
} from "../src/lib/server/itinerary-generation-constraints";
import {
  chooseTargetDayIndexForRecommendation,
  diversifyActivities,
  pickNearbyMealRecommendation,
  pickReplacementRecommendation,
} from "../src/lib/server/country-itinerary-generation";
import {
  buildFallbackAiItinerary,
  isCandidateGeographicallyCompatibleWithDay,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryRequest,
  type TripPreferences,
  type TripRecommendation,
} from "../src/lib/trip-workspace";

/**
 * PHASE 27 — GENERIC SYNTHETIC TEST SUITE.
 *
 * Entirely invented country/cities/coordinates — no real-world place name
 * anywhere in this file. The point is to prove the geographic-compatibility
 * architecture is genuinely generic (works for any destination), not to
 * regression-test a specific country. Israel/Georgia/France remain the
 * separate real-world regression scenarios elsewhere in this test suite.
 *
 * Synthetic geography (all in fictional "Country X"):
 *   City A:      (10.00, 10.00) — the trip's main base
 *   City A West: (10.05, 10.05) — a nearby suburb of City A (~7-8km away)
 *   City B:      (12.00, 10.00) — a genuinely different, distant city (~220km from City A)
 *   Region D:    (10.90, 10.00) — a nature region a deliberate day trip away from City A (~100km)
 */
const CITY_A = { lat: 10.0, lon: 10.0 };
const CITY_A_SUBURB = { lat: 10.05, lon: 10.05 };
const CITY_B = { lat: 12.0, lon: 10.0 };
const REGION_D = { lat: 10.9, lon: 10.0 };

const basePreferences: TripPreferences = {
  startDate: "2026-10-06",
  endDate: "2026-10-10",
  partialDate: "",
  travelers: 2,
  budget: 20000,
  tripStyle: "sightseeing",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "sightseeing, nature",
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

function buildPayload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    countryId: "country-x",
    countryName: "Country X",
    isoA2: "XX",
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
    name: overrides.name ?? "Synthetic Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "City A",
    shortDescription: overrides.shortDescription ?? "",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 100,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? "any",
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
    lat: overrides.lat ?? CITY_A.lat,
    lon: overrides.lon ?? CITY_A.lon,
    source: overrides.source ?? "api",
    wikipediaUrl: overrides.wikipediaUrl ?? null,
    website: overrides.website ?? null,
    wheelchairAccessible: overrides.wheelchairAccessible ?? null,
    isFree: overrides.isFree ?? null,
  };
}

function buildItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return {
    name: overrides.name ?? "Synthetic Stop",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "City A",
    shortDescription: overrides.shortDescription ?? "",
    slot: overrides.slot ?? "morning",
    plannedStartTime: overrides.plannedStartTime ?? "09:00",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 100,
    pricePerPerson: overrides.pricePerPerson ?? null,
    priceOriginalAmount: overrides.priceOriginalAmount ?? 100,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? "USD",
    priceConvertedAmount: overrides.priceConvertedAmount ?? 100,
    priceExchangeRate: overrides.priceExchangeRate ?? 1,
    priceRateTimestamp: overrides.priceRateTimestamp ?? "2026-08-08T00:00:00.000Z",
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 20,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    lastEntryTime: overrides.lastEntryTime ?? "",
    canonicalPlaceId: overrides.canonicalPlaceId ?? "",
    reservationRequired: overrides.reservationRequired ?? false,
    transportation: overrides.transportation ?? "public transport",
    mapLink: overrides.mapLink ?? "",
    lat: overrides.lat ?? CITY_A.lat,
    lon: overrides.lon ?? CITY_A.lon,
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
    cityRegion: overrides.cityRegion ?? "City A",
    accommodation: overrides.accommodation ?? "City A Hotel",
    notes: overrides.notes ?? "",
    transportation: overrides.transportation ?? "public transport",
    estimatedCost: overrides.estimatedCost ?? 200,
    activityCost: overrides.activityCost ?? 150,
    foodCost: overrides.foodCost ?? 50,
    transportCost: overrides.transportCost ?? 0,
    accommodationCost: overrides.accommodationCost ?? 0,
    totalTravelMinutes: overrides.totalTravelMinutes ?? 30,
    warnings: overrides.warnings ?? [],
    alternatives: overrides.alternatives ?? [],
    bookingRequirements: overrides.bookingRequirements ?? [],
    safetyNotes: overrides.safetyNotes ?? [],
    restWindow: overrides.restWindow ?? "",
    transportSegments: overrides.transportSegments ?? [],
    items: overrides.items ?? [],
  };
}

// ===== 1. City A normal day cannot contain a distant City B activity =====
test("isCandidateGeographicallyCompatibleWithDay rejects a candidate from a genuinely distant city", () => {
  const compatible = isCandidateGeographicallyCompatibleWithDay(CITY_B, [CITY_A, CITY_A], {});
  assert.equal(compatible, false);
});

// ===== 2. A nearby suburb may belong to City A's cluster =====
test("isCandidateGeographicallyCompatibleWithDay accepts a nearby suburb of the same city", () => {
  const compatible = isCandidateGeographicallyCompatibleWithDay(CITY_A_SUBURB, [CITY_A], {});
  assert.equal(compatible, true);
});

// ===== 3. City A -> Region D -> City A valid ONLY as a deliberate day trip =====
test("isCandidateGeographicallyCompatibleWithDay rejects a day-trip-distance region on a normal day but accepts it on a day-trip day", () => {
  assert.equal(isCandidateGeographicallyCompatibleWithDay(REGION_D, [CITY_A], {}), false);
  assert.equal(isCandidateGeographicallyCompatibleWithDay(REGION_D, [CITY_A], { isDayTripDay: true }), true);
});

test("isCandidateGeographicallyCompatibleWithDay never blocks on missing geographic data", () => {
  // No existing anchors yet — nothing established to compare against.
  assert.equal(isCandidateGeographicallyCompatibleWithDay(CITY_B, [], {}), true);
  // Candidate itself has no coordinates.
  assert.equal(isCandidateGeographicallyCompatibleWithDay({ lat: null, lon: null }, [CITY_A], {}), true);
});

// ===== 6. A globally top-ranked City B attraction cannot leak into a City A day =====
test("pickReplacementRecommendation never replaces a City A item with a globally better-scoring City B candidate", () => {
  const cityBWinner = buildRecommendation({
    id: "city-b-winner",
    name: "City B's Most Famous Attraction",
    category: "attraction",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
    approximatePrice: 0, // free + perfectly matching category — would win purely on score if geography weren't a hard gate
  });
  const cityALocal = buildRecommendation({
    id: "city-a-local",
    name: "City A Local Attraction",
    category: "attraction",
    location: "City A",
    lat: CITY_A_SUBURB.lat,
    lon: CITY_A_SUBURB.lon,
  });

  const day = buildDay({
    items: [buildItem({ name: "City A Anchor", lat: CITY_A.lat, lon: CITY_A.lon })],
  });
  const payload = buildPayload({ recommendations: [cityBWinner, cityALocal] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const replacement = pickReplacementRecommendation({
    payload,
    day,
    item: day.items[0],
    profile,
    usedPlaceKeys: new Set(),
  });

  assert.ok(replacement, "a real, geographically compatible replacement must still be found");
  assert.equal(replacement!.id, "city-a-local");
});

test("pickReplacementRecommendation accepts a Region D candidate on a genuine day-trip day", () => {
  const regionDCandidate = buildRecommendation({
    id: "region-d-trail",
    name: "Region D Nature Trail",
    category: "nature",
    location: "Region D",
    lat: REGION_D.lat,
    lon: REGION_D.lon,
  });

  const dayTripDay = buildDay({
    items: [
      buildItem({ name: "Region D Morning Hike", category: "nature", lat: REGION_D.lat, lon: REGION_D.lon }),
    ],
    cityRegion: "City A",
    notes: "טיול יום לאזור הטבע",
  });
  const payload = buildPayload({ recommendations: [regionDCandidate] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const replacement = pickReplacementRecommendation({
    payload,
    day: dayTripDay,
    item: dayTripDay.items[0],
    profile,
    usedPlaceKeys: new Set(),
  });

  // Not asserting it MUST pick this specific candidate (scoring may prefer
  // others) — only that geography never rules it out outright the way it
  // would on a normal day.
  assert.notEqual(replacement, null);
});

// ===== 7. Diversity repair cannot introduce a wrong-region item =====
test("diversifyActivities cannot import a wrong-region candidate even to balance the activity mix", () => {
  const cityBNatureCandidate = buildRecommendation({
    id: "city-b-nature",
    name: "City B Nature Reserve",
    category: "nature",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
  });

  const day = buildDay({
    dayNumber: 1,
    items: [
      buildItem({ name: "City A Museum 1", category: "museum", lat: CITY_A.lat, lon: CITY_A.lon }),
      buildItem({ name: "City A Museum 2", category: "museum", lat: CITY_A_SUBURB.lat, lon: CITY_A_SUBURB.lon }),
    ],
  });
  const payload = buildPayload({ recommendations: [cityBNatureCandidate] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const repaired = diversifyActivities(
    [day],
    payload,
    profile,
    "museum",
    [{ tier: "flexible", share: 0, target: { min: 0.1, max: 0.2 } }]
  );

  assert.ok(
    !repaired[0].items.some((item) => item.name === "City B Nature Reserve"),
    "a wrong-region candidate must never be imported just to satisfy a diversity/tier quota"
  );
});

// ===== 10. Meal insertion stays local =====
test("pickNearbyMealRecommendation returns null rather than a restaurant from a different city", () => {
  const cityBRestaurant = buildRecommendation({
    id: "city-b-restaurant",
    name: "City B's Best Restaurant",
    category: "restaurant",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
  });

  const day = buildDay({
    items: [buildItem({ name: "City A Anchor", lat: CITY_A.lat, lon: CITY_A.lon, slot: "afternoon" })],
  });
  const payload = buildPayload({ recommendations: [cityBRestaurant] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const meal = pickNearbyMealRecommendation(payload, day, "dinner", profile, new Set());
  assert.equal(meal, null, "no real candidate is geographically close, so this must fall through to the synthetic placeholder, never a City B restaurant");
});

// ===== 9. Must-visit repair respects day geography =====
test("chooseTargetDayIndexForRecommendation prefers the day whose real content is nearest, not just the day with the most free capacity", () => {
  const cityBMustVisit = buildRecommendation({
    id: "city-b-must-visit",
    name: "City B Landmark",
    category: "attraction",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
  });

  // Day 1 (City A) is nearly empty (lots of free capacity), but geographically unrelated.
  const dayInCityA = buildDay({
    dayNumber: 1,
    cityRegion: "",
    accommodation: "",
    items: [buildItem({ name: "Light City A Stop", lat: CITY_A.lat, lon: CITY_A.lon, estimatedDurationMinutes: 30 })],
  });
  // Day 2 (City B) is fuller, but geographically the right place for this candidate.
  const dayInCityB = buildDay({
    dayNumber: 2,
    cityRegion: "",
    accommodation: "",
    items: [
      buildItem({ name: "City B Stop 1", lat: CITY_B.lat, lon: CITY_B.lon, estimatedDurationMinutes: 180 }),
      buildItem({ name: "City B Stop 2", lat: CITY_B.lat, lon: CITY_B.lon, estimatedDurationMinutes: 180 }),
    ],
  });

  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 2);
  const targetIndex = chooseTargetDayIndexForRecommendation([dayInCityA, dayInCityB], cityBMustVisit, profile);

  assert.equal(targetIndex, 1, "the geographically-correct (but fuller) day must win over the emptier but unrelated day");
});

// ===== 1 (integration) / 6 (integration) — the deterministic fallback template =====
test("buildFallbackAiItinerary never mixes City A and City B content within the same non-day-trip day", () => {
  const cityARecs = Array.from({ length: 6 }, (_, index) =>
    buildRecommendation({
      id: `city-a-${index}`,
      name: `City A Place ${index}`,
      category: index % 2 === 0 ? "attraction" : "restaurant",
      location: "City A",
      lat: CITY_A.lat + index * 0.001,
      lon: CITY_A.lon + index * 0.001,
    })
  );
  const cityBRecs = Array.from({ length: 6 }, (_, index) =>
    buildRecommendation({
      id: `city-b-${index}`,
      name: `City B Place ${index}`,
      category: index % 2 === 0 ? "attraction" : "restaurant",
      location: "City B",
      lat: CITY_B.lat + index * 0.001,
      lon: CITY_B.lon + index * 0.001,
    })
  );

  const payload = buildPayload({
    preferences: { ...basePreferences, startDate: "2026-10-06", endDate: "2026-10-09" },
    recommendations: [...cityARecs, ...cityBRecs],
  });

  const fallback = buildFallbackAiItinerary(payload);

  for (const day of fallback.days) {
    const itemsWithCoords = day.items.filter((item) => item.lat != null && item.lon != null);
    if (itemsWithCoords.length < 2) continue;

    const hasCityA = itemsWithCoords.some((item) => Math.abs((item.lat ?? 0) - CITY_A.lat) < 1);
    const hasCityB = itemsWithCoords.some((item) => Math.abs((item.lat ?? 0) - CITY_B.lat) < 1);
    assert.ok(
      !(hasCityA && hasCityB),
      `day ${day.dayNumber} mixes City A and City B content: ${itemsWithCoords.map((item) => `${item.name}@${item.lat}`).join(", ")}`
    );
  }
});
