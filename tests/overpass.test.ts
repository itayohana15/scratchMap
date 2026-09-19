import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOverpass,
  getOverpassCallStats,
  getOverpassUserAgent,
  OVERPASS_ENDPOINTS,
  recordOverpassCall,
  resetOverpassCallStats,
  queryNearbyRecommendations,
  queryNearbyRecommendationsDetailed,
} from "../src/lib/places/overpass";

// Pure counter logic only — no real network call.

test("resetOverpassCallStats zeroes both counters", () => {
  recordOverpassCall(true);
  recordOverpassCall(false);
  resetOverpassCallStats();
  assert.deepEqual(getOverpassCallStats(), { totalCalls: 0, failedCalls: 0 });
});

test("recordOverpassCall counts every call as total, only failures as failed", () => {
  resetOverpassCallStats();
  recordOverpassCall(true);
  recordOverpassCall(true);
  recordOverpassCall(false);
  assert.deepEqual(getOverpassCallStats(), { totalCalls: 3, failedCalls: 1 });
});

test("recordOverpassCall(false) never increments succeeded-only state — every call counts toward total", () => {
  resetOverpassCallStats();
  recordOverpassCall(false);
  recordOverpassCall(false);
  const stats = getOverpassCallStats();
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.failedCalls, 2);
});

// --- fetchOverpass: endpoint fallback / User-Agent / timeout -------------
// Fully mocked via an injected fetchImpl — no real network, no dependency
// on Overpass's own availability. fetchOverpass is the ONE transport every
// real caller (checkOverpassAvailability, executeOverpassQuery,
// queryNearbyPlaces) goes through, so testing it directly covers their
// real behavior.

type MockCall = { endpoint: string; init: RequestInit & { next?: { revalidate: number } } };
type MockBehavior =
  | { type: "success"; status?: number; body?: unknown }
  | { type: "http-error"; status: number }
  | { type: "network-error"; message?: string }
  | { type: "hang" };

function createMockFetch(behaviors: MockBehavior[]) {
  const calls: MockCall[] = [];
  let index = 0;
  const fetchImpl = (async (endpoint: string, init: RequestInit & { next?: { revalidate: number } }) => {
    calls.push({ endpoint, init });
    const behavior = behaviors[Math.min(index, behaviors.length - 1)];
    index += 1;

    if (behavior.type === "hang") {
      // Never resolves on its own — only rejects when the real
      // AbortController (fetchOverpass's own timeout) actually fires,
      // exercising the genuine timeout path rather than simulating one.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    if (behavior.type === "network-error") {
      throw new Error(behavior.message ?? "simulated network error");
    }
    const status = behavior.type === "http-error" ? behavior.status : (behavior.status ?? 200);
    const ok = status >= 200 && status < 300;
    const body = behavior.type === "success" ? (behavior.body ?? { elements: [] }) : {};
    return { ok, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("fetchOverpass: 1. primary endpoint success -> no fallback", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "success" }]);
  const outcome = await fetchOverpass("[out:json];node(1);out;", { fetchImpl });
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.kind === "success" ? outcome.endpoint : null, OVERPASS_ENDPOINTS[0]);
  assert.equal(calls.length, 1);
});

test("fetchOverpass: 2. primary network failure -> fallback endpoint used", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "network-error" }, { type: "success" }]);
  const outcome = await fetchOverpass("q", { fetchImpl });
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.kind === "success" ? outcome.endpoint : null, OVERPASS_ENDPOINTS[1]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endpoint, OVERPASS_ENDPOINTS[0]);
  assert.equal(calls[1].endpoint, OVERPASS_ENDPOINTS[1]);
});

test("fetchOverpass: 3. primary timeout -> fallback endpoint used", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "hang" }, { type: "success" }]);
  const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 50 });
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.kind === "success" ? outcome.endpoint : null, OVERPASS_ENDPOINTS[1]);
  assert.equal(calls.length, 2);
});

test("fetchOverpass: 4. primary 429 -> fallback endpoint used", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "http-error", status: 429 }, { type: "success" }]);
  const outcome = await fetchOverpass("q", { fetchImpl });
  assert.equal(outcome.kind, "success");
  assert.equal(calls.length, 2);
});

test("fetchOverpass: 5. primary 5xx -> fallback endpoint used", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "http-error", status: 503 }, { type: "success" }]);
  const outcome = await fetchOverpass("q", { fetchImpl });
  assert.equal(outcome.kind, "success");
  assert.equal(calls.length, 2);
});

test("fetchOverpass: 6. invalid/non-retryable 4xx -> no pointless endpoint storm", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "http-error", status: 400 }, { type: "success" }]);
  const outcome = await fetchOverpass("malformed query", { fetchImpl });
  assert.equal(outcome.kind, "failure");
  assert.equal(calls.length, 1, "a malformed query fails identically everywhere — must not try the second endpoint");
});

test("fetchOverpass: 7. a real User-Agent is present on every request", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "network-error" }, { type: "success" }]);
  await fetchOverpass("q", { fetchImpl });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const userAgent = (call.init.headers as Record<string, string>)["User-Agent"];
    assert.equal(userAgent, getOverpassUserAgent());
    assert.ok(userAgent.length > 0);
    assert.ok(!userAgent.includes("example.com"), "must never be a fabricated contact address");
  }
});

test("fetchOverpass: 8. all endpoints fail -> clean failure outcome, no throw, bounded attempts", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "network-error" }, { type: "http-error", status: 500 }]);
  const outcome = await fetchOverpass("q", { fetchImpl });
  assert.equal(outcome.kind, "failure");
  assert.equal(calls.length, OVERPASS_ENDPOINTS.length, "never more attempts than configured endpoints — no retry storm");
});

test("fetchOverpass: 9. the existing 24h caching option is still passed through on success", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "success" }]);
  await fetchOverpass("q", { fetchImpl, next: { revalidate: 60 * 60 * 24 } });
  assert.deepEqual(calls[0].init.next, { revalidate: 60 * 60 * 24 });
});

// --- Round 9: queryNearbyRecommendations (stay-scoped refill query) ------

test("queryNearbyRecommendations: parses elements into per-category recommendations, deduped and capped", async () => {
  const body = {
    elements: [
      { type: "node", lat: 10.001, lon: 10.001, tags: { name: "City Museum", tourism: "museum", opening_hours: "09:00-18:00" } },
      { type: "node", lat: 10.002, lon: 10.002, tags: { name: "City Museum", tourism: "museum" } }, // duplicate name -> deduped
      { type: "node", lat: 10.003, lon: 10.003, tags: { name: "Grand Bazaar", shop: "mall" } },
      { type: "node", lat: 10.004, lon: 10.004, tags: { name: "Unrelated Bank", amenity: "bank" } }, // matches no requested category filter
    ],
  };
  const { fetchImpl, calls } = createMockFetch([{ type: "success", body }]);
  const results = await queryNearbyRecommendations(10, 10, 5000, ["museum", "shopping"], 5, { fetchImpl, areaLabelForLocation: "Area A" });

  assert.equal(calls.length, 1, "one combined query, not one per category");
  assert.deepEqual(
    results.map((r) => r.name).sort(),
    ["City Museum", "Grand Bazaar"]
  );
  const museum = results.find((r) => r.name === "City Museum")!;
  assert.equal(museum.category, "museum");
  assert.equal(museum.location, "Area A");
  assert.equal(museum.openingHours, "09:00-18:00");
});

test("queryNearbyRecommendations: an unrequested/unmapped category never has its own tag filter sent", async () => {
  const { fetchImpl, calls } = createMockFetch([{ type: "success" }]);
  await queryNearbyRecommendations(10, 10, 5000, ["hidden_gem"], 5, { fetchImpl }); // hidden_gem has no CATEGORY_TAG_FILTERS entry
  assert.equal(calls.length, 0, "no query is even sent when no requested category has a real tag mapping");
});

test("queryNearbyRecommendations: a provider failure returns an empty array, never throws", async () => {
  const { fetchImpl } = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const results = await queryNearbyRecommendations(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.deepEqual(results, []);
});

test("queryNearbyRecommendations: caps results per category at perCategoryLimit", async () => {
  const body = {
    elements: Array.from({ length: 10 }, (_, i) => ({
      type: "node",
      lat: 10 + i * 0.001,
      lon: 10,
      tags: { name: `Museum ${i}`, tourism: "museum" },
    })),
  };
  const { fetchImpl } = createMockFetch([{ type: "success", body }]);
  const results = await queryNearbyRecommendations(10, 10, 5000, ["museum"], 3, { fetchImpl });
  assert.equal(results.length, 3);
});

// --- Round 9.3.3: queryNearbyRecommendationsDetailed — provider failure vs
// true zero-supply must be distinguishable, never collapsed into the same
// empty array the way plain queryNearbyRecommendations still does. ---

test("Round 9.3.3: queryNearbyRecommendationsDetailed reports providerFailed:true when every endpoint fails, not just an empty result", async () => {
  const { fetchImpl } = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const outcome = await queryNearbyRecommendationsDetailed(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.providerFailed, true);
  assert.ok(outcome.failureReason, "a failure must always carry a reason, never a silent unexplained empty result");
});

test("Round 9.3.3: queryNearbyRecommendationsDetailed reports providerFailed:false when the provider genuinely returns zero elements", async () => {
  const { fetchImpl } = createMockFetch([{ type: "success", body: { elements: [] } }]);
  const outcome = await queryNearbyRecommendationsDetailed(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.deepEqual(outcome.results, []);
  assert.equal(outcome.providerFailed, false, "a real HTTP 200 with zero elements is true low supply, not a provider failure");
  assert.equal(outcome.rawElementCount, 0);
});

test("Round 9.3.3: queryNearbyRecommendationsDetailed reports the raw element count even when most elements are discarded", async () => {
  const body = {
    elements: [
      { type: "node", lat: 10.001, lon: 10.001, tags: { name: "City Museum", tourism: "museum" } },
      { type: "node", lat: 10.002, lon: 10.002, tags: { amenity: "bank" } }, // no name -> discarded
      { type: "node", tags: { name: "No Coordinates", tourism: "museum" } }, // no lat/lon at all -> discarded
    ],
  };
  const { fetchImpl } = createMockFetch([{ type: "success", body }]);
  const outcome = await queryNearbyRecommendationsDetailed(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.equal(outcome.rawElementCount, 3, "raw count reflects every element the provider returned, before any discard");
  assert.equal(outcome.results.length, 1, "only the one genuinely valid, named, located element survives");
  assert.equal(outcome.providerFailed, false);
});

test("Round 9.3.3: queryNearbyRecommendations (the never-throws wrapper) still returns a plain empty array on provider failure", async () => {
  const { fetchImpl } = createMockFetch([{ type: "network-error" }, { type: "network-error" }]);
  const results = await queryNearbyRecommendations(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.deepEqual(results, [], "existing callers of the plain function must see no behavior change");
});
