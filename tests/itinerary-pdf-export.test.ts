import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import { bidiName, buildItineraryPdfHtml, renderDay, renderItem } from "../src/lib/itinerary-pdf-export";
import { geoResolutionJoinKey, type GeoResolutionOverrideMap } from "../src/lib/itinerary-day-view-helpers";
import {
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  type TripItineraryDay,
  type TripItineraryItem,
} from "../src/lib/trip-workspace";

function day(overrides: Partial<TripItineraryDay> = {}): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides };
}

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

// Invented geography ("Testonia") — same convention as the rest of this
// test suite's newer files (route-optimization.test.ts etc).
function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  return {
    id: "itin-qa-1",
    countryId: "country-testonia",
    isoA2: "ZZ",
    title: "Testonia trip",
    startDate: "2026-10-06",
    endDate: "2026-10-08",
    daysCount: 3,
    travelers: 2,
    budget: 5000,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: createDefaultWorkspace("Testonia").preferences,
    workspaceSnapshot: createDefaultWorkspace("Testonia"),
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 0,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
    status: "upcoming",
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

// Spec "LOCATION LABEL NORMALIZATION BUG" — the underlying multi-word
// English name must never be reordered by the fix itself; only wrapped
// for correct bidi rendering.
test("25. bidiName never reorders a multi-word English name — New York stays New York", () => {
  assert.equal(bidiName("New York"), "<bdi>New York</bdi>");
});

test("26. bidiName never reorders San Francisco", () => {
  assert.equal(bidiName("San Francisco"), "<bdi>San Francisco</bdi>");
});

test("27. bidiName never reorders Los Angeles", () => {
  assert.equal(bidiName("Los Angeles"), "<bdi>Los Angeles</bdi>");
});

test("28. bidiName never reorders New Orleans", () => {
  assert.equal(bidiName("New Orleans"), "<bdi>New Orleans</bdi>");
});

test("29. Hebrew surrounding text does not reverse the isolated English entity token", () => {
  const testDay = day({ title: "", cityRegion: "New York", accommodation: "" });
  const html = renderDay(testDay);
  assert.ok(html.includes("<bdi>New York</bdi>"), "the city region must be isolated as one unbroken bdi run");
  // The word order inside the isolated run itself must be untouched.
  const bdiMatch = /<bdi>([^<]*)<\/bdi>/.exec(html);
  assert.equal(bdiMatch?.[1], "New York");
});

test("bidiName escapes HTML-unsafe characters the same way the rest of the export does", () => {
  assert.equal(bidiName("Ben & Jerry's"), "<bdi>Ben &amp; Jerry&#039;s</bdi>");
});

test("renderItem isolates both the item name and its location text", () => {
  const html = renderItem(item({ name: "Golden Gate Bridge", location: "San Francisco, CA" }));
  assert.ok(html.includes("<bdi>Golden Gate Bridge</bdi>"));
  assert.ok(html.includes("<bdi>San Francisco, CA</bdi>"));
});

test("renderDay omits the QA_DEBUG_GEOGRAPHY overlay entirely when no geoDebugContext is given (the default, non-flagged path)", () => {
  const html = renderDay(day({ title: "יום רגיל" }));
  assert.ok(!html.includes("geo-debug"), "the overlay must never appear unless explicitly requested");
});

test("renderDay's QA_DEBUG_GEOGRAPHY overlay shows a dayTypeMismatch and bidi-isolates its English field values", () => {
  const cityB = { lat: 20, lon: 20 };
  const previousDay = day({ dayNumber: 1, cityCanonicalId: "zz:10.00:10.00" });
  const testDay = day({
    dayNumber: 2,
    cityCanonicalId: "zz:20.00:20.00",
    title: "יום רגיל בעיר B",
    notes: "",
    accommodationLat: cityB.lat,
    accommodationLon: cityB.lon,
    items: [
      item({ name: "Invented Landmark", category: "attraction", lat: cityB.lat, lon: cityB.lon, recommendationId: "rec-b1" }),
      item({ name: "Unplaced Stop", category: "attraction", lat: null, lon: null, recommendationId: null }),
    ],
  });

  const html = renderDay(testDay, { previousDay, isFirstDay: false, isLastDay: false, geoResolutionOverride: null });

  assert.ok(html.includes("geo-debug"), "the overlay must render when a geoDebugContext is given");
  assert.ok(html.includes("derivedDayType=<bdi>transfer</bdi>"), "English diagnostic tokens must get the same bdi isolation as any other foreign-language text in this RTL document");
  assert.ok(html.includes("textualDayType=<bdi>normal</bdi>"));
  assert.ok(html.includes('<strong class="geo-debug-mismatch">dayTypeMismatch=TRUE</strong>'));
  assert.ok(html.includes("<bdi>Invented Landmark</bdi>") && html.includes("<bdi>provider</bdi>"));
  assert.ok(html.includes("<bdi>Unplaced Stop</bdi>") && html.includes("<bdi>unresolved</bdi>"));
});

test("renderDay's overlay shows a real fuzzyName resolution when a geo-resolution.json override exists, and falls back cleanly without one", () => {
  const testDay = day({
    dayNumber: 1,
    title: "יום רגיל",
    items: [item({ name: "Old Town Market", category: "attraction", lat: 10, lon: 10, recommendationId: null })],
  });
  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey(null, 1, "Old Town Market")]: {
      geoSource: "fuzzyName",
      dayIndex: 1,
      itemName: "Old Town Market",
      stayId: "phase-a",
    },
  };

  const withOverride = renderDay(testDay, { previousDay: null, isFirstDay: true, isLastDay: false, geoResolutionOverride: overrideMap });
  assert.ok(withOverride.includes("<bdi>fuzzyName</bdi>"), "a real override entry must surface the full taxonomy value in the rendered PDF");

  // No override file for this trip (the normal case) must never crash and
  // must fall back to the existing degraded computation.
  const withoutOverride = renderDay(testDay, { previousDay: null, isFirstDay: true, isLastDay: false, geoResolutionOverride: null });
  assert.ok(withoutOverride.includes("<bdi>provider</bdi>"), "with no override, the degraded provider/unresolved computation is the only source");
  assert.ok(!withoutOverride.includes("fuzzyName"));
});

// Sanity check requested directly: buildItineraryPdfHtml was never exported
// or exercised end-to-end before — every existing test above only calls
// renderDay directly. This confirms the whole assembled document (not just
// one day's fragment) actually contains the N/M summary line, at least one
// item-level geoSource, an "unmatched" case, and a dayTypeMismatch case —
// with no live PDF-export button reachable in this sandbox (no browser),
// this is the only way to verify the flag actually produces real output.
test("buildItineraryPdfHtml renders the N/M summary, a geoSource row, an unmatched case, and a dayTypeMismatch case", () => {
  const day1 = day({
    dayNumber: 1,
    date: "2026-10-06",
    cityCanonicalId: "zz:10.00:10.00",
    title: "יום הגעה",
    items: [item({ name: "Arrival Landmark", category: "attraction", lat: 10, lon: 10, recommendationId: "rec-a1" })],
  });
  const day2 = day({
    dayNumber: 2,
    date: "2026-10-07",
    cityCanonicalId: "zz:20.00:20.00", // differs from day1 -> derivedDayType "transfer"
    title: "יום רגיל באזור B", // textually normal -> textualDayType "normal" -> mismatch
    notes: "",
    items: [
      item({ name: "Testonia Landmark", category: "attraction", lat: 20, lon: 20, recommendationId: "rec-b1" }),
      item({ name: "Unlisted Local Market", category: "attraction", lat: 20, lon: 20, recommendationId: null }),
    ],
  });
  const day3 = day({
    dayNumber: 3,
    date: "2026-10-08",
    cityCanonicalId: "zz:20.00:20.00",
    title: "יום עזיבה",
    items: [item({ name: "Departure Landmark", category: "attraction", lat: 20, lon: 20, recommendationId: "rec-c1" })],
  });

  // Only rec-b1 has a real override entry — every other real-place item
  // (3 of the 4 total) must come back "unmatched", not silently "provider".
  const overrideMap: GeoResolutionOverrideMap = {
    [geoResolutionJoinKey("rec-b1", 2, "Testonia Landmark")]: {
      geoSource: "fuzzyName",
      dayIndex: 2,
      itemName: "Testonia Landmark",
      stayId: "phase-b",
    },
  };

  const itinerary = buildItinerary({ itineraryDays: [day1, day2, day3] });
  const html = buildItineraryPdfHtml(itinerary, "Testonia", undefined, true, overrideMap);

  // 1. N/M summary line
  assert.ok(html.includes('class="geo-debug-summary"'), "the geo-debug-summary block must be present");
  assert.ok(html.includes("1/4 items matched"), "expected exactly 1 of the 4 real-place items to match the override");

  // 2. at least one item row with a real geoSource
  assert.ok(html.includes("<bdi>fuzzyName</bdi>"), "the matched item's geoSource must render");

  // 3. at least one unmatched case
  assert.ok(html.includes("<bdi>unmatched</bdi>"), "an item missing from the override file must render as unmatched");

  // 4. at least one dayTypeMismatch case
  assert.ok(
    html.includes('<strong class="geo-debug-mismatch">dayTypeMismatch=TRUE</strong>'),
    "day 2's city change without a textual transfer indication must render as a mismatch"
  );

  const summaryStart = html.indexOf('class="geo-debug-summary"') - 20;
  const day2DebugStart = html.indexOf("QA_DEBUG_GEOGRAPHY — יום 2") - 20;
  console.log("---- geo-debug-summary excerpt ----");
  console.log(html.slice(summaryStart, summaryStart + 160));
  console.log("---- day 2 geo-debug excerpt ----");
  console.log(html.slice(day2DebugStart, day2DebugStart + 900));
});
