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
import {
  classifyItemEnergy,
  findFramePhaseForDay,
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
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

    if (!isTransferDay && segmentMinutes > MAX_LOCAL_TRAVEL_MINUTES) {
      longTravelSegments.push({
        fromName: previous.name,
        toName: current.name,
        minutes: segmentMinutes,
        distanceKm: Number(distanceKm.toFixed(2)),
      });
    }

    if (
      !isTransferDay &&
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
        !isTransferDay &&
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
    return `coords:${item.lat.toFixed(4)}:${item.lon.toFixed(4)}`;
  }
  return `name:${item.name.trim().toLowerCase()}::${item.location.trim().toLowerCase()}`;
}

export function collectPlanDiagnostics(
  plan: AiItineraryResponse,
  profile: TripPreferenceProfile,
  tripFrame?: TripFrame | null
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
  let currentHighEnergyStreak = 0;
  let maxConsecutiveHighEnergyDays = 0;
  const seenPlaces = new Set<string>();
  const matchedMustVisitKeywords = new Set<string>();
  const activityCategoryCounts = new Map<RecommendationCategory, number>();
  let totalCountedActivities = 0;

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
      if (seenPlaces.has(key)) {
        duplicatePlaces += 1;
      } else {
        seenPlaces.add(key);
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
