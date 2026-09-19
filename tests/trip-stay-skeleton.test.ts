import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProposedStay,
  resolveStaySkeleton,
  dedupeResolvedStays,
  deterministicFallbackSkeleton,
  buildSingleBaseFallbackProposal,
  validateTripStaySkeleton,
  buildTripFrameFromResolvedStays,
  adjustStayWeightForSupply,
  computeActivityDiversityScore,
  classifyStayDiscoveryConfidence,
  computeStayValueProfile,
  marginalValueForNextDay,
  allocateNightsByMarginalValue,
  reallocateNightsAfterDiscovery,
  computeStayUsableCapacity,
  rankReserveStaysForPromotion,
  decideReservePromotion,
  applyReservePromotion,
  type ProposedStay,
  type ResolvedStay,
  type StayValueProfile,
} from "../src/lib/server/trip-stay-skeleton";
import { createEmptyFlightLeg, type AiItineraryRequest, type TripPreferences } from "../src/lib/trip-workspace";
import type { StayDayCapacityInput } from "../src/lib/server/stay-activity-pool";
import type { GeocodedPlace, SearchPlacesOptions } from "../src/lib/places/nominatim";
import type { StayActivityPool } from "../src/lib/server/stay-activity-pool";
import type { StayMealVenuePool } from "../src/lib/server/stay-meal-venue-pool";
import type { TripFrame } from "../src/lib/server/itinerary-planning-principles";

const basePreferences: TripPreferences = {
  startDate: "2026-06-01",
  endDate: "2026-07-12", // 42 days
  partialDate: "",
  travelers: 2,
  budget: 50000,
  tripStyle: "balanced",
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

function payload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    countryId: "country-us",
    countryName: "United States",
    isoA2: "US",
    tripStatus: "planning",
    preferences: overrides.preferences ?? basePreferences,
    selectedPlaces: overrides.selectedPlaces ?? [],
    recommendations: overrides.recommendations ?? [],
    bookings: overrides.bookings ?? [],
    existingDays: overrides.existingDays ?? [],
  };
}

function proposed(areaName: string, nights = 3, reasons: string[] = ["culture"]): ProposedStay {
  return { proposedId: `p-${areaName}`, areaName, nights, reasons };
}

/** A fake searchPlaces — never a real network call — resolving only names in `known`. */
function fakeSearch(known: Record<string, GeocodedPlace>): (query: string, opts?: SearchPlacesOptions) => Promise<GeocodedPlace[]> {
  return async (query: string) => {
    const match = known[query.trim().toLowerCase()];
    return match ? [match] : [];
  };
}

/* -------------------- resolveProposedStay / resolveStaySkeleton -------------------- */

test("resolveProposedStay resolves a real place through the injected geocoder", async () => {
  const search = fakeSearch({ "new york": { name: "New York", lat: 40.7128, lon: -74.006 } });
  const result = await resolveProposedStay(proposed("New York", 4, ["culture"]), "US", "gemini_resolved", search);
  assert.equal(result?.areaLabel, "New York");
  assert.equal(result?.lat, 40.7128);
  assert.equal(result?.nights, 4);
  assert.equal(result?.source, "gemini_resolved");
});

// D. Gemini proposes hallucinated stay -> rejected; country centroid is NOT substituted
test("Round 9.3 D: an unresolvable (hallucinated) area name resolves to null, never substituted with anything", async () => {
  const search = fakeSearch({});
  const result = await resolveProposedStay(proposed("Fictional Nowhereville"), "US", "gemini_resolved", search);
  assert.equal(result, null);
});

test("resolveProposedStay returns null (never throws) when the geocoder itself fails", async () => {
  const throwingSearch = async () => {
    throw new Error("network down");
  };
  const result = await resolveProposedStay(proposed("New York"), "US", "gemini_resolved", throwingSearch);
  assert.equal(result, null);
});

// C. Gemini proposes multiple valid stays -> all resolve
test("Round 9.3 C: multiple valid proposed stays all resolve through the geocoder", async () => {
  const search = fakeSearch({
    "new york": { name: "New York", lat: 40.7128, lon: -74.006 },
    "los angeles": { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
    "yellowstone national park": { name: "Yellowstone National Park", lat: 44.428, lon: -110.5885 },
  });
  const { resolved, unresolvedCount } = await resolveStaySkeleton(
    [proposed("New York", 5), proposed("Los Angeles", 5), proposed("Yellowstone National Park", 3)],
    "US",
    "gemini_resolved",
    search
  );
  assert.equal(resolved.length, 3);
  assert.equal(unresolvedCount, 0);
});

test("resolveStaySkeleton counts unresolved proposals without discarding the resolved ones", async () => {
  const search = fakeSearch({ "new york": { name: "New York", lat: 40.7128, lon: -74.006 } });
  const { resolved, unresolvedCount } = await resolveStaySkeleton([proposed("New York"), proposed("Fictional Place")], "US", "gemini_resolved", search);
  assert.equal(resolved.length, 1);
  assert.equal(unresolvedCount, 1);
});

/* -------------------- dedupeResolvedStays -------------------- */

// F. duplicate proposed stays canonicalize/dedupe
test("Round 9.3 F: two proposed stays resolving to the same real place merge into one, summing nights", () => {
  const stayA: ResolvedStay = { stayId: "us:40.71:-74.01", proposedId: "p1", areaLabel: "New York", lat: 40.7128, lon: -74.006, nights: 3, reasons: ["culture"], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const stayB: ResolvedStay = { stayId: "us:40.71:-74.01", proposedId: "p2", areaLabel: "New York City", lat: 40.7127, lon: -74.0059, nights: 2, reasons: ["food"], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const deduped = dedupeResolvedStays([stayA, stayB]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].nights, 5);
  assert.deepEqual(new Set(deduped[0].reasons), new Set(["culture", "food"]));
});

test("dedupeResolvedStays leaves genuinely distinct stays untouched", () => {
  const stayA: ResolvedStay = { stayId: "us:40.71:-74.01", proposedId: "p1", areaLabel: "New York", lat: 40.7128, lon: -74.006, nights: 3, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const stayB: ResolvedStay = { stayId: "us:34.05:-118.24", proposedId: "p2", areaLabel: "Los Angeles", lat: 34.0522, lon: -118.2437, nights: 3, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const deduped = dedupeResolvedStays([stayA, stayB]);
  assert.equal(deduped.length, 2);
});

/* -------------------- deterministicFallbackSkeleton (spec §8) -------------------- */

// E. Gemini unavailable -> deterministic fallback produces resolvable local stays
test("Round 9.3 E: deterministicFallbackSkeleton proposes real, geocodable place names from must-visit text and flights", () => {
  const p = payload({
    preferences: {
      ...basePreferences,
      mustVisitPlaces: "New York, Yellowstone National Park",
      flights: {
        outbound: { ...createEmptyFlightLeg(), departureAirport: "TLV", arrivalAirport: "JFK" },
        return: { ...createEmptyFlightLeg(), departureAirport: "LAX", arrivalAirport: "TLV" },
      },
    },
  });
  const proposals = deterministicFallbackSkeleton(p);
  const names = proposals.map((s) => s.areaName);
  assert.ok(names.includes("New York"), "arrival airport city (also a must-visit) must be proposed");
  assert.ok(names.includes("Los Angeles"), "departure airport city must be proposed");
  assert.ok(names.includes("Yellowstone National Park"), "must-visit text must be parsed into real place proposals");
  assert.ok(proposals.every((p) => !p.areaName.match(/attraction|museum|restaurant/i)), "no POI-shaped names, only place names");
});

test("deterministicFallbackSkeleton never proposes the same name twice", () => {
  const p = payload({ preferences: { ...basePreferences, mustVisitPlaces: "New York, New York" } });
  const proposals = deterministicFallbackSkeleton(p);
  assert.equal(proposals.filter((s) => s.areaName === "New York").length, 1);
});

test("deterministicFallbackSkeleton returns an empty list when there is truly no signal at all", () => {
  const p = payload();
  assert.deepEqual(deterministicFallbackSkeleton(p), []);
});

test("buildSingleBaseFallbackProposal proposes the country name itself, honestly tagged", () => {
  const p = payload();
  const proposal = buildSingleBaseFallbackProposal(p);
  assert.equal(proposal.areaName, "United States");
  assert.equal(proposal.reasons[0], "single_base_fallback");
});

/* -------------------- validateTripStaySkeleton (spec §9) -------------------- */

test("validateTripStaySkeleton rejects a skeleton whose only stay IS the country itself", () => {
  const countryLevelStay: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "United States", lat: 39, lon: -98, nights: 41, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const report = validateTripStaySkeleton([countryLevelStay], 0, 41, "United States");
  assert.equal(report.valid, false);
  assert.equal(report.countryLevelStayCount, 1);
});

test("validateTripStaySkeleton accepts the country name ONLY when honestly tagged single_base_fallback", () => {
  const honestFallback: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "United States", lat: 39, lon: -98, nights: 3, reasons: ["single_base_fallback"], source: "single_base_fallback", confidence: "high", countryIso: "US" };
  const report = validateTripStaySkeleton([honestFallback], 0, 3, "United States");
  assert.equal(report.countryLevelStayCount, 0);
  assert.equal(report.valid, true);
});

test("validateTripStaySkeleton rejects a skeleton with a zero-night stay", () => {
  const zeroNight: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "New York", lat: 40, lon: -74, nights: 0, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const report = validateTripStaySkeleton([zeroNight], 0, 3, "United States");
  assert.equal(report.valid, false);
  assert.equal(report.zeroNightStayCount, 1);
});

test("validateTripStaySkeleton reports unresolved/duplicate counts without itself failing validity for them alone", () => {
  const stay: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "New York", lat: 40, lon: -74, nights: 5, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const report = validateTripStaySkeleton([stay], 2, 5, "United States", 1);
  assert.equal(report.unresolvedStayCount, 2);
  assert.equal(report.duplicateStayCount, 1);
  assert.equal(report.valid, true, "unresolved/duplicate counts are visibility signals, not automatic invalidation");
});

test("validateTripStaySkeleton rejects an empty resolved-stay list", () => {
  const report = validateTripStaySkeleton([], 3, 10, "United States");
  assert.equal(report.valid, false);
  assert.equal(report.resolvedStayCount, 0);
});

/* -------------------- buildTripFrameFromResolvedStays (spec §5/§14, reuses buildTripFramePhases) -------------------- */

// A. short compact trip can legitimately produce one resolved local stay
test("Round 9.3 A: a single well-supported stay for a short trip produces exactly one phase spanning the whole trip", () => {
  const stay: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "Reykjavik", lat: 64.1466, lon: -21.9426, nights: 3, reasons: ["culture"], source: "gemini_resolved", confidence: "high", countryIso: "IS" };
  const { frame } = buildTripFrameFromResolvedStays([stay], 4);
  assert.equal(frame.phases.length, 1);
  assert.equal(frame.phases[0].areaLabel, "Reykjavik");
  assert.equal(frame.phases[0].startDayNumber, 1);
  assert.equal(frame.phases[0].endDayNumber, 4);
});

// B. long geographically broad trip cannot silently collapse to country-only owner
test("Round 9.3 B: a long trip with several proposed stays produces multiple phases, never one country-level phase", () => {
  const stays: ResolvedStay[] = [
    { stayId: "ny", proposedId: null, areaLabel: "New York", lat: 40.7128, lon: -74.006, nights: 5, reasons: ["culture"], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "chi", proposedId: null, areaLabel: "Chicago", lat: 41.8781, lon: -87.6298, nights: 4, reasons: ["food"], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "yell", proposedId: null, areaLabel: "Yellowstone National Park", lat: 44.428, lon: -110.5885, nights: 3, reasons: ["nature"], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "sf", proposedId: null, areaLabel: "San Francisco", lat: 37.7749, lon: -122.4194, nights: 4, reasons: ["culture"], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "la", proposedId: null, areaLabel: "Los Angeles", lat: 34.0522, lon: -118.2437, nights: 5, reasons: ["entertainment"], source: "gemini_resolved", confidence: "high", countryIso: "US" },
  ];
  const { frame } = buildTripFrameFromResolvedStays(stays, 42);
  assert.ok(frame.phases.length > 1, `expected multiple phases for a 42-day broad trip, got ${frame.phases.length}`);
  assert.ok(frame.phases.every((p) => p.areaLabel !== "United States"), "no phase may be the bare country name");
});

// H. all nights allocated exactly once
test("Round 9.3 H: every day of the trip is covered by exactly one phase, no gaps or overlaps", () => {
  const stays: ResolvedStay[] = [
    { stayId: "ny", proposedId: null, areaLabel: "New York", lat: 40.7128, lon: -74.006, nights: 5, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "chi", proposedId: null, areaLabel: "Chicago", lat: 41.8781, lon: -87.6298, nights: 4, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "la", proposedId: null, areaLabel: "Los Angeles", lat: 34.0522, lon: -118.2437, nights: 5, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
  ];
  const dayCount = 14;
  const { frame } = buildTripFrameFromResolvedStays(stays, dayCount);
  const covered = new Set<number>();
  for (const phase of frame.phases) {
    for (let d = phase.startDayNumber; d <= phase.endDayNumber; d += 1) {
      assert.equal(covered.has(d), false, `day ${d} covered by more than one phase`);
      covered.add(d);
    }
  }
  assert.equal(covered.size, dayCount, "every day of the trip must be covered exactly once");
});

/* -------------------- adjustStayWeightForSupply (spec §14) -------------------- */

// O. activity capacity influences nights
test("Round 9.3 O: a stay with weak activity supply gets its proposed nights rescaled down", () => {
  const richlyProposedButThin: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "Small Town", lat: 40, lon: -74, nights: 7, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const adjusted = adjustStayWeightForSupply(richlyProposedButThin, 2); // only 2 meaningful candidates for 7 proposed nights
  assert.ok(adjusted.nights < 7, `expected nights rescaled down from 7, got ${adjusted.nights}`);
  assert.ok(adjusted.nights >= 1);
});

test("adjustStayWeightForSupply never rescales a stay whose supply already supports its proposed nights", () => {
  const wellSupplied: ResolvedStay = { stayId: "x", proposedId: null, areaLabel: "New York", lat: 40, lon: -74, nights: 4, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" };
  const adjusted = adjustStayWeightForSupply(wellSupplied, 20);
  assert.equal(adjusted.nights, 4);
});

/* ==================================================================== *
 * ROUND 9.3.1 — STAY DURATION AS A PLANNING RESULT, NOT A BUCKET        *
 * ==================================================================== */

function pool(overrides: Partial<StayActivityPool> = {}): StayActivityPool {
  return {
    stayId: "s1",
    ownerArea: "Area A",
    anchor: { lat: 10, lon: 10 },
    usableDayCapacity: 4,
    requiredRealActivityTarget: 8,
    desiredCandidateCount: 20,
    minimumViableCandidateCount: 8,
    candidates: [],
    categorySupply: {},
    diagnostics: {
      initialCandidateCount: 0, resolvedCandidateCount: 0, legalCandidateCount: 0, desiredCandidateCount: 20,
      refillAttempts: 0, refillCandidateCount: 0, providerFailures: 0, providerElapsedMs: 0, providerTimeouts: 0,
      dedupeRejected: 0, geographyRejected: 0, mealVenueExcluded: 0, classificationBreakdown: {}, supplyDegraded: false,
    },
    ...overrides,
  };
}

function mealPool(overrides: Partial<StayMealVenuePool> = {}): StayMealVenuePool {
  return {
    stayId: "s1",
    ownerArea: "Area A",
    anchor: { lat: 10, lon: 10 },
    venues: [],
    cuisineSupply: {},
    mealTypeSupply: {},
    diagnostics: { initialCandidateCount: 0, resolvedCandidateCount: 0, legalCandidateCount: 0, dedupeRejected: 0, geographyRejected: 0, cuisineBreakdown: {}, mealTypeBreakdown: {} },
    ...overrides,
  };
}

function profile(overrides: Partial<StayValueProfile> = {}): StayValueProfile {
  return {
    stayId: "s1",
    areaLabel: "Area A",
    meaningfulActivitySupply: 10,
    diversityScore: 5,
    mealVenueSupply: 5,
    userPriority: 0,
    isStructuralAnchor: false,
    discoveryConfidence: "high_confidence",
    usableCapacityFactor: 1,
    ...overrides,
  };
}

/* -------------------- computeActivityDiversityScore (spec §8) -------------------- */

test("Round 9.3.1: computeActivityDiversityScore gives diminishing returns within a family, real credit across families", () => {
  const manySimilar = computeActivityDiversityScore({ CULTURE: 15 });
  const diverse = computeActivityDiversityScore({ CULTURE: 1, LANDMARK: 1, NATURE: 1, LOCAL_EXPERIENCE: 1, FOOD: 1, ENTERTAINMENT: 1, SHOPPING: 1, OTHER: 1 });
  assert.ok(diverse > manySimilar, `15 similar candidates (${manySimilar}) must score lower than 8 genuinely diverse ones (${diverse})`);
});

test("computeActivityDiversityScore is 0 for an empty supply", () => {
  assert.equal(computeActivityDiversityScore({}), 0);
});

/* -------------------- classifyStayDiscoveryConfidence (spec §12) -------------------- */

test("Round 9.3.1: classifyStayDiscoveryConfidence distinguishes provider trouble from genuine low supply", () => {
  assert.equal(classifyStayDiscoveryConfidence(pool().diagnostics), "high_confidence");
  assert.equal(classifyStayDiscoveryConfidence(pool({ diagnostics: { ...pool().diagnostics, supplyDegraded: true } }).diagnostics), "provider_degraded");
  assert.equal(classifyStayDiscoveryConfidence(pool({ diagnostics: { ...pool().diagnostics, providerTimeouts: 2 } }).diagnostics), "provider_degraded");
  assert.equal(classifyStayDiscoveryConfidence(undefined), "unknown");
});

test("Round 9.3.1: computeStayValueProfile floors a provider-degraded stay's supply signal instead of trusting a low raw count", () => {
  const degraded = pool({ candidates: [], diagnostics: { ...pool().diagnostics, providerTimeouts: 3 } });
  const p = computeStayValueProfile("s1", "Area A", degraded, undefined, [], false);
  assert.equal(p.discoveryConfidence, "provider_degraded");
  assert.ok(p.meaningfulActivitySupply >= 4, "a provider timeout must never be mistaken for a genuinely empty destination");
});

/* -------------------- marginalValueForNextDay (spec §6: diminishing returns) -------------------- */

test("Round 9.3.1: marginalValueForNextDay decays — day 1 > day 4 > day 9 for the SAME stay", () => {
  const richStay = profile({ meaningfulActivitySupply: 20, diversityScore: 15 });
  const day1 = marginalValueForNextDay(richStay, 0);
  const day4 = marginalValueForNextDay(richStay, 3);
  const day9 = marginalValueForNextDay(richStay, 8);
  assert.ok(day1 > day4, `day1 (${day1}) must exceed day4 (${day4})`);
  assert.ok(day4 > day9, `day4 (${day4}) must exceed day9 (${day9})`);
});

test("Round 9.3.1: a richer stay's marginal value stays higher for longer than a thin stay's", () => {
  const rich = profile({ meaningfulActivitySupply: 30, diversityScore: 20 });
  const thin = profile({ stayId: "s2", meaningfulActivitySupply: 3, diversityScore: 1 });
  assert.ok(marginalValueForNextDay(rich, 5) > marginalValueForNextDay(thin, 1), "a genuinely rich destination's 6th day can still outvalue a thin one's 2nd");
});

/* -------------------- allocateNightsByMarginalValue — THE required regression (spec §16) -------------------- */

// 16. No arbitrary night pattern: changing one stay's value must materially
// change its allocation relative to an otherwise-comparable stay — never a
// fixed bucket pattern, never asserting one specific desired sequence.
test("Round 9.3.1 §16: unequal stay value produces unequal night allocation, and the delta tracks the value difference", () => {
  const equalProfiles = [
    profile({ stayId: "a", meaningfulActivitySupply: 10, diversityScore: 6 }),
    profile({ stayId: "b", meaningfulActivitySupply: 10, diversityScore: 6 }),
  ];
  const { nightsByStayId: equalResult } = allocateNightsByMarginalValue(equalProfiles, 10);
  assert.equal(equalResult.get("a"), equalResult.get("b"), "genuinely equal value must allocate equally — not by coincidence, by the algorithm actually finding them tied");

  const unequalProfiles = [
    profile({ stayId: "a", meaningfulActivitySupply: 30, diversityScore: 20 }),
    profile({ stayId: "b", meaningfulActivitySupply: 3, diversityScore: 1 }),
  ];
  const { nightsByStayId: unequalResult } = allocateNightsByMarginalValue(unequalProfiles, 10);
  assert.ok(unequalResult.get("a")! > unequalResult.get("b")!, "the richer stay must receive materially more nights than the thin one");

  // Total nights conserved either way — this is an ALLOCATION, not a
  // heuristic that can silently under/over-assign the trip's own length.
  assert.equal([...equalResult.values()].reduce((s, n) => s + n, 0), 10);
  assert.equal([...unequalResult.values()].reduce((s, n) => s + n, 0), 10);
});

test("Round 9.3.1: changing ONE stay's value changes ITS OWN allocation without requiring a specific total pattern", () => {
  const baseline = [profile({ stayId: "a" }), profile({ stayId: "b" }), profile({ stayId: "c" })];
  const { nightsByStayId: before } = allocateNightsByMarginalValue(baseline, 15);

  const boosted = [profile({ stayId: "a", meaningfulActivitySupply: 40, diversityScore: 25 }), profile({ stayId: "b" }), profile({ stayId: "c" })];
  const { nightsByStayId: after } = allocateNightsByMarginalValue(boosted, 15);

  assert.ok(after.get("a")! > before.get("a")!, "boosting stay A's own value must increase ITS allocation");
});

test("Round 9.3.1: allocateNightsByMarginalValue never drops a stay below its floor", () => {
  const profiles = [profile({ stayId: "a", meaningfulActivitySupply: 100, diversityScore: 50 }), profile({ stayId: "b", meaningfulActivitySupply: 0, diversityScore: 0 })];
  const { nightsByStayId } = allocateNightsByMarginalValue(profiles, 10, 1);
  assert.ok(nightsByStayId.get("b")! >= 1, "even a comparatively weak stay must keep its minimum floor, never be reduced to zero nights by the competition");
});

test("Round 9.3.1: userPriority (must-visit) meaningfully increases a stay's allocation over an otherwise-equal one", () => {
  const profiles = [profile({ stayId: "a", userPriority: 1 }), profile({ stayId: "b", userPriority: 0 })];
  const { nightsByStayId } = allocateNightsByMarginalValue(profiles, 10);
  assert.ok(nightsByStayId.get("a")! > nightsByStayId.get("b")!, "an explicit must-visit stay must receive real structural weight, not just a tie-break");
});

// Spec §8/mutation D: SAME raw activity supply, but one stay's supply is
// genuinely diverse (many families) and the other is all the same
// subtype-equivalent family — the diverse one must win more nights, since
// diversityScore (not meaningfulActivitySupply) is what carries that
// signal into base capacity.
test("Round 9.3.1: two stays with EQUAL raw activity supply but different diversity get different allocations", () => {
  const sameFamily = profile({ stayId: "a", meaningfulActivitySupply: 15, diversityScore: computeActivityDiversityScore({ CULTURE: 15 }) });
  const diverse = profile({ stayId: "b", meaningfulActivitySupply: 15, diversityScore: computeActivityDiversityScore({ CULTURE: 2, LANDMARK: 2, NATURE: 2, LOCAL_EXPERIENCE: 2, SHOPPING: 2, ENTERTAINMENT: 2, FOOD: 2, OTHER: 1 }) });
  const { nightsByStayId } = allocateNightsByMarginalValue([sameFamily, diverse], 10);
  assert.ok(nightsByStayId.get("b")! > nightsByStayId.get("a")!, "the genuinely diverse stay must receive more nights than the same-raw-count but repetitive one");
});

/* -------------------- reallocateNightsAfterDiscovery — live wiring shape -------------------- */

function testFrame(phases: Array<{ id: string; areaLabel: string; nights: number }>): TripFrame {
  let cursor = 1;
  return {
    bucketId: "multi_phase",
    source: "ai",
    phases: phases.map((p) => {
      const startDayNumber = cursor;
      const endDayNumber = cursor + p.nights - 1;
      cursor = endDayNumber + 1;
      return { id: p.id, areaLabel: p.areaLabel, nights: p.nights, startDayNumber, endDayNumber, intent: "mixed" as const };
    }),
  };
}

test("Round 9.3.1: reallocateNightsAfterDiscovery rebalances toward the stay with genuinely richer real discovered supply", () => {
  const frame = testFrame([{ id: "s1", areaLabel: "Rich City", nights: 5 }, { id: "s2", areaLabel: "Thin Town", nights: 5 }]);
  const poolsByStay = new Map([
    ["s1", pool({ stayId: "s1", ownerArea: "Rich City", candidates: Array.from({ length: 20 }), categorySupply: { CULTURE: 5, NATURE: 5, LANDMARK: 5, LOCAL_EXPERIENCE: 5 } })],
    ["s2", pool({ stayId: "s2", ownerArea: "Thin Town", candidates: Array.from({ length: 2 }), categorySupply: { CULTURE: 2 } })],
  ]);
  const mealPoolsByStay = new Map([
    ["s1", mealPool({ stayId: "s1" })],
    ["s2", mealPool({ stayId: "s2" })],
  ]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 10, poolsByStay as never, mealPoolsByStay, []);
  const rich = reallocated.phases.find((p) => p.areaLabel === "Rich City")!;
  const thin = reallocated.phases.find((p) => p.areaLabel === "Thin Town")!;
  assert.ok(rich.nights > thin.nights, `expected Rich City (${rich.nights}) > Thin Town (${thin.nights})`);
  assert.equal(reallocated.phases.reduce((s, p) => s + p.nights, 0), 10, "total nights must still equal the trip length exactly");
});

test("Round 9.3.1: reallocateNightsAfterDiscovery never touches a single-phase frame", () => {
  const frame = testFrame([{ id: "s1", areaLabel: "Only City", nights: 10 }]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 10, new Map(), new Map(), []);
  assert.equal(reallocated, frame);
});

test("Round 9.3.1: reallocateNightsAfterDiscovery preserves day-range contiguity and phase order", () => {
  const frame = testFrame([{ id: "s1", areaLabel: "A", nights: 5 }, { id: "s2", areaLabel: "B", nights: 5 }, { id: "s3", areaLabel: "C", nights: 5 }]);
  const poolsByStay = new Map([
    ["s1", pool({ stayId: "s1", candidates: Array.from({ length: 10 }) })],
    ["s2", pool({ stayId: "s2", candidates: Array.from({ length: 10 }) })],
    ["s3", pool({ stayId: "s3", candidates: Array.from({ length: 10 }) })],
  ]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 15, poolsByStay as never, new Map(), []);
  assert.equal(reallocated.phases[0].startDayNumber, 1);
  for (let i = 1; i < reallocated.phases.length; i += 1) {
    assert.equal(reallocated.phases[i].startDayNumber, reallocated.phases[i - 1].endDayNumber + 1, "day ranges must stay contiguous after reallocation");
  }
  assert.equal(reallocated.phases.at(-1)!.endDayNumber, 15);
  assert.deepEqual(reallocated.phases.map((p) => p.areaLabel), ["A", "B", "C"], "reallocation must never change stay order, only night counts");
});

/* ==================================================================== *
 * ROUND 9.3.2 — RESERVE-STAY COMPETITION + USABLE-DAY ALLOCATION        *
 * ==================================================================== */

function dayInput(overrides: Partial<StayDayCapacityInput> = {}): StayDayCapacityInput {
  return { dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false, ...overrides };
}

/* -------------------- computeStayUsableCapacity (spec §7-12) -------------------- */

// F. late arrival reduces usable sightseeing capacity.
test("Round 9.3.2 F: a late arrival (low usableHours) reduces a stay's equivalent sightseeing days", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "mixed" as const };
  const lateArrival = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5 })]]]);
  const earlyArrival = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 8 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5 })]]]);
  const late = computeStayUsableCapacity(phase, lateArrival);
  const early = computeStayUsableCapacity(phase, earlyArrival);
  assert.ok(late.equivalentSightseeingDays < early.equivalentSightseeingDays, `expected late-arrival capacity (${late.equivalentSightseeingDays}) < early-arrival capacity (${early.equivalentSightseeingDays})`);
});

// G. early arrival preserves meaningful usable time.
test("Round 9.3.2 G: an early arrival keeps capacity close to a stay with no arrival day at all", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" as const };
  const earlyArrival = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 8 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 })]]]);
  const allNormal = new Map([["s1", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 })]]]);
  const early = computeStayUsableCapacity(phase, earlyArrival);
  const normal = computeStayUsableCapacity(phase, allNormal);
  assert.ok(early.equivalentSightseeingDays > normal.equivalentSightseeingDays * 0.6, "an early arrival should preserve a substantial share of a full day's value");
});

// H. early departure reduces usable sightseeing capacity.
test("Round 9.3.2 H: an early departure (low usableHours) reduces a stay's equivalent sightseeing days", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "mixed" as const };
  const earlyDeparture = new Map([["s1", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5, dayType: "departure", usableHours: 0.5 })]]]);
  const lateDeparture = new Map([["s1", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5, dayType: "departure", usableHours: 6 })]]]);
  const early = computeStayUsableCapacity(phase, earlyDeparture);
  const late = computeStayUsableCapacity(phase, lateDeparture);
  assert.ok(early.equivalentSightseeingDays < late.equivalentSightseeingDays, `expected early-departure capacity (${early.equivalentSightseeingDays}) < late-departure capacity (${late.equivalentSightseeingDays})`);
});

// I. late departure can preserve partial sightseeing time.
test("Round 9.3.2 I: a late departure still contributes a non-trivial amount of capacity, not zero", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" as const };
  const lateDeparture = new Map([["s1", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3, dayType: "departure", usableHours: 6 })]]]);
  const result = computeStayUsableCapacity(phase, lateDeparture);
  assert.ok(result.equivalentSightseeingDays > 3, "a late departure day should contribute meaningfully, not read as zero");
});

// J. internal transfer day is not counted as a full day in both stays.
test("Round 9.3.2 J: a transfer day contributes less than a normal day, and only to its own owning stay", () => {
  const phaseA = { id: "a", areaLabel: "A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" as const };
  const dayTypesByStay = new Map([["a", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3, dayType: "transfer" })]]]);
  const withTransfer = computeStayUsableCapacity(phaseA, dayTypesByStay);
  const allNormal = computeStayUsableCapacity(phaseA, new Map([["a", [dayInput({ dayNumber: 1 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 })]]]));
  assert.ok(withTransfer.equivalentSightseeingDays < allNormal.equivalentSightseeingDays, "a transfer day must discount capacity relative to an all-normal-days stay of the same length");
  // Exact value, not just "less than" — catches a transfer day silently
  // being double-counted (e.g. attributed at 2x its own real target)
  // rather than counted exactly once at its own real (0.5) target.
  assert.equal(withTransfer.equivalentSightseeingDays, 6.5, "two normal days (3 each) + one transfer day (0.5) must sum to exactly 6.5, never double-counted");
});

// K. same raw night count, different arrival/departure timing -> different usable capacity.
test("Round 9.3.2 K: two stays with the SAME night count but different arrival/departure timing get different usable capacity", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 5, startDayNumber: 1, endDayNumber: 5, intent: "mixed" as const };
  const goodTiming = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 8 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5, dayType: "departure", usableHours: 8 })]]]);
  const badTiming = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 0.5 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 }), dayInput({ dayNumber: 4 }), dayInput({ dayNumber: 5, dayType: "departure", usableHours: 0.5 })]]]);
  const good = computeStayUsableCapacity(phase, goodTiming);
  const bad = computeStayUsableCapacity(phase, badTiming);
  assert.notEqual(good.equivalentSightseeingDays, bad.equivalentSightseeingDays);
  assert.ok(good.equivalentSightseeingDays > bad.equivalentSightseeingDays);
});

// L. unknown timing does not fabricate full-day precision.
test("Round 9.3.2 L: unknown arrival/departure timing is reported as 'partial' confidence, never silently treated as fully known", () => {
  const phase = { id: "s1", areaLabel: "A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" as const };
  const unknownTiming = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: null }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 })]]]);
  const result = computeStayUsableCapacity(phase, unknownTiming);
  assert.equal(result.confidence, "partial");

  const knownTiming = new Map([["s1", [dayInput({ dayNumber: 1, dayType: "arrival", usableHours: 8 }), dayInput({ dayNumber: 2 }), dayInput({ dayNumber: 3 })]]]);
  assert.equal(computeStayUsableCapacity(phase, knownTiming).confidence, "known");

  assert.equal(computeStayUsableCapacity(phase, new Map()).confidence, "unknown");
});

test("computeStayValueProfile applies the usable-capacity discount only when usableCapacity+nights are both supplied", () => {
  const pool = { candidates: Array.from({ length: 10 }), categorySupply: {}, diagnostics: { supplyDegraded: false, providerFailures: 0, providerTimeouts: 0 } } as unknown as StayActivityPool;
  const withoutDiscount = computeStayValueProfile("s1", "A", pool, undefined, [], false);
  assert.equal(withoutDiscount.usableCapacityFactor, 1);

  const withDiscount = computeStayValueProfile("s1", "A", pool, undefined, [], false, { equivalentSightseeingDays: 3, confidence: "known" }, 5);
  assert.ok(withDiscount.usableCapacityFactor < 1, "a stay whose usable days fall well short of raw nights * 3 must be discounted");
});

/* -------------------- Reserve-stay competition (spec §2-6, §13-15) -------------------- */

function reserveStay(overrides: Partial<ResolvedStay> = {}): ResolvedStay {
  return { stayId: "reserve-1", proposedId: null, areaLabel: "Reserve City", lat: 45, lon: -100, nights: 2, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US", ...overrides };
}
function activeStay(overrides: Partial<ResolvedStay> = {}): ResolvedStay {
  return { stayId: "active-1", proposedId: null, areaLabel: "Active City", lat: 40, lon: -74, nights: 5, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US", ...overrides };
}

// C. small reserve advantage does not overcome high transfer friction.
test("Round 9.3.2 C: rankReserveStaysForPromotion penalizes a distant reserve enough that a nearby weaker one can rank higher", () => {
  const nearWeak = reserveStay({ stayId: "near", lat: 40.5, lon: -74.5, nights: 1 });
  const farStrong = reserveStay({ stayId: "far", lat: 60, lon: 20, nights: 3, reasons: ["must_visit"] }); // very far, e.g. across an ocean
  const active = [activeStay({ lat: 40, lon: -74 })];
  const ranked = rankReserveStaysForPromotion([nearWeak, farStrong], active);
  const nearScore = ranked.find((r) => r.reserve.stayId === "near")!.netStageAScore;
  const farScore = ranked.find((r) => r.reserve.stayId === "far")!.netStageAScore;
  assert.ok(ranked[0].transferCostKm >= 0);
  // The far reserve's raw stageAValue is higher, but transfer friction must
  // meaningfully erode its net score relative to its own raw value.
  const farRaw = ranked.find((r) => r.reserve.stayId === "far")!.stageAValue;
  assert.ok(farScore < farRaw, "transfer friction must reduce the far reserve's net score below its raw value");
  assert.ok(nearScore <= ranked.find((r) => r.reserve.stayId === "near")!.stageAValue, "friction (even if small) never increases a score above raw value");
});

// A/B. rich active stay deserves another day over weak reserve / strong
// reserve beats low marginal value of day 8 in an active stay.
test("Round 9.3.2 A/B: decideReservePromotion only promotes when the reserve's real value meaningfully exceeds the weakest active day", () => {
  const weakReserveProfile: StayValueProfile = { stayId: "reserve-1", areaLabel: "Reserve City", meaningfulActivitySupply: 1, diversityScore: 0, mealVenueSupply: 0, userPriority: 0, isStructuralAnchor: false, discoveryConfidence: "high_confidence", usableCapacityFactor: 1 };
  const strongReserveProfile: StayValueProfile = { stayId: "reserve-1", areaLabel: "Reserve City", meaningfulActivitySupply: 30, diversityScore: 20, mealVenueSupply: 10, userPriority: 0, isStructuralAnchor: false, discoveryConfidence: "high_confidence", usableCapacityFactor: 1 };
  const allocation = { nightsByStayId: new Map([["active-1", 8]]), allocationDetails: new Map([["active-1", { valueScore: 10, firstDayMarginalValue: 10, lastAllocatedDayMarginalValue: 1, nextUnallocatedDayMarginalValue: 1 }]]) };

  const weakDecision = decideReservePromotion(reserveStay(), weakReserveProfile, 50, allocation);
  assert.equal(weakDecision.promote, false, "a weak reserve must not displace even a low-value 8th day");

  const strongDecision = decideReservePromotion(reserveStay(), strongReserveProfile, 50, allocation);
  assert.equal(strongDecision.promote, true, "a genuinely strong reserve must be able to beat a low marginal-value day in an active stay");
  assert.equal(strongDecision.demoteFromStayId, "active-1");
});

// D. strong reserve can be promoted when transfer cost is reasonable.
test("Round 9.3.2 D: a strong reserve with LOW transfer cost is promoted more readily than the same reserve with HIGH transfer cost", () => {
  const strongProfile: StayValueProfile = { stayId: "reserve-1", areaLabel: "Reserve City", meaningfulActivitySupply: 15, diversityScore: 8, mealVenueSupply: 5, userPriority: 0, isStructuralAnchor: false, discoveryConfidence: "high_confidence", usableCapacityFactor: 1 };
  const allocation = { nightsByStayId: new Map([["active-1", 5]]), allocationDetails: new Map([["active-1", { valueScore: 10, firstDayMarginalValue: 10, lastAllocatedDayMarginalValue: 5, nextUnallocatedDayMarginalValue: 5 }]]) };
  const lowFriction = decideReservePromotion(reserveStay(), strongProfile, 20, allocation);
  const highFriction = decideReservePromotion(reserveStay(), strongProfile, 5000, allocation);
  assert.equal(lowFriction.promote, true);
  assert.equal(highFriction.promote, false, "the same reserve must fail to promote once transfer cost is high enough");
});

// E. must-visit reserve receives structural protection.
test("Round 9.3.2 E: a must-visit reserve's Stage-A ranking is meaningfully higher than an equivalent non-must-visit reserve", () => {
  const plain = reserveStay({ stayId: "plain", nights: 2, reasons: [] });
  const mustVisit = reserveStay({ stayId: "priority", nights: 2, reasons: ["must_visit"] });
  const ranked = rankReserveStaysForPromotion([plain, mustVisit], [activeStay()]);
  const plainScore = ranked.find((r) => r.reserve.stayId === "plain")!.netStageAScore;
  const priorityScore = ranked.find((r) => r.reserve.stayId === "priority")!.netStageAScore;
  assert.ok(priorityScore > plainScore, "an explicit must-visit reserve must rank meaningfully above an otherwise-identical non-priority one");
});

/* -------------------- applyReservePromotion (spec §14/§15) -------------------- */

// M. reserve promotion preserves exact total nights.
test("Round 9.3.2 M: applyReservePromotion preserves the exact total night count", () => {
  const frame = testFrame([{ id: "active-1", areaLabel: "Active City", nights: 5 }, { id: "active-2", areaLabel: "Other City", nights: 5 }]);
  const totalBefore = frame.phases.reduce((s, p) => s + p.nights, 0);
  const promoted = applyReservePromotion(frame, reserveStay(), "active-1");
  const totalAfter = promoted.phases.reduce((s, p) => s + p.nights, 0);
  assert.equal(totalAfter, totalBefore);
  assert.ok(promoted.phases.some((p) => p.id === "reserve-1"));
  assert.equal(promoted.phases.find((p) => p.id === "active-1")!.nights, 4);
});

test("Round 9.3.2: applyReservePromotion refuses to demote a stay already at its minimum (1 night)", () => {
  const frame = testFrame([{ id: "active-1", areaLabel: "Active City", nights: 1 }, { id: "active-2", areaLabel: "Other City", nights: 9 }]);
  const promoted = applyReservePromotion(frame, reserveStay(), "active-1");
  assert.equal(promoted, frame, "refusing to demote a 1-night stay must return the frame unchanged");
});

// Q. no stale transition references survive — day ranges stay contiguous
// and cover the whole trip after promotion.
test("Round 9.3.2 Q: applyReservePromotion produces contiguous, gap-free day ranges covering the whole trip", () => {
  const frame = testFrame([{ id: "active-1", areaLabel: "A", nights: 5 }, { id: "active-2", areaLabel: "B", nights: 5 }]);
  const promoted = applyReservePromotion(frame, reserveStay(), "active-1");
  assert.equal(promoted.phases[0].startDayNumber, 1);
  for (let i = 1; i < promoted.phases.length; i += 1) {
    assert.equal(promoted.phases[i].startDayNumber, promoted.phases[i - 1].endDayNumber + 1);
  }
  assert.equal(promoted.phases.at(-1)!.endDayNumber, 10);
});
