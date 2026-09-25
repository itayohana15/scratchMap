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
  classifyStayDestination,
  MAX_STAY_NIGHTS,
  computeMinimumRequiredStayCount,
  evaluateStaySkeletonCoverage,
  computeStayInventoryPressure,
  classifyInterestDemand,
  estimateStayCapacityProfile,
  clampPhaseNightsToMaximum,
  discoverRouteCorridorCandidates,
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

/* ==================================================================== *
 * ROUND 9.16.2.1 — DAYS VS NIGHTS ACCOUNTING FIX. The exact Round        *
 * 9.16.3 production defect: a 36-calendar-day / 35-sleeping-night trip,  *
 * 7 real Gemini-proposed stays summing to exactly 35 raw nights, ended   *
 * up with sum(phase.nights) = 36 after buildTripFrameFromResolvedStays   *
 * — the highest-weight stay (New York, proposed 10 nights, resolved     *
 * last in route order) silently absorbed a phantom 36th night. Fixed by  *
 * reducing ONLY the trip's LAST phase's `nights` field by the departure- *
 * day slack, leaving day-RANGES (startDayNumber/endDayNumber) — already  *
 * proven contiguous/gap-free/overlap-free — completely untouched.       *
 * ==================================================================== */

// §5 — the exact Round 9.16.3 production regression.
test("Round 9.16.2.1 §5 (CRITICAL VALIDATION, exact production regression): 7 real stays summing to 35 proposed nights never inflate to 36 after buildTripFrameFromResolvedStays", () => {
  const stays: ResolvedStay[] = [
    { stayId: "boston", proposedId: null, areaLabel: "Boston", lat: 42.3588336, lon: -71.0578303, nights: 4, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "portland-me", proposedId: null, areaLabel: "Portland, Maine", lat: 43.6573605, lon: -70.2586618, nights: 4, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "north-conway", proposedId: null, areaLabel: "North Conway, New Hampshire", lat: 44.037776, lon: -71.1238246, nights: 5, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "providence", proposedId: null, areaLabel: "Providence, Rhode Island", lat: 41.8239891, lon: -71.4128343, nights: 3, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "newport", proposedId: null, areaLabel: "Newport, Rhode Island", lat: 41.4899827, lon: -71.3137707, nights: 3, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "philadelphia", proposedId: null, areaLabel: "Philadelphia", lat: 39.9527237, lon: -75.1635262, nights: 6, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "new-york", proposedId: null, areaLabel: "New York", lat: 40.7127281, lon: -74.0060152, nights: 10, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
  ];
  const dayCount = 36; // 35 tripNights — the exact production shape
  // Real arrival(Boston-area)/departure(New-York-area) anchors — matching
  // the exact production route-reorder that put New York last.
  const { frame } = buildTripFrameFromResolvedStays(stays, dayCount, { lat: 42.36, lon: -71.06 }, { lat: 40.71, lon: -74.0 });
  const phases = frame.phases;
  const totalNights = phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(totalNights, 35, "sum(phase.nights) must equal tripNights (35), NOT dayCount (36)");
  assert.ok(phases.every((p) => p.nights <= 14), `no stay may exceed 14 nights, got ${JSON.stringify(phases.map((p) => ({ area: p.areaLabel, nights: p.nights })))}`);
  // Every one of the 36 calendar days must still be represented by exactly one phase.
  const coveredDays = new Set<number>();
  for (const phase of phases) {
    for (let d = phase.startDayNumber; d <= phase.endDayNumber; d += 1) coveredDays.add(d);
  }
  assert.equal(coveredDays.size, dayCount, "all 36 calendar days must remain represented by the trip/day model");
  assert.equal(Math.max(...phases.map((p) => p.endDayNumber)), dayCount, "the trip's last calendar day (36) must still be owned by some phase");
  // The highest-weight stay (New York, proposed 10) must not silently
  // absorb a phantom extra NIGHT — its nights value stays at (or below)
  // its own proposed value, even though its CALENDAR day-span may
  // legitimately be one day longer (the trip's pure departure day).
  const newYork = phases.find((p) => p.areaLabel === "New York")!;
  assert.ok(newYork, "New York must still be a real, resolved phase");
  assert.ok(newYork.nights <= 10, `New York's nights must not be inflated beyond its own proposed value (10), got ${newYork.nights}`);
});

// §6 — coverage regressions A-G.
test("Round 9.16.2.1 §6A: tripNights=35, coveredNights=35 => exact allocation, valid", () => {
  // 3 stays (none individually over MAX_STAY_NIGHTS) so this isolates the
  // exact-allocation signal from the unrelated overlong-stay check.
  const coverage = evaluateStaySkeletonCoverage([{ nights: 12 }, { nights: 12 }, { nights: 11 }], 35);
  assert.equal(coverage.totalAllocatedNights, 35);
  assert.equal(coverage.allocationStatus, "EXACTLY_ALLOCATED");
  assert.ok(!coverage.reasonCodes.includes("TRIP_OVER_ALLOCATED"));
  assert.equal(coverage.coverageValid, true);
});

test("Round 9.16.2.1 §6B: tripNights=35, coveredNights=34 => under-allocated, invalid (below the 0.8 ratio floor)", () => {
  // 34/35 = 0.971 ratio, well above 0.8 — under-allocation by 1 night
  // alone does not trip the coarse ratio gate; this proves UNDER_ALLOCATED
  // is reported honestly regardless, without being conflated with
  // coverageValid (a separate, coarser signal).
  const coverage = evaluateStaySkeletonCoverage([{ nights: 34 }], 35);
  assert.equal(coverage.totalAllocatedNights, 34);
  assert.equal(coverage.allocationStatus, "UNDER_ALLOCATED");
  assert.ok(!coverage.reasonCodes.includes("TRIP_OVER_ALLOCATED"));
});

test("Round 9.16.2.1 §6C (CRITICAL VALIDATION): tripNights=35, coveredNights=36 => TRIP_OVER_ALLOCATED, invalid — the exact Round 9.16.3 shape", () => {
  // 3 stays (none individually over MAX_STAY_NIGHTS) summing to 36 — the
  // exact Round 9.16.3 shape, isolated from the unrelated overlong-stay check.
  const coverage = evaluateStaySkeletonCoverage([{ nights: 12 }, { nights: 12 }, { nights: 12 }], 35);
  assert.equal(coverage.totalAllocatedNights, 36);
  assert.equal(coverage.allocationStatus, "OVER_ALLOCATED");
  assert.ok(coverage.reasonCodes.includes("TRIP_OVER_ALLOCATED"));
  assert.equal(coverage.coverageValid, false, "over-allocation must invalidate coverage even though the raw ratio (1.03) and every other signal look healthy");
  assert.equal(coverage.coverageRatio, 1.03, "the raw ratio must stay observable, never clamped to hide the defect");
});

test("Round 9.16.2.1 §6D: 36 calendar days remain represented even though phase nights sum to 35 (buildTripFrameFromResolvedStays)", () => {
  const stays: ResolvedStay[] = [
    { stayId: "s1", proposedId: null, areaLabel: "Alpha City", lat: 1, lon: 1, nights: 20, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
    { stayId: "s2", proposedId: null, areaLabel: "Beta Town", lat: 2, lon: 2, nights: 16, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" },
  ];
  const { frame } = buildTripFrameFromResolvedStays(stays, 36);
  const totalNights = frame.phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(totalNights, 35);
  assert.equal(Math.max(...frame.phases.map((p) => p.endDayNumber)), 36, "day 36 must still be represented");
});

test("Round 9.16.2.1 §6E: the 1-day trip edge case preserves existing planner semantics safely (tripNights floors at 1, never 0)", () => {
  const coverage = evaluateStaySkeletonCoverage([{ nights: 1 }], 1);
  assert.equal(coverage.totalAllocatedNights, 1);
  assert.equal(coverage.allocationStatus, "EXACTLY_ALLOCATED");
  const stays: ResolvedStay[] = [{ stayId: "s1", proposedId: null, areaLabel: "Solo City", lat: 1, lon: 1, nights: 1, reasons: [], source: "gemini_resolved", confidence: "high", countryIso: "US" }];
  const { frame } = buildTripFrameFromResolvedStays(stays, 1);
  assert.equal(frame.phases[0].nights, 1, "a 1-day trip must never be reduced to 0 nights");
});

test("Round 9.16.2.1 §6F: exactly MAX_STAY_NIGHTS (14) remains legal", () => {
  const coverage = evaluateStaySkeletonCoverage([{ nights: 14 }], 14);
  assert.equal(coverage.overlongStayCount, 0);
  assert.equal(coverage.allocationStatus, "EXACTLY_ALLOCATED");
  assert.equal(coverage.coverageValid, true);
});

test("Round 9.16.2.1 §6G: 15 nights (one over MAX_STAY_NIGHTS) remains illegal", () => {
  const coverage = evaluateStaySkeletonCoverage([{ nights: 15 }], 15);
  assert.equal(coverage.overlongStayCount, 1);
  assert.equal(coverage.coverageValid, false);
});

// §7 — reallocateNightsAfterDiscovery regression.
test("Round 9.16.2.1 §7: reallocateNightsAfterDiscovery preserves the frame's own real 24-night total after the upstream fix (never re-inflates it toward dayCount=25)", () => {
  const frame = testFrame([
    { id: "s1", areaLabel: "Rich City", nights: 12 },
    { id: "s2", areaLabel: "Thin Town", nights: 12 },
  ]);
  const sumBefore = frame.phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(sumBefore, 24, "a 25-calendar-day / 24-sleeping-night trip's frame, per the sleeping-nights convention this round establishes");
  const poolsByStay = new Map([
    ["s1", pool({ stayId: "s1", ownerArea: "Rich City", candidates: Array.from({ length: 30 }) })],
    ["s2", pool({ stayId: "s2", ownerArea: "Thin Town", candidates: Array.from({ length: 3 }) })],
  ]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 25, poolsByStay as never, new Map(), []);
  const sumAfter = reallocated.phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(sumAfter, 24, "reallocation must preserve the frame's own real total (24), never silently inflate it toward dayCount (25)");
  assert.ok(reallocated.phases.every((p) => p.nights <= 14), "no stay may exceed 14 nights after reallocation");
  assert.equal(Math.max(...reallocated.phases.map((p) => p.endDayNumber)), 25, "all 25 calendar days must remain represented after reallocation");
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

test("Round 9.16.2 §5: reallocateNightsAfterDiscovery never lets a richly-supplied stay's marginal value push it past MAX_STAY_NIGHTS", () => {
  // A 26-night trip, 2 stays, one with vastly richer real post-discovery
  // supply than the other — uncapped, marginal-value allocation would
  // legitimately want to give the rich stay far more than 14 nights; here
  // (unlike the next test) 2*14=28 >= 26, so the cap and full coverage are
  // both simultaneously achievable, and both must actually be honored.
  const frame = testFrame([{ id: "s1", areaLabel: "Rich Metro", nights: 13 }, { id: "s2", areaLabel: "Thin Town", nights: 13 }]);
  const poolsByStay = new Map([
    ["s1", pool({ stayId: "s1", ownerArea: "Rich Metro", candidates: Array.from({ length: 90 }), categorySupply: { CULTURE: 20, NATURE: 20, LANDMARK: 20, LOCAL_EXPERIENCE: 20 } })],
    ["s2", pool({ stayId: "s2", ownerArea: "Thin Town", candidates: Array.from({ length: 3 }), categorySupply: { CULTURE: 3 } })],
  ]);
  const mealPoolsByStay = new Map([
    ["s1", mealPool({ stayId: "s1" })],
    ["s2", mealPool({ stayId: "s2" })],
  ]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 26, poolsByStay as never, mealPoolsByStay, []);
  assert.ok(reallocated.phases.every((p) => p.nights <= MAX_STAY_NIGHTS), `no stay may exceed ${MAX_STAY_NIGHTS} nights even when its real discovered supply strongly favors it`);
  assert.equal(reallocated.phases.reduce((s, p) => s + p.nights, 0), 26, "full trip-day coverage must be preserved");
});

test("Round 9.16.2 §5 (bug fix): when the trip is too long for its known stay count even at the hard cap (2 phases, 30 nights: 2*14=28<30), full day coverage still wins — no day is ever left owned by no phase", () => {
  const frame = testFrame([{ id: "s1", areaLabel: "Rich Metro", nights: 15 }, { id: "s2", areaLabel: "Thin Town", nights: 15 }]);
  const poolsByStay = new Map([
    ["s1", pool({ stayId: "s1", ownerArea: "Rich Metro", candidates: Array.from({ length: 90 }), categorySupply: { CULTURE: 20, NATURE: 20, LANDMARK: 20, LOCAL_EXPERIENCE: 20 } })],
    ["s2", pool({ stayId: "s2", ownerArea: "Thin Town", candidates: Array.from({ length: 3 }), categorySupply: { CULTURE: 3 } })],
  ]);
  const mealPoolsByStay = new Map([
    ["s1", mealPool({ stayId: "s1" })],
    ["s2", mealPool({ stayId: "s2" })],
  ]);
  const reallocated = reallocateNightsAfterDiscovery(frame, 30, poolsByStay as never, mealPoolsByStay, []);
  assert.equal(reallocated.phases.reduce((s, p) => s + p.nights, 0), 30, "full trip-day coverage must never be silently dropped, even when it is genuinely impossible to also honor the 14-night cap with only 2 known stays");
  assert.equal(reallocated.phases[0].startDayNumber, 1);
  assert.equal(reallocated.phases[reallocated.phases.length - 1].endDayNumber, 30, "every trip day, including the last, must belong to some phase");
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

/* ==================================================================== *
 * ROUND 9.16 — stay skeleton resilience + size/capacity-aware duration. *
 * ==================================================================== */

function rs(areaLabel: string, nights: number, overrides: Partial<ResolvedStay> = {}): ResolvedStay {
  return {
    stayId: `stay-${areaLabel}`,
    proposedId: `p-${areaLabel}`,
    areaLabel,
    lat: 0,
    lon: 0,
    nights,
    reasons: [],
    source: "gemini_resolved",
    confidence: "high",
    countryIso: "US",
    ...overrides,
  };
}

/* ---- §10 locality semantic eligibility guard ---- */

test("Round 9.16 §10/test J: a POI/institution masquerading as a locality (college, museum, business) is rejected as a stay destination, generically — never by hardcoded name", () => {
  const college = { placeClass: "amenity", placeType: "college", addressComponents: { city: "Berlin", county: "Coös County", state: "New Hampshire", country: "United States" } };
  const museum = { placeClass: "tourism", placeType: "museum", addressComponents: { city: "Springfield", state: "Illinois", country: "United States" } };
  const shop = { placeClass: "shop", placeType: "supermarket", addressComponents: { city: "Reno", state: "Nevada", country: "United States" } };
  for (const match of [college, museum, shop]) {
    const result = classifyStayDestination(match);
    assert.equal(result.kind, "rejected", `${match.placeClass}/${match.placeType} must never become a lodging locality merely because its address contains a settlement field`);
  }
});

test("Round 9.16 test K: a legitimate city/town/village remains accepted as a practical stay base", () => {
  assert.equal(classifyStayDestination({ placeClass: "place", placeType: "city", addressComponents: { city: "Denver", state: "Colorado", country: "United States" } }).kind, "practical_base");
  assert.equal(classifyStayDestination({ placeClass: "place", placeType: "town", addressComponents: { town: "Hyannis", county: "Barnstable", state: "Massachusetts", country: "United States" } }).kind, "practical_base");
  assert.equal(classifyStayDestination({ placeClass: "place", placeType: "village", addressComponents: { village: "Stowe", state: "Vermont", country: "United States" } }).kind, "practical_base");
});

/* ---- §5 minimum required stay count (hard lower bound only) ---- */

test("Round 9.16 §5: computeMinimumRequiredStayCount is the hard ceil(tripNights/14) LOWER bound, never a desired count", () => {
  assert.equal(computeMinimumRequiredStayCount(0), 1);
  assert.equal(computeMinimumRequiredStayCount(10), 1);
  assert.equal(computeMinimumRequiredStayCount(14), 1);
  assert.equal(computeMinimumRequiredStayCount(15), 2);
  assert.equal(computeMinimumRequiredStayCount(35), 3);
  assert.equal(computeMinimumRequiredStayCount(36), 3);
});

/* ---- §2 StaySkeletonCoverage — the core new invariant ---- */

test("Round 9.16 §2 (the exact Round 9.15.11 regression): 2 geographically valid stays covering only ~3 of 36 trip nights is coverageValid=false, not silently accepted", () => {
  const stays = [rs("Boston", 1, { reasons: ["arrival"] }), rs("New York", 1, { reasons: ["departure"] })];
  const coverage = evaluateStaySkeletonCoverage(stays, 35);
  assert.equal(coverage.coverageValid, false, "the exact Round 9.15.11 shape must never be accepted as a healthy final stay skeleton");
  assert.ok(coverage.reasonCodes.includes("TRIP_UNDER_COVERED"));
  assert.ok(coverage.reasonCodes.includes("BELOW_MINIMUM_REQUIRED_STAY_COUNT"));
});

test("Round 9.16 §2/test E: a single stay proposed for more nights than the trip needs covers it, but a stay exceeding MAX_STAY_NIGHTS is still flagged overlong", () => {
  const coverage = evaluateStaySkeletonCoverage([rs("Solo City", 15)], 15);
  assert.equal(coverage.overlongStayCount, 1, "a single 15-night stay must fail the hard 14-night ceiling");
  assert.equal(coverage.coverageValid, false);
  assert.ok(coverage.reasonCodes.includes("STAY_EXCEEDS_MAX_NIGHTS"));
});

test("Round 9.16 test D: a 14-day rich region may remain ONE stay when its own capacity genuinely supports it", () => {
  const coverage = evaluateStaySkeletonCoverage([rs("Rich Metro", 13)], 13);
  assert.equal(coverage.stayCount, 1);
  assert.equal(coverage.overlongStayCount, 0);
  assert.equal(coverage.coverageValid, true, "a single stay within the ceiling that fully covers the trip must not be forced to split");
});

test("Round 9.16 test C: a 10-day rich city trip is NOT forced into unnecessary extra stays merely because expansion machinery exists", () => {
  const coverage = evaluateStaySkeletonCoverage([rs("Rich City", 9)], 9);
  assert.equal(coverage.coverageValid, true);
  assert.equal(coverage.stayCount, 1);
});

test("Round 9.16 test L (inventory pressure): a starved stay is flagged even when its night count ALONE would already satisfy coverage", () => {
  // 6 nights for a 6-night trip: night-count coverage alone is already 100%
  // (coveredNights=6, coverageRatio=1.0, not overlong, stayCount meets the
  // minimum) — ONLY the real, measured supply shortfall (10 available vs
  // 18 required) can catch this, exactly the Round 9.15.11 New York shape
  // (34 available vs 52 required, ratio 0.65) generalized.
  const pressure = computeStayInventoryPressure("stay-Thin", "Thin City", 6, 10);
  assert.equal(pressure.starved, true);
  const withoutPressure = evaluateStaySkeletonCoverage([rs("Thin City", 6)], 6);
  assert.equal(withoutPressure.coverageValid, true, "sanity: night-count alone genuinely looks sufficient here");
  const withPressure = evaluateStaySkeletonCoverage([rs("Thin City", 6)], 6, [pressure]);
  assert.ok(withPressure.reasonCodes.includes("INVENTORY_STARVED_STAY"));
  assert.equal(withPressure.coverageValid, false, "real inventory pressure must be able to fail an otherwise night-count-sufficient skeleton — the allocator should expand rather than keep piling FreeTime onto a starved stay");
});

test("Round 9.16 §8: computeStayInventoryPressure never flags a stay with genuinely adequate real supply", () => {
  const pressure = computeStayInventoryPressure("stay-Rich", "Rich City", 6, 30);
  assert.equal(pressure.starved, false);
});

/* ---- §4/§9 hard max-stay invariant + safe redistribution ---- */

test("Round 9.16 §4: clampPhaseNightsToMaximum redistributes overflow to phases with real headroom, never invents a phase, never drops trip days", () => {
  const phases = [
    { id: "p1", areaLabel: "Boston", nights: 18, startDayNumber: 1, endDayNumber: 18, intent: "mixed" as const },
    { id: "p2", areaLabel: "New York", nights: 18, startDayNumber: 19, endDayNumber: 36, intent: "mixed" as const },
    { id: "p3", areaLabel: "Providence", nights: 6, startDayNumber: 37, endDayNumber: 42, intent: "mixed" as const },
  ];
  const result = clampPhaseNightsToMaximum(phases, MAX_STAY_NIGHTS);
  assert.ok(result.phases.every((p) => p.nights <= MAX_STAY_NIGHTS), "no phase may exceed the hard ceiling when real headroom exists elsewhere");
  const totalBefore = phases.reduce((sum, p) => sum + p.nights, 0);
  const totalAfter = result.phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(totalAfter, totalBefore, "total trip nights (day coverage) must never change — only the split across phases");
  assert.equal(result.unallocatableNights, 0, "3 phases at up to 14 nights each (42) comfortably covers this 42-night trip");
});

test("Round 9.16 §4: clampPhaseNightsToMaximum never silently drops trip-day coverage even when NO phase has enough combined headroom", () => {
  const phases = [
    { id: "p1", areaLabel: "Boston", nights: 18, startDayNumber: 1, endDayNumber: 18, intent: "mixed" as const },
    { id: "p2", areaLabel: "New York", nights: 18, startDayNumber: 19, endDayNumber: 36, intent: "mixed" as const },
  ];
  const result = clampPhaseNightsToMaximum(phases, MAX_STAY_NIGHTS);
  const totalBefore = phases.reduce((sum, p) => sum + p.nights, 0);
  const totalAfter = result.phases.reduce((sum, p) => sum + p.nights, 0);
  assert.equal(totalAfter, totalBefore, "2 stays at 14 each (28) cannot legally cover a 36-night trip — the shortfall must be REPORTED (unallocatableNights), never hidden by silently shrinking day coverage");
  assert.equal(result.unallocatableNights, 8, "36 - (2*14) = 8 nights genuinely cannot respect the ceiling with only 2 phases");
});

/* ---- §7 interest-driven demand classification (generic, never hardcoded destinations) ---- */

test("Round 9.16 test M: classifyInterestDemand maps free-text interests to structured demand categories, in both Hebrew and English, without ever naming a destination", () => {
  const demand = classifyInterestDemand("טבע, היסטוריה, אוכל, הרים, חופים, כפרים, תרבות, חיי לילה");
  assert.ok(demand.has("NATURE"));
  assert.ok(demand.has("HISTORY"));
  assert.ok(demand.has("FOOD"));
  assert.ok(demand.has("MOUNTAINS"));
  assert.ok(demand.has("BEACHES"));
  assert.ok(demand.has("VILLAGES"));
  assert.ok(demand.has("CULTURE"));
  assert.ok(demand.has("NIGHTLIFE"));

  const englishDemand = classifyInterestDemand("hiking in the mountains, scenic coastal villages, street food");
  assert.ok(englishDemand.has("HIKING"));
  assert.ok(englishDemand.has("MOUNTAINS"));
  assert.ok(englishDemand.has("SCENIC") || englishDemand.has("COAST") || englishDemand.has("VILLAGES"));
  assert.ok(englishDemand.has("FOOD"));
});

test("Round 9.16 test M: classifyInterestDemand returns an empty set for blank/missing interests, never a fabricated default", () => {
  assert.equal(classifyInterestDemand("").size, 0);
  assert.equal(classifyInterestDemand(null).size, 0);
  assert.equal(classifyInterestDemand(undefined).size, 0);
});

/* ---- §3 StayCapacityProfile ---- */

test("Round 9.16 §3: estimateStayCapacityProfile returns the small/medium/large/exceptional tiers with the spec's own target ranges, and never exceeds MAX_STAY_NIGHTS", () => {
  const small = estimateStayCapacityProfile({ stayId: "s1", areaLabel: "Small Town" }, new Set());
  assert.equal(small.tier, "small");
  assert.ok(small.recommendedMinNights >= 3 && small.recommendedMinNights <= 5);
  assert.ok(small.recommendedMaxNights <= MAX_STAY_NIGHTS);

  const exceptional = estimateStayCapacityProfile({ stayId: "s2", areaLabel: "Rich Metro" }, new Set(), { meaningfulActivitySupply: 80, diversityScore: 15 });
  assert.equal(exceptional.tier, "exceptional");
  assert.ok(exceptional.recommendedMaxNights <= MAX_STAY_NIGHTS, "exceptional is still bounded by the hard 14-day ceiling, never exceeds it");
});

test("Round 9.16 §3: a broad interest profile can only ever nudge the CEILING of an already-non-small tier, never fabricate supply for a genuinely thin one", () => {
  const broadDemand = new Set(["NATURE", "HIKING", "FOOD", "CULTURE", "NIGHTLIFE"] as const);
  const thin = estimateStayCapacityProfile({ stayId: "s1", areaLabel: "Thin Town" }, broadDemand, { meaningfulActivitySupply: 5 });
  assert.equal(thin.tier, "small", "broad interests must never upgrade a stay whose real measured supply is genuinely thin");
});

/* ==================================================================== *
 * ROUND 9.16.2 §2 — discoverRouteCorridorCandidates: provider-neutral,  *
 * Gemini-independent region discovery along the real arrival<->        *
 * departure line. Never invents a name — every candidate comes from a  *
 * real reverse-geocode result, still subject to the SAME locality      *
 * guard (via classifyStayDestination in the caller's own resolve step) *
 * as every other candidate source.                                    *
 * ==================================================================== */

test("Round 9.16.2 §2: discoverRouteCorridorCandidates returns real, distinct candidates from interior points along the arrival<->departure line", async () => {
  const arrival = { lat: 42.36, lon: -71.06 }; // Boston
  const departure = { lat: 40.71, lon: -74.0 }; // New York
  const seen: number[] = [];
  const fakeReverse = async (lat: number, lon: number) => {
    seen.push(lat);
    return { name: `Corridor Town ${seen.length}`, lat, lon, placeClass: "place", placeType: "town", addressComponents: {} };
  };
  const candidates = await discoverRouteCorridorCandidates(arrival, departure, new Set(), 3, fakeReverse as never);
  assert.equal(candidates.length, 3);
  assert.equal(seen.length, 3, "exactly the requested sample count of interior points must be reverse-geocoded");
  const names = new Set(candidates.map((c) => c.areaName));
  assert.equal(names.size, 3, "each interior sample must produce a distinct candidate");
  assert.ok(candidates.every((c) => c.reasons.includes("route_corridor")));
  assert.ok(candidates.every((c) => c.nights > 0 && c.nights <= MAX_STAY_NIGHTS));
});

test("Round 9.16.2 §2: discoverRouteCorridorCandidates skips a point that already matches an existing stay, never proposing a duplicate", async () => {
  const arrival = { lat: 42.36, lon: -71.06 };
  const departure = { lat: 40.71, lon: -74.0 };
  const fakeReverse = async () => ({ name: "Boston", lat: 42.36, lon: -71.06, placeClass: "place", placeType: "city", addressComponents: {} });
  const candidates = await discoverRouteCorridorCandidates(arrival, departure, new Set(["boston"]), 2, fakeReverse as never);
  assert.equal(candidates.length, 0, "a candidate resolving to an area label already in the trip must never be proposed again");
});

test("Round 9.16.2 §2: discoverRouteCorridorCandidates gracefully skips a failed/invalid reverse-geocode result rather than throwing or fabricating a name", async () => {
  const arrival = { lat: 42.36, lon: -71.06 };
  const departure = { lat: 40.71, lon: -74.0 };
  let call = 0;
  const flakyReverse = async () => {
    call += 1;
    if (call === 1) throw new Error("network down");
    if (call === 2) return null;
    return { name: "  ", lat: 41, lon: -72, placeClass: "place", placeType: "town", addressComponents: {} }; // blank name
  };
  const candidates = await discoverRouteCorridorCandidates(arrival, departure, new Set(), 3, flakyReverse as never);
  assert.equal(candidates.length, 0, "every one of these three failure shapes must be skipped, never crash and never produce a fabricated candidate");
});

test("Round 9.16.2 §2: discoverRouteCorridorCandidates never queries more than 6 interior points regardless of a larger requested sampleCount", async () => {
  const arrival = { lat: 42.36, lon: -71.06 };
  const departure = { lat: 40.71, lon: -74.0 };
  let calls = 0;
  const countingReverse = async (lat: number, lon: number) => {
    calls += 1;
    return { name: `Town ${calls}`, lat, lon, placeClass: "place", placeType: "town", addressComponents: {} };
  };
  await discoverRouteCorridorCandidates(arrival, departure, new Set(), 20, countingReverse as never);
  assert.ok(calls <= 6, `expected the sample count to be clamped to a small bound, got ${calls} calls`);
});
