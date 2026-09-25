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
  beginOverpassSession,
  endOverpassSession,
  getOverpassCircuitState,
  getOverpassSessionSummary,
  classifyOverpassFailureReason,
  MIN_OVERPASS_ATTEMPT_BUDGET_MS,
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
  | { type: "hang" }
  // Round 9.6.6 §8 test 1/2 — a genuinely stuck transport that never
  // settles AND never reacts to AbortSignal at all (no listener attached),
  // the exact real-world shape a stuck TCP connection can take. Distinct
  // from "hang" above, which DOES resolve once abort() fires — this one
  // must be bounded purely by the caller's own hard deadline race.
  | { type: "hang-ignore-abort" }
  // Round 9.6.6 §8 test 3/4 — settles long after any reasonable deadline,
  // to prove a late settlement is safely absorbed and never mutates an
  // already-returned result.
  | { type: "late-reject"; delayMs: number; message?: string }
  | { type: "late-success"; delayMs: number; body?: unknown };

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
    if (behavior.type === "hang-ignore-abort") {
      // Never resolves, never listens for abort at all — the exact "stuck
      // TCP connection" shape AbortController alone cannot bound.
      return new Promise<Response>(() => {});
    }
    if (behavior.type === "late-reject") {
      return new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new Error(behavior.message ?? "late simulated network error")), behavior.delayMs);
      });
    }
    if (behavior.type === "late-success") {
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve({ ok: true, status: 200, json: async () => behavior.body ?? { elements: [] } } as unknown as Response), behavior.delayMs);
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

/* ==================================================================== *
 * ROUND 9.6.6 — OVERPASS LATENCY CONTAINMENT / FAIL-FAST BOUNDARY       *
 * ==================================================================== */

// Test 1 — fetch never resolves: caller returns within hard deadline.
test("Round 9.6.6 test 1: a fetch that never resolves still returns within the hard deadline", async () => {
  const { fetchImpl } = createMockFetch([{ type: "hang-ignore-abort" }, { type: "hang-ignore-abort" }]);
  const start = Date.now();
  const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 60 });
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "failure");
  assert.ok(elapsed < 2000, `expected to return well within the hard deadline (2 endpoints x 60ms), took ${elapsed}ms`);
});

// Test 2 — fetch ignores AbortSignal entirely: caller still returns within hard deadline.
test("Round 9.6.6 test 2: a fetch that ignores AbortSignal entirely still returns within the hard deadline", async () => {
  const { fetchImpl } = createMockFetch([{ type: "hang-ignore-abort" }]);
  const start = Date.now();
  const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 50, endpoints: ["https://only-endpoint.example/api"] });
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.kind === "failure" ? outcome.failureCategory : null, "OVERPASS_TIMEOUT");
  assert.ok(elapsed < 500, `must not wait materially beyond the configured 50ms deadline, took ${elapsed}ms`);
});

// Test 3 — late fetch rejection: no unhandled rejection.
test("Round 9.6.6 test 3: a fetch that rejects long after the hard deadline never produces an unhandled rejection", async () => {
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { fetchImpl } = createMockFetch([{ type: "late-reject", delayMs: 150 }]);
    const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 30, endpoints: ["https://only-endpoint.example/api"] });
    assert.equal(outcome.kind, "failure");
    // Give the late rejection time to actually fire and be (safely) absorbed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(unhandled, false, "a late rejection from an already-abandoned attempt must never surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// Test 4 — late fetch success: cannot mutate already-completed discovery result.
test("Round 9.6.6 test 4: a fetch that succeeds long after the hard deadline cannot change the already-returned result", async () => {
  const { fetchImpl } = createMockFetch([{ type: "late-success", delayMs: 150, body: { elements: [{ type: "node", lat: 1, lon: 1, tags: { name: "Late Place", tourism: "museum" } }] } }]);
  const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 30, endpoints: ["https://only-endpoint.example/api"] });
  assert.equal(outcome.kind, "failure", "the caller must have already moved on with a timeout result");
  // Wait past the late success to confirm nothing retroactively changes.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(outcome.kind, "failure", "the already-returned outcome object must never be mutated by a later-settling promise");
});

// Test 5 — remaining global budget < configured timeout: effective timeout uses remaining budget.
test("Round 9.6.6 test 5: a remaining session budget smaller than the configured timeout clamps the effective timeout", async () => {
  const { fetchImpl } = createMockFetch([{ type: "hang-ignore-abort" }]);
  // Deliberately ABOVE MIN_OVERPASS_ATTEMPT_BUDGET_MS (2000ms) so this
  // exercises the CLAMP specifically, distinct from test 6's "skip below
  // the sane minimum" path — a budget below the minimum would short-circuit
  // before ever reaching the effective-timeout computation at all.
  const remainingBudgetMs = MIN_OVERPASS_ATTEMPT_BUDGET_MS + 500;
  beginOverpassSession(Date.now() + remainingBudgetMs);
  try {
    const start = Date.now();
    const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 20_000, endpoints: ["https://only-endpoint.example/api"] });
    const elapsed = Date.now() - start;
    assert.equal(outcome.kind, "failure");
    assert.ok(elapsed < remainingBudgetMs + 1000, `effective timeout must have been clamped to the ~${remainingBudgetMs}ms remaining budget, not the configured 20s, took ${elapsed}ms`);
  } finally {
    endOverpassSession();
  }
});

// Test 6 — zero remaining budget: no Overpass request starts.
test("Round 9.6.6 test 6: a remaining session budget below the sane minimum skips the request entirely", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return { ok: true, status: 200, json: async () => ({ elements: [] }) } as unknown as Response; }) as unknown as typeof fetch;
  beginOverpassSession(Date.now() + 10); // far below MIN_OVERPASS_ATTEMPT_BUDGET_MS
  try {
    const outcome = await fetchOverpass("q", { fetchImpl });
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.kind === "failure" ? outcome.failureCategory : null, "OVERPASS_BUDGET_EXHAUSTED");
    assert.equal(called, false, "no network request may even start when the remaining budget is below the sane minimum");
  } finally {
    endOverpassSession();
  }
});

// Test 7 — repeated timeouts: generation-scoped circuit opens.
test("Round 9.6.6 test 7: repeated timeout/network failures open the generation-scoped circuit", async () => {
  const { fetchImpl } = createMockFetch([{ type: "hang-ignore-abort" }]);
  beginOverpassSession(null);
  try {
    assert.equal(getOverpassCircuitState(), "HEALTHY");
    for (let i = 0; i < 4; i += 1) {
      await fetchOverpass("q", { fetchImpl, timeoutMs: 20, endpoints: ["https://only-endpoint.example/api"] });
    }
    assert.equal(getOverpassCircuitState(), "UNAVAILABLE", "enough consecutive failures must open the circuit");
  } finally {
    endOverpassSession();
  }
});

// Test 8 — circuit open: later stays/categories skip Overpass immediately.
test("Round 9.6.6 test 8: once the circuit is open, a later call skips Overpass immediately with no network attempt", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; throw new Error("must never be called"); }) as unknown as typeof fetch;
  beginOverpassSession(null);
  try {
    const { fetchImpl: hangingFetch } = createMockFetch([{ type: "hang-ignore-abort" }]);
    for (let i = 0; i < 4; i += 1) {
      await fetchOverpass("q", { fetchImpl: hangingFetch, timeoutMs: 20, endpoints: ["https://only-endpoint.example/api"] });
    }
    assert.equal(getOverpassCircuitState(), "UNAVAILABLE");
    const start = Date.now();
    const outcome = await fetchOverpass("q", { fetchImpl, timeoutMs: 20_000 });
    const elapsed = Date.now() - start;
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.kind === "failure" ? outcome.failureCategory : null, "OVERPASS_CIRCUIT_OPEN");
    assert.equal(called, false, "an open circuit must skip the network attempt entirely, not just fail fast after trying");
    assert.ok(elapsed < 200, "a circuit-open skip must be immediate");
  } finally {
    endOverpassSession();
  }
});

// Test 9 — new generation: circuit starts healthy again.
test("Round 9.6.6 test 9: a new generation's Overpass session always starts HEALTHY regardless of a previous one's circuit state", async () => {
  const { fetchImpl } = createMockFetch([{ type: "hang-ignore-abort" }]);
  beginOverpassSession(null);
  for (let i = 0; i < 4; i += 1) {
    await fetchOverpass("q", { fetchImpl, timeoutMs: 20, endpoints: ["https://only-endpoint.example/api"] });
  }
  assert.equal(getOverpassCircuitState(), "UNAVAILABLE");
  endOverpassSession();

  beginOverpassSession(null);
  try {
    assert.equal(getOverpassCircuitState(), "HEALTHY", "a later generation must never inherit a previous one's open circuit — no permanent/global blacklisting");
  } finally {
    endOverpassSession();
  }
});

// Test 10 — HTTP 504: counted distinctly from timeout.
test("Round 9.6.6 test 10: an HTTP 504 is classified distinctly from a timeout", async () => {
  const { fetchImpl } = createMockFetch([{ type: "http-error", status: 504 }, { type: "http-error", status: 504 }]);
  beginOverpassSession(null);
  try {
    await fetchOverpass("q", { fetchImpl });
    const summary = getOverpassSessionSummary();
    assert.equal(summary.overpassHttpErrors, 2);
    assert.equal(summary.overpassTimeouts, 0, "an HTTP error must never be counted as a timeout");
  } finally {
    endOverpassSession();
  }
});

test("Round 9.6.6 test 10b: classifyOverpassFailureReason distinguishes every failure category", () => {
  assert.equal(classifyOverpassFailureReason("timeout", undefined), "OVERPASS_TIMEOUT");
  assert.equal(classifyOverpassFailureReason("HTTP 504", 504), "OVERPASS_HTTP_ERROR");
  assert.equal(classifyOverpassFailureReason("some network failure", undefined), "OVERPASS_NETWORK_ERROR");
  assert.equal(classifyOverpassFailureReason("budget_exhausted", undefined), "OVERPASS_BUDGET_EXHAUSTED");
  assert.equal(classifyOverpassFailureReason("circuit_open", undefined), "OVERPASS_CIRCUIT_OPEN");
});

// Test 11 — genuine zero result: not classified as provider failure.
test("Round 9.6.6 test 11: a genuine HTTP 200 with zero elements is never classified as a provider failure", async () => {
  const { fetchImpl } = createMockFetch([{ type: "success", body: { elements: [] } }]);
  const outcome = await queryNearbyRecommendationsDetailed(10, 10, 5000, ["museum"], 5, { fetchImpl });
  assert.equal(outcome.providerFailed, false);
  assert.equal(outcome.failureCategory, null, "only a real failure carries a failureCategory — a genuine empty answer must never be labeled OVERPASS_ZERO_RESULTS as if it were a failure state");
});

test("Round 9.6.6: MIN_OVERPASS_ATTEMPT_BUDGET_MS is a small, sane, positive bound", () => {
  assert.ok(MIN_OVERPASS_ATTEMPT_BUDGET_MS > 0);
  assert.ok(MIN_OVERPASS_ATTEMPT_BUDGET_MS < 10_000);
});
