// Server-only helper around OpenStreetMap's free Overpass API. Used instead
// of asking an LLM to invent place names/prices/hours — every field here
// comes straight from real OSM tags, or is left null/empty when the tag
// doesn't exist (the UI already renders "not available" copy for that case).
import { readFile } from "node:fs/promises";
import path from "node:path";

import { captureProviderFixture } from "@/lib/server/fixture-capture";
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";
import type { RecommendationCategory } from "@/lib/trip-workspace";

// Real production outage found via a live QA run: overpass-api.de was
// unreachable (connection refused) from the deployment environment while
// an independent mirror (kumi.systems) was reachable but rejected requests
// with HTTP 429 — "Please include a meaningful User-Agent string with your
// requests to avoid rate-limiting" — until one was sent. Two fixes, one
// change: every request now carries a real User-Agent (getOverpassUserAgent
// below) AND falls back across configured endpoints instead of depending
// on a single instance. Order matters — the existing primary stays first.
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Same real, non-fake User-Agent convention already established for
// Nominatim (places/nominatim.ts) — Overpass's own usage policy explicitly
// asks for exactly this ("a meaningful User-Agent... to avoid
// rate-limiting"), confirmed live: the same request without one gets 429
// from kumi.systems, 200 with one. OVERPASS_USER_AGENT lets a real
// deployment override with its own contact/URL if it has one; the default
// never fabricates one.
const DEFAULT_OVERPASS_USER_AGENT = "ScratchMap/1.0 (personal travel-tracking app, single user, low volume)";

export function getOverpassUserAgent(): string {
  return process.env.OVERPASS_USER_AGENT?.trim() || DEFAULT_OVERPASS_USER_AGENT;
}

// Country-wide area queries against the public Overpass instance can take
// 10-20s; we lean on the 24h cache below so only the first load per
// country+category ever pays that cost.
const REQUEST_TIMEOUT_MS = 25_000;

/* ================================================================== *
 * Round 9.6.6 — OVERPASS LATENCY CONTAINMENT.                          *
 *                                                                       *
 * ROOT CAUSE (see Round 9.6.6 investigation): fetchOverpassOnce's own   *
 * AbortController/setTimeout only ever ASKS the underlying transport    *
 * to stop — it never itself bounds how long `await fetchImpl(...)`      *
 * takes to actually settle. In this sandbox, a genuinely stuck TCP      *
 * connection attempt does not reliably honor AbortSignal within any     *
 * useful window, so `await fetchImpl(...)` can hang far past            *
 * `timeoutMs` — a live bounded validation observed ~13 minutes against  *
 * a configured 25s timeout. The generation-level `deadline` check       *
 * elsewhere in this codebase only ever gates STARTING a new call; it    *
 * never bounds one already in flight, so it could not help either.      *
 *                                                                        *
 * Fix, in order: (1) a hard Promise.race at the single-attempt level    *
 * so the caller regains control at `timeoutMs` regardless of whether    *
 * the transport ever actually settles; (2) deadline propagation, so an  *
 * attempt started with little generation budget left gets a smaller     *
 * effective timeout, or is skipped outright below a sane minimum;       *
 * (3) a generation-scoped circuit breaker so repeated failures stop     *
 * paying the same timeout for every later stay/category and let the     *
 * (already-implemented) Google Places fallback take over promptly.      *
 * ================================================================== */

export type OverpassCircuitState = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

/** Consecutive network/timeout failures before the circuit degrades, then opens. Non-retryable HTTP errors (a malformed query) never count — they are a property of the request, not evidence Overpass itself is unhealthy. */
const CIRCUIT_DEGRADE_AFTER = 2;
const CIRCUIT_OPEN_AFTER = 4;

/** Never start (or continue into a second endpoint for) an attempt that cannot get at least this much real wall-clock time — a 200ms attempt is never worth the overhead; it is more honest to skip and let a secondary provider be evaluated immediately. */
export const MIN_OVERPASS_ATTEMPT_BUDGET_MS = 2_000;

export type OverpassFailureCategory =
  | "OVERPASS_TIMEOUT"
  | "OVERPASS_NETWORK_ERROR"
  | "OVERPASS_HTTP_ERROR"
  | "OVERPASS_ZERO_RESULTS"
  | "OVERPASS_BUDGET_EXHAUSTED"
  | "OVERPASS_CIRCUIT_OPEN";

/** Pure classifier — every OTHER failure category besides OVERPASS_ZERO_RESULTS remains eligible for secondary-provider fallback (spec §6); this function only ever LABELS a failure, it never decides fallback eligibility itself (that stays the caller's own providerFailed-style boolean, unchanged). */
export function classifyOverpassFailureReason(reason: string, status: number | undefined | null): OverpassFailureCategory {
  if (reason === "budget_exhausted") return "OVERPASS_BUDGET_EXHAUSTED";
  if (reason === "circuit_open") return "OVERPASS_CIRCUIT_OPEN";
  if (reason === "timeout") return "OVERPASS_TIMEOUT";
  if (status != null) return "OVERPASS_HTTP_ERROR";
  return "OVERPASS_NETWORK_ERROR";
}

interface OverpassSessionCounters {
  overpassTimeouts: number;
  overpassNetworkErrors: number;
  overpassHttpErrors: number;
  overpassCircuitOpenSkips: number;
  overpassBudgetSkips: number;
  overpassWallClockMs: number;
  googleFallbacksTriggeredAfterOverpassFailure: number;
}

interface OverpassSession {
  /** ms epoch; null = no generation-scoped deadline tracked (every existing caller that never opts in behaves exactly as before). */
  deadlineAt: number | null;
  circuitState: OverpassCircuitState;
  consecutiveFailures: number;
  counters: OverpassSessionCounters;
}

function createOverpassSessionCounters(): OverpassSessionCounters {
  return {
    overpassTimeouts: 0,
    overpassNetworkErrors: 0,
    overpassHttpErrors: 0,
    overpassCircuitOpenSkips: 0,
    overpassBudgetSkips: 0,
    overpassWallClockMs: 0,
    googleFallbacksTriggeredAfterOverpassFailure: 0,
  };
}

// Module-level, but generation-SCOPED (spec §5 "do not create permanent/
// global process blacklisting") — begin/end around one generateCountryItineraryPlan
// call, the same pattern real-place-qa.ts's trace context already uses for
// an identical reason (cross-cutting, per-generation state that many deep
// call sites need without threading a new parameter through every one of
// them). A later generation always starts HEALTHY again.
let currentSession: OverpassSession | null = null;

/** `deadlineAt`: an absolute Date.now()-comparable ms timestamp — pass the SAME value already used for the caller's own generation-wide discovery deadline. Omit (or pass null) for a caller that wants the circuit breaker but no deadline propagation. */
export function beginOverpassSession(deadlineAt: number | null = null): void {
  currentSession = { deadlineAt, circuitState: "HEALTHY", consecutiveFailures: 0, counters: createOverpassSessionCounters() };
}

export function endOverpassSession(): void {
  currentSession = null;
}

/**
 * Round 9.15.4 §B/§C — grants a bounded, LATER floor to the current
 * session's own deadline without resetting anything else about it (circuit
 * state, consecutive-failure count, and accumulated counters all survive
 * untouched) — deliberately NOT a call to beginOverpassSession again, which
 * would wipe those and understate the final OverpassLatencySummary. Used
 * exactly once, by the nature-trail discovery reserved-budget fix: the
 * caller's own function-level deadline check already decided a bounded
 * floor is warranted (a real nature/hiking/mountains preference), so this
 * only ever makes the session's internal remainingBudgetMs math agree with
 * that same decision — never an independent source of extra time. A no-op
 * when no session is active, or when the requested deadline is not later
 * than what the session already has.
 */
export function extendOverpassSessionDeadline(newDeadlineAt: number): void {
  if (!currentSession) return;
  if (currentSession.deadlineAt == null || newDeadlineAt > currentSession.deadlineAt) {
    currentSession.deadlineAt = newDeadlineAt;
  }
}

export function getOverpassCircuitState(): OverpassCircuitState {
  return currentSession?.circuitState ?? "HEALTHY";
}

/** Observability only — a snapshot for the generation-summary log (spec §7); never read by any planning decision. */
export function getOverpassSessionSummary(): OverpassSessionCounters & { circuitState: OverpassCircuitState } {
  return { ...(currentSession?.counters ?? createOverpassSessionCounters()), circuitState: currentSession?.circuitState ?? "HEALTHY" };
}

/** Called once, from the discovery orchestration, the moment it decides a Google Places fallback was reachable specifically because Overpass failed — kept as an explicit call (never inferred from timing) so this counter is never guessed at. */
export function recordGoogleFallbackAfterOverpassFailure(): void {
  if (currentSession) currentSession.counters.googleFallbacksTriggeredAfterOverpassFailure += 1;
}

function recordSessionOutcome(category: OverpassFailureCategory | "success"): void {
  if (!currentSession) return;
  if (category === "success") {
    currentSession.consecutiveFailures = 0;
    currentSession.circuitState = "HEALTHY";
    return;
  }
  if (category === "OVERPASS_TIMEOUT") currentSession.counters.overpassTimeouts += 1;
  else if (category === "OVERPASS_NETWORK_ERROR") currentSession.counters.overpassNetworkErrors += 1;
  else if (category === "OVERPASS_HTTP_ERROR") currentSession.counters.overpassHttpErrors += 1;
  // A non-retryable HTTP error (malformed query) is a property of the
  // request, never evidence Overpass itself is unhealthy — never counted
  // toward the circuit. Budget/circuit skips never reach this function at
  // all (they short-circuit before any attempt), so only genuine
  // timeout/network/retryable-HTTP failures affect circuit health.
  if (category === "OVERPASS_TIMEOUT" || category === "OVERPASS_NETWORK_ERROR") {
    currentSession.consecutiveFailures += 1;
    if (currentSession.consecutiveFailures >= CIRCUIT_OPEN_AFTER) currentSession.circuitState = "UNAVAILABLE";
    else if (currentSession.consecutiveFailures >= CIRCUIT_DEGRADE_AFTER) currentSession.circuitState = "DEGRADED";
  }
}

/**
 * The hard wall-clock boundary (spec §2/§11): races the real request
 * against a plain timer, so the caller regains control at `timeoutMs`
 * regardless of whether the underlying transport ever actually settles —
 * "AbortController.abort() was called" is explicitly NOT the acceptance
 * criterion. `task` is expected to never reject (every real call site
 * below wraps its own try/catch into a resolved failure value) but this
 * still attaches a no-op `.catch` in case a future caller's task ever
 * does, so a late rejection can never become an unhandled rejection —
 * and since the caller only ever reads the race's own settled value, a
 * late resolution/rejection from `task` can never mutate anything the
 * caller already moved on from.
 */
export async function raceWithHardDeadline<T>(task: () => Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  const taskPromise = task();
  taskPromise.catch(() => {});
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

// Process-lifetime counter (not per-run — Overpass calls happen across
// several separate API requests: recommendations, food, hotels, and any
// nearby-search during generation, not just one call site) so a debug
// session can tell "every Overpass call this session failed" (a synthetic/
// fallback run) apart from "Overpass is genuinely reachable and mostly
// returning real data" — spec ask: never silently let a fallback run look
// like a production one. Exported for country-itinerary-generation.ts's
// QA_DEBUG_GEOGRAPHY/CAPTURE_FIXTURES diagnostics; recordOverpassCall is
// also exported so its counting logic is directly unit-testable without a
// real network call.
let overpassTotalCalls = 0;
let overpassFailedCalls = 0;

export function recordOverpassCall(succeeded: boolean): void {
  overpassTotalCalls += 1;
  if (!succeeded) overpassFailedCalls += 1;
}

export function getOverpassCallStats(): { totalCalls: number; failedCalls: number } {
  return { totalCalls: overpassTotalCalls, failedCalls: overpassFailedCalls };
}

export function resetOverpassCallStats(): void {
  overpassTotalCalls = 0;
  overpassFailedCalls = 0;
}

// --- Centralized transport (endpoint fallback + User-Agent + timeout) ----
// The ONE place every Overpass HTTP request goes through — previously each
// of the three call sites below (checkOverpassAvailability,
// executeOverpassQuery, queryNearbyPlaces) had its own duplicated fetch,
// its own AbortController/timeout, and no User-Agent at all. Centralizing
// here means endpoint fallback and the User-Agent fix apply everywhere at
// once and can never drift apart between call sites again.

export type FetchLike = typeof fetch;

function isRetryableStatus(status: number): boolean {
  // 429 (rate-limited) and 5xx (server-side failure) are legitimately
  // worth trying a different endpoint for — the SAME request might just
  // work elsewhere. Any other 4xx (400 malformed query, 403, 404, ...) is
  // a property of the request itself, not the endpoint — it would fail
  // identically everywhere, so retrying it across every configured
  // endpoint would just be a pointless storm, never a real recovery.
  return status === 429 || (status >= 500 && status < 600);
}

interface OverpassAttemptFailure {
  ok: false;
  retryable: boolean;
  reason: string;
  status?: number;
}

async function fetchOverpassOnce(
  endpoint: string,
  query: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  next?: { revalidate: number }
): Promise<{ ok: true; response: Response } | OverpassAttemptFailure> {
  const controller = new AbortController();
  // Round 9.6.6 §2 — the hard wall-clock boundary. abort() is still called
  // (best effort — a well-behaved transport does stop), but the CALLER's
  // own wait is bounded by raceWithHardDeadline regardless of whether the
  // underlying fetch implementation ever actually honors the signal. This
  // is the exact fix for the confirmed root cause: a stuck connection that
  // does not respond to AbortSignal within any useful window used to hang
  // this function (and everything awaiting it) indefinitely.
  return raceWithHardDeadline(
    async () => {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "User-Agent": getOverpassUserAgent() },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
          ...(next ? { next } : {}),
        });
        if (res.ok) return { ok: true, response: res };
        return { ok: false, retryable: isRetryableStatus(res.status), reason: `HTTP ${res.status}`, status: res.status };
      } catch (error) {
        // AbortError (our own timeout) and any other network-level throw
        // (DNS failure, connection refused, ...) are both real transport
        // problems a different endpoint might not have — always retryable.
        const reason = error instanceof Error ? (error.name === "AbortError" ? "timeout" : error.message) : String(error);
        return { ok: false, retryable: true, reason };
      }
    },
    timeoutMs,
    () => {
      // The hard deadline fired before the task itself settled (with a
      // well-behaved transport this is the abort() case; with a stuck one,
      // this is what actually bounds the wait). Either way, the caller
      // gets this SAME, honestly-labeled outcome.
      controller.abort();
      return { ok: false, retryable: true, reason: "timeout" };
    }
  );
}

export type OverpassFetchOutcome =
  | { kind: "success"; response: Response; endpoint: string }
  | { kind: "failure"; endpoint: string; reason: string; failureCategory: OverpassFailureCategory };

/**
 * Tries each configured endpoint in order (OVERPASS_ENDPOINTS by default —
 * bounded, never more attempts than the configured list, no retry storm).
 * Falls through to the next endpoint only for a retryable failure (network
 * error, timeout, 429, 5xx); a non-retryable 4xx stops immediately. Every
 * request carries a real User-Agent (getOverpassUserAgent). `fetchImpl` is
 * injectable so tests never depend on real network/Overpass availability.
 *
 * Round 9.6.6 — three additive behaviors, all opt-in via the CURRENT
 * generation-scoped session (beginOverpassSession), so a caller that never
 * begins a session (every pre-existing call site) sees zero behavior
 * change beyond the hard-deadline fix inside fetchOverpassOnce itself:
 *   §5 circuit breaker — an UNAVAILABLE circuit skips every endpoint
 *     outright, no network attempt at all.
 *   §3 deadline propagation — each attempt's effective timeout is
 *     min(configured, remaining session budget); below
 *     MIN_OVERPASS_ATTEMPT_BUDGET_MS, the attempt is skipped rather than
 *     started, so a near-exhausted budget can never itself become a slow
 *     Overpass call.
 *   §7 observability — one structured attempt log per endpoint try, plus
 *     circuit-state transitions and session counters.
 */
export async function fetchOverpass(
  query: string,
  options: {
    timeoutMs?: number;
    endpoints?: string[];
    fetchImpl?: FetchLike;
    next?: { revalidate: number };
    /** Observability only — never changes behavior; lets the caller's own stay/category context appear in the per-attempt trace log without threading a new parameter through the fixed fetchCandidates signature callers already share. */
    logContext?: { stay?: string; categoryGroup?: string };
  } = {}
): Promise<OverpassFetchOutcome> {
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS;
  const configuredTimeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastFailure: { endpoint: string; reason: string; failureCategory: OverpassFailureCategory } | null = null;

  if (getOverpassCircuitState() === "UNAVAILABLE") {
    if (currentSession) currentSession.counters.overpassCircuitOpenSkips += 1;
    if (isPlannerQaTraceEnabled()) {
      console.log("[Overpass] attempt", {
        stay: options.logContext?.stay ?? null,
        categoryGroup: options.logContext?.categoryGroup ?? null,
        endpoint: null,
        attemptNumber: 0,
        configuredTimeoutMs,
        remainingBudgetMs: currentSession?.deadlineAt != null ? currentSession.deadlineAt - Date.now() : null,
        effectiveTimeoutMs: 0,
        elapsedMs: 0,
        result: "circuit_open",
        circuitStateBefore: "UNAVAILABLE",
        circuitStateAfter: "UNAVAILABLE",
      });
    }
    return { kind: "failure", endpoint: endpoints[0], reason: "circuit_open", failureCategory: "OVERPASS_CIRCUIT_OPEN" };
  }

  for (const [index, endpoint] of endpoints.entries()) {
    const remainingBudgetMs = currentSession?.deadlineAt != null ? currentSession.deadlineAt - Date.now() : null;
    if (remainingBudgetMs != null && remainingBudgetMs < MIN_OVERPASS_ATTEMPT_BUDGET_MS) {
      if (currentSession) currentSession.counters.overpassBudgetSkips += 1;
      if (isPlannerQaTraceEnabled()) {
        console.log("[Overpass] attempt", {
          stay: options.logContext?.stay ?? null,
          categoryGroup: options.logContext?.categoryGroup ?? null,
          endpoint,
          attemptNumber: index + 1,
          configuredTimeoutMs,
          remainingBudgetMs,
          effectiveTimeoutMs: 0,
          elapsedMs: 0,
          result: "budget_exhausted",
          circuitStateBefore: getOverpassCircuitState(),
          circuitStateAfter: getOverpassCircuitState(),
        });
      }
      return { kind: "failure", endpoint, reason: "budget_exhausted", failureCategory: "OVERPASS_BUDGET_EXHAUSTED" };
    }
    const effectiveTimeoutMs = remainingBudgetMs != null ? Math.min(configuredTimeoutMs, remainingBudgetMs) : configuredTimeoutMs;

    const circuitStateBefore = getOverpassCircuitState();
    const startedAt = Date.now();
    const attempt = await fetchOverpassOnce(endpoint, query, effectiveTimeoutMs, fetchImpl, options.next);
    const elapsedMs = Date.now() - startedAt;
    if (currentSession) currentSession.counters.overpassWallClockMs += elapsedMs;

    if (attempt.ok) {
      recordSessionOutcome("success");
      // Routine fallback mechanics, not a real problem (the request DID
      // succeed) — QA-gated rather than always-on, since this fires on
      // every retry during ordinary Overpass flakiness.
      if (isPlannerQaTraceEnabled()) {
        if (lastFailure) console.log("[Overpass] recovered via fallback endpoint", { endpoint, previousFailure: lastFailure });
        console.log("[Overpass] attempt", {
          stay: options.logContext?.stay ?? null,
          categoryGroup: options.logContext?.categoryGroup ?? null,
          endpoint,
          attemptNumber: index + 1,
          configuredTimeoutMs,
          remainingBudgetMs,
          effectiveTimeoutMs,
          elapsedMs,
          result: "success",
          circuitStateBefore,
          circuitStateAfter: getOverpassCircuitState(),
        });
      }
      return { kind: "success", response: attempt.response, endpoint };
    }

    const failureCategory = classifyOverpassFailureReason(attempt.reason, attempt.status);
    recordSessionOutcome(failureCategory);

    if (isPlannerQaTraceEnabled()) {
      console.log("[Overpass] endpoint attempt failed", { endpoint, reason: attempt.reason, retryable: attempt.retryable });
      console.log("[Overpass] attempt", {
        stay: options.logContext?.stay ?? null,
        categoryGroup: options.logContext?.categoryGroup ?? null,
        endpoint,
        attemptNumber: index + 1,
        configuredTimeoutMs,
        remainingBudgetMs,
        effectiveTimeoutMs,
        elapsedMs,
        result: failureCategory,
        circuitStateBefore,
        circuitStateAfter: getOverpassCircuitState(),
      });
    }

    lastFailure = { endpoint, reason: attempt.reason, failureCategory };
    if (!attempt.retryable) break;
    // Round 9.6.6 §5 — a freshly-opened circuit stops trying the REMAINING
    // configured endpoints too, not just future calls: no point paying a
    // second endpoint's timeout in the same call that just proved Overpass
    // unhealthy for this generation.
    if (getOverpassCircuitState() === "UNAVAILABLE") break;
  }

  return {
    kind: "failure",
    endpoint: lastFailure?.endpoint ?? endpoints[0],
    reason: lastFailure?.reason ?? "no endpoints configured",
    failureCategory: lastFailure?.failureCategory ?? "OVERPASS_NETWORK_ERROR",
  };
}

export interface OverpassPlace {
  name: string;
  lat: number;
  lon: number;
  openingHours: string | null;
  description: string | null;
  website: string | null;
  wikipediaUrl: string | null;
  cuisine: string | null;
  wheelchairAccessible: boolean | null;
  isFree: boolean | null;
}

/**
 * Real provider-availability probe (spec §H) — a minimal, cheap query
 * whose only purpose is "did Overpass actually respond", never "does it
 * have data for X" (that's still queryOverpassPlaces/queryNearbyPlaces,
 * unchanged). Distinguishes a genuine outage from "the query legitimately
 * returned zero results" — the two currently look identical to every
 * existing caller, since both silently resolve to []. Callers that already
 * know the real result (having just run their own category queries) don't
 * need this at all; it exists for a caller that wants the answer up front,
 * without inferring it from candidate counts (spec §H's explicit "do not
 * infer network/provider success from candidate count").
 */
export async function checkOverpassAvailability(): Promise<boolean> {
  // Never cached (no `next` option) — this probe exists specifically to
  // answer "is Overpass reachable right now", so a stale cached response
  // would defeat its whole purpose.
  const outcome = await fetchOverpass("[out:json][timeout:5];out count;", { timeoutMs: 8_000 });
  recordOverpassCall(outcome.kind === "success");
  return outcome.kind === "success";
}

type CountryBBox = [number, number, number, number];

// Categories with no equivalent structured/open data source (they require
// editorial judgment or event calendars) intentionally have no tag filter —
// callers should treat them as unavailable rather than inventing content.
const CATEGORY_TAG_FILTERS: Partial<Record<RecommendationCategory, string[]>> = {
  attraction: ['tourism=attraction', 'tourism=viewpoint', 'tourism=gallery'],
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  museum: ["tourism=museum"],
  // Round 9.15 §C — extended from the original 3-tag set (Round 9.14 audit:
  // only 7/212 real items were nature-category, and zero hiking/trail/peak/
  // waterfall content was ever discovered despite a whole White-Mountains
  // stay). Every entry here still requires a real `name`/`name:en` tag to
  // survive normalization (queryNearbyRecommendationsDetailed's existing
  // `if (!name ...) continue` gate, unchanged) — that alone excludes the
  // vast majority of anonymous noise. These 5 new tags are all simple
  // node/way point features — safe/cheap to add to this SHARED table
  // (also used by the country-wide queryOverpassPlaces path). `route=
  // hiking` was tried and DELIBERATELY REMOVED (Round 9.15 §AD bounded
  // real validation): it is a RELATION tag, and Overpass's `around` radius
  // filter on a relation requires expanding every member's geometry —
  // measured live against the real public instance for a genuine White-
  // Mountains anchor, a bare `nwr[route=hiking](around:15000,...)` query
  // returned an HTTP 504 after ~10s even with its own 25s internal
  // timeout, while every other new tag here answered in under 3s. Real
  // trail evidence is still reachable via the cheap `information=
  // trailhead` node tag and via queryNearbyNatureTrailCandidates below
  // (highway=path/footway + sac_scale/trail_visibility, way-scoped, not
  // relation-scoped) — never worth risking a provider timeout trip-wide
  // for one relation tag. `highway=path`/`highway=footway` are also
  // deliberately NOT added here (too dense country-wide to be a bounded
  // query) — see queryNearbyNatureTrailCandidates below for the separate,
  // stay-scoped-only, radius-bounded path/footway query, gated behind an
  // explicit nature-discovery decision (never run unconditionally).
  nature: [
    "leisure=nature_reserve",
    "natural=beach",
    "tourism=alpine_hut",
    "natural=peak",
    "natural=waterfall",
    "natural=cliff",
    "information=trailhead",
    "boundary=protected_area",
  ],
  shopping: ["shop=mall", "shop=department_store"],
  nightlife: ["amenity=bar", "amenity=nightclub", "amenity=pub"],
  family: ["leisure=park", "tourism=zoo", "leisure=water_park"],
  hotel: ["tourism=hotel", "tourism=resort"],
  transportation: ["aeroway=aerodrome", "railway=station", "amenity=bus_station"],
};

export function categoryHasOpenDataSource(category: RecommendationCategory): boolean {
  return category in CATEGORY_TAG_FILTERS;
}

function toOverpassSelector(filter: string) {
  const [key, ...valueParts] = filter.split("=");
  const value = valueParts.join("=");
  if (!key || !value) return "";
  return `[${key}="${value}"]`;
}

function buildClauses(category: RecommendationCategory): string | null {
  const filters = CATEGORY_TAG_FILTERS[category];
  if (!filters) return null;

  return filters
    .map((filter) => `nwr${toOverpassSelector(filter)}(area.searchArea);`)
    .join("\n      ");
}

function buildAreaQuery(isoA2: string, category: RecommendationCategory, limit: number): string | null {
  const clauses = buildClauses(category);
  if (!clauses) return null;

  return `
    [out:json][timeout:22];
    (
      area["ISO3166-1"="${isoA2}"][admin_level=2];
      area["ISO3166-1:alpha2"="${isoA2}"][admin_level=2];
      area["ISO3166-1:alpha2"="${isoA2}"];
    )->.searchArea;
    (
      ${clauses}
    );
    out center ${Math.max(limit * 4, 40)};
  `;
}

function buildBboxQuery(
  bbox: CountryBBox,
  category: RecommendationCategory,
  limit: number
): string | null {
  const clauses = buildClauses(category);
  if (!clauses) return null;

  const [west, south, east, north] = bbox;
  const filters = CATEGORY_TAG_FILTERS[category] ?? [];
  const bboxClauses = filters
    .map(
      (filter) =>
        `nwr${toOverpassSelector(filter)}(${south},${west},${north},${east});`
    )
    .join("\n      ");

  return `
    [out:json][timeout:22];
    (
      ${bboxClauses}
    );
    out center ${Math.max(limit * 4, 40)};
  `;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string | undefined>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

interface CountryFeatureCollectionFile {
  features?: Array<{
    properties?: {
      iso_a2?: string;
      bbox?: CountryBBox;
    };
  }>;
}

let countryBboxesPromise: Promise<Map<string, CountryBBox>> | null = null;

function score(tags: Record<string, string | undefined>): number {
  // Prefer entries that carry enough real-world signal to be worth
  // recommending — a name is mandatory; everything else just nudges rank.
  let value = 0;
  if (tags.wikidata) value += 3;
  if (tags.wikipedia) value += 2;
  if (tags.opening_hours) value += 1;
  if (tags.website) value += 1;
  if (tags.description || tags["description:en"]) value += 1;
  return value;
}

async function loadCountryBboxes() {
  if (!countryBboxesPromise) {
    countryBboxesPromise = readFile(
      path.join(process.cwd(), "public", "data", "world-countries.geojson"),
      "utf8"
    )
      .then((content) => JSON.parse(content) as CountryFeatureCollectionFile)
      .then((data) => {
        const map = new Map<string, CountryBBox>();
        for (const feature of data.features ?? []) {
          const iso = feature.properties?.iso_a2?.toUpperCase();
          const bbox = feature.properties?.bbox;
          if (iso && bbox?.length === 4) {
            map.set(iso, bbox);
          }
        }
        return map;
      })
      .catch(() => new Map<string, CountryBBox>());
  }

  return countryBboxesPromise;
}

async function getCountryBbox(isoA2: string) {
  const bboxes = await loadCountryBboxes();
  return bboxes.get(isoA2.toUpperCase()) ?? null;
}

function normalizeOverpassElements(data: OverpassResponse, limit: number): OverpassPlace[] {
  const withNames = data.elements
    .map((el) => {
      const tags = el.tags ?? {};
      const name = tags.name || tags["name:en"];
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!name || lat == null || lon == null) return null;

      const wikipediaTag = tags.wikipedia;
      const wikipediaUrl = wikipediaTag
        ? (() => {
            const [lang, ...rest] = wikipediaTag.split(":");
            const title = rest.join(":") || lang;
            const wikiLang = rest.length > 0 ? lang : "en";
            return `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
          })()
        : null;

      const wheelchairAccessible =
        tags.wheelchair === "yes" || tags.wheelchair === "designated"
          ? true
          : tags.wheelchair === "no"
            ? false
            : null;
      const isFree = tags.fee === "no" ? true : tags.fee === "yes" ? false : null;

      return {
        place: {
          name,
          lat,
          lon,
          openingHours: tags.opening_hours ?? null,
          description: tags.description ?? tags["description:en"] ?? null,
          website: tags.website ?? tags["contact:website"] ?? null,
          wikipediaUrl,
          cuisine: tags.cuisine ?? null,
          wheelchairAccessible,
          isFree,
        } satisfies OverpassPlace,
        score: score(tags),
      };
    })
    .filter((entry): entry is { place: OverpassPlace; score: number } => entry != null);

  const seen = new Set<string>();
  const deduped = withNames.filter((entry) => {
    const key = entry.place.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.place);
}

/**
 * Section B — the request's own real outcome, kept distinct from "how many
 * places came back": a request that genuinely reached Overpass and got a
 * valid response is `succeeded: true` even with zero results (spec §B2 —
 * "zero results != provider failure"); a network error or non-OK status is
 * `succeeded: false` regardless of how many places a LATER fallback query
 * might still turn up.
 */
export interface OverpassQueryOutcome {
  places: OverpassPlace[];
  succeeded: boolean;
}

async function executeOverpassQuery(query: string, limit: number): Promise<OverpassQueryOutcome> {
  // Degrading to [] on failure is intentional (categories with no data
  // just come back empty) — but a real provider failure (every endpoint
  // exhausted) is not "no results", so succeeded is false here even though
  // the shape (empty array) looks identical to a legitimate zero-result
  // query.
  const outcome = await fetchOverpass(query, { next: { revalidate: 60 * 60 * 24 } });
  if (outcome.kind !== "success") {
    recordOverpassCall(false);
    // Every configured endpoint was exhausted for this query — a genuine
    // provider-availability problem, kept visible as a real warning rather
    // than gated behind a QA flag.
    console.warn("[Recommendations] Overpass request failed", { endpoint: outcome.endpoint, reason: outcome.reason });
    return { places: [], succeeded: false };
  }

  const data = (await outcome.response.json()) as OverpassResponse;
  captureProviderFixture("overpass", query, { query, response: data });
  recordOverpassCall(true);
  return { places: normalizeOverpassElements(data, limit), succeeded: true };
}

export async function queryOverpassPlaces(
  isoA2: string,
  category: RecommendationCategory,
  limit: number
): Promise<OverpassQueryOutcome> {
  const normalizedIso = isoA2.toUpperCase();
  const areaQuery = buildAreaQuery(normalizedIso, category, limit);
  if (!areaQuery) return { places: [], succeeded: true };

  const areaOutcome = await executeOverpassQuery(areaQuery, limit);
  if (areaOutcome.places.length > 0) {
    return areaOutcome;
  }

  const bbox = await getCountryBbox(normalizedIso);
  if (!bbox) return areaOutcome;

  const bboxQuery = buildBboxQuery(bbox, category, limit);
  if (!bboxQuery) return areaOutcome;

  const bboxOutcome = await executeOverpassQuery(bboxQuery, limit);
  // The area query already told us the truth about provider reachability;
  // a bbox fallback that also comes back empty must not silently overwrite
  // a real area-query success with its own (still legitimate) succeeded
  // value — both are ANDed so a genuine failure anywhere is never hidden.
  return { places: bboxOutcome.places, succeeded: areaOutcome.succeeded && bboxOutcome.succeeded };
}

// --- Nearby places (radius search around a single point) -----------------

export type NearbyCategory =
  | "restaurant"
  | "cafe"
  | "dessert"
  | "hotel"
  | "fuel"
  | "supermarket"
  | "parking"
  | "restroom"
  | "attraction";

export interface NearbyPlace {
  name: string;
  category: NearbyCategory;
  lat: number;
  lon: number;
  distanceMeters: number;
  openingHours: string | null;
}

const NEARBY_CATEGORY_TAG_FILTERS: Record<NearbyCategory, string[]> = {
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  dessert: ["shop=pastry", "shop=confectionery", "amenity=ice_cream"],
  hotel: ["tourism=hotel", "tourism=guest_house", "tourism=hostel"],
  fuel: ["amenity=fuel"],
  supermarket: ["shop=supermarket"],
  parking: ["amenity=parking"],
  restroom: ["amenity=toilets"],
  attraction: ["tourism=attraction", "tourism=viewpoint", "tourism=museum", "tourism=gallery"],
};

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Reverse lookup: given an element's own tags, which nearby category (if
// any) does it match? Built once from NEARBY_CATEGORY_TAG_FILTERS so a
// single combined query can be classified after the fact instead of firing
// one request per category (kinder to the shared public Overpass instance).
const TAG_TO_NEARBY_CATEGORY = new Map<string, NearbyCategory>();
for (const [nearbyCategory, filters] of Object.entries(NEARBY_CATEGORY_TAG_FILTERS) as [
  NearbyCategory,
  string[],
][]) {
  for (const filter of filters) {
    TAG_TO_NEARBY_CATEGORY.set(filter, nearbyCategory);
  }
}

function classifyNearbyElement(tags: Record<string, string | undefined>): NearbyCategory | null {
  for (const [filter, nearbyCategory] of TAG_TO_NEARBY_CATEGORY) {
    const [key, value] = filter.split("=");
    if (tags[key] === value) return nearbyCategory;
  }
  return null;
}

export async function queryNearbyPlaces(
  lat: number,
  lon: number,
  radiusMeters: number,
  perCategoryLimit: number
): Promise<NearbyPlace[]> {
  const allFilters = Object.values(NEARBY_CATEGORY_TAG_FILTERS).flat();
  const query = `
    [out:json][timeout:20];
    (
      ${allFilters.map((filter) => `nwr${toOverpassSelector(filter)}(around:${radiusMeters},${lat},${lon});`).join("\n      ")}
    );
    out center 200;
  `;

  const outcome = await fetchOverpass(query, { timeoutMs: 20_000, next: { revalidate: 60 * 60 * 24 } });
  if (outcome.kind !== "success") {
    recordOverpassCall(false);
    return [];
  }

  try {
    const data = (await outcome.response.json()) as OverpassResponse;
    captureProviderFixture("overpass", query, { query, response: data });
    recordOverpassCall(true);
    const byCategory = new Map<NearbyCategory, NearbyPlace[]>();

    for (const el of data.elements) {
      const tags = el.tags ?? {};
      const name = tags.name || tags["name:en"];
      const placeLat = el.lat ?? el.center?.lat;
      const placeLon = el.lon ?? el.center?.lon;
      const category = classifyNearbyElement(tags);
      if (!name || placeLat == null || placeLon == null || !category) continue;

      const place: NearbyPlace = {
        name,
        category,
        lat: placeLat,
        lon: placeLon,
        distanceMeters: Math.round(haversineMeters(lat, lon, placeLat, placeLon)),
        openingHours: tags.opening_hours ?? null,
      };
      const bucket = byCategory.get(category) ?? [];
      bucket.push(place);
      byCategory.set(category, bucket);
    }

    return [...byCategory.values()].flatMap((places) =>
      places.sort((left, right) => left.distanceMeters - right.distanceMeters).slice(0, perCategoryLimit)
    );
  } catch {
    // A malformed response body (JSON parse failure) after a genuinely
    // successful HTTP response — real, if rare; the transport itself
    // already succeeded so recordOverpassCall(true) above stands.
    return [];
  }
}

// --- Round 9: stay-scoped sightseeing candidate refill --------------------

/**
 * A real candidate discovered around a STAY's own anchor (never a whole
 * country) — the shape stay-activity-pool.ts's refillStayActivityPool
 * converts into a full TripRecommendation. Every field comes straight from
 * OSM tags via the SAME parsing rules queryOverpassPlaces already uses
 * (normalizeOverpassElements) — nothing fabricated.
 *
 * Round 9.6 §A — this shape is now provider-neutral in practice (see
 * `RealPlaceCandidate` alias below): google-places.ts's own discovery
 * function returns candidates in this EXACT shape (with `provenance`
 * populated), so every downstream consumer (fetchDiscoveryGroupRaw,
 * acceptRawCandidatesIntoPool, refillStayActivityPool's own
 * `fetchCandidates` override point) already works unchanged regardless of
 * which provider actually produced the candidate. `provenance` is
 * optional so this interface's name/shape/every existing Overpass-only
 * caller stays exactly as it was.
 */
export interface OverpassNearbyRecommendation {
  name: string;
  category: RecommendationCategory;
  location: string;
  shortDescription: string | null;
  lat: number;
  lon: number;
  openingHours: string | null;
  wikipediaUrl: string | null;
  website: string | null;
  provenance?: import("@/lib/trip-workspace").RealPlaceProvenance;
}

/**
 * Round 9.6 §A — the provider-neutral name for the same shape, used by new
 * code (google-places.ts, the discovery orchestration) so it reads
 * correctly regardless of which provider is involved; never a second,
 * drifting type.
 */
export type RealPlaceCandidate = OverpassNearbyRecommendation;

/**
 * Round 9 §4 — the stay-scoped twin of queryOverpassPlaces: bounded by a
 * real radius around ONE anchor point (a stay's own base, never the whole
 * country), and category-aware (only ever asks for categories
 * categoryHasOpenDataSource already knows a real OSM tag mapping for — see
 * CATEGORY_TAG_FILTERS, the SAME table queryOverpassPlaces itself uses, so
 * this can never invent a new tag set). One combined query per call
 * (kinder to the shared public instance than one request per category),
 * classified back into per-category buckets by which tag filter actually
 * matched, then capped to `perCategoryLimit` each. `fetchImpl` is
 * injectable for tests — never a real network call unless the caller
 * (or its default) actually wants one.
 */
export async function queryNearbyRecommendations(
  lat: number,
  lon: number,
  radiusMeters: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; areaLabelForLocation?: string } = {}
): Promise<OverpassNearbyRecommendation[]> {
  return (await queryNearbyRecommendationsDetailed(lat, lon, radiusMeters, categories, perCategoryLimit, options)).results;
}

/**
 * Round 9.3.3 — same query/parse behavior as {@link queryNearbyRecommendations},
 * but surfaces WHY zero results came back instead of collapsing "the
 * provider failed" and "the provider genuinely has nothing here" into the
 * same empty array. `queryNearbyRecommendations` itself must keep its
 * existing never-throws contract (callers/tests rely on that), so this is
 * a separate entry point used by callers that need to tell a real
 * provider outage apart from true low supply (e.g. refillStayActivityPool's
 * accounting).
 */
export async function queryNearbyRecommendationsDetailed(
  lat: number,
  lon: number,
  radiusMeters: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; areaLabelForLocation?: string; logContext?: { stay?: string; categoryGroup?: string } } = {}
): Promise<{
  results: OverpassNearbyRecommendation[];
  providerFailed: boolean;
  failureReason: string | null;
  /** Round 9.6.6 §6 — the granular classification; providerFailed stays the existing boolean every caller already relies on. */
  failureCategory: OverpassFailureCategory | null;
  rawElementCount: number;
  /** Round 9.3.4 §2/§8 — reported per-group diagnostics, never re-derived by guessing at the query the caller built. */
  selectorCount: number;
  queryLength: number;
  elapsedMs: number;
  endpoint: string | null;
}> {
  const requestedCategories = categories.filter((category) => categoryHasOpenDataSource(category));
  if (requestedCategories.length === 0) {
    return { results: [], providerFailed: false, failureReason: null, failureCategory: null, rawElementCount: 0, selectorCount: 0, queryLength: 0, elapsedMs: 0, endpoint: null };
  }

  const tagToCategory = new Map<string, RecommendationCategory>();
  const selectors: string[] = [];
  for (const category of requestedCategories) {
    for (const filter of CATEGORY_TAG_FILTERS[category] ?? []) {
      tagToCategory.set(filter, category);
      selectors.push(`nwr${toOverpassSelector(filter)}(around:${radiusMeters},${lat},${lon});`);
    }
  }
  if (selectors.length === 0) {
    return { results: [], providerFailed: false, failureReason: null, failureCategory: null, rawElementCount: 0, selectorCount: 0, queryLength: 0, elapsedMs: 0, endpoint: null };
  }

  const query = `
    [out:json][timeout:22];
    (
      ${selectors.join("\n      ")}
    );
    out center ${Math.max(perCategoryLimit * requestedCategories.length * 3, 40)};
  `;
  const selectorCount = selectors.length;
  const queryLength = query.length;
  const startedAt = Date.now();

  const outcome = await fetchOverpass(query, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    next: { revalidate: 60 * 60 * 12 },
    logContext: options.logContext,
  });
  const elapsedMs = Date.now() - startedAt;
  if (outcome.kind !== "success") {
    recordOverpassCall(false);
    return { results: [], providerFailed: true, failureReason: outcome.reason, failureCategory: outcome.failureCategory, rawElementCount: 0, selectorCount, queryLength, elapsedMs, endpoint: outcome.endpoint };
  }

  let data: OverpassResponse;
  try {
    data = (await outcome.response.json()) as OverpassResponse;
  } catch {
    recordOverpassCall(true); // the HTTP transport succeeded; only the body was malformed
    return { results: [], providerFailed: true, failureReason: "malformed_response_body", failureCategory: "OVERPASS_NETWORK_ERROR", rawElementCount: 0, selectorCount, queryLength, elapsedMs, endpoint: outcome.endpoint };
  }
  captureProviderFixture("overpass", query, { query, response: data });
  recordOverpassCall(true);

  const byCategory = new Map<RecommendationCategory, Array<{ place: OverpassNearbyRecommendation; score: number }>>();
  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const name = tags.name || tags["name:en"];
    const placeLat = el.lat ?? el.center?.lat;
    const placeLon = el.lon ?? el.center?.lon;
    if (!name || placeLat == null || placeLon == null) continue;

    // Which requested category does this element's own tags match? The
    // first matching filter wins — an element could technically satisfy
    // more than one (rare); it is still only ever counted once.
    let matchedCategory: RecommendationCategory | null = null;
    for (const [filter, category] of tagToCategory) {
      const [key, value] = filter.split("=");
      if (tags[key] === value) {
        matchedCategory = category;
        break;
      }
    }
    if (!matchedCategory) continue;

    const wikipediaTag = tags.wikipedia;
    const wikipediaUrl = wikipediaTag
      ? (() => {
          const [wikiLang, ...rest] = wikipediaTag.split(":");
          const title = rest.join(":") || wikiLang;
          const lang = rest.length > 0 ? wikiLang : "en";
          return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        })()
      : null;

    const place: OverpassNearbyRecommendation = {
      name,
      category: matchedCategory,
      location: options.areaLabelForLocation ?? "",
      shortDescription: tags.description ?? tags["description:en"] ?? null,
      lat: placeLat,
      lon: placeLon,
      openingHours: tags.opening_hours ?? null,
      wikipediaUrl,
      website: tags.website ?? tags["contact:website"] ?? null,
      // Round 9.9 — carries the raw OSM tags forward so classifyTouristEligibility
      // has real structured evidence (shop=*/leisure=*/tourism=*/historic=*/
      // amenity=*/office=*/building=*) instead of only the coarse category this
      // element's tags happened to first-match. `providerId` reproduces the
      // EXACT composite string toTripRecommendation's own fallback would have
      // built (same category/lat/lon/name) — this is purely additive, never a
      // change to any existing recommendation id / dedup behavior.
      provenance: {
        provider: "overpass",
        providerId: `overpass:${matchedCategory}:${placeLat.toFixed(5)}:${placeLon.toFixed(5)}:${name}`,
        // OSM tag values are always strings when present; the loose
        // `Record<string, string | undefined>` declaration on OverpassElement
        // is only defensive against a key being entirely absent (already
        // handled by every `tags[key] === value`/`tags.key` read above).
        osmTags: tags as Record<string, string>,
      },
    };
    const bucket = byCategory.get(matchedCategory) ?? [];
    bucket.push({ place, score: score(tags) });
    byCategory.set(matchedCategory, bucket);
  }

  const seenNames = new Set<string>();
  const results: OverpassNearbyRecommendation[] = [];
  for (const bucket of byCategory.values()) {
    const ranked = bucket.sort((a, b) => b.score - a.score);
    for (const entry of ranked) {
      const key = entry.place.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      results.push(entry.place);
      if (results.filter((r) => r.category === entry.place.category).length >= perCategoryLimit) break;
    }
  }
  return { results, providerFailed: false, failureReason: null, failureCategory: null, rawElementCount: data.elements.length, selectorCount, queryLength, elapsedMs, endpoint: outcome.endpoint };
}

/**
 * Round 9.15 §C/§D — a SEPARATE, stay-scoped-only, radius-bounded query for
 * `highway=path`/`highway=footway` (deliberately excluded from
 * CATEGORY_TAG_FILTERS.nature above — see that table's own comment for
 * why). Callers (stay-activity-pool.ts) gate this behind an explicit
 * nature-discovery decision — it is never run unconditionally alongside
 * the ordinary category refill. A named path/footway alone is NOT
 * sufficient evidence of a genuine hiking trail (an ordinary named
 * sidewalk would still pass a bare name check) — every result additionally
 * requires at least one of `sac_scale`/`trail_visibility`/a `route` tag
 * already present in its own OSM tags, checked HERE (not deferred to
 * classifyTouristEligibility) specifically so this function's own bounded
 * result count reflects genuinely evidenced candidates, not raw noise.
 * Output is capped small (`resultLimit`) since this supplements, never
 * replaces, the ordinary nature category query.
 */
export async function queryNearbyNatureTrailCandidates(
  lat: number,
  lon: number,
  radiusMeters: number,
  resultLimit: number,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; areaLabelForLocation?: string; logContext?: { stay?: string; categoryGroup?: string } } = {}
): Promise<{ results: OverpassNearbyRecommendation[]; providerFailed: boolean; rawElementCount: number; elapsedMs: number }> {
  const pathFilters = ["highway=path", "highway=footway"];
  const selectors = pathFilters.map((filter) => `nwr${toOverpassSelector(filter)}(around:${radiusMeters},${lat},${lon});`);
  const query = `
    [out:json][timeout:20];
    (
      ${selectors.join("\n      ")}
    );
    out center ${Math.max(resultLimit * 4, 40)};
  `;
  const startedAt = Date.now();
  const outcome = await fetchOverpass(query, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 20_000,
    next: { revalidate: 60 * 60 * 12 },
    logContext: options.logContext,
  });
  const elapsedMs = Date.now() - startedAt;
  if (outcome.kind !== "success") {
    recordOverpassCall(false);
    return { results: [], providerFailed: true, rawElementCount: 0, elapsedMs };
  }

  let data: OverpassResponse;
  try {
    data = (await outcome.response.json()) as OverpassResponse;
  } catch {
    recordOverpassCall(true);
    return { results: [], providerFailed: true, rawElementCount: 0, elapsedMs };
  }
  captureProviderFixture("overpass", query, { query, response: data });
  recordOverpassCall(true);

  const HIKING_EVIDENCE_KEYS = ["sac_scale", "trail_visibility", "route"];
  const results: OverpassNearbyRecommendation[] = [];
  const seenNames = new Set<string>();
  for (const el of data.elements) {
    const tags = el.tags ?? {};
    const name = tags.name || tags["name:en"];
    const placeLat = el.lat ?? el.center?.lat;
    const placeLon = el.lon ?? el.center?.lon;
    if (!name || placeLat == null || placeLon == null) continue;
    const hasHikingEvidence = HIKING_EVIDENCE_KEYS.some((key) => Boolean(tags[key]));
    if (!hasHikingEvidence) continue; // a named-but-ordinary path (e.g. a sidewalk) — never enough on its own
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    results.push({
      name,
      category: "nature",
      location: options.areaLabelForLocation ?? "",
      shortDescription: tags.description ?? tags["description:en"] ?? null,
      lat: placeLat,
      lon: placeLon,
      openingHours: tags.opening_hours ?? null,
      wikipediaUrl: null,
      website: tags.website ?? tags["contact:website"] ?? null,
      provenance: {
        provider: "overpass",
        providerId: `overpass:nature:${placeLat.toFixed(5)}:${placeLon.toFixed(5)}:${name}`,
        osmTags: tags as Record<string, string>,
      },
    });
    if (results.length >= resultLimit) break;
  }
  return { results, providerFailed: false, rawElementCount: data.elements.length, elapsedMs };
}
