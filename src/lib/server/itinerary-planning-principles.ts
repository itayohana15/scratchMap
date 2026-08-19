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
