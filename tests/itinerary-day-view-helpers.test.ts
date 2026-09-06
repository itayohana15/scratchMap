import assert from "node:assert/strict";
import test from "node:test";

import {
  computeDaySummary,
  computeDayGeographyDebugRow,
  computeGeographyDebugRows,
  computeGeoResolutionMatchSummary,
  derivedDayTypeDebug,
  deriveDayTypeLabel,
  formatMinutes,
  geoResolutionJoinKey,
  getAdjacentDayId,
  isRealPlaceItem,
  shouldShowTravelConnector,
  textualDayTypeDebug,
  type GeoResolutionOverrideMap,
} from "../src/lib/itinerary-day-view-helpers";
import { createEmptyDay, createEmptyItineraryItem, type TripItineraryDay, type TripItineraryItem } from "../src/lib/trip-workspace";

function day(overrides: Partial<TripItineraryDay> = {}): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides };
}

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

test("formatMinutes formats under an hour as minutes, over an hour as H:MM", () => {
  assert.equal(formatMinutes(45), "45 דק׳");
  assert.equal(formatMinutes(90), "1:30 שעות");
  assert.equal(formatMinutes(120), "2 שעות");
});

test("deriveDayTypeLabel reads the generator's own transfer/day-trip wording, never invents one", () => {
  assert.equal(deriveDayTypeLabel(day({ notes: "יום מעבר בין בסיסים" })), "יום מעבר");
  assert.equal(deriveDayTypeLabel(day({ title: "טיול יום להרים" })), "טיול יום");
  assert.equal(deriveDayTypeLabel(day({ title: "יום רגיל בעיר" })), null);
});

test("isRealPlaceItem excludes transportation/practical items and meal opportunities", () => {
  assert.equal(isRealPlaceItem(item({ category: "attraction", lat: 1, lon: 1, recommendationId: "rec-1" })), true);
  assert.equal(isRealPlaceItem(item({ category: "transportation", lat: 1, lon: 1, recommendationId: "rec-1" })), false);
  assert.equal(isRealPlaceItem(item({ category: "practical" })), false);
  assert.equal(isRealPlaceItem(item({ category: "restaurant", lat: null, lon: null, recommendationId: null })), false, "a meal opportunity is not a real place");
  assert.equal(isRealPlaceItem(item({ category: "restaurant", lat: 1, lon: 1, recommendationId: "osm:restaurant:1:1" })), true, "a real selected restaurant IS a real place");
});

test("computeDaySummary sums real travel minutes and counts real places/food windows", () => {
  const testDay = day({
    items: [
      item({ category: "attraction", lat: 1, lon: 1, recommendationId: "rec-1", travelMinutes: 10 }),
      item({ category: "attraction", lat: 2, lon: 2, recommendationId: "rec-2", travelMinutes: 15 }),
      item({ category: "restaurant", lat: 1, lon: 1, recommendationId: "osm:restaurant:1:1" }),
    ],
  });
  const summary = computeDaySummary(testDay);
  assert.equal(summary.totalTravelMinutes, 25);
  assert.equal(summary.placeCount, 3, "real attractions AND a real selected restaurant both count as places");
  assert.equal(summary.foodWindowCount, 1);
});

test("shouldShowTravelConnector is true only when there's real travel data to show", () => {
  assert.equal(shouldShowTravelConnector(item({ travelMinutes: 15, transportation: "" })), true);
  assert.equal(shouldShowTravelConnector(item({ travelMinutes: null, transportation: "רכבת" })), true);
  assert.equal(shouldShowTravelConnector(item({ travelMinutes: null, transportation: "" })), false);
});

test("textualDayTypeDebug mirrors the server's text-pattern classifiers (transfer wording, day-trip wording, plain)", () => {
  assert.equal(textualDayTypeDebug(day({ notes: "יום מעבר בין בסיסים" })), "transfer");
  assert.equal(textualDayTypeDebug(day({ title: "טיול יום להרים" })), "day_trip");
  assert.equal(textualDayTypeDebug(day({ title: "יום רגיל בעיר" })), "normal");
});

test("derivedDayTypeDebug: trip edges are arrival/departure regardless of wording; a mid-trip cityCanonicalId change is a structural transfer", () => {
  const cityA = { cityCanonicalId: "zz:10.00:10.00" };
  const cityB = { cityCanonicalId: "zz:20.00:20.00" };
  assert.equal(derivedDayTypeDebug(day({ ...cityA, title: "יום רגיל בעיר" }), null, true, false), "arrival");
  assert.equal(derivedDayTypeDebug(day({ ...cityB, title: "יום רגיל בעיר" }), day(cityA), false, true), "departure");
  assert.equal(
    derivedDayTypeDebug(day({ ...cityB, title: "יום רגיל בעיר" }), day(cityA), false, false),
    "transfer",
    "a real stay change must be detected structurally even when the day's own text gives no hint at all"
  );
  assert.equal(derivedDayTypeDebug(day({ ...cityA, title: "יום רגיל בעיר" }), day(cityA), false, false), "normal");
});

test("computeGeographyDebugRows: acceptance — shows a real dayTypeMismatch and a real provider-resolved item", () => {
  const cityA = { lat: 10, lon: 10 };
  const cityB = { lat: 20, lon: 20 };
  const days: TripItineraryDay[] = [
    day({
      dayNumber: 1,
      cityRegion: "City A",
      cityCanonicalId: "zz:10.00:10.00",
      title: "יום ראשון בעיר A",
      accommodationLat: cityA.lat,
      accommodationLon: cityA.lon,
      items: [
        item({ name: "Old Landmark", category: "attraction", lat: cityA.lat, lon: cityA.lon, recommendationId: "rec-a1" }),
        item({ name: "Mystery Viewpoint", category: "attraction", lat: null, lon: null, recommendationId: null }),
      ],
    }),
    // Middle day: real stay change (cityCanonicalId flips) but the day's
    // own text carries no transfer/day-trip wording at all — the exact
    // asymmetry the acceptance case needs to demonstrate.
    day({
      dayNumber: 2,
      cityRegion: "City B",
      cityCanonicalId: "zz:20.00:20.00",
      title: "יום רגיל בעיר B",
      notes: "המשך הטיול",
      accommodationLat: cityB.lat,
      accommodationLon: cityB.lon,
      items: [item({ name: "City B Anchor", category: "attraction", lat: cityB.lat, lon: cityB.lon, recommendationId: "rec-b1" })],
    }),
    day({ dayNumber: 3, cityRegion: "City B", cityCanonicalId: "zz:20.00:20.00", title: "יום אחרון" }),
  ];

  const rows = computeGeographyDebugRows(days);
  const [day1, day2] = rows;

  console.log("[computeGeographyDebugRows acceptance demo]");
  for (const row of rows) {
    console.log(
      `day ${row.dayNumber} | owner=${row.ownerStay} | derived=${row.derivedDayType} | textual=${row.textualDayType} | mismatch=${row.dayTypeMismatch} | totalLeg=${row.totalLegMinutes} | maxLeg=${row.maxLegMinutes} | unresolved=${row.unresolvedItemCount}`
    );
    for (const it of row.items) {
      console.log(`  - ${it.itemName} | geoSource=${it.geoSource} | precision=${it.precision} | legMinutes=${it.legMinutes}`);
    }
  }

  assert.equal(day1.dayTypeMismatch, false);
  const resolvedItem = day1.items.find((entry) => entry.itemName === "Old Landmark")!;
  assert.equal(resolvedItem.geoSource, "provider");
  assert.equal(resolvedItem.precision, "point");
  const unresolvedItem = day1.items.find((entry) => entry.itemName === "Mystery Viewpoint")!;
  assert.equal(unresolvedItem.geoSource, "unresolved");
  assert.equal(day1.unresolvedItemCount, 1);

  assert.equal(day2.derivedDayType, "transfer", "day 2's real stay change must be detected structurally");
  assert.equal(day2.textualDayType, "normal", "day 2's own text gives no transfer hint at all");
  assert.equal(day2.dayTypeMismatch, true, "the two classifiers must be shown to disagree");
});

test("computeDayGeographyDebugRow marks non-place items (practical/transportation) as n/a rather than unresolved", () => {
  const testDay = day({
    dayNumber: 1,
    accommodationLat: 10,
    accommodationLon: 10,
    items: [item({ name: "מעבר לוגיסטי", category: "practical", lat: null, lon: null })],
  });
  const row = computeDayGeographyDebugRow(testDay, null, true, false);
  assert.equal(row.items[0].geoSource, "n/a");
  assert.equal(row.unresolvedItemCount, 0, "a non-place item must never inflate the unresolved count");
});

test("geoResolutionJoinKey prefers recommendationId, falls back to day+name only when there is none", () => {
  assert.equal(geoResolutionJoinKey("rec-1", 3, "Anything"), "rec-1");
  assert.equal(geoResolutionJoinKey(null, 3, "Old Town Market"), "name:3:Old Town Market");
});

test("computeDayGeographyDebugRow: with a geo-resolution.json override present, shows the full taxonomy (e.g. fuzzyName) instead of the degraded guess", () => {
  const testDay = day({
    dayNumber: 1,
    items: [
      item({ name: "Old Town Market", category: "attraction", lat: 10, lon: 10, recommendationId: null }),
      item({ name: "Known Landmark", category: "attraction", lat: 10, lon: 10, recommendationId: "rec-known" }),
    ],
  });
  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey(null, 1, "Old Town Market")]: {
      geoSource: "fuzzyName",
      dayIndex: 1,
      itemName: "Old Town Market",
      stayId: "phase-a",
    },
  };

  const withOverride = computeDayGeographyDebugRow(testDay, null, true, false, "balanced", overrideMap);
  assert.equal(withOverride.items[0].geoSource, "fuzzyName", "an override entry must replace the degraded provider/unresolved guess");
  assert.equal(
    withOverride.items[1].geoSource,
    "unmatched",
    "once an override FILE exists, an item with no entry in it is a distinct finding (unmatched) — never silently treated as if no file existed at all"
  );

  // Same day, no override file (the normal case — no CAPTURE_FIXTURES run
  // ever happened, or it happened for a different country) must fall back
  // cleanly to the existing degraded behavior, never throw.
  const withoutOverride = computeDayGeographyDebugRow(testDay, null, true, false);
  assert.equal(withoutOverride.items[0].geoSource, "provider", "with no override file, the degraded computation is the only source — lat/lon present means provider");
});

test("computeGeographyDebugRows threads the override map through every day", () => {
  const days = [day({ dayNumber: 1, items: [item({ name: "X", category: "attraction", lat: 1, lon: 1, recommendationId: null })] })];
  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey(null, 1, "X")]: { geoSource: "recommendationId", dayIndex: 1, itemName: "X", stayId: null },
  };
  const rows = computeGeographyDebugRows(days, "balanced", overrideMap);
  assert.equal(rows[0].items[0].geoSource, "recommendationId");
});

test("computeDayGeographyDebugRow: unresolved (a real geoSource value from the file) and unmatched (no entry in the file) are never confused with each other", () => {
  const testDay = day({
    dayNumber: 1,
    items: [
      item({ name: "Genuinely Unresolved Spot", category: "attraction", lat: null, lon: null, recommendationId: null }),
      item({ name: "Never Captured Spot", category: "attraction", lat: null, lon: null, recommendationId: null }),
    ],
  });
  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey(null, 1, "Genuinely Unresolved Spot")]: {
      geoSource: "unresolved",
      dayIndex: 1,
      itemName: "Genuinely Unresolved Spot",
      stayId: null,
    },
  };
  const row = computeDayGeographyDebugRow(testDay, null, true, false, "balanced", overrideMap);
  assert.equal(row.items[0].geoSource, "unresolved", "the resolver genuinely failed at generation time — a real finding from the file");
  assert.equal(row.items[1].geoSource, "unmatched", "this item was never in the file at all — a different finding, not the same as unresolved");
});

test("computeGeoResolutionMatchSummary returns null with no override file (nothing to report), and a real N/M count once one exists", () => {
  const days = [
    day({
      dayNumber: 1,
      items: [
        item({ name: "A", category: "attraction", lat: 1, lon: 1, recommendationId: null }),
        item({ name: "B", category: "attraction", lat: 1, lon: 1, recommendationId: null }),
      ],
    }),
    day({
      dayNumber: 2,
      items: [item({ name: "C", category: "attraction", lat: 1, lon: 1, recommendationId: null })],
    }),
  ];

  assert.equal(computeGeoResolutionMatchSummary(days, null), null, "no file at all means nothing to summarize — never a misleading 0/0");

  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey(null, 1, "A")]: { geoSource: "provider", dayIndex: 1, itemName: "A", stayId: null },
    [geoResolutionJoinKey(null, 2, "C")]: { geoSource: "fuzzyName", dayIndex: 2, itemName: "C", stayId: null },
  };
  assert.deepEqual(
    computeGeoResolutionMatchSummary(days, overrideMap),
    { matched: 2, total: 3 },
    "matched counts real entries found in the file; total is every real-place item across the whole trip, regardless of match"
  );
});

test("getAdjacentDayId returns the previous/next day and null at either end, regardless of trip length", () => {
  const days = Array.from({ length: 13 }, (_, index) => ({ id: `day-${index + 1}` }));
  assert.equal(getAdjacentDayId(days, "day-5", -1), "day-4");
  assert.equal(getAdjacentDayId(days, "day-5", 1), "day-6");
  assert.equal(getAdjacentDayId(days, "day-1", -1), null);
  assert.equal(getAdjacentDayId(days, "day-13", 1), null);
  assert.equal(getAdjacentDayId(days, "not-a-real-id", 1), null);
});
