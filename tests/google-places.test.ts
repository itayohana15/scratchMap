import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  isGooglePlacesConfigured,
  categoryHasGooglePlacesSource,
  queryGooglePlacesForCategories,
  queryGooglePlacesForCategoriesDetailed,
  resolveGooglePlaceByName,
  createGooglePlacesBudget,
  queryGooglePlacesWithBudget,
} from "../src/lib/places/google-places";

const BOSTON = { lat: 42.3601, lon: -71.0589 };

function withMockedGoogleKey(t: import("node:test").TestContext) {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key-never-a-real-credential";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  });
}

function mockPlace(overrides: Partial<{ id: string; name: string; lat: number; lon: number; primaryType: string; types: string[]; formattedAddress: string }> = {}) {
  return {
    id: overrides.id ?? "ChIJmock1",
    displayName: { text: overrides.name ?? "Mock Museum" },
    location: { latitude: overrides.lat ?? BOSTON.lat, longitude: overrides.lon ?? BOSTON.lon },
    primaryType: overrides.primaryType ?? "museum",
    types: overrides.types ?? ["museum", "tourist_attraction", "point_of_interest", "establishment"],
    formattedAddress: overrides.formattedAddress ?? "1 Mock St, Boston, MA",
  };
}

test("Round 9.6: isGooglePlacesConfigured reflects GOOGLE_MAPS_API_KEY presence", (t) => {
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  });
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.equal(isGooglePlacesConfigured(), false);
  process.env.GOOGLE_MAPS_API_KEY = "x";
  assert.equal(isGooglePlacesConfigured(), true);
});

test("Round 9.6: category-to-Google-type mapping deliberately excludes ordinary retail/accommodation categories", () => {
  assert.equal(categoryHasGooglePlacesSource("attraction"), true);
  assert.equal(categoryHasGooglePlacesSource("museum"), true);
  assert.equal(categoryHasGooglePlacesSource("restaurant"), true);
  assert.equal(categoryHasGooglePlacesSource("hotel"), false, "hotels are never a Google Places discovery category — this provider never returns lodging as an activity candidate");
  assert.equal(categoryHasGooglePlacesSource("transportation"), false);
});

// test 7: Google returns museum/tourist attraction -> accepted appropriately.
test("Round 9.6 test 7: a mocked Nearby Search response for a museum/tourist_attraction place is accepted with correct category and provenance", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () => new Response(JSON.stringify({ places: [mockPlace()] }), { status: 200 })) as typeof fetch;

  const { candidates, requestFailed } = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["museum", "attraction"], 10);
  assert.equal(requestFailed, false);
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.category, "museum");
  assert.equal(candidate.name, "Mock Museum");
  assert.equal(candidate.provenance?.provider, "google_places");
  assert.equal(candidate.provenance?.providerId, "ChIJmock1");
  assert.ok(candidate.provenance?.types?.includes("tourist_attraction"));
});

// Round 9.6.5 §D test 14: restaurant/cafe/bakery accepted; grocery/convenience/gas rejected.
test("Round 9.6.5 test 14: a bakery is accepted as a cafe-tier meal venue", async (t) => {
  withMockedGoogleKey(t);
  const bakery = mockPlace({ id: "ChIJbakery1", name: "Corner Bakery", primaryType: "bakery", types: ["bakery", "food", "point_of_interest", "establishment"] });
  global.fetch = (async () => new Response(JSON.stringify({ places: [bakery] }), { status: 200 })) as typeof fetch;
  const { candidates } = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["cafe", "restaurant"], 10);
  assert.equal(candidates.length, 1, "a genuine bakery must be accepted as a meal venue");
  assert.equal(candidates[0].category, "cafe");
});

test("Round 9.6.5 test 14b: a grocery store or convenience store is never accepted as a meal venue, even if requested alongside restaurant/cafe", async (t) => {
  withMockedGoogleKey(t);
  const grocery = mockPlace({ id: "ChIJgrocery1", name: "Neighborhood Grocery", primaryType: "grocery_store", types: ["grocery_store", "food", "store", "point_of_interest", "establishment"] });
  const convenience = mockPlace({ id: "ChIJconv1", name: "Quick Stop", primaryType: "convenience_store", types: ["convenience_store", "food", "store", "point_of_interest", "establishment"] });
  global.fetch = (async () => new Response(JSON.stringify({ places: [grocery, convenience, mockPlace()] }), { status: 200 })) as typeof fetch;
  const { candidates } = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["cafe", "restaurant", "museum"], 10);
  assert.ok(!candidates.some((c) => c.name === "Neighborhood Grocery"), "a grocery store must never be accepted as a meal venue");
  assert.ok(!candidates.some((c) => c.name === "Quick Stop"), "a convenience store must never be accepted as a meal venue");
});

// test 6: Google returns hotel/supermarket/ordinary utility -> rejected from normal activity portfolio.
test("Round 9.6 test 6: a place whose types match NONE of the requested categories (e.g. a lodging/utility type slipping into a broad response) is silently excluded, never guessed into a category", async (t) => {
  withMockedGoogleKey(t);
  const lodgingLikePlace = mockPlace({ id: "ChIJhotel1", name: "Some Hotel", primaryType: "lodging", types: ["lodging", "point_of_interest", "establishment"] });
  global.fetch = (async () => new Response(JSON.stringify({ places: [lodgingLikePlace, mockPlace()] }), { status: 200 })) as typeof fetch;

  const { candidates } = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["museum", "attraction"], 10);
  assert.equal(candidates.length, 1, "only the genuinely matching museum candidate should survive");
  assert.equal(candidates[0].name, "Mock Museum");
  assert.ok(!candidates.some((c) => c.name === "Some Hotel"), "a lodging-typed place must never be accepted as a tourist activity candidate");
});

// Discovered live during the Round 9.6 §M Boston validation: a hotel's own
// on-site restaurant is returned by Google with primaryType "hotel" but
// types also including "restaurant" — this must never be accepted as a
// meal recommendation just because a secondary type happens to match.
test("Round 9.6 §M regression: a hotel whose secondary types include \"restaurant\" is rejected outright, never accepted via the broader types fallback", async (t) => {
  withMockedGoogleKey(t);
  const hotelWithOnSiteRestaurant = mockPlace({
    id: "ChIJhotel-restaurant",
    name: "Fairmont Copley Plaza, Boston",
    primaryType: "hotel",
    types: ["hotel", "lodging", "restaurant", "food", "point_of_interest", "establishment"],
  });
  global.fetch = (async () => new Response(JSON.stringify({ places: [hotelWithOnSiteRestaurant, mockPlace()] }), { status: 200 })) as typeof fetch;

  const { candidates } = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["restaurant", "museum"], 10);
  assert.equal(candidates.length, 1, "only the genuine museum should survive");
  assert.ok(!candidates.some((c) => c.name === "Fairmont Copley Plaza, Boston"), "a hotel must never be accepted as a restaurant merely because its secondary types include \"restaurant\"");
});

test("Round 9.6: queryGooglePlacesForCategories never requests a Nearby Search when every given category is unsupported (e.g. hotel/transportation only)", async (t) => {
  withMockedGoogleKey(t);
  let called = false;
  global.fetch = (async () => {
    called = true;
    return new Response(JSON.stringify({ places: [] }), { status: 200 });
  }) as typeof fetch;
  const result = await queryGooglePlacesForCategories(BOSTON, 5, ["hotel", "transportation"], 10);
  assert.deepEqual(result, []);
  assert.equal(called, false, "no network request should be made when nothing in the category list is Google-Places-eligible");
});

test("Round 9.6: a failed Google request (5xx) is distinguished from a genuinely empty result", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  const failed = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["museum"], 10);
  assert.equal(failed.requestFailed, true);
  assert.deepEqual(failed.candidates, []);

  global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  const empty = await queryGooglePlacesForCategoriesDetailed(BOSTON, 5, ["museum"], 10);
  assert.equal(empty.requestFailed, false, "a successful response with genuinely zero places must never be reported as a request failure");
  assert.deepEqual(empty.candidates, []);
});

// Section G resolution primitive.
test("Round 9.6 §G: resolveGooglePlaceByName resolves a real, nearby, category-eligible place", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () => new Response(JSON.stringify({ places: [mockPlace({ name: "Boston Tea Party Ships & Museum" })] }), { status: 200 })) as typeof fetch;
  const resolved = await resolveGooglePlaceByName("Boston Tea Party Ships & Museum", BOSTON, 15);
  assert.ok(resolved);
  assert.equal(resolved!.name, "Boston Tea Party Ships & Museum");
  assert.equal(resolved!.category, "museum");
});

test("Round 9.6 §G: resolveGooglePlaceByName returns null for a non-resolvable / fabricated name", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () => new Response(JSON.stringify({ places: [] }), { status: 200 })) as typeof fetch;
  const resolved = await resolveGooglePlaceByName("Totally Fictional Unicorn Castle", BOSTON, 15);
  assert.equal(resolved, null);
});

test("Round 9.6 §G: resolveGooglePlaceByName rejects a same-named place that is genuinely far from the anchor (fail-closed on distance)", async (t) => {
  withMockedGoogleKey(t);
  const farAway = mockPlace({ lat: BOSTON.lat + 20, lon: BOSTON.lon + 20 });
  global.fetch = (async () => new Response(JSON.stringify({ places: [farAway] }), { status: 200 })) as typeof fetch;
  const resolved = await resolveGooglePlaceByName("Mock Museum", BOSTON, 15);
  assert.equal(resolved, null, "a same-named place thousands of km away must never be accepted as a match");
});

// test 12/13: budget exhaustion + cache.
test("Round 9.6 test 13: queryGooglePlacesWithBudget caches identical (anchor/radius/category-group) lookups, never issuing a second Google call", async (t) => {
  withMockedGoogleKey(t);
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ places: [mockPlace()] }), { status: 200 });
  }) as typeof fetch;
  const budget = createGooglePlacesBudget(10);
  await queryGooglePlacesWithBudget(budget, BOSTON, 5, ["museum"], 10);
  await queryGooglePlacesWithBudget(budget, BOSTON, 5, ["museum"], 10);
  assert.equal(calls, 1, "an identical repeated lookup must be served from cache");
  assert.equal(budget.counters.googlePlacesCalls, 1);
  assert.equal(budget.counters.googlePlacesCacheHits, 1);
});

test("Round 9.6 test 12: queryGooglePlacesWithBudget stops issuing calls once the budget is exhausted, and reports it truthfully via counters", async (t) => {
  withMockedGoogleKey(t);
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ places: [mockPlace()] }), { status: 200 });
  }) as typeof fetch;
  const budget = createGooglePlacesBudget(1);
  const first = await queryGooglePlacesWithBudget(budget, BOSTON, 5, ["museum"], 10);
  const second = await queryGooglePlacesWithBudget(budget, { lat: BOSTON.lat + 1, lon: BOSTON.lon + 1 }, 5, ["museum"], 10);
  assert.equal(calls, 1, "the budget cap of 1 must be respected — a second, genuinely different lookup must not trigger a second call");
  assert.ok(first.length > 0);
  assert.deepEqual(second, [], "once budget is exhausted, the function must return an empty (never fabricated) result");
  assert.equal(budget.counters.googlePlacesCalls, 1);
});

// test 14: API key never exposed.
test("Round 9.6 test 14: GOOGLE_MAPS_API_KEY is read only server-side and never logged/serialized by google-places.ts", () => {
  const projectRoot = path.join(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(projectRoot, "src", "lib", "places", "google-places.ts"), "utf8");
  assert.match(source, /process\.env\.GOOGLE_MAPS_API_KEY/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_GOOGLE/i);
  assert.doesNotMatch(source, /console\.(log|error|warn)\([^)]*apiKey/i, "the api key variable must never be passed to a console call");
});
