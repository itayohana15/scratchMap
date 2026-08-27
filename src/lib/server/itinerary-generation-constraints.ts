import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryResponse,
  DayPart,
  RecommendationCategory,
  TripPreferences,
  TripRecommendation,
} from "../trip-workspace";
import { estimateTravelMinutes, haversineKm } from "../trip-workspace";
import { violatesArrivalDepartureWindow, type ArrivalDepartureWindow } from "../flight-planning";
import {
  ACTIVITY_MIX_TARGETS,
  classifyActivityTier,
  classifyItemEnergy,
  classifyVisitScale,
  findFramePhaseForDay,
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
  resolveVisitDurationMinutes,
  type ActivityTier,
  type EnergyLevel,
  type TripFrame,
} from "./itinerary-planning-principles";

export type { TripFrame, TripFramePhase } from "./itinerary-planning-principles";
export { findFramePhaseForDay } from "./itinerary-planning-principles";

export interface ExchangeRateContext {
  sourceCurrency: string;
  targetCurrency: "ILS";
  rateToTarget: number;
  updatedAt: string;
  source: "provider" | "fallback" | "identity";
}

export interface BudgetAllocation {
  accommodation: number;
  food: number;
  transportation: number;
  attractions: number;
  buffer: number;
}

export interface TripPreferenceProfile {
  dayCount: number;
  budgetTarget: number | null;
  budgetSoftCeiling: number | null;
  budgetHardCeiling: number | null;
  dailyCapacityMinutes: number;
  perDayBudget: number | null;
  mealBudgetLunch: number | null;
  mealBudgetDinner: number | null;
  activityBudgetPerStop: number | null;
  transportBudgetPerDay: number | null;
  accommodationBudgetPerDay: number | null;
  budgetAllocation: BudgetAllocation;
  hardConstraints: string[];
  strongPreferences: string[];
  softPreferences: string[];
  mustVisitKeywords: string[];
  avoidKeywords: string[];
  dietaryKeywords: string[];
  preferredAreaKeywords: string[];
  luxuryEnabled: boolean;
  summary: string;
}

export interface PlanDiagnostics {
  totalEstimatedCost: number | null;
  missingMeals: number;
  duplicatePlaces: number;
  duplicateWarnings: number;
  overloadedDays: number;
  overSoftBudget: boolean;
  outOfBudget: boolean;
  missingAccommodation: number;
  missingTransport: number;
  avoidConflicts: number;
  missingMustVisitKeywords: string[];
  diversityRisk: boolean;
  dominantCategory: RecommendationCategory | null;
  dominantCategoryShare: number;
  invalidCoordinates: number;
  crossCityDays: number;
  longTravelDays: number;
  foodDominantDays: number;
  missingAnchorDays: number;
  longMealDetours: number;
  maxConsecutiveHighEnergyDays: number;
  highEnergyRhythmViolation: boolean;
  baseMismatchDays: number;
  /**
   * Guidance-only signal (not a `passesValidation` gate — the target
   * percentages are explicitly "guidelines, not rigid percentages"): tiers
   * whose actual share of the trip's stops falls outside
   * `ACTIVITY_MIX_TARGETS`. Empty when the mix is reasonably balanced.
   */
  activityMixSkew: Array<{ tier: ActivityTier; share: number; target: { min: number; max: number } }>;
  /**
   * Real activities scheduled before the traveler could realistically have
   * arrived, or after they'd need to already be heading to the airport —
   * spec §D16/E.1/E.2. A hard gate, not advisory, unlike activityMixSkew.
   */
  arrivalDepartureWindowViolations: number;
  /**
   * Two items on the same day whose visit-scale-derived windows overlap in
   * wall-clock time (spec item 58's "three activities at 12:30" symptom) —
   * a hard gate. Computed from plannedStartTime + a resolved duration, so it
   * catches raw AI output even before any scheduler pass has assigned a
   * real endTime.
   */
  timeOverlaps: number;
}

export interface RouteProximityScore {
  score: number;
  anchorTravelMinutes: number | null;
  routeDetourMinutes: number | null;
  exceedsLimit: boolean;
  withinPreferredWindow: boolean;
}

export interface GeographicSegmentDiagnostic {
  fromName: string;
  toName: string;
  minutes: number;
  distanceKm: number;
}

export interface DayGeographyDiagnostics {
  invalidCoordinateItems: string[];
  correctedCoordinateItems: string[];
  crossCityItems: string[];
  longTravelSegments: GeographicSegmentDiagnostic[];
  longMealDetours: GeographicSegmentDiagnostic[];
  foodStopCount: number;
  anchorStopCount: number;
  supportingStopCount: number;
  foodDominant: boolean;
  totalTravelMinutes: number;
  clusterLabel: string;
  orderedStopNames: string[];
  isTransferDay: boolean;
  energyLevel: EnergyLevel;
}

const ENERGY_SEVERITY: Record<EnergyLevel, number> = { low: 0, medium: 1, high: 2 };

function computeDayEnergyLevel(anchorItems: Pick<AiGeneratedItem, "category" | "name" | "shortDescription" | "estimatedDurationMinutes">[]): EnergyLevel {
  if (anchorItems.length === 0) return "low";

  let worst: EnergyLevel = "low";
  for (const item of anchorItems) {
    const level = classifyItemEnergy(item);
    if (ENERGY_SEVERITY[level] > ENERGY_SEVERITY[worst]) {
      worst = level;
    }
  }
  return worst;
}

export type DayIntensityLevel = "קל" | "בינוני" | "עמוס";

export interface DayIntensitySummary {
  level: DayIntensityLevel;
  activityCount: number;
  walkingKm: number;
  travelMinutes: number;
  activeMinutes: number;
}

interface DayIntensityItemInput {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  estimatedDurationMinutes: number | null;
  plannedStartTime: string;
  travelMinutes: number | null;
  lat: number | null;
  lon: number | null;
}

function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Deterministic (not AI-guessed) day intensity, per the spec: combines
 * active-hours span, walking distance, activity count, travel time, and the
 * existing per-item energy classification into one of three UI tiers. Client
 * usable — this file has no server-only dependency, and it's already
 * imported client-side (via itineraries.ts's cost-summary computation).
 */
export function computeDayIntensity(items: DayIntensityItemInput[]): DayIntensitySummary {
  if (items.length === 0) {
    return { level: "קל", activityCount: 0, walkingKm: 0, travelMinutes: 0, activeMinutes: 0 };
  }

  const activityCount = items.filter(
    (item) => item.category !== "transportation" && item.category !== "practical"
  ).length;
  const travelMinutes = items.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);

  let walkingKm = 0;
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    const distance = haversineKm(previous.lat, previous.lon, current.lat, current.lon);
    if (distance > 0 && distance <= 2) walkingKm += distance;
  }

  const times = items
    .map((item) => parseTimeToMinutes(item.plannedStartTime))
    .filter((value): value is number => value != null);
  const lastItem = items[items.length - 1];
  const activeMinutes =
    times.length >= 2
      ? Math.max(...times) - Math.min(...times) + (lastItem.estimatedDurationMinutes ?? 60)
      : items.reduce((sum, item) => sum + (item.estimatedDurationMinutes ?? 60) + (item.travelMinutes ?? 0), 0);

  const energyLevel = computeDayEnergyLevel(items);
  let score = ENERGY_SEVERITY[energyLevel];
  if (activeMinutes > 600) score += 1;
  else if (activeMinutes > 0 && activeMinutes < 360) score -= 1;
  if (travelMinutes > 150) score += 1;
  if (walkingKm > 8) score += 1;
  if (activityCount >= 6) score += 1;
  else if (activityCount > 0 && activityCount <= 3) score -= 1;
  score = Math.max(0, Math.min(4, score));

  const level: DayIntensityLevel = score <= 1 ? "קל" : score <= 2 ? "בינוני" : "עמוס";

  return {
    level,
    activityCount,
    walkingKm: Math.round(walkingKm * 10) / 10,
    travelMinutes,
    activeMinutes,
  };
}

const GENERIC_WARNING_PATTERNS = [
  /היום צפוף/,
  /להזיז פעילות/,
  /להוסיף אוכל/,
  /food stop/i,
  /nearby food/i,
  /may be busy/i,
];

const LUXURY_KEYWORDS = [
  "luxury",
  "high-end",
  "fine dining",
  "michelin",
  "יוקרה",
  "יוקרתי",
  "פיין דיינינג",
  "מסעדת שף",
];

const PREMIUM_VENUE_KEYWORDS = [
  "narisawa",
  "den",
  "sukiyabashi",
  "kaiseki",
  "omakase",
  "michelin",
];

const SLOT_ORDER: DayPart[] = ["morning", "lunch", "afternoon", "dinner", "evening", "night"];

const LOCATION_STOP_WORDS = new Set([
  "city",
  "district",
  "region",
  "area",
  "prefecture",
  "province",
  "state",
  "ward",
  "downtown",
  "center",
  "centre",
  "old town",
  "town",
  "עיר",
  "אזור",
  "מחוז",
  "רובע",
  "מרכז",
]);

const TRANSFER_DAY_PATTERN =
  /intercity|transfer|relocation|checkout|check-out|check in|check-in|airport|flight|bullet train|shinkansen|long-distance|ferry crossing|move to next city|מעבר|רכבת מהירה|רכבת בין-עירונית|שינקנסן|טיסה|צ'ק-אאוט|צ'ק אאוט|צ'ק-אין|צ'ק אין|שדה תעופה|מעבורת בין-עירונית|עוברים ליעד הבא|לינה חדשה/i;

// A day trip keeps the traveler's overnight base unchanged but visits a
// genuinely different area for the day (spec item 13) — e.g. a Tbilisi-based
// day trip to Borjomi/Kazbegi. Without recognizing this, analyzeDayGeography
// would (wrongly) flag it as "cross-city mixing," which is exactly the
// "Borjomi and Tbilisi mixed in one day" false-positive/mis-structure
// reported against the current generator. Same self-contained,
// text-pattern-on-a-single-day style as TRANSFER_DAY_PATTERN — no neighbor-day
// lookup needed, so every existing analyzeDayGeography call site benefits
// with zero signature changes.
const DAY_TRIP_PATTERN =
  /day trip|day-trip|excursion|half-day trip|round trip to|round-trip to|טיול יום|יום טיול|נסיעת יום|יציאה ליום|סיור יום/i;

export function isDayTripDay(day: Pick<AiGeneratedDay, "title" | "notes" | "transportation" | "transportSegments">) {
  if (isIntercityTransferDay(day)) return false;
  return DAY_TRIP_PATTERN.test(`${day.title} ${day.notes} ${day.transportation}`);
}

/**
 * Counts real wall-clock overlaps between a day's items — the structural
 * check behind spec item 58's "three activities at 12:30" symptom.
 * Transportation legs are excluded (they're connective, not competing for
 * the same slot). Duration comes from resolveVisitDurationMinutes so this
 * works even on raw AI output that hasn't been through the scheduler yet.
 */
export function countDayTimeOverlaps(day: Pick<AiGeneratedDay, "items">): number {
  const timedItems = day.items
    .filter((item) => item.category !== "transportation")
    .map((item) => {
      const start = parseTimeToMinutes(item.plannedStartTime);
      if (start == null) return null;
      const duration = resolveVisitDurationMinutes(item, classifyVisitScale(item));
      return { start, end: start + Math.max(duration, 1) };
    })
    .filter((entry): entry is { start: number; end: number } => entry != null)
    .sort((a, b) => a.start - b.start);

  let overlaps = 0;
  for (let index = 1; index < timedItems.length; index += 1) {
    if (timedItems[index].start < timedItems[index - 1].end) overlaps += 1;
  }
  return overlaps;
}

export const IDEAL_LOCAL_TRAVEL_MINUTES = 15;
export const MAX_LOCAL_TRAVEL_MINUTES = 25;
export const TARGET_NORMAL_DAY_TRAVEL_MINUTES = 90;
export const MAX_NORMAL_DAY_TRAVEL_MINUTES = 120;
export const DISTANT_CITY_DISTANCE_KM = 80;

function parseKeywords(value: string) {
  return value
    .toLowerCase()
    .split(/[,;\n/|]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function roundPrice(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function includesAnyKeyword(value: string, keywords: string[]) {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function normalizeSearchableText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isFoodCategory(category: RecommendationCategory) {
  return category === "restaurant" || category === "cafe";
}

function isAnchorCategory(category: RecommendationCategory) {
  return !isFoodCategory(category) && category !== "transportation" && category !== "hotel";
}

function inferPaceFromProfile(profile: TripPreferenceProfile): TripPreferences["tripPace"] {
  if (profile.dailyCapacityMinutes <= 480) return "relaxed";
  if (profile.dailyCapacityMinutes >= 720) return "fast";
  return "balanced";
}

function slotOrder(slot: DayPart) {
  return SLOT_ORDER.indexOf(slot);
}

function sortItemsBySchedule<T extends Pick<AiGeneratedItem, "plannedStartTime" | "slot">>(items: T[]) {
  return [...items].sort((left, right) => {
    if (
      left.plannedStartTime &&
      right.plannedStartTime &&
      left.plannedStartTime !== right.plannedStartTime
    ) {
      return left.plannedStartTime.localeCompare(right.plannedStartTime);
    }
    return slotOrder(left.slot) - slotOrder(right.slot);
  });
}

function normalizeClusterLabel(value: string) {
  return value
    .split(/[,|·/()-]+/)
    .map((part) => part.trim())
    .find(Boolean) ?? value.trim();
}

function buildLocationTokens(value: string) {
  return normalizeSearchableText(value)
    .split(/[,|·/()-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !LOCATION_STOP_WORDS.has(token));
}

function sharesLocationContext(...values: string[]) {
  if (values.length < 2) return false;
  const tokenSets = values.map((value) => new Set(buildLocationTokens(value)));
  const [first, ...rest] = tokenSets;

  for (const token of first) {
    if (rest.every((tokenSet) => tokenSet.has(token))) {
      return true;
    }
  }

  return false;
}

function hasCoordinates(value: Pick<AiGeneratedItem, "lat" | "lon"> | Pick<TripRecommendation, "lat" | "lon">) {
  return value.lat != null && value.lon != null;
}

export function normalizeCoordinatePair(lat: number | null | undefined, lon: number | null | undefined) {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      lat: null,
      lon: null,
      isValid: false,
      wasSwapped: false,
    };
  }

  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return {
      lat,
      lon,
      isValid: true,
      wasSwapped: false,
    };
  }

  if (Math.abs(lat) <= 180 && Math.abs(lon) <= 90) {
    return {
      lat: lon,
      lon: lat,
      isValid: true,
      wasSwapped: true,
    };
  }

  return {
    lat: null,
    lon: null,
    isValid: false,
    wasSwapped: false,
  };
}

export function isIntercityTransferDay(
  day: Pick<AiGeneratedDay, "title" | "notes" | "transportation" | "transportSegments">
) {
  return TRANSFER_DAY_PATTERN.test(
    `${day.title} ${day.notes} ${day.transportation} ${(day.transportSegments ?? []).join(" ")}`
  );
}

export function scoreRouteProximity(
  candidate: Pick<TripRecommendation | AiGeneratedItem, "name" | "location" | "lat" | "lon">,
  args: {
    anchor: Pick<AiGeneratedItem | TripRecommendation, "name" | "location" | "lat" | "lon"> | null;
    nextStop?: Pick<AiGeneratedItem | TripRecommendation, "name" | "location" | "lat" | "lon"> | null;
    pace: TripPreferences["tripPace"];
    transportation: string;
    hardLimitMinutes?: number;
    idealLimitMinutes?: number;
    explicitRequest?: boolean;
  }
): RouteProximityScore {
  const hardLimit = args.hardLimitMinutes ?? MAX_LOCAL_TRAVEL_MINUTES;
  const idealLimit = args.idealLimitMinutes ?? IDEAL_LOCAL_TRAVEL_MINUTES;
  const normalizedCandidate = normalizeCoordinatePair(candidate.lat, candidate.lon);
  const normalizedAnchor = args.anchor
    ? normalizeCoordinatePair(args.anchor.lat, args.anchor.lon)
    : { lat: null, lon: null, isValid: false, wasSwapped: false };
  const normalizedNext = args.nextStop
    ? normalizeCoordinatePair(args.nextStop.lat, args.nextStop.lon)
    : { lat: null, lon: null, isValid: false, wasSwapped: false };

  if (!normalizedAnchor.isValid || !normalizedCandidate.isValid) {
    return {
      score: normalizedCandidate.isValid ? 0 : -160,
      anchorTravelMinutes: null,
      routeDetourMinutes: null,
      exceedsLimit: normalizedCandidate.isValid ? false : true,
      withinPreferredWindow: false,
    };
  }

  const anchorTravelMinutes = estimateTravelMinutes(
    normalizedAnchor.lat,
    normalizedAnchor.lon,
    normalizedCandidate.lat,
    normalizedCandidate.lon,
    args.pace,
    args.transportation
  );
  const anchorToCandidate = anchorTravelMinutes;
  const candidateToNext =
    normalizedNext.isValid
      ? estimateTravelMinutes(
          normalizedCandidate.lat,
          normalizedCandidate.lon,
          normalizedNext.lat,
          normalizedNext.lon,
          args.pace,
          args.transportation
        )
      : null;
  const anchorToNext =
    normalizedNext.isValid
      ? estimateTravelMinutes(
          normalizedAnchor.lat,
          normalizedAnchor.lon,
          normalizedNext.lat,
          normalizedNext.lon,
          args.pace,
          args.transportation
        )
      : null;
  const routeDetourMinutes =
    candidateToNext != null && anchorToNext != null
      ? Math.max(0, anchorToCandidate + candidateToNext - anchorToNext)
      : anchorTravelMinutes;

  let score = 0;

  if (anchorTravelMinutes <= 10) score += 40;
  else if (anchorTravelMinutes <= idealLimit) score += 32;
  else if (anchorTravelMinutes <= 20) score += 20;
  else if (anchorTravelMinutes <= hardLimit) score += 8;
  else score += args.explicitRequest ? -8 : -52 - Math.min(20, anchorTravelMinutes - hardLimit);

  if (routeDetourMinutes <= 10) score += 14;
  else if (routeDetourMinutes <= idealLimit) score += 8;
  else if (routeDetourMinutes <= 20) score += 2;
  else if (routeDetourMinutes <= hardLimit) score -= 4;
  else score += args.explicitRequest ? -12 : -28 - Math.min(12, routeDetourMinutes - hardLimit);

  if (sharesLocationContext(candidate.location, args.anchor?.location ?? "")) {
    score += 8;
  }
  if (args.nextStop && sharesLocationContext(candidate.location, args.nextStop.location)) {
    score += 4;
  }

  const exceedsLimit =
    anchorTravelMinutes > hardLimit || (routeDetourMinutes != null && routeDetourMinutes > hardLimit);

  return {
    score,
    anchorTravelMinutes,
    routeDetourMinutes,
    exceedsLimit,
    withinPreferredWindow:
      anchorTravelMinutes <= idealLimit &&
      (routeDetourMinutes == null || routeDetourMinutes <= idealLimit),
  };
}

function findClosestAnchor(
  target: Pick<AiGeneratedItem, "name" | "location" | "lat" | "lon">,
  anchors: Array<Pick<AiGeneratedItem, "name" | "location" | "lat" | "lon">>,
  profile: TripPreferenceProfile
) {
  let bestMatch: {
    anchor: Pick<AiGeneratedItem, "name" | "location" | "lat" | "lon">;
    travelMinutes: number;
    distanceKm: number;
  } | null = null;

  for (const anchor of anchors) {
    const normalizedTarget = normalizeCoordinatePair(target.lat, target.lon);
    const normalizedAnchor = normalizeCoordinatePair(anchor.lat, anchor.lon);
    if (!normalizedTarget.isValid || !normalizedAnchor.isValid) continue;

    const distanceKm = haversineKm(
      normalizedTarget.lat,
      normalizedTarget.lon,
      normalizedAnchor.lat,
      normalizedAnchor.lon
    );
    const travelMinutes = estimateTravelMinutes(
      normalizedTarget.lat,
      normalizedTarget.lon,
      normalizedAnchor.lat,
      normalizedAnchor.lon,
      inferPaceFromProfile(profile),
      "הליכה"
    );

    if (
      bestMatch == null ||
      travelMinutes < bestMatch.travelMinutes ||
      (travelMinutes === bestMatch.travelMinutes && distanceKm < bestMatch.distanceKm)
    ) {
      bestMatch = {
        anchor,
        travelMinutes,
        distanceKm,
      };
    }
  }

  return bestMatch;
}

function buildDayClusterLabel(day: AiGeneratedDay, anchorItems: AiGeneratedItem[]) {
  const frequencies = new Map<string, number>();
  const register = (value: string, weight: number) => {
    const label = normalizeClusterLabel(value);
    if (!label) return;
    frequencies.set(label, (frequencies.get(label) ?? 0) + weight);
  };

  register(day.cityRegion, 4);
  register(day.accommodation, 3);
  for (const item of anchorItems) {
    register(item.location, 2);
  }
  for (const item of day.items) {
    register(item.location, 1);
  }

  return [...frequencies.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? day.cityRegion;
}

export function analyzeDayGeography(
  day: AiGeneratedDay,
  profile: TripPreferenceProfile
): DayGeographyDiagnostics {
  const orderedItems = sortItemsBySchedule(day.items);
  const invalidCoordinateItems: string[] = [];
  const correctedCoordinateItems: string[] = [];

  for (const item of orderedItems) {
    const normalized = normalizeCoordinatePair(item.lat, item.lon);
    if (item.lat != null || item.lon != null) {
      if (!normalized.isValid) {
        invalidCoordinateItems.push(item.name);
      } else if (normalized.wasSwapped) {
        correctedCoordinateItems.push(item.name);
      }
    }
  }

  const anchorItems = orderedItems.filter((item) => isAnchorCategory(item.category));
  const foodItems = orderedItems.filter((item) => isFoodCategory(item.category));
  const isTransferDay = isIntercityTransferDay(day);
  // A day trip keeps the day's own overnight base (day.accommodation is
  // unchanged from the surrounding days) but its stops genuinely sit far
  // away for the day — cross-city distance there is expected, not a bug,
  // same as it already is on a transfer day.
  const skipCrossCityChecks = isTransferDay || isDayTripDay(day);
  const clusterLabel = buildDayClusterLabel(day, anchorItems);
  const clusterContext = `${clusterLabel} ${day.cityRegion} ${day.accommodation}`;
  const baseAnchor = anchorItems.find(hasCoordinates) ?? anchorItems[0] ?? null;
  const crossCityItems = new Set<string>();
  const longTravelSegments: GeographicSegmentDiagnostic[] = [];
  const longMealDetours: GeographicSegmentDiagnostic[] = [];
  let totalTravelMinutes = 0;
  const pace = inferPaceFromProfile(profile);

  for (let index = 1; index < orderedItems.length; index += 1) {
    const previous = orderedItems[index - 1];
    const current = orderedItems[index];
    const normalizedPrevious = normalizeCoordinatePair(previous.lat, previous.lon);
    const normalizedCurrent = normalizeCoordinatePair(current.lat, current.lon);
    const segmentMinutes =
      current.travelMinutes ??
      estimateTravelMinutes(
        normalizedPrevious.lat,
        normalizedPrevious.lon,
        normalizedCurrent.lat,
        normalizedCurrent.lon,
        pace,
        current.transportation || day.transportation || "תחבורה מקומית"
      );
    const distanceKm = haversineKm(
      normalizedPrevious.lat,
      normalizedPrevious.lon,
      normalizedCurrent.lat,
      normalizedCurrent.lon
    );

    totalTravelMinutes += segmentMinutes ?? 0;

    if (!skipCrossCityChecks && segmentMinutes > MAX_LOCAL_TRAVEL_MINUTES) {
      longTravelSegments.push({
        fromName: previous.name,
        toName: current.name,
        minutes: segmentMinutes,
        distanceKm: Number(distanceKm.toFixed(2)),
      });
    }

    if (
      !skipCrossCityChecks &&
      normalizedPrevious.isValid &&
      normalizedCurrent.isValid &&
      distanceKm >= DISTANT_CITY_DISTANCE_KM &&
      !sharesLocationContext(previous.location, current.location, clusterContext)
    ) {
      crossCityItems.add(previous.name);
      crossCityItems.add(current.name);
    }
  }

  if (baseAnchor && hasCoordinates(baseAnchor)) {
    for (const item of anchorItems) {
      if (item === baseAnchor) continue;
      const normalizedBase = normalizeCoordinatePair(baseAnchor.lat, baseAnchor.lon);
      const normalizedItem = normalizeCoordinatePair(item.lat, item.lon);
      const distanceKm = haversineKm(
        normalizedBase.lat,
        normalizedBase.lon,
        normalizedItem.lat,
        normalizedItem.lon
      );

      if (
        !skipCrossCityChecks &&
        normalizedBase.isValid &&
        normalizedItem.isValid &&
        distanceKm >= DISTANT_CITY_DISTANCE_KM &&
        !sharesLocationContext(item.location, baseAnchor.location, clusterContext)
      ) {
        crossCityItems.add(item.name);
      }
    }
  }

  const anchorCandidates = anchorItems.filter(hasCoordinates);
  for (const meal of foodItems.filter(hasCoordinates)) {
    const closestAnchor = findClosestAnchor(meal, anchorCandidates, profile);
    if (!closestAnchor) continue;

    if (closestAnchor.travelMinutes > MAX_LOCAL_TRAVEL_MINUTES) {
      longMealDetours.push({
        fromName: closestAnchor.anchor.name,
        toName: meal.name,
        minutes: closestAnchor.travelMinutes,
        distanceKm: Number(closestAnchor.distanceKm.toFixed(2)),
      });
    }
  }

  const supportingStopCount = orderedItems.filter(
    (item) => item.category === "transportation" || item.category === "hotel"
  ).length;
  const foodDominant =
    foodItems.length > 0 &&
    (anchorItems.length === 0 || foodItems.length >= anchorItems.length || foodItems.length > Math.ceil(orderedItems.length * 0.45));

  return {
    invalidCoordinateItems,
    correctedCoordinateItems,
    crossCityItems: [...crossCityItems],
    longTravelSegments,
    longMealDetours,
    foodStopCount: foodItems.length,
    anchorStopCount: anchorItems.length,
    supportingStopCount,
    foodDominant,
    totalTravelMinutes,
    clusterLabel,
    orderedStopNames: orderedItems.map((item) => item.name),
    isTransferDay,
    energyLevel: isTransferDay ? "low" : computeDayEnergyLevel(anchorItems),
  };
}

function isAvoidedByProfile(
  item: Pick<AiGeneratedItem, "name" | "location" | "shortDescription">,
  profile: TripPreferenceProfile
) {
  if (profile.avoidKeywords.length === 0) return false;
  return includesAnyKeyword(
    `${item.name} ${item.location} ${item.shortDescription}`,
    profile.avoidKeywords
  );
}

export function buildBudgetAllocation(
  preferences: TripPreferences,
  dayCount: number
): BudgetAllocation {
  const allocation: BudgetAllocation = {
    accommodation: 0.35,
    food: 0.2,
    transportation: 0.2,
    attractions: 0.15,
    buffer: 0.1,
  };

  if (preferences.generationMode === "cheapest") {
    allocation.accommodation = 0.32;
    allocation.food = 0.18;
    allocation.transportation = 0.18;
    allocation.attractions = 0.12;
    allocation.buffer = 0.2;
  } else if (preferences.generationMode === "fastest") {
    allocation.transportation = 0.25;
    allocation.accommodation = 0.33;
    allocation.food = 0.18;
    allocation.attractions = 0.14;
    allocation.buffer = 0.1;
  } else if (preferences.generationMode === "relaxed") {
    allocation.accommodation = 0.38;
    allocation.food = 0.2;
    allocation.transportation = 0.16;
    allocation.attractions = 0.14;
    allocation.buffer = 0.12;
  }

  const interests = `${preferences.tripStyle} ${preferences.interests}`.toLowerCase();
  if (includesAnyKeyword(interests, ["food", "culinary", "אוכל", "שוק", "גסטרו"])) {
    allocation.food += 0.04;
    allocation.attractions -= 0.02;
    allocation.buffer -= 0.02;
  }
  if (includesAnyKeyword(interests, ["nature", "hike", "park", "טבע", "טרק"])) {
    allocation.attractions -= 0.03;
    allocation.buffer += 0.01;
  }
  if (includesAnyKeyword(interests, ["nightlife", "bars", "חיי לילה"])) {
    allocation.food += 0.02;
    allocation.transportation += 0.02;
    allocation.attractions -= 0.02;
    allocation.buffer -= 0.02;
  }

  if (dayCount >= 14) {
    allocation.buffer = Math.max(allocation.buffer, 0.12);
  }

  const total =
    allocation.accommodation +
    allocation.food +
    allocation.transportation +
    allocation.attractions +
    allocation.buffer;

  return {
    accommodation: allocation.accommodation / total,
    food: allocation.food / total,
    transportation: allocation.transportation / total,
    attractions: allocation.attractions / total,
    buffer: allocation.buffer / total,
  };
}

export function buildTripPreferenceProfile(
  preferences: TripPreferences,
  countryName: string,
  dayCount: number
): TripPreferenceProfile {
  const budgetAllocation = buildBudgetAllocation(preferences, dayCount);
  const budgetTarget = roundPrice(preferences.budget);
  const budgetSoftCeiling =
    budgetTarget != null ? Math.round(budgetTarget * 1.05) : null;
  const budgetHardCeiling =
    budgetTarget != null ? Math.round(budgetTarget * 1.1) : null;
  const travelers = Math.max(preferences.travelers, 1);
  const usableBudget =
    budgetTarget != null ? Math.round(budgetTarget * (1 - budgetAllocation.buffer)) : null;
  const perDayBudget =
    usableBudget != null && dayCount > 0 ? Math.round(usableBudget / dayCount) : null;
  const dailyCapacityMinutes =
    preferences.tripPace === "relaxed"
      ? 480
      : preferences.tripPace === "balanced"
        ? 600
        : 720;
  const luxuryEnabled = includesAnyKeyword(
    `${preferences.tripStyle} ${preferences.interests} ${preferences.generationMode}`,
    LUXURY_KEYWORDS
  );

  const hardConstraints = [
    budgetTarget != null ? `תקציב מקסימלי: ₪${budgetTarget}` : "",
    preferences.startDate && preferences.endDate
      ? `תאריכים קשיחים: ${preferences.startDate} עד ${preferences.endDate}`
      : "",
    travelers > 0 ? `מספר נוסעים: ${travelers}` : "",
    preferences.accessibilityNeeds ? `נגישות: ${preferences.accessibilityNeeds}` : "",
    preferences.dietaryPreferences ? `הגבלות תזונתיות: ${preferences.dietaryPreferences}` : "",
    preferences.mustVisitPlaces ? `חובה לשלב: ${preferences.mustVisitPlaces}` : "",
    preferences.placesToAvoid ? `אסור או רצוי להימנע: ${preferences.placesToAvoid}` : "",
    preferences.transportationPreferences ? `מגבלות תחבורה: ${preferences.transportationPreferences}` : "",
    preferences.accommodationArea ? `העדפות לינה: ${preferences.accommodationArea}` : "",
  ].filter(Boolean);

  const strongPreferences = [
    `קצב: ${preferences.tripPace}`,
    preferences.tripStyle ? `סגנון: ${preferences.tripStyle}` : "",
    preferences.interests ? `תחומי עניין: ${preferences.interests}` : "",
    preferences.transportationPreferences ? `תחבורה מועדפת: ${preferences.transportationPreferences}` : "",
    preferences.preferredRegions ? `אזורים מועדפים: ${preferences.preferredRegions}` : "",
    preferences.safetyConstraints ? `בטיחות: ${preferences.safetyConstraints}` : "",
  ].filter(Boolean);

  const softPreferences = [
    preferences.interests ? `רצוי לשלב: ${preferences.interests}` : "",
  ].filter(Boolean);

  const mustVisitKeywords = parseKeywords(preferences.mustVisitPlaces);
  const avoidKeywords = parseKeywords(preferences.placesToAvoid);
  const dietaryKeywords = parseKeywords(preferences.dietaryPreferences);
  const preferredAreaKeywords = parseKeywords(preferences.preferredRegions || preferences.accommodationArea);

  const accommodationBudgetPerDay =
    perDayBudget != null ? Math.round(perDayBudget * budgetAllocation.accommodation) : null;
  const foodBudgetPerDay =
    perDayBudget != null ? Math.round(perDayBudget * budgetAllocation.food) : null;
  const transportBudgetPerDay =
    perDayBudget != null ? Math.round(perDayBudget * budgetAllocation.transportation) : null;
  const attractionBudgetPerDay =
    perDayBudget != null ? Math.round(perDayBudget * budgetAllocation.attractions) : null;

  const mealBudgetLunch =
    foodBudgetPerDay != null ? Math.max(35, Math.round(foodBudgetPerDay * 0.4)) : null;
  const mealBudgetDinner =
    foodBudgetPerDay != null ? Math.max(50, Math.round(foodBudgetPerDay * 0.55)) : null;
  const activityBudgetPerStop =
    attractionBudgetPerDay != null
      ? Math.max(30, Math.round(attractionBudgetPerDay / (preferences.tripPace === "fast" ? 2.5 : 2)))
      : null;

  const summary = [
    `Trip: ${countryName}`,
    preferences.startDate && preferences.endDate
      ? `${preferences.startDate}–${preferences.endDate} (${dayCount} days)`
      : `${dayCount} days`,
    `${travelers} travelers`,
    budgetTarget != null ? `Budget max: ₪${budgetTarget}` : "Budget: not defined",
    `Pace: ${preferences.tripPace}`,
    preferences.tripStyle ? `Style: ${preferences.tripStyle}` : "",
    preferences.interests ? `Priorities: ${preferences.interests}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    dayCount,
    budgetTarget,
    budgetSoftCeiling,
    budgetHardCeiling,
    dailyCapacityMinutes,
    perDayBudget,
    mealBudgetLunch,
    mealBudgetDinner,
    activityBudgetPerStop,
    transportBudgetPerDay,
    accommodationBudgetPerDay,
    budgetAllocation,
    hardConstraints,
    strongPreferences,
    softPreferences,
    mustVisitKeywords,
    avoidKeywords,
    dietaryKeywords,
    preferredAreaKeywords,
    luxuryEnabled,
    summary,
  };
}

export function normalizePriceToTarget(
  amount: number | null | undefined,
  context: ExchangeRateContext | null
) {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (!context) return roundPrice(amount);
  return roundPrice(amount * context.rateToTarget);
}

export function withNormalizedRecommendationPrice(
  recommendation: TripRecommendation,
  context: ExchangeRateContext | null
): TripRecommendation {
  const originalAmount = roundPrice(recommendation.approximatePrice);
  const convertedAmount = normalizePriceToTarget(originalAmount, context);
  return {
    ...recommendation,
    approximatePrice: convertedAmount,
    priceOriginalAmount:
      recommendation.priceOriginalAmount ?? originalAmount,
    priceOriginalCurrency:
      recommendation.priceOriginalCurrency ?? context?.sourceCurrency ?? "ILS",
    priceConvertedAmount:
      recommendation.priceConvertedAmount ?? convertedAmount,
    priceExchangeRate:
      recommendation.priceExchangeRate ?? context?.rateToTarget ?? 1,
    priceRateTimestamp:
      recommendation.priceRateTimestamp ?? context?.updatedAt ?? null,
    convertedCurrency: recommendation.convertedCurrency ?? context?.targetCurrency ?? "ILS",
    sourceType: recommendation.sourceType ?? "candidate",
  };
}

interface CostSummaryDay {
  items: Array<{ category: RecommendationCategory; approximatePrice: number | null }>;
  estimatedCost?: number | null;
  activityCost?: number | null;
  foodCost?: number | null;
  transportCost?: number | null;
  accommodationCost?: number | null;
}

export interface ItemCostSummary {
  totalEstimatedCost: number | null;
  estimatedTransportCost: number | null;
  averageDailyCost: number | null;
  costPerTraveler: number | null;
  categoryBreakdown: Record<string, number>;
}

/**
 * Single source of truth for turning a list of days (each with priced
 * items) into cost totals. Used both right after generation
 * (`country-itinerary-generation.ts`) and at save time
 * (`computeItineraryCostSummary` in itineraries.ts) so the two no longer
 * risk silently diverging.
 */
export function summarizeItemCosts(
  days: CostSummaryDay[],
  travelers: number,
  extraExpenses: Array<{ category: string; amount: number }> = []
): ItemCostSummary {
  const categoryBreakdown = new Map<string, number>();

  for (const day of days) {
    const derived = { accommodation: 0, food: 0, attractions: 0, transportation: 0 };
    for (const item of day.items) {
      const price = item.approximatePrice ?? 0;
      if (item.category === "restaurant" || item.category === "cafe") {
        derived.food += price;
      } else if (item.category === "hotel") {
        derived.accommodation += price;
      } else if (item.category === "transportation") {
        derived.transportation += price;
      } else {
        derived.attractions += price;
      }
    }

    const groups = {
      accommodation: day.accommodationCost ?? (derived.accommodation > 0 ? derived.accommodation : 0),
      food: day.foodCost ?? (derived.food > 0 ? derived.food : 0),
      attractions: day.activityCost ?? (derived.attractions > 0 ? derived.attractions : 0),
      transportation: day.transportCost ?? (derived.transportation > 0 ? derived.transportation : 0),
    };

    const explicitTotal = groups.accommodation + groups.food + groups.attractions + groups.transportation;
    const dayBase = day.estimatedCost ?? explicitTotal;

    if (dayBase > explicitTotal && explicitTotal === 0) {
      groups.attractions += dayBase;
    } else if (dayBase > explicitTotal) {
      categoryBreakdown.set("other", (categoryBreakdown.get("other") ?? 0) + (dayBase - explicitTotal));
    }

    for (const [key, amount] of Object.entries(groups)) {
      if (amount <= 0) continue;
      categoryBreakdown.set(key, (categoryBreakdown.get(key) ?? 0) + amount);
    }
  }

  for (const expense of extraExpenses) {
    const key = expense.category === "local_transportation" ? "transportation" : expense.category;
    categoryBreakdown.set(key, (categoryBreakdown.get(key) ?? 0) + expense.amount);
  }

  const totalEstimatedCost = [...categoryBreakdown.values()].reduce((sum, amount) => sum + amount, 0);
  const safeTravelers = Math.max(travelers, 1);

  return {
    totalEstimatedCost: totalEstimatedCost > 0 ? Math.round(totalEstimatedCost) : null,
    estimatedTransportCost:
      (categoryBreakdown.get("transportation") ?? 0) > 0
        ? Math.round(categoryBreakdown.get("transportation")!)
        : null,
    averageDailyCost:
      totalEstimatedCost > 0 && days.length > 0 ? Math.round(totalEstimatedCost / days.length) : null,
    costPerTraveler: totalEstimatedCost > 0 ? Math.round(totalEstimatedCost / safeTravelers) : null,
    categoryBreakdown: Object.fromEntries(
      [...categoryBreakdown.entries()].map(([key, value]) => [key, Math.round(value)])
    ),
  };
}

export function normalizeActionableMessages(messages: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const message of messages) {
    const trimmed = message.trim();
    if (!trimmed) continue;
    if (GENERIC_WARNING_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;

    const key = trimmed
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!,;:]/g, "");

    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

export function calculateDayLoadMinutes(day: Pick<AiGeneratedDay, "items" | "restWindow">) {
  const itemMinutes = day.items.reduce((sum, item) => {
    const duration = item.estimatedDurationMinutes ?? 90;
    const travel = item.travelMinutes ?? 0;
    const mealBuffer = item.slot === "lunch" || item.slot === "dinner" ? 15 : 0;
    return sum + duration + travel + mealBuffer;
  }, 0);

  return itemMinutes + (day.restWindow ? 20 : 0);
}

function buildPlaceKey(item: Pick<AiGeneratedItem, "recommendationId" | "name" | "lat" | "lon" | "location">) {
  if (item.recommendationId) return `id:${item.recommendationId}`;
  if (item.lat != null && item.lon != null) {
    // ~111m grid (was 4 decimals / ~11m) plus the normalized name — see
    // buildItemKey's identical reasoning in country-itinerary-generation.ts.
    return `coords:${item.lat.toFixed(3)}:${item.lon.toFixed(3)}:${normalizePlaceNameSlug(item.name)}`;
  }
  // No id and no coordinates means this isn't a claim about a specific real
  // place — generic/flexible filler content (free-exploration/free-time/meal
  // placeholders) — see buildItemKey's identical reasoning and the real bug
  // it fixes in country-itinerary-generation.ts. Never treated as a
  // duplicate rather than trusting generated filler text to already be
  // globally unique.
  return `generic:${crypto.randomUUID()}`;
}

const FUZZY_DUPLICATE_MAX_KM = 0.15; // ~150m

// Strips parenthetical suffixes ("Mtatsminda Park (Funicular)" ->
// "mtatsminda park") and punctuation so differently-worded mentions of the
// same real place collapse to the same slug — buildPlaceKey's exact/coord
// match alone misses this class of duplicate (spec item 52/56's "duplicate
// Mtatsminda Park" symptom).
export function normalizePlaceNameSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface FuzzyPlaceRecord {
  nameSlug: string;
  lat: number | null;
  lon: number | null;
}

function isFuzzyDuplicatePlace(a: FuzzyPlaceRecord, b: FuzzyPlaceRecord): boolean {
  if (!a.nameSlug || !b.nameSlug) return false;
  const namesMatch = a.nameSlug === b.nameSlug || a.nameSlug.startsWith(b.nameSlug) || b.nameSlug.startsWith(a.nameSlug);
  if (!namesMatch) return false;
  // Both slugs matched (one contains the other) — if we also have
  // coordinates for both, only call it a duplicate when they're genuinely
  // close together, so "Mtatsminda Park" in Tbilisi never collides with an
  // unrelated same-named place elsewhere. Without coordinates for either
  // side, the strict slug match alone is treated as sufficient (same trust
  // level as buildPlaceKey's own name+location exact-match fallback).
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return true;
  return haversineKm(a.lat, a.lon, b.lat, b.lon) <= FUZZY_DUPLICATE_MAX_KM;
}

/** Categories that represent arrival/transfer/logistics rather than a discretionary activity. */
export const NON_ACTIVITY_CATEGORIES = new Set<RecommendationCategory>(["transportation", "hotel", "practical"]);

function countArrivalDepartureWindowViolations(
  plan: AiItineraryResponse,
  window: ArrivalDepartureWindow | null | undefined
): number {
  if (!window) return 0;
  const dayCount = plan.days.length;
  let violations = 0;

  for (const day of plan.days) {
    const isArrivalDay = day.dayNumber === 1;
    const isDepartureDay = day.dayNumber === dayCount;
    if (!isArrivalDay && !isDepartureDay) continue;

    for (const item of day.items) {
      if (NON_ACTIVITY_CATEGORIES.has(item.category)) continue;
      if (violatesArrivalDepartureWindow(item.plannedStartTime, day.date, isArrivalDay, isDepartureDay, window)) {
        violations += 1;
      }
    }
  }

  return violations;
}

export function collectPlanDiagnostics(
  plan: AiItineraryResponse,
  profile: TripPreferenceProfile,
  tripFrame?: TripFrame | null,
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
): PlanDiagnostics {
  let missingMeals = 0;
  let duplicatePlaces = 0;
  let duplicateWarnings = 0;
  let overloadedDays = 0;
  let missingAccommodation = 0;
  let missingTransport = 0;
  let avoidConflicts = 0;
  let invalidCoordinates = 0;
  let crossCityDays = 0;
  let longTravelDays = 0;
  let foodDominantDays = 0;
  let missingAnchorDays = 0;
  let longMealDetours = 0;
  let baseMismatchDays = 0;
  let timeOverlaps = 0;
  let currentHighEnergyStreak = 0;
  let maxConsecutiveHighEnergyDays = 0;
  const seenPlaces = new Set<string>();
  const seenFuzzyPlaces: FuzzyPlaceRecord[] = [];
  const matchedMustVisitKeywords = new Set<string>();
  const activityCategoryCounts = new Map<RecommendationCategory, number>();
  let totalCountedActivities = 0;
  const tierCounts = new Map<ActivityTier, number>();
  let totalTierStops = 0;

  for (const day of plan.days) {
    const hasLunch = day.items.some(
      (item) => item.slot === "lunch" && isFoodCategory(item.category)
    );
    const hasDinner = day.items.some(
      (item) => item.slot === "dinner" && isFoodCategory(item.category)
    );
    if (!hasLunch) missingMeals += 1;
    if (!hasDinner) missingMeals += 1;

    const normalizedWarnings = normalizeActionableMessages(day.warnings);
    duplicateWarnings += Math.max(day.warnings.length - normalizedWarnings.length, 0);

    if (calculateDayLoadMinutes(day) > profile.dailyCapacityMinutes) {
      overloadedDays += 1;
    }

    if (!day.accommodation.trim()) {
      missingAccommodation += 1;
    }

    if (
      !day.transportation.trim() &&
      day.items.some((item) => (item.travelMinutes ?? 0) > 0)
    ) {
      missingTransport += 1;
    }

    const geography = analyzeDayGeography(day, profile);
    timeOverlaps += countDayTimeOverlaps(day);
    invalidCoordinates += geography.invalidCoordinateItems.length;
    if (geography.crossCityItems.length > 0) {
      crossCityDays += 1;
    }
    if (
      !geography.isTransferDay &&
      (geography.totalTravelMinutes > MAX_NORMAL_DAY_TRAVEL_MINUTES ||
        geography.longTravelSegments.some((segment) => segment.minutes > 45))
    ) {
      longTravelDays += 1;
    }
    if (geography.foodDominant) {
      foodDominantDays += 1;
    }
    if (!geography.isTransferDay && geography.anchorStopCount === 0) {
      missingAnchorDays += 1;
    }
    longMealDetours += geography.longMealDetours.length;

    if (geography.energyLevel === "high") {
      currentHighEnergyStreak += 1;
      maxConsecutiveHighEnergyDays = Math.max(maxConsecutiveHighEnergyDays, currentHighEnergyStreak);
    } else {
      currentHighEnergyStreak = 0;
    }

    if (tripFrame) {
      const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
      if (
        phase &&
        !geography.isTransferDay &&
        !sharesLocationContext(day.cityRegion || day.accommodation, phase.areaLabel)
      ) {
        baseMismatchDays += 1;
      }
    }

    const daySearchBlob = normalizeSearchableText(
      [
        day.title,
        day.cityRegion,
        day.accommodation,
        day.notes,
        ...day.items.map((item) => `${item.name} ${item.location} ${item.shortDescription}`),
      ].join(" ")
    );

    for (const keyword of profile.mustVisitKeywords) {
      if (daySearchBlob.includes(keyword)) {
        matchedMustVisitKeywords.add(keyword);
      }
    }

    for (const item of day.items) {
      const key = buildPlaceKey(item);
      // Only items that actually identify a specific real place (a known
      // candidate id, or real coordinates) participate in the fuzzy
      // name-similarity scan — generic filler content has nothing real to
      // compare, and relies solely on its own always-unique key above.
      const isRealPlace = Boolean(item.recommendationId) || (item.lat != null && item.lon != null);
      const fuzzyRecord: FuzzyPlaceRecord = { nameSlug: normalizePlaceNameSlug(item.name), lat: item.lat, lon: item.lon };
      const isDuplicate =
        seenPlaces.has(key) || (isRealPlace && seenFuzzyPlaces.some((seen) => isFuzzyDuplicatePlace(seen, fuzzyRecord)));
      if (isDuplicate) {
        duplicatePlaces += 1;
      } else {
        seenPlaces.add(key);
        if (isRealPlace) seenFuzzyPlaces.push(fuzzyRecord);
      }

       if (isAvoidedByProfile(item, profile)) {
        avoidConflicts += 1;
      }

      if (
        !isFoodCategory(item.category) &&
        item.category !== "transportation" &&
        item.category !== "hotel"
      ) {
        activityCategoryCounts.set(
          item.category,
          (activityCategoryCounts.get(item.category) ?? 0) + 1
        );
        totalCountedActivities += 1;
      }

      if (item.category !== "transportation" && item.category !== "hotel") {
        const tier = classifyActivityTier(item.category);
        tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
        totalTierStops += 1;
      }
    }
  }

  const totalEstimatedCost =
    roundPrice(
      plan.days.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0)
    ) ?? null;
  const overSoftBudget =
    profile.budgetSoftCeiling != null &&
    totalEstimatedCost != null &&
    totalEstimatedCost > profile.budgetSoftCeiling;
  const outOfBudget =
    profile.budgetHardCeiling != null &&
    totalEstimatedCost != null &&
    totalEstimatedCost > profile.budgetHardCeiling;
  const dominantCategoryEntry = [...activityCategoryCounts.entries()].sort(
    (left, right) => right[1] - left[1]
  )[0];
  const dominantCategory = dominantCategoryEntry?.[0] ?? null;
  const dominantCategoryShare =
    dominantCategoryEntry != null && totalCountedActivities > 0
      ? dominantCategoryEntry[1] / totalCountedActivities
      : 0;
  const diversityRisk =
    totalCountedActivities >= 8 &&
    activityCategoryCounts.size <= Math.max(2, Math.round(plan.days.length / 6)) &&
    dominantCategoryShare > 0.45;
  const missingMustVisitKeywords = profile.mustVisitKeywords.filter(
    (keyword) => !matchedMustVisitKeywords.has(keyword)
  );

  const activityMixSkew: PlanDiagnostics["activityMixSkew"] =
    totalTierStops >= 6
      ? (Object.keys(ACTIVITY_MIX_TARGETS) as ActivityTier[])
          .map((tier) => {
            const share = (tierCounts.get(tier) ?? 0) / totalTierStops;
            const target = ACTIVITY_MIX_TARGETS[tier];
            return { tier, share, target };
          })
          .filter(({ share, target }) => share < target.min || share > target.max)
      : [];

  return {
    totalEstimatedCost,
    missingMeals,
    duplicatePlaces,
    duplicateWarnings,
    overloadedDays,
    overSoftBudget,
    outOfBudget,
    missingAccommodation,
    missingTransport,
    avoidConflicts,
    missingMustVisitKeywords,
    diversityRisk,
    dominantCategory,
    dominantCategoryShare,
    invalidCoordinates,
    crossCityDays,
    longTravelDays,
    foodDominantDays,
    missingAnchorDays,
    longMealDetours,
    maxConsecutiveHighEnergyDays,
    highEnergyRhythmViolation: maxConsecutiveHighEnergyDays > MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
    baseMismatchDays,
    activityMixSkew,
    arrivalDepartureWindowViolations: countArrivalDepartureWindowViolations(plan, arrivalDepartureWindow),
    timeOverlaps,
  };
}

function countUniqueRegions(days: AiGeneratedDay[]) {
  return new Set(
    days
      .map((day) => day.cityRegion.trim())
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  ).size;
}

function countActivities(days: AiGeneratedDay[]) {
  return days.reduce(
    (sum, day) =>
      sum +
      day.items.filter(
        (item) => item.category !== "restaurant" && item.category !== "cafe"
      ).length,
    0
  );
}

function countFoodStops(days: AiGeneratedDay[]) {
  return days.reduce(
    (sum, day) =>
      sum +
      day.items.filter(
        (item) => item.category === "restaurant" || item.category === "cafe"
      ).length,
    0
  );
}

function countDayTrips(days: AiGeneratedDay[]) {
  return days.reduce(
    (sum, day) => sum + day.items.filter((item) => item.category === "day_trip").length,
    0
  );
}

function countLighterDays(days: AiGeneratedDay[], profile: TripPreferenceProfile) {
  return days.filter(
    (day) =>
      !!day.restWindow ||
      calculateDayLoadMinutes(day) <= Math.round(profile.dailyCapacityMinutes * 0.65)
  ).length;
}

export function buildGenerationSummary(
  plan: AiItineraryResponse,
  profile: TripPreferenceProfile
) {
  const totalCost =
    roundPrice(plan.totalEstimatedCost) ??
    roundPrice(plan.days.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0));
  const withinBudgetLabel =
    profile.budgetTarget != null && totalCost != null
      ? totalCost <= profile.budgetSoftCeiling!
        ? `בתוך יעד התקציב של ₪${profile.budgetTarget}`
        : `בסך מוערך של ₪${totalCost}`
      : totalCost != null
        ? `בסך מוערך של ₪${totalCost}`
        : "עם אומדן עלות מתוקן";

  return `נוצר מסלול של ${plan.days.length} ימים ${withinBudgetLabel}, עם ${countUniqueRegions(plan.days)} אזורים, ${countActivities(plan.days)} פעילויות, ${countFoodStops(plan.days)} עצירות אוכל, ${countDayTrips(plan.days)} טיולי יום ו-${countLighterDays(plan.days, profile)} ימים קלים יותר.`;
}

export function getBudgetCapForItem(
  item: Pick<AiGeneratedItem, "category" | "slot">,
  profile: TripPreferenceProfile
) {
  if (item.category === "restaurant" || item.category === "cafe") {
    return item.slot === "dinner" ? profile.mealBudgetDinner : profile.mealBudgetLunch;
  }

  if (item.category === "transportation") return profile.transportBudgetPerDay;
  return profile.activityBudgetPerStop;
}

export function isPremiumVenue(item: Pick<AiGeneratedItem, "name" | "approximatePrice">) {
  return (
    includesAnyKeyword(item.name, PREMIUM_VENUE_KEYWORDS) ||
    (item.approximatePrice != null && item.approximatePrice >= 350)
  );
}

export function scoreBudgetFitness(
  recommendation: Pick<TripRecommendation, "approximatePrice" | "name" | "category">,
  slot: DayPart,
  profile: TripPreferenceProfile
) {
  const cap =
    recommendation.category === "restaurant" || recommendation.category === "cafe"
      ? slot === "dinner"
        ? profile.mealBudgetDinner
        : profile.mealBudgetLunch
      : profile.activityBudgetPerStop;

  if (cap == null || recommendation.approximatePrice == null) return 0;
  if (recommendation.approximatePrice <= cap) return 12;
  if (recommendation.approximatePrice <= cap * 1.2 && profile.luxuryEnabled) return 4;
  if (recommendation.approximatePrice <= cap * 1.5) return -12;
  return -30;
}
