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
  assert.equal(bidiName("New York"), '<bdi dir="auto">New York</bdi>');
});

test("26. bidiName never reorders San Francisco", () => {
  assert.equal(bidiName("San Francisco"), '<bdi dir="auto">San Francisco</bdi>');
});

test("27. bidiName never reorders Los Angeles", () => {
  assert.equal(bidiName("Los Angeles"), '<bdi dir="auto">Los Angeles</bdi>');
});

test("28. bidiName never reorders New Orleans", () => {
  assert.equal(bidiName("New Orleans"), '<bdi dir="auto">New Orleans</bdi>');
});

test("29. Hebrew surrounding text does not reverse the isolated English entity token", () => {
  const testDay = day({ title: "", cityRegion: "New York", accommodation: "" });
  const html = renderDay(testDay);
  assert.ok(html.includes('<bdi dir="auto">New York</bdi>'), "the city region must be isolated as one unbroken bdi run");
  // The word order inside the isolated run itself must be untouched.
  const bdiMatch = /<bdi dir="auto">([^<]*)<\/bdi>/.exec(html);
  assert.equal(bdiMatch?.[1], "New York");
});

test("bidiName escapes HTML-unsafe characters the same way the rest of the export does", () => {
  assert.equal(bidiName("Ben & Jerry's"), '<bdi dir="auto">Ben &amp; Jerry&#039;s</bdi>');
});

test("renderItem isolates both the item name and its location text", () => {
  const html = renderItem(item({ name: "Golden Gate Bridge", location: "San Francisco, CA" }));
  assert.ok(html.includes('<bdi dir="auto">Golden Gate Bridge</bdi>'));
  assert.ok(html.includes('<bdi dir="auto">San Francisco, CA</bdi>'));
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
  assert.ok(html.includes('derivedDayType=<bdi dir="auto">transfer</bdi>'), "English diagnostic tokens must get the same bdi isolation as any other foreign-language text in this RTL document");
  assert.ok(html.includes('textualDayType=<bdi dir="auto">normal</bdi>'));
  assert.ok(html.includes('<strong class="geo-debug-mismatch">dayTypeMismatch=TRUE</strong>'));
  assert.ok(html.includes('<bdi dir="auto">Invented Landmark</bdi>') && html.includes('<bdi dir="auto">provider</bdi>'));
  assert.ok(html.includes('<bdi dir="auto">Unplaced Stop</bdi>') && html.includes('<bdi dir="auto">unresolved</bdi>'));
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
  assert.ok(withOverride.includes('<bdi dir="auto">fuzzyName</bdi>'), "a real override entry must surface the full taxonomy value in the rendered PDF");

  // No override file for this trip (the normal case) must never crash and
  // must fall back to the existing degraded computation.
  const withoutOverride = renderDay(testDay, { previousDay: null, isFirstDay: true, isLastDay: false, geoResolutionOverride: null });
  assert.ok(withoutOverride.includes('<bdi dir="auto">provider</bdi>'), "with no override, the degraded provider/unresolved computation is the only source");
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
  assert.ok(html.includes('<bdi dir="auto">fuzzyName</bdi>'), "the matched item's geoSource must render");

  // 3. at least one unmatched case
  assert.ok(html.includes('<bdi dir="auto">unmatched</bdi>'), "an item missing from the override file must render as unmatched");

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

/* ==================================================================== *
 * ROUND 9.10 — RTL/BIDI RENDERING CORRECTNESS                          *
 *                                                                        *
 * Real production evidence (Round 9.8's actual persisted itinerary,     *
 * refetched — never regenerated): raw data is verified correct          *
 * ("Bar Harbor", "North Conway", "New York" all stay exactly themselves *
 * in cityRegion/accommodation/title/transportation fields), but the     *
 * exported PDF and the on-screen itinerary reportedly rendered them     *
 * reordered ("Harbor Bar", "Conway North"). Fixed at the rendering      *
 * boundary only — bidiName()/IsolatedText/isolateText — never by        *
 * touching the underlying strings.                                      *
 * ==================================================================== */

// Test A — Bar Harbor inside a Hebrew sentence (the exact real
// day.accommodation shape: "לינה נוחה באזור Bar Harbor").
test("Round 9.10 test A: Bar Harbor stays Bar Harbor inside a Hebrew accommodation sentence", () => {
  const testDay = day({ title: "יום 14 בBar Harbor", cityRegion: "Bar Harbor", accommodation: "לינה נוחה באזור Bar Harbor" });
  const html = renderDay(testDay);
  assert.ok(html.includes('<bdi dir="auto">Bar Harbor</bdi>'), "Bar Harbor must be isolated as one unbroken bdi run");
  const bdiMatches = [...html.matchAll(/<bdi dir="auto">([^<]*)<\/bdi>/g)].map((m) => m[1]);
  assert.ok(bdiMatches.includes("Bar Harbor"), "internal word order must be exactly 'Bar Harbor', never 'Harbor Bar'");
});

// Test B — North Conway inside a Hebrew sentence (the exact real
// day.title shape: "יום 20 בNorth Conway").
test("Round 9.10 test B: North Conway stays North Conway inside a Hebrew day title", () => {
  const testDay = day({ title: "יום 20 בNorth Conway", cityRegion: "North Conway", accommodation: "לינה נוחה באזור North Conway" });
  const html = renderDay(testDay);
  assert.ok(html.includes('<bdi dir="auto">North Conway</bdi>'), "North Conway must be isolated");
  assert.ok(!html.includes("Conway North"), "must never appear as the reversed 'Conway North'");
});

// Test C — New York inside a Hebrew sentence.
test("Round 9.10 test C: New York stays New York inside a Hebrew sentence", () => {
  const testDay = day({ title: "יום 33 בNew York", cityRegion: "New York", accommodation: "לינה נוחה באזור New York" });
  const html = renderDay(testDay);
  assert.ok(html.includes('<bdi dir="auto">New York</bdi>'));
  assert.ok(!html.includes("York New"));
});

// Test D — a long multi-word English POI (the exact real Round 9.8 name).
test("Round 9.10 test D: a long multi-word English POI preserves full internal word order", () => {
  const html = renderItem(item({ name: "Harvard Museum of Natural History", location: "Cambridge" }));
  assert.ok(html.includes('<bdi dir="auto">Harvard Museum of Natural History</bdi>'));
});

test("Round 9.10 test D2: a second long multi-word English POI (Lower East Side Tenement Museum)", () => {
  const html = renderItem(item({ name: "Lower East Side Tenement Museum", location: "New York" }));
  assert.ok(html.includes('<bdi dir="auto">Lower East Side Tenement Museum</bdi>'));
});

// Test E — an English restaurant name.
test("Round 9.10 test E: an English restaurant name is isolated correctly", () => {
  const html = renderItem(item({ category: "restaurant", name: "Thurston's Lobster Pound", location: "Bar Harbor" }));
  assert.ok(html.includes(bidiName("Thurston's Lobster Pound")));
});

// Test F — a Hebrew place name is unaffected by the SAME isolation mechanism.
test("Round 9.10 test F: a Hebrew place name renders unchanged through the same isolation path", () => {
  const testDay = day({ title: "", cityRegion: "בוסטון", accommodation: "לינה נוחה באזור בוסטון" });
  const html = renderDay(testDay);
  assert.ok(html.includes('<bdi dir="auto">בוסטון</bdi>'), "a Hebrew name goes through the identical dir=auto isolation, never a hardcoded dir=ltr that would break it");
});

// Test G — numeric time unchanged.
test("Round 9.10 test G: a numeric time (09:00) is unaffected by bidi isolation", () => {
  const html = renderItem(item({ name: "Sand Beach", plannedStartTime: "09:00" }));
  assert.ok(html.includes("09:00"), "the time must still render exactly, unwrapped and unreordered");
});

// Test H — currency unchanged.
test("Round 9.10 test H: currency formatting is unaffected by bidi isolation", () => {
  const html = renderItem(item({ name: "Whale Watch Tour", approximatePrice: 150 }));
  assert.ok(/₪|ILS|150/.test(html), "the price must still render, untouched by any bidi change");
});

// Tests I/J/K — real inter-stay transfer strings (exact Round 9.8 shape:
// mode-prefixed Hebrew text + "Origin → Destination", all one opaque
// item.name string). Isolated as ONE run — the arrow and both endpoints'
// internal order must survive.
test("Round 9.10 test I: Boston → Providence transfer order preserved", () => {
  const html = renderItem(item({ category: "transportation", name: "רכבת: Boston → Providence" }));
  assert.ok(html.includes('<bdi dir="auto">רכבת: Boston → Providence</bdi>'));
  const bdiMatch = /<bdi dir="auto">([^<]*)<\/bdi>/.exec(html);
  assert.equal(bdiMatch?.[1], "רכבת: Boston → Providence");
});

test("Round 9.10 test J: Providence → Bar Harbor transfer order preserved (the exact real Round 9.8 string)", () => {
  const html = renderItem(item({ category: "transportation", name: "נסיעה ברכב: Providence → Bar Harbor" }));
  const bdiMatch = /<bdi dir="auto">([^<]*)<\/bdi>/.exec(html);
  assert.equal(bdiMatch?.[1], "נסיעה ברכב: Providence → Bar Harbor");
  assert.ok(bdiMatch![1].indexOf("Providence") < bdiMatch![1].indexOf("Bar Harbor"), "Providence must appear before Bar Harbor");
});

test("Round 9.10 test K: Bar Harbor → North Conway transfer order preserved (the exact real Round 9.8 string)", () => {
  const html = renderItem(item({ category: "transportation", name: "נסיעה ברכב: Bar Harbor → North Conway" }));
  const bdiMatch = /<bdi dir="auto">([^<]*)<\/bdi>/.exec(html);
  assert.equal(bdiMatch?.[1], "נסיעה ברכב: Bar Harbor → North Conway");
});

// Test L — mixed English + number name.
test("Round 9.10 test L: a mixed English + number name is preserved exactly", () => {
  const html = renderItem(item({ name: "Route 66 Diner" }));
  assert.ok(html.includes('<bdi dir="auto">Route 66 Diner</bdi>'));
});

// Test M — punctuation around isolated LTR text (comma, ampersand).
test("Round 9.10 test M: punctuation around an isolated name survives (comma, ampersand)", () => {
  const html = renderItem(item({ name: "Ben & Jerry's", location: "Cambridge, MA" }));
  assert.ok(html.includes(bidiName("Ben & Jerry's")));
  assert.ok(html.includes(bidiName("Cambridge, MA")));
});

// Round 9.10 §B — refetched Round 9.8 raw-data invariant, exercised
// directly against the real render functions (no regeneration involved).
test("Round 9.10: the Round 9.8 refetched raw strings (Bar Harbor, North Conway) survive the full renderDay pipeline unchanged", () => {
  for (const name of ["Bar Harbor", "North Conway", "New York", "Providence", "Philadelphia"]) {
    const testDay = day({ title: `יום 1 ב${name}`, cityRegion: name, accommodation: `לינה נוחה באזור ${name}` });
    const html = renderDay(testDay);
    const matches = [...html.matchAll(/<bdi dir="auto">([^<]*)<\/bdi>/g)].map((m) => m[1]);
    assert.ok(matches.includes(name), `${name} must appear as one unbroken, correctly-ordered bdi run`);
  }
});
