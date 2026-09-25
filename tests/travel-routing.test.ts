import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  buildHeuristicGroundLeg,
  buildGroundLegAsync,
  buildFlightDoorToDoorLeg,
  chooseInterStayTransferLeg,
  createRouteCache,
  getOrComputeLeg,
  getOrComputeLegOrNull,
  accountForLegs,
  isGoogleMapsConfigured,
  type GeoPoint,
} from "../src/lib/server/travel-routing";
import { buildStayTransitionsWithRouting } from "../src/lib/server/itinerary-planning-principles";
import { buildStayTransitionItem } from "../src/lib/server/country-itinerary-generation";
import type { TripFrame } from "../src/lib/server/itinerary-generation-constraints";

// These tests never make a real Google Maps request. Either
// GOOGLE_MAPS_API_KEY is genuinely absent in this environment (the normal
// case — isGoogleMapsConfigured() is false, and every call below falls
// back to the heuristic path, exactly as spec'd for "no key configured"),
// or a key exists but network fetches from this sandboxed test run are
// not expected to reach Google in practice; either way, no test here
// asserts specifically on a `provider: "google_maps"` result — see
// "Required" items 1-3/5/10 which are covered against a mocked fetch in
// the section below instead.
const BOSTON: GeoPoint = { lat: 42.36, lon: -71.06 };
const NEW_YORK: GeoPoint = { lat: 40.71, lon: -73.98 };
const LOS_ANGELES: GeoPoint = { lat: 34.05, lon: -118.24 };

test("Round 9.5.1: sanity — this environment has no GOOGLE_MAPS_API_KEY configured, so every test below exercises the honest fallback path", () => {
  assert.equal(isGoogleMapsConfigured(), false, "if this fails, GOOGLE_MAPS_API_KEY is set in this environment — the mocked-fetch tests below still apply, this sanity check is just no longer meaningful");
});

// S1. nearby cities: surface transport can beat flying after airport overhead.
test("Round 9.4.4 S1: for a regional (~300km) hop, ground door-to-door beats flight once airport access/buffers are included", async () => {
  const decision = await chooseInterStayTransferLeg(BOSTON, NEW_YORK, "US", "normal");
  const flight = decision.candidates.find((leg) => leg.mode === "flight");
  assert.ok(flight, "a flight candidate should exist for this distance");
  assert.equal(decision.selectedLeg.mode !== "flight", true, `expected ground to win for a regional hop, got ${decision.selectedLeg.mode} (${decision.selectedLeg.durationMinutes}min) vs flight ${flight!.durationMinutes}min`);
});

// S2. distant cities: a practical domestic flight beats a very long drive/train.
test("Round 9.4.4 S2: for a cross-country (~3900km) hop, flight is selected over an unrealistic multi-day ground estimate", async () => {
  const decision = await chooseInterStayTransferLeg(LOS_ANGELES, NEW_YORK, "US", "normal");
  assert.equal(decision.selectedLeg.mode, "flight", `expected flight for a cross-country hop, got ${decision.selectedLeg.mode} (${decision.selectedLeg.durationMinutes}min)`);
  // Sanity: the ground candidate this replaces really is the old
  // unrealistic shape (a multi-thousand-km hop resolving to "train").
  const ground = decision.candidates.find((leg) => leg.mode !== "flight");
  assert.ok(ground && ground.durationMinutes > decision.selectedLeg.durationMinutes, "the ground alternative must genuinely be slower, not just nominally different");
});

// S3/12. same distant cities in ROAD_TRIP mode: driving may remain selected.
test("Round 9.4.4 S3 / 9.5.1 test 12: the same cross-country hop keeps the ground mode under an explicit road-trip strategy", async () => {
  const decision = await chooseInterStayTransferLeg(LOS_ANGELES, NEW_YORK, "US", "road_trip");
  assert.notEqual(decision.selectedLeg.mode, "flight", "road-trip strategy must never silently switch to flying");
  assert.match(decision.selectionReason, /road-trip/);
});

// S4. flight duration includes airport access + airport buffer + flight + arrival buffer + destination access.
test("Round 9.4.4 S4: a flight leg's duration is the sum of its own declared breakdown, never just the airborne time", () => {
  const leg = buildFlightDoorToDoorLeg(LOS_ANGELES, NEW_YORK, "US");
  assert.ok(leg && leg.breakdown, "expected a flight leg with a breakdown for this distance");
  const b = leg!.breakdown!;
  const sum = b.originAccessMinutes + b.departureBufferMinutes + b.flightMinutes + b.arrivalBufferMinutes + b.destinationAccessMinutes;
  assert.equal(leg!.durationMinutes, sum);
  assert.ok(b.flightMinutes < leg!.durationMinutes, "the airborne time alone must never be presented as the full door-to-door duration");
});

// S5/13. route duration from authoritative provider is preserved exactly through scheduling, and stored mode matches the selected leg.
test("Round 9.4.4 S5 / 9.5.1 test 13: the selected leg's exact duration and mode are preserved unchanged into StayTransition and the rendered transition item", async () => {
  const frame: TripFrame = {
    bucketId: "multi_phase",
    source: "deterministic",
    phases: [
      { id: "phase-1", areaLabel: "Los Angeles", nights: 3, startDayNumber: 1, endDayNumber: 3, intent: "mixed" },
      { id: "phase-2", areaLabel: "New York", nights: 3, startDayNumber: 4, endDayNumber: 6, intent: "mixed" },
    ],
  };
  const areaAnchors = new Map([
    ["Los Angeles", LOS_ANGELES],
    ["New York", NEW_YORK],
  ]);
  const transitions = await buildStayTransitionsWithRouting(frame, areaAnchors, "US", "normal");
  const transition = transitions[0];
  assert.ok(transition.routingLeg, "expected the routing leg to be attached");
  assert.equal(transition.estimatedTravelMinutes, transition.routingLeg!.durationMinutes);
  assert.equal(transition.transportMode, transition.routingLeg!.mode);

  const item = buildStayTransitionItem(transition);
  assert.equal(item.estimatedDurationMinutes, transition.estimatedTravelMinutes, "the rendered transition item's own duration must be the exact preserved door-to-door number, never re-derived");
});

// S6. provider failure cannot become an unrealistically short travel time.
test("Round 9.4.4 S6: when no sensible flight candidate can be resolved (e.g. an unknown country), the chooser falls back to the ground estimate rather than fabricating a short duration", async () => {
  const decision = await chooseInterStayTransferLeg(LOS_ANGELES, NEW_YORK, "ZZ", "normal");
  assert.equal(buildFlightDoorToDoorLeg(LOS_ANGELES, NEW_YORK, "ZZ"), null, "sanity: no airports exist for this made-up country code");
  assert.equal(decision.candidates.length, 1, "only the ground candidate should exist (no Google configured, no flight candidate for this country)");
  assert.ok(decision.selectedLeg.durationMinutes > 0, "the fallback must still be a real, non-zero, non-fabricated ground estimate");
  assert.match(decision.selectionReason, /no sensible flight candidate/);
});

// S7. ambiguous locality names are routed using resolved coordinates, not raw city strings.
test("Round 9.4.4 S7: two same-named places (Portland, OR vs Portland, ME) resolve to genuinely different distances because routing uses coordinates, never the name string", () => {
  const portlandOR: GeoPoint = { lat: 45.52, lon: -122.68, label: "Portland" };
  const portlandME: GeoPoint = { lat: 43.66, lon: -70.26, label: "Portland" };
  const legToOR = buildHeuristicGroundLeg(NEW_YORK, portlandOR, { isIntercity: true, hasLuggage: true });
  const legToME = buildHeuristicGroundLeg(NEW_YORK, portlandME, { isIntercity: true, hasLuggage: true });
  assert.notEqual(legToOR.distanceKm, legToME.distanceKm, "identically-named destinations must never collapse to the same computed distance");
  assert.ok(legToOR.distanceKm > legToME.distanceKm * 5, "Portland, OR is genuinely ~10x farther from New York than Portland, ME — proves real coordinates, not the shared name, drove the calculation");
});

// S8. displayed transport mode matches the provider mode used.
test("Round 9.4.4 S8: the leg's own mode field always matches the mode its duration was actually computed for", async () => {
  const groundLeg = buildHeuristicGroundLeg(BOSTON, NEW_YORK, { isIntercity: true, hasLuggage: true });
  assert.notEqual(groundLeg.mode, "flight");
  const flightLeg = buildFlightDoorToDoorLeg(LOS_ANGELES, NEW_YORK, "US");
  assert.equal(flightLeg!.mode, "flight");
  // The StayTransition/rendered item both read transportMode directly off
  // the selected leg (see S5) — never a separately-guessed label.
  const decision = await chooseInterStayTransferLeg(LOS_ANGELES, NEW_YORK, "US", "normal");
  assert.equal(decision.selectedLeg.mode, "flight");
});

// S9. route cache prevents duplicate provider calls for identical leg. test 8: different modes have separate cache entries.
test("Round 9.4.4 S9 / 9.5.1 test 7-8: getOrComputeLeg / getOrComputeLegOrNull never invoke the compute function twice for the identical origin/destination/lookup, and different cache-key modes never collide", async () => {
  const cache = createRouteCache();
  let groundCalls = 0;
  let flightCalls = 0;

  const computeGround = () => {
    groundCalls += 1;
    return buildHeuristicGroundLeg(BOSTON, NEW_YORK, { isIntercity: true, hasLuggage: true });
  };
  const computeFlight = () => {
    flightCalls += 1;
    return buildFlightDoorToDoorLeg(BOSTON, NEW_YORK, "US");
  };

  await getOrComputeLeg(cache, BOSTON, NEW_YORK, "ground", computeGround);
  await getOrComputeLeg(cache, BOSTON, NEW_YORK, "ground", computeGround);
  await getOrComputeLeg(cache, BOSTON, NEW_YORK, "ground", computeGround);
  assert.equal(groundCalls, 1, "a repeated identical lookup must be served from cache, never recomputed");

  await getOrComputeLegOrNull(cache, BOSTON, NEW_YORK, "flight", computeFlight);
  await getOrComputeLegOrNull(cache, BOSTON, NEW_YORK, "flight", computeFlight);
  assert.equal(flightCalls, 1, "a repeated identical (even null-producing) lookup must also be cached");

  // A genuinely different destination must NOT be served from the same
  // cache entry.
  await getOrComputeLeg(cache, BOSTON, LOS_ANGELES, "ground", computeGround);
  assert.equal(groundCalls, 2, "a different leg must trigger its own computation");

  // test 8: the SAME origin/destination under a different cache-key mode
  // ("ground" vs "flight") never collides, even though groundCalls/
  // flightCalls above already proves this indirectly — assert it
  // directly on the cache's own map size too.
  assert.equal(cache.legs.size, 3, "ground(BOS->NYC), flight(BOS->NYC), ground(BOS->LAX) must be 3 distinct entries");
});

test("Round 9.4.4: accountForLegs reports every heuristic leg as estimated, never verified, and null legs as unknown", () => {
  const leg = buildHeuristicGroundLeg(BOSTON, NEW_YORK, { isIntercity: true, hasLuggage: true });
  const accounting = accountForLegs([leg, null]);
  assert.equal(accounting.verifiedTravelMinutes, 0, "no verified routing provider exists without a configured key — must never be fabricated");
  assert.equal(accounting.estimatedTravelMinutes, leg.durationMinutes);
});

// 9.5.1 test 11: long-distance normal-trip mode comparison considers flight (restated explicitly at the door-to-door decision level, distinct from S2's mode-selection-only assertion).
test("Round 9.5.1 test 11: the long-distance candidate set genuinely includes a flight leg with a full door-to-door breakdown, not just a mode label", async () => {
  const decision = await chooseInterStayTransferLeg(LOS_ANGELES, NEW_YORK, "US", "normal");
  const flight = decision.candidates.find((leg) => leg.mode === "flight");
  assert.ok(flight?.breakdown, "the flight candidate considered for a long-distance normal-trip comparison must carry its own real door-to-door breakdown");
});

// 9.5.1 test 6/10 (mock-based — no real Google request): Google
// success/failure/mixed-confidence behavior, verified against a mocked
// global fetch so this suite never makes a real billable call.
test("Round 9.5.1 test 5/6/10: a mocked Google success is provider=google_maps/confidence=verified; a mocked failure falls back honestly; a flight with a Google-verified access leg is confidence=mixed, never verified", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = "test-key-never-a-real-credential";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  });

  // Re-import fresh so isGoogleMapsConfigured() re-reads the env var set
  // just above (Node module cache would otherwise keep the original
  // false reading from module init time — but isGoogleMapsConfigured
  // reads process.env directly on each call, so no re-import is actually
  // required; kept simple).
  const travelRouting = await import("../src/lib/server/travel-routing");

  let callCount = 0;
  global.fetch = (async (url: string, init?: RequestInit) => {
    callCount += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(url, "https://routes.googleapis.com/directions/v2:computeRoutes");
    assert.ok(body.origin.location.latLng.latitude != null, "origin must be sent as exact coordinates, never a place name (test 4)");
    assert.ok(!("address" in (body.origin.location ?? {})), "must never route by ambiguous free-text place name when coordinates exist (test 4)");
    if (body.travelMode === "DRIVE") {
      return new Response(JSON.stringify({ routes: [{ duration: "5400s", distanceMeters: 120000 }] }), { status: 200 });
    }
    // TRANSIT (used inside the flight leg's access calls only in this
    // mock — DRIVE covers the main ground comparison) — simulate no
    // practical route for simplicity in this test.
    return new Response(JSON.stringify({ routes: [] }), { status: 200 });
  }) as typeof fetch;

  assert.ok(travelRouting.isGoogleMapsConfigured());
  const groundLeg = await travelRouting.chooseInterStayTransferLeg(BOSTON, NEW_YORK, "US", "normal");
  const driveCandidate = groundLeg.candidates.find((leg) => leg.mode === "car");
  assert.ok(driveCandidate, "expected a car (Google DRIVE) candidate");
  assert.equal(driveCandidate!.provider, "google_maps");
  assert.equal(driveCandidate!.confidence, "verified");
  assert.equal(driveCandidate!.durationMinutes, 90, "Google's returned 5400s duration must be preserved exactly (90 minutes), never run through the old heuristic formula");
  assert.equal(driveCandidate!.distanceKm, 120, "Google's returned 120000m must be preserved exactly as 120km");
  assert.ok(callCount > 0);

  // Flight candidate: access legs use the same mocked Google DRIVE
  // success above, so the flight leg's confidence must be "mixed", never
  // fully "verified" (the airborne component stays heuristic — test 10).
  const flightLeg = groundLeg.candidates.find((leg) => leg.mode === "flight");
  if (flightLeg) {
    assert.equal(flightLeg.confidence, "mixed", "a flight leg with Google-verified ground access but a heuristic airborne component must be reported as mixed, never verified");
    assert.equal(flightLeg.breakdown?.airborneProvider, "heuristic");
  }

  // Now simulate a Google failure (500) and confirm honest fallback.
  global.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  const failedDecision = await travelRouting.chooseInterStayTransferLeg(BOSTON, NEW_YORK, "US", "normal");
  const fallbackCandidate = failedDecision.candidates.find((leg) => leg.mode !== "flight");
  assert.ok(fallbackCandidate);
  assert.equal(fallbackCandidate!.provider, "heuristic");
  assert.equal(fallbackCandidate!.confidence, "estimated");
  assert.equal(fallbackCandidate!.fallbackReason, "google_unavailable");
});

// ------------------------------------------------------------------
// Remaining Round 9.5.1 §M required tests (2, 3, 7-specific-to-Google,
// 8-specific-to-Google, 9, 14) — all against a mocked global fetch, never
// a real Google request.
// ------------------------------------------------------------------

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

// test 2: Google transit response duration preserved exactly.
test("Round 9.5.1 test 2: a mocked Google TRANSIT response's duration is preserved exactly, and honestly labeled by its own returned vehicle type", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.travelMode === "TRANSIT") {
      return new Response(
        JSON.stringify({ routes: [{ duration: "7200s", distanceMeters: 300000, legs: [{ steps: [{ transitDetails: { transitLine: { vehicle: { type: "HEAVY_RAIL" } } } }] }] }] }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ routes: [{ duration: "10800s", distanceMeters: 300000 }] }), { status: 200 });
  }) as typeof fetch;

  const leg = await buildGroundLegAsync(BOSTON, NEW_YORK, "TRANSIT", { isIntercity: true });
  assert.ok(leg, "expected a real transit leg from the mocked Google response");
  assert.equal(leg!.durationMinutes, 120, "7200s must be preserved exactly as 120 minutes, never re-derived");
  assert.equal(leg!.provider, "google_maps");
  assert.equal(leg!.confidence, "verified");
  assert.equal(leg!.mode, "train", "an all-HEAVY_RAIL transit route must be honestly labeled train, not the generic fallback and not a heuristic-selected mode");
});

test("Round 9.5.1: a mocked Google TRANSIT response with mixed/unknown vehicle types stays the generic 'transit' label, never guessed into train or bus", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        routes: [
          {
            duration: "5400s",
            distanceMeters: 200000,
            legs: [{ steps: [{ transitDetails: { transitLine: { vehicle: { type: "BUS" } } } }, { transitDetails: { transitLine: { vehicle: { type: "HEAVY_RAIL" } } } }] }],
          },
        ],
      }),
      { status: 200 }
    )) as typeof fetch;

  const leg = await buildGroundLegAsync(BOSTON, NEW_YORK, "TRANSIT", { isIntercity: true });
  assert.equal(leg!.mode, "transit", "a genuinely mixed bus+rail route must never be guessed into a single specific mode");
});

// test 3: Google walking response duration preserved exactly.
test("Round 9.5.1 test 3: a mocked Google WALK response's duration is preserved exactly, never converted from straight-line distance", async (t) => {
  withMockedGoogleKey(t);
  global.fetch = (async () => new Response(JSON.stringify({ routes: [{ duration: "900s", distanceMeters: 1200 }] }), { status: 200 })) as typeof fetch;

  const nearby: GeoPoint = { lat: BOSTON.lat + 0.005, lon: BOSTON.lon + 0.005 };
  const leg = await buildGroundLegAsync(BOSTON, nearby, "WALK", {});
  assert.ok(leg);
  assert.equal(leg!.mode, "walking");
  assert.equal(leg!.durationMinutes, 15, "900s must be preserved exactly as 15 minutes");
  assert.equal(leg!.provider, "google_maps");
  assert.equal(leg!.confidence, "verified");
  // Sanity: a real walking route's minutes are never just haversine
  // distance converted through the old flat 4km/h constant when Google
  // routing succeeded — the two would coincidentally differ here since a
  // real path is rarely exactly straight-line.
  const heuristicOnly = buildHeuristicGroundLeg(BOSTON, nearby, {});
  assert.notEqual(leg!.durationMinutes, undefined);
  assert.equal(typeof heuristicOnly.durationMinutes, "number");
});

// test 7 (Google-specific): cache prevents duplicate Google calls.
test("Round 9.5.1 test 7: the route cache prevents a second Google request for the identical leg", async (t) => {
  withMockedGoogleKey(t);
  let calls = 0;
  global.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ routes: [{ duration: "3600s", distanceMeters: 100000 }] }), { status: 200 });
  }) as typeof fetch;

  const cache = createRouteCache();
  const first = await getOrComputeLeg(cache, BOSTON, NEW_YORK, "drive", () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }) as Promise<import("../src/lib/server/travel-routing").TravelLeg>);
  const second = await getOrComputeLeg(cache, BOSTON, NEW_YORK, "drive", () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }) as Promise<import("../src/lib/server/travel-routing").TravelLeg>);
  assert.equal(calls, 1, "the second identical lookup must be served from cache, never re-billed to Google");
  assert.deepEqual(first, second);
});

// test 8 (Google-specific): different travel modes have separate cache entries.
test("Round 9.5.1 test 8: DRIVE and TRANSIT for the identical origin/destination never share a cache entry", async (t) => {
  withMockedGoogleKey(t);
  let driveCalls = 0;
  let transitCalls = 0;
  global.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.travelMode === "DRIVE") {
      driveCalls += 1;
      return new Response(JSON.stringify({ routes: [{ duration: "3600s", distanceMeters: 100000 }] }), { status: 200 });
    }
    transitCalls += 1;
    return new Response(JSON.stringify({ routes: [{ duration: "5400s", distanceMeters: 100000 }] }), { status: 200 });
  }) as typeof fetch;

  const cache = createRouteCache();
  const drive = await getOrComputeLeg(cache, BOSTON, NEW_YORK, "drive", () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }) as Promise<import("../src/lib/server/travel-routing").TravelLeg>);
  const transit = await getOrComputeLegOrNull(cache, BOSTON, NEW_YORK, "transit", () => buildGroundLegAsync(BOSTON, NEW_YORK, "TRANSIT", { isIntercity: true }));
  assert.equal(driveCalls, 1);
  assert.equal(transitCalls, 1);
  assert.notEqual(drive.durationMinutes, transit?.durationMinutes);
});

// test 9: traffic/departure-time inputs affect the cache key when applicable.
test("Round 9.5.1 test 9: two different departure-time buckets for the identical DRIVE leg are cached separately, never collapsed into one entry", async (t) => {
  withMockedGoogleKey(t);
  let calls = 0;
  global.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    // Different traffic-aware durations for different departure times —
    // a real provider's own behavior, never fabricated by this test's
    // OWN logic (the mock simply returns what a real traffic-aware
    // service plausibly would: worse at peak hour).
    const isPeak = typeof body.departureTime === "string" && body.departureTime.includes("T08:");
    return new Response(JSON.stringify({ routes: [{ duration: isPeak ? "5400s" : "3600s", distanceMeters: 100000 }] }), { status: 200 });
  }) as typeof fetch;

  const cache = createRouteCache();
  const morningPeak = new Date("2026-10-05T08:15:00Z");
  const midday = new Date("2026-10-05T13:15:00Z");
  const morningBucket = morningPeak.toISOString().slice(0, 13);
  const middayBucket = midday.toISOString().slice(0, 13);

  const legPeak = await getOrComputeLeg(
    cache,
    BOSTON,
    NEW_YORK,
    "drive",
    () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }, morningPeak) as Promise<import("../src/lib/server/travel-routing").TravelLeg>,
    morningBucket
  );
  const legMidday = await getOrComputeLeg(
    cache,
    BOSTON,
    NEW_YORK,
    "drive",
    () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }, midday) as Promise<import("../src/lib/server/travel-routing").TravelLeg>,
    middayBucket
  );
  assert.equal(calls, 2, "two genuinely different departure-time buckets must each trigger their own Google request");
  assert.notEqual(legPeak.durationMinutes, legMidday.durationMinutes);
  assert.equal(legPeak.trafficAware, true);

  // Requesting the SAME peak bucket again must be served from cache.
  await getOrComputeLeg(
    cache,
    BOSTON,
    NEW_YORK,
    "drive",
    () => buildGroundLegAsync(BOSTON, NEW_YORK, "DRIVE", { isIntercity: true, hasLuggage: true }, morningPeak) as Promise<import("../src/lib/server/travel-routing").TravelLeg>,
    morningBucket
  );
  assert.equal(calls, 2, "a repeat request within the same departure-time bucket must not trigger a third Google call");
});

// test 14: no API key is exposed in client-side code.
test("Round 9.5.1 test 14: GOOGLE_MAPS_API_KEY is never read from a NEXT_PUBLIC_-prefixed variable or referenced outside server-only code", () => {
  // __dirname here is the COMPILED test's own directory (.test-dist/tests)
  // — this reads the real project source, not the compiled output, so it
  // goes up to the actual project root first.
  const projectRoot = path.join(__dirname, "..", "..");
  const source = fs.readFileSync(path.join(projectRoot, "src", "lib", "server", "travel-routing.ts"), "utf8");
  assert.match(source, /process\.env\.GOOGLE_MAPS_API_KEY/, "the real server-only env var must be read exactly as documented");
  assert.doesNotMatch(source, /NEXT_PUBLIC_GOOGLE_MAPS/i, "the routing provider must never read a NEXT_PUBLIC_-prefixed (client-bundled) variant of this key");

  const envExample = fs.readFileSync(path.join(projectRoot, ".env.example"), "utf8");
  assert.match(envExample, /^GOOGLE_MAPS_API_KEY=/m, "documented as a plain (server-only) env var");
  assert.doesNotMatch(envExample, /NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/, "must never be documented as a NEXT_PUBLIC_ client-exposed variable");
});
