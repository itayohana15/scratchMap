import { evaluateFinalBaseDepartureFeasibility } from "../flight-planning";
import { estimateMinutesForMode, selectTransportMode, type TransportMode } from "../transport-mode";
import { haversineKm } from "../trip-workspace";
import type { RecommendationCategory } from "../trip-workspace";

/**
 * Reusable "how to plan a trip" reference layer, shared by the trip-frame
 * builder and the main day-by-day generation prompt/repair pipeline in
 * country-itinerary-generation.ts. Encodes trip-length pacing rules and
 * energy-level classification as data, not scattered magic numbers.
 *
 * The three archetypes below are the behavioral benchmark this module
 * encodes (short trips move like the "Berlin style", medium trips like the
 * "Georgia style", long trips like the "Japan style" — see project chat
 * history for the full itineraries; only the Georgia and Japan reference
 * files exist on disk, so the short-trip archetype is derived from its own
 * written description rather than a source file):
 * - Short (1-6 days): tight, single-base, walkable-neighborhood clustering.
 * - Medium (7-16 days): 2-4 regional bases, day trips, deliberate transfer days.
 * - Long (17+ days): geographic phases, varied experience categories, rest days.
 */

// A cluster/area whose content takes at least this long is worth a
// dedicated overnight base on its own merits — roughly "more than half a
// normal sightseeing day." Single source of truth for both this file's
// buildTripFramePhases (area significance) and route-optimization.ts's
// decideClusterRole (cluster role) — not an arbitrary country-specific
// number, and never duplicated between the two.
export const OVERNIGHT_WORTHY_MINUTES = 240;

export type TripLengthBucketId =
  | "micro_city"
  | "single_base"
  | "regional"
  | "multi_phase"
  | "extended_multi_phase"
  | "slow_travel";

export interface TripLengthBucket {
  id: TripLengthBucketId;
  label: string;
  minDays: number;
  maxDays: number | null;
  minBases: number;
  maxBases: number;
  guidance: string;
}

export const TRIP_LENGTH_BUCKETS: TripLengthBucket[] = [
  {
    id: "micro_city",
    label: "Micro-city planning",
    minDays: 1,
    maxDays: 3,
    minBases: 1,
    maxBases: 1,
    guidance:
      "Single base, one dense but comfortable geographic cluster per day. No day trips unless they offer exceptional value.",
  },
  {
    id: "single_base",
    label: "Single base with optional day trip",
    minDays: 4,
    maxDays: 6,
    minBases: 1,
    maxBases: 2,
    guidance:
      "Keep one base for the whole trip. At most one short regional day trip if it clearly earns its place.",
  },
  {
    id: "regional",
    label: "1-3 regional bases",
    minDays: 7,
    maxDays: 10,
    minBases: 1,
    maxBases: 3,
    guidance:
      "Divide the trip into up to three logical bases/regions with 2-4 nights each, connected by meaningful transfer days.",
  },
  {
    id: "multi_phase",
    label: "2-4 geographic phases",
    minDays: 11,
    maxDays: 16,
    minBases: 2,
    maxBases: 4,
    guidance:
      "Build distinct geographic phases (city, nature, coast, historic region). Vary pacing and introduce a rest day.",
  },
  {
    id: "extended_multi_phase",
    label: "3-6 phases with recovery days",
    minDays: 17,
    maxDays: 24,
    minBases: 3,
    maxBases: 6,
    guidance:
      "Multiple regional phases with real rhythm: heavy sightseeing, local neighborhood days, nature, recovery days between long excursions.",
  },
  {
    id: "slow_travel",
    label: "Slow travel / regional phases",
    minDays: 25,
    maxDays: null,
    minBases: 3,
    maxBases: 10,
    guidance:
      "Full slow-travel model: regional phases, deeper local exploration, recovery days, and flexible unplanned time.",
  },
];

export function getTripLengthBucket(dayCount: number): TripLengthBucket {
  const safeDayCount = Math.max(1, Math.round(dayCount));
  return (
    TRIP_LENGTH_BUCKETS.find(
      (bucket) => safeDayCount >= bucket.minDays && (bucket.maxDays == null || safeDayCount <= bucket.maxDays)
    ) ?? TRIP_LENGTH_BUCKETS[TRIP_LENGTH_BUCKETS.length - 1]
  );
}

export function expectedBaseCountRange(dayCount: number): { min: number; max: number } {
  const bucket = getTripLengthBucket(dayCount);
  return { min: bucket.minBases, max: bucket.maxBases };
}

/**
 * Trip-frame: the geography-first plan of base cities/regions and nights
 * per base, produced BEFORE day-level content is generated. Ephemeral —
 * used only to constrain the generation prompt and to validate day output,
 * never persisted on the stored itinerary.
 */
export interface TripFramePhase {
  id: string;
  areaLabel: string;
  nights: number;
  startDayNumber: number;
  endDayNumber: number;
  intent: "city" | "nature" | "coast" | "historic" | "mixed";
}

/**
 * A geographically real but non-overnight cluster explicitly attached to
 * the nearest surviving overnight phase (spec "DAY-TRIP CLUSTER" — never a
 * competing hotel base). Carried on the TripFrame so the generation prompt
 * can turn it into an explicit day trip FROM that base, and so debug/QA
 * output can show why it exists (spec "REQUIRED DEBUG/QA DATA").
 */
export interface TripFrameDayTripHint {
  areaLabel: string;
  attachedToAreaLabel: string;
  requiredTimeMinutes: number;
}

/** Spec "REQUIRED DEBUG/QA DATA" — development-only visibility into why the cluster/stay structure came out the way it did; never surfaced in normal production UI. */
export interface TripFramePlanningTrace {
  clusterCount: number;
  overnightClusterAreas: string[];
  dayTripClusterAreas: string[];
  mergedClusterAreas: string[];
  skippedClusterAreas: string[];
  backtrackingReordered: boolean;
  shortStayMerges: string[];
}

export interface TripFrame {
  bucketId: TripLengthBucketId;
  phases: TripFramePhase[];
  source: "deterministic" | "ai";
  /** Optional — absent when the deterministic frame was built with no real geographic clustering data (e.g. no coordinates at all in the candidate pool) or by any older code path. */
  dayTripHints?: TripFrameDayTripHint[];
  /** Optional — development-only planning trace (spec "REQUIRED DEBUG/QA DATA"). */
  planningTrace?: TripFramePlanningTrace;
}

export function findFramePhaseForDay(frame: TripFrame, dayNumber: number): TripFramePhase | null {
  return frame.phases.find((phase) => dayNumber >= phase.startDayNumber && dayNumber <= phase.endDayNumber) ?? null;
}

/**
 * Explicit model of a base change between two consecutive TripFrame phases
 * (spec §C1) — no overnight teleportation: every phase boundary gets a
 * real, computed transition rather than the next day's content simply
 * starting somewhere else. Reuses the existing distance-based transport
 * infrastructure (transport-mode.ts's selectTransportMode/
 * estimateMinutesForMode — the exact same primitives item-level travel
 * already uses) rather than a second, disconnected routing system.
 */
export interface StayTransition {
  fromBase: string;
  toBase: string;
  fromCoordinates: { lat: number; lon: number } | null;
  toCoordinates: { lat: number; lon: number } | null;
  transportMode: TransportMode;
  /** Null only when neither base's real coordinates are known. */
  estimatedTravelMinutes: number | null;
  /** The day this transition happens on — always the new phase's first day. */
  dayNumber: number;
}

/**
 * One transition per phase boundary (spec §C1/§C2) — `areaAnchors` is the
 * same per-area coordinate centroid map used by
 * reorderAreasForDepartureFeasibility, so both features stay derived from
 * one real geography source rather than two.
 */
export function buildStayTransitions(
  frame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>
): StayTransition[] {
  const transitions: StayTransition[] = [];

  for (let index = 1; index < frame.phases.length; index += 1) {
    const from = frame.phases[index - 1];
    const to = frame.phases[index];
    const fromCoordinates = areaAnchors.get(from.areaLabel) ?? null;
    const toCoordinates = areaAnchors.get(to.areaLabel) ?? null;
    const distanceKm =
      fromCoordinates && toCoordinates
        ? haversineKm(fromCoordinates.lat, fromCoordinates.lon, toCoordinates.lat, toCoordinates.lon)
        : null;
    // Luggage + intercity are always true here — a stay transition is by
    // definition an overnight base change, never a same-day local hop.
    const transportMode =
      distanceKm != null ? selectTransportMode(distanceKm, { hasLuggage: true, isIntercity: true }) : "car";
    const estimatedTravelMinutes = distanceKm != null ? estimateMinutesForMode(distanceKm, transportMode) : null;

    transitions.push({
      fromBase: from.areaLabel,
      toBase: to.areaLabel,
      fromCoordinates,
      toCoordinates,
      transportMode,
      estimatedTravelMinutes,
      dayNumber: to.startDayNumber,
    });
  }

  return transitions;
}

// Section A7 — a bounded number of structural-repair attempts per
// generation, never an unbounded/retrying loop.
export const MAX_STAY_STRUCTURE_REPAIR_PASSES = 2;

export type StayStructureRepairStrategy =
  | "shift_boundary_earlier"
  | "shift_boundary_later"
  | "reselect_base"
  | "merge_short_stay";

export interface StayStructureRepairResult {
  frame: TripFrame;
  changed: boolean;
  strategy: StayStructureRepairStrategy | null;
}

function dayRangeHasProtectedContent(phase: TripFramePhase, protectedDayNumbers: Set<number>): boolean {
  for (let day = phase.startDayNumber; day <= phase.endDayNumber; day += 1) {
    if (protectedDayNumbers.has(day)) return true;
  }
  return false;
}

function shiftPhaseBoundary(frame: TripFrame, phaseIndex: number, delta: -1 | 1): TripFrame {
  const phases = frame.phases.map((phase) => ({ ...phase }));
  phases[phaseIndex - 1].endDayNumber += delta;
  phases[phaseIndex - 1].nights += delta;
  phases[phaseIndex].startDayNumber += delta;
  phases[phaseIndex].nights -= delta;
  return { ...frame, phases };
}

function mergePhase(frame: TripFrame, removeIndex: number, intoIndex: number): TripFrame {
  const removed = frame.phases[removeIndex];
  const phases = frame.phases
    .map((phase, index) =>
      index === intoIndex
        ? {
            ...phase,
            startDayNumber: Math.min(phase.startDayNumber, removed.startDayNumber),
            endDayNumber: Math.max(phase.endDayNumber, removed.endDayNumber),
            nights: phase.nights + removed.nights,
          }
        : phase
    )
    .filter((_, index) => index !== removeIndex);
  return { ...frame, phases };
}

export interface ShortStayViabilityResult {
  worthOvernight: boolean;
  benefitMinutes: number;
  costMinutes: number;
  reason: string;
}

/**
 * Spec "WIRE SHORT-STAY VIABILITY" — a real cost/benefit comparison for a
 * 1-night stay: its own content time vs. the real transfer cost of adding
 * a hotel change. Any of the three legitimate-1-night reasons the spec
 * names short-circuits to "keep it" without needing the numeric
 * comparison at all. THE single production short-stay evaluator —
 * route-optimization.ts re-exports this exact function rather than a
 * parallel implementation.
 */
export function evaluateShortStayViability(args: {
  clusterRequiredTimeMinutes: number;
  transferMinutesFromPrevious: number | null;
  transferMinutesToNext: number | null;
  isFixedReservation?: boolean;
  isRemoteUniqueDestination?: boolean;
  isNecessaryAirportPositioning?: boolean;
}): ShortStayViabilityResult {
  if (args.isFixedReservation || args.isRemoteUniqueDestination || args.isNecessaryAirportPositioning) {
    return {
      worthOvernight: true,
      benefitMinutes: args.clusterRequiredTimeMinutes,
      costMinutes: (args.transferMinutesFromPrevious ?? 0) + (args.transferMinutesToNext ?? 0),
      reason: "legitimate 1-night stay (fixed reservation, remote unique destination, or airport positioning)",
    };
  }

  const costMinutes = (args.transferMinutesFromPrevious ?? 0) + (args.transferMinutesToNext ?? 0);
  const benefitMinutes = args.clusterRequiredTimeMinutes;
  const worthOvernight = benefitMinutes > costMinutes;
  return {
    worthOvernight,
    benefitMinutes,
    costMinutes,
    reason: worthOvernight
      ? "the cluster's own content time exceeds the real transfer cost of a hotel change"
      : "the real transfer cost outweighs this cluster's own content time",
  };
}

/**
 * Spec "WIRE SHORT-STAY VIABILITY" — a real production pass run once right
 * after buildTripFramePhases, before any day content exists. Every
 * INTERIOR 1-night phase (never the first/last — those are far more often
 * a legitimate arrival/departure adjustment, spec "KEEP LEGITIMATE
 * ONE-NIGHT STAYS") is checked against its own real inbound/outbound
 * transition cost (buildStayTransitions — the same real distance/mode/
 * time math used everywhere else) and merged into whichever neighbor has
 * the smaller real transfer cost when it fails. Bounded: a single sweep
 * over the phases that existed when the pass started — each iteration
 * either advances or shrinks the phase list, so it always terminates.
 */
export function applyShortStayViabilityRepair(
  frame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  areaWeights: Map<string, number>
): { frame: TripFrame; mergedAreas: string[] } {
  let currentFrame = frame;
  const mergedAreas: string[] = [];
  let index = 1;

  while (index < currentFrame.phases.length - 1) {
    const phase = currentFrame.phases[index];
    if (phase.nights !== 1) {
      index += 1;
      continue;
    }

    const transitions = buildStayTransitions(currentFrame, areaAnchors);
    const inboundIndex = transitions.findIndex((transition) => transition.dayNumber === phase.startDayNumber);
    const inbound = inboundIndex >= 0 ? transitions[inboundIndex] : null;
    const outbound = inboundIndex >= 0 ? (transitions[inboundIndex + 1] ?? null) : null;

    const evaluation = evaluateShortStayViability({
      clusterRequiredTimeMinutes: Math.max(1, areaWeights.get(phase.areaLabel) ?? 0),
      transferMinutesFromPrevious: inbound?.estimatedTravelMinutes ?? null,
      transferMinutesToNext: outbound?.estimatedTravelMinutes ?? null,
    });

    if (evaluation.worthOvernight) {
      index += 1;
      continue;
    }

    mergedAreas.push(phase.areaLabel);
    const mergeIntoPrevious =
      (inbound?.estimatedTravelMinutes ?? Infinity) <= (outbound?.estimatedTravelMinutes ?? Infinity);
    currentFrame = mergePhase(currentFrame, index, mergeIntoPrevious ? index - 1 : index + 1);
    // Don't advance `index` — a different phase now occupies this
    // position after the merge, and it deserves its own check.
  }

  return { frame: currentFrame, mergedAreas };
}

/**
 * Section A1-A4 — ONE generic structural repair attempt for ONE impossible
 * stay transition (between phases[phaseIndex-1] and phases[phaseIndex]),
 * tried in the spec's own order: shift the phase boundary by a day (A2, in
 * whichever direction has a spare night to give up), reselect the "to"
 * phase's base to another feasible candidate area (A3), or merge a
 * genuinely short (1-night) phase into whichever neighbor is unaffected
 * (A4). Never touches a phase whose day range contains protected (locked/
 * fixedTime) content (A5) — that candidate strategy is simply skipped, not
 * forced. Returns `changed: false` when nothing generic and safe was
 * found; the caller (repairPlan) is responsible for bounding repeated
 * calls (spec §A7 — MAX_STAY_STRUCTURE_REPAIR_PASSES) and rebuilding every
 * derived structure afterward (spec §A6) — this function only ever
 * returns a new frame, never touches days/items/transitions itself.
 */
export function repairImpossibleStayTransition(args: {
  frame: TripFrame;
  phaseIndex: number;
  candidateAreas: string[];
  protectedDayNumbers: Set<number>;
  /** Real time/distance feasibility check for a candidate replacement base — injected so this pure planning-principles module never has to import flight-planning.ts's math itself. */
  isTransitionFeasible: (fromArea: string, toArea: string) => boolean;
}): StayStructureRepairResult {
  const { frame, phaseIndex, candidateAreas, protectedDayNumbers, isTransitionFeasible } = args;
  const toPhase = frame.phases[phaseIndex];
  const fromPhase = frame.phases[phaseIndex - 1];
  if (!toPhase || !fromPhase) return { frame, changed: false, strategy: null };

  // A2a: shift the boundary earlier — the FROM phase gives up its last
  // night to the TO phase, provided FROM still keeps at least one night
  // and that shared day isn't protected content.
  const earlierBoundaryDay = toPhase.startDayNumber - 1;
  if (fromPhase.nights > 1 && !protectedDayNumbers.has(earlierBoundaryDay)) {
    return { frame: shiftPhaseBoundary(frame, phaseIndex, -1), changed: true, strategy: "shift_boundary_earlier" };
  }

  // A2b: the symmetric case — TO gives up its first night to FROM.
  if (toPhase.nights > 1 && !protectedDayNumbers.has(toPhase.startDayNumber)) {
    return { frame: shiftPhaseBoundary(frame, phaseIndex, 1), changed: true, strategy: "shift_boundary_later" };
  }

  // A3: reselect the TO phase's base — a candidate area not already used
  // elsewhere in the frame, genuinely feasible from the FROM phase (real
  // time/distance, never a name-based rule).
  const usedAreas = new Set(frame.phases.map((phase) => phase.areaLabel));
  const alternative = candidateAreas.find(
    (area) => !usedAreas.has(area) && isTransitionFeasible(fromPhase.areaLabel, area)
  );
  if (alternative) {
    const phases = frame.phases.map((phase, index) =>
      index === phaseIndex ? { ...phase, areaLabel: alternative } : phase
    );
    return { frame: { ...frame, phases }, changed: true, strategy: "reselect_base" };
  }

  // A4: a genuinely short (1-night) stay creating this expensive transfer
  // — merge it into whichever neighbor has no protected content in its
  // range, rather than force an impossible transition around it. Not
  // "blindly eliminate all one-night stays" (spec §A4) — only the specific
  // one-night phase actually involved in THIS impossible transition, and
  // only when merging doesn't disturb protected content.
  if (toPhase.nights === 1 && !dayRangeHasProtectedContent(toPhase, protectedDayNumbers)) {
    return { frame: mergePhase(frame, phaseIndex, phaseIndex - 1), changed: true, strategy: "merge_short_stay" };
  }
  if (fromPhase.nights === 1 && !dayRangeHasProtectedContent(fromPhase, protectedDayNumbers)) {
    return { frame: mergePhase(frame, phaseIndex - 1, phaseIndex), changed: true, strategy: "merge_short_stay" };
  }

  return { frame, changed: false, strategy: null };
}

/**
 * Departure-aware final-base selection (spec §B) — runs BEFORE
 * buildTripFramePhases decides which area becomes the trip's last phase, so
 * an infeasible final base is never chosen in the first place rather than
 * being discovered later at validation time. Generic: works from
 * coordinates + a clock time only, never a named airport/city/country.
 *
 * `rankedAreas`'s LAST element (after buildTripFramePhases's own slicing)
 * is what becomes the final overnight base — this only ever reorders that
 * array so a feasible area ends up there, never touches
 * buildTripFramePhases itself. An area with no known coordinates, or when
 * no departure flight exists at all, is always treated as feasible (never
 * block on missing data) — B2's hard rejection only ever fires when a real
 * distance/time comparison genuinely fails.
 */
export function reorderAreasForDepartureFeasibility(
  rankedAreas: string[],
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  departureAirportIata: string | null,
  departureTime: string | null
): string[] {
  if (!departureAirportIata || !departureTime || rankedAreas.length <= 1) return rankedAreas;

  const isFeasible = (area: string): boolean => {
    const anchor = areaAnchors.get(area);
    if (!anchor) return true;
    const result = evaluateFinalBaseDepartureFeasibility(departureAirportIata, departureTime, anchor);
    return result?.feasible ?? true;
  };

  const lastArea = rankedAreas[rankedAreas.length - 1];
  if (isFeasible(lastArea)) return rankedAreas;

  const feasibleArea = rankedAreas.find((area) => area !== lastArea && isFeasible(area));
  if (!feasibleArea) return rankedAreas; // no known feasible alternative — leave as-is, the hard validation gate still catches it

  const rest = rankedAreas.filter((area) => area !== feasibleArea && area !== lastArea);
  return [...rest, lastArea, feasibleArea];
}

/**
 * Spec "WIRE BACKTRACKING" — a generic, coordinate-only reversal count: for
 * every interior stop, the direction of the incoming leg is compared to
 * the outgoing leg; a sharp reversal (heading substantially back the way
 * it came) counts as one unit of backtracking. 0 for a straight/coherent
 * A→B→C progression; higher for a route that doubles back on itself
 * (A→C→A→B→C). No country/region-specific logic anywhere in this
 * function — pure vector geometry on real coordinates. THE single
 * production backtracking detector — route-optimization.ts's
 * computeItineraryTravelMetrics and this file's own
 * reorderAreasToMinimizeBacktracking both call this same function.
 */
export function detectBacktracking(orderedAnchors: Array<{ lat: number; lon: number }>): number {
  if (orderedAnchors.length < 3) return 0;
  let backtrackCount = 0;
  for (let i = 1; i < orderedAnchors.length - 1; i += 1) {
    const prev = orderedAnchors[i - 1];
    const curr = orderedAnchors[i];
    const next = orderedAnchors[i + 1];
    const v1 = { x: curr.lon - prev.lon, y: curr.lat - prev.lat };
    const v2 = { x: next.lon - curr.lon, y: next.lat - curr.lat };
    const mag1 = Math.hypot(v1.x, v1.y);
    const mag2 = Math.hypot(v2.x, v2.y);
    if (mag1 === 0 || mag2 === 0) continue;
    const cosAngle = (v1.x * v2.x + v1.y * v2.y) / (mag1 * mag2);
    // cosAngle near -1 means the route reversed direction almost entirely.
    if (cosAngle < -0.3) backtrackCount += 1;
  }
  return backtrackCount;
}

/**
 * Spec "WIRE BACKTRACKING" — a real, generic route reorder: greedy
 * nearest-neighbor from the heaviest-weighted (first-ranked) area, which
 * naturally tends to avoid doubling back. Only ever adopted when it
 * genuinely scores fewer backtracks than the original order (never a
 * regression) — areas with no known real anchor are left in their
 * original relative order (can't reason about geography with nothing
 * real to compare). A single deterministic pass, not an iterative
 * optimizer — bounded by construction.
 */
export function reorderAreasToMinimizeBacktracking(
  rankedAreas: string[],
  areaAnchors: Map<string, { lat: number; lon: number } | null>
): string[] {
  if (rankedAreas.length <= 2) return rankedAreas;

  const withAnchor = rankedAreas.filter((area) => areaAnchors.get(area) != null);
  if (withAnchor.length < 3) return rankedAreas; // not enough real geography to reason about

  const originalAnchors = rankedAreas.map((area) => areaAnchors.get(area)).filter((a): a is { lat: number; lon: number } => a != null);
  const originalScore = detectBacktracking(originalAnchors);
  if (originalScore === 0) return rankedAreas; // already coherent

  const remaining = new Set(rankedAreas);
  const ordered: string[] = [rankedAreas[0]];
  remaining.delete(rankedAreas[0]);

  while (remaining.size > 0) {
    const lastAnchor = areaAnchors.get(ordered[ordered.length - 1]);
    let nearest: string | null = null;
    let nearestDistance = Infinity;
    for (const candidate of remaining) {
      const candidateAnchor = areaAnchors.get(candidate);
      const distance =
        lastAnchor && candidateAnchor ? haversineKm(lastAnchor.lat, lastAnchor.lon, candidateAnchor.lat, candidateAnchor.lon) : Infinity;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }
    // No real anchor to compare against any remaining candidate — keep the
    // original relative order for whatever's left rather than guessing.
    if (nearest == null) {
      for (const candidate of remaining) ordered.push(candidate);
      break;
    }
    ordered.push(nearest);
    remaining.delete(nearest);
  }

  const reorderedAnchors = ordered.map((area) => areaAnchors.get(area)).filter((a): a is { lat: number; lon: number } => a != null);
  const reorderedScore = detectBacktracking(reorderedAnchors);
  return reorderedScore < originalScore ? ordered : rankedAreas;
}

// =====================================================================
// GLOBAL ROUTE OPTIMIZATION — spec "trip-frame / stay-ordering problem,
// not a day-level repair problem". Real 43-day US replay evidence:
// Seattle→Washington→Seattle, Boston→Atlanta→Boston, Austin→New York→
// Austin, Nashville→Philadelphia→Nashville — a heavy-weight area ranked
// #1, a distant heavy-weight area ranked #2, and a THIRD area
// geographically near #1 (but weight-ranked #3) produced exactly this
// zig-zag, because the production order was pure weight-rank with only a
// single greedy nearest-neighbor pass (reorderAreasToMinimizeBacktracking,
// adopted only if it beat the ORIGINAL order — no multi-start, no local
// search) and a narrow last-stop-only departure swap
// (reorderAreasForDepartureFeasibility) — arrival was never considered at
// all, and neither function detects a non-contiguous REGION revisit (only
// a sharp 3-point local angle reversal).
//
// This is the ONE authoritative replacement for that reorder step at its
// single production call site (buildDeterministicTripFrame) — the two
// older functions above are left defined and independently tested (they
// have real standalone test coverage and no other code should compete
// with THIS optimizer in production), but production no longer calls them.
// This never drops or merges a stay — it is a pure permutation optimizer
// over whichever stays buildTripFramePhases' own significance filter
// already selected (spec §E: never solve backtracking by deleting value).
//
// Architecture (spec §I): buildDeterministicTripFrame already (1) decides
// viable overnight areas via decideClusterRole/buildTripFramePhases'
// significance filter before this ever runs, and (since
// allocateNightsForClusters computes each area's own night count purely
// from its own required-content-minutes, never from its position) night
// allocation is already order-independent — so (2) optimizing order here
// and (3) keeping each area's already-allocated night count, just at its
// new position, is achieved by the existing reorderPhasesByArea call
// immediately after this, with no restructuring of the well-tested
// buildTripFramePhases needed. (4) applyShortStayViabilityRepair and (5)
// a post-repair invariant re-check both still run after, unchanged in
// position.
// =====================================================================

/** A same-region reappearance within this many km of an already-left area counts as a revisit — large enough to catch a metro-area-adjacent second area (e.g. a satellite city), small enough to never conflate two genuinely different regions. Generic worldwide; never a named place. */
export const STAY_REGION_REVISIT_RADIUS_KM = 150;

/** How much extra distance (beyond the best achievable) an arrival/departure endpoint may sit at before it's flagged as a real, worth-fixing mismatch rather than an unavoidable rounding-scale difference. */
export const ARRIVAL_DEPARTURE_MISMATCH_TOLERANCE_KM = 150;

export interface StayRouteNode {
  /** Stable id — this codebase's normalized area label, the same key areaAnchors/areaWeights are keyed by. */
  id: string;
  lat: number;
  lon: number;
  /** True only when a real, resolved anchor exists — an anchor-less node is never geometrically reordered (nothing real to compare), matching the pre-existing philosophy in reorderAreasToMinimizeBacktracking. */
  hasAnchor: boolean;
  /** Cluster/area significance (e.g. required-content-minutes or candidate weight) — informational for logging/reporting; a pure permutation of a FIXED node set has the same total value regardless of order, so this never discriminates between orderings by itself (see spec §H note on value preservation living in the SELECTION step, not here). */
  value: number;
}

export interface RouteScoreWeights {
  /** Per km of total inter-stay travel. */
  travel: number;
  /** Extra weight on top of `travel` for the single largest leg — discourages one huge outlier jump even when total distance is otherwise fine. */
  maxJump: number;
  /** Flat penalty per non-contiguous region reappearance — deliberately large: spec §F says a revisit must normally be strongly dominated by any revisit-free alternative. */
  revisit: number;
  /** Per km of avoidable extra distance between the arrival anchor and the first stay (0 when the closest available stay was chosen). */
  arrivalMismatch: number;
  /** Per km of avoidable extra distance between the departure anchor and the last stay. */
  departureMismatch: number;
}

/** Spec §H "keep weights generic and centralized" — the one production set; a caller may pass its own for testing but never a second competing default. */
export const DEFAULT_ROUTE_SCORE_WEIGHTS: RouteScoreWeights = {
  travel: 1,
  maxJump: 0.3,
  revisit: 800,
  arrivalMismatch: 4,
  departureMismatch: 4,
};

export interface RouteScoreBreakdown {
  travelCostKm: number;
  maxJumpKm: number;
  revisitCount: number;
  arrivalMismatchKm: number;
  departureMismatchKm: number;
  total: number;
}

/** Union-find grouping by mutual proximity — the SAME generic radius-based idea used elsewhere in this codebase for geographic compatibility, never a named-place lookup. */
function groupStayNodesByRegion(nodes: StayRouteNode[], radiusKm: number): number[] {
  const parent = nodes.map((_, index) => index);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      if (haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon) <= radiusKm) {
        union(i, j);
      }
    }
  }
  return nodes.map((_, index) => find(index));
}

/**
 * Spec §F "generic revisit/backtracking penalty" — counts every time the
 * route returns to a region it had already left (any earlier CONTIGUOUS
 * block of the same region-group, followed by at least one stay from a
 * DIFFERENT region-group, followed by this region-group again). Zero for
 * a genuinely coherent A→B→C progression, or for a region visited in one
 * single contiguous block regardless of how many stays it contains.
 * Deliberately distinct from detectBacktracking above (a local 3-point
 * angle check) — this catches a revisit even across several intervening
 * stays, which a purely local angle check structurally cannot.
 */
export function countRegionRevisits(
  sequence: StayRouteNode[],
  radiusKm: number = STAY_REGION_REVISIT_RADIUS_KM
): number {
  if (sequence.length < 3) return 0;
  const regionIds = groupStayNodesByRegion(sequence, radiusKm);
  const closedRegions = new Set<number>();
  let revisits = 0;
  let i = 0;
  while (i < sequence.length) {
    const region = regionIds[i];
    if (closedRegions.has(region)) revisits += 1;
    let j = i;
    while (j + 1 < sequence.length && regionIds[j + 1] === region) j += 1;
    closedRegions.add(region);
    i = j + 1;
  }
  return revisits;
}

/**
 * Spec §H "make the route score explicit and testable" — the ONE
 * objective function both the optimizer below and its own tests use.
 * Lower is better. arrivalMismatch/departureMismatch are "regret" terms
 * (extra distance versus the best achievable choice within this SAME
 * node set), not raw distance — a trip that is simply far from the
 * airport everywhere never gets punished for geography it can't change,
 * only for choosing a WORSE stay than one already available to it.
 */
export function scoreStayRoute(
  sequence: StayRouteNode[],
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  weights: RouteScoreWeights = DEFAULT_ROUTE_SCORE_WEIGHTS
): RouteScoreBreakdown {
  let travelCostKm = 0;
  let maxJumpKm = 0;
  for (let i = 0; i < sequence.length - 1; i += 1) {
    const legKm = haversineKm(sequence[i].lat, sequence[i].lon, sequence[i + 1].lat, sequence[i + 1].lon);
    travelCostKm += legKm;
    if (legKm > maxJumpKm) maxJumpKm = legKm;
  }

  const revisitCount = countRegionRevisits(sequence);

  let arrivalMismatchKm = 0;
  if (arrivalAnchor && sequence.length > 0) {
    const firstDistanceKm = haversineKm(arrivalAnchor.lat, arrivalAnchor.lon, sequence[0].lat, sequence[0].lon);
    const bestPossibleKm = Math.min(
      ...sequence.map((node) => haversineKm(arrivalAnchor.lat, arrivalAnchor.lon, node.lat, node.lon))
    );
    arrivalMismatchKm = Math.max(0, firstDistanceKm - bestPossibleKm);
  }

  let departureMismatchKm = 0;
  if (departureAnchor && sequence.length > 0) {
    const lastNode = sequence[sequence.length - 1];
    const lastDistanceKm = haversineKm(departureAnchor.lat, departureAnchor.lon, lastNode.lat, lastNode.lon);
    const bestPossibleKm = Math.min(
      ...sequence.map((node) => haversineKm(departureAnchor.lat, departureAnchor.lon, node.lat, node.lon))
    );
    departureMismatchKm = Math.max(0, lastDistanceKm - bestPossibleKm);
  }

  const total =
    weights.travel * travelCostKm +
    weights.maxJump * maxJumpKm +
    weights.revisit * revisitCount +
    weights.arrivalMismatch * arrivalMismatchKm +
    weights.departureMismatch * departureMismatchKm;

  return { travelCostKm, maxJumpKm, revisitCount, arrivalMismatchKm, departureMismatchKm, total };
}

function nearestNeighborConstruct(nodes: StayRouteNode[], seedIndex: number): StayRouteNode[] {
  const remaining = nodes.map((_, index) => index).filter((index) => index !== seedIndex);
  const order = [seedIndex];
  while (remaining.length > 0) {
    const lastNode = nodes[order[order.length - 1]];
    let bestIndex = remaining[0];
    let bestDistance = Infinity;
    for (const candidateIndex of remaining) {
      const distance = haversineKm(lastNode.lat, lastNode.lon, nodes[candidateIndex].lat, nodes[candidateIndex].lon);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = candidateIndex;
      }
    }
    order.push(bestIndex);
    remaining.splice(remaining.indexOf(bestIndex), 1);
  }
  return order.map((index) => nodes[index]);
}

function twoOptSwap(sequence: StayRouteNode[], i: number, j: number): StayRouteNode[] {
  return [...sequence.slice(0, i), ...sequence.slice(i, j + 1).reverse(), ...sequence.slice(j + 1)];
}

/**
 * Spec §G "nearest-neighbor + 2-opt... bounded, deterministic, no
 * expensive unbounded TSP solver". Bounded by construction: at most
 * MAX_TWO_OPT_PASSES full O(n^2) sweeps, each trial scored in O(n) — for
 * the realistic n (a trip's own overnight base count, capped at the
 * bucket table's own maxBases of 10), this is at most a few thousand
 * scoring calls, not an unbounded search.
 */
const MAX_TWO_OPT_PASSES = 25;

function twoOptImprove(
  sequence: StayRouteNode[],
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  weights: RouteScoreWeights
): StayRouteNode[] {
  let current = sequence;
  let currentScore = scoreStayRoute(current, arrivalAnchor, departureAnchor, weights).total;

  for (let pass = 0; pass < MAX_TWO_OPT_PASSES; pass += 1) {
    let improvedThisPass = false;
    for (let i = 0; i < current.length - 1; i += 1) {
      for (let j = i + 1; j < current.length; j += 1) {
        const candidate = twoOptSwap(current, i, j);
        const candidateScore = scoreStayRoute(candidate, arrivalAnchor, departureAnchor, weights).total;
        if (candidateScore < currentScore - 1e-9) {
          current = candidate;
          currentScore = candidateScore;
          improvedThisPass = true;
        }
      }
    }
    if (!improvedThisPass) break;
  }
  return current;
}

/**
 * Spec §G "multi-start optimization... for ~10-20 stays a single greedy
 * nearest-neighbor is not enough". Seeds: nearest-to-arrival (the missing
 * piece the OLD reorder never considered at all), highest-value node, and
 * the original first node (a stable, always-available baseline) — deduped,
 * each run through nearest-neighbor construction + bounded 2-opt, and the
 * globally best-SCORING result wins. Deterministic: no randomness
 * anywhere, ties broken by insertion order (strict `<` comparison, first
 * candidate wins). Never drops or merges a node — a pure permutation of
 * whatever it's given (spec §E).
 */
export function optimizeStayRouteSequence(
  nodes: StayRouteNode[],
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  weights: RouteScoreWeights = DEFAULT_ROUTE_SCORE_WEIGHTS
): StayRouteNode[] {
  if (nodes.length <= 1) return nodes;

  const withAnchor = nodes.filter((node) => node.hasAnchor);
  const withoutAnchor = nodes.filter((node) => !node.hasAnchor);
  if (withAnchor.length < 2) return nodes; // not enough real geography to reason about — leave everything in its original order

  const seedIndices = new Set<number>();
  seedIndices.add(0); // stable baseline seed, always available

  let highestValueIndex = 0;
  withAnchor.forEach((node, index) => {
    if (node.value > withAnchor[highestValueIndex].value) highestValueIndex = index;
  });
  seedIndices.add(highestValueIndex);

  if (arrivalAnchor) {
    let nearestArrivalIndex = 0;
    let nearestArrivalDistance = Infinity;
    withAnchor.forEach((node, index) => {
      const distance = haversineKm(arrivalAnchor.lat, arrivalAnchor.lon, node.lat, node.lon);
      if (distance < nearestArrivalDistance) {
        nearestArrivalDistance = distance;
        nearestArrivalIndex = index;
      }
    });
    seedIndices.add(nearestArrivalIndex);
  }

  let best: StayRouteNode[] = withAnchor;
  let bestScore = scoreStayRoute(withAnchor, arrivalAnchor, departureAnchor, weights).total;

  for (const seedIndex of seedIndices) {
    const constructed = nearestNeighborConstruct(withAnchor, seedIndex);
    const improved = twoOptImprove(constructed, arrivalAnchor, departureAnchor, weights);
    const score = scoreStayRoute(improved, arrivalAnchor, departureAnchor, weights).total;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = improved;
    }
  }

  // Anchor-less nodes can't be reasoned about geographically — appended in
  // their original relative order, same philosophy as the pre-existing
  // reorderAreasToMinimizeBacktracking.
  return [...best, ...withoutAnchor];
}

export type RouteInvariantViolationType =
  | "duplicate_stay"
  | "non_contiguous_revisit"
  | "missing_anchor"
  | "arrival_mismatch"
  | "departure_mismatch";

export interface RouteInvariantViolation {
  type: RouteInvariantViolationType;
  detail: string;
}

/**
 * Spec §J "hard route invariants... before day generation, assert...". A
 * diagnostic assertion, not a second repair mechanism — the optimizer
 * above already scores every one of these; this is the QA-visible proof
 * that it actually achieved them (or an honest record of why it couldn't,
 * e.g. genuinely infeasible geography with no closer alternative).
 */
export function verifyStayRouteInvariants(
  sequence: StayRouteNode[],
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  regionRadiusKm: number = STAY_REGION_REVISIT_RADIUS_KM
): RouteInvariantViolation[] {
  const violations: RouteInvariantViolation[] = [];
  const seen = new Set<string>();

  for (const node of sequence) {
    if (seen.has(node.id)) {
      violations.push({ type: "duplicate_stay", detail: `"${node.id}" appears more than once in the route` });
    }
    seen.add(node.id);
    if (!node.hasAnchor) {
      violations.push({ type: "missing_anchor", detail: `"${node.id}" has no usable anchor coordinates` });
    }
  }

  const revisitCount = countRegionRevisits(sequence, regionRadiusKm);
  if (revisitCount > 0) {
    violations.push({
      type: "non_contiguous_revisit",
      detail: `${revisitCount} region(s) revisited non-contiguously after being left`,
    });
  }

  if (arrivalAnchor && sequence.length > 1) {
    const firstDistanceKm = haversineKm(arrivalAnchor.lat, arrivalAnchor.lon, sequence[0].lat, sequence[0].lon);
    const bestPossibleKm = Math.min(
      ...sequence.map((node) => haversineKm(arrivalAnchor.lat, arrivalAnchor.lon, node.lat, node.lon))
    );
    if (firstDistanceKm - bestPossibleKm > ARRIVAL_DEPARTURE_MISMATCH_TOLERANCE_KM) {
      violations.push({
        type: "arrival_mismatch",
        detail: `first stay is ${Math.round(firstDistanceKm)}km from arrival; ${Math.round(bestPossibleKm)}km was achievable within this same stay set`,
      });
    }
  }

  if (departureAnchor && sequence.length > 1) {
    const lastNode = sequence[sequence.length - 1];
    const lastDistanceKm = haversineKm(departureAnchor.lat, departureAnchor.lon, lastNode.lat, lastNode.lon);
    const bestPossibleKm = Math.min(
      ...sequence.map((node) => haversineKm(departureAnchor.lat, departureAnchor.lon, node.lat, node.lon))
    );
    if (lastDistanceKm - bestPossibleKm > ARRIVAL_DEPARTURE_MISMATCH_TOLERANCE_KM) {
      violations.push({
        type: "departure_mismatch",
        detail: `last stay is ${Math.round(lastDistanceKm)}km from departure; ${Math.round(bestPossibleKm)}km was achievable within this same stay set`,
      });
    }
  }

  return violations;
}

/**
 * Pure geography-first phase distribution: given ranked area weights (e.g.
 * how many real candidate places fall in each area) and a bucket's base
 * count range, picks base cities and distributes the trip's days across
 * them contiguously. No AI call, no I/O — safe to unit test directly and
 * safe as the guaranteed fallback when an AI refinement call is unavailable
 * or fails.
 */
/**
 * Spec "WIRE NIGHT ALLOCATION" — nights proportional to each cluster/area's
 * own real required content time, not spread evenly by count. Every
 * cluster gets at least 1 night; rounding surplus/deficit is resolved on
 * the largest cluster(s) first so the total always matches `totalNights`
 * exactly. THE single production night-allocation algorithm — both
 * buildTripFramePhases below and route-optimization.ts's cluster-based
 * callers use this same function, not two parallel implementations.
 */
export function allocateNightsForClusters(
  clusters: Array<{ clusterRequiredTimeMinutes: number }>,
  totalNights: number
): number[] {
  if (clusters.length === 0) return [];
  if (clusters.length >= totalNights) {
    // Not enough nights for one each — give the largest clusters priority.
    const order = clusters
      .map((cluster, index) => ({ index, minutes: cluster.clusterRequiredTimeMinutes }))
      .sort((left, right) => right.minutes - left.minutes);
    const nights = new Array(clusters.length).fill(0);
    for (let i = 0; i < totalNights; i += 1) nights[order[i].index] = 1;
    return nights;
  }

  const totalMinutes = clusters.reduce((sum, cluster) => sum + cluster.clusterRequiredTimeMinutes, 0);
  const rawShares = clusters.map((cluster) =>
    totalMinutes > 0 ? (cluster.clusterRequiredTimeMinutes / totalMinutes) * totalNights : totalNights / clusters.length
  );
  const nights = rawShares.map((share) => Math.max(1, Math.round(share)));
  let diff = totalNights - nights.reduce((sum, n) => sum + n, 0);
  // Rounding can over/under-shoot the total by a few nights — resolve on
  // the largest cluster(s) first, and never drop a cluster below 1 night.
  const byMinutesDesc = clusters
    .map((cluster, index) => ({ index, minutes: cluster.clusterRequiredTimeMinutes }))
    .sort((left, right) => right.minutes - left.minutes);
  let cursor = 0;
  while (diff !== 0 && byMinutesDesc.length > 0) {
    const target = byMinutesDesc[cursor % byMinutesDesc.length].index;
    if (diff > 0) {
      nights[target] += 1;
      diff -= 1;
    } else if (nights[target] > 1) {
      nights[target] -= 1;
      diff += 1;
    }
    cursor += 1;
    if (cursor > byMinutesDesc.length * totalNights + 10) break; // safety valve, never loops forever
  }
  return nights;
}

export function buildTripFramePhases(
  rankedAreas: string[],
  areaWeights: Map<string, number>,
  dayCount: number,
  bucket: TripLengthBucket,
  pinnedArea?: string | null
): TripFramePhase[] {
  const safeDayCount = Math.max(1, Math.round(dayCount));
  let orderedAreas = rankedAreas.length > 0 ? [...rankedAreas] : [pinnedArea?.trim() || "Trip"];

  if (pinnedArea?.trim()) {
    const normalizedPinned = pinnedArea.trim().toLowerCase();
    orderedAreas = [
      pinnedArea.trim(),
      ...orderedAreas.filter((area) => area.toLowerCase() !== normalizedPinned),
    ];
  }

  // A pinned area (user already chose an accommodation area/region) is a
  // strict single-base signal — honor it rather than spreading across
  // whatever other areas happen to appear in the candidate list.
  let baseCount: number;
  if (pinnedArea?.trim()) {
    baseCount = 1;
  } else {
    // Significance is absolute ("does this area alone have enough content
    // for a real day"), not a share of the whole trip's weight — a
    // relative threshold self-defeats on geographically diverse trips: the
    // more real areas a trip has, the smaller each one's share, however
    // substantial its own content, so a wide-ranging trip could see EVERY
    // area fall short and collapse to the bucket's floor regardless of how
    // much real content exists. OVERNIGHT_WORTHY_MINUTES is the same bar
    // decideClusterRole already uses to decide a cluster deserves its own
    // overnight base in the first place.
    const significantAreaCount = orderedAreas.filter((area) => {
      const weight = Math.max(1, areaWeights.get(area) ?? 1);
      return weight >= OVERNIGHT_WORTHY_MINUTES;
    }).length;
    // The bucket table's own boundaries already imply roughly how many
    // extra days justify one more base (e.g. slow_travel's own entry point
    // is minDays/maxBases = 25/10 = 2.5 days/base) — for the one truly
    // open-ended bucket (maxDays: null), that same ratio keeps scaling the
    // ceiling past the entry point instead of freezing it at the bucket's
    // minimum-day-count value, so a 90-day trip isn't held to the same
    // ceiling as a 25-day one.
    const effectiveMaxBases =
      bucket.maxDays == null
        ? Math.max(bucket.maxBases, Math.round(safeDayCount / (bucket.minDays / bucket.maxBases)))
        : bucket.maxBases;
    baseCount = Math.min(Math.max(bucket.minBases, significantAreaCount), effectiveMaxBases);
  }

  const maxBasesForData = Math.max(1, Math.min(baseCount, orderedAreas.length, safeDayCount));
  const selectedAreas = orderedAreas.slice(0, maxBasesForData);

  // Section "WIRE NIGHT ALLOCATION" — ONE production source of truth:
  // allocateNightsForClusters (below) is the same function route-
  // optimization.ts's cluster-based callers use, not a second parallel
  // algorithm reimplemented inline here.
  const weights = selectedAreas.map((area) => Math.max(1, areaWeights.get(area) ?? 1));
  const dayShares = allocateNightsForClusters(
    weights.map((weight) => ({ clusterRequiredTimeMinutes: weight })),
    safeDayCount
  );

  const phases: TripFramePhase[] = [];
  let cursorDay = 1;
  selectedAreas.forEach((area, index) => {
    const nights = dayShares[index] ?? 1;
    const startDayNumber = cursorDay;
    const endDayNumber = cursorDay + nights - 1;
    phases.push({
      id: `phase-${index + 1}`,
      areaLabel: area,
      nights,
      startDayNumber,
      endDayNumber,
      intent: "mixed",
    });
    cursorDay = endDayNumber + 1;
  });

  return phases;
}

/**
 * Advisory activity-mix targets (spec-style guidance, not a hard gate):
 * roughly 35-50% iconic/must-see, 25-35% local/neighborhood, 15-25% niche
 * interest-driven, 10-20% flexible/rest. Popularity data isn't tracked on
 * candidates today, so this stays a coarse category-based heuristic used
 * only to enrich prompt guidance, never to block generation.
 */
export type ActivityTier = "iconic" | "local" | "niche" | "flexible";

export const ACTIVITY_MIX_TARGETS: Record<ActivityTier, { min: number; max: number }> = {
  iconic: { min: 0.35, max: 0.5 },
  local: { min: 0.25, max: 0.35 },
  niche: { min: 0.15, max: 0.25 },
  flexible: { min: 0.1, max: 0.2 },
};

const NICHE_CATEGORIES = new Set<RecommendationCategory>(["hidden_gem", "day_trip", "seasonal_event"]);
const LOCAL_CATEGORIES = new Set<RecommendationCategory>(["restaurant", "cafe", "shopping", "nightlife"]);
const FLEXIBLE_CATEGORIES = new Set<RecommendationCategory>(["nature", "family"]);

export function classifyActivityTier(category: RecommendationCategory): ActivityTier {
  if (NICHE_CATEGORIES.has(category)) return "niche";
  if (LOCAL_CATEGORIES.has(category)) return "local";
  if (FLEXIBLE_CATEGORIES.has(category)) return "flexible";
  return "iconic";
}

export function describeActivityMixTargets() {
  return (Object.entries(ACTIVITY_MIX_TARGETS) as [ActivityTier, { min: number; max: number }][])
    .map(([tier, range]) => `${tier} ${Math.round(range.min * 100)}-${Math.round(range.max * 100)}%`)
    .join(", ");
}

/**
 * Energy-level classification per stop, used to detect and repair
 * unhealthy intensity rhythm (e.g. four HIGH-energy days in a row).
 */
export type EnergyLevel = "low" | "medium" | "high";

const LOW_ENERGY_KEYWORDS = [
  "cafe",
  "coffee",
  "spa",
  "viewpoint",
  "river cruise",
  "market stroll",
  "relax",
  "rest",
  "pool",
  "קפה",
  "ספא",
  "תצפית",
  "שייט",
  "מנוחה",
  "בריכה",
  "שיטוט",
];

const HIGH_ENERGY_KEYWORDS = [
  "hike",
  "trek",
  "full-day",
  "full day",
  "theme park",
  "mountain",
  "climb",
  "long walk",
  "multi-hour",
  "טרק",
  "הליכה ארוכה",
  "טיול יום",
  "פארק שעשועים",
  "רכיבה בהרים",
  "מסלול הליכה",
  "יום שלם",
];

const LOW_ENERGY_CATEGORIES = new Set<RecommendationCategory>(["cafe"]);
const HIGH_ENERGY_CATEGORIES = new Set<RecommendationCategory>(["day_trip"]);
const MEDIUM_ENERGY_CATEGORIES = new Set<RecommendationCategory>(["museum", "shopping", "attraction", "hidden_gem"]);

function includesAnyKeywordLocal(value: string, keywords: string[]) {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

export function classifyItemEnergy(item: {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  estimatedDurationMinutes?: number | null;
}): EnergyLevel {
  if (LOW_ENERGY_CATEGORIES.has(item.category)) return "low";
  if (HIGH_ENERGY_CATEGORIES.has(item.category)) return "high";

  const text = `${item.name} ${item.shortDescription}`;
  if (includesAnyKeywordLocal(text, HIGH_ENERGY_KEYWORDS)) return "high";
  if (includesAnyKeywordLocal(text, LOW_ENERGY_KEYWORDS)) return "low";

  if ((item.estimatedDurationMinutes ?? 0) >= 240) return "high";
  if (MEDIUM_ENERGY_CATEGORIES.has(item.category)) return "medium";
  if (item.category === "nature") return "medium";

  return "medium";
}

export const MAX_CONSECUTIVE_HIGH_ENERGY_DAYS = 2;

/**
 * How much of a day's planning capacity a stop realistically consumes — the
 * missing piece that let every attraction get the same generic ~90-minute
 * treatment regardless of whether it's a viewpoint or a theme park. Used by
 * itinerary-scheduler.ts to build a real per-day timeline instead of
 * assigning fixed slot-default clock times.
 */
export type VisitScale = "quick_stop" | "short" | "medium" | "half_day" | "full_day" | "event_fixed";

export const VISIT_SCALE_DURATION_MINUTES: Record<VisitScale, { min: number; max: number; default: number }> = {
  quick_stop: { min: 15, max: 45, default: 30 },
  short: { min: 30, max: 90, default: 60 },
  medium: { min: 60, max: 150, default: 90 },
  half_day: { min: 150, max: 300, default: 210 },
  full_day: { min: 300, max: 720, default: 480 },
  // A timed reservation's duration comes from the reservation itself
  // (estimatedDurationMinutes), not a generic range — this scale exists so
  // the scheduler can recognize "this is a fixed anchor" distinctly from a
  // flexible half/full-day block.
  event_fixed: { min: 30, max: 480, default: 120 },
};

const QUICK_STOP_KEYWORDS = [
  "viewpoint",
  "lookout",
  "photo stop",
  "street",
  "square",
  "bridge",
  "statue",
  "מצפה",
  "תצפית",
  "כיכר",
  "גשר",
  "פסל",
];

// Generic worldwide architecture audit (Phase 28): "disneyland"/"disney"
// and "louvre" used to be listed here by brand/proper name — exactly the
// per-place hardcoding the planning logic must never do. Removed as pure
// cleanup, not a behavior change: any real theme park is still classified
// correctly by the generic "theme park"/"amusement park" keywords
// (Disneyland included, by TYPE not name), and "half-day"/"half day"
// already covers a text-described half-day attraction generically —
// there was no generic substitute for "louvre" specifically, so a museum
// described that way now falls through to category-based classification
// instead (still reasonable: museum → medium, and a genuinely half-day
// museum can still say so in its own description text).
const HALF_DAY_KEYWORDS = ["half-day", "half day", "חצי יום"];

const FULL_DAY_KEYWORDS = [
  "theme park",
  "amusement park",
  "national park",
  "safari",
  "ski",
  "פארק שעשועים",
  "פארק אטרקציות",
  "יום שלם",
];

/**
 * Same category+keyword heuristic style as classifyItemEnergy — a
 * reservation with a known time is always event_fixed (its duration comes
 * from the reservation, not a generic estimate); otherwise category/keyword
 * signals pick a scale, and an AI-provided estimatedDurationMinutes (if any)
 * only clamps into that scale's range rather than being trusted blindly.
 */
export function classifyVisitScale(item: {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  reservationRequired?: boolean;
  estimatedDurationMinutes?: number | null;
}): VisitScale {
  if (item.reservationRequired) return "event_fixed";

  const text = `${item.name} ${item.shortDescription}`;
  if (includesAnyKeywordLocal(text, FULL_DAY_KEYWORDS) || item.category === "day_trip") return "full_day";
  if (includesAnyKeywordLocal(text, HALF_DAY_KEYWORDS)) return "half_day";
  if (includesAnyKeywordLocal(text, QUICK_STOP_KEYWORDS)) return "quick_stop";

  if (item.category === "museum" || item.category === "hidden_gem") return "medium";
  if (item.category === "nature" || item.category === "attraction") return "medium";
  if (item.category === "shopping" || item.category === "nightlife" || item.category === "cafe") return "short";

  const duration = item.estimatedDurationMinutes;
  if (duration != null) {
    if (duration >= VISIT_SCALE_DURATION_MINUTES.full_day.min) return "full_day";
    if (duration >= VISIT_SCALE_DURATION_MINUTES.half_day.min) return "half_day";
    if (duration >= VISIT_SCALE_DURATION_MINUTES.medium.min) return "medium";
    if (duration >= VISIT_SCALE_DURATION_MINUTES.short.min) return "short";
    return "quick_stop";
  }

  return "medium";
}

/**
 * Resolves the real minutes to schedule for an item: an AI-provided
 * estimate is clamped into its visit-scale's realistic range rather than
 * trusted as-is (spec item 11 — "do not estimate all attractions with one
 * generic duration"), and a missing estimate falls back to the scale's own
 * default instead of a flat 90-minute guess used everywhere today.
 */
export function resolveVisitDurationMinutes(
  item: {
    category: RecommendationCategory;
    name: string;
    shortDescription: string;
    reservationRequired?: boolean;
    estimatedDurationMinutes?: number | null;
  },
  scale: VisitScale = classifyVisitScale(item)
): number {
  const range = VISIT_SCALE_DURATION_MINUTES[scale];
  if (scale === "event_fixed" && item.estimatedDurationMinutes != null && item.estimatedDurationMinutes > 0) {
    return item.estimatedDurationMinutes;
  }
  if (item.estimatedDurationMinutes != null && item.estimatedDurationMinutes > 0) {
    return Math.min(Math.max(item.estimatedDurationMinutes, range.min), range.max);
  }
  return range.default;
}

function parseClockMinutesLocal(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function formatClockMinutesLocal(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * The item's real occupied-until clock time, same calendar day as its
 * start — arrival/departure feasibility must validate the item's whole
 * interval, not just when it starts (a real bug: an activity starting at
 * 10:18 but running to 15:18 against a 13:15 departure cutoff used to
 * silently pass because only the start was checked). Prefers the
 * scheduler's own assigned endTime; derives one from the exact same
 * canonical duration semantics used everywhere else
 * (resolveVisitDurationMinutes/classifyVisitScale, with the same
 * "practical" filler exclusion as calculateDayLoadMinutes/
 * countDayTimeOverlaps) when no real endTime exists yet — never a second,
 * different duration interpretation.
 */
export function resolveItemEffectiveEndTime(item: {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  reservationRequired?: boolean;
  estimatedDurationMinutes?: number | null;
  plannedStartTime: string;
  endTime?: string;
}): string | null {
  const startMinutes = parseClockMinutesLocal(item.plannedStartTime);
  if (startMinutes == null) return null;

  const scheduledEndMinutes = item.endTime ? parseClockMinutesLocal(item.endTime) : null;
  if (scheduledEndMinutes != null && scheduledEndMinutes > startMinutes) {
    return formatClockMinutesLocal(scheduledEndMinutes);
  }

  const duration =
    item.category === "practical"
      ? Math.max(item.estimatedDurationMinutes ?? 30, 5)
      : resolveVisitDurationMinutes(item);
  return formatClockMinutesLocal(startMinutes + Math.max(duration, 1));
}

/**
 * Indoor/outdoor/mixed tagging (spec items 64/65) — this app has no real
 * weather forecast anywhere, so this only ever supports Plan B (a backup
 * suggestion for an outdoor-heavy day), never a real "prioritize outdoor in
 * good weather" claim — no forecast is fabricated. Same category+keyword
 * heuristic style as classifyVisitScale/classifyItemEnergy.
 */
export type WeatherSensitivity = "indoor" | "outdoor" | "mixed";

const OUTDOOR_KEYWORDS = [
  "hike",
  "hiking",
  "trail",
  "beach",
  "viewpoint",
  "lookout",
  "park",
  "garden",
  "mountain",
  "lake",
  "waterfall",
  "desert",
  "safari",
  "טיול רגלי",
  "מסלול הליכה",
  "חוף",
  "תצפית",
  "פארק",
  "גן",
  "הר",
  "אגם",
  "מפל",
  "מדבר",
  "ספארי",
];

const INDOOR_KEYWORDS = [
  "museum",
  "gallery",
  "mall",
  "aquarium",
  "theater",
  "theatre",
  "cinema",
  "מוזיאון",
  "גלריה",
  "קניון",
  "אקווריום",
  "תיאטרון",
  "קולנוע",
];

export function classifyWeatherSensitivity(item: {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
}): WeatherSensitivity {
  const text = `${item.name} ${item.shortDescription}`;
  if (item.category === "nature" || includesAnyKeywordLocal(text, OUTDOOR_KEYWORDS)) return "outdoor";
  if (item.category === "museum" || item.category === "shopping" || includesAnyKeywordLocal(text, INDOOR_KEYWORDS)) {
    return "indoor";
  }
  return "mixed";
}
