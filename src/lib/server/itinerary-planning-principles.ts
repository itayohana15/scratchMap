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

export interface TripFrame {
  bucketId: TripLengthBucketId;
  phases: TripFramePhase[];
  source: "deterministic" | "ai";
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
 * Pure geography-first phase distribution: given ranked area weights (e.g.
 * how many real candidate places fall in each area) and a bucket's base
 * count range, picks base cities and distributes the trip's days across
 * them contiguously. No AI call, no I/O — safe to unit test directly and
 * safe as the guaranteed fallback when an AI refinement call is unavailable
 * or fails.
 */
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
    const totalWeightAll = orderedAreas.reduce((sum, area) => sum + Math.max(1, areaWeights.get(area) ?? 1), 0);
    const significantAreaCount = orderedAreas.filter((area) => {
      const weight = Math.max(1, areaWeights.get(area) ?? 1);
      return weight / totalWeightAll >= 0.12;
    }).length;
    baseCount = Math.min(Math.max(bucket.minBases, significantAreaCount), bucket.maxBases);
  }

  const maxBasesForData = Math.max(1, Math.min(baseCount, orderedAreas.length, safeDayCount));
  const selectedAreas = orderedAreas.slice(0, maxBasesForData);

  const weights = selectedAreas.map((area) => Math.max(1, areaWeights.get(area) ?? 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const dayShares = weights.map((weight) => Math.max(1, Math.floor((weight / totalWeight) * safeDayCount)));

  let remainder = safeDayCount - dayShares.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  while (remainder > 0) {
    dayShares[cursor % dayShares.length] += 1;
    remainder -= 1;
    cursor += 1;
  }
  while (remainder < 0) {
    const largestIndex = dayShares.indexOf(Math.max(...dayShares));
    if (dayShares[largestIndex] <= 1) break;
    dayShares[largestIndex] -= 1;
    remainder += 1;
  }

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
