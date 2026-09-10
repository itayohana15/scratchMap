import assert from "node:assert/strict";
import test from "node:test";

import {
  optimizeStayRouteSequence,
  scoreStayRoute,
  countRegionRevisits,
  verifyStayRouteInvariants,
  DEFAULT_ROUTE_SCORE_WEIGHTS,
  type StayRouteNode,
  type RouteScoreWeights,
} from "../src/lib/server/itinerary-planning-principles";

function node(id: string, lat: number, lon: number, value = 1): StayRouteNode {
  return { id, lat, lon, hasAnchor: true, value };
}

function distinctIds(sequence: StayRouteNode[]): string[] {
  return sequence.map((n) => n.id);
}

// Small exact TSP solver (brute force) — only ever used in tests on n<=6
// nodes, to establish ground truth independent of this codebase's own
// optimizer, for the "greedy trap" test below.
function bruteForceOptimalOrder(
  nodes: StayRouteNode[],
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  weights: RouteScoreWeights
): number {
  function permute<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += 1) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permute(rest)) result.push([arr[i], ...p]);
    }
    return result;
  }
  let best = Infinity;
  for (const perm of permute(nodes)) {
    const score = scoreStayRoute(perm, arrivalAnchor, departureAnchor, weights).total;
    if (score < best) best = score;
  }
  return best;
}

// 1. Four clusters in a line: optimizer returns a monotonic, low-cost route.
test("optimizeStayRouteSequence: four collinear stays produce a monotonic (non-crossing) route", () => {
  const nodes = [node("P0", 0, 0), node("P1", 0, 1), node("P2", 0, 2), node("P3", 0, 3)];
  const shuffled = [nodes[0], nodes[2], nodes[1], nodes[3]];

  const optimized = optimizeStayRouteSequence(shuffled, null, null);
  const lons = optimized.map((n) => n.lon);
  const increasing = lons.every((lon, i) => i === 0 || lon >= lons[i - 1]);
  const decreasing = lons.every((lon, i) => i === 0 || lon <= lons[i - 1]);
  assert.ok(increasing || decreasing, `expected a monotonic route along the line, got: ${optimized.map((n) => n.id).join(",")}`);
  assert.equal(countRegionRevisits(optimized), 0);
});

// 2. Input order A,C,B,D (out of order) reorders to the geographically
// coherent A,B,C,D — value on A breaks the direction-symmetry deterministically.
test("optimizeStayRouteSequence: A,C,B,D reorders to A,B,C,D when A is the natural start", () => {
  const A = node("A", 0, 0, 10);
  const B = node("B", 0, 1, 1);
  const C = node("C", 0, 2, 1);
  const D = node("D", 0, 3, 1);

  const optimized = optimizeStayRouteSequence([A, C, B, D], { lat: 0, lon: 0 }, null);
  assert.deepEqual(distinctIds(optimized), ["A", "B", "C", "D"]);
});

// 3. An A,B,A-style (same-region) revisit disappears after optimization.
test("optimizeStayRouteSequence: a same-region non-contiguous revisit is eliminated", () => {
  const A = node("A", 0, 0);
  const ANear = node("A2", 0.01, 0.01); // well within STAY_REGION_REVISIT_RADIUS_KM of A
  const B = node("B", 20, 20); // a genuinely different, distant region

  const withRevisit = [A, B, ANear];
  assert.ok(countRegionRevisits(withRevisit) > 0, "test setup sanity check: the input itself must contain a revisit");

  const optimized = optimizeStayRouteSequence(withRevisit, null, null);
  assert.equal(countRegionRevisits(optimized), 0, `expected the revisit to disappear, got: ${optimized.map((n) => n.id).join(",")}`);
});

// 3b. Direct scoreStayRoute formula check — deliberately NOT going through
// the search (2-opt alone already avoids a revisit for a simple 2-close/
// 1-far layout, by the plain triangle inequality: doubling back to a far
// region always costs roughly 2x its one-way distance, so distance ALONE
// already dominates for that shape — see test 3 above). This is the one
// that actually isolates the revisit WEIGHT's own contribution: two fixed
// sequences over the same 3 nodes, engineered so the raw travel-distance
// gap between them (~200km) is real but modest, while the revisit
// penalty (800) is deliberately large enough to dominate it — proving the
// weight itself is load-bearing in the score, independent of the search.
test("scoreStayRoute: the revisit penalty dominates a modest travel-distance difference", () => {
  const A = node("A", 0, 0);
  const ANear = node("ANear", 0, 0.001); // ~0.1km from A — same region
  const B = node("B", 1.8, 0); // ~200km away — a genuinely different region

  const clean = [A, ANear, B]; // revisitCount = 0
  const revisit = [A, B, ANear]; // revisitCount = 1

  const cleanScore = scoreStayRoute(clean, null, null);
  const revisitScore = scoreStayRoute(revisit, null, null);
  assert.equal(cleanScore.revisitCount, 0);
  assert.equal(revisitScore.revisitCount, 1);
  assert.ok(
    revisitScore.total - cleanScore.total >= 700,
    `expected the revisit penalty to dominate the ~200km raw-distance gap (clean=${cleanScore.total}, revisit=${revisitScore.total})`
  );
});

// 4. Arrival anchored near A: A becomes first when feasible.
test("optimizeStayRouteSequence: arrival anchored near A puts A first", () => {
  const A = node("A", 50, 50);
  const B = node("B", 10, 10);
  const C = node("C", 30, 30);
  const arrivalAnchor = { lat: 50.01, lon: 50.01 };

  const optimized = optimizeStayRouteSequence([B, C, A], arrivalAnchor, null);
  assert.equal(optimized[0].id, "A");
});

// 5. Departure anchored near D: D becomes last when feasible.
test("optimizeStayRouteSequence: departure anchored near D puts D last", () => {
  const A = node("A", 50, 50);
  const B = node("B", 10, 10);
  const C = node("C", 30, 30);
  const D = node("D", 0, 0);
  const departureAnchor = { lat: 0.01, lon: 0.01 };

  const optimized = optimizeStayRouteSequence([D, A, B, C], null, departureAnchor);
  assert.equal(optimized[optimized.length - 1].id, "D");
});

// 6. Greedy trap: nearest-neighbor alone is provably suboptimal here (verified
// against an exact brute-force TSP solver); optimizeStayRouteSequence (which
// includes the 2-opt improvement step) must reach the true optimum.
test("optimizeStayRouteSequence: escapes a real nearest-neighbor-only local optimum (matches brute-force optimum)", () => {
  const nodes = [node("P0", 0, 0), node("P1", 2, 1), node("P2", 0, 2), node("P3", 2, 3), node("P4", 4, 0.5)];
  const trueOptimalScore = bruteForceOptimalOrder(nodes, null, null, DEFAULT_ROUTE_SCORE_WEIGHTS);

  const optimized = optimizeStayRouteSequence([...nodes], null, null);
  const optimizedScore = scoreStayRoute(optimized, null, null).total;

  assert.ok(
    Math.abs(optimizedScore - trueOptimalScore) < 1e-6,
    `expected the optimizer to reach the true optimum (${trueOptimalScore}), got ${optimizedScore}`
  );
});

// 7. optimizeStayRouteSequence never drops a stay itself — dropping/merging
// a low-value distant detour is a SEPARATE decision made elsewhere in the
// pipeline (buildTripFramePhases' significance filter / short-stay
// viability repair), never by this pure permutation optimizer.
test("optimizeStayRouteSequence never drops a node, even a low-value distant one", () => {
  const nodes = [node("A", 0, 0, 100), node("B", 0, 1, 100), node("FarLowValue", 80, 80, 1)];
  const optimized = optimizeStayRouteSequence(nodes, null, null);
  assert.equal(optimized.length, nodes.length);
  assert.ok(optimized.some((n) => n.id === "FarLowValue"), "a low-value distant node must still survive optimization itself");
});

// 8. A high-value distant stay is preserved and placed coherently (at an
// end of the sequence, not sandwiched in a way that creates a revisit).
test("optimizeStayRouteSequence preserves a high-value distant stay in a coherent position", () => {
  const A = node("A", 0, 0, 50);
  const B = node("B", 0, 1, 50);
  const C = node("C", 0, 2, 50);
  const distantValuable = node("Distant", 40, 40, 200);

  const optimized = optimizeStayRouteSequence([A, B, distantValuable, C], null, null);
  assert.ok(optimized.some((n) => n.id === "Distant"), "the high-value distant stay must survive");
  const distantIndex = optimized.findIndex((n) => n.id === "Distant");
  assert.ok(
    distantIndex === 0 || distantIndex === optimized.length - 1,
    `expected the distant stay at one end of the route, found it at index ${distantIndex} of ${optimized.map((n) => n.id).join(",")}`
  );
  assert.equal(countRegionRevisits(optimized), 0);
});

// 9. Same input twice: deterministic identical route (no randomness anywhere).
test("optimizeStayRouteSequence is deterministic across repeated calls with identical input", () => {
  const build = () => [node("A", 12, 34, 7), node("B", 1, 1, 3), node("C", 50, 20, 9), node("D", 5, 60, 2)];

  const first = optimizeStayRouteSequence(build(), { lat: 12, lon: 34 }, { lat: 5, lon: 60 });
  const second = optimizeStayRouteSequence(build(), { lat: 12, lon: 34 }, { lat: 5, lon: 60 });

  assert.deepEqual(distinctIds(first), distinctIds(second));
});

// verifyStayRouteInvariants — direct coverage of the assertion function itself.
test("verifyStayRouteInvariants flags a non-contiguous revisit and a missing anchor, passes a clean route", () => {
  const A = node("A", 0, 0);
  const ANear = { ...node("A2", 0.01, 0.01) };
  const B = node("B", 20, 20);
  const noAnchor: StayRouteNode = { id: "Ghost", lat: 0, lon: 0, hasAnchor: false, value: 1 };

  const violations = verifyStayRouteInvariants([A, B, ANear, noAnchor], null, null);
  assert.ok(violations.some((v) => v.type === "non_contiguous_revisit"));
  assert.ok(violations.some((v) => v.type === "missing_anchor"));

  const clean = verifyStayRouteInvariants([A, ANear, B], null, null);
  assert.equal(clean.length, 0);
});

test("verifyStayRouteInvariants flags an avoidable arrival/departure mismatch", () => {
  const near = node("Near", 0, 0);
  const far = node("Far", 50, 50);
  const arrivalAnchor = { lat: 0.01, lon: 0.01 };

  // "Far" placed first when "Near" was available and much closer to arrival.
  const violations = verifyStayRouteInvariants([far, near], arrivalAnchor, null);
  assert.ok(violations.some((v) => v.type === "arrival_mismatch"));
});
