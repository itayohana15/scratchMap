// Generation-time cluster evaluation + itinerary-wide travel/backtracking
// metrics (spec "FINAL PRODUCT COMPLETION PASS", Parts A-L, G-H, Z-AA).
// Pure, generic, coordinate-driven functions — no country/region names
// anywhere in this file. Two deliberately separate concerns:
//   1. Cluster evaluation (evaluateCluster/decideClusterRole/
//      allocateNightsForClusters/evaluateShortStayViability) — used as an
//      ADVISORY layer feeding the generation prompt and the existing
//      post-generation TripFrame repair, not a hard replacement of the
//      whole generation pipeline (see country-itinerary-generation.ts's
//      own comments at its call sites for the honest scope of that wiring).
//   2. Itinerary-wide metrics (computeItineraryTravelMetrics/
//      detectBacktracking) — computed AFTER a plan exists, for QA
//      reporting and as an input the repair loop can react to.
import { haversineKm, type TripRecommendation } from "../trip-workspace";
import { estimateMinutesForMode, selectTransportMode } from "../transport-mode";
import type { TripPreferenceProfile } from "./itinerary-generation-constraints";
import {
  allocateNightsForClusters,
  detectBacktracking,
  evaluateShortStayViability,
  OVERNIGHT_WORTHY_MINUTES,
} from "./itinerary-planning-principles";

// Re-exported so every existing caller/test of THIS module is unaffected
// by the move described at each definition's own original location below.
export { allocateNightsForClusters, detectBacktracking, evaluateShortStayViability };

export interface ActivityCluster {
  id: string;
  center: { lat: number; lon: number };
  members: TripRecommendation[];
}

/**
 * Greedy geographic clustering of real candidates (spec Part A step 2) —
 * simple and deterministic rather than a full k-means/DBSCAN: repeatedly
 * takes an unclustered point, gathers every other unclustered point within
 * `radiusKm` of ITS running centroid, and closes the cluster once nothing
 * new joins. `radiusKm` should be the destination's own
 * DestinationMobilityProfile.localityRadiusKm — never a fixed constant.
 */
export function clusterActivityCandidates(
  candidates: TripRecommendation[],
  radiusKm: number
): ActivityCluster[] {
  const points = candidates.filter((candidate) => candidate.lat != null && candidate.lon != null);
  const remaining = new Set(points);
  let clusters: Array<Pick<ActivityCluster, "center" | "members">> = [];

  for (const seed of points) {
    if (!remaining.has(seed)) continue;
    const members: TripRecommendation[] = [seed];
    remaining.delete(seed);
    let centroid = { lat: seed.lat!, lon: seed.lon! };

    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of remaining) {
        if (haversineKm(centroid.lat, centroid.lon, candidate.lat!, candidate.lon!) <= radiusKm) {
          members.push(candidate);
          remaining.delete(candidate);
          centroid = {
            lat: members.reduce((sum, m) => sum + m.lat!, 0) / members.length,
            lon: members.reduce((sum, m) => sum + m.lon!, 0) / members.length,
          };
          grew = true;
        }
      }
    }

    clusters.push({ center: centroid, members });
  }

  // Cluster IDENTITY is coordinates only (spec "זהות אשכול נקבעת
  // מקואורדינטות בלבד") — a real 46-day US trip trace showed the same
  // real city split across two "areas" purely because its own
  // candidates' coordinates spread wider than a single radiusKm pass
  // from whichever point happened to seed first (a known limitation of
  // single-linkage greedy clustering — nothing here ever reads a
  // name/location string; this function never has one to read). A real
  // agglomerative merge closes that gap: repeatedly combine whichever TWO
  // clusters are geographically closest, as long as that distance is
  // still within radiusKm, recomputing the merged centroid from every
  // member each time, until no remaining pair qualifies. The textual
  // label a cluster ends up displayed under (pickClusterAreaLabel,
  // elsewhere) is picked from its now-merged member list afterward —
  // display only, never fed back into this identity decision.
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    let bestPairIndex: [number, number] | null = null;
    let bestDistanceKm = Infinity;

    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const distanceKm = haversineKm(
          clusters[i].center.lat,
          clusters[i].center.lon,
          clusters[j].center.lat,
          clusters[j].center.lon
        );
        if (distanceKm < bestDistanceKm) {
          bestDistanceKm = distanceKm;
          bestPairIndex = [i, j];
        }
      }
    }

    if (bestPairIndex && bestDistanceKm <= radiusKm) {
      const [i, j] = bestPairIndex;
      const combinedMembers = [...clusters[i].members, ...clusters[j].members];
      const combinedCentroid = {
        lat: combinedMembers.reduce((sum, member) => sum + member.lat!, 0) / combinedMembers.length,
        lon: combinedMembers.reduce((sum, member) => sum + member.lon!, 0) / combinedMembers.length,
      };
      clusters = [
        ...clusters.filter((_, index) => index !== i && index !== j),
        { center: combinedCentroid, members: combinedMembers },
      ];
      merged = true;
    }
  }

  return clusters.map((cluster, index) => ({ id: `cluster-${index + 1}`, ...cluster }));
}

export interface ClusterEvaluation {
  clusterActivityCount: number;
  /** 0-100 — derived from real signals only (count + category diversity), never a fabricated rating (no generic quality-score data source exists). */
  clusterQualityScore: number;
  /** 0-100 — share of members matching the trip's own strong/soft preference keywords. */
  clusterInterestMatch: number;
  /** Sum of real/estimated visit durations across the cluster's members. */
  clusterRequiredTimeMinutes: number;
  /** Count of distinct real categories present in the cluster. */
  clusterDistinctiveness: number;
  /** Real distance to the nearest OTHER cluster's center; Infinity when this is the only cluster. */
  clusterDistanceFromOtherClustersKm: number;
  /** Conservative — "likely" only when a real hotel-category candidate exists within the cluster's own radius; otherwise "unknown", never "poor" (spec Part C: "do not fabricate hotels"). */
  clusterAccommodationFeasibility: "likely" | "unknown";
}

const DEFAULT_VISIT_MINUTES = 90;

function keywordMatchesText(keyword: string, text: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  return normalized.length > 0 && text.toLowerCase().includes(normalized);
}

/**
 * Real signals only (spec Part B) — no invented "cluster quality" number.
 * `allClusters`/`radiusKm` are used solely for the real distance-to-nearest-
 * other-cluster and hotel-candidate-in-radius checks.
 */
export function evaluateCluster(
  cluster: ActivityCluster,
  allClusters: ActivityCluster[],
  profile: Pick<TripPreferenceProfile, "strongPreferences" | "softPreferences">
): ClusterEvaluation {
  const clusterActivityCount = cluster.members.length;
  const categories = new Set(cluster.members.map((member) => member.category));
  const clusterDistinctiveness = categories.size;
  const clusterQualityScore = Math.round(
    Math.min(100, clusterActivityCount * 8 + clusterDistinctiveness * 10)
  );

  const interestKeywords = [...profile.strongPreferences, ...profile.softPreferences];
  const matchingMembers = interestKeywords.length
    ? cluster.members.filter((member) =>
        interestKeywords.some((keyword) => keywordMatchesText(keyword, `${member.name} ${member.category} ${member.shortDescription}`))
      ).length
    : 0;
  const clusterInterestMatch =
    interestKeywords.length > 0 && clusterActivityCount > 0
      ? Math.round((matchingMembers / clusterActivityCount) * 100)
      : 50; // neutral when the trip has no strong/soft preferences to match against

  const clusterRequiredTimeMinutes = cluster.members.reduce(
    (sum, member) => sum + (member.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES),
    0
  );

  const otherClusters = allClusters.filter((other) => other !== cluster);
  const clusterDistanceFromOtherClustersKm =
    otherClusters.length > 0
      ? Math.min(...otherClusters.map((other) => haversineKm(cluster.center.lat, cluster.center.lon, other.center.lat, other.center.lon)))
      : Infinity;

  const hasNearbyHotelCandidate = cluster.members.some((member) => member.category === "hotel");
  const clusterAccommodationFeasibility: "likely" | "unknown" = hasNearbyHotelCandidate ? "likely" : "unknown";

  return {
    clusterActivityCount,
    clusterQualityScore,
    clusterInterestMatch,
    clusterRequiredTimeMinutes,
    clusterDistinctiveness,
    clusterDistanceFromOtherClustersKm,
    clusterAccommodationFeasibility,
  };
}

export type ClusterRole = "overnight" | "day_trip" | "merge" | "skip";

// OVERNIGHT_WORTHY_MINUTES now lives in itinerary-planning-principles.ts
// (imported above) — buildTripFramePhases' own area-significance test
// needs the exact same "worth a dedicated day" bar, so it's a single
// shared constant rather than two independently-tuned numbers.
const SKIP_THRESHOLD_ACTIVITY_COUNT = 1;

/**
 * Spec Part B/C — decides a cluster's structural role from its OWN real
 * content and geography, never from "5 regions exist so 5 stays." A
 * cluster close to a bigger neighbor merges into it rather than becoming
 * its own base; a small-but-real cluster far from everything else becomes
 * a day trip (from whichever neighboring stay is nearest) rather than a
 * weak overnight stay; a cluster with almost nothing real gets skipped.
 */
export function decideClusterRole(
  evaluation: ClusterEvaluation,
  localityRadiusKm: number,
  options: {
    /** Set ONLY from a real, verified check (e.g. an actual hotel search near the cluster returning zero results) — never inferred from clusterAccommodationFeasibility being merely "unknown" (spec Part C: "do not fabricate hotels"). */
    accommodationVerifiedUnavailable?: boolean;
  } = {}
): ClusterRole {
  if (evaluation.clusterActivityCount <= SKIP_THRESHOLD_ACTIVITY_COUNT && evaluation.clusterRequiredTimeMinutes < DEFAULT_VISIT_MINUTES) {
    return "skip";
  }
  const isFarFromEverythingElse = evaluation.clusterDistanceFromOtherClustersKm > localityRadiusKm;
  const hasEnoughContentForADay = evaluation.clusterRequiredTimeMinutes >= OVERNIGHT_WORTHY_MINUTES;

  if (!isFarFromEverythingElse && !hasEnoughContentForADay) {
    // Close to another cluster and not substantial enough to justify its
    // own base — the neighboring stay absorbs it instead.
    return "merge";
  }
  if (hasEnoughContentForADay) {
    // Good activities, but a REAL, verified check found nowhere practical
    // to stay — a day trip from a nearby base, never a forced bad
    // overnight (spec Part C).
    return options.accommodationVerifiedUnavailable ? "day_trip" : "overnight";
  }
  // Real content, but not enough for a dedicated overnight and not close
  // enough to simply merge — a day trip from a nearby base is the
  // structurally honest answer (spec Part C: never force a bad overnight).
  return "day_trip";
}

// Day-trip round-trip feasibility (base -> excursion cluster -> base) —
// previously missing entirely: a cluster earning "day_trip" role
// (decideClusterRole above) never had its actual round-trip travel cost
// checked against the day's real usable time, so a genuinely too-far or
// too-thin cluster could still surface as a "day trip" hint with nothing to
// say whether a traveler could plausibly do it and enjoy it. Two
// deliberately separate functions: evaluateDayTripFeasibility is the pure
// arithmetic/decision (fully unit-testable with plain numbers, including
// deliberately asymmetric legs), computeDayTripClusterFeasibility is the one
// real caller that derives those numbers from an actual cluster + base
// anchor using the same haversineKm/selectTransportMode/estimateMinutesForMode
// primitives already used for intercity feasibility elsewhere (see
// attemptStayStructureRepair's isTransitionFeasible in
// country-itinerary-generation.ts) — no new travel-time estimator invented.
export interface DayTripFeasibilityInput {
  outboundTravelMinutes: number;
  returnTravelMinutes: number;
  internalTravelMinutes: number;
  visitMinutes: number;
  usableMinutes: number;
}

export interface DayTripFeasibility extends DayTripFeasibilityInput {
  totalMinutes: number;
  valueRatio: number;
  feasible: boolean;
  reason: "ok" | "exceeds_time_budget" | "low_value_ratio";
}

// No comparable ratio/threshold concept exists elsewhere in this codebase
// (decideClusterRole's own thresholds are duration- and distance-based, not
// a travel-share ratio) — a genuinely NEW tunable, not a magic number buried
// in logic: at least 40% of the day trip's total time budget must be real
// visit time, not travel, or the excursion isn't worth the trip.
export const DAY_TRIP_MIN_VALUE_RATIO = 0.4;

/**
 * Pure feasibility decision from already-known quantities — never computes
 * travel time itself, so outbound/return are always independently supplied
 * and never assumed equal (a real route can be asymmetric: a loop road, a
 * different return mode). Callers with only straight-line coordinates
 * (computeDayTripClusterFeasibility below) currently derive both the same
 * way, but this function's contract doesn't require that, so a future real
 * routing source can supply genuinely different legs without any change
 * here.
 */
export function evaluateDayTripFeasibility(input: DayTripFeasibilityInput): DayTripFeasibility {
  const totalMinutes =
    input.outboundTravelMinutes + input.returnTravelMinutes + input.internalTravelMinutes + input.visitMinutes;
  const valueRatio = totalMinutes > 0 ? input.visitMinutes / totalMinutes : 0;
  const withinBudget = totalMinutes <= input.usableMinutes;
  const meetsValueRatio = valueRatio >= DAY_TRIP_MIN_VALUE_RATIO;

  return {
    ...input,
    totalMinutes,
    valueRatio,
    feasible: withinBudget && meetsValueRatio,
    reason: !withinBudget ? "exceeds_time_budget" : !meetsValueRatio ? "low_value_ratio" : "ok",
  };
}

/**
 * Nearest-neighbor chain through the cluster's own members — the one
 * genuinely new estimator here (nothing existing computes intra-cluster
 * route time). Local travel (isIntercity: false), not the intercity mode
 * used for the outbound/return legs. Members without coordinates are
 * skipped as hop targets (never fabricate a distance) but still counted via
 * the chain once reached from a real-coordinate neighbor.
 */
function estimateClusterInternalTravelMinutes(cluster: ActivityCluster): number {
  const withCoordinates = cluster.members.filter((member) => member.lat != null && member.lon != null);
  if (withCoordinates.length <= 1) return 0;

  const remaining = withCoordinates.slice(1);
  let current = withCoordinates[0];
  let totalMinutes = 0;

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestKm = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const distanceKm = haversineKm(current.lat!, current.lon!, remaining[index].lat!, remaining[index].lon!);
      if (distanceKm < nearestKm) {
        nearestKm = distanceKm;
        nearestIndex = index;
      }
    }
    const mode = selectTransportMode(nearestKm, { isIntercity: false });
    totalMinutes += estimateMinutesForMode(nearestKm, mode);
    current = remaining[nearestIndex];
    remaining.splice(nearestIndex, 1);
  }

  return totalMinutes;
}

/**
 * The one real production caller — derives every DayTripFeasibilityInput
 * field from a real cluster and its base anchor, then defers the actual
 * decision to evaluateDayTripFeasibility above.
 */
export function computeDayTripClusterFeasibility(
  cluster: ActivityCluster,
  baseAnchor: { lat: number; lon: number },
  usableMinutes: number
): DayTripFeasibility {
  const outboundKm = haversineKm(baseAnchor.lat, baseAnchor.lon, cluster.center.lat, cluster.center.lon);
  const outboundMode = selectTransportMode(outboundKm, { isIntercity: true });
  const outboundTravelMinutes = estimateMinutesForMode(outboundKm, outboundMode);

  // Independently computed (not copied from outbound) per
  // evaluateDayTripFeasibility's own contract — with only straight-line
  // coordinates available at this planning stage the two currently land on
  // the same number (haversine is symmetric), but a future real-routing
  // source (a loop road, a different return mode) can supply a genuinely
  // different value here without touching this function's shape.
  const returnKm = haversineKm(cluster.center.lat, cluster.center.lon, baseAnchor.lat, baseAnchor.lon);
  const returnMode = selectTransportMode(returnKm, { isIntercity: true });
  const returnTravelMinutes = estimateMinutesForMode(returnKm, returnMode);

  const internalTravelMinutes = estimateClusterInternalTravelMinutes(cluster);
  const visitMinutes = cluster.members.reduce(
    (sum, member) => sum + (member.estimatedDurationMinutes ?? DEFAULT_VISIT_MINUTES),
    0
  );

  return evaluateDayTripFeasibility({
    outboundTravelMinutes,
    returnTravelMinutes,
    internalTravelMinutes,
    visitMinutes,
    usableMinutes,
  });
}

// Transfer-day detour/corridor feasibility (origin stay -> destination
// stay) — the existing transfer-day check (enforceNormalDayLocality,
// country-itinerary-generation.ts) only ever rejected an item that
// POSITIVELY matched some OTHER modeled stay's area; an item that was
// simply far from everything (not near origin, not near destination, not a
// real match to any known stay, and not actually on the way) sailed
// through with zero validation — the exact gap this closes. Same
// deliberately separate two-function shape as the day-trip feasibility
// work just above: evaluateTransferDetourFeasibility is pure arithmetic
// (fully unit-testable with plain numbers, including the combined-slack
// case for multiple detour activities on the same day), the real caller
// derives its inputs from the trip's own already-computed StayTransition
// (buildStayTransitions, itinerary-planning-principles.ts) — the same
// origin/destination anchors and t(origin,destination) already used for
// intercity feasibility elsewhere, not a second source of truth.
export interface TransferDetourInput {
  /** t(origin, candidate) */
  outboundToCandidateMinutes: number;
  /** t(candidate, destination) */
  candidateToDestinationMinutes: number;
  /** t(origin, destination) — the direct transfer leg itself */
  directTransferMinutes: number;
  visitMinutes: number;
  /** The transfer day's total leftover time budget for detour activities (dailyCapacityMinutes - directTransferMinutes), before this candidate. */
  availableSlackMinutes: number;
  /** Detour+visit minutes already committed to earlier detour activities the same day — a second, individually-fine detour can still be correctly rejected once combined with the first. */
  usedSlackMinutes: number;
}

export interface TransferDetourFeasibility {
  detourMinutes: number;
  totalMinutes: number;
  remainingSlackMinutes: number;
  feasible: boolean;
  reason: "ok" | "exceeds_available_slack";
}

/**
 * detour(P) = t(origin,P) + t(P,destination) - t(origin,destination) —
 * implemented exactly. Clamped at 0: real-world mode-selection quirks
 * (different transport modes chosen for legs of different lengths) can
 * technically violate strict triangle-inequality symmetry in edge cases;
 * a "negative detour" has no physical meaning, it just means genuinely on
 * the way.
 */
export function evaluateTransferDetourFeasibility(input: TransferDetourInput): TransferDetourFeasibility {
  const detourMinutes = Math.max(
    0,
    input.outboundToCandidateMinutes + input.candidateToDestinationMinutes - input.directTransferMinutes
  );
  const totalMinutes = detourMinutes + input.visitMinutes;
  const remainingSlackBefore = input.availableSlackMinutes - input.usedSlackMinutes;
  const feasible = totalMinutes <= remainingSlackBefore;

  return {
    detourMinutes,
    totalMinutes,
    remainingSlackMinutes: remainingSlackBefore - totalMinutes,
    feasible,
    reason: feasible ? "ok" : "exceeds_available_slack",
  };
}

// allocateNightsForClusters now lives in itinerary-planning-principles.ts
// (imported/re-exported at the top of this file) so it can be the ONE
// production night-allocation algorithm shared with buildTripFramePhases.

// evaluateShortStayViability now lives in itinerary-planning-principles.ts
// (imported/re-exported at the top of this file) so the real production
// short-stay repair pass there can share this exact same function.
export type { ShortStayViabilityResult } from "./itinerary-planning-principles";

export interface ItineraryTravelReport {
  totalGroundTravelMinutes: number;
  averageGroundTravelMinutesPerDay: number;
  maxNormalDayTravelSegment: number;
  maxDayTripTravelSegment: number;
  hotelChangeCount: number;
  backtrackingScore: number;
}

interface TravelMetricsDay {
  dayNumber: number;
  items: Array<{ travelMinutes: number | null }>;
}

/**
 * Spec Part G — real itinerary-wide travel numbers from the plan's own
 * already-computed travelMinutes fields (never re-estimated), for both
 * planning-time repair decisions and QA reporting (spec Parts Z/AA).
 */
export function computeItineraryTravelMetrics(
  days: TravelMetricsDay[],
  classifyDay: (day: TravelMetricsDay) => "normal" | "day_trip" | "transfer",
  stayAnchorsInVisitOrder: Array<{ lat: number; lon: number }>
): ItineraryTravelReport {
  let totalGroundTravelMinutes = 0;
  let maxNormalDayTravelSegment = 0;
  let maxDayTripTravelSegment = 0;

  for (const day of days) {
    const dayType = classifyDay(day);
    for (const item of day.items) {
      if (item.travelMinutes == null) continue;
      totalGroundTravelMinutes += item.travelMinutes;
      if (dayType === "normal") maxNormalDayTravelSegment = Math.max(maxNormalDayTravelSegment, item.travelMinutes);
      if (dayType === "day_trip") maxDayTripTravelSegment = Math.max(maxDayTripTravelSegment, item.travelMinutes);
    }
  }

  const averageGroundTravelMinutesPerDay = days.length > 0 ? Math.round(totalGroundTravelMinutes / days.length) : 0;
  const hotelChangeCount = Math.max(0, stayAnchorsInVisitOrder.length - 1);
  const backtrackingScore = detectBacktracking(stayAnchorsInVisitOrder);

  return {
    totalGroundTravelMinutes: Math.round(totalGroundTravelMinutes),
    averageGroundTravelMinutesPerDay,
    maxNormalDayTravelSegment: Math.round(maxNormalDayTravelSegment),
    maxDayTripTravelSegment: Math.round(maxDayTripTravelSegment),
    hotelChangeCount,
    backtrackingScore,
  };
}

// detectBacktracking now lives in itinerary-planning-principles.ts
// (imported/re-exported at the top of this file) so
// reorderAreasToMinimizeBacktracking (used directly by generation) can
// share this exact same function, not a re-implementation.
