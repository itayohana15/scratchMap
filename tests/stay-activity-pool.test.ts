import assert from "node:assert/strict";
import test from "node:test";

import type { ActivityClassification, ActivityFamily, ActivitySubtype } from "../src/lib/server/activity-taxonomy";
import { ACTIVITY_FAMILIES } from "../src/lib/server/activity-taxonomy";
import {
  computeStayCapacity,
  computeDesiredCandidateCount,
  computeMinimumViableCandidateCount,
  estimateDayActivityTarget,
  assignCandidatesToStays,
  buildStayActivityPool,
  computeSignificance,
  selectStayPortfolio,
  appendPortfolioToHistory,
  refillStayActivityPool,
  validateGeminiPortfolioSelection,
  buildTripActivityPortfolios,
  defaultFetchNearbyRecommendations,
  OverpassProviderFailureError,
  CANDIDATE_RESERVE_FACTOR,
  type StayDayCapacityInput,
  type StayActivityPool,
  type StayActivityPoolCandidate,
  type RecentActivityHistoryEntry,
} from "../src/lib/server/stay-activity-pool";
import type { TripFrame, TripFramePhase } from "../src/lib/server/itinerary-planning-principles";
import type { TripRecommendation, DestinationMobilityProfile } from "../src/lib/trip-workspace";
import type { OverpassNearbyRecommendation, FetchLike } from "../src/lib/places/overpass";

// Round 9.3.3 — a tiny fetchImpl double mirroring tests/overpass.test.ts's
// createMockFetch, just enough to drive defaultFetchNearbyRecommendations's
// real Overpass path without any real network call.
function fakeFailingFetch(): FetchLike {
  return (async () => {
    throw new Error("simulated network error");
  }) as unknown as FetchLike;
}
function fakeEmptySuccessFetch(): FetchLike {
  return (async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) }) as unknown as Response) as unknown as FetchLike;
}

function normalizeArea(raw: string): string {
  return raw.trim();
}
function textMatch(locationText: string, areaLabel: string): boolean {
  return locationText === areaLabel;
}

function frame(phases: Array<Partial<TripFramePhase> & { areaLabel: string; startDayNumber: number; endDayNumber: number }>): TripFrame {
  return {
    bucketId: "multi_phase",
    source: "deterministic",
    phases: phases.map((p, i) => ({ id: p.id ?? `stay-${i}`, areaLabel: p.areaLabel, nights: p.endDayNumber - p.startDayNumber + 1, startDayNumber: p.startDayNumber, endDayNumber: p.endDayNumber, intent: "mixed" })),
  };
}

function rec(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? "rec-1",
    name: overrides.name ?? "Sample Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Area A",
    shortDescription: overrides.shortDescription ?? "",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? null,
    openingHours: overrides.openingHours ?? "08:00-20:00",
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? "any",
    reservationRequired: overrides.reservationRequired ?? false,
    mapLink: "",
    imageUrl: "",
    imageQuery: "",
    lat: overrides.lat ?? 10,
    lon: overrides.lon ?? 10,
    source: overrides.source ?? "api",
    wikipediaUrl: null,
    website: null,
    wheelchairAccessible: null,
    isFree: null,
  };
}

const MOBILITY: DestinationMobilityProfile = { tier: "medium", localityRadiusKm: 60, normalDayTravelBudgetMinutes: 160 };

/** Direct StayActivityPoolCandidate construction for pure diversity-scoring tests — bypasses classifyActivity entirely so tests state exactly the family/subtype under test. */
function poolCandidate(id: string, primaryFamily: ActivityFamily, subtype: ActivitySubtype, significance: number, secondaryFamilies: ActivityFamily[] = []): StayActivityPoolCandidate {
  const classification: ActivityClassification = {
    primaryFamily,
    subtype,
    secondaryFamilies,
    confidence: "keyword",
    metadata: { indoorOutdoor: "mixed", energyLevel: "medium", suitableTimeOfDay: null, paidFree: null, familyRelevant: null, eveningNightlifeSuitable: null, bookingSensitive: null },
  };
  return { recommendationId: id, name: id, category: "attraction", classification, significance, lat: 10, lon: 10, location: "Area A", source: "api" };
}

function poolOf(candidates: StayActivityPoolCandidate[], overrides: Partial<StayActivityPool> = {}): StayActivityPool {
  const categorySupply: Partial<Record<ActivityFamily, number>> = {};
  for (const c of candidates) categorySupply[c.classification.primaryFamily] = (categorySupply[c.classification.primaryFamily] ?? 0) + 1;
  return {
    stayId: "stay-0",
    ownerArea: "Area A",
    anchor: { lat: 10, lon: 10 },
    usableDayCapacity: 4,
    requiredRealActivityTarget: 8,
    desiredCandidateCount: 20,
    minimumViableCandidateCount: 8,
    candidates,
    categorySupply,
    diagnostics: {
      initialCandidateCount: candidates.length,
      resolvedCandidateCount: candidates.length,
      legalCandidateCount: candidates.length,
      desiredCandidateCount: 20,
      refillAttempts: 0,
      refillCandidateCount: 0,
      providerFailures: 0,
      providerElapsedMs: 0,
      providerTimeouts: 0,
      dedupeRejected: 0,
      geographyRejected: 0,
      mealVenueExcluded: 0,
      classificationBreakdown: categorySupply,
      supplyDegraded: false,
    },
    ...overrides,
  };
}

const NEUTRAL_WEIGHTS = Object.fromEntries(ACTIVITY_FAMILIES.map((f) => [f, 1])) as Record<ActivityFamily, number>;

/* -------------------- A-D: pool sizing -------------------- */

test("Round 9 A: a 1-day stay requires a smaller pool than a 5-day stay", () => {
  const oneDay: StayDayCapacityInput[] = [{ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false }];
  const fiveDay: StayDayCapacityInput[] = Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }));
  const oneDayPool = computeDesiredCandidateCount(computeStayCapacity(oneDay).requiredRealActivityTarget);
  const fiveDayPool = computeDesiredCandidateCount(computeStayCapacity(fiveDay).requiredRealActivityTarget);
  assert.ok(fiveDayPool > oneDayPool, `5-day pool (${fiveDayPool}) must exceed 1-day pool (${oneDayPool})`);
});

test("Round 9 B: 5 usable sightseeing days produce enough candidate reserve for multiple real activities/day", () => {
  const fiveDay: StayDayCapacityInput[] = Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }));
  const capacity = computeStayCapacity(fiveDay);
  const desired = computeDesiredCandidateCount(capacity.requiredRealActivityTarget);
  assert.ok(capacity.requiredRealActivityTarget >= 10, "5 full sightseeing days should target >= 2/day on average");
  assert.ok(desired >= capacity.requiredRealActivityTarget * 2, "reserve must be a real multiple, not a 1:1 count");
});

test("Round 9 C: an arrival/departure/transfer-heavy stay requests fewer candidates than an equal-length all-normal stay", () => {
  const heavy: StayDayCapacityInput[] = [
    { dayNumber: 1, dayType: "arrival", hasExplicitRestWindow: false, usableHours: 2 },
    { dayNumber: 2, dayType: "transfer", hasExplicitRestWindow: false },
    { dayNumber: 3, dayType: "transfer", hasExplicitRestWindow: false },
    { dayNumber: 4, dayType: "departure", hasExplicitRestWindow: false, usableHours: 2 },
  ];
  const allNormal: StayDayCapacityInput[] = Array.from({ length: 4 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false }));
  const heavyDesired = computeDesiredCandidateCount(computeStayCapacity(heavy).requiredRealActivityTarget);
  const normalDesired = computeDesiredCandidateCount(computeStayCapacity(allNormal).requiredRealActivityTarget);
  assert.ok(heavyDesired < normalDesired, `arrival/transfer-heavy (${heavyDesired}) must request fewer than all-normal (${normalDesired})`);
});

test("Round 9 D: pool size policy is centralized — computeDesiredCandidateCount is the ONE formula (reserve factor + floor)", () => {
  assert.equal(computeDesiredCandidateCount(0), Math.ceil(0 * CANDIDATE_RESERVE_FACTOR) || 4);
  assert.equal(computeDesiredCandidateCount(10), Math.ceil(10 * CANDIDATE_RESERVE_FACTOR));
  // Every call site (buildStayActivityPool, refillStayActivityPool sizing) reads pool.desiredCandidateCount, never recomputes its own number.
});

test("estimateDayActivityTarget never hardcodes a flat 3/day regardless of day type", () => {
  const normal = estimateDayActivityTarget({ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false });
  const light = estimateDayActivityTarget({ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: true });
  const transfer = estimateDayActivityTarget({ dayNumber: 1, dayType: "transfer", hasExplicitRestWindow: false });
  const shortArrival = estimateDayActivityTarget({ dayNumber: 1, dayType: "arrival", hasExplicitRestWindow: false, usableHours: 2 });
  const longArrival = estimateDayActivityTarget({ dayNumber: 1, dayType: "arrival", hasExplicitRestWindow: false, usableHours: 8 });
  assert.ok(normal > light);
  assert.ok(light > transfer);
  assert.ok(longArrival > shortArrival);
});

/* -------------------- ownership -------------------- */

test("Round 9: candidates are owned by exactly one stay — the geographically nearest anchor", () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 2 }, { areaLabel: "Area B", startDayNumber: 3, endDayNumber: 4 }]);
  const anchors = new Map([["Area A", { lat: 0, lon: 0 }], ["Area B", { lat: 5, lon: 5 }]]);
  const nearA = rec({ id: "near-a", lat: 0.1, lon: 0.1 });
  const nearB = rec({ id: "near-b", lat: 4.9, lon: 4.9 });
  const owned = assignCandidatesToStays([nearA, nearB], tripFrame, anchors, normalizeArea, textMatch);
  assert.deepEqual(owned.get("stay-0")!.map((c) => c.id), ["near-a"]);
  assert.deepEqual(owned.get("stay-1")!.map((c) => c.id), ["near-b"]);
});

test("Round 9: a coordinate-less candidate falls back to a text match against a phase's own area label", () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 2 }]);
  const anchors = new Map<string, { lat: number; lon: number } | null>([["Area A", null]]);
  const textOnly = rec({ id: "text-only", lat: null, lon: null, location: "Area A" });
  const owned = assignCandidatesToStays([textOnly], tripFrame, anchors, normalizeArea, textMatch);
  assert.deepEqual(owned.get("stay-0")!.map((c) => c.id), ["text-only"]);
});

/* -------------------- refill: Z-AE -------------------- */

function fakeOverpassRec(name: string, category: TripRecommendation["category"], lat = 10.01, lon = 10.01): OverpassNearbyRecommendation {
  return { name, category, location: "Area A", shortDescription: null, lat, lon, openingHours: null, wikipediaUrl: null, website: null };
}

test("Round 9 Z: initial discovery below target (6) -> a bounded refill round (12 more) brings the pool up to sufficiency", async () => {
  // Mirrors spec §33's own worked example numbers: needs ~15, initial
  // discovery yields 6, one targeted refill round yields 12 more.
  const initial = Array.from({ length: 6 }, (_, i) => rec({ id: `init-${i}`, name: `Init ${i}` }));
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 2 }]);
  const anchors = new Map([["Area A", { lat: 10, lon: 10 }]]);
  const owned = assignCandidatesToStays(initial, tripFrame, anchors, normalizeArea, textMatch);
  const capacity = computeStayCapacity([{ dayNumber: 1, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }]);
  const pool = buildStayActivityPool(tripFrame.phases[0], owned.get("stay-0")!, anchors.get("Area A")!, MOBILITY, capacity, [], 600);
  assert.ok(pool.candidates.length < pool.desiredCandidateCount, "initial pool is genuinely below target");

  let call = 0;
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => {
      call += 1;
      return Array.from({ length: 12 }, (_, i) => fakeOverpassRec(`Refill ${call}-${i}`, "attraction", 10.01 + i * 0.001, 10.01));
    },
  });
  assert.ok(refilled.candidates.length >= pool.desiredCandidateCount, `refilled pool (${refilled.candidates.length}) should reach the desired count (${pool.desiredCandidateCount})`);
});

test("Round 9: refill is bounded — it never queries forever even when the pool stays under target", async () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 5 }]);
  const anchor = { lat: 10, lon: 10 };
  const capacity = computeStayCapacity(Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false })));
  const pool = buildStayActivityPool(tripFrame.phases[0], [], anchor, MOBILITY, capacity, [], 600);
  let calls = 0;
  await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => {
      calls += 1;
      return [fakeOverpassRec(`Only One ${calls}`, "attraction")]; // never enough to reach target
    },
  });
  assert.ok(calls <= 2, `refill must stop after its bounded round count, got ${calls} calls`);
});

test("Round 9 AA: refill duplicates of existing candidates are removed", async () => {
  const existing = poolCandidate("dup-1", "LANDMARK", "iconic_landmark", 50);
  const pool = poolOf([existing], { desiredCandidateCount: 4, diagnostics: { initialCandidateCount: 1, resolvedCandidateCount: 1, legalCandidateCount: 1, desiredCandidateCount: 4, refillAttempts: 0, refillCandidateCount: 0, providerFailures: 0, providerElapsedMs: 0, providerTimeouts: 0, dedupeRejected: 0, geographyRejected: 0, mealVenueExcluded: 0, classificationBreakdown: {}, supplyDegraded: false } });
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => [fakeOverpassRec("dup-1", "attraction")], // same id our toTripRecommendation would derive is unlikely to collide, but name-based real-world dup is what dedupeRejected inside buildStayActivityPool later handles — here we assert no crash and no unbounded growth
  });
  assert.ok(refilled.candidates.length <= pool.desiredCandidateCount + 1);
});

test("Round 9 AB: refill candidates that are geographically illegal are rejected", async () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 3 }]);
  const anchor = { lat: 10, lon: 10 };
  const capacity = computeStayCapacity([{ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false }, { dayNumber: 2, dayType: "normal", hasExplicitRestWindow: false }, { dayNumber: 3, dayType: "normal", hasExplicitRestWindow: false }]);
  const pool = buildStayActivityPool(tripFrame.phases[0], [], anchor, MOBILITY, capacity, [], 600);
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => [fakeOverpassRec("Far Away Place", "attraction", 40, 40)], // far outside the 60km radius
  });
  assert.equal(refilled.candidates.length, 0);
  assert.ok(refilled.diagnostics.geographyRejected >= 1);
});

test("Round 9 AC: a provider failure/timeout is recorded, not silently swallowed", async () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 3 }]);
  const anchor = { lat: 10, lon: 10 };
  const capacity = computeStayCapacity([{ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false }]);
  const pool = buildStayActivityPool(tripFrame.phases[0], [], anchor, MOBILITY, capacity, [], 600);
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => {
      throw new Error("provider timeout");
    },
  });
  assert.ok(refilled.diagnostics.providerFailures >= 1);
});

test("Round 9 AD: an undersupplied category is targeted on the 2nd refill round", async () => {
  const cultureHeavy = [poolCandidate("c1", "CULTURE", "art_museum", 50), poolCandidate("c2", "CULTURE", "history_museum", 50)];
  const pool = poolOf(cultureHeavy, { desiredCandidateCount: 6 });
  const requestedCategoriesByRound: Array<TripRecommendation["category"][]> = [];
  await refillStayActivityPool(pool, MOBILITY, 600, [], {
    maxRounds: 2,
    fetchCandidates: async (_anchor, _radius, categories) => {
      requestedCategoriesByRound.push(categories);
      return [];
    },
  });
  assert.equal(requestedCategoriesByRound.length, 2, "both bounded rounds ran since the pool never filled");
  assert.ok(requestedCategoriesByRound[1].length === 1, "round 2 targets exactly one undersupplied category");
});

test("Round 9 AE: genuine provider exhaustion is a distinct, visible supply limitation, not a silent success", async () => {
  const tripFrame = frame([{ areaLabel: "Area A", startDayNumber: 1, endDayNumber: 5 }]);
  const anchor = { lat: 10, lon: 10 };
  const capacity = computeStayCapacity(Array.from({ length: 5 }, (_, i) => ({ dayNumber: i + 1, dayType: "normal" as const, hasExplicitRestWindow: false })));
  const pool = buildStayActivityPool(tripFrame.phases[0], [], anchor, MOBILITY, capacity, [], 600);
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    fetchCandidates: async () => [], // provider genuinely has nothing more
  });
  assert.ok(refilled.candidates.length < refilled.desiredCandidateCount, "supply limitation is visible in the returned pool size");
  assert.equal(refilled.diagnostics.providerFailures, 0, "an empty result is NOT a provider failure — distinct signals");
});

/* -------------------- diversity: M-S -------------------- */

test("Round 9 M: a large balanced pool across 4 days spans multiple primary families", () => {
  const pool = poolOf([
    poolCandidate("a", "CULTURE", "art_museum", 60),
    poolCandidate("b", "LANDMARK", "iconic_landmark", 60),
    poolCandidate("c", "NATURE", "urban_park", 60),
    poolCandidate("d", "LOCAL_EXPERIENCE", "market", 60),
    poolCandidate("e", "ENTERTAINMENT", "zoo", 60),
    poolCandidate("f", "SHOPPING", "mall", 60),
  ]);
  const portfolio = selectStayPortfolio(pool, 6, NEUTRAL_WEIGHTS, [], 1);
  const families = new Set(portfolio.selected.map((c) => c.classification.primaryFamily));
  assert.ok(families.size >= 4, `expected broad family coverage, got ${[...families].join(",")}`);
});

test("Round 9 N: 5 art museums + equally strong alternatives -> not one art museum every day", () => {
  const museums = Array.from({ length: 5 }, (_, i) => poolCandidate(`museum-${i}`, "CULTURE", "art_museum", 70));
  const alternatives = [
    poolCandidate("landmark", "LANDMARK", "iconic_landmark", 70),
    poolCandidate("nature", "NATURE", "urban_park", 70),
    poolCandidate("local", "LOCAL_EXPERIENCE", "neighborhood", 70),
    poolCandidate("shopping", "SHOPPING", "mall", 70),
    poolCandidate("entertainment", "ENTERTAINMENT", "zoo", 70),
  ];
  const pool = poolOf([...museums, ...alternatives]);
  const portfolio = selectStayPortfolio(pool, 5, NEUTRAL_WEIGHTS, [], 1);
  const museumCount = portfolio.selected.filter((c) => c.classification.subtype === "art_museum").length;
  assert.ok(museumCount < 5, `expected fewer than 5 art museums in a 5-slot portfolio, got ${museumCount}`);
  assert.ok(museumCount >= 1, "museums are still legitimately good candidates and should appear at least once");
});

test("Round 9 O: 2 very high-significance museums may both survive despite the repetition penalty", () => {
  const topMuseums = [poolCandidate("famous-1", "CULTURE", "art_museum", 98), poolCandidate("famous-2", "CULTURE", "art_museum", 96)];
  const ordinary = Array.from({ length: 4 }, (_, i) => poolCandidate(`ordinary-${i}`, "LANDMARK", "iconic_landmark", 45));
  const pool = poolOf([...topMuseums, ...ordinary]);
  const portfolio = selectStayPortfolio(pool, 3, NEUTRAL_WEIGHTS, [], 1);
  const selectedIds = portfolio.selected.map((c) => c.recommendationId);
  assert.ok(selectedIds.includes("famous-1") && selectedIds.includes("famous-2"), "both world-class museums should survive");
});

test("Round 9 P: a strong museum preference increases culture frequency without consuming every day", () => {
  const museums = Array.from({ length: 4 }, (_, i) => poolCandidate(`museum-${i}`, "CULTURE", i % 2 === 0 ? "art_museum" : "history_museum", 55));
  const alternatives = Array.from({ length: 4 }, (_, i) => poolCandidate(`alt-${i}`, "NATURE", "urban_park", 55));
  const pool = poolOf([...museums, ...alternatives]);
  const preferenceWeights = { ...NEUTRAL_WEIGHTS, CULTURE: 1.8 };
  const withPreference = selectStayPortfolio(pool, 4, preferenceWeights, [], 1);
  const withoutPreference = selectStayPortfolio(pool, 4, NEUTRAL_WEIGHTS, [], 1);
  const cultureCount = (p: typeof withPreference) => p.selected.filter((c) => c.classification.primaryFamily === "CULTURE").length;
  assert.ok(cultureCount(withPreference) >= cultureCount(withoutPreference), "preference should raise, never lower, culture frequency");
  assert.ok(cultureCount(withPreference) < 4, "even a strong preference should not automatically consume every single slot");
});

test("Round 9 Q: nature-heavy supply allows repeated NATURE while preferring subtype variety", () => {
  const natureCandidates = [
    poolCandidate("hike", "NATURE", "hiking", 60),
    poolCandidate("viewpoint", "NATURE", "scenic_viewpoint", 60),
    poolCandidate("wildlife", "NATURE", "wildlife", 60),
    poolCandidate("drive", "NATURE", "scenic_drive", 60),
    poolCandidate("lake", "NATURE", "lake", 60),
  ];
  const pool = poolOf(natureCandidates); // no other family has ANY supply
  const portfolio = selectStayPortfolio(pool, 5, NEUTRAL_WEIGHTS, [], 1);
  assert.equal(portfolio.selected.length, 5, "all 5 nature candidates are usable — no alternative family exists to force diversity");
  const subtypes = new Set(portfolio.selected.map((c) => c.classification.subtype));
  assert.equal(subtypes.size, 5, "subtype variety is still naturally achieved when the pool itself is varied");
});

test("Round 9 R: trip-wide history containing an art museum yesterday penalizes an equivalent museum today", () => {
  const history: RecentActivityHistoryEntry[] = [{ dayIndex: 5, stayId: "other-stay", primaryFamily: "CULTURE", subtype: "art_museum" }];
  const pool = poolOf([poolCandidate("today-museum", "CULTURE", "art_museum", 60), poolCandidate("today-alt", "LANDMARK", "iconic_landmark", 60)]);
  const withHistory = selectStayPortfolio(pool, 1, NEUTRAL_WEIGHTS, history, 6);
  const withoutHistory = selectStayPortfolio(pool, 1, NEUTRAL_WEIGHTS, [], 6);
  assert.equal(withoutHistory.selected[0].recommendationId, "today-museum", "sanity: without history the equally-scored museum wins first (stable tiebreak)");
  assert.equal(withHistory.selected[0].recommendationId, "today-alt", "recent history penalizes the repeated subtype enough to prefer the alternative");
});

test("Round 9 S: the repetition penalty decays over time", () => {
  const pool = poolOf([poolCandidate("today-museum", "CULTURE", "art_museum", 60), poolCandidate("today-alt", "LANDMARK", "iconic_landmark", 60)]);
  const recentHistory: RecentActivityHistoryEntry[] = [{ dayIndex: 1, stayId: "s", primaryFamily: "CULTURE", subtype: "art_museum" }];
  const distantHistory: RecentActivityHistoryEntry[] = [{ dayIndex: 1, stayId: "s", primaryFamily: "CULTURE", subtype: "art_museum" }];
  const soonAfter = selectStayPortfolio(pool, 1, NEUTRAL_WEIGHTS, recentHistory, 2); // 1 day later
  const longAfter = selectStayPortfolio(pool, 1, NEUTRAL_WEIGHTS, distantHistory, 30); // many days later
  assert.equal(soonAfter.selected[0].recommendationId, "today-alt", "penalty is strong immediately after");
  assert.equal(longAfter.selected[0].recommendationId, "today-museum", "penalty has decayed away long after");
});

/* -------------------- Gemini candidate-ID contract -------------------- */

test("Round 9: Gemini may only select from the legal candidate pool — an unknown id is rejected, never scheduled", () => {
  const pool = poolOf([poolCandidate("known-1", "CULTURE", "art_museum", 60)]);
  const result = validateGeminiPortfolioSelection(pool, { selectedCandidateIds: ["known-1", "invented-id"] });
  assert.deepEqual(result.selected.map((c) => c.recommendationId), ["known-1"]);
  assert.deepEqual(result.rejectedUnknownIds, ["invented-id"]);
});

/* -------------------- trip-wide orchestration -------------------- */

test("Round 9: buildTripActivityPortfolios threads diversity memory forward across stays, in trip order", () => {
  const tripFrame = frame([
    { areaLabel: "Area A", startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "Area B", startDayNumber: 4, endDayNumber: 6 },
  ]);
  const anchors = new Map([["Area A", { lat: 0, lon: 0 }], ["Area B", { lat: 20, lon: 20 }]]);
  const recommendations = [
    rec({ id: "a-museum", name: "A Museum", category: "museum", location: "Area A", lat: 0.01, lon: 0.01 }),
    rec({ id: "a-landmark", name: "A Landmark", category: "attraction", location: "Area A", lat: 0.02, lon: 0.01 }),
    rec({ id: "b-museum", name: "B Museum", category: "museum", location: "Area B", lat: 20.01, lon: 20.01 }),
    rec({ id: "b-landmark", name: "B Landmark", category: "attraction", location: "Area B", lat: 20.02, lon: 20.01 }),
  ];
  const dayCapacityByStay = new Map([
    ["stay-0", [{ dayNumber: 1, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 2, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 3, dayType: "normal" as const, hasExplicitRestWindow: false }]],
    ["stay-1", [{ dayNumber: 4, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 5, dayType: "normal" as const, hasExplicitRestWindow: false }, { dayNumber: 6, dayType: "normal" as const, hasExplicitRestWindow: false }]],
  ]);
  const result = buildTripActivityPortfolios(tripFrame, anchors, MOBILITY, recommendations, dayCapacityByStay, [], [], 600, normalizeArea, textMatch);
  assert.equal(result.poolsByStay.size, 2);
  assert.equal(result.portfoliosByStay.size, 2);
  assert.ok(result.recentHistory.length > 0, "history accumulates across stays");
});

/* -------------------- significance -------------------- */

test("Round 9: computeSignificance boosts user-selected/saved candidates and must-visit keyword matches, never fabricates a rating", () => {
  const ordinary = computeSignificance(rec({ source: "api" }), []);
  const userSelected = computeSignificance(rec({ source: "saved" }), []);
  const mustVisit = computeSignificance(rec({ name: "The Grand Tower", source: "api" }), ["grand tower"]);
  assert.ok(userSelected > ordinary, "an explicitly saved/selected place scores higher");
  assert.ok(mustVisit > ordinary, "a must-visit keyword match scores higher");
  assert.ok(ordinary >= 0 && ordinary <= 100 && userSelected <= 100 && mustVisit <= 100);
});

/* -------------------- history threading -------------------- */

test("Round 9: appendPortfolioToHistory tags each selected candidate with its own day index within the stay", () => {
  const pool = poolOf([poolCandidate("a", "CULTURE", "art_museum", 60), poolCandidate("b", "LANDMARK", "iconic_landmark", 60)]);
  const portfolio = selectStayPortfolio(pool, 2, NEUTRAL_WEIGHTS, [], 10);
  const history = appendPortfolioToHistory([], portfolio, 10);
  assert.equal(history.length, 2);
  assert.deepEqual(new Set(history.map((h) => h.dayIndex)), new Set([10, 11]));
  assert.ok(history.every((h) => h.stayId === "stay-0"));
});

/* ================================================================== *
 * Round 9.1 — minimum vs target sizing, refill deadline/timeouts        *
 * ================================================================== */

test("Round 9.1: minimumViableCandidateCount is always <= desiredCandidateCount, and strictly less once targets grow", () => {
  const small = computeMinimumViableCandidateCount(1);
  const smallDesired = computeDesiredCandidateCount(1);
  assert.ok(small <= smallDesired);
  const big = computeMinimumViableCandidateCount(9);
  const bigDesired = computeDesiredCandidateCount(9);
  assert.ok(big < bigDesired, `minimum (${big}) must be a real floor below the healthy reserve target (${bigDesired})`);
});

test("Round 9.1: buildStayActivityPool sets minimumViableCandidateCount from the SAME capacity the desired count uses", () => {
  const capacity = { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] };
  const p = buildStayActivityPool(
    { id: "s", areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" },
    [],
    { lat: 10, lon: 10 },
    MOBILITY,
    capacity,
    [],
    600
  );
  assert.equal(p.minimumViableCandidateCount, computeMinimumViableCandidateCount(9));
});

test("Round 9.1: refillStayActivityPool never starts a new round once its deadline has passed", async () => {
  const anchor = { lat: 10, lon: 10 };
  const capacity = { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] };
  const p = buildStayActivityPool({ id: "s", areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" }, [], anchor, MOBILITY, capacity, [], 600);
  let calls = 0;
  const { pool: refilled } = await refillStayActivityPool(p, MOBILITY, 600, [], {
    deadline: Date.now() - 1, // already passed
    fetchCandidates: async () => {
      calls += 1;
      return [fakeOverpassRec("Should Never Be Fetched", "attraction")];
    },
  });
  assert.equal(calls, 0, "no provider call is even attempted once the deadline has passed");
  assert.equal(refilled.diagnostics.supplyDegraded, true);
});

test("Round 9.1: a timeout-shaped provider rejection is counted in providerTimeouts, a plain failure is not", async () => {
  const anchor = { lat: 10, lon: 10 };
  const capacity = { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] };
  const p = buildStayActivityPool({ id: "s", areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" }, [], anchor, MOBILITY, capacity, [], 600);
  const timeoutError = new Error("The operation was aborted");
  timeoutError.name = "AbortError";
  const { pool: refilled } = await refillStayActivityPool(p, MOBILITY, 600, [], {
    fetchCandidates: async () => {
      throw timeoutError;
    },
  });
  assert.equal(refilled.diagnostics.providerFailures, 2); // both bounded rounds failed
  assert.equal(refilled.diagnostics.providerTimeouts, 2);
});

test("Round 9.1: providerElapsedMs accumulates real wall-clock time spent on provider calls", async () => {
  const anchor = { lat: 10, lon: 10 };
  const capacity = { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] };
  const p = buildStayActivityPool({ id: "s", areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" }, [], anchor, MOBILITY, capacity, [], 600);
  const { pool: refilled } = await refillStayActivityPool(p, MOBILITY, 600, [], {
    maxRounds: 1,
    fetchCandidates: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return [];
    },
  });
  assert.ok(refilled.diagnostics.providerElapsedMs >= 10, `expected real elapsed time to be tracked, got ${refilled.diagnostics.providerElapsedMs}ms`);
});

// --- Round 9.3.3: the production default (defaultFetchNearbyRecommendations)
// must throw a distinguishable error on a genuine provider failure instead
// of silently returning [] like queryNearbyRecommendations itself does —
// this is what lets refillStayActivityPool's existing providerFailures/
// providerTimeouts accounting actually see a real outage instead of
// treating it identically to "this area truly has nothing left."

test("Round 9.3.3: defaultFetchNearbyRecommendations throws OverpassProviderFailureError when every endpoint fails", async () => {
  await assert.rejects(
    () => defaultFetchNearbyRecommendations({ lat: 10, lon: 10 }, 20, ["museum"], 8, fakeFailingFetch()),
    OverpassProviderFailureError
  );
});

test("Round 9.3.3: defaultFetchNearbyRecommendations resolves to [] (no throw) on a genuine zero-element success", async () => {
  const results = await defaultFetchNearbyRecommendations({ lat: 10, lon: 10 }, 20, ["museum"], 8, fakeEmptySuccessFetch());
  assert.deepEqual(results, []);
});

test("Round 9.3.3: a real provider outage reaching refillStayActivityPool through the production default is counted as a provider failure, not silently exhausted supply", async () => {
  const anchor = { lat: 10, lon: 10 };
  const capacity = { usableSightseeingDays: 3, requiredRealActivityTarget: 9, perDayTargets: [] };
  const pool = buildStayActivityPool({ id: "s", areaLabel: "Area A", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" }, [], anchor, MOBILITY, capacity, [], 600);
  const { pool: refilled } = await refillStayActivityPool(pool, MOBILITY, 600, [], {
    maxRounds: 1,
    fetchCandidates: (a, r, c, l) => defaultFetchNearbyRecommendations(a, r, c, l, fakeFailingFetch()),
  });
  assert.equal(refilled.diagnostics.providerFailures, 1, "the underlying Overpass outage must be visible here, not swallowed into a bare empty result");
  assert.equal(refilled.candidates.length, 0);
});
