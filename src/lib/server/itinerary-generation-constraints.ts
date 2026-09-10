import type {
  AiGeneratedDay,
  AiGeneratedItem,
  AiItineraryResponse,
  DayPart,
  DestinationMobilityProfile,
  RecommendationCategory,
  TripPreferences,
  TripRecommendation,
} from "../trip-workspace";
import {
  estimateTravelMinutes,
  haversineKm,
  isFuzzyDuplicatePlace,
  normalizePlaceNameSlug,
  deriveDailyCapacityMinutes,
  type FuzzyPlaceRecord,
} from "../trip-workspace";
import {
  violatesArrivalDepartureWindow,
  detectInvalidFlightLegs,
  detectAirportBaseMismatch,
  type ArrivalDepartureWindow,
  type InvalidFlightLegDiagnostic,
  type AirportBaseMismatchDiagnostic,
} from "../flight-planning";
import type { TripFlights } from "@/lib/trip-workspace";
import { violatesOpeningHours } from "./opening-hours";
import { isPlannerQaTraceEnabled, buildDuplicateTraceReports, formatDuplicateTraceReport } from "@/lib/planner-qa-trace";
import { findFixedTimeConflicts, type FixedTimeConflict } from "./itinerary-scheduler";
import { isImplausiblyFastTravelTime, resolveTransportModeFromLabel } from "../transport-mode";
import {
  ACTIVITY_MIX_TARGETS,
  classifyActivityTier,
  classifyItemEnergy,
  classifyVisitScale,
  classifyWeatherSensitivity,
  findFramePhaseForDay,
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
  resolveItemEffectiveEndTime,
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
  /** Spec item 22 — its own line rather than folded into attractions (spec item 53's shopping/souvenir time still needs a real budget share). */
  shopping: number;
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
  /** Spec "MAKE TRAVEL METRICS ACTUALLY ACTIVE" — a NORMAL day (never day-trip/transfer) whose single-segment travel time still exceeds the destination's own real DestinationMobilityProfile budget after repair. Distinct from longTravelDays' fixed-constant check: this one is mobility-profile-aware, real per-trip, and only counted when a real profile was actually supplied. Optional — absent on any diagnostics object built before this field existed (a hand-built test fixture, an older code path); treat absent the same as 0, never as a failure. */
  normalDayTravelOutliers?: number;
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
   * Thread 1 (locked/fixed-time hard requirement), item 7: two fixed-time
   * items on the same day whose own times (plus real travel between them)
   * genuinely cannot both be honored — a legitimate hard failure, never
   * silently resolved by moving either one. Each entry names the day it
   * happened on (dayId here is the day's dayNumber — AiGeneratedDay has no
   * other stable id at generation time) plus both activities, their fixed
   * times, and the travel time that was required.
   */
  fixedTimeConflicts: Array<FixedTimeConflict & { dayId: number }>;
  /**
   * Two items on the same day whose visit-scale-derived windows overlap in
   * wall-clock time (spec item 58's "three activities at 12:30" symptom) —
   * a hard gate. Computed from plannedStartTime + a resolved duration, so it
   * catches raw AI output even before any scheduler pass has assigned a
   * real endTime.
   */
  timeOverlaps: number;
  /**
   * Items scheduled outside their own parsed opening-hours window (or past
   * a distinct lastEntryTime) — spec items 16/17/84/85. A hard gate, only
   * ever counts items whose opening hours AND start time both parsed with
   * confidence (see violatesOpeningHours) — never a false positive from
   * ambiguous source text.
   */
  openingHoursViolations: number;
  /** A day with more than the two normal dedicated food stops (spec item 37). */
  excessFoodStopsDays: number;
  /** Consecutive food stops closer together than the spec's minimum spacing (item 39). */
  mealSpacingViolations: number;
  /** The same restaurant/cafe name appearing more than once across the whole trip (spec item 42). */
  duplicateRestaurants: number;
  /**
   * A flight leg whose origin and destination airport are identical (spec
   * §A2) — always a real data problem (an accidental default surviving two
   * dropdowns), never a legitimate flight. A hard gate.
   */
  invalidFlightLegs: number;
  /** Structured detail behind invalidFlightLegs, for debugging/logging — never itself a gate. */
  invalidFlightLegDetails: InvalidFlightLegDiagnostic[];
  /**
   * The arrival or departure airport is real-distance-implausibly far from
   * that day's own dominant activity coordinates — meaningfully more ground
   * travel than the fixed buffer the arrival/departure window already
   * assumes (spec §A3-A5). A hard gate: this is "physically impossible
   * flight/base transition" territory, not a soft preference.
   */
  airportBaseMismatches: number;
  /** Structured detail behind airportBaseMismatches, for debugging/logging. */
  airportBaseMismatchDetails: AirportBaseMismatchDiagnostic[];
  /**
   * A locked/fixed-time item that sits in a geographically incompatible
   * cluster on its day and could not be resolved by the geographic repair
   * cascade (move/replace/remove all skip protected items by design — spec
   * §B5). Surfaced for visibility only; never silently drops or moves
   * protected content, so this stays a soft/advisory count, not a gate.
   */
  protectedGeographicConflicts: number;
  /** Structured detail behind protectedGeographicConflicts. */
  protectedGeographicConflictDetails: ProtectedGeographicConflict[];
  /**
   * A stay transition (spec §C) whose own estimated travel time alone
   * already exceeds the day's realistic capacity — a genuinely impossible
   * base change, not a scheduling inconvenience. A hard gate. No separate
   * stayContinuityViolation exists: overnight continuity is already
   * enforced per-day by baseMismatchDays (every day's own base must match
   * its TripFrame phase), so a second diagnostic for the same invariant
   * would be redundant (spec's own "avoid redundant diagnostics" rule).
   */
  impossibleStayTransitions: number;
  /** Structured detail behind impossibleStayTransitions. */
  impossibleStayTransitionDetails: ImpossibleStayTransition[];
}

/** One stay transition the repair pass found could not be made to fit, even after trimming optional content around it (spec §D/§E5). */
export interface ImpossibleStayTransition {
  fromStay: string;
  toStay: string;
  dayNumber: number;
  requiredTravelMinutes: number;
  availableMinutes: number;
  reason: string;
}

/** One protected (locked/fixedTime) item the geographic repair cascade found in genuine conflict but correctly refused to touch (spec §B5). */
export interface ProtectedGeographicConflict {
  dayNumber: number;
  itemName: string;
  lat: number | null;
  lon: number | null;
  reason: string;
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
  /** Real gap time within the day's own active span — activeMinutes minus scheduled activity durations and travel (spec item 95). */
  freeMinutes: number;
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
    return { level: "קל", activityCount: 0, walkingKm: 0, travelMinutes: 0, activeMinutes: 0, freeMinutes: 0 };
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

  // Real gap time within the day's own active span (spec item 95) — the
  // span already includes any slack between back-to-back items, so
  // subtracting out what was actually scheduled (durations + travel)
  // leaves the genuine free time, not a guess.
  const scheduledMinutes = items.reduce(
    (sum, item) => (item.category === "transportation" ? sum : sum + (item.estimatedDurationMinutes ?? 60)),
    0
  );
  const freeMinutes = Math.max(0, Math.round(activeMinutes - scheduledMinutes - travelMinutes));

  return {
    level,
    activityCount,
    walkingKm: Math.round(walkingKm * 10) / 10,
    travelMinutes,
    activeMinutes,
    freeMinutes,
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

// Section I/J root cause (a real Georgia QA run): a day whose transportation
// text read "נסיעה ברכב פרטי עם עצירות בדרך" (private-car drive with stops
// along the way) — genuine, legitimate transfer/road-trip phrasing, real
// waypoints along an actual intercity route — matched none of the existing
// keywords, so it was scored as an ordinary day and its real (if
// coordinate-less, in this candidate-starved sandbox) travel time wrongly
// tripped longTravelDays. "stops along the way"/"עצירות בדרך" is added as a
// generic phrase, not tied to any place name.
// Section I/J root cause (a real Georgia QA run): a day whose transportation
// text read "נסיעה ברכב פרטי עם עצירות בדרך" (private-car drive with stops
// along the way) — genuine, legitimate transfer/road-trip phrasing, real
// waypoints along an actual intercity route — matched none of the existing
// keywords, so it was scored as an ordinary day and its real (if
// coordinate-less, in this candidate-starved sandbox) travel time wrongly
// tripped longTravelDays. "stops along the way"/"עצירות בדרך" is added as a
// generic phrase, not tied to any place name.
const TRANSFER_DAY_PATTERN =
  /intercity|transfer|relocation|checkout|check-out|check in|check-in|airport|flight|bullet train|shinkansen|long-distance|ferry crossing|move to next city|road trip|stops? along the way|scenic drive|מעבר|רכבת מהירה|רכבת בין-עירונית|שינקנסן|טיסה|צ'ק-אאוט|צ'ק אאוט|צ'ק-אין|צ'ק אין|שדה תעופה|מעבורת בין-עירונית|עוברים ליעד הבא|לינה חדשה|עצירות בדרך|עצירה בדרך|נסיעה ארוכה בין ערים/i;

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

/** A real one-way hop over this long from the day's own base makes it a day trip structurally (spec item 48). */
const DAY_TRIP_REAL_DISTANCE_MINUTES = 60;
/** How close the day's first and last anchor must be to count as "the same base" (spec item 7: day-trip start/end = same hotel). */
const DAY_TRIP_BASE_RADIUS_KM = 5;

/**
 * Text-pattern wording is checked first; failing that, a genuine
 * round-trip STRUCTURE also counts (spec items 7/48) — but distance alone
 * is deliberately NOT sufficient. An earlier attempt that flagged any day
 * with a >60-minute hop between two anchors, regardless of structure,
 * falsely legitimized a same-day Tokyo+Osaka mix (a genuine AI geography
 * error, never returning to Tokyo) as a "day trip" purely because the
 * cities are far apart — that broke the cross-city hard constraint below.
 * Requiring the first AND last anchor to both sit near the same base,
 * with only a middle anchor genuinely far away, is what actually
 * distinguishes a well-structured day trip from a chaotic geographic
 * error — a chain that never returns (like Tokyo→Osaka) still correctly
 * falls through to the cross-city check.
 */
/**
 * The structural half of isDayTripDay's own check, extracted so a caller
 * that deliberately does NOT want to trust Gemini's own title/notes/
 * transportation wording (spec "GEOGRAPHIC CORRECTNESS REDESIGN" — day-
 * type must be provably derived, not merely asserted by the model) can
 * still use the one real, coordinate-based signal: a genuine out-and-back
 * structure, first/last anchor at the same base, a real distant middle
 * anchor. No text is consulted here at all.
 */
export function isStructuralRoundTripDay(day: Pick<AiGeneratedDay, "items">) {
  const anchors = sortItemsBySchedule(
    day.items.filter((item) => isAnchorCategory(item.category) && hasCoordinates(item))
  );
  if (anchors.length < 3) return false;

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const returnsToBase = haversineKm(first.lat, first.lon, last.lat, last.lon) <= DAY_TRIP_BASE_RADIUS_KM;
  if (!returnsToBase) return false;

  return anchors.slice(1, -1).some((middle) => {
    const oneWayMinutes = estimateTravelMinutes(first.lat, first.lon, middle.lat, middle.lon, "balanced", "");
    return oneWayMinutes > DAY_TRIP_REAL_DISTANCE_MINUTES;
  });
}

export function isDayTripDay(
  day: Pick<AiGeneratedDay, "title" | "notes" | "transportation" | "transportSegments" | "items">
) {
  if (isIntercityTransferDay(day)) return false;
  if (DAY_TRIP_PATTERN.test(`${day.title} ${day.notes} ${day.transportation}`)) return true;
  return isStructuralRoundTripDay(day);
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
      // Prefer the real scheduled end time when the item has already been
      // through the scheduler — recomputing from resolveVisitDurationMinutes
      // is only a stand-in for raw AI output that hasn't been scheduled yet.
      const scheduledEnd = parseTimeToMinutes(item.endTime ?? "");
      if (scheduledEnd != null && scheduledEnd > start) {
        return { start, end: scheduledEnd };
      }
      // Same "practical" filler exclusion as calculateDayLoadMinutes and
      // itinerary-scheduler.ts's isFillerItem branch — a free-time block's
      // own deliberately-large duration (it fills whatever window is left,
      // often hours) must never be run back through
      // resolveVisitDurationMinutes/classifyVisitScale, which is built for
      // real attractions. Root cause of a real France regression's phantom
      // timeOverlaps: 1 — the filler's recomputed "attraction-scale"
      // duration overshot its actual scheduled end, falsely overlapping the
      // next item even though nothing about the real timeline collided.
      const duration =
        item.category === "practical"
          ? Math.max(item.estimatedDurationMinutes ?? 30, 5)
          : resolveVisitDurationMinutes(item, classifyVisitScale(item));
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

const MEAL_MINIMUM_GAP_MINUTES = 30;
// Same typical clock ranges as slotForClockTime's lunch/dinner buckets
// (country-itinerary-generation.ts) — a meal outside its usual hours isn't
// really "that meal" even if the day happens to have a free block there.
export const LUNCH_WINDOW_MINUTES: [number, number] = [11 * 60, 15 * 60];
export const DINNER_WINDOW_MINUTES: [number, number] = [18 * 60, 20 * 60];

/**
 * Is there genuinely enough slack left in an arrival/departure day's real
 * window to fit this meal (lunch or dinner, by its usual clock range),
 * given what's already scheduled that day? Used by missingMeals (see
 * collectPlanDiagnostics) to decide whether a missing lunch/dinner on day
 * 1 or the last day is a real gap or an unavoidable consequence of the
 * flight schedule.
 *
 * Deliberately checks the day's OWN remaining slack rather than trusting a
 * single fixed reference clock time in isolation — a real bug found
 * during end-to-end QA generation: a fixed "12:30 is fine" reference said
 * lunch was feasible in principle, but the day's OTHER activities pushed
 * the meal's actual scheduled time past the real departure cutoff, so
 * repair's own enforceArrivalDepartureWindow kept stripping it right back
 * out on every pass and missingMeals could never converge, even though
 * the validator thought the meal was fine.
 */
export function hasUsableGapForMeal(
  day: AiGeneratedDay,
  mealWindow: [number, number],
  isArrivalDay: boolean,
  isDepartureDay: boolean,
  window: ArrivalDepartureWindow | null | undefined
): boolean {
  if (!window || (!isArrivalDay && !isDepartureDay)) return true;

  const otherItems = day.items.filter(
    (item) => !NON_ACTIVITY_CATEGORIES.has(item.category) && !isFoodCategory(item.category)
  );
  const [mealEarliest, mealLatest] = mealWindow;

  if (isDepartureDay && window.latestUsableTimeOnDepartureDay) {
    const { date, time } = window.latestUsableTimeOnDepartureDay;
    if (date < day.date) return false;
    if (date === day.date) {
      const cutoffMinutes = parseTimeToMinutes(time);
      if (cutoffMinutes != null) {
        if (cutoffMinutes <= mealEarliest) return false;
        const lastEndMinutes = otherItems.reduce((max, item) => {
          const end =
            (item.endTime ? parseTimeToMinutes(item.endTime) : null) ??
            (parseTimeToMinutes(item.plannedStartTime) ?? 0) + (item.estimatedDurationMinutes ?? 0);
          return Math.max(max, end);
        }, 0);
        const gapStart = Math.max(lastEndMinutes, mealEarliest);
        const gapEnd = Math.min(cutoffMinutes, mealLatest);
        if (gapEnd - gapStart < MEAL_MINIMUM_GAP_MINUTES) return false;
      }
    }
  }

  if (isArrivalDay && window.earliestUsableTimeOnArrivalDay) {
    const { date, time } = window.earliestUsableTimeOnArrivalDay;
    if (date > day.date) return false;
    if (date === day.date) {
      const earliestMinutes = parseTimeToMinutes(time);
      if (earliestMinutes != null) {
        if (earliestMinutes >= mealLatest) return false;
        const firstStartMinutes = otherItems.reduce(
          (min, item) => Math.min(min, parseTimeToMinutes(item.plannedStartTime) ?? min),
          24 * 60
        );
        const gapStart = Math.max(earliestMinutes, mealEarliest);
        const gapEnd = Math.min(firstStartMinutes, mealLatest);
        if (gapEnd - gapStart < MEAL_MINIMUM_GAP_MINUTES) return false;
      }
    }
  }

  return true;
}

export const IDEAL_LOCAL_TRAVEL_MINUTES = 15;
export const MAX_LOCAL_TRAVEL_MINUTES = 25;
/** Food-specific hard caps from the last place before the meal — tighter than the general MAX_LOCAL_TRAVEL_MINUTES, and mode-aware (a restaurant reached on foot must be much closer than one reached by transit/car/taxi). */
export const MEAL_MAX_WALKING_MINUTES = 20;
export const MEAL_MAX_TRAVEL_MINUTES = 45;
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

// deriveDailyCapacityMinutes now lives in trip-workspace.ts (spec
// "DAY-LEVEL POI GEOGRAPHY / LEGALITY" — the deterministic fallback
// template builder there needs the same real capacity number to wire real
// day-trip feasibility into buildLegalDayCandidatePool/
// selectFallbackCandidate, and trip-workspace.ts cannot import from this
// file). Re-exported here so every existing caller of THIS module is
// unaffected.
export { deriveDailyCapacityMinutes } from "../trip-workspace";

// Real bug found via a real 44-day US QA run: duplicateRestaurants,
// foodDominant, and mealSpacingViolations all filtered by isFoodCategory
// alone, so a meal-opportunity placeholder (createFallbackMealPlaceholder —
// no recommendationId, no coordinates, by design: "not a real POI the
// traveler picks from the food tab") got validated as if it were a real
// restaurant. FALLBACK_LUNCH_PHRASES/FALLBACK_DINNER_PHRASES only rotate
// through 3 templates each, so any phase spanning more than 3 days
// mathematically guarantees the same rendered phrase repeats — duplicateRestaurants
// then flagged that as a real repeated restaurant name. The exact same
// real-place test buildPlaceKey already uses (a real place claims either a
// known candidate id or real coordinates) — shared here, not reimplemented,
// so these three checks can never drift from duplicatePlaces' own
// definition of "real."
function isRealPlaceCandidate(item: Pick<AiGeneratedItem, "recommendationId" | "lat" | "lon">): boolean {
  return Boolean(item.recommendationId) || (item.lat != null && item.lon != null);
}

// Spec "SEPARATE NON-PLACE SCHEDULE ITEMS" — the ONE authoritative check
// for "is this a synthetic filler block (meal opportunity / free time /
// transit-practical), never a real POI claim." Reads ScheduleItemRole
// (trip-workspace.ts), set explicitly by every synthetic-item builder at
// creation — never inferred from display text or category. An item with
// no itemRole (built before this field existed, or a genuine
// Gemini-authored real place) is treated as a real place, never
// synthetic — this function only ever narrows, never widens, what counts
// as a real POI claim.
export function isSyntheticScheduleItem(item: Pick<AiGeneratedItem, "itemRole">): boolean {
  return item.itemRole != null && item.itemRole !== "real_place";
}

function isAnchorCategory(category: RecommendationCategory) {
  // Real bug found during end-to-end QA generation: this was a separate,
  // drifted-apart copy of the same "is this a real anchor" check as
  // country-itinerary-generation.ts's isAnchorDayItem, missing the same
  // "practical" exclusion (NON_ACTIVITY_CATEGORIES, defined further below
  // in this file, already treats "practical" as a non-activity category
  // everywhere else). A "practical" item is a free-time/logistics filler,
  // never a genuine anchor — left in, it could make missingAnchorDays too
  // lenient (a day with only a filler item reads as "has an anchor") and
  // skew foodDominant's anchor count.
  return !isFoodCategory(category) && !NON_ACTIVITY_CATEGORIES.has(category);
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
  // Real-POI guard (see isRealPlaceCandidate's own comment): a day full of
  // meal-opportunity placeholders is not "food-dominant" — it has no real
  // food content at all, just as many unfilled slots as anything else.
  const foodItems = orderedItems.filter((item) => isFoodCategory(item.category) && isRealPlaceCandidate(item));
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
    const transportationLabel = current.transportation || day.transportation || "תחבורה מקומית";
    const distanceKm = haversineKm(
      normalizedPrevious.lat,
      normalizedPrevious.lon,
      normalizedCurrent.lat,
      normalizedCurrent.lon
    );
    const estimatedMinutes = estimateTravelMinutes(
      normalizedPrevious.lat,
      normalizedPrevious.lon,
      normalizedCurrent.lat,
      normalizedCurrent.lon,
      pace,
      transportationLabel
    );
    // An AI-stated travelMinutes is trusted only when it's realistically
    // achievable by whatever mode this hop is actually assigned to (spec
    // test 83 — "do not display ~20 minutes if [the] selected mode cannot
    // achieve it"); an implausibly fast claim falls back to the real
    // distance-based estimate instead of being displayed verbatim.
    const segmentMinutes =
      current.travelMinutes != null &&
      !isImplausiblyFastTravelTime(
        distanceKm,
        current.travelMinutes,
        resolveTransportModeFromLabel(transportationLabel, distanceKm)
      )
        ? current.travelMinutes
        : estimatedMinutes;

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

    // findClosestAnchor always estimates on foot, so the walking-specific
    // cap applies here, not the general MAX_LOCAL_TRAVEL_MINUTES (spec: a
    // restaurant reached on foot must be within ~20 minutes, not 25).
    if (closestAnchor.travelMinutes > MEAL_MAX_WALKING_MINUTES) {
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

/**
 * "למה היום מסודר כך" (spec item 96) — a short, content-derived sentence
 * built only from signals already computed by analyzeDayGeography, never
 * invented flavor text unrelated to the actual day.
 */
export function buildDayExplanation(
  day: Pick<AiGeneratedDay, "items">,
  geography: DayGeographyDiagnostics
): string {
  const parts: string[] = [];

  if (geography.isTransferDay) {
    parts.push("היום הוא יום מעבר בין בסיסים, ולכן מרבית הזמן מוקדש לנסיעה עצמה.");
  } else if (geography.longTravelSegments.length === 0 && geography.crossCityItems.length === 0 && geography.clusterLabel) {
    parts.push(`היום מרוכז באזור ${geography.clusterLabel} כדי לצמצם נסיעות מיותרות בין העצירות.`);
  }

  const hasEveningOutdoorActivity = day.items.some(
    (item) =>
      (item.slot === "evening" || item.slot === "night") &&
      classifyWeatherSensitivity(item) === "outdoor"
  );
  if (hasEveningOutdoorActivity) {
    parts.push("הפעילות החיצונית שובצה לקראת הערב כדי לתפוס אור ואווירה נעימה.");
  }

  if (parts.length === 0) {
    parts.push("היום נבנה סביב האטרקציות המרכזיות שנבחרו למסלול.");
  }

  return parts.join(" ");
}

export interface RouteHealthIndicator {
  label: string;
  ok: true;
}

/**
 * Small set of POSITIVE-only indicators (spec item 97 — "do not
 * overwhelm... show small internal-friendly indicators", never a wall of
 * warnings). Only genuinely-true signals are returned; anything wrong is
 * already surfaced elsewhere (day.warnings, the validation engine) rather
 * than duplicated here as a loud red flag. Any signal the caller doesn't
 * actually know (omitted) simply produces no indicator for it, rather than
 * guessing "ok".
 */
export function buildRouteHealthIndicators(input: {
  longTravelSegments: number;
  crossCityItems: number;
  mealSpacingViolations?: number;
  timeOverlaps?: number;
  hotelAverageTravelMinutes?: number | null;
}): RouteHealthIndicator[] {
  const indicators: RouteHealthIndicator[] = [];

  if (input.longTravelSegments === 0 && input.crossCityItems === 0) {
    indicators.push({ label: "מסלול יעיל", ok: true });
  }
  if (input.mealSpacingViolations === 0) {
    indicators.push({ label: "מרווח ארוחות תקין", ok: true });
  }
  if (input.timeOverlaps === 0) {
    indicators.push({ label: "אין התנגשויות", ok: true });
  }
  if (input.hotelAverageTravelMinutes != null && input.hotelAverageTravelMinutes <= IDEAL_LOCAL_TRAVEL_MINUTES) {
    indicators.push({ label: "לינה ממוקמת היטב", ok: true });
  }

  return indicators;
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
    attractions: 0.1,
    shopping: 0.05,
    buffer: 0.1,
  };

  if (preferences.generationMode === "cheapest") {
    allocation.accommodation = 0.32;
    allocation.food = 0.18;
    allocation.transportation = 0.18;
    allocation.attractions = 0.08;
    allocation.shopping = 0.04;
    allocation.buffer = 0.2;
  } else if (preferences.generationMode === "fastest") {
    allocation.transportation = 0.25;
    allocation.accommodation = 0.33;
    allocation.food = 0.18;
    allocation.attractions = 0.09;
    allocation.shopping = 0.05;
    allocation.buffer = 0.1;
  } else if (preferences.generationMode === "relaxed") {
    allocation.accommodation = 0.38;
    allocation.food = 0.2;
    allocation.transportation = 0.16;
    allocation.attractions = 0.09;
    allocation.shopping = 0.05;
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
  if (includesAnyKeyword(interests, ["shopping", "market", "mall", "קניות", "שוק", "קניון"])) {
    allocation.shopping += 0.03;
    allocation.attractions -= 0.02;
    allocation.buffer -= 0.01;
  }

  if (dayCount >= 14) {
    allocation.buffer = Math.max(allocation.buffer, 0.12);
  }

  const total =
    allocation.accommodation +
    allocation.food +
    allocation.transportation +
    allocation.attractions +
    allocation.shopping +
    allocation.buffer;

  return {
    accommodation: allocation.accommodation / total,
    food: allocation.food / total,
    transportation: allocation.transportation / total,
    attractions: allocation.attractions / total,
    shopping: allocation.shopping / total,
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
  const dailyCapacityMinutes = deriveDailyCapacityMinutes(preferences.tripPace);
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
    const derived = { accommodation: 0, food: 0, attractions: 0, transportation: 0, shopping: 0 };
    for (const item of day.items) {
      const price = item.approximatePrice ?? 0;
      if (item.category === "restaurant" || item.category === "cafe") {
        derived.food += price;
      } else if (item.category === "hotel") {
        derived.accommodation += price;
      } else if (item.category === "transportation") {
        derived.transportation += price;
      } else if (item.category === "shopping") {
        derived.shopping += price;
      } else {
        derived.attractions += price;
      }
    }

    // day.activityCost (when present) is a pre-existing day-level total
    // that already includes shopping items' own contribution — spec item
    // 22 wants shopping broken out as its own line, so its share is
    // subtracted back out here rather than double-counted, without
    // needing a new day-level field of its own.
    const groups = {
      accommodation: day.accommodationCost ?? (derived.accommodation > 0 ? derived.accommodation : 0),
      food: day.foodCost ?? (derived.food > 0 ? derived.food : 0),
      attractions:
        day.activityCost != null
          ? Math.max(0, day.activityCost - derived.shopping)
          : derived.attractions > 0
            ? derived.attractions
            : 0,
      transportation: day.transportCost ?? (derived.transportation > 0 ? derived.transportation : 0),
      shopping: derived.shopping,
    };

    const explicitTotal =
      groups.accommodation + groups.food + groups.attractions + groups.transportation + groups.shopping;
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
    // Real root cause found while tracing overloadedDays in live QA: a
    // "practical" item (buildFreeTimeItem, the arrival/departure logistics
    // block, ...) is deliberately given a duration equal to whatever
    // leftover window it fills — often several hours — representing
    // UNSTRUCTURED, low-demand time, the opposite of real planned load.
    // Counting it here meant a day with a few real, entirely reasonable
    // activities plus a generous free-time block could get flagged as
    // "overloaded" purely because the filler's own size was added on top
    // — and fixOverloadedDays would then remove the filler to bring the
    // (miscounted) total back down, only for the next resequencing pass
    // to immediately add a fresh one back (scheduleDayItems always
    // appends one for a genuinely large leftover window), repeating
    // every attempt without ever actually resolving anything.
    if (item.category === "practical") return sum;
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

// normalizePlaceNameSlug/isFuzzyDuplicatePlace/FuzzyPlaceRecord moved to
// trip-workspace.ts (imported above) so the fallback-template candidate
// selection (selectFallbackCandidate, which lives there and cannot import
// from this file — this file already imports FROM trip-workspace.ts) can
// use the exact same fuzzy-duplicate identity this file's own duplicate
// check uses, rather than a second, drifting definition.
export { normalizePlaceNameSlug };

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
      if (
        violatesArrivalDepartureWindow(
          item.plannedStartTime,
          day.date,
          isArrivalDay,
          isDepartureDay,
          window,
          resolveItemEffectiveEndTime(item)
        )
      ) {
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
  arrivalDepartureWindow?: ArrivalDepartureWindow | null,
  flights?: TripFlights | null,
  protectedGeographicConflictDetails: ProtectedGeographicConflict[] = [],
  impossibleStayTransitionDetails: ImpossibleStayTransition[] = [],
  /** Optional real DestinationMobilityProfile — absent (default) means normalDayTravelOutliers stays 0, exactly like every caller before this parameter existed. */
  mobilityProfile: DestinationMobilityProfile | null = null
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
  let normalDayTravelOutliers = 0;
  let foodDominantDays = 0;
  let missingAnchorDays = 0;
  let longMealDetours = 0;
  let baseMismatchDays = 0;
  let timeOverlaps = 0;
  let openingHoursViolations = 0;
  let excessFoodStopsDays = 0;
  let mealSpacingViolations = 0;
  let duplicateRestaurants = 0;
  const invalidFlightLegDetails = detectInvalidFlightLegs(flights);
  const airportBaseMismatchDetails: AirportBaseMismatchDiagnostic[] = [];
  const fixedTimeConflicts: Array<FixedTimeConflict & { dayId: number }> = [];
  const seenMealNames = new Set<string>();
  let currentHighEnergyStreak = 0;
  let maxConsecutiveHighEnergyDays = 0;
  const seenPlaces = new Set<string>();
  const seenFuzzyPlaces: FuzzyPlaceRecord[] = [];
  const matchedMustVisitKeywords = new Set<string>();
  const activityCategoryCounts = new Map<RecommendationCategory, number>();
  let totalCountedActivities = 0;
  const tierCounts = new Map<ActivityTier, number>();
  let totalTierStops = 0;

  const dayCount = plan.days.length;

  for (const day of plan.days) {
    const hasLunch = day.items.some(
      (item) => item.slot === "lunch" && isFoodCategory(item.category)
    );
    const hasDinner = day.items.some(
      (item) => item.slot === "dinner" && isFoodCategory(item.category)
    );

    // Real bug found during end-to-end QA generation: a real departure day
    // (breakfast + checkout + airport transfer, flying home that
    // afternoon) has no realistic dinner — the traveler is in the air or
    // already home by 19:00. This check used to demand both meals on
    // EVERY day unconditionally, so a perfectly realistic departure day
    // kept failing validation on both real Gemini attempts, forcing a
    // fallback to the generic template on essentially every normal-length
    // trip. A meal is only required when the arrival/departure window
    // itself doesn't already rule it out — reusing the exact same
    // violatesArrivalDepartureWindow check the repair/routing side uses,
    // so "is this meal even feasible" never drifts out of sync between
    // validation and repair.
    const isArrivalDay = day.dayNumber === 1;
    const isDepartureDay = day.dayNumber === dayCount;

    if (isArrivalDay && flights?.outbound?.arrivalAirport) {
      const mismatch = detectAirportBaseMismatch("arrival", flights.outbound.arrivalAirport, day.items);
      if (mismatch) airportBaseMismatchDetails.push(mismatch);
    }
    if (isDepartureDay && flights?.return?.departureAirport) {
      const mismatch = detectAirportBaseMismatch("departure", flights.return.departureAirport, day.items);
      if (mismatch) airportBaseMismatchDetails.push(mismatch);
    }

    // Real bug found during end-to-end QA generation (a live France trip):
    // checking a FIXED reference clock time (12:30/19:00) against the
    // window said lunch was feasible in principle, but the day's OTHER
    // activities pushed the meal's actual scheduled time past the real
    // cutoff — repair's own enforceArrivalDepartureWindow then (correctly)
    // stripped it again on every pass, so missingMeals could never
    // converge even though the validator thought the meal was fine. This
    // checks the day's REAL remaining slack against the window instead of
    // a generic reference time — the same question repair itself is
    // implicitly answering when it strips (or keeps) an inserted meal.
    const windowAllowsLunch = hasUsableGapForMeal(day, LUNCH_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);
    const windowAllowsDinner = hasUsableGapForMeal(day, DINNER_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);

    // Real bug found during end-to-end QA generation (a live France trip
    // with Disneyland Paris): resequenceDayItems deliberately drops both
    // meals from a day with a genuine full-day anchor (Disneyland, a
    // national park, ...) — spec item 12: "Do not add Louvre or Eiffel
    // Tower afterward" applies to meals too, since a full-day attraction
    // already includes food on-site. This check had no matching exemption,
    // so repair's intentional omission kept getting immediately re-flagged
    // as missingMeals, and — because the same repair step re-runs
    // resequenceDayItems on its own output — any freshly re-inserted meal
    // placeholder got silently dropped again on the next pass, leaving
    // missingMeals permanently non-zero and forcing a fallback to the
    // generic template on any trip with a real full-day attraction.
    const hasFullDayAnchor = day.items.some(
      (item) => isAnchorCategory(item.category) && classifyVisitScale(item) === "full_day"
    );
    const lunchIsFeasible = windowAllowsLunch && !hasFullDayAnchor;
    const dinnerIsFeasible = windowAllowsDinner && !hasFullDayAnchor;

    if (!hasLunch && lunchIsFeasible) missingMeals += 1;
    if (!hasDinner && dinnerIsFeasible) missingMeals += 1;

    // At most two dedicated food stops per day (spec item 37) — breakfast
    // is assumed near the hotel and never scheduled as its own item (this
    // app's DayPart has no "breakfast" slot), so any food-category item
    // beyond the normal lunch+dinner pair is an extra.
    const dayFoodItems = day.items.filter((item) => isFoodCategory(item.category));
    if (dayFoodItems.length > 2) {
      excessFoodStopsDays += 1;
    }

    // Real-POI guard (isRealPlaceCandidate) — spacing between two
    // meal-opportunity placeholders (or a placeholder and a real meal) is
    // meaningless; only two real, identifiable food stops can genuinely be
    // "too close together."
    const realDayFoodItems = dayFoodItems.filter(isRealPlaceCandidate);

    // Minimum spacing between consecutive food stops (spec item 39) —
    // lunch→dinner needs 4h+, anything else (e.g. an extra cafe) needs 3h+.
    const orderedFoodItems = sortItemsBySchedule(realDayFoodItems);
    for (let index = 1; index < orderedFoodItems.length; index += 1) {
      const previousMeal = orderedFoodItems[index - 1];
      const currentMeal = orderedFoodItems[index];
      const previousMinutes = parseTimeToMinutes(previousMeal.plannedStartTime);
      const currentMinutes = parseTimeToMinutes(currentMeal.plannedStartTime);
      if (previousMinutes == null || currentMinutes == null) continue;
      const minimumGap = previousMeal.slot === "lunch" && currentMeal.slot === "dinner" ? 240 : 180;
      if (currentMinutes - previousMinutes < minimumGap) {
        mealSpacingViolations += 1;
      }
    }

    // Trip-wide repeated restaurant/cafe name (spec item 42) — a defensive
    // backstop counted here regardless of how the name got repeated,
    // separate from pickNearbyMealRecommendation's own hard exclusion at
    // generation time. Real-POI guard (isRealPlaceCandidate, via
    // realDayFoodItems): a repeated meal-opportunity phrase (guaranteed by
    // FALLBACK_LUNCH_PHRASES/FALLBACK_DINNER_PHRASES only rotating 3
    // templates each) is not a repeated restaurant.
    for (const item of realDayFoodItems) {
      const nameKey = item.name.trim().toLowerCase();
      if (!nameKey) continue;
      if (seenMealNames.has(nameKey)) {
        duplicateRestaurants += 1;
      } else {
        seenMealNames.add(nameKey);
      }
    }

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
    for (const conflict of findFixedTimeConflicts(day.items)) {
      fixedTimeConflicts.push({ ...conflict, dayId: day.dayNumber });
    }
    invalidCoordinates += geography.invalidCoordinateItems.length;
    if (geography.crossCityItems.length > 0) {
      crossCityDays += 1;
    }
    // Section J: a transfer day's intercity travel is expected and already
    // modeled elsewhere (stay transitions); a genuine day trip's long
    // outbound/return travel is equally intentional — same reasoning
    // analyzeDayGeography's own skipCrossCityChecks already applies to
    // longTravelSegments/crossCityItems, but this NORMAL-day-only rule had
    // drifted to only exclude transfer days, not day trips too. A real bug:
    // a genuine day trip (e.g. a mountain excursion with several hours of
    // real round-trip travel) was flagged exactly like an unexpected long
    // detour on an ordinary day, the one distinction spec §J requires.
    if (
      !geography.isTransferDay &&
      !isDayTripDay(day) &&
      (geography.totalTravelMinutes > MAX_NORMAL_DAY_TRAVEL_MINUTES ||
        geography.longTravelSegments.some((segment) => segment.minutes > 45))
    ) {
      longTravelDays += 1;
    }
    // Spec "MAKE TRAVEL METRICS ACTUALLY ACTIVE" — a real, mobility-
    // profile-aware check alongside longTravelDays' fixed-constant one:
    // a day can be under MAX_NORMAL_DAY_TRAVEL_MINUTES/45min overall and
    // still have one segment that's genuinely excessive for THIS
    // destination's own real travel budget (e.g. a compact destination
    // where even 40 minutes is an outlier). Same day-trip/transfer
    // exemption as longTravelDays.
    if (
      mobilityProfile &&
      !geography.isTransferDay &&
      !isDayTripDay(day) &&
      day.items.some((item) => item.travelMinutes != null && item.travelMinutes > mobilityProfile.normalDayTravelBudgetMinutes)
    ) {
      normalDayTravelOutliers += 1;
    }
    if (geography.foodDominant) {
      foodDominantDays += 1;
    }
    // Real bug found during end-to-end QA generation (a live Greece trip
    // with a 10:40 departure): a severely flight-constrained arrival/
    // departure day can legitimately have nothing but checkout/transfer
    // logistics — no real sightseeing anchor AND no meal either — same
    // reasoning as the meal exemption above. Narrowly targeted at exactly
    // that "purely logistics, nothing else fits" composition (not every
    // arrival/departure day) so a normal arrival/departure day with real
    // time to spare still correctly requires an anchor.
    const isPureLogisticsArrivalOrDeparture =
      (isArrivalDay || isDepartureDay) && geography.foodStopCount === 0;
    if (!geography.isTransferDay && !isPureLogisticsArrivalOrDeparture && geography.anchorStopCount === 0) {
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
      const isRealPlace = isRealPlaceCandidate(item);
      const fuzzyRecord: FuzzyPlaceRecord = { nameSlug: normalizePlaceNameSlug(item.name), lat: item.lat, lon: item.lon };
      const exactMatch = seenPlaces.has(key);
      const fuzzyMatch = isRealPlace ? seenFuzzyPlaces.find((seen) => isFuzzyDuplicatePlace(seen, fuzzyRecord)) : undefined;
      const isDuplicate = exactMatch || Boolean(fuzzyMatch);
      if (isDuplicate) {
        // QA-gated (hygiene pass — this used to fire on every non-production
        // request instead of only a deliberate QA run) — real evidence for
        // whichever specific pair is still slipping through, since this
        // can't be reproduced against real production-scale candidate data
        // in a synthetic test.
        if (isPlannerQaTraceEnabled()) {
          console.log("[collectPlanDiagnostics] duplicatePlaces", {
            day: day.dayNumber,
            matchType: exactMatch ? "exact-key" : "fuzzy-name-coords",
            item: { name: item.name, category: item.category, recommendationId: item.recommendationId, lat: item.lat, lon: item.lon, key },
            matchedAgainst: fuzzyMatch ?? null,
          });
        }
        // Spec "DUPLICATE FORENSIC REPORT" — "this is the most important
        // requirement." `key` here is byte-identical in format to
        // computeCanonicalPlaceIdentity's own `identity` string (both
        // `id:${recommendationId}` and `coords:${lat}:${lon}:${name}` are
        // the exact same construction), so an exact-key duplicate's trace
        // history is always found this way. A fuzzy-name-coords duplicate
        // (matchedAgainst a DIFFERENT key) is a real, separate case this
        // lookup cannot resolve — buildPlaceKey's own coordinate rounding
        // means two near-identical-but-not-identical keys never collide
        // here; disclosed as a known gap rather than silently missed.
        if (isPlannerQaTraceEnabled()) {
          const reports = buildDuplicateTraceReports(key);
          if (reports.length > 0) {
            for (const report of reports) {
              console.log(formatDuplicateTraceReport(report));
            }
          } else {
            console.log("[DuplicateTrace] no insertion-trace history found for this duplicate's key", {
              key,
              matchType: exactMatch ? "exact-key" : "fuzzy-name-coords",
              note:
                exactMatch
                  ? "an exact-key duplicate with no trace history means the place was inserted by a code path not yet instrumented with tracePlaceInsertion"
                  : "a fuzzy-name-coords duplicate matches a DIFFERENT canonical key than this item's own — buildDuplicateTraceReports only looks up exact-key history, so this case is a known observability gap, not a bug in the trace itself",
            });
          }
        }
        duplicatePlaces += 1;
      } else {
        seenPlaces.add(key);
        if (isRealPlace) seenFuzzyPlaces.push(fuzzyRecord);
      }

       if (isAvoidedByProfile(item, profile)) {
        avoidConflicts += 1;
      }

      if (violatesOpeningHours(item)) {
        openingHoursViolations += 1;
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
    normalDayTravelOutliers,
    foodDominantDays,
    missingAnchorDays,
    longMealDetours,
    maxConsecutiveHighEnergyDays,
    highEnergyRhythmViolation: maxConsecutiveHighEnergyDays > MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
    baseMismatchDays,
    activityMixSkew,
    arrivalDepartureWindowViolations: countArrivalDepartureWindowViolations(plan, arrivalDepartureWindow),
    fixedTimeConflicts,
    timeOverlaps,
    openingHoursViolations,
    excessFoodStopsDays,
    mealSpacingViolations,
    duplicateRestaurants,
    invalidFlightLegs: invalidFlightLegDetails.length,
    invalidFlightLegDetails,
    airportBaseMismatches: airportBaseMismatchDetails.length,
    airportBaseMismatchDetails,
    protectedGeographicConflicts: protectedGeographicConflictDetails.length,
    protectedGeographicConflictDetails,
    impossibleStayTransitions: impossibleStayTransitionDetails.length,
    impossibleStayTransitionDetails,
  };
}

/**
 * A single 0-100 internal quality score (spec item 81) — no such number
 * exists anywhere in the codebase today; everything below repairPlan's own
 * pass/fail gate (passesValidation) is a plain boolean AND. Deducts a fixed
 * weight per non-zero diagnostic, grouped the way the spec itself groups
 * them (geography / timing / budget / variety / duplicates), floored at 0.
 * A plan can pass passesValidation (every hard gate at zero) yet still
 * score under 100 on the advisory-only signals (activityMixSkew,
 * dominantCategoryShare) — this score exists specifically to catch that
 * gap and push one more diversify pass when there's still an attempt left
 * (see repairPlan).
 */
export function computeQualityScore(diagnostics: PlanDiagnostics): number {
  let score = 100;

  // Geography.
  score -= diagnostics.crossCityDays * 8;
  score -= diagnostics.longTravelDays * 5;
  score -= diagnostics.longMealDetours * 4;
  score -= diagnostics.foodDominantDays * 4;
  score -= diagnostics.missingAnchorDays * 4;
  score -= diagnostics.baseMismatchDays * 5;

  // Timing.
  score -= diagnostics.arrivalDepartureWindowViolations * 6;
  score -= diagnostics.timeOverlaps * 6;
  score -= diagnostics.openingHoursViolations * 8;
  score -= diagnostics.mealSpacingViolations * 3;

  // Budget.
  if (diagnostics.outOfBudget) score -= 15;
  if (diagnostics.overSoftBudget) score -= 6;

  // Variety / nature balance.
  if (diagnostics.diversityRisk) score -= 12;
  score -= diagnostics.activityMixSkew.length * 3;

  // Duplicates.
  score -= diagnostics.duplicatePlaces * 6;
  score -= diagnostics.duplicateRestaurants * 4;
  score -= diagnostics.excessFoodStopsDays * 3;

  return Math.max(0, Math.round(score));
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
