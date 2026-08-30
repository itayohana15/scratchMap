import assert from "node:assert/strict";
import test from "node:test";

import { collectPlanDiagnostics, buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import type { TripFrame } from "../src/lib/server/itinerary-generation-constraints";
import {
  buildStayTransitions,
  buildTripFramePhases,
  classifyItemEnergy,
  classifyWeatherSensitivity,
  expectedBaseCountRange,
  getTripLengthBucket,
  MAX_STAY_STRUCTURE_REPAIR_PASSES,
  repairImpossibleStayTransition,
  reorderAreasForDepartureFeasibility,
  resolveItemEffectiveEndTime,
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
    endTime: overrides.endTime,
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
    travelMinutes: overrides.travelMinutes ?? 15,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    lastEntryTime: overrides.lastEntryTime ?? "",
    canonicalPlaceId: overrides.canonicalPlaceId ?? "",
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
    theme: overrides.theme ?? "",
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

test("classifyWeatherSensitivity tags nature/hike/beach stops as outdoor", () => {
  assert.equal(
    classifyWeatherSensitivity({ category: "nature", name: "Mtatsminda Park", shortDescription: "פארק על הר עם נוף" }),
    "outdoor"
  );
  assert.equal(
    classifyWeatherSensitivity({ category: "attraction", name: "Sunset Viewpoint Hike", shortDescription: "" }),
    "outdoor"
  );
});

test("classifyWeatherSensitivity tags museum/shopping stops as indoor", () => {
  assert.equal(
    classifyWeatherSensitivity({ category: "museum", name: "City Museum", shortDescription: "" }),
    "indoor"
  );
  assert.equal(
    classifyWeatherSensitivity({ category: "shopping", name: "Central Mall", shortDescription: "" }),
    "indoor"
  );
});

test("classifyWeatherSensitivity defaults to mixed when neither signal is clear", () => {
  assert.equal(
    classifyWeatherSensitivity({ category: "attraction", name: "Old Town Square", shortDescription: "" }),
    "mixed"
  );
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

// Section A2: resolveItemEffectiveEndTime — the single canonical source of
// "when does this item really finish" shared by every arrival/departure
// feasibility check.
test("resolveItemEffectiveEndTime prefers a real, already-scheduled endTime", () => {
  const item = buildItem({ plannedStartTime: "10:18", endTime: "15:18" });
  assert.equal(resolveItemEffectiveEndTime(item), "15:18");
});

test("resolveItemEffectiveEndTime derives an end time from the canonical duration when no endTime exists yet", () => {
  const item = buildItem({ category: "attraction", plannedStartTime: "09:00", estimatedDurationMinutes: 90 });
  assert.equal(resolveItemEffectiveEndTime(item), "10:30");
});

test("resolveItemEffectiveEndTime uses the item's own duration for a practical filler, never the generic attraction scale", () => {
  const item = buildItem({ category: "practical", plannedStartTime: "12:00", estimatedDurationMinutes: 5 });
  assert.equal(resolveItemEffectiveEndTime(item), "12:05");
});

test("resolveItemEffectiveEndTime ignores a nonsensical endTime that isn't after the start", () => {
  const item = buildItem({ category: "attraction", plannedStartTime: "10:00", endTime: "09:00", estimatedDurationMinutes: 60 });
  assert.equal(resolveItemEffectiveEndTime(item), "11:00");
});

// Section B: reorderAreasForDepartureFeasibility — City A/City B/City C are
// invented area labels; only CDG's real coordinates make the underlying
// distance/time math meaningful.
const CITY_A_NEAR_AIRPORT = { lat: 48.86, lon: 2.35 }; // ~20km from CDG
const CITY_B_MID_DISTANCE = { lat: 45.75, lon: 4.85 }; // a few hundred km from CDG
const CITY_C_EXTREME_DISTANCE = { lat: 10, lon: 10 }; // thousands of km from CDG

test("reorderAreasForDepartureFeasibility leaves the order unchanged when the natural last area is already feasible", () => {
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_A_NEAR_AIRPORT],
  ]);
  const result = reorderAreasForDepartureFeasibility(["City B", "City A"], anchors, "CDG", "20:00");
  assert.deepEqual(result, ["City B", "City A"]);
});

test("reorderAreasForDepartureFeasibility promotes a feasible area to last when the natural last choice is infeasible (early flight)", () => {
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_B_MID_DISTANCE],
  ]);
  // An early flight makes City B (mid-distance) infeasible as the final base.
  const result = reorderAreasForDepartureFeasibility(["City A", "City B"], anchors, "CDG", "07:00");
  assert.deepEqual(result, ["City B", "City A"], "City A (feasible) should become the final base instead of City B");
});

test("reorderAreasForDepartureFeasibility keeps the same order for a late flight, since the mid-distance base is genuinely feasible then", () => {
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_B_MID_DISTANCE],
  ]);
  const result = reorderAreasForDepartureFeasibility(["City A", "City B"], anchors, "CDG", "20:00");
  assert.deepEqual(result, ["City A", "City B"]);
});

test("reorderAreasForDepartureFeasibility leaves order unchanged when no known area is feasible as a final base", () => {
  const anchors = new Map([
    ["City A", CITY_C_EXTREME_DISTANCE],
    ["City B", CITY_C_EXTREME_DISTANCE],
  ]);
  const result = reorderAreasForDepartureFeasibility(["City A", "City B"], anchors, "CDG", "20:00");
  assert.deepEqual(result, ["City A", "City B"], "no feasible alternative exists — the hard validation gate must catch this instead");
});

test("reorderAreasForDepartureFeasibility never blocks on an area with unknown coordinates", () => {
  const anchors = new Map([["City A", null], ["City B", null]]);
  const result = reorderAreasForDepartureFeasibility(["City A", "City B"], anchors, "CDG", "07:00");
  assert.deepEqual(result, ["City A", "City B"]);
});

test("reorderAreasForDepartureFeasibility does nothing when there is no return flight data", () => {
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_C_EXTREME_DISTANCE],
  ]);
  assert.deepEqual(reorderAreasForDepartureFeasibility(["City A", "City B"], anchors, null, null), ["City A", "City B"]);
});

// Section C1/C2: buildStayTransitions — one real, computed transition per
// TripFrame phase boundary, never overnight teleportation.
function buildFrame(phases: Array<{ areaLabel: string; nights: number; startDayNumber: number; endDayNumber: number }>): TripFrame {
  return {
    bucketId: "multi_phase",
    source: "deterministic",
    phases: phases.map((phase, index) => ({ id: `phase-${index + 1}`, intent: "mixed", ...phase })),
  };
}

test("buildStayTransitions creates one transition per phase boundary with the right day and both bases", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
    { areaLabel: "City C", nights: 3, startDayNumber: 8, endDayNumber: 10 },
  ]);
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_B_MID_DISTANCE],
    ["City C", CITY_C_EXTREME_DISTANCE],
  ]);

  const transitions = buildStayTransitions(frame, anchors);

  assert.equal(transitions.length, 2);
  assert.equal(transitions[0].fromBase, "City A");
  assert.equal(transitions[0].toBase, "City B");
  assert.equal(transitions[0].dayNumber, 4, "a transition happens on the NEW phase's first day");
  assert.equal(transitions[1].fromBase, "City B");
  assert.equal(transitions[1].toBase, "City C");
  assert.equal(transitions[1].dayNumber, 8);
});

test("buildStayTransitions estimates real, positive travel minutes from real coordinates, never a fabricated zero", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
  ]);
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City B", CITY_B_MID_DISTANCE],
  ]);

  const [transition] = buildStayTransitions(frame, anchors);
  assert.ok(transition.estimatedTravelMinutes != null && transition.estimatedTravelMinutes > 0);
  assert.notEqual(transition.transportMode, undefined);
});

test("buildStayTransitions returns an empty list for a single-base trip", () => {
  const frame = buildFrame([{ areaLabel: "City A", nights: 5, startDayNumber: 1, endDayNumber: 5 }]);
  assert.deepEqual(buildStayTransitions(frame, new Map()), []);
});

// Section A — repairImpossibleStayTransition: generic structural repair,
// tried in the spec's own order (boundary shift -> base reselection ->
// merge), respecting protected content throughout.

test("repairImpossibleStayTransition shifts the phase boundary earlier when the FROM phase has a spare night", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
  ]);
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: [],
    protectedDayNumbers: new Set(),
    isTransitionFeasible: () => false,
  });
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "shift_boundary_earlier");
  assert.equal(result.frame.phases[0].nights, 2);
  assert.equal(result.frame.phases[0].endDayNumber, 2);
  assert.equal(result.frame.phases[1].nights, 5);
  assert.equal(result.frame.phases[1].startDayNumber, 3);
});

test("repairImpossibleStayTransition keeps phase night counts internally consistent (nights match startDayNumber/endDayNumber) after a shift", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
  ]);
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: [],
    protectedDayNumbers: new Set(),
    isTransitionFeasible: () => false,
  });
  for (const phase of result.frame.phases) {
    assert.equal(phase.endDayNumber - phase.startDayNumber + 1, phase.nights);
  }
});

test("repairImpossibleStayTransition reselects the base when boundary shifts aren't available but a feasible alternative area exists", () => {
  // Both phases have exactly 1 night each — no spare night to shift.
  const frame = buildFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: ["City C"],
    protectedDayNumbers: new Set(),
    isTransitionFeasible: (_from, to) => to === "City C",
  });
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "reselect_base");
  assert.equal(result.frame.phases[1].areaLabel, "City C");
});

test("repairImpossibleStayTransition merges a genuinely short (1-night) stay into its neighbor as a last resort", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 1, startDayNumber: 4, endDayNumber: 4 },
    { areaLabel: "City C", nights: 3, startDayNumber: 5, endDayNumber: 7 },
  ]);
  // shift_boundary_earlier would otherwise fire (City A has a spare
  // night) — protect day 3 (that shift's boundary day, part of City A's
  // OWN range, not City B's) to force it past both shifts (City B only
  // has 1 night, so shift_boundary_later is already unavailable on its
  // own) and past reselection (no candidate areas), down to the merge path.
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: [],
    protectedDayNumbers: new Set([3]),
    isTransitionFeasible: () => false,
  });
  assert.equal(result.changed, true);
  assert.equal(result.strategy, "merge_short_stay");
  assert.equal(result.frame.phases.length, 2);
  // City B's one night is folded into an adjacent phase — total night
  // count across the frame is preserved.
  const totalNights = result.frame.phases.reduce((sum, phase) => sum + phase.nights, 0);
  assert.equal(totalNights, 7);
});

test("repairImpossibleStayTransition never merges/shifts a legitimate one-night stay that isn't the one actually involved in this impossible transition", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 5, startDayNumber: 2, endDayNumber: 6 },
    { areaLabel: "City C", nights: 1, startDayNumber: 7, endDayNumber: 7 },
  ]);
  // The impossible transition is between City B and City C (phaseIndex 2)
  // — City A (phaseIndex 0, also 1 night) must never be touched by this call.
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 2,
    candidateAreas: [],
    protectedDayNumbers: new Set(),
    isTransitionFeasible: () => false,
  });
  assert.equal(result.changed, true);
  const cityAPhase = result.frame.phases.find((phase) => phase.areaLabel === "City A");
  assert.ok(cityAPhase, "City A's legitimate one-night stay must survive untouched");
  assert.equal(cityAPhase?.nights, 1);
});

test("repairImpossibleStayTransition never shifts a boundary through a day with protected (locked/fixedTime) content", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
  ]);
  // Day 3 (the earlier-shift candidate) AND day 4 (the later-shift
  // candidate) are both protected — no shift may touch either.
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: [],
    protectedDayNumbers: new Set([3, 4]),
    isTransitionFeasible: () => false,
  });
  assert.notEqual(result.strategy, "shift_boundary_earlier");
  assert.notEqual(result.strategy, "shift_boundary_later");
});

test("repairImpossibleStayTransition returns changed:false when every generic strategy is blocked by protected content", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: [],
    protectedDayNumbers: new Set([1, 2]),
    isTransitionFeasible: () => false,
  });
  assert.equal(result.changed, false);
  assert.equal(result.strategy, null);
  assert.equal(result.frame, frame, "an unrepaired frame must be returned as-is, never a mutated copy");
});

test("repairImpossibleStayTransition's structural change is fully reflected when transitions are rebuilt afterward", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 1, startDayNumber: 1, endDayNumber: 1 },
    { areaLabel: "City B", nights: 1, startDayNumber: 2, endDayNumber: 2 },
  ]);
  const anchors = new Map([
    ["City A", CITY_A_NEAR_AIRPORT],
    ["City C", CITY_B_MID_DISTANCE],
  ]);
  const result = repairImpossibleStayTransition({
    frame,
    phaseIndex: 1,
    candidateAreas: ["City C"],
    protectedDayNumbers: new Set(),
    isTransitionFeasible: (_from, to) => to === "City C",
  });
  const rebuiltTransitions = buildStayTransitions(result.frame, anchors);
  assert.equal(rebuiltTransitions.length, 1);
  assert.equal(rebuiltTransitions[0].toBase, "City C");
});

test("MAX_STAY_STRUCTURE_REPAIR_PASSES is a small, real bound", () => {
  assert.ok(MAX_STAY_STRUCTURE_REPAIR_PASSES >= 1 && MAX_STAY_STRUCTURE_REPAIR_PASSES <= 5);
});

test("buildStayTransitions never fabricates travel minutes when a base's real coordinates are unknown", () => {
  const frame = buildFrame([
    { areaLabel: "City A", nights: 3, startDayNumber: 1, endDayNumber: 3 },
    { areaLabel: "City B", nights: 4, startDayNumber: 4, endDayNumber: 7 },
  ]);
  const anchors = new Map([["City A", CITY_A_NEAR_AIRPORT], ["City B", null]]);

  const [transition] = buildStayTransitions(frame, anchors);
  assert.equal(transition.estimatedTravelMinutes, null);
});
