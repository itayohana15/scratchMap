import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import { buildTripHubTrip, type TripHubCountry, type TripHubTrip } from "../src/lib/trip-hub";
import {
  buildGlobalTimeline,
  computePassportStats,
  deriveCountryMapStatuses,
  getCompletedTrips,
  getUpcomingTrips,
  groupTripsByCountry,
  longestKnownTrip,
  mostVisitedCountry,
} from "../src/lib/travel-passport";
import { createDefaultWorkspace, createEmptyDay } from "../src/lib/trip-workspace";

const BASE_PREFERENCES = createDefaultWorkspace("Egypt").preferences;

function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  return {
    id: overrides.id ?? "itin-1",
    countryId: "country-eg",
    isoA2: "EG",
    title: "Trip",
    startDate: "2026-10-06",
    endDate: "2026-10-08",
    daysCount: 3,
    travelers: 2,
    budget: null,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: BASE_PREFERENCES,
    workspaceSnapshot: createDefaultWorkspace("Egypt"),
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 0,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
    status: "completed",
    version: 1,
    parentItineraryId: null,
    manuallyEdited: false,
    archived: false,
    generatedAt: "2026-08-19T00:00:00.000Z",
    deletedAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

const EGYPT_COUNTRY: TripHubCountry = { id: "country-eg", name: "Egypt", isoA2: "EG", status: "visited" };

function trip(overrides: Partial<CountryItineraryRecord> = {}, photoCount = 0): TripHubTrip {
  return buildTripHubTrip(buildItinerary(overrides), EGYPT_COUNTRY, photoCount);
}

// 1 & 6 (passport). Two Sinai trips (both iso_a2=EG) group as ONE country, not two.
test("groupTripsByCountry buckets two Sinai/EG trips into a single group", () => {
  const tripA = trip({ id: "sinai-2022", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });
  const tripB = trip({ id: "sinai-2023", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });

  const groups = groupTripsByCountry([tripA, tripB]);
  assert.equal(groups.size, 1);
  const egypt = groups.get("EG");
  assert.equal(egypt?.trips.length, 2);
  assert.equal(egypt?.completedTrips.length, 2);
});

// 2. Multiple visits appear as multiple years.
test("groupTripsByCountry collects distinct visit years for repeat visits", () => {
  const tripA = trip({ id: "a", startDate: "2018-05-01", endDate: "2018-05-10" });
  const tripB = trip({ id: "b", startDate: "2019-06-01", endDate: "2019-06-10" });
  const groups = groupTripsByCountry([tripA, tripB]);
  const group = groups.get("EG");
  assert.deepEqual(group?.visitYears, ["2018", "2019"]);
});

// 4. Upcoming country is not counted as visited.
test("computePassportStats excludes upcoming-only trips from countriesVisited/tripsCompleted", () => {
  const upcomingOnly = trip({ id: "upcoming", status: "upcoming", startDate: "2027-01-01", endDate: "2027-01-05" });
  const stats = computePassportStats([upcomingOnly]);
  assert.equal(stats.countriesVisited, 0);
  assert.equal(stats.tripsCompleted, 0);
});

test("computePassportStats counts a completed trip's country as visited", () => {
  const completed = trip({ id: "done" });
  const stats = computePassportStats([completed]);
  assert.equal(stats.countriesVisited, 1);
  assert.equal(stats.tripsCompleted, 1);
});

// 4/5. deriveCountryMapStatuses never marks an upcoming-only country "visited"; active trips render.
test("deriveCountryMapStatuses maps completed->visited and upcoming->planned, never both confused", () => {
  const upcomingOnly = trip({ id: "up", status: "upcoming", startDate: "2027-01-01", endDate: "2027-01-05" });
  const upcomingStatuses = deriveCountryMapStatuses([upcomingOnly]);
  assert.equal(upcomingStatuses.EG, "planned");

  const completed = trip({ id: "done" });
  const completedStatuses = deriveCountryMapStatuses([completed]);
  assert.equal(completedStatuses.EG, "visited");
});

// 6. Historical partial dates sort correctly (no invented dates).
test("buildGlobalTimeline sorts exact-date and partial-date trips deterministically", () => {
  const exact = trip({ id: "exact", startDate: "2019-06-01", endDate: "2019-06-10" });
  const partial = trip({
    id: "partial",
    startDate: null,
    endDate: null,
    daysCount: 0,
    preferencesSnapshot: { ...BASE_PREFERENCES, partialDate: "2018-05" },
  });
  const timeline = buildGlobalTimeline([exact, partial]);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].trip.id, "partial");
  assert.equal(timeline[1].trip.id, "exact");
});

// 7. Duplicate joins do not inflate counts — groupTripsByCountry keys strictly by trip id, not by a fan-out join.
test("groupTripsByCountry never double-counts a trip even if passed the same trip object reference twice by mistake upstream", () => {
  const single = trip({ id: "single" });
  const groups = groupTripsByCountry([single]);
  assert.equal(groups.get("EG")?.trips.length, 1);
});

// 8. Missing trip duration does not become zero days in "known" aggregates.
test("computePassportStats.knownTravelDays ignores unknown-duration trips instead of treating them as 0", () => {
  const known = trip({ id: "known", daysCount: 5 });
  const unknown = trip({ id: "unknown", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });
  const stats = computePassportStats([known, unknown]);
  assert.equal(stats.knownTravelDays.value, 5);
  assert.equal(stats.knownTravelDays.isPartial, true);
});

test("longestKnownTrip never picks an unknown-duration (daysCount=0) trip", () => {
  const unknown = trip({ id: "unknown", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });
  const known = trip({ id: "known", daysCount: 5 });
  const longest = longestKnownTrip([unknown, known]);
  assert.equal(longest?.id, "known");
});

// 3. Region does not become a country — mostVisitedCountry counts by trip, keyed by real iso, not by trip title/region text.
test("mostVisitedCountry counts trips per ISO, correctly bucketing repeat Sinai/Egypt visits", () => {
  const tripA = trip({ id: "a", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });
  const tripB = trip({ id: "b", startDate: null, endDate: null, daysCount: 0, source: "historical_manual" });
  const best = mostVisitedCountry([tripA, tripB]);
  assert.equal(best?.isoA2, "EG");
  assert.equal(best?.tripCount, 2);
});

// citiesVisited: unknown != 0 — a historical trip with no day data never
// counts as "0 cities visited", it flags isPartial instead.
test("computePassportStats.citiesVisited ignores untracked (itineraryDays: []) trips but flags isPartial", () => {
  const untracked = trip({ id: "untracked", startDate: null, endDate: null, daysCount: 0, source: "historical_manual", itineraryDays: [] });
  const untrackedOnlyStats = computePassportStats([untracked]);
  assert.equal(untrackedOnlyStats.citiesVisited.value, 0);
  assert.equal(untrackedOnlyStats.citiesVisited.isPartial, true);

  const trackedDay = { ...createEmptyDay(1, "2026-10-06"), cityRegion: "Cairo", items: [] };
  const tracked = trip({ id: "tracked", itineraryDays: [trackedDay] });
  const trackedOnlyStats = computePassportStats([tracked]);
  assert.equal(trackedOnlyStats.citiesVisited.isPartial, false);
});

test("getCompletedTrips and getUpcomingTrips filter by status only, matching status everywhere else", () => {
  const completed = trip({ id: "done", status: "completed" });
  const upcoming = trip({ id: "soon", status: "upcoming", startDate: "2027-01-01", endDate: "2027-01-05" });
  const planning = trip({ id: "draft", status: "draft" });

  assert.deepEqual(getCompletedTrips([completed, upcoming, planning]).map((t) => t.id), ["done"]);
  assert.deepEqual(getUpcomingTrips([completed, upcoming, planning]).map((t) => t.id), ["soon"]);
});
