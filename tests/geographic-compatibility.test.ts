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
  buildLegalDayCandidatePool,
  createItineraryUsageState,
  isCandidateGeographicallyCompatibleWithDay,
  selectFallbackCandidate,
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
const COMPACT_MOBILITY_PROFILE = { tier: "compact" as const, localityRadiusKm: 25, normalDayTravelBudgetMinutes: 60 };

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

// ===== 3. City A -> Region D -> City A valid ONLY as a PROVEN, feasible day trip =====
// Root-cause regression test (real generated PDF: Seattle days containing
// Grand Canyon/Yosemite) — a day-trip claim alone must never be an
// unconditional pass; it must go through real round-trip feasibility math
// (dayTripContext), and a genuinely infeasible excursion must still be
// rejected even when the day IS a real day trip.
test("isCandidateGeographicallyCompatibleWithDay rejects a day-trip-distance region on a normal day, and never grants an unconditional day-trip pass without real feasibility context", () => {
  assert.equal(isCandidateGeographicallyCompatibleWithDay(REGION_D, [CITY_A], {}), false);
  // Root-cause regression: claiming day-trip status with NO real feasibility
  // context must fail closed, never fall back to the old unconditional pass.
  assert.equal(
    isCandidateGeographicallyCompatibleWithDay(REGION_D, [CITY_A], {
      dayTripContext: { baseAnchor: null, mobilityProfile: COMPACT_MOBILITY_PROFILE, dailyCapacityMinutes: 600 },
    }),
    false
  );
});

test("isCandidateGeographicallyCompatibleWithDay grants the day-trip exemption only when the round trip is actually feasible", () => {
  const generousCapacity = { baseAnchor: CITY_A, mobilityProfile: COMPACT_MOBILITY_PROFILE, dailyCapacityMinutes: 1200 };
  assert.equal(
    isCandidateGeographicallyCompatibleWithDay(REGION_D, [CITY_A], { dayTripContext: generousCapacity }),
    true,
    "a genuinely feasible round trip (real capacity, real base anchor) must be accepted"
  );

  // The exact real-world shape of the reported bug: a real, resolved place
  // thousands of km away — no realistic capacity makes this a genuine day
  // trip, and it must be rejected even though day-trip status is claimed.
  const farAwayPlace = { lat: 55.0, lon: 55.0 };
  assert.equal(
    isCandidateGeographicallyCompatibleWithDay(farAwayPlace, [CITY_A], { dayTripContext: generousCapacity }),
    false,
    "an impossibly distant place must never pass purely because the day is classified as a day trip"
  );
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
    usageState: createItineraryUsageState(),
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

  // Root-cause fix regression note: a day-trip claim is no longer an
  // unconditional pass (spec §D) — real feasibility math now needs a real
  // base anchor to measure the round trip from. A genuine day-trip day
  // realistically has a base-anchored item (e.g. the morning departure
  // point) alongside the excursion itself, which is what actually lets
  // pickReplacementRecommendation establish `anchor` internally (via
  // getPrimaryAnchor on the day's OTHER items, excluding the one being
  // replaced) — a day with only the excursion item and nothing else has no
  // establishable base, and correctly fails closed rather than guessing.
  const dayTripDay = buildDay({
    items: [
      buildItem({ name: "City A Base", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon }),
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
    item: dayTripDay.items[1],
    profile,
    usageState: createItineraryUsageState(),
  });

  // Not asserting it MUST pick this specific candidate (scoring may prefer
  // others) — only that geography never rules it out outright the way it
  // would on a normal day.
  assert.notEqual(replacement, null);
});

test("pickReplacementRecommendation fails closed on a day-trip-labeled day with no establishable base anchor", () => {
  const regionDCandidate = buildRecommendation({
    id: "region-d-trail",
    name: "Region D Nature Trail",
    category: "nature",
    location: "Region D",
    lat: REGION_D.lat,
    lon: REGION_D.lon,
  });
  const dayTripDay = buildDay({
    items: [buildItem({ name: "Region D Morning Hike", category: "nature", lat: REGION_D.lat, lon: REGION_D.lon })],
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
    usageState: createItineraryUsageState(),
  });

  assert.equal(replacement, null, "with no other item to establish a real base anchor, the day-trip exemption must fail closed, never guess");
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

// Spec "תיקון גנרי, לא תיקון תשיעי" — diversifyActivities has its own
// PARALLEL candidate search (it never goes through
// pickReplacementRecommendation at all, unlike every other repair pass —
// a real discrepancy found while writing this test: the earlier
// investigation had assumed it shared the same call path), so the
// generic fix inside pickReplacementRecommendation does not cover it —
// this one needed its own, separate fix. Its own geo-compatibility check
// used to hand a day view that still included the item being swapped
// out, so a candidate close only to IT (never to the day's real anchor)
// could pass. Unlike the test above (where the day has no far item at
// all, so there's nothing for a bad candidate to hide behind), here the
// item BEING REPLACED is itself the far one — the exact shape the bug
// needed. Candidate category is deliberately NOT "museum" — diversifyActivities
// only ever considers a candidate from a DIFFERENT category than the one
// being diversified away from, by design.
test("diversifyActivities never selects a replacement close only to the item it's swapping out, not to the day's real anchor", () => {
  const fakeNearbyToTarget = buildRecommendation({
    id: "fake-near-target",
    name: "Fake Nearby To Target Only",
    category: "nature",
    location: "Nowhere Real",
    // Close to the far museum (11.26, 10) — far from the real base City A (10, 10).
    lat: 11.261,
    lon: 10.001,
  });
  const day = buildDay({
    dayNumber: 1,
    transportation: "רכב",
    items: [
      buildItem({ name: "City A Anchor", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon, transportation: "רכב" }),
      // ~140km from City A — the dominant-category item diversifyActivities
      // will pick to swap out.
      buildItem({ name: "Far Museum", category: "museum", slot: "afternoon", lat: 11.26, lon: 10, transportation: "רכב" }),
    ],
  });
  const payload = buildPayload({ recommendations: [fakeNearbyToTarget] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const repaired = diversifyActivities([day], payload, profile, "museum", []);

  // diversifyActivities has no free-exploration fallback of its own — a
  // day with no valid candidate simply keeps its original item untouched
  // (unlike every other repair pass tested this round), so the real
  // assertion here is narrower: the rejected far candidate specifically
  // must never appear, regardless of whether Far Museum itself survives.
  assert.ok(
    !repaired[0].items.some((item) => item.name === "Fake Nearby To Target Only"),
    "a candidate close only to the item being swapped out must never be selected"
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

// Real bug found via a real 44-day US QA run: a transfer day's own practical
// item (checkout/transfer block, lat/lon both null) is pushed into
// existingItems BEFORE selectFallbackCandidate is ever called for that day's
// real slots — so existingItems.length was never 0 by the time this ran,
// the pool-based area anchor never got seeded, and the hard geographic
// filter had zero coordinate anchors to judge against (silently passing
// everything). This is the same "target/context excluded itself out of the
// safe path" shape as pickReplacementRecommendation's original bug, just
// triggered by a coordinate-less existing item instead of a self-referential
// one. A dummy no-coordinate transfer item is the fixture below precisely
// because that's the real trigger, not an incidental detail.
// Built via object-spread AFTER buildItem, not through its overrides param
// — that helper's own lat/lon use `??`, which treats an explicit `null`
// override as "not provided" and falls back to CITY_A's coordinates,
// silently defeating the whole point of this fixture.
const NO_COORDS_TRANSFER_ITEM = { ...buildItem({ name: "Checkout block", category: "practical" }), lat: null, lon: null };

test("selectFallbackCandidate picks the geographically-correct candidate over a higher-scoring far one, even on a transfer day (no-coordinate existing item)", () => {
  const closeCandidate = buildRecommendation({
    id: "close-city-a",
    name: "City A Real Stop",
    category: "attraction",
    location: "City A",
    lat: CITY_A.lat,
    lon: CITY_A.lon,
  });
  const farCandidate = buildRecommendation({
    id: "far-city-b",
    name: "City B Landmark Stop",
    category: "attraction",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
    recommendedTimeOfDay: "morning",
  });

  const picked = selectFallbackCandidate({
    pool: [closeCandidate, farCandidate],
    slot: "morning",
    template: { kind: "transfer", titleHint: "", slots: ["morning"], maxStops: 3, notes: "", restWindow: "" },
    preferredArea: "City A",
    previousItem: null,
    existingItems: [NO_COORDS_TRANSFER_ITEM],
    usedToday: new Set<string>(),
    usageCounts: new Map<string, number>(),
    usedRealPlaces: [],
    // Stacked scoring bonuses give the FAR candidate a real score advantage
    // (recommendedTimeOfDay exact match +14, selectedIds +12, keyword match
    // +12 = 38) that comfortably beats the close candidate's own area-label
    // match bonus (+24) — under the old (no-op-when-uncoordinated) filter
    // this alone would be enough for the far candidate to win on score.
    selectedIds: new Set([farCandidate.id]),
    preferredKeywords: ["landmark"],
    avoidKeywords: [],
  });

  assert.equal(picked?.id, closeCandidate.id, "the geographically-correct candidate must win even when the far one scores higher");
});

test("selectFallbackCandidate returns null (never the closest of only-far candidates) when nothing real is geographically compatible", () => {
  // Anchor-only: establishes City A's real coordinate anchor via the pool
  // (the exact mechanism the fix widens), but is excluded from actual
  // candidate selection via usedToday — so it can never itself be "the"
  // answer, only prove an anchor was available to judge against.
  const anchorOnly = buildRecommendation({
    id: "anchor-city-a",
    name: "City A Anchor",
    category: "attraction",
    location: "City A",
    lat: CITY_A.lat,
    lon: CITY_A.lon,
  });
  const farCandidate = buildRecommendation({
    id: "far-city-b-2",
    name: "City B Only Option",
    category: "attraction",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
  });

  const picked = selectFallbackCandidate({
    pool: [anchorOnly, farCandidate],
    slot: "morning",
    template: { kind: "transfer", titleHint: "", slots: ["morning"], maxStops: 3, notes: "", restWindow: "" },
    preferredArea: "City A",
    previousItem: null,
    existingItems: [NO_COORDS_TRANSFER_ITEM],
    usedToday: new Set([anchorOnly.id]),
    usageCounts: new Map<string, number>(),
    usedRealPlaces: [],
    selectedIds: new Set<string>(),
    preferredKeywords: [],
    avoidKeywords: [],
  });

  assert.equal(picked, null, "must fall through to null (the caller's placeholder path), never the far candidate");
});

// ===== buildLegalDayCandidatePool — Point D/G invariants =====
// Real bug this closes: the deterministic fallback used to draw from an
// unrestricted pool with filters duplicated inline — this is that same
// logic, now a single named/testable function every caller (currently
// selectFallbackCandidate) routes through, so "never a global unrestricted
// pool" is a real, checkable property instead of an inline convention.

test("buildLegalDayCandidatePool: a cross-owner (wrong-city) candidate is excluded even when nothing else is filtered", () => {
  const nearCandidate = buildRecommendation({ id: "near-1", name: "City A Place", location: "City A", lat: CITY_A.lat, lon: CITY_A.lon });
  const farCandidate = buildRecommendation({ id: "far-1", name: "City B Place", location: "City B", lat: CITY_B.lat, lon: CITY_B.lon });

  const legalPool = buildLegalDayCandidatePool({
    pool: [nearCandidate, farCandidate],
    ownerAnchors: [CITY_A],
    usedToday: new Set(),
    usageCounts: new Map(),
    usedRealPlaces: [],
  });

  assert.deepEqual(legalPool.map((c) => c.id), ["near-1"], "a genuinely different city must never be in the legal pool for this owner");
});

test("buildLegalDayCandidatePool: an already-used real place (by id, by usage count, or by fuzzy name+coordinate identity) is excluded", () => {
  const usedById = buildRecommendation({ id: "used-by-id", name: "Used By Id", location: "City A", lat: CITY_A.lat, lon: CITY_A.lon });
  const usedByCount = buildRecommendation({ id: "used-by-count", name: "Used By Count", location: "City A", lat: CITY_A.lat, lon: CITY_A.lon });
  const usedByFuzzy = buildRecommendation({
    id: "different-id-same-place",
    name: "Old Town Market",
    location: "City A",
    lat: CITY_A.lat + 0.0001,
    lon: CITY_A.lon + 0.0001,
  });
  const freshCandidate = buildRecommendation({ id: "fresh-1", name: "Fresh Place", location: "City A", lat: CITY_A.lat, lon: CITY_A.lon });

  const legalPool = buildLegalDayCandidatePool({
    pool: [usedById, usedByCount, usedByFuzzy, freshCandidate],
    ownerAnchors: [CITY_A],
    usedToday: new Set(["used-by-id"]),
    usageCounts: new Map([["used-by-count", 1]]),
    usedRealPlaces: [{ nameSlug: "old town market", lat: CITY_A.lat, lon: CITY_A.lon }],
  });

  assert.deepEqual(legalPool.map((c) => c.id), ["fresh-1"], "every already-used real place must be excluded, regardless of which tracking mechanism caught it");
});

// Root-cause fix regression: isDayTripDay alone (with no real feasibility
// context) must fail closed, never grant the old unconditional pass.
test("buildLegalDayCandidatePool: isDayTripDay alone (no real feasibility context) fails closed", () => {
  // Substantial duration (matches the "genuinely feasible" test's own
  // candidate) — with no real feasibility context at all, this must still
  // be rejected; it must never pass just because a big enough visit
  // duration would otherwise clear the value-ratio bar under some
  // hypothetical generous capacity.
  const farCandidate = buildRecommendation({
    id: "far-1",
    name: "City B Place",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
    estimatedDurationMinutes: 240,
  });

  const legalPool = buildLegalDayCandidatePool({
    pool: [farCandidate],
    ownerAnchors: [CITY_A],
    isDayTripDay: true,
    usedToday: new Set(),
    usageCounts: new Map(),
    usedRealPlaces: [],
  });

  assert.deepEqual(legalPool.map((c) => c.id), []);
});

test("buildLegalDayCandidatePool: a day_trip day is exempt from the geographic gate ONLY with real, feasible day-trip context", () => {
  // A substantial visit duration is required for the round trip to clear
  // evaluateDayTripFeasibility's own value-ratio floor (real travel time
  // to City B dominates a short visit otherwise) — not just a generous
  // time budget alone.
  const farCandidate = buildRecommendation({
    id: "far-1",
    name: "City B Place",
    location: "City B",
    lat: CITY_B.lat,
    lon: CITY_B.lon,
    estimatedDurationMinutes: 240,
  });

  const legalPool = buildLegalDayCandidatePool({
    pool: [farCandidate],
    ownerAnchors: [CITY_A],
    isDayTripDay: true,
    dayTripFeasibilityContext: { baseAnchor: CITY_A, mobilityProfile: COMPACT_MOBILITY_PROFILE, dailyCapacityMinutes: 1200 },
    usedToday: new Set(),
    usageCounts: new Map(),
    usedRealPlaces: [],
  });

  assert.deepEqual(legalPool.map((c) => c.id), ["far-1"]);
});

// ===== Semantic role safety (spec §J) — an airport/station/hotel must
// never fill a normal activity slot merely because it's geographically
// nearby. Enforced structurally: pickReplacementRecommendation's own
// category filter requires an exact category match for replacementMode
// "match" (an "attraction" slot can only ever be replaced by another
// "attraction"), and replacementMode "non_food" additionally requires
// isAnchorDayItem, which excludes NON_ACTIVITY_CATEGORIES
// ("transportation"/"hotel"/"practical") outright — never by matching the
// candidate's own name text. =====
test("semantic role: a nearby airport/station (category transportation) cannot fill an attraction slot", () => {
  const nearbyAirport = buildRecommendation({
    id: "nearby-airport",
    name: "City A International Airport",
    category: "transportation",
    location: "City A",
    lat: CITY_A_SUBURB.lat,
    lon: CITY_A_SUBURB.lon,
  });
  const day = buildDay({ items: [buildItem({ name: "City A Anchor", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon })] });
  const payload = buildPayload({ recommendations: [nearbyAirport] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const replacement = pickReplacementRecommendation({
    payload,
    day,
    item: buildItem({ name: "Outdated Attraction", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon }),
    profile,
    usageState: createItineraryUsageState(),
    replacementMode: "non_food",
  });

  assert.equal(replacement, null, "a transportation-category candidate must never fill a non-food activity slot, however close it is");
});

test("semantic role: a nearby hotel (category hotel) cannot fill an attraction slot", () => {
  const nearbyHotel = buildRecommendation({
    id: "nearby-hotel",
    name: "City A Grand Hotel",
    category: "hotel",
    location: "City A",
    lat: CITY_A_SUBURB.lat,
    lon: CITY_A_SUBURB.lon,
  });
  const day = buildDay({ items: [buildItem({ name: "City A Anchor", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon })] });
  const payload = buildPayload({ recommendations: [nearbyHotel] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  const replacement = pickReplacementRecommendation({
    payload,
    day,
    item: buildItem({ name: "Outdated Attraction", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon }),
    profile,
    usageState: createItineraryUsageState(),
    replacementMode: "non_food",
  });

  assert.equal(replacement, null, "a hotel-category candidate must never fill a non-food activity slot, however close it is");
});

test("semantic role: a nearby train station (category transportation) cannot fill an attraction slot without transit-leg context", () => {
  const nearbyStation = buildRecommendation({
    id: "nearby-station",
    name: "City A Central Station",
    category: "transportation",
    location: "City A",
    lat: CITY_A_SUBURB.lat,
    lon: CITY_A_SUBURB.lon,
  });
  const day = buildDay({ items: [buildItem({ name: "City A Anchor", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon })] });
  const payload = buildPayload({ recommendations: [nearbyStation] });
  const profile = buildTripPreferenceProfile(basePreferences, "Country X", 1);

  // replacementMode "match" (the default, used for a plain attraction-slot
  // repair) requires the candidate's OWN category to equal the item being
  // replaced's category — "transportation" can never match "attraction".
  const replacement = pickReplacementRecommendation({
    payload,
    day,
    item: buildItem({ name: "Outdated Attraction", category: "attraction", lat: CITY_A.lat, lon: CITY_A.lon }),
    profile,
    usageState: createItineraryUsageState(),
  });

  assert.equal(replacement, null, "a station cannot fill an attraction slot without a real TransitLeg/transportation-role context");
});
