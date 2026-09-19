import { GoogleGenAI, Type } from "@google/genai";

/**
 * Structured progress/failure logging for the generation pipeline (never
 * logs secrets/full payloads). Hygiene pass — this used to gate on
 * `NODE_ENV !== "production"` alone, so a plain `npm run dev` trip
 * generation printed dozens of these lines with no way to turn them off.
 * Gated behind the same QA/debug flags every other generation-time
 * diagnostic in this file already uses (QA_DEBUG_GEOGRAPHY, CAPTURE_FIXTURES,
 * PLANNER_QA_TRACE) — silent by default, still available for a deliberate
 * QA run.
 */
function logGenerationStage(message: string, details?: Record<string, unknown>) {
  if (!isPlannerQaTraceEnabled()) return;
  if (details) {
    console.log(`[Itinerary] ${message}`, details);
  } else {
    console.log(`[Itinerary] ${message}`);
  }
}

/**
 * Thrown when the generator (both Gemini attempts, then the deterministic
 * fallback) genuinely cannot produce a plan that satisfies validation —
 * a real "this request can't be fulfilled as configured" outcome, distinct
 * from an unexpected server error. The API route maps this to 422, not 500.
 */
export class ItineraryGenerationInfeasibleError extends Error {
  code: "PLAN_NOT_FEASIBLE" | "BUDGET_NOT_FEASIBLE";

  constructor(code: "PLAN_NOT_FEASIBLE" | "BUDGET_NOT_FEASIBLE", message: string) {
    super(message);
    this.name = "ItineraryGenerationInfeasibleError";
    this.code = code;
  }
}

/** Round 9.1 §16/§17/§26 — per-stay detail inside a PlannerFailureSummary/InsufficientRealActivitySupplyError. */
export interface StayFailureDetail {
  stayId: string;
  owner: string;
  requiredRealActivities: number;
  desiredCandidates: number;
  legalCandidates: number;
  providerRequests: number;
  providerFailures: number;
  supplyDegraded: boolean;
  /** True when this stay's own legalCandidates fell below its minimumViableCandidateCount — the actual SUPPLY-failure signal (spec §16), never the healthy-reserve target. */
  belowMinimum: boolean;
  /**
   * Round 9.3.3 continuation §6 — the three-way distinction the round
   * requires, kept separate from `belowMinimum` (which only says THAT a
   * stay is short, not WHY): HEALTHY_SUPPLY (met its minimum),
   * TRUE_LOW_SUPPLY (below minimum, but the provider genuinely responded —
   * `providerFailures === 0` — so the destination itself is just sparse),
   * or PROVIDER_FAILURE (below minimum AND at least one real provider
   * outage/timeout occurred — this round's own OverpassProviderFailureError
   * fix is what makes `providerFailures` a trustworthy signal here rather
   * than silently indistinguishable from zero real candidates).
   */
  supplyState: "HEALTHY_SUPPLY" | "TRUE_LOW_SUPPLY" | "PROVIDER_FAILURE";
}

function classifyStaySupplyState(stay: {
  belowMinimum: boolean;
  providerFailures: number;
}): "HEALTHY_SUPPLY" | "TRUE_LOW_SUPPLY" | "PROVIDER_FAILURE" {
  if (!stay.belowMinimum) return "HEALTHY_SUPPLY";
  return stay.providerFailures > 0 ? "PROVIDER_FAILURE" : "TRUE_LOW_SUPPLY";
}

/**
 * Round 9.3.3 continuation §7 — thrown ONLY for a genuinely CATASTROPHIC
 * provider-infrastructure failure on a multi-day stay: zero real
 * candidates collected, on a stay that genuinely needed real content, AND
 * at least one real provider outage/timeout actually occurred (never
 * merely a destination with few real POIs — that stays
 * InsufficientRealActivitySupplyError/TRUE_LOW_SUPPLY, unchanged). Kept
 * distinct from PLAN_NOT_FEASIBLE/BUDGET_NOT_FEASIBLE/a Gemini failure so
 * a caller can tell "the destination is just quiet" apart from "our own
 * provider infrastructure was unavailable" — the API must never disguise
 * the second as a normal successful (mostly-FreeTime) itinerary.
 */
export class RealPlaceDiscoveryUnavailableError extends Error {
  readonly code = "REAL_PLACE_DISCOVERY_UNAVAILABLE" as const;
  readonly stayFailures: StayFailureDetail[];

  constructor(message: string, stayFailures: StayFailureDetail[]) {
    super(message);
    this.name = "RealPlaceDiscoveryUnavailableError";
    this.stayFailures = stayFailures;
  }
}

/**
 * Round 9.4.2 §G — the "regression firewall", never a substitute for
 * fixing the fallback itself (spec: "This is not a substitute for fixing
 * fallback"). A DIRECT, non-ratio-based hard gate: a non-trivial real
 * candidate pool existed and the FINAL itinerary has literally zero
 * scheduled real activities. Kept distinct from
 * InsufficientRealActivityCoverageError (a ratio/majority-based judgment
 * call that can have edge cases where it doesn't fire — exactly what let
 * the proven production bug reach persistence undetected) — this one
 * fires on the unambiguous, unconditional shape alone.
 */
export class RealPlaceContentLostError extends Error {
  readonly code = "REAL_PLACE_CONTENT_LOST" as const;
  readonly diagnostics: {
    totalRealActivityCandidates: number;
    finalRealActivities: number;
    normalDayCount: number;
    fallbackUsed: boolean;
    perStay?: StayCoverageSummary[];
  };

  constructor(message: string, diagnostics: RealPlaceContentLostError["diagnostics"]) {
    super(message);
    this.name = "RealPlaceContentLostError";
    this.diagnostics = diagnostics;
  }
}

/** Round 9.4.3 §C/§J — one real place occupying one scheduled slot, identified by its authoritative recommendationId. */
export interface RealPlaceDuplicateOccurrence {
  dayNumber: number;
  phaseId: string | null;
  category: RecommendationCategory;
}

/** Round 9.4.3 §C/§J — a single real place (by recommendationId) found scheduled more than once across the final itinerary. */
export interface RealPlaceDuplicateGroup {
  recommendationId: string;
  name: string;
  occurrences: RealPlaceDuplicateOccurrence[];
}

/**
 * Round 9.4.3 §J — the final duplicate firewall. Proven production trace
 * (gen-mu7kn7ef-s9cg5z4x): the same real recommendationId (e.g. "Harvard
 * Club of Boston") removed, restored, and reassigned across repair
 * attempts, with duplicatePlaces never reaching 0 — every attempt then
 * fails passesValidation, cascading all the way to a generic
 * PLAN_NOT_FEASIBLE / "לא הצלחנו להסיר כפילויות" with no indication of
 * WHICH place or WHY. This is a regression firewall, not the primary fix
 * (resolveExactIdDuplicates + the phase-aware repairCrossRegionDayContent
 * fix below are the primary fix) — it exists so that if a real-place
 * duplicate ever DOES survive to a would-be-successful return, the caller
 * gets the exact identity instead of a generic failure.
 */
export class RealPlaceDuplicatesRemainError extends Error {
  readonly code = "REAL_PLACE_DUPLICATES_REMAIN" as const;
  readonly diagnostics: {
    duplicateCount: number;
    duplicates: RealPlaceDuplicateGroup[];
  };

  constructor(message: string, diagnostics: RealPlaceDuplicatesRemainError["diagnostics"]) {
    super(message);
    this.name = "RealPlaceDuplicatesRemainError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Round 9.1 §16/§17 — thrown ONLY when the root cause is genuinely
 * insufficient real-candidate SUPPLY (a stay's own legal pool fell below
 * its minimum-viable floor after discovery + bounded refill), never for a
 * planner/quality problem (duplicates, geography, diversity) with a
 * healthy supply — that stays PLAN_NOT_FEASIBLE, a DIFFERENT code (spec
 * §17: "do not use the same error code"). The API route maps this to its
 * own 422 body, distinct from generic PLAN_NOT_FEASIBLE.
 */
export class InsufficientRealActivitySupplyError extends Error {
  readonly code = "INSUFFICIENT_REAL_ACTIVITY_SUPPLY" as const;
  readonly stayFailures: StayFailureDetail[];

  constructor(message: string, stayFailures: StayFailureDetail[]) {
    super(message);
    this.name = "InsufficientRealActivitySupplyError";
    this.stayFailures = stayFailures;
  }
}

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { estimateMinutesForMode, selectTransportMode, type TransportMode } from "@/lib/transport-mode";
import countryFactsData from "@/lib/facts/country-facts-data.json";
import { findAirportByIata } from "@/lib/facts/airports-data";
import {
  computeArrivalDepartureWindow,
  describeArrivalDepartureWindow,
  flightCostExpenses,
  violatesArrivalDepartureWindow,
  type ArrivalDepartureWindow,
} from "@/lib/flight-planning";
import {
  analyzeDayGeography,
  buildGenerationSummary,
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  computeQualityScore,
  deriveDailyCapacityMinutes,
  DINNER_WINDOW_MINUTES,
  findFramePhaseForDay,
  hasUsableGapForMeal,
  IDEAL_LOCAL_TRAVEL_MINUTES,
  isIntercityTransferDay,
  getBudgetCapForItem,
  LUNCH_WINDOW_MINUTES,
  MAX_LOCAL_TRAVEL_MINUTES,
  MAX_NORMAL_DAY_TRAVEL_MINUTES,
  MEAL_MAX_TRAVEL_MINUTES,
  MEAL_MAX_WALKING_MINUTES,
  isDayTripDay,
  isStructuralRoundTripDay,
  isSyntheticScheduleItem,
  isPremiumVenue,
  NON_ACTIVITY_CATEGORIES,
  normalizeCoordinatePair,
  normalizeActionableMessages,
  normalizePlaceNameSlug,
  scoreRouteProximity,
  scoreBudgetFitness,
  summarizeItemCosts,
  withNormalizedRecommendationPrice,
  type ExchangeRateContext,
  type ImpossibleStayTransition,
  type PlanDiagnostics,
  type ProtectedGeographicConflict,
  type TripFrame,
  type TripFramePhase,
  type TripPreferenceProfile,
} from "@/lib/server/itinerary-generation-constraints";
import {
  buildTripFramePhases,
  classifyActivityTier,
  classifyItemEnergy,
  classifyVisitScale,
  classifyWeatherSensitivity,
  getTripLengthBucket,
  TRIP_LENGTH_BUCKETS,
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
  MAX_STAY_STRUCTURE_REPAIR_PASSES,
  describeActivityMixTargets,
  applyShortStayViabilityRepair,
  buildStayTransitions,
  repairImpossibleStayTransition,
  optimizeStayRouteSequence,
  verifyStayRouteInvariants,
  scoreStayRoute,
  type StayRouteNode,
  type TripFrameDayTripHint,
  type TripFramePlanningTrace,
  resolveItemEffectiveEndTime,
  resolveVisitDurationMinutes,
  type StayTransition,
} from "@/lib/server/itinerary-planning-principles";
import {
  clusterActivityCandidates,
  computeDayTripClusterFeasibility,
  computeItineraryTravelMetrics,
  decideClusterRole,
  evaluateCluster,
  evaluateDayTripFeasibility,
  evaluateTransferDetourFeasibility,
  type ActivityCluster,
} from "@/lib/server/route-optimization";
import {
  clockToMinutes,
  DEFAULT_DAY_WINDOW,
  minutesToClock,
  scheduleDayItems,
  type FixedTimeConflict,
} from "@/lib/server/itinerary-scheduler";
import {
  isPlannerQaTraceEnabled,
  tracePlaceInsertion,
  computeCanonicalPlaceIdentity,
  findInsertionsByIdentity,
  getPoolStageLogs,
  classifyPoolExhaustionReasons,
  type PlaceInsertionSource,
} from "@/lib/planner-qa-trace";
import {
  logRealPlaceQA,
  logRealPlaceQACompact,
  diffRealActivitySnapshots,
  logRepairStepDelta,
  logRepairAttemptStart,
  logRepairAttemptEnd,
  logRepairRoundTrip,
  type RealActivityIdentitySnapshot,
  type RepairSnapshotItem,
} from "@/lib/server/real-place-qa";
import { describeHolidayContext } from "@/lib/facts/jewish-holidays";
import { getOverpassCallStats, queryNearbyRecommendationsDetailed, type OverpassNearbyRecommendation as OverpassGroupCandidate } from "@/lib/places/overpass";
import type { GenerationProgressReporter } from "@/lib/server/generation-progress";
import { fetchDrivingRouteBestEffort } from "@/lib/routing/osrm-server";
import {
  captureGeminiFixture,
  captureGeoResolutionFixture,
  captureOverpassStatsFixture,
  isFixtureCaptureEnabled,
  startFixtureCaptureSession,
  type GeoResolutionFixtureEntry,
} from "@/lib/server/fixture-capture";
import {
  parseOpeningHours,
  evaluateOpeningHoursLegality,
  isKnownHoursViolation,
  resolveLastEntryMinutes,
  parseOpeningHoursWindow,
  type OpeningHoursLegalityStatus,
} from "./opening-hours";
import {
  computeStayCapacity,
  assignCandidatesToStays,
  buildStayActivityPool,
  refillStayActivityPool,
  buildTripActivityPortfolios,
  computeRecencyPenalty,
  estimateDayActivityTarget,
  acceptRawCandidatesIntoPool,
  acceptRawMealCandidates,
  classifyQueryGroupOutcome,
  orderActivityQueryGroupsByPreference,
  MEAL_QUERY_GROUP,
  ACTIVITY_DISCOVERY_RADIUS_CAP_KM,
  computeDesiredCandidateCount,
  computeMinimumViableCandidateCount,
  type StayDayCapacityInput,
  type StayActivityPool,
  type StayActivityPortfolio,
  type StayActivityPoolCandidate,
  type RecentActivityHistoryEntry,
  type RefillOptions,
  type ActivityQueryGroupDefinition,
  type QueryGroupResult,
  type QueryGroupOutcome,
} from "@/lib/server/stay-activity-pool";
import {
  classifyActivity,
  determinePlanningRole,
  type ActivityFamily,
  type ActivitySubtype,
} from "@/lib/server/activity-taxonomy";
import {
  classifyMealVenue,
  buildCuisinePreferenceWeights,
  CUISINE_FAMILIES,
  type CuisineFamily,
  type MealType,
} from "@/lib/server/meal-cuisine-taxonomy";
import {
  computeMealCuisineRecencyPenalty,
  selectMealVenueFromPool,
  buildTripMealVenuePools,
  buildStayMealVenuePool,
  RECENT_MEAL_HISTORY_DECAY_DAYS,
  type RecentMealHistoryEntry,
  type StayMealVenuePool,
} from "@/lib/server/stay-meal-venue-pool";
import {
  resolveStaySkeleton,
  dedupeResolvedStays,
  deterministicFallbackSkeleton,
  buildSingleBaseFallbackProposal,
  validateTripStaySkeleton,
  buildTripFrameFromResolvedStays,
  reallocateNightsAfterDiscovery,
  rankReserveStaysForPromotion,
  decideReservePromotion,
  applyReservePromotion,
  computeStayValueProfile,
  allocateNightsByMarginalValue,
  type ProposedStay,
  type ResolvedStay,
  type StaySkeletonSource,
  type StaySkeletonFrame,
} from "@/lib/server/trip-stay-skeleton";
import {
  buildFallbackAiItinerary,
  buildMapLink,
  buildWarnings,
  createEmptyItineraryItem,
  dateForDayNumber,
  estimateTravelMinutes,
  CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM,
  computeDestinationMobilityProfile,
  getTripDayCount,
  haversineKm,
  isCandidateGeographicallyCompatibleWithDay,
  evaluateScheduledPlaceLegality,
  type ScheduledPlaceLegalityRule,
  FUZZY_DUPLICATE_MAX_KM,
  isFuzzyDuplicatePlace,
  isMealOpportunityMarker,
  ITINERARY_GENERATION_MODE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  createItineraryUsageState,
  buildItineraryUsageState,
  registerItineraryUsage,
  releaseItineraryUsage,
  isItineraryPlaceUsed,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryRequest,
  type AiItineraryResponse,
  type DayPart,
  type DestinationMobilityProfile,
  type FuzzyPlaceRecord,
  type ItemPriority,
  type ItineraryUsageState,
  type RecommendationCategory,
  type TripItineraryDay,
  type TripFlights,
  type TripItineraryItem,
  type TripPreferences,
  type TripRecommendation,
} from "@/lib/trip-workspace";

export const ITINERARY_MODEL = "gemini-flash-lite-latest";

interface RawCountryFactsRecord {
  currencies?: Array<{ code?: string }>;
}

export interface RawGeneratedItem {
  name: string;
  category: string;
  location: string;
  shortDescription: string;
  slot: string;
  plannedStartTime: string;
  estimatedDurationMinutes?: number;
  /** Price PER PERSON, in local currency — resolveItemPriceFields multiplies by traveler count to get the group total. Never a pre-multiplied total. */
  approximatePrice?: number;
  travelMinutes?: number;
  openingHours?: string;
  /** Last entry time in HH:mm, only when known and distinct from the closing time — never fabricated from openingHours. */
  lastEntryTime?: string;
  reservationRequired?: boolean;
  transportation?: string;
  bookingWarning?: string;
  alternativeSuggestion?: string;
}

export interface RawGeneratedDay {
  dayNumber: number;
  date: string;
  title: string;
  cityRegion: string;
  accommodation: string;
  notes: string;
  transportation: string;
  estimatedCost?: number;
  activityCost?: number;
  foodCost?: number;
  transportCost?: number;
  accommodationCost?: number;
  totalTravelMinutes?: number;
  warnings?: string[];
  alternatives?: string[];
  bookingRequirements?: string[];
  safetyNotes?: string[];
  restWindow?: string;
  transportSegments?: string[];
  items: RawGeneratedItem[];
}

export interface RawGeneratedPlan {
  title: string;
  summary: string;
  totalEstimatedCost?: number;
  estimatedTransportCost?: number;
  averageDailyCost?: number;
  costPerTraveler?: number;
  categoryBreakdown?: Record<string, number>;
  days: RawGeneratedDay[];
}

// Phase 11/26 (generic worldwide architecture): a real, explicit answer to
// "which path actually produced this plan" — never inferred by the caller
// from usedFallback alone. "gemini_repaired" (not plain "gemini") is
// deliberate: repairPlan's normalization/repair machinery always runs on
// real Gemini output before it's accepted, so there is no "raw, untouched
// Gemini" path to report separately from it.
export type ItineraryGenerationSource = "gemini_repaired" | "fallback_template" | "portfolio_composed" | "portfolio_composed_soft_checkpoint";

/**
 * Distinguishes "the candidate provider was unreachable" from "the plan is
 * genuinely infeasible" (spec §H) — never exposes the raw fetch error, just
 * whether real candidates came back. "partial" is intentionally unused for
 * now (no honest signal distinguishes it from "available" with this
 * pipeline's current data) rather than guessed.
 */
export interface CandidateProviderStatus {
  overpass: "available" | "unavailable" | "partial";
  gemini: "used" | "not_used";
}

export interface GeneratedCountryItineraryPlan extends AiItineraryResponse {
  model: string;
  usedFallback: boolean;
  generationSource: ItineraryGenerationSource;
  candidateProviderStatus: CandidateProviderStatus;
}

/**
 * Section H — prefers the REAL provider result when the caller supplied one
 * (payload.overpassAvailable, from its own fetch or
 * places/overpass.ts's checkOverpassAvailability), never inferring success
 * from candidate count alone: a manually-injected candidate (e.g. this
 * app's own QA harness, or a future "add a place manually" feature) would
 * otherwise make Overpass look "available" even when the real request
 * failed. Falls back to the candidate-count heuristic only when the caller
 * genuinely doesn't know — disclosed as an imprecise fallback, not a fix.
 */
export function resolveCandidateProviderStatus(payload: AiItineraryRequest): CandidateProviderStatus {
  const overpass: CandidateProviderStatus["overpass"] =
    payload.overpassAvailable ?? (payload.recommendations.length > 0 ? "available" : "unavailable");
  return { overpass, gemini: "used" };
}

// Round 9.3.6.1 §8/§11 — "practical" (the free-time/logistics filler
// category buildFreeTimeItem assigns, explicitly excluded from
// calculateDayLoadMinutes and isScheduledRealPlace elsewhere in this file)
// was MISSING from this set despite being a real member of
// RecommendationCategory. normalizeCategory falls through to "attraction"
// for anything not in this set — so every time a composed plan's items
// round-tripped through toRawGeneratedPlan (RawGeneratedItem has no
// itemRole field at all) and back through repairPlan's own enrichAiDay
// ingestion (the ACTUAL production path for every composed-portfolio
// generation, per the repairPlan(toRawGeneratedPlan(composed.plan), ...)
// call), a free-time filler silently became a fake "attraction" — with
// its own often-400+-minute duration now counted as real activity load
// (calculateDayLoadMinutes's "practical" exclusion no longer matched) and
// no remaining structural signal (itemRole is gone; category no longer
// says "practical") to tell it apart from a genuine real POI. Proven via
// a deterministic 7-stay reproduction: fixOverloadedDays, unable to tell
// the miscategorized filler apart from real content, evicted real,
// verified POIs alongside it to bring the (falsely inflated) day load
// back under capacity — exactly the "real supply existed, day still ended
// up zero-real" shape reported in production.
const CATEGORY_VALUES = new Set<RecommendationCategory>([
  "attraction",
  "restaurant",
  "cafe",
  "museum",
  "nature",
  "shopping",
  "nightlife",
  "family",
  "hidden_gem",
  "day_trip",
  "seasonal_event",
  "hotel",
  "transportation",
  "practical",
]);

const SLOT_VALUES = new Set<DayPart>(["morning", "lunch", "afternoon", "dinner", "evening", "night"]);
const SLOT_ORDER: DayPart[] = ["morning", "lunch", "afternoon", "dinner", "evening", "night"];
const FOOD_CATEGORIES = new Set<RecommendationCategory>(["restaurant", "cafe"]);
/** Round 9.2.1 — neutral cuisine-weight default (every family = 1) for callers that haven't computed the trip's own preference-derived weights. */
const EMPTY_CUISINE_WEIGHTS: Record<CuisineFamily, number> = Object.fromEntries(CUISINE_FAMILIES.map((family) => [family, 1])) as Record<CuisineFamily, number>;
const FALLBACK_RATE_TO_ILS: Record<string, number> = {
  USD: 3.45,
  EUR: 3.98,
  GBP: 4.62,
  JPY: 0.023,
  CAD: 2.51,
  AUD: 2.27,
  CHF: 4.19,
  CNY: 0.48,
  KRW: 0.0026,
  INR: 0.041,
  BRL: 0.64,
  EGP: 0.07,
  THB: 0.098,
  TRY: 0.086,
};

function stringField(description: string) {
  return { type: Type.STRING, description };
}

function numberField(description: string) {
  return { type: Type.NUMBER, description };
}

function stringArrayField(description: string, itemDescription: string) {
  return {
    type: Type.ARRAY,
    description,
    items: stringField(itemDescription),
  };
}

const ITINERARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: stringField("A short itinerary title in Hebrew."),
    summary: stringField("A concise planning summary in Hebrew."),
    totalEstimatedCost: numberField("Estimated total trip cost."),
    estimatedTransportCost: numberField("Estimated transport cost for the full trip."),
    averageDailyCost: numberField("Estimated average daily cost."),
    costPerTraveler: numberField("Estimated cost per traveler."),
    categoryBreakdown: {
      type: Type.OBJECT,
      properties: {
        attractions: numberField("Estimated attraction cost."),
        food: numberField("Estimated food cost."),
        transportation: numberField("Estimated transportation cost."),
        accommodation: numberField("Estimated accommodation cost."),
        other: numberField("Estimated other costs."),
      },
    },
    days: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          dayNumber: numberField("Day number starting at 1."),
          date: stringField("Exact calendar date in YYYY-MM-DD."),
          title: stringField("Short day title."),
          cityRegion: stringField("Main city or region for the day."),
          accommodation: stringField("Accommodation area or hotel base for the night."),
          notes: stringField("Short day summary in Hebrew explaining why these stops fit together, plus practical notes."),
          transportation: stringField("Main transport strategy for the day, including transfer context when relevant."),
          estimatedCost: numberField("Estimated total daily cost."),
          activityCost: numberField("Estimated attraction/activity cost."),
          foodCost: numberField("Estimated food cost."),
          transportCost: numberField("Estimated local transport cost."),
          accommodationCost: numberField("Estimated accommodation cost for the day."),
          totalTravelMinutes: numberField("Total estimated travel time in minutes."),
          warnings: stringArrayField("Warnings or caveats for the day.", "One warning in Hebrew."),
          alternatives: stringArrayField("Optional alternatives.", "One alternative in Hebrew."),
          bookingRequirements: stringArrayField("Bookings to make or confirm.", "One booking note in Hebrew."),
          safetyNotes: stringArrayField("Safety notes for the day.", "One safety note in Hebrew."),
          restWindow: stringField("Rest, flexible, laundry, or buffer window when relevant."),
          transportSegments: stringArrayField(
            "Travel segments during the day including origin, destination, mode, duration, and cost when possible.",
            "One transport segment in Hebrew."
          ),
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: stringField("Activity or meal stop name in Hebrew."),
                category: stringField("One supported category keyword."),
                location: stringField("City, neighborhood, or address cue near the planned route."),
                shortDescription: stringField("Short practical description in Hebrew. Explain why it fits this day and area."),
                slot: stringField("morning, lunch, afternoon, dinner, evening, or night."),
                plannedStartTime: stringField("Suggested start time in HH:mm."),
                estimatedDurationMinutes: numberField("Estimated duration in minutes."),
                approximatePrice: numberField("Estimated price PER PERSON (not the total for the whole group), in local currency."),
                travelMinutes: numberField("Travel time from previous stop in minutes."),
                openingHours: stringField("Opening hours if known, otherwise state unavailable."),
                lastEntryTime: stringField("Last entry time in HH:mm, only if known and different from the closing time, otherwise leave empty."),
                reservationRequired: { type: Type.BOOLEAN, description: "Whether booking is recommended." },
                transportation: stringField("Transport used to reach this stop."),
                bookingWarning: stringField("Booking, timing, or practical warning such as ticketing, luggage, or check-in."),
                alternativeSuggestion: stringField("Nearby or weather-safe alternative if this stop is unavailable."),
              },
              required: [
                "name",
                "category",
                "location",
                "shortDescription",
                "slot",
                "plannedStartTime",
                "transportation",
                "bookingWarning",
                "alternativeSuggestion",
                "reservationRequired",
              ],
            },
          },
        },
        required: [
          "dayNumber",
          "date",
          "title",
          "cityRegion",
          "accommodation",
          "notes",
          "transportation",
          "warnings",
          "alternatives",
          "bookingRequirements",
          "safetyNotes",
          "restWindow",
          "transportSegments",
          "items",
        ],
      },
    },
  },
  required: ["title", "summary", "categoryBreakdown", "days"],
};

function normalizeCategory(value: string): RecommendationCategory {
  const lower = value.trim().toLowerCase();
  if (CATEGORY_VALUES.has(lower as RecommendationCategory)) return lower as RecommendationCategory;
  if (lower.includes("rest")) return "restaurant";
  if (lower.includes("cafe") || lower.includes("coffee")) return "cafe";
  if (lower.includes("museum")) return "museum";
  if (lower.includes("night")) return "nightlife";
  if (lower.includes("shop")) return "shopping";
  if (lower.includes("nature")) return "nature";
  if (lower.includes("family")) return "family";
  if (lower.includes("season")) return "seasonal_event";
  if (lower.includes("transport")) return "transportation";
  if (lower.includes("hotel")) return "hotel";
  return "attraction";
}

function normalizeSlot(value: string): DayPart {
  const lower = value.trim().toLowerCase();
  if (SLOT_VALUES.has(lower as DayPart)) return lower as DayPart;
  if (lower.includes("lunch")) return "lunch";
  if (lower.includes("after")) return "afternoon";
  if (lower.includes("dinner")) return "dinner";
  if (lower.includes("even")) return "evening";
  if (lower.includes("night")) return "night";
  return "morning";
}

function summarizeCountryKnowledge(knowledge: CountryAiRecommendation | null | undefined) {
  if (!knowledge) return "No static country guide data available.";

  const monthsPreview = knowledge.bestTime.months
    .slice(0, 4)
    .map((month) => ({
      month: month.month,
      weather: month.weather,
      tourismLevel: month.tourismLevel,
      prices: month.prices,
    }));

  return JSON.stringify(
    {
      overview: knowledge.overview.shortSummary,
      bestTime: {
        summary: knowledge.bestTime.summary,
        bestSeason: knowledge.bestTime.bestSeason,
        cheapestSeason: knowledge.bestTime.cheapestSeason,
        avoidSeason: knowledge.bestTime.avoidSeason,
        monthsPreview,
      },
      transportation: {
        airports: knowledge.transportation.airports.slice(0, 4),
        trains: knowledge.transportation.trains,
        metro: knowledge.transportation.metro,
        buses: knowledge.transportation.buses,
        rideHailing: knowledge.transportation.rideHailing,
        drivingRules: knowledge.transportation.drivingRules,
      },
      safety: {
        score: knowledge.safety.overallSafetyScore,
        hazards: knowledge.safety.naturalHazards.slice(0, 4),
        scams: knowledge.safety.touristScams.slice(0, 4),
        soloTravelSafety: knowledge.safety.soloTravelSafety,
        nightSafety: knowledge.safety.nightSafety,
      },
      food: {
        nationalDishes: knowledge.foodGuide.nationalDishes.slice(0, 4),
        streetFood: knowledge.foodGuide.streetFood.slice(0, 4),
        recommendedSpots: knowledge.foodGuide.recommendedSpots.slice(0, 6).map((spot) => ({
          name: spot.name,
          type: spot.type,
          cityOrArea: spot.cityOrArea,
          whatToTry: spot.whatToTry,
        })),
      },
      topDestinations: knowledge.topDestinations.slice(0, 8).map((item) => item.name),
      cities: knowledge.cities.slice(0, 6).map((item) => ({
        name: item.name,
        knownFor: item.knownFor,
        recommendedStay: item.recommendedStay,
      })),
    },
    null,
    2
  );
}

function getCountryCurrencyCode(isoA2: string) {
  const record = (countryFactsData as Record<string, RawCountryFactsRecord>)[isoA2.toUpperCase()];
  return record?.currencies?.[0]?.code?.toUpperCase() ?? null;
}

async function loadExchangeRateContext(isoA2: string): Promise<ExchangeRateContext | null> {
  const sourceCurrency = getCountryCurrencyCode(isoA2);
  if (!sourceCurrency || sourceCurrency === "ILS") {
    return {
      sourceCurrency: "ILS",
      targetCurrency: "ILS",
      rateToTarget: 1,
      updatedAt: new Date().toISOString(),
      source: "identity",
    };
  }

  try {
    const response = await fetch(`https://open.er-api.com/v6/latest/${sourceCurrency}`, {
      next: { revalidate: 60 * 60 * 12 },
    });
    if (!response.ok) {
      throw new Error("Failed to load exchange rate");
    }

    const data = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
      time_last_update_utc?: string;
    };
    const rateToIls = data.rates?.ILS;
    if (data.result === "success" && typeof rateToIls === "number" && Number.isFinite(rateToIls)) {
      return {
        sourceCurrency,
        targetCurrency: "ILS",
        rateToTarget: rateToIls,
        updatedAt: data.time_last_update_utc ?? new Date().toISOString(),
        source: "provider",
      };
    }
  } catch {
    // Fall through to static fallback rates.
  }

  const fallbackRate = FALLBACK_RATE_TO_ILS[sourceCurrency];
  if (!fallbackRate) return null;

  return {
    sourceCurrency,
    targetCurrency: "ILS",
    rateToTarget: fallbackRate,
    updatedAt: new Date().toISOString(),
    source: "fallback",
  };
}

function normalizePayloadPrices(
  payload: AiItineraryRequest,
  exchangeRateContext: ExchangeRateContext | null
): AiItineraryRequest {
  const normalizeRecommendation = (
    recommendation: AiItineraryRequest["recommendations"][number]
  ) => {
    const priced = withNormalizedRecommendationPrice(recommendation, exchangeRateContext);
    const coords = normalizeCoordinatePair(priced.lat, priced.lon);
    return {
      ...priced,
      lat: coords.lat,
      lon: coords.lon,
      mapLink: priced.mapLink || buildMapLink(priced.name, coords.lat, coords.lon),
    };
  };

  return {
    ...payload,
    recommendations: payload.recommendations.map(normalizeRecommendation),
    selectedPlaces: payload.selectedPlaces.map(normalizeRecommendation),
  };
}

function normalizeAreaLabel(location: string) {
  return location
    .split(/[,|·/]/)
    .map((part) => part.trim())
    .find(Boolean) ?? location.trim();
}

function includesAnyKeyword(value: string, keywords: string[]) {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function inferDayThemeLabel(items: AiGeneratedItem[]) {
  const categories = new Set(items.map((item) => item.category));

  if (categories.has("day_trip")) return "טיול יום";
  if (categories.has("nature")) return "טבע";
  if (categories.has("museum")) return "תרבות";
  if (categories.has("shopping")) return "קניות";
  if (categories.has("nightlife")) return "ערב וחיי לילה";
  if (items.some((item) => isFoodItem(item.category))) return "אוכל ושכונות";
  return "סיור מקומי";
}

function buildCategorySummary(
  candidates: Array<{
    name: string;
    category: RecommendationCategory;
    categoryLabel: string;
    location: string;
    recommendedTimeOfDay: string;
  }>
) {
  const grouped = new Map<string, string[]>();

  for (const candidate of candidates) {
    const label = candidate.categoryLabel;
    const next = grouped.get(label) ?? [];
    if (next.length < 6) {
      next.push(`${candidate.name} (${normalizeAreaLabel(candidate.location) || "ללא אזור"})`);
    }
    grouped.set(label, next);
  }

  return Object.fromEntries(grouped.entries());
}

function buildAreaSummary(
  candidates: Array<{
    name: string;
    categoryLabel: string;
    location: string;
  }>
) {
  const grouped = new Map<string, string[]>();

  for (const candidate of candidates) {
    const area = normalizeAreaLabel(candidate.location);
    if (!area) continue;
    const next = grouped.get(area) ?? [];
    if (next.length < 6) {
      next.push(`${candidate.name} (${candidate.categoryLabel})`);
    }
    grouped.set(area, next);
  }

  return Object.fromEntries([...grouped.entries()].slice(0, 16));
}

const TRIP_FRAME_PHASE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    phases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: numberField("Original phase index, 0-based, matching the input order exactly."),
          areaLabel: stringField("Best real city/region name for this phase."),
          intent: stringField("One of: city, nature, coast, historic, mixed."),
        },
        required: ["index", "areaLabel", "intent"],
      },
    },
  },
  required: ["phases"],
};

const TRIP_FRAME_INTENT_VALUES = new Set<TripFramePhase["intent"]>(["city", "nature", "coast", "historic", "mixed"]);

/**
 * Geography-first trip frame: clusters real candidate places by area and
 * distributes the trip's days across those clusters as base-city phases,
 * BEFORE any day-level content is generated. This is what lets the main
 * generation prompt lock geography instead of deciding it inline per day.
 */
/**
 * Real coordinate centroid per normalized area label, from the same
 * candidate pool the trip frame itself is built from (spec §B1/§C1) — one
 * shared source of area geography for departure-feasibility reordering
 * AND stay-transition distance/time, rather than two separately-computed
 * versions drifting apart.
 */
export function computeAreaAnchors(payload: AiItineraryRequest): Map<string, { lat: number; lon: number } | null> {
  const sums = new Map<string, { latSum: number; lonSum: number; count: number }>();

  for (const recommendation of [...payload.recommendations, ...payload.selectedPlaces]) {
    const area = normalizeAreaLabel(recommendation.location);
    if (!area || recommendation.lat == null || recommendation.lon == null) continue;
    const entry = sums.get(area) ?? { latSum: 0, lonSum: 0, count: 0 };
    entry.latSum += recommendation.lat;
    entry.lonSum += recommendation.lon;
    entry.count += 1;
    sums.set(area, entry);
  }

  const anchors = new Map<string, { lat: number; lon: number } | null>();
  for (const [area, entry] of sums) {
    anchors.set(area, entry.count > 0 ? { lat: entry.latSum / entry.count, lon: entry.lonSum / entry.count } : null);
  }
  return anchors;
}

/**
 * Round 9.3.1 — a real bug found via this round's own live replay:
 * computeAreaAnchors derives an anchor ONLY from payload.recommendations/
 * selectedPlaces coordinates, which are ALWAYS empty for a skeleton-driven
 * trip before discovery ever runs — so refillTripRecommendationPool's own
 * per-stay anchor was silently null, and Overpass was never even queried
 * for any stay. `tripFrame.phases[].anchor` (set by
 * buildTripFrameFromResolvedStays, TripFramePhase's own docstring) is the
 * AUTHORITATIVE resolved coordinate when the frame came from the stay
 * skeleton — always preferred over the recommendation-derived guess,
 * which remains the fallback for the older POI-clustering path (never set
 * phase.anchor) so its existing callers are unaffected.
 */
export function resolveAreaAnchorsForFrame(
  tripFrame: TripFrame,
  fallbackAnchors: Map<string, { lat: number; lon: number } | null>
): Map<string, { lat: number; lon: number } | null> {
  const merged = new Map(fallbackAnchors);
  for (const phase of tripFrame.phases) {
    if (phase.anchor !== undefined) merged.set(phase.areaLabel, phase.anchor);
  }
  return merged;
}

/**
 * The real area label a geographic cluster is known by — the majority
 * normalized location text among its own members (ties broken by first
 * occurrence). Keeps buildTripFramePhases' own input/output shape exactly
 * as before (plain area-label strings) while the GROUPING itself becomes
 * real geography instead of raw text matching.
 */
function pickClusterAreaLabel(members: TripRecommendation[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    const area = normalizeAreaLabel(member.location);
    if (!area) continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  let bestArea = "";
  let bestCount = 0;
  for (const [area, count] of counts) {
    if (count > bestCount) {
      bestArea = area;
      bestCount = count;
    }
  }
  return bestArea;
}

/** Real result of running every cluster through decideClusterRole (spec "WIRE CLUSTER ROLE INTO REAL GENERATION") before any TripFrame phase is committed. */
interface ClusterRolePlan {
  /** area label -> weight, built ONLY from overnight clusters plus any merge-role cluster folded into its nearest overnight/day-trip neighbor. */
  areaWeights: Map<string, number>;
  overnightClusters: ActivityCluster[];
  dayTripClusters: ActivityCluster[];
  trace: TripFramePlanningTrace;
}

/**
 * Spec "GENERATION-TIME STAY CREATION MUST USE ACTIVITY CLUSTERS" — the
 * REAL production decision point: every geographic cluster is evaluated
 * (evaluateCluster) and given an explicit role (decideClusterRole) BEFORE
 * any area becomes a TripFrame phase. Only "overnight" clusters (plus any
 * "merge" cluster's weight folded into its nearest surviving neighbor)
 * feed buildTripFramePhases below — "day_trip" clusters never compete for
 * a hotel base, and "skip" clusters are dropped entirely (spec: "the
 * planner does NOT need to visit every meaningful region — trip quality >
 * geographic coverage"). Candidates with no real coordinates fall back to
 * the original text-label grouping so they still contribute.
 */
function planClustersByRole(
  candidates: TripRecommendation[],
  mobilityProfile: DestinationMobilityProfile
): ClusterRolePlan {
  const areaWeights = new Map<string, number>();
  const withCoordinates = candidates.filter((candidate) => candidate.lat != null && candidate.lon != null);
  const withoutCoordinates = candidates.filter((candidate) => candidate.lat == null || candidate.lon == null);

  const clusters = clusterActivityCandidates(withCoordinates, mobilityProfile.localityRadiusKm);
  const neutralProfile = { strongPreferences: [] as string[], softPreferences: [] as string[] };
  const evaluations = clusters.map((cluster) => evaluateCluster(cluster, clusters, neutralProfile));
  // Section "HOTELABILITY MUST PARTICIPATE" — accommodationVerifiedUnavailable
  // is deliberately never set here: no live provider check runs at
  // TripFrame-build time, and an "unknown" feasibility signal must never
  // be interpreted as "impossible" (spec §10).
  const roles = evaluations.map((evaluation) => decideClusterRole(evaluation, mobilityProfile.localityRadiusKm));

  const overnightClusters = clusters.filter((_, index) => roles[index] === "overnight");
  const dayTripClusters = clusters.filter((_, index) => roles[index] === "day_trip");
  const mergeClusters = clusters.filter((_, index) => roles[index] === "merge");
  const skippedClusters = clusters.filter((_, index) => roles[index] === "skip");

  // Every real cluster still needs SOME area representation if literally
  // nothing survived as overnight (an all-weak-content candidate pool) —
  // fall back to treating every non-skipped cluster as its own area
  // rather than silently losing every bit of real content.
  const targetClusters = overnightClusters.length > 0 ? overnightClusters : [...overnightClusters, ...dayTripClusters, ...mergeClusters];

  for (const cluster of targetClusters) {
    const area = pickClusterAreaLabel(cluster.members);
    if (!area) continue;
    const evaluation = evaluateCluster(cluster, clusters, neutralProfile);
    areaWeights.set(area, (areaWeights.get(area) ?? 0) + Math.max(1, evaluation.clusterRequiredTimeMinutes));
  }

  if (overnightClusters.length > 0) {
    for (const cluster of mergeClusters) {
      let nearest: ActivityCluster | null = null;
      let nearestDistance = Infinity;
      for (const candidate of targetClusters) {
        const distance = haversineKm(cluster.center.lat, cluster.center.lon, candidate.center.lat, candidate.center.lon);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = candidate;
        }
      }
      if (!nearest) continue;
      const targetArea = pickClusterAreaLabel(nearest.members);
      if (!targetArea) continue;
      const evaluation = evaluateCluster(cluster, clusters, neutralProfile);
      areaWeights.set(targetArea, (areaWeights.get(targetArea) ?? 0) + Math.max(1, evaluation.clusterRequiredTimeMinutes));
    }
  }

  for (const recommendation of withoutCoordinates) {
    const area = normalizeAreaLabel(recommendation.location);
    if (!area) continue;
    areaWeights.set(area, (areaWeights.get(area) ?? 0) + (recommendation.estimatedDurationMinutes ?? 90));
  }

  return {
    areaWeights,
    overnightClusters,
    dayTripClusters,
    trace: {
      clusterCount: clusters.length,
      overnightClusterAreas: overnightClusters.map((cluster) => pickClusterAreaLabel(cluster.members)).filter(Boolean),
      dayTripClusterAreas: dayTripClusters.map((cluster) => pickClusterAreaLabel(cluster.members)).filter(Boolean),
      mergedClusterAreas: mergeClusters.map((cluster) => pickClusterAreaLabel(cluster.members)).filter(Boolean),
      skippedClusterAreas: skippedClusters.map((cluster) => pickClusterAreaLabel(cluster.members)).filter(Boolean),
      backtrackingReordered: false,
      shortStayMerges: [],
    },
  };
}

// Kept exported under its previous name for backward compatibility with
// any external caller/test expecting the plain area-weight map alone.
export function computeAreaWeightsFromClusters(
  candidates: TripRecommendation[],
  mobilityProfile: DestinationMobilityProfile
): Map<string, number> {
  return planClustersByRole(candidates, mobilityProfile).areaWeights;
}

/**
 * Reorders already-selected phases to match `newAreaOrder`, rebuilding
 * each phase's day range sequentially while preserving its own nights/
 * areaLabel/intent untouched — used by the backtracking/departure-
 * feasibility reorders, which only ever decide ORDER, never which areas
 * survived selection.
 */
function reorderPhasesByArea(phases: TripFramePhase[], newAreaOrder: string[]): TripFramePhase[] {
  const byArea = new Map(phases.map((phase) => [phase.areaLabel, phase]));
  const ordered = newAreaOrder.map((area) => byArea.get(area)).filter((phase): phase is TripFramePhase => phase != null);
  if (ordered.length !== phases.length) return phases; // safety: never drop/duplicate a phase due to a mismatched reorder

  let cursorDay = 1;
  return ordered.map((phase) => {
    const startDayNumber = cursorDay;
    const endDayNumber = cursorDay + phase.nights - 1;
    cursorDay = endDayNumber + 1;
    return { ...phase, startDayNumber, endDayNumber };
  });
}

export function buildDeterministicTripFrame(payload: AiItineraryRequest, dayCount: number): TripFrame {
  const bucket = getTripLengthBucket(dayCount);
  const allCandidates = [...payload.recommendations, ...payload.selectedPlaces];
  const mobilityProfile = computeDestinationMobilityProfile(
    allCandidates.map((candidate) => ({ lat: candidate.lat, lon: candidate.lon }))
  );
  const clusterPlan = planClustersByRole(allCandidates, mobilityProfile);
  const areaCounts = clusterPlan.areaWeights;

  const pinnedArea = normalizeAreaLabel(
    payload.preferences.accommodationArea || payload.preferences.preferredRegions || ""
  );

  let rankedAreas = [...areaCounts.entries()].sort((left, right) => right[1] - left[1]).map(([area]) => area);
  if (rankedAreas.length === 0) {
    rankedAreas = [normalizeAreaLabel(payload.countryName) || payload.countryName];
  }

  // "Which areas" (significance-based selection inside buildTripFramePhases,
  // unchanged) is deliberately computed from the plain weight-ranked order,
  // NEVER from a reordered one — reordering before selection could let a
  // geometrically-convenient weak area survive over a stronger one purely
  // because a route-coherence pass happened to place it earlier. "What
  // order" (backtracking/departure-feasibility) only ever reorders the
  // areas that already survived selection (spec "IMPORTANT OWNERSHIP
  // ORDER": choose overnight clusters, THEN build final stay sequence).
  const areaAnchors = computeAreaAnchors(payload);
  let phases = buildTripFramePhases(rankedAreas, areaCounts, dayCount, bucket, pinnedArea || null);

  // GLOBAL ROUTE OPTIMIZATION pass — the ONE authoritative stay-order
  // decision (spec §A: replaces the old two-step reorder at this exact
  // call site, never a second competing orderer). Arrival/departure are
  // hard constraints (spec §D): the route is arrival anchor → stay 1 →
  // ... → stay N → departure anchor, both resolved from the real flight
  // legs, never just the last stop.
  const arrivalAirport = payload.preferences.flights?.outbound?.arrivalAirport || null;
  const arrivalAnchor = arrivalAirport ? findAirportByIata(arrivalAirport) : null;
  const departureAirport = payload.preferences.flights?.return?.departureAirport || null;
  const departureAnchor = departureAirport ? findAirportByIata(departureAirport) : null;

  let backtrackingReordered = false;
  if (!pinnedArea && phases.length >= 2) {
    const selectedAreaOrder = phases.map((phase) => phase.areaLabel);
    const routeNodes: StayRouteNode[] = selectedAreaOrder.map((area) => {
      const anchor = areaAnchors.get(area);
      return {
        id: area,
        lat: anchor?.lat ?? 0,
        lon: anchor?.lon ?? 0,
        hasAnchor: anchor != null,
        value: areaCounts.get(area) ?? 1,
      };
    });

    const optimized = optimizeStayRouteSequence(routeNodes, arrivalAnchor, departureAnchor);
    const finalAreaOrder = optimized.map((node) => node.id);
    backtrackingReordered = finalAreaOrder.some((area, index) => area !== selectedAreaOrder[index]);

    if (backtrackingReordered) {
      phases = reorderPhasesByArea(phases, finalAreaOrder);
    }

    if (isPlannerQaTraceEnabled()) {
      const scoreBefore = scoreStayRoute(routeNodes, arrivalAnchor, departureAnchor);
      const scoreAfter = scoreStayRoute(optimized, arrivalAnchor, departureAnchor);
      logGenerationStage("route optimization: stay sequence", {
        before: selectedAreaOrder,
        after: finalAreaOrder,
        scoreBefore,
        scoreAfter,
      });
      const violations = verifyStayRouteInvariants(optimized, arrivalAnchor, departureAnchor);
      if (violations.length > 0) {
        logGenerationStage("route optimization: invariant violations after optimize (pre short-stay-repair)", { violations });
      }
    }
  }

  // Section "WIRE SHORT-STAY VIABILITY" — every interior 1-night phase
  // must earn its own hotel change; a real production pass, not a
  // QA-only computation.
  const shortStayResult = applyShortStayViabilityRepair({ bucketId: bucket.id, phases, source: "deterministic" }, areaAnchors, areaCounts);
  phases = shortStayResult.frame.phases;

  // Spec §I "if short-stay repair changes order/merges clusters, re-run
  // route validation" — diagnostic re-check only (QA-gated), never a
  // second repair pass; short-stay merging can change which areas are
  // adjacent, so a revisit that wasn't there before optimization could in
  // principle reappear after merging.
  if (isPlannerQaTraceEnabled() && phases.length >= 2) {
    const postRepairNodes: StayRouteNode[] = phases.map((phase) => {
      const anchor = areaAnchors.get(phase.areaLabel);
      return { id: phase.areaLabel, lat: anchor?.lat ?? 0, lon: anchor?.lon ?? 0, hasAnchor: anchor != null, value: areaCounts.get(phase.areaLabel) ?? 1 };
    });
    const postRepairViolations = verifyStayRouteInvariants(postRepairNodes, arrivalAnchor, departureAnchor);
    if (postRepairViolations.length > 0) {
      logGenerationStage("route optimization: invariant violations after short-stay repair", { violations: postRepairViolations });
    }
  }

  // Section "DAY-TRIP CLUSTER" — attach each day-trip cluster to whichever
  // FINAL surviving phase is geographically nearest, never a phase that
  // was itself later dropped/merged away. Section "DAY-TRIP FEASIBILITY" —
  // decideClusterRole only ever decided a cluster is WORTH a day trip
  // (enough content, not close enough to merge); it never checked whether
  // the round trip from its actual nearest base is something a traveler
  // could plausibly do in a day. Gated here, at the point a day-trip
  // cluster is actually accepted as a real hint — the same existing
  // "return null, drop from the list" mechanism the missing-anchor case
  // just above already uses, not a new rejection path.
  const dailyCapacityMinutes = deriveDailyCapacityMinutes(payload.preferences.tripPace);
  const dayTripHints: TripFrameDayTripHint[] = clusterPlan.dayTripClusters
    .map((cluster): TripFrameDayTripHint | null => {
      const area = pickClusterAreaLabel(cluster.members);
      if (!area) return null;
      let nearestPhase: TripFramePhase | null = null;
      let nearestPhaseAnchor: { lat: number; lon: number } | null = null;
      let nearestDistance = Infinity;
      for (const phase of phases) {
        const anchor = areaAnchors.get(phase.areaLabel);
        if (!anchor) continue;
        const distance = haversineKm(cluster.center.lat, cluster.center.lon, anchor.lat, anchor.lon);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestPhase = phase;
          nearestPhaseAnchor = anchor;
        }
      }
      if (!nearestPhase || !nearestPhaseAnchor) return null;

      const feasibility = computeDayTripClusterFeasibility(cluster, nearestPhaseAnchor, dailyCapacityMinutes);
      if (!feasibility.feasible) {
        logGenerationStage("day-trip cluster rejected (infeasible)", { area, attachedToAreaLabel: nearestPhase.areaLabel, ...feasibility });
        return null;
      }

      const evaluation = evaluateCluster(cluster, clusterPlan.overnightClusters, { strongPreferences: [], softPreferences: [] });
      return { areaLabel: area, attachedToAreaLabel: nearestPhase.areaLabel, requiredTimeMinutes: evaluation.clusterRequiredTimeMinutes };
    })
    .filter((hint): hint is TripFrameDayTripHint => hint != null);

  const planningTrace: TripFramePlanningTrace = {
    ...clusterPlan.trace,
    backtrackingReordered,
    shortStayMerges: shortStayResult.mergedAreas,
  };

  logGenerationStage("cluster/stay planning trace", planningTrace as unknown as Record<string, unknown>);

  return { bucketId: bucket.id, phases, source: "deterministic", dayTripHints, planningTrace };
}

async function refineTripFrameWithGemini(
  frame: TripFrame,
  payload: AiItineraryRequest,
  knowledge?: CountryAiRecommendation | null
): Promise<TripFrame> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || frame.phases.length <= 1) return frame;

  try {
    const client = new GoogleGenAI({ apiKey });
    const bucket = getTripLengthBucket(frame.phases.at(-1)?.endDayNumber ?? frame.phases.length);
    const prompt = [
      "You are refining a trip's geographic base-city plan. Do not change or reorder night counts or day ranges — only improve area names and assign an intent tag.",
      `Destination: ${payload.countryName}.`,
      `Trip-length planning guidance: ${bucket.guidance}`,
      `Phases JSON (index, current area label, night count): ${JSON.stringify(
        frame.phases.map((phase, index) => ({ index, areaLabel: phase.areaLabel, nights: phase.nights })),
        null,
        2
      )}`,
      knowledge
        ? `Known cities/regions JSON: ${JSON.stringify(
            knowledge.cities.slice(0, 8).map((city) => ({ name: city.name, knownFor: city.knownFor })),
            null,
            2
          )}`
        : "",
      "Return JSON only, matching the schema exactly, with one entry per input phase index.",
    ].join("\n");

    const response = await client.models.generateContent({
      model: ITINERARY_MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: TRIP_FRAME_PHASE_SCHEMA },
    });

    const raw = response.text;
    captureGeminiFixture({ model: ITINERARY_MODEL, prompt, purpose: "refineTripFrameWithGemini" }, raw);
    if (!raw) return frame;

    const parsed = JSON.parse(raw) as { phases?: Array<{ index: number; areaLabel: string; intent: string }> };
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) return frame;

    // Section "STAY ANCHOR MUST SURVIVE RELABELING" — real bug found via a
    // real 43-day US replay: Gemini renaming a phase's areaLabel to a
    // nicer display name (e.g. a specific real city -> a broad regional
    // name like "California Coast") with no matching entry in areaAnchors
    // (keyed strictly by the pool's own raw recommendation location text,
    // recomputed independently of tripFrame and never re-derived after
    // this rename) silently orphaned the phase from any real geographic
    // anchor for the rest of the pipeline. enforceNormalDayLocality's own
    // "no anchor -> continue" then skipped the ENTIRE day's geography
    // check, letting any real POI "pass" regardless of distance — the
    // exact reported shape (New York/Chicago/Tennessee content surviving
    // under a broad "California Coast" owner, legMinutes: null,
    // verdict: passed). Only accept a rename that still resolves to a
    // real anchor; otherwise keep the original, anchor-bearing label —
    // pickClusterAreaLabel only ever returns a label that already exists
    // verbatim in the pool, so the original is always anchor-safe.
    const areaAnchors = computeAreaAnchors(payload);
    // Root-cause fix (real 43-day US replay: "Virginia" ended up as the
    // areaLabel for THREE non-contiguous phases — a transfer day and two
    // separate later "normal" stays — because nothing stopped Gemini from
    // proposing the SAME rename for multiple phase indices). deriveDayType
    // identifies a stay change purely by phase OBJECT identity
    // (phase.id !== previousPhase.id), never by label — so two
    // non-adjacent phases sharing a label is invisible to it, but their
    // SHARED label makes every downstream lookup (areaAnchors.get(phase.
    // areaLabel), buildStayTransitions treating them as the "same" stay
    // when adjacent) ambiguous. A proposed rename that collides with a
    // DIFFERENT phase's already-accepted label is rejected the same way
    // an anchor-less one is — worldwide/generic, no phase-count or
    // area-name assumption.
    const acceptedLabelsByPhaseId = new Map<string, string>();
    for (const phase of frame.phases) acceptedLabelsByPhaseId.set(phase.id, phase.areaLabel);

    const nextPhases = frame.phases.map((phase, index) => {
      const match = parsed.phases!.find((entry) => entry.index === index);
      if (!match || !match.areaLabel?.trim()) return phase;
      const intent = TRIP_FRAME_INTENT_VALUES.has(match.intent as TripFramePhase["intent"])
        ? (match.intent as TripFramePhase["intent"])
        : phase.intent;
      const proposedLabel = match.areaLabel.trim();
      // Root-cause fix (same 43-day US replay) — the anchor-existence
      // check normalizes the proposed label before looking it up, but the
      // RAW (un-normalized) label used to be what got stored. Every later
      // `areaAnchors.get(phase.areaLabel)` call site looks up the RAW
      // stored label without normalizing, so e.g. "Virginia, USA" passed
      // this check (its normalized form "Virginia" has a real anchor) yet
      // resolved to `undefined` everywhere else, silently orphaning the
      // phase from its own anchor. Storing the SAME normalized form that
      // was actually verified closes that mismatch for every consumer at
      // once, instead of patching each lookup site separately.
      const normalizedProposedLabel = normalizeAreaLabel(proposedLabel);
      const proposedHasAnchor = areaAnchors.get(normalizedProposedLabel) != null;
      const collidesWithAnotherPhase = [...acceptedLabelsByPhaseId.entries()].some(
        ([phaseId, label]) => phaseId !== phase.id && normalizeAreaLabel(label) === normalizedProposedLabel
      );
      if (!proposedHasAnchor || collidesWithAnotherPhase) {
        logGenerationStage("refineTripFrameWithGemini: rejected a rename", {
          phaseIndex: index,
          originalAreaLabel: phase.areaLabel,
          rejectedProposedLabel: proposedLabel,
          reason: !proposedHasAnchor ? "no_real_anchor" : "collides_with_another_phase",
        });
        return phase;
      }
      acceptedLabelsByPhaseId.set(phase.id, normalizedProposedLabel);
      return { ...phase, areaLabel: normalizedProposedLabel, intent };
    });

    return { ...frame, phases: nextPhases, source: "ai" };
  } catch {
    return frame;
  }
}

/**
 * Round 9.3 §1/§2 — THE root-cause gate. buildDeterministicTripFrame's own
 * geographic clustering derives every area purely from real coordinates in
 * payload.recommendations/selectedPlaces; with none available (the normal
 * case since Round 9.2 removed the client's country-wide POI prefetch),
 * `planClustersByRole` finds zero areas and buildDeterministicTripFrame's
 * own documented fallback collapses the ENTIRE trip to one phase whose
 * areaLabel is literally the destination country's name — this is true
 * whether the trip is 4 days or 42. This predicate is the ONLY thing that
 * decides whether the stay-skeleton stage below runs; it fires exactly on
 * that collapse, never on a trip that already has a real pinned area or
 * real multi-area clustering data.
 */
export function needsStaySkeleton(deterministicFrame: TripFrame, payload: AiItineraryRequest): boolean {
  if (deterministicFrame.phases.length !== 1) return false;
  const pinnedArea = normalizeAreaLabel(
    payload.preferences.accommodationArea || payload.preferences.preferredRegions || ""
  );
  if (pinnedArea) return false; // an explicit single-base signal, not a failure
  const onlyArea = normalizeAreaLabel(deterministicFrame.phases[0].areaLabel);
  const countryArea = normalizeAreaLabel(payload.countryName);
  return Boolean(onlyArea) && onlyArea === countryArea;
}

const STAY_SKELETON_MODEL = "gemini-flash-lite-latest";
const STAY_SKELETON_TIMEOUT_MS = 15_000;
const STAY_SKELETON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    stays: {
      type: Type.ARRAY,
      description: "2-10 real geographic bases for this trip. NEVER attraction/restaurant/POI names — cities, towns, national-park or island base names only.",
      items: {
        type: Type.OBJECT,
        properties: {
          areaName: { type: Type.STRING, description: "A real, geocodable city/town/region/park-gateway name, optionally with country for disambiguation." },
          nights: { type: Type.NUMBER },
          reasons: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["areaName", "nights"],
      },
    },
  },
  required: ["stays"],
};

/**
 * Round 9.3 §3/§4 — the ENTIRE input is trip-shape/preference data, never a
 * POI list (spec §4: "Do NOT send a giant country-wide POI list"). Gemini
 * decides WHERE to base the trip, not what to do there.
 */
export function buildStaySkeletonPrompt(payload: AiItineraryRequest, dayCount: number): string {
  const bucket = getTripLengthBucket(dayCount);
  const arrivalAirport = payload.preferences.flights?.outbound?.arrivalAirport || null;
  const departureAirport = payload.preferences.flights?.return?.departureAirport || null;
  const arrivalInfo = arrivalAirport ? findAirportByIata(arrivalAirport) : null;
  const departureInfo = departureAirport ? findAirportByIata(departureAirport) : null;

  return [
    `אתה מתכנן את השלד הגיאוגרפי של טיול ל${payload.countryName}, ${dayCount} ימים.`,
    `הצע 2-10 בסיסי לינה אמיתיים (ערים/אזורים/עיירות שער לפארק לאומי/בסיסי אי) — לעולם לא שמות אטרקציות, מסעדות או נקודות עניין ספציפיות.`,
    `הנחיית אורך טיול: ${bucket.guidance}`,
    arrivalInfo ? `נחיתה: ${arrivalInfo.city}.` : "אין מידע על שדה תעופה לנחיתה.",
    departureInfo ? `המראה חזרה: ${departureInfo.city}.` : "אין מידע על שדה תעופה להמראה.",
    `מספר נוסעים: ${payload.preferences.travelers}.`,
    payload.preferences.interests ? `תחומי עניין: ${payload.preferences.interests}.` : "",
    payload.preferences.tripPace ? `קצב מועדף: ${payload.preferences.tripPace}.` : "",
    payload.preferences.budget ? `תקציב כולל משוער: ${payload.preferences.budget}.` : "",
    payload.preferences.transportationPreferences ? `העדפת תחבורה: ${payload.preferences.transportationPreferences}.` : "",
    payload.preferences.mustVisitPlaces ? `מקומות שחובה לכלול: ${payload.preferences.mustVisitPlaces}.` : "",
    payload.preferences.accessibilityNeeds ? `צרכי נגישות: ${payload.preferences.accessibilityNeeds}.` : "",
    payload.preferences.tripStyle ? `סגנון טיול רצוי: ${payload.preferences.tripStyle}.` : "",
    `כל בסיס חייב לקבל nights (מספר לילות) ו-reasons (מערך מחרוזות קצרות, למשל "culture", "food", "major sights"). אל תמציא שמות מקומות שאינם קיימים באמת. סכום הלילות צריך להתקרב ל-${Math.max(1, dayCount - 1)} (מספר הלילות הכולל של הטיול).`,
    `החזר JSON בלבד, תואם לסכמה.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Round 9.3 §3 — Gemini's role here is bounded, high-level geographic
 * planning only. Optional by construction (mirrors
 * refineComposedPlanWithGemini's injectable pattern exactly, Round 9.2) —
 * `geminiCallOverride` lets tests avoid any real network/API-key
 * dependency; production omits it and gets the real GoogleGenAI-backed
 * default. Any failure at all (no key, network, bad JSON, timeout) returns
 * null — the caller falls back to the deterministic skeleton (spec §8:
 * "Gemini must not be a single point of failure").
 */
export async function proposeStaySkeletonWithGemini(
  payload: AiItineraryRequest,
  dayCount: number,
  geminiCallOverride?: (prompt: string) => Promise<string | null>
): Promise<ProposedStay[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!geminiCallOverride && !apiKey) return null;

  try {
    const prompt = buildStaySkeletonPrompt(payload, dayCount);
    const callGemini =
      geminiCallOverride ??
      (async (thePrompt: string) => {
        const client = new GoogleGenAI({ apiKey: apiKey! });
        const response = await client.models.generateContent({
          model: STAY_SKELETON_MODEL,
          contents: thePrompt,
          config: { responseMimeType: "application/json", responseSchema: STAY_SKELETON_SCHEMA },
        });
        return response.text ?? null;
      });
    const raw = await Promise.race([
      callGemini(prompt),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stay-skeleton timeout")), STAY_SKELETON_TIMEOUT_MS)),
    ]);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { stays?: Array<{ areaName?: string; nights?: number; reasons?: string[] }> };
    if (!Array.isArray(parsed.stays) || parsed.stays.length === 0) return null;
    return parsed.stays
      .filter((s): s is { areaName: string; nights?: number; reasons?: string[] } => Boolean(s.areaName?.trim()))
      .map((s, index) => ({
        proposedId: `gemini-${index + 1}`,
        areaName: s.areaName.trim(),
        nights: s.nights != null && Number.isFinite(s.nights) ? Math.max(0, Math.round(s.nights)) : 1,
        reasons: Array.isArray(s.reasons) ? s.reasons.filter((r): r is string => typeof r === "string") : [],
      }));
  } catch {
    return null;
  }
}

/**
 * Round 9.3 — THE stay-skeleton stage: propose (Gemini, then deterministic
 * fallback) -> resolve (real geocoding) -> dedupe -> validate -> build
 * frame. Returns null only when every source (Gemini AND the deterministic
 * fallback AND the single-base last resort) fails to produce a VALID
 * skeleton — the caller then falls back to the old deterministic-cluster
 * frame rather than ever silently returning nothing (spec §7: "If still
 * impossible: surface an explicit planner supply/skeleton failure", wired
 * at the classifyPlanFailure layer below, never a bare crash here).
 */
export async function buildTripFrameFromSkeleton(
  payload: AiItineraryRequest,
  dayCount: number,
  geminiCallOverride?: (prompt: string) => Promise<string | null>,
  /** Injectable — tests pass a fake to avoid any real Nominatim network call. */
  searchPlacesOverride?: Parameters<typeof resolveStaySkeleton>[3]
): Promise<{ result: StaySkeletonFrame; skeletonSource: StaySkeletonSource } | null> {
  const totalNights = Math.max(1, dayCount - 1);
  const arrivalAirport = payload.preferences.flights?.outbound?.arrivalAirport || null;
  const arrivalAnchor = arrivalAirport ? findAirportByIata(arrivalAirport) : null;
  const departureAirport = payload.preferences.flights?.return?.departureAirport || null;
  const departureAnchor = departureAirport ? findAirportByIata(departureAirport) : null;

  const tryBuild = async (
    proposals: ProposedStay[],
    source: StaySkeletonSource
  ): Promise<{ result: StaySkeletonFrame; skeletonSource: StaySkeletonSource } | null> => {
    if (proposals.length === 0) return null;
    const { resolved, unresolvedCount } = await resolveStaySkeleton(proposals, payload.isoA2, source, searchPlacesOverride);
    const deduped = dedupeResolvedStays(resolved);
    const validation = validateTripStaySkeleton(deduped, unresolvedCount, totalNights, payload.countryName, resolved.length - deduped.length);
    logGenerationStage("[StaySkeletonQA] validation", { source, ...validation });
    if (!validation.valid) return null;
    return { result: buildTripFrameFromResolvedStays(deduped, dayCount, arrivalAnchor, departureAnchor), skeletonSource: source };
  };

  const geminiProposals = await proposeStaySkeletonWithGemini(payload, dayCount, geminiCallOverride);
  if (geminiProposals) {
    const geminiResult = await tryBuild(geminiProposals, "gemini_resolved");
    if (geminiResult) return geminiResult;
  }

  const fallbackProposals = deterministicFallbackSkeleton(payload);
  const fallbackResult = await tryBuild(fallbackProposals, "fallback_cluster");
  if (fallbackResult) return fallbackResult;

  // Absolute last resort — still resolved through the real geocoder, still
  // honestly tagged, never a bare unresolved country string (spec §8).
  const singleBaseResult = await tryBuild([buildSingleBaseFallbackProposal(payload)], "single_base_fallback");
  if (singleBaseResult) return singleBaseResult;

  return null;
}

export async function buildTripFrame(
  payload: AiItineraryRequest,
  dayCount: number,
  knowledge?: CountryAiRecommendation | null,
  staySkeletonGeminiOverride?: (prompt: string) => Promise<string | null>,
  staySkeletonSearchPlacesOverride?: Parameters<typeof buildTripFrameFromSkeleton>[3]
): Promise<{ frame: TripFrame; reserveStays: ResolvedStay[] }> {
  const deterministicFrame = buildDeterministicTripFrame(payload, dayCount);

  if (needsStaySkeleton(deterministicFrame, payload)) {
    const skeleton = await buildTripFrameFromSkeleton(payload, dayCount, staySkeletonGeminiOverride, staySkeletonSearchPlacesOverride);
    if (skeleton) {
      logGenerationStage("[StaySkeletonQA]", {
        source: skeleton.skeletonSource,
        proposedStayCount: skeleton.result.stays.length,
        resolvedStayCount: skeleton.result.stays.length,
        finalStayCount: skeleton.result.frame.phases.length,
        reserveStayCount: skeleton.result.reserveStays.length,
        nightsByStay: skeleton.result.frame.phases.map((p) => ({ area: p.areaLabel, nights: p.nights })),
      });
      return { frame: skeleton.result.frame, reserveStays: skeleton.result.reserveStays };
    }
    // Every skeleton source failed validation — fall through to the old
    // deterministic-cluster frame (still the country-level single phase in
    // the worst case) rather than throwing here; the failure becomes
    // visible downstream via classifyPlanFailure/InsufficientRealActivitySupplyError
    // once local discovery/portfolio building also comes up empty for it.
    logGenerationStage("[StaySkeletonQA] all skeleton sources failed — falling back to country-level frame");
  }

  if (deterministicFrame.phases.length <= 1) return { frame: deterministicFrame, reserveStays: [] };
  return { frame: await refineTripFrameWithGemini(deterministicFrame, payload, knowledge), reserveStays: [] };
}

function describeTripFrame(frame: TripFrame) {
  const phasesText = frame.phases
    .map((phase) => {
      const dayLabel = phase.startDayNumber === phase.endDayNumber
        ? `Day ${phase.startDayNumber}`
        : `Days ${phase.startDayNumber}-${phase.endDayNumber}`;
      return `${dayLabel} base: ${phase.areaLabel} (${phase.nights} night${phase.nights === 1 ? "" : "s"}, intent: ${phase.intent})`;
    })
    .join(" | ");

  // Section "DAY-TRIP CLUSTER" — a real geographic cluster with genuine
  // content that didn't earn its own overnight base is surfaced here as
  // explicit day-trip guidance FROM its attached base, never as its own
  // competing hotel change.
  if (!frame.dayTripHints || frame.dayTripHints.length === 0) return phasesText;
  const dayTripsText = frame.dayTripHints
    .map((hint) => `${hint.areaLabel} as a day trip from the ${hint.attachedToAreaLabel} base (base→destination→base, never its own overnight)`)
    .join("; ");
  return `${phasesText}. Suggested day trips: ${dayTripsText}`;
}

function buildPrompt(
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  exchangeRateContext: ExchangeRateContext | null,
  tripFrame: TripFrame,
  arrivalDepartureWindow: ArrivalDepartureWindow,
  knowledge?: CountryAiRecommendation | null
) {
  const exactDayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  const candidates = payload.recommendations.slice(0, 48).map((recommendation) => ({
    id: recommendation.id,
    name: recommendation.name,
    category: recommendation.category,
    categoryLabel: RECOMMENDATION_CATEGORY_LABELS[recommendation.category],
    location: recommendation.location,
    description: recommendation.shortDescription,
    priceInIls: recommendation.approximatePrice,
    originalPrice:
      recommendation.priceOriginalAmount != null
        ? `${recommendation.priceOriginalAmount} ${recommendation.priceOriginalCurrency ?? ""}`.trim()
        : null,
    durationMinutes: recommendation.estimatedDurationMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
    recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
    reservationRequired: recommendation.reservationRequired,
    lat: recommendation.lat,
    lon: recommendation.lon,
  }));
  const candidateCategorySummary = buildCategorySummary(candidates);
  const candidateAreaSummary = buildAreaSummary(candidates);

  const lockedActivities = payload.existingDays
    .flatMap((day) => day.items.filter((item) => item.locked))
    .map((item) => `${item.name} (${item.location})`);

  const selectedPlaces =
    payload.selectedPlaces.length > 0
      ? payload.selectedPlaces.map((place) => place.name).join(", ")
      : "לא נבחרו מקומות ידניים";

  const bookings =
    payload.bookings.length > 0
      ? payload.bookings.map((booking) => ({
          name: booking.title,
          type: booking.type,
          date: booking.startDateTime,
          status: booking.status,
          notes: booking.notes,
        }))
      : [];

  const longTripGuidance =
    exactDayCount > 7
      ? [
          "Because this is a trip longer than 7 days, include lighter days, flexible hours, laundry/planning windows, accommodation changes when the route spans multiple bases, and explicit intercity transfer structure.",
          "Not every day should be dense. Add buffers after long nights, after transfer days, and every few days on multi-week trips.",
        ]
      : ["Keep the plan varied, realistic, and personal even for a shorter trip."];

  const regenerationGuidance =
    payload.regenerationScope && payload.regenerationScope !== "full"
      ? `Regeneration scope: ${payload.regenerationScope}. Preserve the broader trip logic and only substantially change the requested scope when possible.`
      : "Regeneration scope: full trip.";

  const liveReplanGuidance =
    payload.regenerationScope === "live_replan" && payload.liveInstruction
      ? (() => {
          const targetDay = payload.existingDays.find((day) => day.id === payload.targetDayId);
          const untouchableNames = (targetDay?.items ?? [])
            .filter((item) => item.completed || item.skipped || item.locked || item.fixedTime)
            .map((item) => item.name)
            .filter(Boolean);
          return [
            `Live re-plan instruction from the traveler, said right now, mid-trip: "${payload.liveInstruction}"`,
            "This is a live, in-the-moment adjustment, not a fresh plan. Only adjust the remaining, not-yet-happened items of the target day. Do not change any other day.",
            untouchableNames.length > 0
              ? `These items in the target day are already completed, skipped, locked, or fixed-time and must stay exactly as they are, unchanged, in the same slot: ${untouchableNames.join(", ")}.`
              : "",
            "Locked items, fixed-time items (reservations, trains, flights, tours), and must-do priority items must never move or be replaced, even if the traveler's instruction seems to ask for it — work around them instead of overriding them.",
            "Stay within the remaining budget for the day and keep the same overall geographic area unless the instruction explicitly asks to leave it.",
          ]
            .filter(Boolean)
            .join(" ");
        })()
      : "";

  const flightWindowDescription = describeArrivalDepartureWindow(arrivalDepartureWindow);
  const flightWindowGuidance = flightWindowDescription
    ? [
        `Treat the arrival/departure window as a hard constraint, with higher priority than any other preference below: ${flightWindowDescription}`,
      ]
    : [];

  // Advisory only, never a hard block on the dates themselves (spec item 34).
  const holidayContext = describeHolidayContext(payload.preferences.startDate, payload.preferences.endDate);
  const holidayGuidance = holidayContext ? [holidayContext] : [];

  const tripFrameGuidance = [
    `Locked trip frame (decided before this prompt, geography-first): ${describeTripFrame(tripFrame)}.`,
    "Treat this trip frame as a hard constraint: every day's cityRegion and accommodation must match its assigned base/phase above, except for the specific day(s) where the frame itself transitions between phases (those become transfer days).",
    "Do not invent a different base city on a day that the frame assigns elsewhere.",
    `Advisory activity-mix target across the whole trip (guidance, not a hard rule): ${describeActivityMixTargets()}.`,
  ];

  return [
    "You are a practical itinerary planner, not a travel writer.",
    "Behavioral reference: plan like a strong independent traveler's multi-week trip, not like a generic sightseeing brochure.",
    ...flightWindowGuidance,
    ...holidayGuidance,
    "Plan geography first: the trip frame below already fixed base cities/regions and nights per base. Build each day's content to fit inside its assigned base, not the other way around.",
    ...tripFrameGuidance,
    "Return JSON only, matching the schema exactly.",
    "Write all human-readable text in natural Hebrew.",
    "Use exact selected dates and create one day for every calendar date in the range.",
    "Do not invent live events, precise opening hours, or real-time weather. If unknown, label values as unavailable or estimated.",
    "Only include live events, concerts, festivals, exhibitions, or seasonal happenings when they are supported by the provided candidates or static guide. Otherwise leave them out.",
    "Treat hard constraints as mandatory unless physically impossible. Never ignore budget, dates, traveler count, dietary restrictions, accessibility, must-visit places, excluded places, transport limits, or accommodation constraints.",
    "Strong preferences should shape the whole trip: pace, trip style, interests, transport preferences, food preferences, nightlife interest, city-vs-nature balance, shopping, and cultural focus.",
    "The plan must feel complete when generation ends. Do not output TODO-style notes asking the traveler to add meals, rebalance days, or reorganize geography later.",
    "Every day should already include realistic food stops in the itinerary timeline itself, not only in notes.",
    "Budget is a real ceiling. Keep the final estimated total at or under the target whenever possible, and avoid anything more than about 5% over target.",
    "Prefer affordable local restaurants, markets, food halls, neighborhood favorites, ramen, soba, curry, set meals, izakaya, bakeries, and casual spots unless the user's style explicitly supports luxury dining.",
    "Do not repeat the same restaurant or the same famous premium venue unless the user clearly asked for it.",
    "Do not overload a day and then warn the user about it. Automatically choose a lighter, geographically tighter day instead.",
    "Warnings should be rare and actionable only for unresolved issues like closures, booking risk, safety risk, unusual transfer length, or budget risk.",
    "The trip should feel personal, varied, energetic, geographically efficient, and realistic.",
    "Each day should usually include one anchor activity, one or two secondary activities, nearby meal recommendations, realistic transfers, and an optional evening idea only when capacity allows.",
    "Some days can be dense, but others should be lighter. Avoid repeating the same daily template.",
    "Use a natural mix of major attractions, neighborhoods, parks, museums, markets, shopping, food, nightlife, day trips, practical errands, and flexible time.",
    "Practical tasks such as luggage forwarding, hotel check-in/out, overnight transport, buying passes, or laundry should appear as planning notes or practical stops when relevant.",
    ...longTripGuidance,
    "Avoid repeating similar activities too often. Group nearby places geographically and minimize backtracking.",
    "Keep lunch and dinner close to the day's attraction area. Do not send the traveler across the city for food unless that is the point of the plan.",
    "If an exact restaurant is unavailable, use a real food district, market, or neighborhood instead of inventing a fake venue.",
    "Use transportation and accommodation changes as part of the trip rhythm, especially on long routes.",
    regenerationGuidance,
    liveReplanGuidance,
    `Destination: ${payload.countryName} (${payload.isoA2}).`,
    `Country ID: ${payload.countryId}.`,
    `Travel dates: ${payload.preferences.startDate} to ${payload.preferences.endDate}.`,
    `Exact day count required: ${exactDayCount}.`,
    `Travelers: ${payload.preferences.travelers}.`,
    `Budget target in ILS: ${payload.preferences.budget ?? "לא הוגדר"}.`,
    `Trip style: ${payload.preferences.tripStyle || "לא הוגדר"}.`,
    `Trip pace: ${payload.preferences.tripPace}.`,
    `Generation mode: ${payload.preferences.generationMode} (${ITINERARY_GENERATION_MODE_LABELS[payload.preferences.generationMode]}).`,
    `Interests: ${payload.preferences.interests || "לא הוגדר"}.`,
    `Preferred transportation: ${payload.preferences.transportationPreferences || "לא הוגדר"}.`,
    `Dietary preferences (hard constraints — treat every one as mandatory, never optional): ${payload.preferences.dietaryPreferences || "ללא"}.`,
    payload.preferences.foodNotes
      ? `Additional food notes from the traveler: ${payload.preferences.foodNotes}`
      : "",
    "Food behavior: first choose attractions and the geographic route, then find food options close to those locations — food stops should normally be within 25 minutes travel of the nearby activity, preferring 10-15 minutes or less when possible. If the traveler selected multiple food interests (e.g. local cuisine + street food + cafes + vegetarian), combine all of them when choosing food stops — never interpret multiple selections as picking just one.",
    `Accessibility needs: ${payload.preferences.accessibilityNeeds || "ללא"}.`,
    `Accommodation base: ${payload.preferences.accommodationArea || "לא הוגדר"}.`,
    `Preferred regions/cities: ${payload.preferences.preferredRegions || "לא הוגדר"}.`,
    `Must-visit places: ${payload.preferences.mustVisitPlaces || "לא הוגדר"}.`,
    `Places to avoid: ${payload.preferences.placesToAvoid || "לא הוגדר"}.`,
    `Safety constraints: ${payload.preferences.safetyConstraints || "לא הוגדר"}.`,
    `Selected places: ${selectedPlaces}.`,
    `Locked existing activities: ${lockedActivities.length > 0 ? lockedActivities.join(", ") : "אין"}.`,
    `Normalized preference profile: ${profile.summary}.`,
    `Hard constraints: ${profile.hardConstraints.join(" | ") || "none"}.`,
    `Strong preferences: ${profile.strongPreferences.join(" | ") || "none"}.`,
    `Soft preferences: ${profile.softPreferences.join(" | ") || "none"}.`,
    ...(payload.personalizationSummary
      ? [
          `Learned personalization from the traveler's past trips (secondary to the trip-specific preferences already stated above — trip-specific input always wins on conflict): ${payload.personalizationSummary}.`,
        ]
      : []),
    `Daily capacity limit in minutes including travel and meals: ${profile.dailyCapacityMinutes}.`,
    `Budget allocation in percent: accommodation ${Math.round(profile.budgetAllocation.accommodation * 100)}%, food ${Math.round(profile.budgetAllocation.food * 100)}%, transportation ${Math.round(profile.budgetAllocation.transportation * 100)}%, attractions ${Math.round(profile.budgetAllocation.attractions * 100)}%, shopping ${Math.round(profile.budgetAllocation.shopping * 100)}%, buffer ${Math.round(profile.budgetAllocation.buffer * 100)}%.`,
    `Budget caps in ILS: per day ${profile.perDayBudget ?? "unknown"}, lunch ${profile.mealBudgetLunch ?? "unknown"}, dinner ${profile.mealBudgetDinner ?? "unknown"}, activity stop ${profile.activityBudgetPerStop ?? "unknown"}, transport day ${profile.transportBudgetPerDay ?? "unknown"}, accommodation day ${profile.accommodationBudgetPerDay ?? "unknown"}.`,
    `Candidate prices were normalized to ILS${exchangeRateContext ? ` from ${exchangeRateContext.sourceCurrency} using rate ${exchangeRateContext.rateToTarget} updated ${exchangeRateContext.updatedAt}` : ""}.`,
    exchangeRateContext && exchangeRateContext.sourceCurrency !== exchangeRateContext.targetCurrency
      ? `Local currency for this destination is ${exchangeRateContext.sourceCurrency} (1 ${exchangeRateContext.sourceCurrency} ≈ ${exchangeRateContext.rateToTarget} ILS) — this is for your own rough judgment only, you do not need to convert anything yourself.`
      : "",
    `Existing bookings JSON: ${JSON.stringify(bookings, null, 2)}`,
    `Static country guide JSON: ${summarizeCountryKnowledge(knowledge)}`,
    "Use provided candidates first whenever they fit. Preserve chosen candidate names exactly.",
    "Use the candidate list to build neighborhood-based days and realistic meal placement.",
    "Each day may include fewer than five stops when that is more realistic.",
    "Arrival, transfer, hotel-change, or overnight-transport days should be lighter and more practical.",
    "restWindow should be explicit on lighter days, buffer days, laundry/planning days, or recovery mornings.",
    "notes should explain the planning logic of the day, not just repeat the stop names.",
    "transportSegments should be specific and practical, for example: origin -> destination · mode · duration · cost estimate.",
    "Every item's approximatePrice must be a realistic estimate PER PERSON, in the destination's local currency (not ILS) — never the total for the whole group. Do not attempt to convert currency or multiply by traveler count yourself. The system converts every price to ILS and multiplies by traveler count automatically after generation, using the per-person local-currency estimate you provide.",
    "Include realistic accommodationCost, foodCost, transportCost, and activityCost (also in local currency) so the total trip cost includes accommodation, food, local transport, intercity transport, and paid attractions.",
    "Output categoryBreakdown numbers so they sum roughly to the total estimated cost.",
    `Candidate categories JSON: ${JSON.stringify(candidateCategorySummary, null, 2)}`,
    `Candidate areas JSON: ${JSON.stringify(candidateAreaSummary, null, 2)}`,
    `Candidate places JSON: ${JSON.stringify(candidates, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function slotOrderIndex(slot: DayPart) {
  return SLOT_ORDER.indexOf(slot);
}

function defaultSlotTime(slot: DayPart) {
  switch (slot) {
    case "morning":
      return "09:00";
    case "lunch":
      return "12:30";
    case "afternoon":
      return "15:00";
    case "dinner":
      return "19:00";
    case "evening":
      return "21:00";
    case "night":
      return "23:00";
  }
}

function sortItems(items: AiGeneratedItem[]) {
  return [...items].sort((left, right) => {
    if (left.plannedStartTime && right.plannedStartTime) {
      return left.plannedStartTime.localeCompare(right.plannedStartTime);
    }
    return slotOrderIndex(left.slot) - slotOrderIndex(right.slot);
  });
}

function isFoodItem(category: RecommendationCategory) {
  return FOOD_CATEGORIES.has(category);
}

function requiresAccessibilitySupport(payload: AiItineraryRequest) {
  return /נגיש|accessible|wheelchair|מעלית|כסא גלגלים/i.test(
    payload.preferences.accessibilityNeeds
  );
}

function isAccessibilityConflict(
  recommendation: AiItineraryRequest["recommendations"][number],
  payload: AiItineraryRequest
) {
  return requiresAccessibilitySupport(payload) && recommendation.wheelchairAccessible === false;
}

const EXPLICITLY_CLOSED_SIGNALS = [
  "סגור לצמיתות",
  "סגור באופן זמני",
  "אינו פעיל יותר",
  "permanently closed",
  "temporarily closed",
  "no longer open",
  "closed down",
  "out of business",
];

/**
 * Opening-hours source text (Overpass/Gemini free text) is too unreliable
 * for real time-window parsing — a wrong "definitely open" inference would
 * be worse than the current "hours not available" display. This only
 * catches the one case worth acting on: a place explicitly marked closed.
 */
function isExplicitlyClosed(openingHours: string) {
  const text = openingHours.trim().toLowerCase();
  if (!text || text === "לא זמין") return false;
  return EXPLICITLY_CLOSED_SIGNALS.some((signal) => text.includes(signal));
}

const VEGETARIAN_OR_VEGAN_SIGNALS = ["vegetarian", "vegan", "plant-based", "צמחוני", "טבעוני"];
const MEAT_FOCUSED_SIGNALS = [
  "steakhouse",
  "steak house",
  "bbq",
  "barbecue",
  "grill house",
  "meat house",
  "סטייק",
  "סטייקיה",
  "בשרים",
  "צלעות",
  "המבורגריה",
];
const KOSHER_OR_HALAL_SIGNALS = ["kosher", "halal", "כשר", "חלאל"];
const PORK_SIGNALS = ["pork", "bacon", "ham sandwich", "חזיר", "נקניק חזיר"];

/**
 * Hard-conflict check, mirroring `isAccessibilityConflict`'s pattern — only
 * fires on a clear signal pair (e.g. an explicit vegetarian/vegan
 * preference against an explicitly meat-focused venue name), never on
 * ambiguous free text. Dietary preferences are classified as a hard
 * constraint but were previously only a small score nudge; this makes a
 * genuine conflict a real filter instead.
 */
function isDietaryConflict(
  recommendation: AiItineraryRequest["recommendations"][number],
  profile: TripPreferenceProfile
) {
  if (profile.dietaryKeywords.length === 0) return false;
  const text = `${recommendation.name} ${recommendation.category} ${recommendation.shortDescription}`.toLowerCase();

  const wantsVegetarianOrVegan = profile.dietaryKeywords.some((keyword) =>
    VEGETARIAN_OR_VEGAN_SIGNALS.some((signal) => keyword.includes(signal))
  );
  if (wantsVegetarianOrVegan && MEAT_FOCUSED_SIGNALS.some((signal) => text.includes(signal))) {
    return true;
  }

  const wantsKosherOrHalal = profile.dietaryKeywords.some((keyword) =>
    KOSHER_OR_HALAL_SIGNALS.some((signal) => keyword.includes(signal))
  );
  if (wantsKosherOrHalal && PORK_SIGNALS.some((signal) => text.includes(signal))) {
    return true;
  }

  return false;
}

function isAnchorDayItem(
  item: Pick<AiGeneratedItem, "category">
): item is Pick<AiGeneratedItem, "category"> {
  // Real bug found during end-to-end QA generation: a "practical" item is a
  // free-time/logistics filler (see buildFreeTimeItem), never a genuine
  // sightseeing/dining stop — the rest of the codebase already treats it as
  // a non-activity category (see NON_ACTIVITY_CATEGORIES), but this anchor
  // check didn't exclude it. Left in, a filler item's own
  // estimatedDurationMinutes (deliberately set to whatever leftover window
  // it fills, often several hours) gets fed into classifyVisitScale, which
  // has no "practical" branch and so falls through to duration-based
  // inference — misclassifying the filler as a "full_day" anchor. Once
  // resequenceDayItems is re-run on an already-resequenced day (as
  // repairDayGeography does), that fake full-day anchor causes every real
  // anchor AND every meal item to be dropped from the day entirely.
  return !isFoodItem(item.category) && !NON_ACTIVITY_CATEGORIES.has(item.category);
}

// Thread 1 (locked/fixed-time hard requirement): "locked" means the
// activity itself may never be removed/replaced by automatic
// planning/repair; "fixedTime" means its start time may never be shifted
// automatically. Both are treated together here wherever a repair step
// decides what's droppable — a real, previously-reported bug: several
// places (the full-day-anchor branch below, among others) dropped
// non-selected anchors/meals unconditionally, with no exemption for a
// locked or fixed-time item the user (or an earlier repair pass) had
// pinned in place.
function isProtectedItem(item: Pick<AiGeneratedItem, "locked" | "fixedTime">): boolean {
  return item.locked === true || item.fixedTime === true;
}

// Rough clock-time stand-ins for each slot, used only to decide where a
// FLEXIBLE item's neighbors should land relative to a fixed-time item —
// the flexible item's own real time still comes from scheduleDayItems
// afterward. Broad, deliberately approximate ranges are fine here.
const SLOT_APPROX_MINUTES: Record<DayPart, number> = {
  morning: 9 * 60,
  lunch: 12 * 60 + 30,
  afternoon: 15 * 60,
  dinner: 19 * 60,
  evening: 20 * 60 + 30,
  night: 22 * 60,
};

function effectiveOrderMinutes(item: AiGeneratedItem): number {
  if (item.fixedTime) {
    const parsed = clockToMinutes(item.plannedStartTime);
    if (parsed != null) return parsed;
  }
  return SLOT_APPROX_MINUTES[item.slot] ?? 12 * 60;
}

/**
 * A fixed-time item's own real clock time always wins scheduleDayItems's
 * anchor placement regardless of list position, but the FLEXIBLE items
 * around it still get sorted into segments purely by their position in
 * this array — so a fixed-time item needs to sit roughly where it
 * chronologically belongs, not wherever the heuristic anchor/meal
 * ordering above happened to put it, or a flexible item that should
 * really come "after" it could end up in the "before" segment instead.
 * A stable sort keeps every other item's relative order intact (ties
 * broken by original index) — only fixed-time items actually move.
 */
function interleaveFixedTimeItems(items: AiGeneratedItem[]): AiGeneratedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const delta = effectiveOrderMinutes(left.item) - effectiveOrderMinutes(right.item);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.item);
}

function hasValidCoordinates(value: { lat: number | null; lon: number | null }) {
  return value.lat != null && value.lon != null;
}

function normalizeGeneratedItemCoordinates(item: AiGeneratedItem): AiGeneratedItem {
  const coords = normalizeCoordinatePair(item.lat, item.lon);
  return {
    ...item,
    lat: coords.lat,
    lon: coords.lon,
    mapLink: item.mapLink || buildMapLink(item.name, coords.lat, coords.lon),
  };
}

function getOrderedAnchorItems(day: AiGeneratedDay) {
  return sortItems(day.items).filter(isAnchorDayItem);
}

function getRelevantMealAnchors(day: AiGeneratedDay, slot: DayPart) {
  const anchors = getOrderedAnchorItems(day);
  if (anchors.length === 0) {
    return {
      anchor: null as AiGeneratedItem | null,
      nextAnchor: null as AiGeneratedItem | null,
    };
  }

  if (slot === "dinner") {
    return {
      anchor: anchors.at(-1) ?? anchors[0] ?? null,
      nextAnchor: null,
    };
  }

  return {
    anchor: anchors[0] ?? null,
    nextAnchor: anchors[1] ?? null,
  };
}

function getPrimaryAnchor(day: AiGeneratedDay) {
  const anchors = getOrderedAnchorItems(day);
  return (
    anchors.find((item) => item.slot !== "evening" && item.slot !== "night") ??
    anchors[0] ??
    null
  );
}

function sortAnchorsByCluster(day: AiGeneratedDay, anchors: AiGeneratedItem[]) {
  const primaryAnchor = getPrimaryAnchor({ ...day, items: anchors });
  if (!primaryAnchor) return anchors;

  return [...anchors].sort((left, right) => {
    if (left === primaryAnchor) return -1;
    if (right === primaryAnchor) return 1;

    const leftDistance = hasValidCoordinates(primaryAnchor)
      ? haversineKm(primaryAnchor.lat, primaryAnchor.lon, left.lat, left.lon)
      : 0;
    const rightDistance = hasValidCoordinates(primaryAnchor)
      ? haversineKm(primaryAnchor.lat, primaryAnchor.lon, right.lat, right.lon)
      : 0;
    const leftAreaScore = sharesDayArea(left.location, primaryAnchor.location) ? -4 : 0;
    const rightAreaScore = sharesDayArea(right.location, primaryAnchor.location) ? -4 : 0;
    return leftDistance + leftAreaScore - (rightDistance + rightAreaScore);
  });
}

/**
 * Round 4 — for a PHRASE field (a day's `accommodation` / `title`, e.g.
 * "לינה נוחה באזור Chicago", "יום 4 בChicago") vs a bare area label: does
 * the phrase positively NAME that area? Every word of the area label must
 * appear among the phrase's words (superset direction — the phrase has
 * extra fixed template words). Deliberately NOT `sharesDayArea` (which
 * requires equal word-sets and is right for two bare area strings), and
 * deliberately one-directional so "West Virginia" as an area label is not
 * "named" by a "Virginia" phrase.
 */
function phraseNamesArea(phrase: string, areaLabel: string): boolean {
  const areaWords = normalizeAreaLabel(areaLabel).toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
  if (areaWords.length === 0) return false;
  const phraseWords = new Set(phrase.toLowerCase().trim().split(/[\s,·|/]+/).filter(Boolean));
  return areaWords.every((word) => phraseWords.has(word));
}

function sharesDayArea(left: string, right: string) {
  const normalizedLeft = normalizeAreaLabel(left).toLowerCase().trim();
  const normalizedRight = normalizeAreaLabel(right).toLowerCase().trim();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  // Root-cause fix (real replay: a "West Virginia" transition day kept its
  // stale cityRegion). Whole-word-SET equality, not "one string contains
  // the other" — "West Virginia" / "Virginia Beach" must NOT read as the
  // same area as "Virginia", and "York" must not match "New York". A
  // genuine alias with a different word count (e.g. "New York" vs "New
  // York City") deliberately does not match here either; alignDaysToTripFrame
  // then just rewrites cityRegion to the authoritative phase label, which
  // is the intended outcome.
  const leftWords = new Set(normalizedLeft.split(/[\s,]+/).filter(Boolean));
  const rightWords = new Set(normalizedRight.split(/[\s,]+/).filter(Boolean));
  if (leftWords.size === 0 || leftWords.size !== rightWords.size) return false;
  return [...leftWords].every((word) => rightWords.has(word));
}

/**
 * Round 5 — a GENERIC meal-opportunity placeholder ("🍽 recommended lunch
 * time near <area>"), the ONLY food item that is synthetic. It is either
 * explicitly role-tagged (`itemRole === "meal_opportunity"`) or has the
 * structural marker shape isMealOpportunityMarker already recognizes
 * (restaurant/cafe category, NO real coordinates, NO recommendationId) —
 * which ALSO catches a Gemini-authored restaurant that never name-matched
 * a real candidate (enrichAiDay nulls its geometry) and a placeholder
 * whose `itemRole` was dropped on a save/regeneration round-trip. Such an
 * item's area label is pure presentation: normalizeDayOwnershipToFrame
 * regenerates it from the day's canonical owner. It is NEVER put through
 * real-POI geographic legality (there is no coordinate to judge).
 */
function isGenericMealOpportunity(item: Pick<AiGeneratedItem, "itemRole" | "category" | "lat" | "lon" | "recommendationId">): boolean {
  return item.itemRole === "meal_opportunity" || isMealOpportunityMarker(item);
}

/**
 * Round 6 — THE ONE authoritative predicate for "this scheduled item is a
 * real, geographically-concrete place that must pass the final geographic
 * legality rules". Every geography-critical gate
 * (enforceNormalDayLocality, enforceFinalPlaceLegalityGate,
 * validateFinalItineraryInvariants, enforceItineraryInvariantsWithRepair)
 * uses THIS — never its own category allow/deny list. A named venue in
 * ANY real-POI category — attraction, museum, landmark, nature, shopping,
 * restaurant, cafe, bar/nightlife, family, hidden_gem, seasonal_event,
 * day_trip — counts. `category` is NEVER an exemption: a distant museum is
 * exactly as illegal as a distant restaurant or a distant landmark.
 *
 * Excluded — and ONLY these — the true structural / synthetic types:
 *   - a generic meal-opportunity placeholder (isGenericMealOpportunity)
 *   - a free-time / transit-practical synthetic block (isSyntheticScheduleItem)
 *   - the canonical stay-transition item (isStayTransitionItem)
 *   - `practical` (a logistics filler)
 *   - `transportation` / `hotel` — semantic-role slots, judged by
 *     enforceTransportRoleGuard, not by place geography.
 */
function isScheduledRealPlace(
  item: Pick<AiGeneratedItem, "itemRole" | "category" | "lat" | "lon" | "recommendationId" | "canonicalPlaceId">
): boolean {
  if (isSyntheticScheduleItem(item)) return false;
  if (isStayTransitionItem(item)) return false;
  if (isGenericMealOpportunity(item)) return false;
  if (item.category === "practical" || item.category === "transportation" || item.category === "hotel") return false;
  return true;
}

/** Round 9.4 §M/§N — every real-activity identity currently scheduled, for diffRealActivitySnapshots' before/after comparisons. Meal venues excluded on purpose (activities and meals are tracked as separate conservation lines everywhere else in this round's logging). */
export function snapshotRealActivities(days: AiGeneratedDay[]): RealActivityIdentitySnapshot[] {
  const snapshot: RealActivityIdentitySnapshot[] = [];
  for (const day of days) {
    for (const item of day.items) {
      if (!isScheduledRealPlace(item) || item.category === "restaurant" || item.category === "cafe") continue;
      snapshot.push({ id: item.recommendationId ?? `coords:${item.lat}:${item.lon}:${item.name}`, name: item.name, dayNumber: day.dayNumber });
    }
  }
  return snapshot;
}

/**
 * Round 9.4.1 §B/§D — the ONE shared classification every repair-step
 * trace uses (never a bespoke per-step classifier). Identity is tracked
 * by recommendationId when the item genuinely has one; a coords+name key
 * otherwise — NEVER name alone (spec §D). `hasRecommendationId` is kept
 * separate from the identity string itself so a real item "recreated
 * without their ID" (same coords/name, but the id field is now null) is
 * detected as a genuine identity downgrade, not silently treated as
 * "unchanged" just because the derived key happens to still match.
 */
export function snapshotDayItemsForRepairTrace(days: AiGeneratedDay[], tripFrame: TripFrame): RepairSnapshotItem[] {
  const snapshot: RepairSnapshotItem[] = [];
  for (const day of days) {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    for (const item of day.items) {
      const isReal = isScheduledRealPlace(item);
      const isMeal = item.category === "restaurant" || item.category === "cafe";
      const kind: RepairSnapshotItem["kind"] = isReal
        ? isMeal
          ? "real_meal"
          : "real_activity"
        : isGenericMealOpportunity(item)
          ? "meal_opportunity"
          : isSyntheticScheduleItem(item)
            ? "synthetic_activity"
            : "other";
      snapshot.push({
        id: item.recommendationId ?? `coords:${item.lat}:${item.lon}:${normalizePlaceNameSlug(item.name)}`,
        name: item.name,
        category: item.category,
        itemRole: item.itemRole ?? null,
        phaseId: phase?.id ?? null,
        dayNumber: day.dayNumber,
        lat: item.lat,
        lon: item.lon,
        kind,
        hasRecommendationId: item.recommendationId != null,
      });
    }
  }
  return snapshot;
}

/**
 * Round 9.4.1 §B — THE shared wrapper every mutating repair primitive in
 * repairPlan's attempt loop goes through, so no step needs hand-written
 * logging logic of its own (spec: "Do not hand-write different logging
 * logic for every step"). A true no-op wrapper shape — `transform` is
 * always called exactly once, its return value is always what's returned,
 * so wrapping a step can never change what it does, only what gets
 * observed around it. Logging itself is cheap-gated inside
 * logRepairStepDelta (via logRealPlaceQA's own isPlannerQaTraceEnabled
 * check), but the before/after snapshots are still computed unconditionally
 * here — acceptable for a forensics-only round, never claimed as a
 * zero-cost primitive.
 */
function traceRepairStep(
  attempt: number,
  stepIndex: number,
  stepName: string,
  tripFrame: TripFrame,
  days: AiGeneratedDay[],
  transform: () => AiGeneratedDay[]
): AiGeneratedDay[] {
  if (!isPlannerQaTraceEnabled()) return transform();
  const before = snapshotDayItemsForRepairTrace(days, tripFrame);
  const after = transform();
  const afterSnapshot = snapshotDayItemsForRepairTrace(after, tripFrame);
  logRepairStepDelta(attempt, stepIndex, stepName, before, afterSnapshot);
  return after;
}

/**
 * Round 7 — the effective activity duration for opening-hours legality:
 * the SAME visit-duration model the real scheduler uses
 * (resolveVisitDurationMinutes / classifyVisitScale), never a separate
 * invented number. A reservation-required venue with its own explicit
 * estimate keeps it; everything else is clamped into its visit-scale range.
 */
function effectiveActivityDurationMinutes(item: AiGeneratedItem): number {
  return resolveVisitDurationMinutes(item, classifyVisitScale(item));
}

/**
 * Round 7 — THE authoritative opening-hours legality verdict for one
 * scheduled item on one calendar day. Applies ONLY to real scheduled
 * venues (isScheduledRealPlace); generic meal-opportunity / free-time /
 * transit-practical / stay-transition items have no real opening-hours
 * constraint and always return LEGAL. Judges the whole activity interval
 * `[start, start + effectiveDuration]` against the structured opening
 * intervals for the item's own local weekday (day.date). Unknown/garbled
 * hours → UNKNOWN (never a violation, never "legal evidence").
 */
function evaluateItemOpeningHoursLegality(
  item: AiGeneratedItem,
  dayDate: string
): { status: OpeningHoursLegalityStatus; parsedKind: "known" | "always" | "closed" | "unknown" } {
  if (!isScheduledRealPlace(item)) return { status: "LEGAL", parsedKind: "always" };
  const parsed = parseOpeningHours(item.openingHours);
  if (parsed.kind === "unknown") return { status: "UNKNOWN", parsedKind: "unknown" };
  const startMinutes = clockToMinutes(item.plannedStartTime);
  if (startMinutes == null || !dayDate) return { status: "UNKNOWN", parsedKind: parsed.kind };
  const legacyWindow = parseOpeningHoursWindow(item.openingHours);
  const lastEntryMinutes = legacyWindow ? resolveLastEntryMinutes(item, legacyWindow) : null;
  const result = evaluateOpeningHoursLegality({
    localDate: dayDate,
    startMinutes,
    durationMinutes: effectiveActivityDurationMinutes(item),
    parsed,
    lastEntryMinutes: lastEntryMinutes != null && legacyWindow && lastEntryMinutes < legacyWindow.closesMinutes ? lastEntryMinutes : null,
  });
  return { status: result.status, parsedKind: parsed.kind };
}

/** Round 7 — a real venue with parseable hours that genuinely cannot contain its scheduled activity interval (not UNKNOWN, not LEGAL). */
function itemHasKnownOpeningHoursViolation(item: AiGeneratedItem, dayDate: string): boolean {
  return isKnownHoursViolation(evaluateItemOpeningHoursLegality(item, dayDate).status);
}

/**
 * Round 6 — THE coordinate-having twin of enforceNormalDayLocality's
 * coordinate-less `matchesOwnArea`/`matchedOtherPhase` text check. A single
 * trip-wide `localityRadiusKm` (120 km on the sparse tier) can otherwise
 * accept a POI in an entirely different metro/region simply because the
 * raw kilometres land under that one number (the real replay: the
 * Smithsonian, "Washington, DC", ~80 km from a West Virginia panhandle
 * base — inside 120 km).
 *
 * The rule, coordinate-anchored and threshold-free: a real POI is
 * "elsewhere" when its OWN `location` text positively names a known area
 * (a pool-derived areaAnchors label OR a TripFrame phase) that does NOT
 * share the day owner, AND its coordinates are genuinely CLOSER to that
 * named area's anchor than to this day's own base anchor. i.e. the item
 * is really sitting in the place its text says it is, and that place is
 * not this day's base. A POI whose text names the owner (e.g. "Harpers
 * Ferry, West Virginia" on a "West Virginia" day) returns early — never
 * flagged. Worldwide/generic — the item's own text + coordinates vs. the
 * trip's own known areas; no place names, no distance constant.
 */
function realPlaceNamesADifferentKnownArea(
  placeLat: number | null,
  placeLon: number | null,
  locationText: string,
  ownerAreaLabel: string,
  ownAnchor: { lat: number; lon: number } | null | undefined,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  tripFrame: TripFrame
): { matched: boolean; areaLabel?: string } {
  const text = locationText.trim();
  if (!text) return { matched: false };
  if (resolveTextualAreaMatch(text, ownerAreaLabel)) return { matched: false }; // its own text names the owner — fine
  if (placeLat == null || placeLon == null || !ownAnchor) return { matched: false }; // coord-less handled elsewhere
  const ownDistanceKm = haversineKm(ownAnchor.lat, ownAnchor.lon, placeLat, placeLon);

  const candidateLabels = new Set<string>();
  for (const [label] of areaAnchors) candidateLabels.add(label);
  for (const phase of tripFrame.phases) candidateLabels.add(phase.areaLabel);

  for (const label of candidateLabels) {
    if (sharesDayArea(label, ownerAreaLabel)) continue; // the owner's own area / an alias of it
    if (!resolveTextualAreaMatch(text, label)) continue; // the item's text does not name THIS area
    const anchor = areaAnchors.get(label);
    if (!anchor) continue;
    const otherDistanceKm = haversineKm(anchor.lat, anchor.lon, placeLat, placeLon);
    if (otherDistanceKm < ownDistanceKm) return { matched: true, areaLabel: label };
  }
  return { matched: false };
}

/**
 * Assigns a real slot label matching a scheduled clock time — purely
 * cosmetic/UI grouping now that plannedStartTime itself is the real source
 * of truth (from scheduleDayItems), not the other way around.
 */
function slotForClockTime(minutes: number): DayPart {
  if (minutes < 11 * 60) return "morning";
  if (minutes < 15 * 60) return "lunch";
  if (minutes < 18 * 60) return "afternoon";
  if (minutes < 20 * 60) return "dinner";
  if (minutes < 22 * 60) return "evening";
  return "night";
}

export function resequenceDayItems(day: AiGeneratedDay) {
  const normalizedItems = sortItems(day.items.map(normalizeGeneratedItemCoordinates));
  const transferDay = isIntercityTransferDay(day);

  if (transferDay) {
    const ordered = interleaveFixedTimeItems(
      normalizedItems.map((item, index) => ({
        ...item,
        slot:
          item.category === "transportation" && !item.fixedTime
            ? index === 0
              ? ("morning" as DayPart)
              : ("afternoon" as DayPart)
            : item.slot,
      }))
    );
    const { items: scheduled, overflowItems, fixedTimeConflicts } = scheduleDayItems(ordered, DEFAULT_DAY_WINDOW, day.cityRegion);
    return {
      ...day,
      items: scheduled.map((item) => ({
        ...item,
        // A meal item's slot (lunch/dinner) is what collectPlanDiagnostics's
        // missingMeals check actually keys off — real, semantic, must
        // survive scheduling regardless of what clock time the day's
        // timeline happens to push it to (same protection transportation
        // already gets on the line above; a real bug from a live
        // generation run: a lunch/dinner placeholder drifting to a
        // clock-derived "night" slot made missingMeals impossible to ever
        // close to 0 for a sparsely-filled day).
        slot:
          item.category === "transportation" || isFoodItem(item.category) || item.fixedTime
            ? item.slot
            : slotForClockTime(clockToMinutes(item.plannedStartTime) ?? 9 * 60),
      })),
      warnings: buildFixedTimeConflictWarnings(day, fixedTimeConflicts),
      alternatives: appendOverflowAlternatives(day.alternatives, overflowItems),
    };
  }

  const transportationItems = normalizedItems.filter((item) => item.category === "transportation");
  const anchorCandidates = sortAnchorsByCluster(
    day,
    normalizedItems.filter((item) => isAnchorDayItem(item))
  );
  const mealItems = normalizedItems.filter((item) => isFoodItem(item.category));
  const nonAnchorSupportingItems = normalizedItems.filter(
    (item) =>
      item.category !== "transportation" &&
      !isFoodItem(item.category) &&
      !isAnchorDayItem(item)
  );

  // A full-day anchor (Disneyland, a national park, ...) consumes the day's
  // entire planning capacity — spec item 12 explicitly: "Do not add Louvre
  // or Eiffel Tower afterward." Any other anchor that day moves to
  // alternatives instead of silently disappearing — UNLESS it's locked or
  // fixed-time (Thread 1: locked/fixed-time items may never be
  // automatically removed), in which case it's kept alongside the
  // full-day anchor no matter what the general heuristic would prefer.
  const fullDayAnchor = anchorCandidates.find((item) => classifyVisitScale(item) === "full_day");
  const protectedOtherAnchors = fullDayAnchor
    ? anchorCandidates.filter((item) => item !== fullDayAnchor && isProtectedItem(item))
    : [];
  const anchorItems = fullDayAnchor ? [fullDayAnchor, ...protectedOtherAnchors] : anchorCandidates;
  const droppedAnchors = fullDayAnchor
    ? anchorCandidates.filter((item) => item !== fullDayAnchor && !isProtectedItem(item))
    : [];

  const lunch =
    mealItems.find((item) => item.slot === "lunch") ??
    mealItems.find((item) => item.category === "cafe") ??
    mealItems[0] ??
    null;
  const dinner =
    mealItems.find((item) => item.slot === "dinner") ??
    mealItems.find((item) => item !== lunch) ??
    null;
  // Thread 1: a locked/fixed-time meal survives even on a full-day-anchor
  // day, where meals are normally omitted entirely (spec item 12's "do not
  // add [more]" applies to auto-added content, not to something the user
  // or an earlier repair pass explicitly pinned).
  const keepLunch = !fullDayAnchor || (lunch && isProtectedItem(lunch));
  const keepDinner = !fullDayAnchor || (dinner && isProtectedItem(dinner) && dinner !== lunch);
  const leftoverMeals = fullDayAnchor
    ? mealItems.filter((item) => item !== lunch && item !== dinner && isProtectedItem(item))
    : mealItems.filter((item) => item !== lunch && item !== dinner);
  const protectedSupportingItems = fullDayAnchor
    ? nonAnchorSupportingItems.filter((item) => isProtectedItem(item))
    : nonAnchorSupportingItems;
  const firstHalfCount = anchorItems.length >= 3 ? 2 : Math.min(anchorItems.length, 1);
  const firstHalfAnchors = anchorItems.slice(0, firstHalfCount);
  const secondHalfAnchors = anchorItems.slice(firstHalfCount);
  const preOrdered = [
    ...transportationItems.filter((item) => item.slot === "morning"),
    ...firstHalfAnchors,
    ...(keepLunch && lunch ? [lunch] : []),
    ...secondHalfAnchors,
    ...(keepDinner && dinner ? [dinner] : []),
    ...leftoverMeals,
    ...transportationItems.filter((item) => item.slot !== "morning"),
    ...protectedSupportingItems,
  ];
  // A fixed-time item's real clock time always wins in scheduleDayItems
  // regardless of list position, but the flexible items around it are
  // still assigned to segments purely by position in this array — so it
  // needs to sit roughly where it chronologically belongs first (Thread 1
  // item 2: fixed-time items act as timeline anchors, with everything
  // else filled in around them, never the other way around).
  const ordered = interleaveFixedTimeItems(preOrdered);

  const { items: scheduled, freeTimeItem, overflowItems, fixedTimeConflicts } = scheduleDayItems(ordered, DEFAULT_DAY_WINDOW, day.cityRegion);
  const withSlots = scheduled.map((item) => ({
    ...item,
    // See the identical exemption + reasoning in this function's transfer-day
    // branch above — a meal's lunch/dinner slot is semantic (collectPlanDiagnostics
    // keys off it directly) and must survive scheduling drift. A fixed-time
    // item's slot is likewise left untouched — it's frequently the only
    // remaining signal (alongside the pinned time itself) of what kind of
    // moment this was meant to be.
    slot:
      item.category === "transportation" || isFoodItem(item.category) || item.fixedTime
        ? item.slot
        : slotForClockTime(clockToMinutes(item.plannedStartTime) ?? 9 * 60),
  }));

  return {
    ...day,
    items: freeTimeItem ? [...withSlots, freeTimeItem] : withSlots,
    warnings: buildFixedTimeConflictWarnings(day, fixedTimeConflicts),
    alternatives: appendOverflowAlternatives(
      droppedAnchors.length > 0
        ? normalizeActionableMessages([...day.alternatives, ...droppedAnchors.map((item) => item.name)])
        : day.alternatives,
      overflowItems
    ),
  };
}

/**
 * Thread 1 item 6/7: a non-fixed item that structurally can't fit around a
 * fixed-time anchor is never silently overlapped or dropped without a
 * trace — it moves to alternatives (the same "we'd have liked to include
 * this" bucket droppedAnchors already uses) so a human can see it and
 * decide, rather than the item just vanishing.
 */
function appendOverflowAlternatives(alternatives: string[], overflowItems: AiGeneratedItem[]): string[] {
  if (overflowItems.length === 0) return alternatives;
  return normalizeActionableMessages([
    ...alternatives,
    ...overflowItems.map((item) => `${item.name} (לא נכנס סביב פעילות בשעה קבועה)`),
  ]);
}

/**
 * Thread 1 item 7: two fixed-time items that genuinely cannot both be
 * honored (their own times, plus real travel between them, overlap) is a
 * legitimate hard failure — surfaced as a visible warning here (and as
 * structured PlanDiagnostics.fixedTimeConflicts, see
 * itinerary-generation-constraints.ts) rather than silently resolved by
 * moving either one.
 */
function buildFixedTimeConflictWarnings(day: AiGeneratedDay, conflicts: FixedTimeConflict[]): string[] {
  if (conflicts.length === 0) return day.warnings;
  return normalizeActionableMessages([
    ...day.warnings,
    ...conflicts.map(
      (conflict) =>
        `התנגשות בין שתי פעילויות בשעה קבועה: "${conflict.activityA}" (${conflict.startA}–${conflict.endA}) ו"${conflict.activityB}" (מתחילה ${conflict.startB}, דורשת ${conflict.travelMinutesRequired} דק' נסיעה) — לא ניתן לקיים את שתיהן כמתוכנן.`
    ),
  ]);
}

/**
 * Must match collectPlanDiagnostics's own missingMeals check
 * (itinerary-generation-constraints.ts) exactly — that hard validation
 * gate requires both lunch and dinner unconditionally, on every day, with
 * no exemption for a light/transfer/arrival day. This function used to
 * only insert a missing meal when the day already had a same-period
 * activity (hasDaytimeActivity/hasEveningActivity) — a real bug: on a day
 * whose raw AI output happened to have no daytime or evening activity at
 * all (a real, observed case from a live generation run), repair would
 * never insert the missing meal, missingMeals would stay non-zero
 * forever, and the whole plan would repeatedly fail validation and fall
 * back to the generic template. Always filling both slots keeps repair
 * and validation in agreement, so the loop can actually converge.
 */
export function findMissingMealSlots(items: AiGeneratedItem[]) {
  const missingSlots: DayPart[] = [];
  const hasLunch = items.some((item) => item.slot === "lunch" && isFoodItem(item.category));
  const hasDinner = items.some((item) => item.slot === "dinner" && isFoodItem(item.category));

  if (!hasLunch) missingSlots.push("lunch");
  if (!hasDinner) missingSlots.push("dinner");

  return missingSlots;
}

/** DayPart meal slot -> the meal-cuisine-taxonomy MealType it must have real suitability evidence for (spec §9's "cafe lunch rule"). scoreMealCandidate is only ever called with "lunch"/"dinner" in practice; any other DayPart falls back to LUNCH's own gate rather than throwing. */
const MEAL_SLOT_TO_MEAL_TYPE: Partial<Record<DayPart, MealType>> = { lunch: "LUNCH", dinner: "DINNER" };

/** A hard-ish exclusion score (spec §9/§21 — never an outright thrown error, since callers still want a comparable number for diagnostics, but no selection path in this file ever prefers a mealTypeFit:false candidate to a fit:true one or to the synthetic fallback). */
const MEAL_TYPE_MISMATCH_SCORE = -1000;

export function scoreMealCandidate(
  recommendation: AiItineraryRequest["recommendations"][number],
  day: AiGeneratedDay,
  slot: DayPart,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>,
  payload: AiItineraryRequest,
  /** Round 9.2.1 §12 — trip-wide cuisine memory, threaded the same way usedMealNames is (shared, appended-to by the caller after each real selection). Optional/defaulted so every pre-existing call site keeps compiling unchanged. */
  recentMealHistory: RecentMealHistoryEntry[] = [],
  dayIndex: number = day.dayNumber,
  cuisineWeights: Record<CuisineFamily, number> = EMPTY_CUISINE_WEIGHTS
) {
  const { anchor, nextAnchor } = getRelevantMealAnchors(day, slot);
  const isExplicitMealRequest = payload.selectedPlaces.some((place) => place.id === recommendation.id);

  // Round 9.2.1 §7-9 — THE meal-type-suitability gate. Evidence-based
  // (category baseline + keyword + opening-hours-window, never "it's
  // open" alone) — replaces the old, evidence-free
  // `slot === "lunch" && category === "cafe" -> +18` heuristic that let
  // any cafe satisfy any meal merely by category. A candidate with no
  // suitability evidence for THIS exact slot is excluded, never nudged.
  const mealClassification = classifyMealVenue({
    category: recommendation.category,
    name: recommendation.name,
    shortDescription: recommendation.shortDescription,
    openingHours: recommendation.openingHours,
    recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
    approximatePrice: recommendation.approximatePrice,
    reservationRequired: recommendation.reservationRequired,
  });
  const requiredMealType = MEAL_SLOT_TO_MEAL_TYPE[slot] ?? "LUNCH";
  if (!mealClassification.suitableMealTypes.includes(requiredMealType)) {
    return MEAL_TYPE_MISMATCH_SCORE;
  }

  // A real, evidence-based fit bonus (spec §8/§11's own "mealTypeFit" scoring
  // term) — replaces the old category-only `slot==="lunch"&&category==="cafe"`
  // style bonus with the same magnitude, but now genuinely earned: only
  // reached once the venue has ACTUAL suitability evidence for this exact
  // slot (the gate above), never merely because its raw category happens to
  // match.
  let score = 18;
  const mealTransportation =
    recommendation.category === "cafe"
      ? "הליכה"
      : payload.preferences.transportationPreferences ||
        day.transportation ||
        "תחבורה מקומית";
  // A restaurant reached on foot must be much closer than one reached by
  // transit/car/taxi from the last place — 20 minutes walking, 45 minutes
  // otherwise (tighter than the general MAX_LOCAL_TRAVEL_MINUTES, which
  // still applies to non-food replacements).
  const mealHardLimit = mealTransportation.includes("הליכה") ? MEAL_MAX_WALKING_MINUTES : MEAL_MAX_TRAVEL_MINUTES;
  const proximity = scoreRouteProximity(recommendation, {
    anchor,
    nextStop: nextAnchor,
    pace: payload.preferences.tripPace,
    transportation: mealTransportation,
    hardLimitMinutes: mealHardLimit,
    idealLimitMinutes: IDEAL_LOCAL_TRAVEL_MINUTES,
    explicitRequest: isExplicitMealRequest,
  });

  if (
    recommendation.recommendedTimeOfDay === slot ||
    recommendation.recommendedTimeOfDay === "any"
  ) {
    score += 10;
  }

  score += proximity.score;
  score += scoreBudgetFitness(recommendation, slot, profile);

  if (usedMealNames.has(recommendation.name.trim().toLowerCase())) {
    score -= 35;
  }

  if (!profile.luxuryEnabled && isPremiumVenue({ name: recommendation.name, approximatePrice: recommendation.approximatePrice })) {
    score -= 28;
  }

  if (
    profile.dietaryKeywords.length > 0 &&
    !includesAnyKeyword(
      `${recommendation.name} ${recommendation.shortDescription} ${recommendation.location}`,
      profile.dietaryKeywords
    )
  ) {
    score -= 4;
  }

  if (isExplicitlyClosed(recommendation.openingHours)) {
    score -= 40;
  }

  if (anchor) {
    const anchorArea = normalizeAreaLabel(anchor.location).toLowerCase();
    const candidateArea = normalizeAreaLabel(recommendation.location).toLowerCase();

    if (
      anchorArea &&
      candidateArea &&
      (candidateArea.includes(anchorArea) || anchorArea.includes(candidateArea))
    ) {
      score += 28;
    }

    const km = haversineKm(anchor.lat, anchor.lon, recommendation.lat, recommendation.lon);
    if (km > 0 && km <= 1.5) score += 30;
    else if (km > 0 && km <= 3) score += 20;
    else if (km > 0 && km <= 6) score += 8;
  }

  if (proximity.exceedsLimit && !isExplicitMealRequest) {
    score -= 36;
  }

  if (recommendation.approximatePrice != null) score += 2;

  // Round 9.2.1 §11/§13/§14 — cuisine preference + local-relevance bonuses,
  // always soft, never enough alone to override a bad route/budget fit.
  const cuisineWeight = Math.max(1, ...mealClassification.cuisineFamilies.map((f) => cuisineWeights[f] ?? 1), 1);
  score += Math.round((cuisineWeight - 1) * 20);
  if (mealClassification.cuisineFamilies.includes("LOCAL_TRADITIONAL")) score += 10;

  // Round 9.2.1 §12 — soft trip-wide cuisine repetition penalty (never a
  // hard ban — a genuinely scarce destination can still repeat, spec §12/§27).
  score -= computeMealCuisineRecencyPenalty(mealClassification, recentMealHistory, dayIndex);

  return score;
}

export function pickNearbyMealRecommendation(
  payload: AiItineraryRequest,
  day: AiGeneratedDay,
  slot: DayPart,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>,
  /** Round 9.2.1 §12 — optional, defaulted so every pre-existing call site keeps compiling unchanged. See scoreMealCandidate's own doc. */
  recentMealHistory: RecentMealHistoryEntry[] = [],
  dayIndex: number = day.dayNumber,
  cuisineWeights: Record<CuisineFamily, number> = EMPTY_CUISINE_WEIGHTS
) {
  const usedNames = new Set(day.items.map((item) => item.name.trim().toLowerCase()));
  const baseCandidates = [...payload.recommendations, ...payload.selectedPlaces]
    .filter((recommendation) => isFoodItem(recommendation.category))
    .filter((recommendation) => !isAccessibilityConflict(recommendation, payload))
    .filter((recommendation) => !isDietaryConflict(recommendation, profile))
    .filter((recommendation) => !usedNames.has(recommendation.name.trim().toLowerCase()));

  // A trip-wide repeat is excluded outright (spec item 42) whenever a real
  // alternative exists — only falls back to allowing one when every
  // remaining candidate has already been used elsewhere in the trip, so a
  // sparse destination's candidate pool running out never leaves a day
  // without a meal at all.
  const neverUsedCandidates = baseCandidates.filter(
    (recommendation) => !usedMealNames.has(recommendation.name.trim().toLowerCase())
  );
  const candidates = neverUsedCandidates.length > 0 ? neverUsedCandidates : baseCandidates;

  // Generic worldwide architecture (Phase 5/16): a hard reject, not just a
  // scoring penalty — real bug found in live QA: with the old unconditional
  // "closeEnough ?? ranked[0]" fallback, if every real recommendation in
  // the whole trip happened to score poorly here (e.g. the candidate pool
  // skews toward a different city entirely), this still returned the
  // least-bad one rather than admitting nothing real fits — inserting a
  // restaurant from another city into the route. The caller already has a
  // graceful synthetic placeholder for exactly this case
  // (buildFallbackMealPlaceholder); this now returns null and lets it be
  // used instead of ever placing a genuinely wrong-city meal.
  // A meal is never justified by day-trip exemption logic (spec §I "category
  // must not grant geographic privilege" — the same principle applies to
  // day TYPE here: nobody plans a genuine day trip purely to eat somewhere
  // far away) — always judged by real distance to this day's own anchors,
  // regardless of how the day itself is classified.
  const geographicallyCompatible = candidates.filter((recommendation) =>
    isCandidateGeographicallyCompatibleWithDay(recommendation, day.items, {})
  );

  const ranked = geographicallyCompatible
    .map((recommendation) => ({
      recommendation,
      score: scoreMealCandidate(
        recommendation,
        day,
        slot,
        profile,
        usedMealNames,
        payload,
        recentMealHistory,
        dayIndex,
        cuisineWeights
      ),
    }))
    .sort((left, right) => right.score - left.score);

  return ranked.find((entry) => entry.score > -20)?.recommendation ?? null;
}

function buildSupplementalMealItem(
  recommendation: AiItineraryRequest["recommendations"][number],
  slot: DayPart,
  day: AiGeneratedDay,
  payload: AiItineraryRequest
): AiGeneratedItem {
  const sortedItems = sortItems(day.items);
  const { anchor } = getRelevantMealAnchors(day, slot);
  const coords = normalizeCoordinatePair(recommendation.lat, recommendation.lon);
  const referenceItem =
    anchor ??
    (slot === "dinner"
      ? sortedItems.at(-1) ?? null
      : sortedItems.find((item) => item.slot === "morning" || item.slot === "afternoon") ??
        sortedItems[0] ??
        null);

  const travelMinutes =
    referenceItem == null
      ? 0
      : estimateTravelMinutes(
          referenceItem.lat,
          referenceItem.lon,
          coords.lat,
          coords.lon,
          payload.preferences.tripPace,
          recommendation.category === "cafe" ? "הליכה" : payload.preferences.transportationPreferences || "תחבורה מקומית"
        );

  return {
    name: recommendation.name,
    category: recommendation.category,
    location: recommendation.location,
    shortDescription:
      recommendation.shortDescription ||
      (slot === "lunch"
        ? `עצירת אוכל באזור ${normalizeAreaLabel(recommendation.location)} כדי לשמור על יום גאוגרפי נוח.`
        : `ארוחת ערב נוחה באזור ${normalizeAreaLabel(recommendation.location)} לסיום היום בלי נסיעה מיותרת.`),
    slot,
    plannedStartTime: defaultSlotTime(slot),
    estimatedDurationMinutes:
      recommendation.estimatedDurationMinutes ?? (slot === "lunch" ? 60 : 75),
    ...resolveItemPriceFields(recommendation.approximatePrice, recommendation, null, payload.preferences.travelers),
    travelMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
    lastEntryTime: "",
    canonicalPlaceId: resolveCanonicalPlaceId({ recommendationId: recommendation.id, lat: coords.lat, lon: coords.lon }),
    reservationRequired: recommendation.reservationRequired,
    transportation:
      recommendation.category === "cafe"
        ? "הליכה"
        : payload.preferences.transportationPreferences || day.transportation || "תחבורה מקומית",
    mapLink: recommendation.mapLink || buildMapLink(recommendation.name, coords.lat, coords.lon),
    lat: coords.lat,
    lon: coords.lon,
    bookingWarning: recommendation.reservationRequired ? "כדאי לבדוק זמינות או להזמין מראש." : "",
    alternativeSuggestion: "",
    recommendationId: recommendation.id,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

// Section "MEAL OPPORTUNITIES" — when no real restaurant candidate exists,
// this must read as a TIMELINE SLOT, never as an invented business (spec
// "REMOVE GENERIC FAKE RESTAURANTS": no fake name that could pass for a
// real place). The 🍽 prefix and "recommended time" phrasing are the whole
// discriminator client-side needs — combined with the existing
// lat:null/lon:null/recommendationId:null already set below (the SAME
// isRealPlace signal used everywhere else in this codebase), a meal
// opportunity is unambiguously not a real establishment. Kept as a
// rotation (not one fixed string) for the same reason as
// buildFreeExplorationReplacement's rotation just below — a fixed
// name+area repeated across days with no id/coordinates would otherwise
// read as a duplicate place to buildItemKey's fallback tier.
const FALLBACK_LUNCH_MEAL_PHRASES = [
  (area: string) => `🍽 זמן מומלץ לארוחת צהריים באזור ${area}`,
  (area: string) => `🍽 חלון זמן גמיש לארוחת צהריים ליד ${area}`,
  (area: string) => `🍽 הפסקת צהריים מומלצת באזור ${area}`,
];
const FALLBACK_DINNER_MEAL_PHRASES = [
  (area: string) => `🍽 זמן מומלץ לארוחת ערב באזור ${area}`,
  (area: string) => `🍽 חלון זמן גמיש לארוחת ערב ליד ${area}`,
  (area: string) => `🍽 הפסקת ערב מומלצת באזור ${area}`,
];

export function buildFallbackMealPlaceholder(
  day: AiGeneratedDay,
  slot: DayPart,
  payload: AiItineraryRequest,
  usedMealNames: Set<string> = new Set()
): AiGeneratedItem {
  const area = normalizeAreaLabel(day.cityRegion || day.items[0]?.location || payload.countryName);
  const isLunch = slot === "lunch";
  const phrases = isLunch ? FALLBACK_LUNCH_MEAL_PHRASES : FALLBACK_DINNER_MEAL_PHRASES;
  const startIndex = day.dayNumber % phrases.length;
  // Real bug found during end-to-end QA generation: a fixed 3-phrase
  // rotation keyed only on dayNumber % phrases.length collides on every
  // 3rd day for any trip long enough that the area label repeats (day 1
  // and day 4 land on the exact same phrase+area string) —
  // duplicateRestaurants is a hard validation gate, so this alone could
  // fail an otherwise-good real Gemini plan and force a fallback to the
  // generic template. Walk the rotation for a name not already used
  // anywhere else in the trip, the same usedMealNames convention
  // pickNearbyMealRecommendation already uses for real candidates.
  let name = "";
  for (let offset = 0; offset < phrases.length; offset += 1) {
    const candidate = phrases[(startIndex + offset) % phrases.length](area);
    if (!usedMealNames.has(candidate.trim().toLowerCase())) {
      name = candidate;
      break;
    }
  }
  if (!name) {
    // Every phrase variant for this area is already used somewhere in the
    // trip (an unusually long, fully candidate-starved trip) — append the
    // day number so the string stays genuinely unique instead of quietly
    // duplicating and failing validation again.
    name = `${phrases[startIndex](area)} (יום ${day.dayNumber})`;
  }
  return {
    name,
    category: isLunch ? "cafe" : "restaurant",
    itemRole: "meal_opportunity",
    location: area,
    shortDescription: isLunch
      ? `זהו חלון זמן מומלץ לארוחת צהריים באזור ${area} — לא מסעדה קונקרטית. אפשר לבחור מסעדה אמיתית וקרובה בלשונית "אוכל".`
      : `זהו חלון זמן מומלץ לארוחת ערב באזור ${area} — לא מסעדה קונקרטית. אפשר לבחור מסעדה אמיתית וקרובה בלשונית "אוכל".`,
    slot,
    plannedStartTime: defaultSlotTime(slot),
    estimatedDurationMinutes: isLunch ? 60 : 75,
    approximatePrice: null,
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: 10,
    openingHours: "לא זמין",
    lastEntryTime: "",
    canonicalPlaceId: "",
    reservationRequired: false,
    transportation: "הליכה",
    mapLink: buildMapLink(area, null, null),
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

export function fillDerivedDayFields(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile?: TripPreferenceProfile
): AiGeneratedDay {
  const sourceItems = sortItems(day.items.map(normalizeGeneratedItemCoordinates));
  const items = sourceItems.map((item, index, currentItems) => {
      const previous = index > 0 ? currentItems[index - 1] : null;
      // Real coordinates always win over a Gemini-stated travelMinutes —
      // that field is optional in the schema and Gemini has no actual
      // geographic computation ability, so an unchecked value from it is
      // pattern-matched noise (a real 46-day US trip logged the exact
      // same ~145min for Oregon, New York, Alaska, Chicago, Nevada and
      // Santa Cruz stops — physically impossible, since nothing was ever
      // computed from their real distance at all). estimateTravelMinutes
      // itself is unbounded and monotonic in km; the only reason a
      // description of "40 hours" ever collapsed to something like
      // "2 hours" was that this branch never called it in the first
      // place. Only exception: a synthetic stay-transition item
      // (buildStayTransitionItem) already carries a real, mode-aware
      // estimate from buildStayTransitions (estimateMinutesForMode,
      // which knows this is a flight/train/car — not the flat
      // walking/car/other speed table below) — never second-guess that
      // with the generic estimate.
      const isStayTransitionItem = item.canonicalPlaceId?.startsWith("transition:") ?? false;
      const travelMinutes = isStayTransitionItem
        ? (item.travelMinutes ?? 0)
        : previous && hasValidCoordinates(previous) && hasValidCoordinates(item)
          ? estimateTravelMinutes(
              previous.lat,
              previous.lon,
              item.lat,
              item.lon,
              payload.preferences.tripPace,
              item.transportation ||
                day.transportation ||
                payload.preferences.transportationPreferences ||
                "תחבורה מקומית"
            )
          : item.travelMinutes != null && item.travelMinutes > 0
            ? item.travelMinutes
            : 0;

      return {
        ...item,
        plannedStartTime: item.plannedStartTime || defaultSlotTime(item.slot),
        travelMinutes,
        transportation:
          item.transportation ||
          day.transportation ||
          payload.preferences.transportationPreferences ||
          "תחבורה מקומית",
        mapLink: item.mapLink || buildMapLink(item.name, item.lat, item.lon),
        approximatePrice: item.approximatePrice ?? item.priceConvertedAmount ?? null,
        canonicalPlaceId: resolveCanonicalPlaceId(item),
      };
    });

  const activityItems = items.filter(
    (item) => !isFoodItem(item.category) && item.category !== "transportation" && item.category !== "hotel"
  );
  const foodItems = items.filter((item) => isFoodItem(item.category));
  const transportItems = items.filter((item) => item.category === "transportation");
  const accommodationItems = items.filter((item) => item.category === "hotel");
  const itemActivityCost = activityItems.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const itemFoodCost = foodItems.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const itemTransportCost = transportItems.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const itemAccommodationCost = accommodationItems.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const totalTravelMinutes = items.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);
  // Always trust the sum of (now currency-converted) item prices over the
  // model's own day-level cost fields, including when it's genuinely 0 —
  // never fall back to a day-level number here. That fallback used to kick
  // in whenever a category's items summed to 0, which silently resurrected
  // a stale, pre-repair total once every item in a category had been
  // replaced down to a free placeholder (e.g. by enforceBudgetOnDays) —
  // repeatedly "fixing" a day would each time zero out its own items but
  // the day's headline cost would refuse to actually drop. Accommodation
  // stays the one exception: it's usually represented only as `day.accommodation`
  // free text with no corresponding item to sum, so a reasonable estimate
  // is still worth falling back to there.
  const activityCost = itemActivityCost;
  const foodCost = itemFoodCost;
  const transportCost = itemTransportCost;
  const accommodationCost =
    accommodationItems.length > 0
      ? itemAccommodationCost
      : (day.accommodationCost ?? (day.accommodation ? (profile?.accommodationBudgetPerDay ?? null) : null));
  const estimatedCost =
    (activityCost ?? 0) +
    (foodCost ?? 0) +
    (transportCost ?? 0) +
    (accommodationCost ?? 0);
  const generatedTransportSegments = items.reduce<string[]>((segments, item, index) => {
    if (index === 0 || (item.travelMinutes ?? 0) <= 0) return segments;

    const previous = items[index - 1];
    const origin = previous?.location || payload.countryName;
    const destination = item.location || item.name;
    segments.push(
      `${origin} -> ${destination} · ${item.transportation || "תחבורה מקומית"} · ${item.travelMinutes} דק׳`
    );
    return segments;
  }, []);
  const geography = profile ? analyzeDayGeography({ ...day, items }, profile) : null;
  const generatedWarnings = buildWarnings(items, payload.preferences.tripPace);
  const geographyWarnings =
    geography == null
      ? []
      : normalizeActionableMessages([
          ...(geography.crossCityItems.length > 0 && !geography.isTransferDay
            ? [
                "זוהה ערבוב בין אזורים או ערים רחוקים באותו יום. עדיף לרכז את העצירות לאותו אשכול גאוגרפי.",
              ]
            : []),
          ...(geography.longMealDetours.length > 0
            ? [
                "לפחות אחת מעצירות האוכל דורשת מעקף ארוך מדי ביחס לאטרקציות. כדאי לבחור מקום קרוב יותר למסלול.",
              ]
            : []),
          ...(!geography.isTransferDay && geography.totalTravelMinutes > MAX_NORMAL_DAY_TRAVEL_MINUTES
            ? [
                "סך זמני המעבר ביום הזה כבד מדי למסלול רגיל. כדאי לפצל אזורים או לצמצם עצירות.",
              ]
            : []),
        ]);

  return {
    ...day,
    items,
    // Always content-derived (spec items 49/50), independent of whatever
    // title the AI wrote — never left as freeform AI text.
    theme: inferDayThemeLabel(items),
    // Same reasoning as activity/food/transport above: trust the freshly
    // computed total, including a genuine 0, rather than falling back to
    // the day's previous estimatedCost.
    estimatedCost,
    activityCost,
    foodCost,
    transportCost,
    accommodationCost,
    totalTravelMinutes: totalTravelMinutes > 0 ? totalTravelMinutes : day.totalTravelMinutes,
    warnings:
      day.warnings.length > 0
        ? normalizeActionableMessages([...day.warnings, ...geographyWarnings])
        : normalizeActionableMessages([...generatedWarnings, ...geographyWarnings]),
    transportSegments: day.transportSegments.length > 0 ? day.transportSegments : generatedTransportSegments,
    alternatives: normalizeActionableMessages(day.alternatives),
    bookingRequirements: normalizeActionableMessages(day.bookingRequirements),
    safetyNotes: normalizeActionableMessages(day.safetyNotes),
  };
}

export function replaceItemInDay(
  day: AiGeneratedDay,
  targetItem: AiGeneratedItem,
  nextItem: AiGeneratedItem
) {
  let replaced = false;
  return {
    ...day,
    items: day.items.map((item) => {
      if (!replaced && item === targetItem) {
        replaced = true;
        return nextItem;
      }
      return item;
    }),
  };
}

export function repairDayGeography(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /**
   * Root-cause fix (spec "GLOBAL USED-PLACE STATE MUST BE ITINERARY-WIDE")
   * — the caller's own itinerary-wide ItineraryUsageState, reflecting every
   * OTHER day's current real content. Optional only so a caller with no
   * other days in scope yet (e.g. a unit test exercising this function in
   * isolation) gets a fresh, empty one — never a silent no-op on the
   * within-day check, which pickReplacementRecommendation still runs
   * unconditionally via its own dayExcludingTarget.
   */
  usageState: ItineraryUsageState = createItineraryUsageState()
) {
  // Items with genuinely impossible coordinates (e.g. lat/lon far outside
  // real-world range) must be caught here, on the raw input, before
  // `fillDerivedDayFields` normalizes/nulls them out below — once nulled,
  // `analyzeDayGeography` can no longer tell "invalid" apart from
  // "legitimately has no coordinates yet" and would otherwise leave a
  // nameless, coordinate-less item sitting in the itinerary forever instead
  // of replacing it with a real nearby alternative.
  const rawInvalidNames = new Set(
    day.items
      .filter(
        (item) =>
          (item.lat != null || item.lon != null) &&
          !normalizeCoordinatePair(item.lat, item.lon).isValid
      )
      .map((item) => item.name)
  );

  let nextDay = fillDerivedDayFields(resequenceDayItems(day), payload, profile);

  if (rawInvalidNames.size > 0) {
    const invalidItem = nextDay.items.find(
      (item) => rawInvalidNames.has(item.name) && !item.locked && !item.fixedTime
    );
    if (invalidItem) {
      releaseItineraryUsage(usageState, invalidItem);
      const replacement = pickReplacementRecommendation({
        traceSource: "locality_repair",
        payload,
        day: nextDay,
        item: invalidItem,
        profile,
        usageState,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, invalidItem, nextDay, payload)
        : buildFreeExplorationReplacement(invalidItem, nextDay);
      registerItineraryUsage(usageState, nextItem);
      nextDay = fillDerivedDayFields(
        resequenceDayItems(replaceItemInDay(nextDay, invalidItem, nextItem)),
        payload,
        profile
      );
    }
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const diagnostics = analyzeDayGeography(nextDay, profile);
    let changed = false;

    if (diagnostics.invalidCoordinateItems.length > 0) {
      const invalidItem = nextDay.items.find(
        (item) => diagnostics.invalidCoordinateItems.includes(item.name) && !item.locked && !item.fixedTime
      );

      if (invalidItem) {
        releaseItineraryUsage(usageState, invalidItem);
        const replacement = pickReplacementRecommendation({
          traceSource: "locality_repair",
          payload,
          day: nextDay,
          item: invalidItem,
          profile,
          usageState,
        });
        const nextItem = replacement
          ? buildReplacementItem(replacement, invalidItem, nextDay, payload)
          : buildFreeExplorationReplacement(invalidItem, nextDay);
        registerItineraryUsage(usageState, nextItem);
        nextDay = fillDerivedDayFields(
          resequenceDayItems(replaceItemInDay(nextDay, invalidItem, nextItem)),
          payload,
          profile
        );
        changed = true;
      }
    }

    if (!changed && diagnostics.foodDominant) {
      const extraFoodItem = sortItems(nextDay.items).find(
        (item) => isFoodItem(item.category) && !item.locked && !item.fixedTime
      );
      if (extraFoodItem) {
        releaseItineraryUsage(usageState, extraFoodItem);
        const replacement = pickReplacementRecommendation({
          traceSource: "locality_repair",
          payload,
          day: nextDay,
          item: extraFoodItem,
          profile,
          usageState,
          replacementMode: "non_food",
          anchor: getPrimaryAnchor(nextDay),
        });

        if (replacement) {
          const nextItem = buildReplacementItem(replacement, extraFoodItem, nextDay, payload);
          registerItineraryUsage(usageState, nextItem);
          nextDay = fillDerivedDayFields(
            resequenceDayItems(replaceItemInDay(nextDay, extraFoodItem, nextItem)),
            payload,
            profile
          );
          changed = true;
        } else {
          // Item stays in place — restore its usage exactly as it was.
          registerItineraryUsage(usageState, extraFoodItem);
        }
      }
    }

    if (!changed && diagnostics.longMealDetours.length > 0) {
      const mealToReplace = sortItems(nextDay.items).find(
        (item) =>
          diagnostics.longMealDetours.some((segment) => segment.toName === item.name) &&
          !item.locked &&
          !item.fixedTime
      );

      if (mealToReplace) {
        const dayWithoutMeal = {
          ...nextDay,
          items: nextDay.items.filter((item) => item !== mealToReplace),
        };
        const dayMealNames = new Set(
          dayWithoutMeal.items
            .filter((item) => isFoodItem(item.category))
            .map((item) => item.name.trim().toLowerCase())
        );
        const replacement = pickNearbyMealRecommendation(
          payload,
          dayWithoutMeal,
          mealToReplace.slot === "dinner" ? "dinner" : "lunch",
          profile,
          dayMealNames
        );
        const nextMeal = replacement
          ? buildSupplementalMealItem(
              replacement,
              mealToReplace.slot === "dinner" ? "dinner" : "lunch",
              dayWithoutMeal,
              payload
            )
          : buildFallbackMealPlaceholder(
              dayWithoutMeal,
              mealToReplace.slot === "dinner" ? "dinner" : "lunch",
              payload,
              dayMealNames
            );

        nextDay = fillDerivedDayFields(
          resequenceDayItems({
            ...dayWithoutMeal,
            items: [...dayWithoutMeal.items, nextMeal],
          }),
          payload,
          profile
        );
        changed = true;
      }
    }

    if (
      !changed &&
      (diagnostics.crossCityItems.length > 0 ||
        (!diagnostics.isTransferDay &&
          diagnostics.totalTravelMinutes > MAX_NORMAL_DAY_TRAVEL_MINUTES))
    ) {
      const primaryAnchor = getPrimaryAnchor(nextDay);
      const outlier = getOrderedAnchorItems(nextDay)
        .filter((item) => item !== primaryAnchor && !item.locked && !item.fixedTime)
        .sort((left, right) => {
          const leftDistance = primaryAnchor
            ? haversineKm(primaryAnchor.lat, primaryAnchor.lon, left.lat, left.lon)
            : 0;
          const rightDistance = primaryAnchor
            ? haversineKm(primaryAnchor.lat, primaryAnchor.lon, right.lat, right.lon)
            : 0;
          const leftScore =
            leftDistance * 3 + (left.travelMinutes ?? 0) + (diagnostics.crossCityItems.includes(left.name) ? 160 : 0);
          const rightScore =
            rightDistance * 3 + (right.travelMinutes ?? 0) + (diagnostics.crossCityItems.includes(right.name) ? 160 : 0);
          return rightScore - leftScore;
        })[0];

      if (outlier) {
        releaseItineraryUsage(usageState, outlier);
        const replacement = pickReplacementRecommendation({
          traceSource: "locality_repair",
          payload,
          day: nextDay,
          item: outlier,
          profile,
          usageState,
          anchor: primaryAnchor,
        });
        const nextItem = replacement
          ? buildReplacementItem(replacement, outlier, nextDay, payload)
          : buildFreeExplorationReplacement(outlier, nextDay);
        registerItineraryUsage(usageState, nextItem);
        nextDay = fillDerivedDayFields(
          resequenceDayItems(replaceItemInDay(nextDay, outlier, nextItem)),
          payload,
          profile
        );
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return fillDerivedDayFields(resequenceDayItems(nextDay), payload, profile);
}

/**
 * Round 7 — interval-aware opening-hours enforcement. A real scheduled
 * venue with parseable hours must fit its whole activity interval
 * `[start … start + effectiveDuration]` inside a valid opening interval for
 * that day's local weekday (evaluateItemOpeningHoursLegality). Repair order
 * per violating item (spec §5):
 *
 *   A. MOVE THE SAME ITEM — reorder it within the day so scheduleDayItems
 *      re-times it into a legal slot; the venue is preserved.
 *   B. REORDER SAME-DAY ITEMS — the A step tries both "as early as
 *      possible" and "as late as possible"; the one that yields a legal
 *      time with no new violation / overflow wins.
 *   D. REPLACE — a legal candidate from the same day/stay pool whose OWN
 *      hours are legal (or unknown) at the resulting time.
 *   E. SAFE SYNTHETIC FALLBACK — free-exploration / meal placeholder rather
 *      than ever keeping a known-closed real venue.
 *
 * Locked / fixedTime items are never moved or replaced (spec §6) — they
 * are left exactly as-is and surface as `lockedOpeningHoursConflicts` in
 * the pure final validator, so the itinerary is never falsely reported
 * fully legal.
 *
 * Unknown / unparseable hours are never treated as a violation (spec §2).
 */
export function repairOpeningHoursViolations(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  // Built ONCE from the CURRENT full itinerary, then mutated in place across
  // every day so a replacement chosen for an early day is visible as used
  // when a later day runs its own repair in this same pass.
  const usageState = buildItineraryUsageState(days);

  const reorderAttempt = (
    day: AiGeneratedDay,
    target: AiGeneratedItem,
    position: "front" | "back"
  ): AiGeneratedDay => {
    const others = day.items.filter((entry) => entry !== target);
    const reordered = position === "front" ? [target, ...others] : [...others, target];
    return fillDerivedDayFields(resequenceDayItems({ ...day, items: reordered }), payload, profile);
  };

  return days.map((day) => {
    let nextDay = day;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const violatingItem = nextDay.items.find(
        (item) => !item.locked && !item.fixedTime && itemHasKnownOpeningHoursViolation(item, nextDay.date)
      );
      if (!violatingItem) break;

      // A / B — try to keep the SAME venue by reordering it within the day.
      let resolvedByReorder = false;
      for (const position of ["back", "front"] as const) {
        const candidateDay = reorderAttempt(nextDay, violatingItem, position);
        const movedItem = candidateDay.items.find((entry) => entry.name === violatingItem.name && entry.recommendationId === violatingItem.recommendationId);
        const noNewViolation = candidateDay.items.every(
          (entry) => entry.locked || entry.fixedTime || !itemHasKnownOpeningHoursViolation(entry, candidateDay.date)
        );
        if (movedItem && !itemHasKnownOpeningHoursViolation(movedItem, candidateDay.date) && noNewViolation) {
          nextDay = candidateDay;
          resolvedByReorder = true;
          break;
        }
      }
      if (resolvedByReorder) continue;

      // D — replace with a legal candidate whose own hours also fit.
      releaseItineraryUsage(usageState, violatingItem);
      const replacement = pickReplacementRecommendation({
        traceSource: "opening_hours_repair",
        payload,
        day: nextDay,
        item: violatingItem,
        profile,
        usageState,
      });
      let nextItem = replacement
        ? buildReplacementItem(replacement, violatingItem, nextDay, payload)
        : buildFreeExplorationReplacement(violatingItem, nextDay);
      let candidateDay = fillDerivedDayFields(
        resequenceDayItems(replaceItemInDay(nextDay, violatingItem, nextItem)),
        payload,
        profile
      );
      const placedReplacement = candidateDay.items.find((entry) => entry.name === nextItem.name);
      // E — if the chosen real replacement itself lands illegal at its new
      // time, fall back to the synthetic block, which has no hours.
      if (replacement && placedReplacement && itemHasKnownOpeningHoursViolation(placedReplacement, candidateDay.date)) {
        registerItineraryUsage(usageState, nextItem); // keep it marked used — do not reinsert elsewhere
        nextItem = buildFreeExplorationReplacement(violatingItem, nextDay);
        candidateDay = fillDerivedDayFields(
          resequenceDayItems(replaceItemInDay(nextDay, violatingItem, nextItem)),
          payload,
          profile
        );
      } else {
        registerItineraryUsage(usageState, nextItem);
      }
      nextDay = candidateDay;
    }
    return nextDay;
  });
}

/**
 * Real bug found during end-to-end QA generation (a live France trip with
 * Disneyland Paris): a day starting out as a genuine full-day-anchor day
 * correctly has its meals omitted (spec item 12) — but if a LATER repair
 * step inside repairDayGeography (crossCityItems/foodDominant/outlier
 * replacement) swaps the full-day anchor itself out for a regular-scale
 * substitute, the day is no longer a full-day-anchor day and DOES need
 * meals again, yet nothing re-ran meal insertion since it only happened
 * once, at the very top of repairDayStructure, before that anchor was
 * replaced. The day was then stuck with no meals until an entirely new
 * outer repairPlan attempt started repairDayStructure over from scratch —
 * i.e. missingMeals could take several whole attempts to converge, or
 * never converge within the attempt budget at all. Split out so it can be
 * called both before AND after repairDayGeography in the same pass.
 */
export function insertMissingMeals(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>,
  dayCount?: number,
  arrivalDepartureWindow?: ArrivalDepartureWindow | null,
  /** Round 9.2.1 §12 — shared and mutated across the whole trip's day-processing loop, exactly like usedMealNames (same by-reference threading pattern) — appended to (in place, via push) every time a real meal venue is actually scheduled, read by scoreMealCandidate via pickNearbyMealRecommendation above. Optional/defaulted so every pre-existing call site keeps compiling unchanged. */
  recentMealHistory: RecentMealHistoryEntry[] = [],
  cuisineWeights: Record<CuisineFamily, number> = EMPTY_CUISINE_WEIGHTS
): AiGeneratedDay {
  let nextDay = day;
  // Real bug found during end-to-end QA generation (a live Israel trip): a
  // dinner correctly excluded from missingMeals on the departure day (see
  // hasUsableGapForMeal — the window itself rules it out) still got
  // inserted here regardless, since findMissingMealSlots never knew about
  // window feasibility at all — only the VALIDATOR did. The inserted
  // placeholder then got scheduled well past the real departure cutoff,
  // and nothing re-ran enforceArrivalDepartureWindow afterward to catch
  // it, so it survived straight into arrivalDepartureWindowViolations.
  // Reusing the exact same feasibility check the validator uses keeps
  // insertion and validation from ever disagreeing again — the same fix
  // shape as findMissingMealSlots's own original bug.
  const isArrivalDay = dayCount != null && day.dayNumber === 1;
  const isDepartureDay = dayCount != null && day.dayNumber === dayCount;
  const lunchIsFeasible = !arrivalDepartureWindow || hasUsableGapForMeal(nextDay, LUNCH_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);
  const dinnerIsFeasible = !arrivalDepartureWindow || hasUsableGapForMeal(nextDay, DINNER_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);

  for (const missingMealSlot of findMissingMealSlots(nextDay.items)) {
    if (missingMealSlot === "lunch" && !lunchIsFeasible) continue;
    if (missingMealSlot === "dinner" && !dinnerIsFeasible) continue;
    const recommendation = pickNearbyMealRecommendation(
      payload,
      nextDay,
      missingMealSlot,
      profile,
      usedMealNames,
      recentMealHistory,
      day.dayNumber,
      cuisineWeights
    );

    const nextMealItem = recommendation
      ? buildSupplementalMealItem(recommendation, missingMealSlot, nextDay, payload)
      : buildFallbackMealPlaceholder(nextDay, missingMealSlot, payload, usedMealNames);

    if (recommendation) {
      // Round 9.2.1 §12 — record this real selection's cuisine BEFORE the
      // next slot in this same loop (or the next day, via the caller's
      // shared array) scores against it; mirrors usedMealNames.add just
      // below in repairDayStructure, but per-slot rather than per-day so a
      // lunch immediately informs the SAME day's dinner scoring too.
      const classification = classifyMealVenue({
        category: recommendation.category,
        name: recommendation.name,
        shortDescription: recommendation.shortDescription,
        openingHours: recommendation.openingHours,
        recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
        approximatePrice: recommendation.approximatePrice,
        reservationRequired: recommendation.reservationRequired,
      });
      recentMealHistory.push({
        dayIndex: day.dayNumber,
        mealType: missingMealSlot === "dinner" ? "DINNER" : "LUNCH",
        cuisineFamilies: classification.cuisineFamilies,
        cuisineSubtypes: classification.cuisineSubtypes,
      });
    }

    if (nextMealItem && nextMealItem.name) {
      nextDay = {
        ...nextDay,
        items: [...nextDay.items, nextMealItem],
      };
    }
  }
  return nextDay;
}

export function repairDayStructure(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayIndex: number,
  dayCount: number,
  usedMealNames: Set<string>,
  /**
   * Root-cause fix (spec §A/§C) — itinerary-wide, shared exactly like
   * usedMealNames across every day this loop processes (same threading
   * pattern, same mutable-by-reference sharing). Represents every OTHER
   * day's current real content; this day's own starting items are
   * released below before repairDayGeography runs (so THIS day's repair
   * never self-blocks on its own not-yet-decided content) and the day's
   * FINAL real items are registered at the end, so the NEXT day in this
   * same loop sees them as used.
   */
  usageState: ItineraryUsageState = createItineraryUsageState(),
  arrivalDepartureWindow?: ArrivalDepartureWindow | null,
  /** Round 9.2.1 §12 — same by-reference threading as usedMealNames/usageState above. Optional/defaulted so every pre-existing call site keeps compiling unchanged. */
  recentMealHistory: RecentMealHistoryEntry[] = [],
  cuisineWeights: Record<CuisineFamily, number> = EMPTY_CUISINE_WEIGHTS
) {
  let nextDay = resequenceDayItems({ ...day, items: sortItems(day.items.map(normalizeGeneratedItemCoordinates)) });
  for (const item of nextDay.items) releaseItineraryUsage(usageState, item);
  nextDay = insertMissingMeals(nextDay, payload, profile, usedMealNames, dayCount, arrivalDepartureWindow, recentMealHistory, cuisineWeights);

  if (!nextDay.title || /^day\s+\d+$/i.test(nextDay.title.trim())) {
    const area = normalizeAreaLabel(nextDay.cityRegion || nextDay.items[0]?.location || payload.countryName);
    const theme = inferDayThemeLabel(nextDay.items);
    nextDay = {
      ...nextDay,
      title: `יום ${day.dayNumber} · ${theme}${area ? ` ב${area}` : ""}`,
    };
  }

  if (!nextDay.notes.trim()) {
    const area = normalizeAreaLabel(nextDay.cityRegion || nextDay.items[0]?.location || payload.countryName);
    const theme = inferDayThemeLabel(nextDay.items);
    nextDay = {
      ...nextDay,
      notes: `יום ${theme.toLowerCase()} שמתמקד באזור ${area} עם קצב ${
        payload.preferences.tripPace === "relaxed" ? "נינוח" : "מאוזן"
      }, אוכל קרוב ומעברים הגיוניים בין העצירות.`,
    };
  }

  if (!nextDay.restWindow.trim() && dayCount > 7 && ((dayIndex + 1) % 5 === 0 || (nextDay.totalTravelMinutes ?? 0) > 120)) {
    nextDay = {
      ...nextDay,
      restWindow:
        (nextDay.totalTravelMinutes ?? 0) > 120
          ? "השאירו חלון התאוששות, צ'ק-אין מסודר וגמישות אחרי יום מעבר ארוך."
          : "בוקר רגוע או חלון כביסה/תכנון כדי לשמור על קצב בריא לאורך טיול ארוך.",
    };
  }

  if (
    dayCount > 7 &&
    nextDay.bookingRequirements.length === 0 &&
    ((nextDay.totalTravelMinutes ?? 0) > 150 || /מעבר|רכבת|טיסה|לינה חדשה|צ'ק-אאוט|צ'ק-אין/.test(nextDay.notes))
  ) {
    nextDay = {
      ...nextDay,
      bookingRequirements: [
        "בדקו צ'ק-אאוט, אחסון מזוודות והגעה ללינה הבאה לפני שמעמיסים פעילויות נוספות.",
      ],
    };
  }

  nextDay = repairDayGeography(nextDay, payload, profile, usageState);
  // See insertMissingMeals's own comment — repairDayGeography can change
  // whether this is still a full-day-anchor day (e.g. by replacing the
  // anchor itself), which can newly require meals that weren't needed (or
  // weren't insertable) before it ran.
  nextDay = insertMissingMeals(resequenceDayItems(nextDay), payload, profile, usedMealNames, dayCount, arrivalDepartureWindow, recentMealHistory, cuisineWeights);

  for (const meal of nextDay.items.filter((item) => isFoodItem(item.category))) {
    usedMealNames.add(meal.name.trim().toLowerCase());
  }

  const finalDay = fillDerivedDayFields(resequenceDayItems(nextDay), payload, profile);
  for (const item of finalDay.items) registerItineraryUsage(usageState, item);
  return finalDay;
}

/**
 * Prices coming straight from a priced candidate recommendation already
 * carry a real, auditable currency context (set once, before generation, by
 * `withNormalizedRecommendationPrice`). Anything the LLM invented on the
 * spot has no such context — the prompt asks it to price those in the
 * destination's local currency, so this treats the raw number as local
 * currency and converts it deterministically rather than trusting any
 * in-model arithmetic (never confusing e.g. JPY for ILS).
 */
/**
 * `travelers` is only used on the freshly-AI-estimated path below — a
 * matched real TripRecommendation candidate's own approximatePrice may
 * already be a whole-group total from wherever it was sourced (its exact
 * semantics haven't been audited), so it's passed through as-is rather
 * than guessed at. For a fresh AI estimate, the prompt now explicitly asks
 * for a PER-PERSON price (see buildPrompt's approximatePrice instruction),
 * and the group total is computed here, once, deterministically — never
 * trusted to the LLM's own multiplication (spec: totalActivityCost =
 * pricePerPerson × travelers).
 */
export function resolveItemPriceFields(
  rawPrice: number | null | undefined,
  matchedRecommendation: TripRecommendation | null,
  exchangeRateContext: ExchangeRateContext | null,
  travelers: number
): Pick<
  AiGeneratedItem,
  | "approximatePrice"
  | "pricePerPerson"
  | "priceOriginalAmount"
  | "priceOriginalCurrency"
  | "priceConvertedAmount"
  | "priceExchangeRate"
  | "priceRateTimestamp"
  | "convertedCurrency"
  | "sourceType"
> {
  if (matchedRecommendation?.priceOriginalCurrency && matchedRecommendation.priceConvertedAmount != null) {
    return {
      approximatePrice: matchedRecommendation.priceConvertedAmount,
      pricePerPerson: null,
      priceOriginalAmount: matchedRecommendation.priceOriginalAmount ?? rawPrice ?? null,
      priceOriginalCurrency: matchedRecommendation.priceOriginalCurrency,
      priceConvertedAmount: matchedRecommendation.priceConvertedAmount,
      priceExchangeRate: matchedRecommendation.priceExchangeRate ?? null,
      priceRateTimestamp: matchedRecommendation.priceRateTimestamp ?? null,
      convertedCurrency: exchangeRateContext?.targetCurrency ?? "ILS",
      sourceType: "candidate",
    };
  }

  if (rawPrice != null) {
    // A fresh AI-estimated price is per person by prompt contract — the
    // group total is computed once, here, deterministically.
    const travelerCount = Math.max(1, travelers || 1);
    const totalPrice = rawPrice * travelerCount;
    if (exchangeRateContext) {
      const convertedAmount = Math.round(totalPrice * exchangeRateContext.rateToTarget * 100) / 100;
      const convertedPerPerson = Math.round(rawPrice * exchangeRateContext.rateToTarget * 100) / 100;
      return {
        approximatePrice: convertedAmount,
        pricePerPerson: convertedPerPerson,
        priceOriginalAmount: totalPrice,
        priceOriginalCurrency: exchangeRateContext.sourceCurrency,
        priceConvertedAmount: convertedAmount,
        priceExchangeRate: exchangeRateContext.rateToTarget,
        priceRateTimestamp: exchangeRateContext.updatedAt,
        convertedCurrency: exchangeRateContext.targetCurrency,
        sourceType: "ai_estimate",
      };
    }
    return {
      approximatePrice: totalPrice,
      pricePerPerson: rawPrice,
      priceOriginalAmount: totalPrice,
      priceOriginalCurrency: null,
      priceConvertedAmount: totalPrice,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: "ai_estimate",
    };
  }

  // No fresh AI price — fall back to a matched candidate's plain price.
  // Its own per-person/total semantics aren't audited yet (see the
  // interface comment on AiGeneratedItem.pricePerPerson), so it's treated
  // as an already-resolved total, same as before this change — never
  // multiplied a second time.
  const price = matchedRecommendation?.approximatePrice ?? null;
  if (price != null && exchangeRateContext) {
    const convertedAmount = Math.round(price * exchangeRateContext.rateToTarget * 100) / 100;
    return {
      approximatePrice: convertedAmount,
      pricePerPerson: null,
      priceOriginalAmount: price,
      priceOriginalCurrency: exchangeRateContext.sourceCurrency,
      priceConvertedAmount: convertedAmount,
      priceExchangeRate: exchangeRateContext.rateToTarget,
      priceRateTimestamp: exchangeRateContext.updatedAt,
      convertedCurrency: exchangeRateContext.targetCurrency,
      sourceType: "ai_estimate",
    };
  }

  return {
    approximatePrice: price,
    pricePerPerson: null,
    priceOriginalAmount: price,
    priceOriginalCurrency: null,
    priceConvertedAmount: price,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: price != null ? "ai_estimate" : null,
  };
}

// Carries a user's lock/priority/fixed-time flags forward into freshly
// (re)generated items, matched the same way `applyAiPlanToWorkspace` matches
// items across regenerations — by recommendationId, else by name+location —
// so repair functions can see and respect them even before the plan is
// saved back onto the workspace.
function findExistingItemFlags(payload: AiItineraryRequest, name: string, location: string, recommendationId: string | null) {
  for (const day of payload.existingDays) {
    for (const item of day.items) {
      if (recommendationId && item.recommendationId === recommendationId) return item;
      if (item.name.trim().toLowerCase() === name.trim().toLowerCase() && item.location.trim().toLowerCase() === location.trim().toLowerCase()) {
        return item;
      }
    }
  }
  return null;
}

function enrichAiDay(
  day: RawGeneratedDay,
  payload: AiItineraryRequest,
  exchangeRateContext: ExchangeRateContext | null
): AiGeneratedDay {
  const items: AiGeneratedItem[] = day.items.map((item) => {
    const matchedRecommendation =
      payload.recommendations.find(
        (recommendation) =>
          recommendation.name.trim().toLowerCase() === item.name.trim().toLowerCase()
      ) ??
      payload.selectedPlaces.find(
        (recommendation) =>
          recommendation.name.trim().toLowerCase() === item.name.trim().toLowerCase()
      ) ??
      null;

    const category = normalizeCategory(item.category);
    const location = item.location || matchedRecommendation?.location || payload.countryName;
    const lat = matchedRecommendation?.lat ?? null;
    const lon = matchedRecommendation?.lon ?? null;
    const priceFields = resolveItemPriceFields(
      item.approximatePrice,
      matchedRecommendation,
      exchangeRateContext,
      payload.preferences.travelers
    );
    const recommendationId = matchedRecommendation?.id ?? null;
    const existingFlags = findExistingItemFlags(payload, item.name, location, recommendationId);

    return {
      name: item.name,
      category,
      location,
      shortDescription: item.shortDescription,
      slot: normalizeSlot(item.slot),
      plannedStartTime: item.plannedStartTime,
      estimatedDurationMinutes: item.estimatedDurationMinutes ?? matchedRecommendation?.estimatedDurationMinutes ?? null,
      ...priceFields,
      travelMinutes: item.travelMinutes ?? null,
      openingHours: item.openingHours ?? matchedRecommendation?.openingHours ?? "לא זמין",
      lastEntryTime: item.lastEntryTime ?? "",
      canonicalPlaceId: resolveCanonicalPlaceId({ recommendationId, lat, lon }),
      reservationRequired: item.reservationRequired ?? matchedRecommendation?.reservationRequired ?? false,
      transportation: item.transportation ?? day.transportation,
      mapLink: matchedRecommendation?.mapLink || buildMapLink(item.name, lat, lon),
      lat,
      lon,
      bookingWarning: item.bookingWarning ?? "",
      alternativeSuggestion: item.alternativeSuggestion ?? "",
      recommendationId,
      locked: existingFlags?.locked ?? false,
      priority: existingFlags?.priority ?? "preferred",
      fixedTime: existingFlags?.fixedTime ?? false,
    };
  });

  return {
    dayNumber: day.dayNumber,
    date: day.date,
    title: day.title,
    // Recomputed for real by fillDerivedDayFields once this day is merged
    // into the pipeline (repairDayStructure always runs it through).
    theme: "",
    cityRegion: day.cityRegion,
    accommodation: day.accommodation,
    notes: day.notes,
    transportation: day.transportation,
    estimatedCost: day.estimatedCost ?? null,
    activityCost: day.activityCost ?? null,
    foodCost: day.foodCost ?? null,
    transportCost: day.transportCost ?? null,
    accommodationCost: day.accommodationCost ?? null,
    totalTravelMinutes: day.totalTravelMinutes ?? null,
    warnings: day.warnings ?? [],
    alternatives: day.alternatives ?? [],
    bookingRequirements: day.bookingRequirements ?? [],
    safetyNotes: day.safetyNotes ?? [],
    restWindow: day.restWindow ?? "",
    transportSegments: day.transportSegments ?? [],
    items,
  };
}

async function generateWithGemini(
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  exchangeRateContext: ExchangeRateContext | null,
  tripFrame: TripFrame,
  arrivalDepartureWindow: ArrivalDepartureWindow,
  knowledge?: CountryAiRecommendation | null
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt(payload, profile, exchangeRateContext, tripFrame, arrivalDepartureWindow, knowledge);
  const response = await client.models.generateContent({
    model: ITINERARY_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: ITINERARY_SCHEMA,
    },
  });

  const raw = response.text;
  captureGeminiFixture({ model: ITINERARY_MODEL, prompt, purpose: "generateWithGemini" }, raw);
  if (!raw) {
    throw new Error("Empty itinerary response from Gemini");
  }

  return JSON.parse(raw) as RawGeneratedPlan;
}

/**
 * A real, storable place identity (spec item 76) — `id:${recommendationId}`
 * when known, else `coords:${lat}:${lon}` when the item has real
 * coordinates, else "" (no fabricated name-only identity: two genuinely
 * different places can share a generic name — see buildItemKey's own
 * docstring below on why a name-only tier risks false-positive duplicate
 * merges, a lesson already learned the hard way earlier this session).
 * Deliberately separate from buildItemKey's own dedup-key computation
 * (which additionally falls back to a random generic id for placeless
 * filler) — this function only ever reports a real identity or none,
 * stored on the item for UI/future consumers to key off directly instead
 * of reaching for recommendationId themselves.
 */
export function resolveCanonicalPlaceId(
  item: Pick<AiGeneratedItem, "recommendationId" | "lat" | "lon"> & { canonicalPlaceId?: string }
): string {
  // A stay-transition marker (spec §Q — buildTransitionMarker) identifies
  // an item this file itself generated for a specific fromBase/toBase
  // pair; it must survive fillDerivedDayFields untouched (this function
  // otherwise always overwrites canonicalPlaceId from recommendationId/
  // coordinates, which would silently erase the one signal that lets a
  // stale transition item — from before a stay-structure repair — be told
  // apart from a fresh, correct one).
  if (item.canonicalPlaceId?.startsWith("transition:")) return item.canonicalPlaceId;
  if (item.recommendationId) return `id:${item.recommendationId}`;
  if (item.lat != null && item.lon != null) {
    return `coords:${item.lat.toFixed(3)}:${item.lon.toFixed(3)}`;
  }
  return "";
}

export function buildItemKey(item: Pick<AiGeneratedItem, "recommendationId" | "name" | "lat" | "lon" | "location">) {
  if (item.recommendationId) return `id:${item.recommendationId}`;
  if (item.lat != null && item.lon != null) {
    // ~111m grid (was 4 decimals / ~11m) plus the normalized name — the AI
    // can easily hallucinate slightly different coordinates for the same
    // real landmark across two separate mentions, and 11m precision missed
    // that drift entirely. Folding the name in too keeps two genuinely
    // different nearby places from colliding just because they're close.
    return `coords:${item.lat.toFixed(3)}:${item.lon.toFixed(3)}:${normalizePlaceNameSlug(item.name)}`;
  }
  // No recommendationId and no coordinates means nothing here actually
  // identifies a specific real place — this is generic/flexible filler
  // content (buildFreeExplorationReplacement, buildFreeTimeItem, the meal
  // placeholders), not a claim that a particular landmark exists. Two such
  // fillers for the same area used to collide on name+location alone
  // (a real reported bug: a sparse-candidate trip failed generation
  // entirely because "free time in the same area" on two different days
  // read as a duplicate place). There's nothing reliable to deduplicate
  // against here, so these are never flagged as duplicates rather than
  // trusting generated text to already be globally unique.
  return `generic:${crypto.randomUUID()}`;
}

function isAvoidedItem(item: Pick<AiGeneratedItem, "name" | "location" | "shortDescription">, profile: TripPreferenceProfile) {
  if (profile.avoidKeywords.length === 0) return false;
  return includesAnyKeyword(
    `${item.name} ${item.location} ${item.shortDescription}`,
    profile.avoidKeywords
  );
}

function buildCostsFromDays(days: AiGeneratedDay[], travelers: number, flights?: TripFlights) {
  return summarizeItemCosts(days, travelers, flightCostExpenses(flights));
}

export function buildReplacementItem(
  recommendation: AiItineraryRequest["recommendations"][number],
  existingItem: AiGeneratedItem,
  day: AiGeneratedDay,
  payload: AiItineraryRequest
): AiGeneratedItem {
  const coords = normalizeCoordinatePair(recommendation.lat, recommendation.lon);
  const anchor =
    getRelevantMealAnchors(day, existingItem.slot).anchor ??
    day.items.find((item) => item.name !== existingItem.name) ??
    day.items[0] ??
    null;
  const travelMinutes =
    anchor == null
      ? existingItem.travelMinutes ?? 0
      : estimateTravelMinutes(
          anchor.lat,
          anchor.lon,
          coords.lat,
          coords.lon,
          payload.preferences.tripPace,
          existingItem.transportation || day.transportation || payload.preferences.transportationPreferences || "תחבורה מקומית"
        );

  return {
    ...existingItem,
    name: recommendation.name,
    category: recommendation.category,
    location: recommendation.location,
    shortDescription: recommendation.shortDescription || existingItem.shortDescription,
    approximatePrice: recommendation.approximatePrice ?? existingItem.approximatePrice ?? null,
    priceOriginalAmount:
      recommendation.priceOriginalAmount ?? recommendation.approximatePrice ?? existingItem.priceOriginalAmount ?? null,
    priceOriginalCurrency: recommendation.priceOriginalCurrency ?? existingItem.priceOriginalCurrency ?? null,
    priceConvertedAmount:
      recommendation.priceConvertedAmount ?? recommendation.approximatePrice ?? existingItem.priceConvertedAmount ?? null,
    priceExchangeRate: recommendation.priceExchangeRate ?? existingItem.priceExchangeRate ?? null,
    priceRateTimestamp: recommendation.priceRateTimestamp ?? existingItem.priceRateTimestamp ?? null,
    travelMinutes: travelMinutes > 0 ? travelMinutes : existingItem.travelMinutes,
    openingHours: recommendation.openingHours || existingItem.openingHours,
    reservationRequired: recommendation.reservationRequired,
    transportation:
      existingItem.transportation || day.transportation || payload.preferences.transportationPreferences || "תחבורה מקומית",
    mapLink: recommendation.mapLink || buildMapLink(recommendation.name, coords.lat, coords.lon),
    lat: coords.lat,
    lon: coords.lon,
    recommendationId: recommendation.id,
    // Round 5 — this is now a REAL resolved venue (name + coordinates +
    // recommendationId from the pool). Clear any synthetic marker the
    // slot it replaced was carrying (e.g. a meal_opportunity placeholder),
    // so downstream classifiers do not keep treating a real restaurant as
    // synthetic and blow it away on the next ownership-normalization pass.
    itemRole: "real_place",
  };
}

// Several distinct phrasings rather than one fixed template — this filler is
// used whenever the real candidate pool is exhausted for an area, which can
// happen more than once across a long trip (or a country with a thin
// candidate pool). A single fixed name repeated verbatim for the same area
// used to produce byte-identical items with no id/coordinates to
// distinguish them, which buildItemKey's own name+location fallback tier
// then (correctly, given identical input) flagged as a duplicate place —
// failing the whole plan even though "free time in the same area twice on
// a long trip" isn't really a bug. Rotating the phrasing fixes both the
// dedup false-positive and gives the traveler some real variety instead of
// reading the same sentence on multiple days.
const FREE_EXPLORATION_PHRASES: Array<(area: string) => string> = [
  (area) => `שיטוט חופשי ב${area}`,
  (area) => `זמן פנוי לגלות את ${area} בקצב שלכם`,
  (area) => `הליכה רגועה וגמישה באזור ${area}`,
  (area) => `זמן גמיש לבחירה חופשית ב${area}`,
  (area) => `חיפוש פינות מקומיות באזור ${area}`,
];

export function buildFreeExplorationReplacement(item: AiGeneratedItem, day: AiGeneratedDay): AiGeneratedItem {
  const area = normalizeAreaLabel(day.cityRegion || item.location || day.accommodation || "");
  const variantIndex = (day.dayNumber * 7 + SLOT_ORDER.indexOf(item.slot)) % FREE_EXPLORATION_PHRASES.length;
  // Real bug found during end-to-end QA generation: a food item replaced
  // here (no real candidate available) used to get demoted to category
  // "hidden_gem" like any other replaced item — silently turning an
  // already-inserted lunch/dinner stop back into a non-food item.
  // collectPlanDiagnostics' missingMeals check (correctly) flagged the day
  // as still missing that meal even though repairDayStructure had just
  // inserted one earlier in the very same pass, so missingMeals could
  // never converge to 0 and real Gemini plans kept failing validation. A
  // food item being replaced must stay a food item — reusing the same
  // lunch/dinner placeholder phrasing buildFallbackMealPlaceholder uses.
  const isLunch = item.slot === "lunch" || (item.category === "cafe" && item.slot !== "dinner");
  const isFood = isFoodItem(item.category);
  const foodPhrases = isLunch ? FALLBACK_LUNCH_MEAL_PHRASES : FALLBACK_DINNER_MEAL_PHRASES;
  return {
    ...item,
    // A replaced food item becomes a meal OPPORTUNITY (spec "MEAL
    // OPPORTUNITIES") — the exact same 🍽/"recommended time" phrasing
    // buildFallbackMealPlaceholder uses, never an invented business name,
    // regardless of whether a real area label is known.
    name: isFood
      ? isLunch
        ? area
          ? foodPhrases[day.dayNumber % foodPhrases.length](area)
          : "🍽 זמן מומלץ לארוחת צהריים"
        : area
          ? foodPhrases[day.dayNumber % foodPhrases.length](area)
          : "🍽 זמן מומלץ לארוחת ערב"
      : area
        ? FREE_EXPLORATION_PHRASES[variantIndex](area)
        : "שיטוט חופשי וגמיש",
    category: isFood ? (isLunch ? "cafe" : "restaurant") : item.category === "museum" || item.category === "transportation" ? "hidden_gem" : item.category,
    itemRole: isFood ? "meal_opportunity" : "free_time",
    location: area || item.location,
    shortDescription: isFood
      ? area
        ? `זהו חלון זמן מומלץ לארוחה באזור ${area} — לא מסעדה קונקרטית. אפשר לבחור מסעדה אמיתית וקרובה בלשונית "אוכל".`
        : `זהו חלון זמן מומלץ לארוחה — לא מסעדה קונקרטית. אפשר לבחור מסעדה אמיתית וקרובה בלשונית "אוכל".`
      : area
        ? `חלופה גמישה וזולה באזור ${area} כדי לשמור על הקצב והתקציב בלי לנסוע רחוק.`
        : "חלופה גמישה וזולה באותו אזור כדי לשמור על קצב ותקציב.",
    // Section "MEAL OPPORTUNITIES"/Part V — a meal opportunity has no real
    // price (never fabricate "0"); a non-food free-exploration item keeps
    // the pre-existing honest "free activity" estimate, unchanged.
    approximatePrice: isFood ? null : 0,
    priceOriginalAmount: isFood ? null : 0,
    priceOriginalCurrency: isFood ? null : "ILS",
    priceConvertedAmount: isFood ? null : 0,
    priceExchangeRate: isFood ? null : 1,
    priceRateTimestamp: isFood ? null : new Date().toISOString(),
    sourceType: isFood ? null : item.sourceType,
    openingHours: "לא זמין",
    reservationRequired: false,
    mapLink: buildMapLink(area || item.location || day.cityRegion || day.accommodation, null, null),
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
  };
}

function planContainsKeyword(days: AiGeneratedDay[], keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return true;

  return days.some((day) =>
    [
      day.title,
      day.cityRegion,
      day.accommodation,
      day.notes,
      ...day.items.map((item) => `${item.name} ${item.location} ${item.shortDescription}`),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedKeyword)
  );
}

function buildInsertedRecommendationItem(
  recommendation: AiItineraryRequest["recommendations"][number],
  day: AiGeneratedDay,
  payload: AiItineraryRequest
): AiGeneratedItem {
  if (isFoodItem(recommendation.category)) {
    const slot =
      recommendation.recommendedTimeOfDay === "lunch" ||
      recommendation.recommendedTimeOfDay === "dinner"
        ? recommendation.recommendedTimeOfDay
        : "dinner";
    return buildSupplementalMealItem(recommendation, slot, day, payload);
  }

  const slot =
    recommendation.recommendedTimeOfDay === "any" ||
    recommendation.recommendedTimeOfDay === "lunch" ||
    recommendation.recommendedTimeOfDay === "dinner"
      ? "afternoon"
      : recommendation.recommendedTimeOfDay;
  const coords = normalizeCoordinatePair(recommendation.lat, recommendation.lon);
  const referenceItem = sortItems(day.items).at(-1) ?? null;
  const travelMinutes =
    referenceItem == null
      ? 0
      : estimateTravelMinutes(
          referenceItem.lat,
          referenceItem.lon,
          coords.lat,
          coords.lon,
          payload.preferences.tripPace,
          day.transportation || payload.preferences.transportationPreferences || "תחבורה מקומית"
        );

  return {
    name: recommendation.name,
    category: recommendation.category,
    location: recommendation.location,
    shortDescription:
      recommendation.shortDescription ||
      `שילוב ישיר של ${recommendation.name} כחלק מהעדפות החובה של הטיול.`,
    slot,
    plannedStartTime: slot === "morning" ? "10:00" : slot === "afternoon" ? "15:30" : "19:30",
    estimatedDurationMinutes: recommendation.estimatedDurationMinutes ?? 90,
    ...resolveItemPriceFields(recommendation.approximatePrice, recommendation, null, payload.preferences.travelers),
    travelMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
    lastEntryTime: "",
    canonicalPlaceId: resolveCanonicalPlaceId({ recommendationId: recommendation.id, lat: coords.lat, lon: coords.lon }),
    reservationRequired: recommendation.reservationRequired,
    transportation:
      day.transportation || payload.preferences.transportationPreferences || "תחבורה מקומית",
    mapLink:
      recommendation.mapLink || buildMapLink(recommendation.name, coords.lat, coords.lon),
    lat: coords.lat,
    lon: coords.lon,
    bookingWarning: recommendation.reservationRequired ? "מומלץ לבדוק זמינות מראש." : "",
    alternativeSuggestion: "",
    recommendationId: recommendation.id,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

export function pickReplacementRecommendation(args: {
  payload: AiItineraryRequest;
  day: AiGeneratedDay;
  item: AiGeneratedItem;
  profile: TripPreferenceProfile;
  /**
   * Root-cause fix (real 43-day US replay: Times Square/Central Park first
   * placed correctly in New York, then RE-inserted into Austin/Philadelphia/
   * Nashville/Chicago/Boston by locality_repair, each reporting
   * alreadyUsedAtInsertion:false) — this MUST be the one itinerary-wide
   * ItineraryUsageState the caller's own repair pass is maintaining across
   * every day, never a Set rebuilt from only the day currently being
   * repaired. Within-day dedup against `day`'s own OTHER items is still
   * handled internally below (via dayExcludingTarget), so callers never
   * need to fold their own day's items into this themselves.
   */
  usageState: ItineraryUsageState;
  replacementMode?: "match" | "non_food" | "food";
  anchor?: AiGeneratedItem | null;
  nextStop?: AiGeneratedItem | null;
  /** Locality-first architecture: a destination-mobility-profile-derived radius, when the caller has one, instead of the fixed worldwide default. */
  maxDistanceKm?: number;
  /**
   * Root-cause fix (real 43-day US replay: Yellowstone/Yosemite/Grand
   * Canyon/Mount Rushmore surviving on Austin/New Orleans/Seattle days) —
   * isCandidateGeographicallyCompatibleWithDay falls back to "anything is
   * compatible" whenever the day being repaired has ZERO other items with
   * real coordinates (the exact shape of a day whose only real content IS
   * the violating item itself, everything else a synthetic meal/free-time
   * placeholder). That fallback let the day-trip-national-park items get
   * RE-SELECTED as their own "repair" with no geographic constraint at
   * all. Passing the day's own real stay anchor here (when the caller has
   * one — enforceNormalDayLocality and enforceTransportRoleGuard both do)
   * guarantees the hard geographic gate always has at least one real
   * reference point, even when the day's own items don't.
   */
  stayAreaAnchor?: { lat: number; lon: number } | null;
  /** Observability only (spec "ONE AUTHORITATIVE TRACE HELPER") — the caller's own repair identity; every call site should pass its real one, "other_existing_path" is only the fallback for one that doesn't yet. */
  traceSource?: PlaceInsertionSource;
}) {
  // Spec "תיקון גנרי, לא תיקון תשיעי" — the item about to be replaced must
  // never count as one of the day's own trustworthy anchors, whether for
  // the hard geographic filter, the anchor/nextStop that drives
  // scoreRouteProximity's ranking, or the day-trip exemption check. This
  // used to be the CALLER's responsibility (pass a day that already
  // excludes the item) — eight call sites forgot to, each independently.
  // Guaranteeing it here instead means there is no longer a "wrong" way
  // to call this function; a caller that already excludes the item gets
  // a no-op filter (its own exclusion already did the work), and one that
  // doesn't gets the same safety automatically.
  const dayExcludingTarget: AiGeneratedDay = {
    ...args.day,
    items: args.day.items.filter((entry) => entry !== args.item),
  };
  const area = normalizeAreaLabel(dayExcludingTarget.cityRegion || args.item.location);
  const replacementMode = args.replacementMode ?? "match";
  const anchor =
    args.anchor ?? getRelevantMealAnchors(dayExcludingTarget, args.item.slot).anchor ?? getPrimaryAnchor(dayExcludingTarget);
  const nextStop = args.nextStop ?? getRelevantMealAnchors(dayExcludingTarget, args.item.slot).nextAnchor ?? null;

  // Root-cause fix (real 43-day US replay, Round 3: "Virginia"-labelled
  // phases whose anchor could not be resolved — see refineTripFrameWithGemini
  // relabel bug). isCandidateGeographicallyCompatibleWithDay's own "no
  // anchors -> anything is compatible" fallback let the just-released
  // illegal place (or an equally-distant one) win the ranking straight
  // back into the day whenever the hard geographic filter had nothing to
  // check against. The reference the filter uses, in priority order:
  //   1. args.stayAreaAnchor (the day's real stay/phase anchor) — the
  //      normal path; enforceNormalDayLocality / enforceTransportRoleGuard
  //      / the final gates all pass it.
  //   2. this day's OWN other coordinate-bearing items (dayExcludingTarget).
  //   3. the coordinates of the item being replaced itself — ONLY as a
  //      last resort for a single-item day with no stay anchor (e.g. Live
  //      Trip Mode's "swap this one closed place for a nearby one"), where
  //      "near where it was" is genuinely the only and correct signal.
  //      Never used when a stay anchor exists (that would reintroduce the
  //      "flagged far item anchors its own replacement" bug this exclusion
  //      was built to prevent).
  // If none of the three exists, there is nothing to verify a real
  // replacement against — return no replacement so the caller falls
  // through to a synthetic FreeTimeBlock ("if zero legal unused POIs
  // remain: use FreeTimeBlock; do NOT reinsert an illegal real place").
  const dayItemsHaveCoordinates = dayExcludingTarget.items.some((entry) => entry.lat != null && entry.lon != null);
  // The self-anchor last resort is ONLY safe on a normal day, where the
  // item being replaced sits at (or near) the day's base — "near where it
  // was" then genuinely means "near base". On a day-trip day the excursion
  // item is DELIBERATELY far from base, so a replacement near it is
  // equally unverifiable; that case must fail closed (return null ->
  // FreeTimeBlock) rather than guess.
  const lastResortSelfAnchor =
    !args.stayAreaAnchor &&
    !dayItemsHaveCoordinates &&
    !isDayTripDay(dayExcludingTarget) &&
    args.item.lat != null &&
    args.item.lon != null
      ? { lat: args.item.lat, lon: args.item.lon }
      : null;
  // When there is NO coordinate reference of any kind, the last-resort
  // fallback is a HARD text-area filter: the candidate's own location must
  // textually resolve to the same area as the day (its frame-synced
  // cityRegion, or the replaced item's own location). This keeps
  // empty-day fill / diversity passes working for a genuinely local pool
  // while still blocking a far place whose location text names a different
  // region — "Yellowstone / Wyoming" never resolves to a "Virginia" day.
  // Only when even the area text is unknown is there nothing at all to go
  // on: return no replacement -> the caller uses a synthetic FreeTimeBlock.
  const hasCoordinateReference = Boolean(args.stayAreaAnchor) || dayItemsHaveCoordinates || Boolean(lastResortSelfAnchor);
  const textAreaOnlyFallback = !hasCoordinateReference;
  if (textAreaOnlyFallback && !area) {
    return null;
  }
  const geographicReferenceAnchors: Array<{ lat: number | null; lon: number | null }> = [
    ...dayExcludingTarget.items,
    ...(args.stayAreaAnchor ? [{ lat: args.stayAreaAnchor.lat, lon: args.stayAreaAnchor.lon }] : []),
    ...(lastResortSelfAnchor ? [lastResortSelfAnchor] : []),
  ];
  // Spec §D — "locality_repair must never reinsert a globally used real
  // POI... even if geographically compatible, same category, same
  // ownerStay, legal pool otherwise chooses it": a hard reject at the
  // actual candidate-filtering boundary, checked against the SAME dual
  // identity (exact recommendationId OR fuzzy name+coordinates) duplicate
  // diagnostics themselves use — never recommendationId-only (spec §B).
  // Within-day dedup is a separate, smaller check: `args.usageState` is
  // itinerary-wide but reflects OTHER days' current content (the caller's
  // own responsibility to keep current), so this day's own remaining items
  // still need their own pass here, exactly as before this fix.
  const withinDayUsage = buildItineraryUsageState([dayExcludingTarget]);
  const candidates = [...args.payload.recommendations, ...args.payload.selectedPlaces]
    .filter((candidate) => {
      if (replacementMode === "food") {
        return isFoodItem(candidate.category);
      }
      if (replacementMode === "non_food") {
        return isAnchorDayItem(candidate);
      }
      return candidate.category === args.item.category || (isFoodItem(args.item.category) && isFoodItem(candidate.category));
    })
    .filter((candidate) => !isItineraryPlaceUsed(args.usageState, candidate))
    .filter((candidate) => !isItineraryPlaceUsed(withinDayUsage, candidate))
    .filter((candidate) => !includesAnyKeyword(`${candidate.name} ${candidate.location}`, args.profile.avoidKeywords))
    .filter((candidate) => !isAccessibilityConflict(candidate, args.payload))
    .filter((candidate) => !isDietaryConflict(candidate, args.profile))
    // Round 3 — no coordinate reference of any kind exists for this day
    // (no stay anchor, no coordinate items, no usable self-anchor). The
    // ONLY remaining signal is the candidate's own location TEXT vs the
    // day's area: require a positive whole-word area match, never "no
    // anchors -> anything goes".
    .filter((candidate) => !textAreaOnlyFallback || resolveTextualAreaMatch(candidate.location, area))
    // Generic worldwide architecture (Phase 5/14): a HARD reject, not just
    // a scoring penalty — a candidate that scoreRouteProximity would rank
    // well on other dimensions could still be genuinely in a different
    // city/region from everything already in this day. Judged against
    // every existing item's real coordinates, not just the immediate
    // anchor, so it still catches a mismatch even when the "anchor" happens
    // to be the one out-of-place item itself.
    //
    // Root-cause fix (real 43-day US replay) — dayExcludingTarget.items
    // alone is EMPTY of real coordinates on a day whose only real content
    // was the very item being repaired (a lone national park amid
    // synthetic meal/free-time placeholders). Without a real anchor here,
    // isCandidateGeographicallyCompatibleWithDay's own "no anchors at all"
    // fallback treats every candidate as compatible — including the
    // violating place itself, or an equally far one — which is exactly how
    // the repair silently re-selected its own violation. args.stayAreaAnchor
    // (the day's real stay/phase anchor, when the caller has one) is added
    // as a real reference point so that fallback is never reached merely
    // because THIS day's own items happen to have no coordinates.
    .filter((candidate) =>
      isCandidateGeographicallyCompatibleWithDay(
        candidate,
        geographicReferenceAnchors,
        {
          maxDistanceKm: args.maxDistanceKm,
          dayTripContext: isDayTripDay(dayExcludingTarget)
            ? {
                baseAnchor:
                  anchor && anchor.lat != null && anchor.lon != null
                    ? { lat: anchor.lat, lon: anchor.lon }
                    : args.stayAreaAnchor ?? lastResortSelfAnchor ?? null,
                mobilityProfile: {
                  tier: "medium",
                  localityRadiusKm: args.maxDistanceKm ?? CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM,
                  normalDayTravelBudgetMinutes: args.profile.dailyCapacityMinutes,
                },
                dailyCapacityMinutes: args.profile.dailyCapacityMinutes,
              }
            : undefined,
        }
      )
    )
    .sort((left, right) => {
      const leftAreaScore =
        normalizeAreaLabel(left.location).toLowerCase() === area.toLowerCase() ? 18 : 0;
      const rightAreaScore =
        normalizeAreaLabel(right.location).toLowerCase() === area.toLowerCase() ? 18 : 0;
      const leftBudgetScore = scoreBudgetFitness(left, args.item.slot, args.profile);
      const rightBudgetScore = scoreBudgetFitness(right, args.item.slot, args.profile);
      const leftPremiumPenalty =
        !args.profile.luxuryEnabled && isPremiumVenue({ name: left.name, approximatePrice: left.approximatePrice })
          ? -20
          : 0;
      const rightPremiumPenalty =
        !args.profile.luxuryEnabled && isPremiumVenue({ name: right.name, approximatePrice: right.approximatePrice })
          ? -20
          : 0;
      const leftRouteScore = scoreRouteProximity(left, {
        anchor,
        nextStop,
        pace: args.payload.preferences.tripPace,
        transportation:
          args.item.transportation ||
          dayExcludingTarget.transportation ||
          args.payload.preferences.transportationPreferences ||
          "תחבורה מקומית",
        hardLimitMinutes: MAX_LOCAL_TRAVEL_MINUTES,
        idealLimitMinutes: IDEAL_LOCAL_TRAVEL_MINUTES,
        explicitRequest: args.payload.selectedPlaces.some((place) => place.id === left.id),
      }).score;
      const rightRouteScore = scoreRouteProximity(right, {
        anchor,
        nextStop,
        pace: args.payload.preferences.tripPace,
        transportation:
          args.item.transportation ||
          dayExcludingTarget.transportation ||
          args.payload.preferences.transportationPreferences ||
          "תחבורה מקומית",
        hardLimitMinutes: MAX_LOCAL_TRAVEL_MINUTES,
        idealLimitMinutes: IDEAL_LOCAL_TRAVEL_MINUTES,
        explicitRequest: args.payload.selectedPlaces.some((place) => place.id === right.id),
      }).score;
      const leftSelectedBoost = args.payload.selectedPlaces.some((place) => place.id === left.id) ? 8 : 0;
      const rightSelectedBoost = args.payload.selectedPlaces.some((place) => place.id === right.id) ? 8 : 0;
      return (
        rightAreaScore +
        rightBudgetScore +
        rightRouteScore +
        rightSelectedBoost +
        rightPremiumPenalty -
        (leftAreaScore + leftBudgetScore + leftRouteScore + leftSelectedBoost + leftPremiumPenalty)
      );
    });

  const selected = candidates[0] ?? null;
  if (selected) {
    tracePlaceInsertion({
      item: { recommendationId: selected.id, name: selected.name, lat: selected.lat, lon: selected.lon, category: selected.category, itemRole: "real_place" },
      normalizedName: normalizePlaceNameSlug(selected.name),
      dayNumber: args.day.dayNumber,
      source: args.traceSource ?? "other_existing_path",
      action: "REPLACE",
      ownerStay: dayExcludingTarget.cityRegion,
      candidatePoolSize: args.payload.recommendations.length + args.payload.selectedPlaces.length,
      legalPoolSize: candidates.length,
      passedLegalPool: true,
      alreadyUsedAtInsertion: false,
      reason: `replacementMode=${replacementMode}`,
    });
  }
  return selected;
}

/**
 * Live Trip Mode "this place is closed / skip this" fast path — no AI call.
 * TripItineraryDay/TripItineraryItem are structural supersets of
 * AiGeneratedDay/AiGeneratedItem (every field the generation types need is
 * present with a compatible type), so they pass through directly; only the
 * *result* needs converting back, since AiGeneratedItem lacks the
 * Trip-only fields (completed, actualCost, etc).
 */
export function applyDeterministicReplacement(
  day: TripItineraryDay,
  targetItem: TripItineraryItem,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): { day: TripItineraryDay; replacementName: string } {
  // Defense in depth: the API route already refuses this action for
  // locked/fixed-time items before it ever gets here, but the function
  // itself must never silently replace one regardless of caller discipline.
  if (targetItem.locked || targetItem.fixedTime) {
    return { day, replacementName: targetItem.name };
  }

  // KNOWN RESIDUAL GAP (disclosed, not fixed this pass): this Live Trip
  // Mode single-item "replace this" action only ever sees the ONE day
  // it's called with (TripItineraryDay), never the rest of the already-
  // saved trip — the API route that calls this does not currently pass
  // sibling days in. It is NOT part of the generation pipeline the 43-day
  // replay measures (that pipeline's repair passes are the ones fixed in
  // this change), but it can, in principle, still pick a real place
  // already used elsewhere in the same saved trip. Left as day-local
  // scope, same as before this pass.
  const usageState = buildItineraryUsageState([day]);

  const replacement = pickReplacementRecommendation({
    traceSource: "duplicate_repair",
    payload,
    day,
    item: targetItem,
    profile,
    usageState,
  });

  const nextGeneratedItem = replacement
    ? buildReplacementItem(replacement, targetItem, day, payload)
    : buildFreeExplorationReplacement(targetItem, day);

  const nextItem: TripItineraryItem = {
    ...createEmptyItineraryItem(nextGeneratedItem.slot),
    ...nextGeneratedItem,
    id: targetItem.id,
    locked: targetItem.locked,
    priority: targetItem.priority,
    fixedTime: targetItem.fixedTime,
  };

  return {
    day: { ...day, items: day.items.map((item) => (item.id === targetItem.id ? nextItem : item)) },
    replacementName: nextItem.name,
  };
}

export function chooseTargetDayIndexForRecommendation(
  days: AiGeneratedDay[],
  recommendation: AiItineraryRequest["recommendations"][number],
  profile: TripPreferenceProfile
) {
  const candidateArea = normalizeAreaLabel(recommendation.location).toLowerCase();
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const dayArea = normalizeAreaLabel(
      day.cityRegion || day.accommodation || day.items[0]?.location || ""
    ).toLowerCase();
    const areaScore =
      candidateArea && dayArea && (candidateArea.includes(dayArea) || dayArea.includes(candidateArea))
        ? 26
        : 0;
    // Generic worldwide architecture (Phase 5): a must-visit place must not
    // land on whichever day merely has the most free capacity when no
    // text-based area label happens to match — real coordinates are the
    // authoritative signal, weighted well above capacity, so a place 100km
    // from every item on a spacious day no longer wins over a place 2km
    // from every item on a fuller one.
    const dayItemsWithCoordinates = day.items.filter((item) => item.lat != null && item.lon != null);
    const nearestDistanceKm =
      recommendation.lat != null && recommendation.lon != null && dayItemsWithCoordinates.length > 0
        ? Math.min(
            ...dayItemsWithCoordinates.map((item) => haversineKm(item.lat, item.lon, recommendation.lat, recommendation.lon))
          )
        : null;
    const geographicScore =
      nearestDistanceKm == null
        ? 0
        : nearestDistanceKm < 5
          ? 40
          : nearestDistanceKm < 15
            ? 25
            : nearestDistanceKm < CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM
              ? 10
              : -30;
    const preferredAreaScore =
      profile.preferredAreaKeywords.length > 0 &&
      includesAnyKeyword(`${day.cityRegion} ${day.accommodation}`, profile.preferredAreaKeywords)
        ? 8
        : 0;
    const capacityScore = Math.max(
      0,
      profile.dailyCapacityMinutes - calculateDayLoadMinutes(day)
    );
    const transferPenalty = /מעבר|רכבת|טיסה|צ'ק-אאוט|צ'ק-אין/.test(
      `${day.title} ${day.notes} ${day.transportation}`
    )
      ? -12
      : 0;
    const score = areaScore + geographicScore + preferredAreaScore + capacityScore / 20 + transferPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function ensureMustVisitCoverage(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
) {
  if (profile.mustVisitKeywords.length === 0) return days;

  const mutableDays = days.map((day) => fillDerivedDayFields(day, payload, profile));
  const usedPlaceKeys = new Set(
    mutableDays.flatMap((day) => day.items.map((item) => buildItemKey(item)))
  );

  for (const keyword of profile.mustVisitKeywords) {
    if (planContainsKeyword(mutableDays, keyword)) {
      continue;
    }

    const candidate = [...payload.selectedPlaces, ...payload.recommendations]
      .filter((recommendation) => !isAccessibilityConflict(recommendation, payload))
      .filter((recommendation) =>
        includesAnyKeyword(
          `${recommendation.name} ${recommendation.location} ${recommendation.shortDescription}`,
          [keyword]
        )
      )
      .filter(
        (recommendation) =>
          !includesAnyKeyword(
            `${recommendation.name} ${recommendation.location}`,
            profile.avoidKeywords
          )
      )
      .filter(
        (recommendation) =>
          !usedPlaceKeys.has(
            buildItemKey({
              recommendationId: recommendation.id,
              name: recommendation.name,
              lat: recommendation.lat,
              lon: recommendation.lon,
              location: recommendation.location,
            })
          )
      )
      .sort((left, right) => {
        const leftSelected = payload.selectedPlaces.some((place) => place.id === left.id) ? 18 : 0;
        const rightSelected = payload.selectedPlaces.some((place) => place.id === right.id) ? 18 : 0;
        const leftSlot =
          left.recommendedTimeOfDay === "any" ? "afternoon" : left.recommendedTimeOfDay;
        const rightSlot =
          right.recommendedTimeOfDay === "any" ? "afternoon" : right.recommendedTimeOfDay;
        return (
          rightSelected +
          scoreBudgetFitness(right, rightSlot, profile) -
          (leftSelected + scoreBudgetFitness(left, leftSlot, profile))
        );
      })[0];

    if (!candidate) {
      continue;
    }

    const targetDayIndex = chooseTargetDayIndexForRecommendation(mutableDays, candidate, profile);
    const targetDay = mutableDays[targetDayIndex];
    const insertedItem = buildInsertedRecommendationItem(candidate, targetDay, payload);
    const projectedDay = fillDerivedDayFields(
      { ...targetDay, items: [...targetDay.items, insertedItem] },
      payload,
      profile
    );

    if (calculateDayLoadMinutes(projectedDay) <= profile.dailyCapacityMinutes) {
      mutableDays[targetDayIndex] = projectedDay;
      usedPlaceKeys.add(buildItemKey(insertedItem));
      continue;
    }

    // Thread 1 (locked/fixed-time hard requirement): a locked or
    // fixed-time item must never be sacrificed to make room for something
    // else, must-visit coverage included — real bug found while auditing
    // every repair pass for this guarantee, this filter had no exemption
    // for either flag at all.
    const replaceableEntry = [...targetDay.items]
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !isFoodItem(item.category) && !isProtectedItem(item))
      .filter(
        ({ item }) =>
          !profile.mustVisitKeywords.some((mustVisitKeyword) =>
            includesAnyKeyword(`${item.name} ${item.location}`, [mustVisitKeyword])
          )
      )
      .sort(
        (left, right) =>
          (right.item.approximatePrice ?? 0) +
          (right.item.travelMinutes ?? 0) -
          ((left.item.approximatePrice ?? 0) + (left.item.travelMinutes ?? 0))
      )[0];

    if (!replaceableEntry) {
      continue;
    }

    const nextItems = [...targetDay.items];
    nextItems[replaceableEntry.index] = buildReplacementItem(
      candidate,
      replaceableEntry.item,
      targetDay,
      payload
    );
    mutableDays[targetDayIndex] = fillDerivedDayFields(
      { ...targetDay, items: nextItems },
      payload,
      profile
    );
    usedPlaceKeys.add(buildItemKey(nextItems[replaceableEntry.index]));
  }

  return mutableDays;
}

export function diversifyActivities(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dominantCategory: RecommendationCategory | null,
  activityMixSkew: PlanDiagnostics["activityMixSkew"] = []
) {
  if (!dominantCategory) return days;

  // Guidance only (spec: "guidelines, not rigid percentages") — when the mix
  // is skewed, prefer swapping toward whichever tier is furthest under its
  // target range, instead of an arbitrary replacement category.
  const underRepresentedTier = activityMixSkew
    .filter((entry) => entry.share < entry.target.min)
    .sort((left, right) => left.target.min - left.share - (right.target.min - right.share))
    .at(-1)?.tier;

  const mutableDays = [...days];
  const usedPlaceKeys = new Set(
    mutableDays.flatMap((day) => day.items.map((item) => buildItemKey(item)))
  );
  let replacements = 0;

  for (let dayIndex = mutableDays.length - 1; dayIndex >= 0 && replacements < 2; dayIndex -= 1) {
    const day = mutableDays[dayIndex];
    const replaceableEntry = [...day.items]
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.category === dominantCategory && !item.locked && !item.fixedTime)
      .filter(
        ({ item }) =>
          !profile.mustVisitKeywords.some((keyword) =>
            includesAnyKeyword(`${item.name} ${item.location}`, [keyword])
          )
      )
      .sort((left, right) => {
        const priorityDelta = priorityRemovalWeight(left.item.priority) - priorityRemovalWeight(right.item.priority);
        if (priorityDelta !== 0) return priorityDelta;
        return (
          (right.item.approximatePrice ?? 0) +
          (right.item.travelMinutes ?? 0) -
          ((left.item.approximatePrice ?? 0) + (left.item.travelMinutes ?? 0))
        );
      })[0];

    if (!replaceableEntry) {
      continue;
    }

    const area = normalizeAreaLabel(day.cityRegion || replaceableEntry.item.location);
    const replacement = [...payload.recommendations, ...payload.selectedPlaces]
      .filter((recommendation) => !isAccessibilityConflict(recommendation, payload))
      .filter((recommendation) => !isFoodItem(recommendation.category))
      .filter((recommendation) => recommendation.category !== dominantCategory)
      .filter((recommendation) => recommendation.category !== "transportation")
      .filter((recommendation) => recommendation.category !== "hotel")
      .filter(
        (recommendation) =>
          !usedPlaceKeys.has(
            buildItemKey({
              recommendationId: recommendation.id,
              name: recommendation.name,
              lat: recommendation.lat,
              lon: recommendation.lon,
              location: recommendation.location,
            })
          )
      )
      .filter(
        (recommendation) =>
          !includesAnyKeyword(
            `${recommendation.name} ${recommendation.location}`,
            profile.avoidKeywords
          )
      )
      // Generic worldwide architecture (Phase 5/14/23): a diversity/quota
      // repair must never import an otherwise-fitting candidate (e.g. the
      // under-represented tier's best scorer) from a genuinely different
      // city just to balance the activity mix — that used to be only a
      // soft area-label bonus below, easily outweighed by the tier bonus.
      // Spec "תיקון גנרי, לא תיקון תשיעי" — unlike every other repair
      // pass, this one never goes through pickReplacementRecommendation
      // (it has its own parallel candidate search), so its own generic
      // fix isn't automatic here: the item actually being swapped out
      // must be excluded from the comparison set itself, or a candidate
      // close only to IT could still pass.
      // Spec §I — a diversity/quota rebalance is never a day-trip
      // justification either; always judged by real distance to this
      // day's own remaining anchors.
      .filter((recommendation) =>
        isCandidateGeographicallyCompatibleWithDay(
          recommendation,
          day.items.filter((entry) => entry !== replaceableEntry.item),
          {}
        )
      )
      .sort((left, right) => {
        const leftAreaScore =
          normalizeAreaLabel(left.location).toLowerCase() === area.toLowerCase() ? 16 : 0;
        const rightAreaScore =
          normalizeAreaLabel(right.location).toLowerCase() === area.toLowerCase() ? 16 : 0;
        const leftSlot =
          left.recommendedTimeOfDay === "any" ? "afternoon" : left.recommendedTimeOfDay;
        const rightSlot =
          right.recommendedTimeOfDay === "any" ? "afternoon" : right.recommendedTimeOfDay;
        const leftTierScore =
          underRepresentedTier && classifyActivityTier(left.category) === underRepresentedTier ? 20 : 0;
        const rightTierScore =
          underRepresentedTier && classifyActivityTier(right.category) === underRepresentedTier ? 20 : 0;
        return (
          rightAreaScore +
          rightTierScore +
          scoreBudgetFitness(right, rightSlot, profile) -
          (leftAreaScore + leftTierScore + scoreBudgetFitness(left, leftSlot, profile))
        );
      })[0];

    if (!replacement) {
      continue;
    }

    const nextItems = [...day.items];
    nextItems[replaceableEntry.index] = buildReplacementItem(
      replacement,
      replaceableEntry.item,
      day,
      payload
    );
    const nextDay = fillDerivedDayFields({ ...day, items: nextItems }, payload, profile);

    if (calculateDayLoadMinutes(nextDay) <= profile.dailyCapacityMinutes) {
      mutableDays[dayIndex] = nextDay;
      usedPlaceKeys.add(buildItemKey(nextItems[replaceableEntry.index]));
      replacements += 1;
    }
  }

  return mutableDays;
}

function normalizeDayCollections(day: AiGeneratedDay) {
  return {
    ...day,
    warnings: normalizeActionableMessages(day.warnings),
    alternatives: normalizeActionableMessages(day.alternatives),
    bookingRequirements: normalizeActionableMessages(day.bookingRequirements),
    safetyNotes: normalizeActionableMessages(day.safetyNotes),
  };
}

export function rebalanceDayItems(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /**
   * Deliberately starts EMPTY and accumulates incrementally as the caller
   * walks every day in order (spec §B upgrade only — the itinerary-wide,
   * incremental-across-days design here was already correct, just using
   * the weaker recommendationId-or-coords single-key identity instead of
   * the dual id/fuzzy-coords one duplicate diagnostics use) — a place's
   * FIRST occurrence across the whole trip is never itself a duplicate,
   * only its second+ occurrence is; pre-seeding this from the full
   * itinerary would flag every occurrence, including the first.
   */
  usageState: ItineraryUsageState
) {
  const nextItems: AiGeneratedItem[] = [];
  const mealNamesInDay = new Set<string>();

  for (const item of sortItems(day.items)) {
    const duplicatePlace = isItineraryPlaceUsed(usageState, item);
    const premiumConflict =
      isFoodItem(item.category) &&
      (mealNamesInDay.has(item.name.trim().toLowerCase()) ||
        (!profile.luxuryEnabled && isPremiumVenue(item)));

    if ((isAvoidedItem(item, profile) || duplicatePlace || premiumConflict) && !item.locked && !item.fixedTime) {
      const replacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day: { ...day, items: nextItems },
        item,
        profile,
        usageState,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, { ...day, items: nextItems }, payload)
        : buildFreeExplorationReplacement(item, day);
      nextItems.push(nextItem);
      registerItineraryUsage(usageState, nextItem);
      if (isFoodItem(nextItem.category)) {
        mealNamesInDay.add(nextItem.name.trim().toLowerCase());
      }
      continue;
    }

    nextItems.push(item);
    registerItineraryUsage(usageState, item);
    if (isFoodItem(item.category)) {
      mealNamesInDay.add(item.name.trim().toLowerCase());
    }
  }

  return { ...day, items: nextItems };
}

// Optional items are shed first, must-do items only as an absolute last
// resort (spec: MUST DO "preserve unless impossible", OPTIONAL "first items
// removed"). Used to order candidates within functions that already exclude
// locked/fixedTime items from the candidate pool entirely.
function priorityRemovalWeight(priority: ItemPriority): number {
  switch (priority) {
    case "optional":
      return 0;
    case "preferred":
      return 1;
    case "must":
      return 2;
  }
}

function moveOverflowItem(
  days: AiGeneratedDay[],
  dayIndex: number,
  item: AiGeneratedItem,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
) {
  for (let nextIndex = dayIndex + 1; nextIndex < Math.min(days.length, dayIndex + 3); nextIndex += 1) {
    const nextDay = days[nextIndex];
    const projected = fillDerivedDayFields(
      { ...nextDay, items: [...nextDay.items, { ...item, slot: "afternoon", plannedStartTime: "15:30" }] },
      payload,
      profile
    );
    if (calculateDayLoadMinutes(projected) <= profile.dailyCapacityMinutes) {
      days[nextIndex] = projected;
      return true;
    }
  }
  return false;
}

export function fixOverloadedDays(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
) {
  const mutableDays = [...days];

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    let currentDay = fillDerivedDayFields(mutableDays[dayIndex], payload, profile);
    let attempts = 0;

    while (calculateDayLoadMinutes(currentDay) > profile.dailyCapacityMinutes && attempts < 6) {
      attempts += 1;
      const movableIndex = [...currentDay.items]
        .map((item, index) => ({ item, index }))
        // Root-cause fix (real 43-day US replay: a "New York" day's stay-
        // transition item read "Miami Beach -> Orlando" — completely
        // unrelated to New York) — the real, structurally-marked ground
        // transfer (isStayTransitionItem) is a genuine, day-specific
        // logistics event, not a flexible activity: it is NOT locked or
        // fixedTime (buildStayTransitionItem sets both false), and its
        // often-large travelMinutes made it consistently score HIGHEST in
        // the eviction sort below, getting physically relocated up to two
        // days forward by moveOverflowItem — landing on a day it has
        // nothing to do with, invisible to every later gate because none
        // of them re-scan for a transition marker on a day that isn't
        // itself currently a transfer day. It must never be moved off the
        // one day it's structurally tied to; if that day is still
        // overloaded, something else has to give.
        .filter(({ item }) => !isFoodItem(item.category) && !item.locked && !item.fixedTime && !isStayTransitionItem(item))
        .sort((left, right) => {
          const priorityDelta = priorityRemovalWeight(left.item.priority) - priorityRemovalWeight(right.item.priority);
          if (priorityDelta !== 0) return priorityDelta;
          const leftScore =
            (left.item.slot === "evening" || left.item.slot === "night" ? 30 : 0) +
            (left.item.approximatePrice ?? 0) +
            (left.item.travelMinutes ?? 0);
          const rightScore =
            (right.item.slot === "evening" || right.item.slot === "night" ? 30 : 0) +
            (right.item.approximatePrice ?? 0) +
            (right.item.travelMinutes ?? 0);
          return rightScore - leftScore;
        })[0];

      if (!movableIndex) break;

      const candidate = movableIndex.item;
      const remainingItems = currentDay.items.filter((_, index) => index !== movableIndex.index);
      const moved = moveOverflowItem(mutableDays, dayIndex, candidate, payload, profile);

      currentDay = fillDerivedDayFields(
        {
          ...currentDay,
          items: remainingItems,
          alternatives: moved
            ? currentDay.alternatives
            : normalizeActionableMessages([...currentDay.alternatives, candidate.name]),
        },
        payload,
        profile
      );
    }

    mutableDays[dayIndex] = currentDay;
  }

  return mutableDays;
}

/**
 * At most two dedicated food stops per day (spec item 37) — breakfast is
 * assumed near the hotel and never scheduled as its own item, and a coffee
 * stop is optional flavor, not a mandatory event. The lowest-priority,
 * non-core (not lunch/dinner) items go first — same
 * lowest-priority-removed-first rule as fixOverloadedDays/
 * enforceBudgetOnDays, so a locked/must-priority food item is never the one
 * dropped.
 */
export function enforceMealCountLimit(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  return days.map((day) => {
    const foodItems = day.items.filter((item) => isFoodItem(item.category));
    const excessCount = foodItems.length - 2;
    if (excessCount <= 0) return day;

    const removalOrder = foodItems
      .filter((item) => !item.locked && !item.fixedTime)
      .sort((left, right) => {
        const priorityDelta = priorityRemovalWeight(left.priority) - priorityRemovalWeight(right.priority);
        if (priorityDelta !== 0) return priorityDelta;
        const leftIsCore = left.slot === "lunch" || left.slot === "dinner" ? 1 : 0;
        const rightIsCore = right.slot === "lunch" || right.slot === "dinner" ? 1 : 0;
        return leftIsCore - rightIsCore;
      });

    const toRemove = new Set(removalOrder.slice(0, excessCount));
    if (toRemove.size === 0) return day;

    return fillDerivedDayFields(
      resequenceDayItems({ ...day, items: day.items.filter((item) => !toRemove.has(item)) }),
      payload,
      profile
    );
  });
}

/**
 * Minimum spacing between consecutive food stops (spec item 39) —
 * lunch→dinner needs 4h+, anything else (e.g. an extra cafe near a meal)
 * needs 3h+. Nudges the later item's own start time forward rather than
 * replacing it — same "reschedule before you replace" preference already
 * used by the scheduler.
 */
export function enforceMealSpacing(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  return days.map((day) => {
    const orderedFoodItems = [...day.items]
      .filter((item) => isFoodItem(item.category))
      .sort((left, right) => (clockToMinutes(left.plannedStartTime) ?? 0) - (clockToMinutes(right.plannedStartTime) ?? 0));

    let changed = false;
    // Real bug found during end-to-end QA generation: this used to store
    // only the nudged start time, leaving endTime stale at
    // originalStart+duration — once the start moved later than that stale
    // endTime, the item ended up with endTime BEFORE plannedStartTime (a
    // negative-duration item no real traveler could follow). Tracking both
    // times and shifting endTime by the item's own real duration keeps the
    // meal's length intact while only moving it later.
    const adjustedTimes = new Map<AiGeneratedItem, { start: string; end: string }>();

    for (let index = 1; index < orderedFoodItems.length; index += 1) {
      const previousMeal = orderedFoodItems[index - 1];
      const currentMeal = orderedFoodItems[index];
      if (currentMeal.locked || currentMeal.fixedTime) continue;

      const previousMinutes = clockToMinutes(adjustedTimes.get(previousMeal)?.start ?? previousMeal.plannedStartTime);
      const currentMinutes = clockToMinutes(currentMeal.plannedStartTime);
      if (previousMinutes == null || currentMinutes == null) continue;

      const minimumGap = previousMeal.slot === "lunch" && currentMeal.slot === "dinner" ? 240 : 180;
      if (currentMinutes - previousMinutes < minimumGap) {
        const newStartMinutes = previousMinutes + minimumGap;
        const currentEndMinutes = currentMeal.endTime ? clockToMinutes(currentMeal.endTime) : null;
        const durationMinutes =
          currentEndMinutes != null && currentEndMinutes > currentMinutes
            ? currentEndMinutes - currentMinutes
            : (currentMeal.estimatedDurationMinutes ?? 60);
        adjustedTimes.set(currentMeal, {
          start: minutesToClock(newStartMinutes),
          end: minutesToClock(newStartMinutes + durationMinutes),
        });
        changed = true;
      }
    }

    if (!changed) return day;

    // Deliberately NOT run back through resequenceDayItems here — its
    // underlying scheduleDayItems fully re-derives plannedStartTime from
    // item order/duration and would silently discard the adjusted time
    // this function just computed. fillDerivedDayFields only recomputes
    // cost/travel/warning fields and leaves plannedStartTime/endTime
    // untouched.
    return fillDerivedDayFields(
      {
        ...day,
        items: day.items.map((item) => {
          const adjusted = adjustedTimes.get(item);
          return adjusted ? { ...item, plannedStartTime: adjusted.start, endTime: adjusted.end } : item;
        }),
      },
      payload,
      profile
    );
  });
}

const WEATHER_BACKUP_OUTDOOR_SHARE_THRESHOLD = 0.6;

/**
 * Plan B (spec items 64/65) — an outdoor-heavy day gets ONE indoor backup
 * suggestion appended to its existing `alternatives` list, never inserted
 * into the main schedule (the spec's own "do not display unless needed").
 * Advisory only, not a passesValidation gate — this app has no real
 * weather forecast, so there's never a genuine "it will rain" signal to
 * act on, only a sensible fallback to have on hand.
 */
export function ensureWeatherBackup(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest
): AiGeneratedDay[] {
  return days.map((day) => {
    const anchorItems = day.items.filter((item) => isAnchorDayItem(item));
    if (anchorItems.length === 0) return day;

    const outdoorShare =
      anchorItems.filter((item) => classifyWeatherSensitivity(item) === "outdoor").length / anchorItems.length;
    if (outdoorShare <= WEATHER_BACKUP_OUTDOOR_SHARE_THRESHOLD) return day;

    const usedNames = new Set(day.items.map((item) => item.name.trim().toLowerCase()));
    const indoorBackup = [...payload.recommendations, ...payload.selectedPlaces].find(
      (candidate) =>
        classifyWeatherSensitivity(candidate) === "indoor" &&
        !usedNames.has(candidate.name.trim().toLowerCase()) &&
        // Generic worldwide architecture (Phase 14): a rain-backup
        // suggestion is still surfaced to the traveler as part of this
        // day's route — it must belong to the same area as everything
        // else in the day, not just be the first indoor place anywhere in
        // the whole country's candidate pool.
        isCandidateGeographicallyCompatibleWithDay(candidate, day.items, {})
    );
    if (!indoorBackup) return day;

    const backupNote = `חלופה למקרה של גשם: ${indoorBackup.name}`;
    if (day.alternatives.includes(backupNote)) return day;

    return { ...day, alternatives: normalizeActionableMessages([...day.alternatives, backupNote]) };
  });
}

// Day-utilization targets (spec item 25) — expressed as a share of the
// pace's own dailyCapacityMinutes (the same constant fixOverloadedDays
// already treats as the max ceiling), so "underfilled" and "overloaded" are
// two ends of one consistent scale rather than two unrelated concepts.
const UTILIZATION_TARGETS: Record<TripPreferences["tripPace"], { min: number; max: number }> = {
  relaxed: { min: 0.55, max: 0.68 },
  balanced: { min: 0.65, max: 0.78 },
  fast: { min: 0.75, max: 0.88 },
};

function buildInsertionTemplateItem(day: AiGeneratedDay): AiGeneratedItem {
  const template = day.items[0];
  if (template) return { ...template, slot: "afternoon", plannedStartTime: "", travelMinutes: null };
  return {
    name: "",
    category: "attraction",
    location: day.cityRegion,
    shortDescription: "",
    slot: "afternoon",
    plannedStartTime: "",
    estimatedDurationMinutes: null,
    approximatePrice: null,
    pricePerPerson: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: null,
    openingHours: "",
    lastEntryTime: "",
    canonicalPlaceId: "",
    reservationRequired: false,
    transportation: "",
    mapLink: "",
    lat: null,
    lon: null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "optional",
    fixedTime: false,
  };
}

/**
 * Real fix for an underfilled day (spec item 23) — until now,
 * missingAnchorDays was only ever diagnosed, never repaired, which is the
 * direct cause of the reported "empty Day 1" symptom. Inserts nearby unused
 * candidates (reusing the exact same scoring machinery rebalanceDayItems
 * already uses for replacements) until the day's load reaches its pace's
 * utilization target — never past it, and never on a transfer/day-trip day,
 * which are legitimately light by design.
 */
export function fillUnderfilledDay(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /** Itinerary-wide, shared across every day this pass fills (spec §B upgrade of an already itinerary-wide tracker — see rebalanceDayItems' identical note). */
  usageState: ItineraryUsageState
): AiGeneratedDay {
  if (isIntercityTransferDay(day) || isDayTripDay(day)) return day;

  const target = UTILIZATION_TARGETS[payload.preferences.tripPace] ?? UTILIZATION_TARGETS.balanced;
  let mutableDay = day;
  let inserted = 0;

  while (inserted < 4) {
    const utilization =
      profile.dailyCapacityMinutes > 0 ? calculateDayLoadMinutes(mutableDay) / profile.dailyCapacityMinutes : 1;
    if (utilization >= target.min) break;

    const template = buildInsertionTemplateItem(mutableDay);
    const replacement = pickReplacementRecommendation({
      traceSource: "day_fill",
      payload,
      day: mutableDay,
      item: template,
      profile,
      usageState,
      replacementMode: "non_food",
    });
    if (!replacement) break;

    const newItem = buildReplacementItem(replacement, template, mutableDay, payload);
    registerItineraryUsage(usageState, newItem);
    mutableDay = { ...mutableDay, items: [...mutableDay.items, newItem] };
    inserted += 1;
  }

  return inserted > 0 ? resequenceDayItems(mutableDay) : mutableDay;
}

export function enforceBudgetOnDays(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
) {
  if (profile.budgetSoftCeiling == null) return days;

  const mutableDays = [...days];
  let attempts = 0;
  // Root-cause fix (spec §A/§F) — see enforceNormalDayLocality's identical
  // comment. This one was already itinerary-wide (rebuilt fresh from
  // mutableDays on every inner iteration), just with the weaker single-key
  // identity (spec §B) — now built once and kept current incrementally.
  const usageState = buildItineraryUsageState(mutableDays);

  while (attempts < 14) {
    attempts += 1;
    const total = mutableDays.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0);
    if (total <= profile.budgetSoftCeiling) break;

    let changed = false;

    for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
      const day = mutableDays[dayIndex];
      const overCapCandidates = day.items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => {
          if (item.locked || item.fixedTime) return false;
          const cap = getBudgetCapForItem(item, profile);
          if (cap == null || item.approximatePrice == null) return false;
          return (
            item.approximatePrice > cap ||
            (!profile.luxuryEnabled && isFoodItem(item.category) && isPremiumVenue(item))
          );
        })
        .sort((left, right) => priorityRemovalWeight(left.item.priority) - priorityRemovalWeight(right.item.priority));
      const expensiveIndex = overCapCandidates[0]?.index ?? -1;

      if (expensiveIndex !== -1) {
        const targetItem = day.items[expensiveIndex];
        releaseItineraryUsage(usageState, targetItem);
        const replacement = pickReplacementRecommendation({
          traceSource: "other_existing_path",
          payload,
          day,
          item: targetItem,
          profile,
          usageState,
        });

        const nextItems = [...day.items];
        nextItems[expensiveIndex] = replacement
          ? buildReplacementItem(replacement, targetItem, day, payload)
          : buildFreeExplorationReplacement(targetItem, day);
        registerItineraryUsage(usageState, nextItems[expensiveIndex]);

        mutableDays[dayIndex] = fillDerivedDayFields({ ...day, items: nextItems }, payload, profile);
        changed = true;
        break;
      }

      if (
        day.accommodationCost != null &&
        profile.accommodationBudgetPerDay != null &&
        day.accommodationCost > profile.accommodationBudgetPerDay * 1.15
      ) {
        mutableDays[dayIndex] = fillDerivedDayFields(
          {
            ...day,
            accommodation: day.cityRegion
              ? `לינה נוחה באזור ${normalizeAreaLabel(day.cityRegion)}`
              : day.accommodation,
            accommodationCost: profile.accommodationBudgetPerDay,
          },
          payload,
          profile
        );
        changed = true;
        break;
      }
    }

    if (!changed) break;
  }

  return mutableDays;
}

/**
 * Active repair for content Gemini itself already returned wrong (spec §B).
 * Note this is NOT starting from zero: `repairDayGeography` (called from
 * inside `repairDayStructure`, which already runs at the top of every
 * attempt below) already detects a day's own crossCityItems and replaces
 * the worst offender in place, preferring a real matching candidate over a
 * generic placeholder — so by the time this function runs, most real
 * cross-region content is already gone. What this adds on top, genuinely
 * new this pass:
 *   1. A "move to another day" preference — if some OTHER day's own real
 *      content already sits close to the outlier, relocating it there beats
 *      replacing it with a placeholder (repairDayGeography has no
 *      cross-day step at all; it can only ever act within one day).
 *   2. Structured protectedGeographicConflict reporting — a locked/
 *      fixed-time outlier was already silently left in place by
 *      repairDayGeography's own `!item.locked && !item.fixedTime` guards;
 *      this surfaces that instead of leaving it invisible (spec §B5).
 * Runs before alignDaysToTripFrame so that by the time titles/cityRegion
 * get synced to the TripFrame, the day's actual content already deserves
 * that label (spec §C6).
 */
export function repairCrossRegionDayContent(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /**
   * Round 9.4.3 §F root-cause fix — proven production evidence (traceId
   * gen-mu7kn7ef-s9cg5z4x): "Harvard Club of Boston" and "The Glen House
   * Hotel" oscillated phase-6 -> phase-2 -> phase-6 across repair
   * attempts. Root cause: findCompatibleDayIndexForOutlier picked a
   * target day purely by whichever OTHER day currently happened to have
   * the nearest real coordinates — a signal that shifts every attempt as
   * unrelated repair steps churn other days' content, with zero awareness
   * of tripFrame/phase structure at all. enforceNormalDayLocality (the
   * function that IS phase/anchor-authoritative) never oscillates in
   * isolation for the same coordinate, because its own
   * "belongsToAnotherStay" comparison is a pure function of the item's
   * OWN coordinates against the TripFrame's fixed anchors — it settles
   * once. Optional so this remains additive: every pre-existing call site
   * that predates this parameter keeps compiling and keeps its old
   * (unbounded) search — only repairPlan's own real call site below
   * passes it.
   */
  tripFrame?: TripFrame | null
): { days: AiGeneratedDay[]; protectedGeographicConflicts: ProtectedGeographicConflict[] } {
  const protectedGeographicConflicts: ProtectedGeographicConflict[] = [];
  const workingDays = days.slice();
  // Root-cause fix (spec §A) — see repairOpeningHoursViolations' identical
  // comment; the "move to another day" branch below never changes this
  // outlier's OWN usage (still used exactly once, just relocated), only
  // the actual replace-with-a-different-real-place branch does.
  const usageState = buildItineraryUsageState(workingDays);

  for (let dayIndex = 0; dayIndex < workingDays.length; dayIndex += 1) {
    const day = workingDays[dayIndex];
    const geography = analyzeDayGeography(day, profile);
    if (geography.crossCityItems.length === 0) continue;
    if (isIntercityTransferDay(day) || isDayTripDay(day)) continue;

    const outlierNames = new Set(geography.crossCityItems);
    let mutableDay = day;
    let touched = false;

    for (const outlierName of outlierNames) {
      const outlier = mutableDay.items.find((item) => item.name === outlierName);
      if (!outlier) continue;

      if (isProtectedItem(outlier)) {
        protectedGeographicConflicts.push({
          dayNumber: mutableDay.dayNumber,
          itemName: outlier.name,
          lat: outlier.lat,
          lon: outlier.lon,
          reason: "locked/fixed-time item is geographically incompatible with this day's other content",
        });
        continue;
      }

      const targetIndex = findCompatibleDayIndexForOutlier(workingDays, dayIndex, outlier, profile, tripFrame);
      if (targetIndex != null) {
        workingDays[targetIndex] = {
          ...workingDays[targetIndex],
          items: [...workingDays[targetIndex].items, outlier],
        };
        mutableDay = { ...mutableDay, items: mutableDay.items.filter((item) => item !== outlier) };
        touched = true;
        continue;
      }

      // Same "real candidate first, generic placeholder second" order as
      // repairDayGeography — this outlier already survived that pass, so a
      // fresh lookup rarely finds anything new, but it's never skipped
      // purely for that reason.
      // pickReplacementRecommendation excludes `item` (the outlier) from
      // its own internal anchor/scoring context itself (spec "תיקון
      // גנרי, לא תיקון תשיעי") — passing mutableDay as-is here (still
      // including the outlier) is safe, not a bug.
      releaseItineraryUsage(usageState, outlier);
      const replacement = pickReplacementRecommendation({
        traceSource: "locality_repair",
        payload,
        day: mutableDay,
        item: outlier,
        profile,
        usageState,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, outlier, mutableDay, payload)
        : buildFreeExplorationReplacement(outlier, mutableDay);
      registerItineraryUsage(usageState, nextItem);
      mutableDay = {
        ...mutableDay,
        items: mutableDay.items.map((item) => (item === outlier ? nextItem : item)),
      };
      touched = true;
    }

    if (touched) {
      workingDays[dayIndex] = fillDerivedDayFields(
        resequenceDayItems(normalizeDayCollections(mutableDay)),
        payload,
        profile
      );
    }
  }

  return { days: workingDays, protectedGeographicConflicts };
}

/**
 * Nearest OTHER day whose own items already sit close to the outlier, with
 * room left under its own capacity — never a day already flagged as a
 * transfer/day-trip, whose cross-region spread is expected.
 *
 * Round 9.4.3 §F — when tripFrame is available, candidate days are
 * restricted to the origin day's OWN authoritative phase (never a
 * different phase/stay). This function's job is to fix a WITHIN-STAY
 * geographic outlier (an item that doesn't cohere with the rest of its
 * own day) by relocating it to a better-fitting day of the SAME stay —
 * it must never be the mechanism that decides an item belongs to a
 * DIFFERENT stay entirely, since its "nearest coordinates" signal is
 * itself derived from whatever content OTHER days currently happen to
 * hold, which shifts across repair attempts as unrelated steps churn
 * those days (the proven root cause of the phase-6/phase-2 oscillation).
 * A genuine cross-stay misplacement is enforceNormalDayLocality's job —
 * that function is anchor-authoritative and settles once; this one, once
 * bounded to same-phase days, can never fight it. When no tripFrame is
 * given (every pre-existing caller), the search is unbounded exactly as
 * before.
 */
function findCompatibleDayIndexForOutlier(
  days: AiGeneratedDay[],
  originIndex: number,
  outlier: AiGeneratedItem,
  profile: TripPreferenceProfile,
  tripFrame?: TripFrame | null
): number | null {
  if (outlier.lat == null || outlier.lon == null) return null;

  const originPhase = tripFrame ? findFramePhaseForDay(tripFrame, days[originIndex].dayNumber) : null;

  let bestIndex: number | null = null;
  let bestDistanceKm = CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM;

  for (let index = 0; index < days.length; index += 1) {
    if (index === originIndex) continue;
    const candidateDay = days[index];
    if (originPhase && findFramePhaseForDay(tripFrame as TripFrame, candidateDay.dayNumber)?.id !== originPhase.id) continue;
    if (isIntercityTransferDay(candidateDay) || isDayTripDay(candidateDay)) continue;
    if (calculateDayLoadMinutes(candidateDay) >= profile.dailyCapacityMinutes) continue;

    const anchorsWithCoordinates = candidateDay.items.filter((item) => item.lat != null && item.lon != null);
    if (anchorsWithCoordinates.length === 0) continue;

    const nearestDistanceKm = Math.min(
      ...anchorsWithCoordinates.map((item) => haversineKm(item.lat as number, item.lon as number, outlier.lat as number, outlier.lon as number))
    );
    if (nearestDistanceKm < bestDistanceKm) {
      bestDistanceKm = nearestDistanceKm;
      bestIndex = index;
    }
  }

  return bestIndex;
}

const TRANSPORT_MODE_LABELS_HE: Record<TransportMode, string> = {
  walking: "הליכה",
  transit: "תחבורה ציבורית",
  car: "נסיעה ברכב",
  taxi: "מונית",
  train: "רכבת",
  bus: "אוטובוס",
};

/**
 * Explicit stay-transition timeline item (spec §C7) — represents a base
 * change as a real, visible item rather than leaving it implicit, so every
 * later feasibility/capacity calculation (calculateDayLoadMinutes,
 * scheduling, the overload repair pass) sees the real time it consumes,
 * same as any other item.
 */
/**
 * A stable, reliable marker (spec §Q) identifying an item as ONE THIS
 * FUNCTION generated for exactly this fromBase→toBase pair — reuses the
 * otherwise-always-empty canonicalPlaceId field rather than adding a new
 * one. Lets enforceStayTransitions tell "my own transition item, now
 * stale because the TripFrame changed since it was created" apart from
 * "Gemini's own transport content, which is never safe to delete" — the
 * ONLY items ever removed as stale are ones carrying this exact prefix.
 */
function buildTransitionMarker(fromBase: string, toBase: string): string {
  return `transition:${fromBase}->${toBase}`;
}

export function buildStayTransitionItem(transition: StayTransition): AiGeneratedItem {
  const modeLabel = TRANSPORT_MODE_LABELS_HE[transition.transportMode];
  const duration = Math.max(transition.estimatedTravelMinutes ?? 60, 15);

  return {
    name: `${modeLabel}: ${transition.fromBase} → ${transition.toBase}`,
    category: "transportation",
    location: transition.toBase,
    shortDescription: `מעבר בסיס לינה מ${transition.fromBase} ל${transition.toBase}.`,
    slot: "morning",
    plannedStartTime: "09:00",
    estimatedDurationMinutes: duration,
    approximatePrice: 0,
    pricePerPerson: null,
    priceOriginalAmount: 0,
    priceOriginalCurrency: "ILS",
    priceConvertedAmount: 0,
    priceExchangeRate: 1,
    priceRateTimestamp: new Date().toISOString(),
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: duration,
    openingHours: "",
    lastEntryTime: "",
    canonicalPlaceId: buildTransitionMarker(transition.fromBase, transition.toBase),
    reservationRequired: false,
    transportation: modeLabel,
    mapLink: buildMapLink(transition.toBase, transition.toCoordinates?.lat ?? null, transition.toCoordinates?.lon ?? null),
    lat: transition.toCoordinates?.lat ?? null,
    lon: transition.toCoordinates?.lon ?? null,
    bookingWarning: "",
    alternativeSuggestion: "",
    recommendationId: null,
    locked: false,
    priority: "preferred",
    fixedTime: false,
  };
}

/**
 * No-teleportation enforcement (spec §C2/§C3/§E) — every stay transition
 * genuinely consumes schedule time on the day it happens, visible to every
 * later capacity/feasibility check because it's a real item, not a side
 * channel. Idempotent across repair attempts: a transition already
 * represented (any transportation item carrying most of its estimated
 * minutes) is left alone rather than duplicated.
 */
export function enforceStayTransitions(
  days: AiGeneratedDay[],
  transitions: StayTransition[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): { days: AiGeneratedDay[]; impossibleStayTransitionDetails: ImpossibleStayTransition[] } {
  const impossibleStayTransitionDetails: ImpossibleStayTransition[] = [];
  const mutableDays = [...days];
  const transitionByDayNumber = new Map(transitions.map((transition) => [transition.dayNumber, transition]));

  // Root-cause fix (real 43-day US replay: a "New York" day's item read
  // "Miami Beach -> Orlando", a "New Orleans" day's item read
  // "Pennsylvania -> West Virginia") — the OLD stale-marker cleanup below
  // only ever ran for days CURRENTLY in `transitions` (i.e. days this
  // function is about to (re)insert a transition into). A marked item
  // stranded on some OTHER day — moved there by fixOverloadedDays'
  // eviction sort (now separately fixed to never select a transition item
  // at all, but this sweep is the real, general-purpose backstop), or left
  // behind after attemptStayStructureRepair changed which days are
  // transfer days at all, or never cleaned up because its own
  // (now-fixed) duplicate-area-label transition computed 0 minutes and
  // was skipped by the `requiredMinutes<=0` guard below — was invisible to
  // every other gate (enforceTransportRoleGuard/enforceFinalPlaceLegalityGate
  // both structurally exempt a real transition marker; enforceNormalDayLocality
  // excludes category "transportation" from its real-place checks). A
  // transition marker only ever means anything on the ONE day it names —
  // this sweep runs over EVERY day, independent of the insertion loop
  // below, and removes any marker that doesn't match THAT day's own
  // current (possibly nonexistent) transition. Only this function ever
  // sets the marker, so there's no ambiguity about whose content it is; a
  // transportation item with no marker at all (Gemini's own real content)
  // is never touched here.
  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    const ownTransition = transitionByDayNumber.get(day.dayNumber);
    const ownMarker = ownTransition ? buildTransitionMarker(ownTransition.fromBase, ownTransition.toBase) : null;
    const staleMarkedItems = day.items.filter(
      (item) => item.canonicalPlaceId.startsWith("transition:") && item.canonicalPlaceId !== ownMarker
    );
    if (staleMarkedItems.length > 0) {
      mutableDays[dayIndex] = fillDerivedDayFields(
        resequenceDayItems(normalizeDayCollections({ ...day, items: day.items.filter((item) => !staleMarkedItems.includes(item)) })),
        payload,
        profile
      );
    }
  }

  for (const transition of transitions) {
    const requiredMinutes = transition.estimatedTravelMinutes;
    if (requiredMinutes == null || requiredMinutes <= 0) continue;

    const dayIndex = mutableDays.findIndex((day) => day.dayNumber === transition.dayNumber);
    if (dayIndex === -1) continue;
    const day = mutableDays[dayIndex];
    const currentMarker = buildTransitionMarker(transition.fromBase, transition.toBase);

    // Only MY OWN marker for this exact pair counts as "already
    // represented" — a Gemini-authored transport item (unmarked) is real
    // content this function has no way to verify or safely discard, so it
    // never blocks inserting the correct, verified transition alongside it.
    const alreadyRepresented = day.items.some((item) => item.canonicalPlaceId === currentMarker);
    if (alreadyRepresented) continue;

    // Section E5: a transition whose own required time alone already
    // exceeds the day's realistic capacity is genuinely impossible — no
    // amount of trimming other content fixes that. Still represented (spec
    // §D: "visible to feasibility calculations", never hidden) rather than
    // silently dropped.
    if (requiredMinutes >= profile.dailyCapacityMinutes) {
      impossibleStayTransitionDetails.push({
        fromStay: transition.fromBase,
        toStay: transition.toBase,
        dayNumber: transition.dayNumber,
        requiredTravelMinutes: requiredMinutes,
        availableMinutes: profile.dailyCapacityMinutes,
        reason: "estimated transition travel time alone exceeds the day's realistic daily capacity",
      });
    }

    const transitionItem = buildStayTransitionItem(transition);
    const withTransition = fillDerivedDayFields(
      resequenceDayItems({ ...day, items: [transitionItem, ...day.items] }),
      payload,
      profile
    );

    // Section E1-E2: shrink the day's OTHER optional content around the
    // now-real transition time, same generic overload repair every other
    // day already uses — never removes protected items. Skipped for an
    // already-impossible transition (flagged above): fixOverloadedDays has
    // no notion of "this specific item must never be trimmed away," and
    // when the transition ALONE exceeds capacity it would otherwise be the
    // very thing trimmed first — the one outcome spec §D explicitly rules
    // out ("visible to feasibility calculations", never hidden).
    mutableDays[dayIndex] =
      requiredMinutes < profile.dailyCapacityMinutes && calculateDayLoadMinutes(withTransition) > profile.dailyCapacityMinutes
        ? (fixOverloadedDays([withTransition], payload, profile)[0] ?? withTransition)
        : withTransition;
  }

  return { days: mutableDays, impossibleStayTransitionDetails };
}

/**
 * Section A1/A6/A7 — before accepting an impossible stay transition as a
 * hard failure, attempt bounded generic structural repair on the TripFrame
 * itself (repairImpossibleStayTransition — boundary shift, base
 * reselection, merge). Each successful structural change immediately
 * rebuilds the derived StayTransition list from the NEW frame (spec §A6 —
 * never patches stale derived state) before checking whether any
 * transition is still impossible. Bounded by
 * MAX_STAY_STRUCTURE_REPAIR_PASSES (spec §A7) — never loops indefinitely,
 * and gives up (returning the frame/transitions unchanged from that point)
 * the moment a pass makes no progress.
 */
export function attemptStayStructureRepair(
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  candidateAreas: string[],
  protectedDayNumbers: Set<number>,
  profile: TripPreferenceProfile
): { tripFrame: TripFrame; stayTransitions: StayTransition[]; changed: boolean } {
  let frame = tripFrame;
  let changed = false;

  for (let pass = 0; pass < MAX_STAY_STRUCTURE_REPAIR_PASSES; pass += 1) {
    const transitions = buildStayTransitions(frame, areaAnchors);
    const impossible = transitions.find(
      (transition) =>
        transition.estimatedTravelMinutes != null && transition.estimatedTravelMinutes >= profile.dailyCapacityMinutes
    );
    if (!impossible) break;

    const phaseIndex = frame.phases.findIndex(
      (phase) => phase.areaLabel === impossible.toBase && phase.startDayNumber === impossible.dayNumber
    );
    if (phaseIndex <= 0) break;

    const result = repairImpossibleStayTransition({
      frame,
      phaseIndex,
      candidateAreas,
      protectedDayNumbers,
      isTransitionFeasible: (fromArea, toArea) => {
        const fromCoordinates = areaAnchors.get(fromArea);
        const toCoordinates = areaAnchors.get(toArea);
        if (!fromCoordinates || !toCoordinates) return false;
        const distanceKm = haversineKm(fromCoordinates.lat, fromCoordinates.lon, toCoordinates.lat, toCoordinates.lon);
        const mode = selectTransportMode(distanceKm, { hasLuggage: true, isIntercity: true });
        return estimateMinutesForMode(distanceKm, mode) < profile.dailyCapacityMinutes;
      },
    });
    if (!result.changed) break;
    frame = result.frame;
    changed = true;
  }

  return { tripFrame: frame, stayTransitions: buildStayTransitions(frame, areaAnchors), changed };
}

function alignDaysToTripFrame(days: AiGeneratedDay[], tripFrame: TripFrame): AiGeneratedDay[] {
  return days.map((day) => {
    // Root-cause fix (real replay: a "New York" day whose transition item
    // read "Miami Beach -> Orlando" kept that wrong cityRegion). The old
    // check was `isIntercityTransferDay(day)` — a TEXT heuristic over the
    // day's own title/notes/transportSegments, and transportSegments is
    // itself SYNTHESIZED from the day's items (fillDerivedDayFields), so a
    // stray transition item or an airport item made the day "look like" a
    // transfer day and exempt itself from the very correction that would
    // fix it. deriveDayType is structural: a day is a transfer only when
    // its TripFrame phase differs from the previous day's phase, never
    // because of what text its items happen to contain.
    const derivedDayType = deriveDayType(day, tripFrame, null);
    if (derivedDayType === "transfer") return day;
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) return day;
    if (sharesDayArea(day.cityRegion || day.accommodation, phase.areaLabel)) return day;

    // A genuine mismatch was just found — the AI's own title very likely
    // still names the OLD (wrong) area (spec §C6: "title = Haifa, activities
    // = Jerusalem" surviving even after the underlying content is fixed).
    // Only rewritten in this branch, i.e. only when a real correction is
    // happening — an untouched day keeps its original AI-written title
    // exactly as-is.
    return {
      ...day,
      title: `יום ${day.dayNumber} ב${phase.areaLabel}`,
      cityRegion: phase.areaLabel,
      accommodation:
        day.accommodation && day.accommodation.trim() ? day.accommodation : `לינה נוחה באזור ${phase.areaLabel}`,
    };
  });
}

/**
 * Spec "ONE DAY HAS ONE AUTHORITATIVE STRUCTURAL OWNER" (Round 4) — the
 * single place that binds every day to its canonical TripFrame owner and
 * makes ALL presentation/content fields derive from it:
 *   - day.phaseId        := findFramePhaseForDay(...).id
 *   - day.cityRegion     := phase.areaLabel        (display owner)
 *   - day.accommodation  := "לינה נוחה באזור <phase.areaLabel>"  (lodging owner)
 *   - day.title          := "יום N ב<phase.areaLabel>"          (title owner)
 *   - every SYNTHETIC item's area label (free-time / meal-opportunity /
 *     transit-practical) := phase.areaLabel — regenerated from the canonical
 *     builder, never string-patched.
 *
 * Runs on the FINAL frame, for EVERY day type. A transfer day's owner is
 * its destination phase (where the traveller sleeps that night); the
 * "from → to" information lives on the structural transition item, not on
 * the day's display/lodging fields. A day-trip day's owner stays the base
 * — the excursion is visible through its own real item, and lodging/display
 * both remain the base, so "display owner == lodging owner == structural
 * owner" holds for every day type.
 *
 * A field is left alone only when it already `sharesDayArea` with the
 * owner (a real hotel name in the right city, an AI title already naming
 * the right area) — otherwise it is rewritten. Real items are never
 * touched here (their geography is the gates' job); only synthetic items,
 * whose area label is pure presentation, are re-derived.
 */
export function normalizeDayOwnershipToFrame(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  const otherPhaseLabels = tripFrame.phases.map((phase) => phase.areaLabel);

  return days.map((day) => {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) return day; // no structural owner to bind to — never block on missing structure
    const ownerLabel = phase.areaLabel;

    const cityRegion = sharesDayArea(day.cityRegion, ownerLabel) ? day.cityRegion : ownerLabel;
    const accommodation = phraseNamesArea(day.accommodation, ownerLabel)
      ? day.accommodation
      : `לינה נוחה באזור ${ownerLabel}`;
    const title = phraseNamesArea(day.title, ownerLabel) ? day.title : `יום ${day.dayNumber} ב${ownerLabel}`;

    // Round 5 — the day's narrative (day.notes, printed under the PDF
    // header) is a template string of the shape "... היום בנוי סביב <area>
    // ...". It is written once (Gemini or the fallback builder) and never
    // re-derived. When it positively names a DIFFERENT TripFrame phase's
    // area than this day's owner, regenerate it from the canonical
    // owner-anchored template — not a free-text search/replace.
    const notesNamesForeignArea = otherPhaseLabels.some(
      (label) => !sharesDayArea(label, ownerLabel) && phraseNamesArea(day.notes, label)
    );
    const notes =
      notesNamesForeignArea || (day.notes.includes("בנוי סביב") && !phraseNamesArea(day.notes, ownerLabel))
        ? `היום בנוי סביב ${ownerLabel} כדי לשמור על קצב טבעי, אוכל קרוב ומעברים הגיוניים.`
        : day.notes;

    const boundDay: AiGeneratedDay = { ...day, phaseId: phase.id, cityRegion, accommodation, title, notes };

    const ownerBaked = { ...boundDay, cityRegion: ownerLabel };
    let itemsChanged = false;
    const items = boundDay.items.map((item) => {
      // Round 5 — a GENERIC meal-opportunity placeholder (role-tagged OR a
      // coordinate-less unmatched Gemini restaurant OR a placeholder whose
      // itemRole was dropped on a save round-trip) carries only a
      // presentation area label. Regenerate it from the canonical owner —
      // this wipes a stale "Blue Bottle Coffee / San Francisco" name on an
      // LA-owned day and replaces it with an LA meal-opportunity block.
      if (isGenericMealOpportunity(item) || item.itemRole === "free_time") {
        const rebuilt = buildFreeExplorationReplacement(item, ownerBaked);
        itemsChanged = true;
        return { ...rebuilt, slot: item.slot, plannedStartTime: item.plannedStartTime };
      }
      if (!isSyntheticScheduleItem(item)) return item; // a real, verifiable venue — the gates' job, not this pass's
      // transit_practical / other synthetic: name+description are generic
      // (no embedded area) — only the location tag + mapLink carry an area.
      if (!sharesDayArea(item.location, ownerLabel)) {
        itemsChanged = true;
        return { ...item, location: ownerLabel, mapLink: buildMapLink(ownerLabel, null, null) };
      }
      return item;
    });

    const next: AiGeneratedDay =
      itemsChanged || cityRegion !== day.cityRegion || notes !== day.notes ? { ...boundDay, items } : boundDay;
    return itemsChanged
      ? fillDerivedDayFields(resequenceDayItems(normalizeDayCollections(next)), payload, profile)
      : next;
  });
}

function capArrivalDepartureDays(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayCount: number
): AiGeneratedDay[] {
  if (days.length === 0) return days;
  const tightProfile: TripPreferenceProfile = {
    ...profile,
    dailyCapacityMinutes: Math.round(profile.dailyCapacityMinutes * 0.65),
  };

  return days.map((day) => {
    const isArrival = day.dayNumber === 1;
    const isDeparture = day.dayNumber === dayCount;
    if ((!isArrival && !isDeparture) || isIntercityTransferDay(day)) return day;

    const [tightened] = fixOverloadedDays([day], payload, tightProfile);
    return tightened ?? day;
  });
}

/** Mirrors capArrivalDepartureDays's item-level checks — real activities are not allowed before landing or after the return-flight buffer starts. */
function itemViolatesArrivalDepartureWindow(
  item: AiGeneratedItem,
  day: AiGeneratedDay,
  isArrivalDay: boolean,
  isDepartureDay: boolean,
  window: ArrivalDepartureWindow
): boolean {
  if (NON_ACTIVITY_CATEGORIES.has(item.category)) return false;
  return violatesArrivalDepartureWindow(
    item.plannedStartTime,
    day.date,
    isArrivalDay,
    isDepartureDay,
    window,
    resolveItemEffectiveEndTime(item)
  );
}

/**
 * Flight-aware repair pass (spec §D16/§E.1/§E.2) — a real, non-logistics
 * activity scheduled before the traveler could realistically have landed
 * and checked in, or after they'd need to already be heading to the
 * airport, gets bumped to the next day (arrival side, reusing
 * moveOverflowItem's forward search) or dropped to alternatives (departure
 * side, since there is no later day to move it to). Locked/fixed-time items
 * are never touched, matching every other repair pass in this file.
 */
/**
 * Section A4's repair cascade for a flexible item whose real interval
 * crosses the arrival/departure cutoff — move earlier -> replace -> (the
 * caller removes it if this returns null). "Shorten" is deliberately not
 * attempted generically: arbitrarily cutting a real place's visit length is
 * the one step the spec itself gates on "only if semantically valid", and
 * this app has no per-place signal to judge that safely — removal (the
 * pre-existing, unconditionally-safe fallback) is preferred over guessing.
 * Never called for a locked/fixedTime item — those are filtered out by the
 * caller before this runs.
 */
function repairArrivalDepartureWindowViolation(
  day: AiGeneratedDay,
  item: AiGeneratedItem,
  isArrivalDay: boolean,
  isDepartureDay: boolean,
  window: ArrivalDepartureWindow,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  usageState: ItineraryUsageState
): AiGeneratedDay | null {
  // 1. Move earlier within the day: put it first among the day's flexible
  // items and reschedule — often enough on its own to pull its end back
  // under a departure cutoff, or its start back after an arrival floor.
  const reordered: AiGeneratedDay = { ...day, items: [item, ...day.items.filter((candidate) => candidate !== item)] };
  const rescheduled = fillDerivedDayFields(resequenceDayItems(reordered), payload, profile);
  const movedItem = rescheduled.items.find((candidate) => candidate.name === item.name);
  if (movedItem && !itemViolatesArrivalDepartureWindow(movedItem, rescheduled, isArrivalDay, isDepartureDay, window)) {
    return rescheduled;
  }

  // 2. Replace with a real, geographically-compatible nearby alternative —
  // same candidate search the rest of the repair pipeline already uses;
  // its own scheduling still has to end up window-safe, checked below.
  const dayWithoutItem = { ...day, items: day.items.filter((candidate) => candidate !== item) };
  // Root-cause fix (spec §A/§F "transfer_repair must never reinsert a
  // globally used real POI") — released unconditionally: a failed
  // replacement attempt below still returns null, and the caller removes
  // `item` from the day entirely on a null return, so its usage must stay
  // released either way, never restored.
  releaseItineraryUsage(usageState, item);
  const replacement = pickReplacementRecommendation({
    traceSource: "transfer_repair",
    payload,
    day: dayWithoutItem,
    item,
    profile,
    usageState,
  });
  if (replacement) {
    const nextItem = buildReplacementItem(replacement, item, dayWithoutItem, payload);
    const withReplacement = fillDerivedDayFields(
      resequenceDayItems({ ...dayWithoutItem, items: [...dayWithoutItem.items, nextItem] }),
      payload,
      profile
    );
    const placedReplacement = withReplacement.items.find((candidate) => candidate.name === nextItem.name);
    if (
      placedReplacement &&
      !itemViolatesArrivalDepartureWindow(placedReplacement, withReplacement, isArrivalDay, isDepartureDay, window)
    ) {
      registerItineraryUsage(usageState, nextItem);
      return withReplacement;
    }
  }

  return null;
}

export function enforceArrivalDepartureWindow(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  window: ArrivalDepartureWindow,
  dayCount: number
): AiGeneratedDay[] {
  if (!window.earliestUsableTimeOnArrivalDay && !window.latestUsableTimeOnDepartureDay) return days;

  const mutableDays = [...days];
  const usageState = buildItineraryUsageState(mutableDays);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    let day = mutableDays[dayIndex];
    const isArrivalDay = day.dayNumber === 1;
    const isDepartureDay = day.dayNumber === dayCount;
    if (!isArrivalDay && !isDepartureDay) continue;

    const violating = day.items.filter(
      (item) =>
        !item.locked &&
        !item.fixedTime &&
        itemViolatesArrivalDepartureWindow(item, day, isArrivalDay, isDepartureDay, window)
    );
    if (violating.length === 0) continue;

    let alternatives = day.alternatives;

    for (const item of violating) {
      // Re-read the current item from `day` (name-matched) — an earlier
      // iteration's repair may have already rescheduled/replaced content
      // around it.
      const currentItem = day.items.find((candidate) => candidate.name === item.name);
      if (!currentItem) continue;

      const repaired = repairArrivalDepartureWindowViolation(
        day,
        currentItem,
        isArrivalDay,
        isDepartureDay,
        window,
        payload,
        profile,
        usageState
      );
      if (repaired) {
        day = repaired;
        continue;
      }

      // repairArrivalDepartureWindowViolation already released currentItem's
      // usage unconditionally above (a failed repair means it's about to
      // either move to another day or be removed outright) — a successful
      // move re-registers it since it's still a real, scheduled place, just
      // relocated; a genuine removal leaves it released.
      const moved = isArrivalDay ? moveOverflowItem(mutableDays, dayIndex, currentItem, payload, profile) : false;
      if (moved) registerItineraryUsage(usageState, currentItem);
      day = { ...day, items: day.items.filter((candidate) => candidate !== currentItem) };
      if (!moved) {
        alternatives = normalizeActionableMessages([...alternatives, currentItem.name]);
      }
    }

    // Always resequence at the end, not just when an item was moved/
    // replaced above — an item that was removed outright still leaves the
    // rest of the day needing a fresh, consistent set of real end times.
    mutableDays[dayIndex] = fillDerivedDayFields(resequenceDayItems({ ...day, alternatives }), payload, profile);
  }

  return mutableDays;
}

/**
 * Real bug found during end-to-end QA generation (a live Greece trip with
 * a 10:40 departure): enforceArrivalDepartureWindow only ever REMOVES
 * items that don't fit the real flight-driven window, with no guarantee
 * anything is left afterward — a tight enough departure stripped every
 * single item from the last day, leaving it completely empty. Two real
 * travelers looking at "Day 5: (nothing)" would have no idea they still
 * need to check out, pack, and get to the airport. This guarantees at
 * least one minimal logistics item survives on an arrival/departure day
 * that would otherwise end up with zero items.
 *
 * The item's own time is pinned directly from the real window (fixedTime,
 * bypassing resequenceDayItems/scheduleDayItems entirely) rather than a
 * generic "08:00" guess — a first version of this fix used a fixed guess
 * and let the generic scheduler place it, which anchored it to the day's
 * default 09:00 start regardless of the actual flight: for the 10:40
 * departure this reproduced, that produced "checkout, ends 10:30" — ten
 * minutes before the flight, actively unsafe advice.
 */
export function ensureArrivalDepartureDayHasContent(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayCount: number,
  window?: ArrivalDepartureWindow | null
): AiGeneratedDay[] {
  return days.map((day) => {
    const isArrivalDay = day.dayNumber === 1;
    const isDepartureDay = day.dayNumber === dayCount;
    if ((!isArrivalDay && !isDepartureDay) || day.items.length > 0) return day;

    const area = normalizeAreaLabel(day.cityRegion || payload.countryName);
    let plannedStartTime = isDepartureDay ? "08:00" : "20:00";
    let endTime = isDepartureDay ? "09:30" : "21:30";

    if (isDepartureDay && window?.latestUsableTimeOnDepartureDay?.date === day.date) {
      const cutoff = window.latestUsableTimeOnDepartureDay.time;
      const cutoffMinutes = clockToMinutes(cutoff) ?? 9 * 60 + 30;
      endTime = cutoff;
      plannedStartTime = minutesToClock(Math.max(cutoffMinutes - 90, 0));
    } else if (isArrivalDay && window?.earliestUsableTimeOnArrivalDay?.date === day.date) {
      const earliest = window.earliestUsableTimeOnArrivalDay.time;
      const earliestMinutes = clockToMinutes(earliest) ?? 20 * 60;
      plannedStartTime = earliest;
      endTime = minutesToClock(Math.min(earliestMinutes + 90, 23 * 60 + 45));
    }

    const logisticsItem: AiGeneratedItem = {
      name: isDepartureDay ? "צ'ק-אאוט ונסיעה לשדה התעופה" : "נחיתה, קליטת מזוודות והגעה ללינה",
      category: "practical",
      location: area,
      shortDescription: isDepartureDay
        ? "לוח הזמנים של הטיסה לא משאיר זמן לפעילות נוספת — הקדישו את היום לצ'ק-אאוט, סידור מזוודות והגעה נוחה לשדה התעופה."
        : "לוח הזמנים של הטיסה לא משאיר זמן לפעילות בהגעה — התמקדו בקליטת מזוודות, מעבר גבולות והגעה ללינה.",
      slot: isDepartureDay ? "morning" : "evening",
      plannedStartTime,
      endTime,
      estimatedDurationMinutes: 90,
      approximatePrice: null,
      pricePerPerson: null,
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "",
      lastEntryTime: "",
      canonicalPlaceId: "",
      reservationRequired: false,
      transportation: payload.preferences.transportationPreferences || "תחבורה מקומית",
      mapLink: buildMapLink(area, null, null),
      lat: null,
      lon: null,
      bookingWarning: isDepartureDay ? "בדקו את שעת הצ'ק-אאוט ואת זמן הנסיעה לשדה התעופה מראש." : "",
      alternativeSuggestion: "",
      recommendationId: null,
      locked: false,
      priority: "preferred",
      // Pinned directly from the real flight window — must survive
      // untouched through any later resequencing pass in the same
      // outer iteration.
      fixedTime: true,
    };

    // Deliberately NOT resequenceDayItems here — its scheduleDayItems
    // fully re-derives plannedStartTime/endTime from a generic 09:00 day
    // start, which is exactly the stale-scheduling bug this fix exists to
    // avoid. fillDerivedDayFields alone recomputes cost/warnings without
    // touching the times we just pinned.
    return fillDerivedDayFields({ ...day, items: [logisticsItem] }, payload, profile);
  });
}

export function lightenHighEnergyStreaks(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  const mutableDays = [...days];
  let streak = 0;
  // Root-cause fix (spec §A/§F) — see enforceNormalDayLocality's identical
  // comment. This one was already itinerary-wide (rebuilt fresh from
  // mutableDays every iteration), just with the weaker single-key identity
  // (spec §B) — upgraded to the same dual id/fuzzy-coords tracker.
  const usageState = buildItineraryUsageState(mutableDays);

  for (let index = 0; index < mutableDays.length; index += 1) {
    const day = mutableDays[index];
    const geography = analyzeDayGeography(day, profile);

    if (geography.energyLevel !== "high") {
      streak = 0;
      continue;
    }

    streak += 1;
    if (streak <= MAX_CONSECUTIVE_HIGH_ENERGY_DAYS) continue;

    const anchors = getOrderedAnchorItems(day);
    // Thread 1 (locked/fixed-time hard requirement): found while auditing
    // every repair pass for this guarantee — this used to pick ANY
    // high-energy anchor to swap out, with no exemption for one the user
    // (or an earlier pass) had locked or pinned to a fixed time.
    const highAnchor = anchors.find((item) => classifyItemEnergy(item) === "high" && !isProtectedItem(item));

    if (highAnchor) {
      releaseItineraryUsage(usageState, highAnchor);
      const replacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day,
        item: highAnchor,
        profile,
        usageState,
        replacementMode: "non_food",
      });
      const nextItem = replacement ? buildReplacementItem(replacement, highAnchor, day, payload) : null;

      if (nextItem && classifyItemEnergy(nextItem) !== "high") {
        registerItineraryUsage(usageState, nextItem);
        mutableDays[index] = fillDerivedDayFields(
          resequenceDayItems(replaceItemInDay(day, highAnchor, nextItem)),
          payload,
          profile
        );
        streak = 0;
        continue;
      }
      // No usable replacement (null, or one that's itself still high-energy)
      // — highAnchor stays exactly where it was, so its usage must be
      // restored rather than left released.
      registerItineraryUsage(usageState, highAnchor);
    }

    mutableDays[index] = fillDerivedDayFields(
      {
        ...day,
        restWindow:
          day.restWindow || "יום זה בא אחרי כמה ימים אינטנסיביים ברצף — שמרו על קצב נינוח וזמן גמיש.",
      },
      payload,
      profile
    );
    streak = 0;
  }

  return mutableDays;
}

/**
 * One-time, best-effort real-routing check on the already-validated final
 * plan. Only overwrites a segment's heuristic travel time when OSRM
 * responds and materially disagrees (>50%). Never blocks or fails
 * generation: any network/timeout/parse issue silently keeps the
 * heuristic estimate. Intentionally NOT part of the repair loop, which can
 * run many iterations — this runs once, against the free public OSRM demo
 * instance, which has no SLA.
 */
async function applyBestEffortRoutingValidation(
  plan: AiItineraryResponse,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): Promise<AiItineraryResponse> {
  const days = await Promise.all(
    plan.days.map(async (day) => {
      const orderedItems = sortItems(day.items);
      const segments = orderedItems
        .map((item, index) => ({ item, previous: index > 0 ? orderedItems[index - 1] : null }))
        .filter((entry) => entry.previous != null && (entry.item.travelMinutes ?? 0) > 0)
        .sort((left, right) => (right.item.travelMinutes ?? 0) - (left.item.travelMinutes ?? 0))
        .slice(0, 2);

      if (segments.length === 0) return day;

      let changed = false;
      const updatedItems = [...day.items];

      for (const { item, previous } of segments) {
        if (!previous || !hasValidCoordinates(previous) || !hasValidCoordinates(item)) continue;

        const realRoute = await fetchDrivingRouteBestEffort(
          { lat: previous.lat as number, lon: previous.lon as number },
          { lat: item.lat as number, lon: item.lon as number }
        );
        if (!realRoute) continue;

        const heuristicMinutes = item.travelMinutes ?? 0;
        if (heuristicMinutes <= 0) continue;

        const realMinutes = Math.max(1, Math.round(realRoute.durationSeconds / 60));
        const disagreement = Math.abs(realMinutes - heuristicMinutes) / heuristicMinutes;
        if (disagreement <= 0.5) continue;

        const index = updatedItems.findIndex((candidate) => candidate === item);
        if (index === -1) continue;
        updatedItems[index] = { ...updatedItems[index], travelMinutes: realMinutes };
        changed = true;
      }

      if (!changed) return day;
      return fillDerivedDayFields({ ...day, items: updatedItems }, payload, profile);
    })
  );

  const costs = buildCostsFromDays(days, payload.preferences.travelers, payload.preferences.flights);
  return {
    ...plan,
    days,
    totalEstimatedCost: costs.totalEstimatedCost ?? plan.totalEstimatedCost,
    estimatedTransportCost: costs.estimatedTransportCost ?? plan.estimatedTransportCost,
    averageDailyCost: costs.averageDailyCost ?? plan.averageDailyCost,
    categoryBreakdown: costs.categoryBreakdown,
  };
}

/** Target internal quality score (spec item 81) — below this, a passing plan still gets one extra diversify attempt if one remains. */
const QUALITY_SCORE_TARGET = 85;

/**
 * Guarantees an arrival/departure day never leaves this function with zero
 * items, applied exactly once to whatever plan repairPlan is about to
 * return (never mid-loop — see the comment at its removed in-loop call
 * site for why: the next attempt's resequenceDayItems would silently
 * undo it, since scheduleDayItems doesn't check locked/fixedTime at all).
 */
/**
 * Final, whole-plan defense-in-depth pass — a real bug found in live
 * production use: the same real place, fetched under two different
 * candidate ids from two different category requests (e.g. an "attraction"
 * fetch and a "day_trip" fetch both returning "Old Jaffa Grill" with
 * different ids), could still slip past individual repair steps'
 * "already used" tracking (rebalanceDayItems/pickReplacementRecommendation's
 * usedPlaceKeys, buildFallbackAiItinerary's own selectFallbackCandidate
 * exclusion), each of which checks by EXACT id/coordinate key only — the
 * same gap already found and fixed for selectFallbackCandidate itself, but
 * genuinely present at every OTHER insertion point too, and there wasn't
 * time to migrate every one of them individually. Runs once, at the very
 * end, on the plan actually about to be accepted (both the success path
 * and the fallback path) — the first real occurrence of a place always
 * wins; a later fuzzy-duplicate (the exact identity
 * collectPlanDiagnostics' own duplicatePlaces check uses) is replaced with
 * a generic, geographically-neutral placeholder
 * (buildFreeExplorationReplacement, already used everywhere else in this
 * file for "can't use this one, keep the day structurally real"). A
 * locked/fixed-time item is never touched, even if it's a genuine
 * duplicate — surfaced to the user via the existing duplicatePlaces
 * diagnostic instead of silently dropped.
 */
/**
 * Round 9.4.3 §H — collects every real place that carries the SAME
 * recommendationId in 2+ places across the final itinerary. Exact-ID
 * identity is authoritative whenever it exists (spec "Do not infer
 * duplicate identity from name alone when recommendationId exists") —
 * this never falls back to fuzzy name/coordinate matching, which
 * removeFuzzyDuplicatePlaces already covers separately for the
 * recommendationId-less case. Pure and side-effect-free so both the
 * repair pass below and the final firewall share one identical notion of
 * "what counts as a duplicate."
 */
export function computeRealPlaceDuplicateGroups(
  days: AiGeneratedDay[],
  tripFrame: TripFrame | null
): RealPlaceDuplicateGroup[] {
  const occurrencesById = new Map<string, RealPlaceDuplicateOccurrence[]>();
  const nameById = new Map<string, string>();

  for (const day of days) {
    const phase = tripFrame ? findFramePhaseForDay(tripFrame, day.dayNumber) : null;
    for (const item of day.items) {
      // A synthetic FreeTime/MealOpportunity placeholder (spec §D "do not
      // treat meal placeholders or synthetic blocks as real-place
      // duplicates") can still carry a STALE recommendationId —
      // buildFreeExplorationReplacement spreads the original item's own
      // fields and only overrides name/category/location/itemRole, never
      // clearing recommendationId. itemRole (the same authoritative
      // signal isSyntheticScheduleItem/isRealPlaceForUsageTracking already
      // use everywhere else in this file) is what actually decides "is
      // this a real, trackable place" — never recommendationId presence
      // alone.
      if (!item.recommendationId || isSyntheticScheduleItem(item)) continue;
      const list = occurrencesById.get(item.recommendationId) ?? [];
      list.push({ dayNumber: day.dayNumber, phaseId: phase?.id ?? null, category: item.category });
      occurrencesById.set(item.recommendationId, list);
      nameById.set(item.recommendationId, item.name);
    }
  }

  const groups: RealPlaceDuplicateGroup[] = [];
  for (const [recommendationId, occurrences] of occurrencesById) {
    if (occurrences.length > 1) {
      groups.push({ recommendationId, name: nameById.get(recommendationId) ?? "", occurrences });
    }
  }
  return groups;
}

/**
 * Round 9.4.3 §J — the final duplicate firewall. Thrown at the same
 * successful-return boundaries assertFinalRealActivityCoverage already
 * guards, so a real-place exact-ID duplicate can never silently reach
 * persistence regardless of which upstream repair step let it survive.
 */
export function assertNoRealPlaceDuplicatesRemain(days: AiGeneratedDay[], tripFrame: TripFrame | null): void {
  const duplicates = computeRealPlaceDuplicateGroups(days, tripFrame);
  if (duplicates.length === 0) return;
  throw new RealPlaceDuplicatesRemainError(
    `${duplicates.length} real place(s) are scheduled more than once across the itinerary: ${duplicates.map((group) => group.name).join(", ")}.`,
    { duplicateCount: duplicates.length, duplicates }
  );
}

/**
 * Round 9.4.3 §H — which occurrence of an exact-ID duplicate to KEEP.
 * Higher is better. A locked/fixedTime occurrence is never a candidate
 * for removal at all (spec "user locked/fixedTime protection" + §Q
 * "preserve existing protected-item semantics") — it always outranks
 * every non-protected occurrence, mirroring isProtectedItem's treatment
 * everywhere else in this file (never touched by a repair pass, only
 * ever reported). Among non-protected occurrences: the day whose
 * TripFrame phase is genuinely this coordinate's nearest anchor (the same
 * authoritative "which stay does this real place actually belong to"
 * signal enforceNormalDayLocality's own belongsToAnotherStay check
 * already uses) wins first; a day with no known opening-hours violation
 * is a secondary tiebreak.
 */
function scoreDuplicateOccurrenceForKeep(
  item: AiGeneratedItem,
  day: AiGeneratedDay,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>
): number {
  if (item.locked || item.fixedTime) return Number.POSITIVE_INFINITY;

  let score = 0;
  const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
  if (phase && item.lat != null && item.lon != null) {
    const ownAnchor = areaAnchors.get(phase.areaLabel);
    if (ownAnchor) {
      const ownDistanceKm = haversineKm(ownAnchor.lat, ownAnchor.lon, item.lat, item.lon);
      const isAuthoritativePhase = tripFrame.phases.every((otherPhase) => {
        if (otherPhase === phase) return true;
        const otherAnchor = areaAnchors.get(otherPhase.areaLabel);
        if (!otherAnchor) return true;
        return haversineKm(otherAnchor.lat, otherAnchor.lon, item.lat as number, item.lon as number) >= ownDistanceKm;
      });
      if (isAuthoritativePhase) score += 100;
    }
  }
  if (!itemHasKnownOpeningHoursViolation(item, day.date)) score += 10;
  return score;
}

/**
 * Round 9.4.3 §C/§D/§G/§H — the primary fix for the proven production
 * duplicate-oscillation bug (traceId gen-mu7kn7ef-s9cg5z4x: the same
 * recommendationId — e.g. "Harvard Club of Boston" — surviving on two
 * different days/phases at once, with duplicatePlaces never reaching 0
 * across all 4 repair attempts). recommendationId is authoritative
 * identity (spec §H) — for every id claimed 2+ times, keeps exactly the
 * highest-scored occurrence (scoreDuplicateOccurrenceForKeep) and
 * replaces every other occurrence with a DIFFERENT, currently-unused
 * legal candidate via the SAME pickReplacementRecommendation/
 * buildFreeExplorationReplacement machinery every other repair step in
 * this file already uses — never the same recommendationId again (the
 * surviving occurrence stays registered in usageState throughout, so
 * pickReplacementRecommendation's own isItineraryPlaceUsed filter
 * excludes it automatically). Idempotent (a second call with no
 * duplicates left is a no-op) and monotonic by construction — it only
 * ever REMOVES occurrences from occurrencesById groups of size > 1, never
 * creates a new group, and the one survivor per id is never itself
 * touched.
 *
 * Two locked/fixedTime occurrences of the very same id is a genuine data
 * conflict, not a repair decision this function can make silently (spec
 * §Q) — left untouched for the final firewall (assertNoRealPlaceDuplicatesRemain)
 * to report precisely instead.
 */
export function resolveExactIdDuplicates(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  const occurrences = new Map<string, Array<{ dayIndex: number; itemIndex: number; score: number }>>();
  days.forEach((day, dayIndex) => {
    day.items.forEach((item, itemIndex) => {
      // Same exclusion as computeRealPlaceDuplicateGroups — a synthetic
      // placeholder carrying a stale recommendationId is never a real
      // occurrence to weigh or remove.
      if (!item.recommendationId || isSyntheticScheduleItem(item)) return;
      const score = scoreDuplicateOccurrenceForKeep(item, day, tripFrame, areaAnchors);
      const list = occurrences.get(item.recommendationId) ?? [];
      list.push({ dayIndex, itemIndex, score });
      occurrences.set(item.recommendationId, list);
    });
  });

  const losers = new Set<string>();
  for (const list of occurrences.values()) {
    if (list.length <= 1) continue;
    const protectedCount = list.filter((entry) => entry.score === Number.POSITIVE_INFINITY).length;
    if (protectedCount >= 2) continue; // genuine locked/fixedTime conflict — never silently resolved.
    const sorted = [...list].sort((left, right) => right.score - left.score || left.dayIndex - right.dayIndex);
    for (const loser of sorted.slice(1)) {
      if (loser.score === Number.POSITIVE_INFINITY) continue; // never remove a locked/fixedTime occurrence.
      losers.add(`${loser.dayIndex}:${loser.itemIndex}`);
    }
  }
  if (losers.size === 0) return days;

  const usageState = buildItineraryUsageState(days);
  const mutableDays = days.map((day) => ({ ...day, items: [...day.items] }));
  const touchedDayIndexes = new Set<number>();

  for (const key of losers) {
    const [dayIndexText, itemIndexText] = key.split(":");
    const dayIndex = Number(dayIndexText);
    const itemIndex = Number(itemIndexText);
    const day = mutableDays[dayIndex];
    const item = day.items[itemIndex];

    // Multiset release (spec: "same object copied twice" and "same
    // recommendation reconstructed twice" are the same identity) — the
    // surviving occurrence's own registration is untouched, so the
    // candidate search below can never re-select this exact id (spec §H
    // rule 6: "never fill the gap with the same recommendationId").
    releaseItineraryUsage(usageState, item);
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const stayAnchor = phase ? areaAnchors.get(phase.areaLabel) ?? null : null;
    const replacement = pickReplacementRecommendation({
      traceSource: "other_existing_path",
      payload,
      day,
      item,
      profile,
      usageState,
      maxDistanceKm: mobilityProfile.localityRadiusKm,
      stayAreaAnchor: stayAnchor,
    });
    const nextItem = replacement
      ? buildReplacementItem(replacement, item, day, payload)
      : buildFreeExplorationReplacement(item, day);
    registerItineraryUsage(usageState, nextItem);
    day.items[itemIndex] = nextItem;
    touchedDayIndexes.add(dayIndex);
  }

  for (const dayIndex of touchedDayIndexes) {
    mutableDays[dayIndex] = fillDerivedDayFields(resequenceDayItems(normalizeDayCollections(mutableDays[dayIndex])), payload, profile);
  }
  return mutableDays;
}

export function removeFuzzyDuplicatePlaces(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  const seen: FuzzyPlaceRecord[] = [];

  return days.map((day) => {
    let changed = false;
    const nextItems = day.items.map((item) => {
      const isRealPlace = Boolean(item.recommendationId) || (item.lat != null && item.lon != null);
      if (!isRealPlace || isProtectedItem(item)) return item;

      const record: FuzzyPlaceRecord = { nameSlug: normalizePlaceNameSlug(item.name), lat: item.lat, lon: item.lon };
      if (seen.some((existing) => isFuzzyDuplicatePlace(existing, record))) {
        changed = true;
        return buildFreeExplorationReplacement(item, day);
      }
      seen.push(record);
      return item;
    });

    return changed ? fillDerivedDayFields(resequenceDayItems({ ...day, items: nextItems }), payload, profile) : day;
  });
}

/** One normal-day geographic outlier found and repaired (or, for protected content, left in place and reported) by enforceNormalDayLocality. */
export type DerivedDayType = "arrival" | "departure" | "transfer" | "day_trip" | "normal";

/**
 * Spec "א-סימטריה בין normal לday-trip/transfer" — the geographic gates
 * must never trust Gemini's own title/notes/transportation wording for
 * WHICH kind of day this is; that label is exactly the thing a model can
 * write to escape the strict normal-day rule. This derives the day type
 * from real, already-decided planning data only:
 *   - arrival/departure: the day's own calendar date matches the real
 *     inbound/outbound flight leg's own date (ArrivalDepartureWindow —
 *     itself derived from the actual flight times, never text).
 *   - transfer: this day's TripFrame phase differs from the PREVIOUS
 *     day's phase (a real stay change), not a keyword in prose.
 *   - day_trip: isStructuralRoundTripDay's own coordinate geometry only
 *     (out from the base, a genuinely distant middle anchor, back to the
 *     base) — the text-pattern half of isDayTripDay is deliberately not
 *     consulted here.
 *   - normal: none of the above.
 * Gemini's own title/notes remain purely informational display text —
 * nothing in this function, and nothing that consumes its result, reads
 * them for classification.
 */
export function deriveDayType(
  day: Pick<AiGeneratedDay, "dayNumber" | "date" | "items">,
  tripFrame: TripFrame,
  arrivalDepartureWindow: ArrivalDepartureWindow | null
): DerivedDayType {
  if (
    arrivalDepartureWindow?.earliestUsableTimeOnArrivalDay &&
    day.date === arrivalDepartureWindow.earliestUsableTimeOnArrivalDay.date
  ) {
    return "arrival";
  }
  if (
    arrivalDepartureWindow?.latestUsableTimeOnDepartureDay &&
    day.date === arrivalDepartureWindow.latestUsableTimeOnDepartureDay.date
  ) {
    return "departure";
  }

  const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
  const previousPhase = day.dayNumber > 1 ? findFramePhaseForDay(tripFrame, day.dayNumber - 1) : null;
  if (phase && previousPhase && phase.id !== previousPhase.id) {
    return "transfer";
  }

  if (isStructuralRoundTripDay(day)) return "day_trip";

  return "normal";
}

export interface LocalityViolation {
  dayNumber: number;
  itemName: string;
  distanceFromBaseKm: number;
  reason:
    | "too_far_from_base"
    | "belongs_to_another_stay"
    | "unverified_region_mismatch"
    | "infeasible_transfer_detour"
    | "infeasible_day_excursion"
    | "unresolved_owner_geometry";
  repaired: boolean;
  /** Debug-only context (spec "REAL BROWSER REGRESSION" §1) — never shown in production UI. */
  note?: string;
  /** Spec "RESOLVER FALSE POSITIVES" §4 — how this item's coordinates (if any) were established, for audit trail purposes. Absent when the item had no coordinates AND resolution never got far enough to have an opinion (e.g. it was skipped for an unrelated reason). */
  geographySource?: GeographyResolutionSource;
}

/**
 * Spec "GEMINI ITEMS ARE BYPASSING GEOGRAPHIC VALIDATION" §2/§5/§17 — a
 * real, generic geographic-identity resolver for a Gemini-authored item
 * that has NO real coordinates. Real coordinates always win when present
 * (handled by the caller before this is even consulted); this only
 * covers the coordinate-LESS case, which used to bypass locality
 * entirely. Uses the item's own real `location` text (never a hardcoded
 * famous-place list) normalized the exact same way area labels already
 * are everywhere else in this file, so "San Francisco, CA"/"NYC"-style
 * variants of a KNOWN trip area still match it.
 */
function resolveTextualAreaMatch(itemLocation: string, candidateAreaLabel: string): boolean {
  const itemArea = normalizeAreaLabel(itemLocation).toLowerCase().trim();
  const candidateArea = normalizeAreaLabel(candidateAreaLabel).toLowerCase().trim();
  if (!itemArea || !candidateArea) return false;
  if (itemArea === candidateArea) return true;
  // Whole-word overlap, not raw substring containment — "Atlanta" must
  // never match a short area label like "LA" just because it happens to
  // contain the letters "la" somewhere inside it. Every word counts
  // (including short ones) so "City A" and "City B" — or "New York" and
  // "New Orleans" — are correctly distinct rather than colliding on a
  // shared generic word alone.
  const itemWords = new Set(itemArea.split(/[\s,]+/).filter(Boolean));
  const candidateWords = candidateArea.split(/[\s,]+/).filter(Boolean);
  if (candidateWords.length === 0) return false;
  return candidateWords.every((word) => itemWords.has(word));
}

/**
 * Spec "GEOGRAPHIC CORRECTNESS REDESIGN" §1-2 — "a place is not a place
 * until it has resolved coordinates." Before falling back to text-only
 * heuristics, a coordinate-less Gemini-authored item gets ONE real chance
 * to be resolved: does it actually match a real candidate already in this
 * trip's own known pool (by id, or by fuzzy name — the same matcher
 * removeFuzzyDuplicatePlaces already uses)? If so, its real coordinates
 * are the truth, not a guess — the caller then runs the exact same
 * coordinate-based distance check every other item gets. This closes real
 * false negatives (a genuinely local, real candidate that merely arrived
 * without lat/lon attached) without inventing anything: no geocoding call
 * is made here, only a real match against data this trip already has.
 */
/**
 * Spec "RESOLVER FALSE POSITIVES" — where a real coordinate/recommendationId
 * came from, kept alongside the resolved point itself. "provider" is
 * assigned by the caller (the item already had real coordinates, no
 * resolution needed) — this function only ever returns the other two.
 */
export type GeographyResolutionSource = "provider" | "recommendationId" | "fuzzyName" | "unresolved";

export interface GeographyResolution {
  lat: number;
  lon: number;
  source: Exclude<GeographyResolutionSource, "provider" | "unresolved">;
}

// Spec "RESOLVER FALSE POSITIVES" — deliberately NOT the same rule as
// isFuzzyDuplicatePlace (trip-workspace.ts). Deduplication's prefix match
// ("Mtatsminda Park" vs "Mtatsminda Park (Funicular)") is tuned for its
// own failure mode: missing a true duplicate just leaves two rows for the
// same real place. A GEOGRAPHIC RESOLVER's false positive is categorically
// worse — it attaches a WRONG real place's coordinates to an item and lets
// them flow downstream as verified, real geography (an item that would
// otherwise have been correctly rejected can now pass as "local"), and
// the resolution note itself becomes a lie. The resolver therefore requires
// exact name-slug equality, never a prefix/substring relationship — a
// separate, stricter rule with its own name, not inherited from (or tuned
// in lockstep with) the dedup threshold.
function isResolverNameMatch(itemNameSlug: string, candidateNameSlug: string): boolean {
  return itemNameSlug !== "" && itemNameSlug === candidateNameSlug;
}

function resolveItemGeography(
  item: Pick<AiGeneratedItem, "name" | "recommendationId" | "category">,
  candidates: TripRecommendation[]
): GeographyResolution | null {
  // A recommendationId is a definite, unambiguous identity claim — it
  // uniquely names ONE real candidate this trip already knows about, so
  // it is exempt from the ambiguity check below (there is nothing to be
  // ambiguous BETWEEN; a single id can only ever resolve to one record).
  // Name matching gets no such certainty and must never be blended with
  // this path.
  if (item.recommendationId) {
    const byId = candidates.find((candidate) => candidate.id === item.recommendationId);
    if (byId && byId.lat != null && byId.lon != null) {
      return { lat: byId.lat, lon: byId.lon, source: "recommendationId" };
    }
  }

  const itemNameSlug = normalizePlaceNameSlug(item.name);
  const nameMatches = candidates.filter(
    (candidate) => candidate.lat != null && candidate.lon != null && isResolverNameMatch(itemNameSlug, normalizePlaceNameSlug(candidate.name))
  ) as Array<TripRecommendation & { lat: number; lon: number }>;
  if (nameMatches.length === 0) return null;

  // Spec "RESOLVER FALSE POSITIVES" §2 — ambiguity rejection. Multiple
  // name matches that are all genuinely close together (the same real
  // place tagged more than once — FUZZY_DUPLICATE_MAX_KM is reused here
  // for exactly the "is this the same physical venue" question it was
  // already built to answer) still resolve cleanly. Multiple matches that
  // are NOT close together are real, DISTINCT places sharing a name (the
  // "Galleria exists in more than one metro" case) — the correct result is
  // "unresolved," never "the nearest one," because a plausible-looking
  // wrong match is worse than an honest non-match.
  const distinctClusters: Array<{ lat: number; lon: number }> = [];
  for (const match of nameMatches) {
    const alreadyInCluster = distinctClusters.some(
      (cluster) => haversineKm(cluster.lat, cluster.lon, match.lat, match.lon) <= FUZZY_DUPLICATE_MAX_KM
    );
    if (!alreadyInCluster) distinctClusters.push({ lat: match.lat, lon: match.lon });
  }
  if (distinctClusters.length > 1) return null; // ambiguous = not proven, never "best guess"

  const resolved = nameMatches[0];
  return { lat: resolved.lat, lon: resolved.lon, source: "fuzzyName" };
}

/**
 * Locality-first final validation + repair (browser QA Parts B/C/D/H/R/S) —
 * a normal (non-transfer, non-day-trip) day's real content is checked
 * against its OWN TripFrame phase's area anchor, using a
 * DestinationMobilityProfile-derived radius (never one fixed worldwide
 * km value) rather than a soft score. An item is also rejected when it's
 * genuinely closer to a DIFFERENT phase's own area than to its own —
 * "never steal from a future/past stay" (spec §H) — regardless of how
 * confident the raw distance-from-own-base check alone would have been.
 * Runs as a terminal, whole-plan defense-in-depth pass (same reasoning as
 * removeFuzzyDuplicatePlaces just above): repairCrossRegionDayContent
 * already does something similar every attempt with a fixed 80km radius;
 * this is the stronger, adaptive-radius, ownership-aware backstop that
 * catches whatever that pass — or Gemini's own raw output, or any other
 * repair step — still let through. A locked/fixed-time outlier is left in
 * place and reported, never silently moved.
 */
export function enforceNormalDayLocality(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /** Optional — absent means arrival/departure days can't be identified by real flight-leg date, so they simply fall through to the transfer/day_trip/normal derivation like any other day (never a regression for a caller that predates this parameter). */
  arrivalDepartureWindow: ArrivalDepartureWindow | null = null
): { days: AiGeneratedDay[]; violations: LocalityViolation[] } {
  const violations: LocalityViolation[] = [];
  const mutableDays = [...days];
  // Root-cause fix (real 43-day US replay: Times Square/Central Park first
  // placed correctly in New York, then RE-inserted by THIS function into
  // Austin/Philadelphia/Nashville/Chicago/Boston/San Francisco/Portland/
  // Atlanta/Seattle/Boston — locality_repair was "clearly the dominant
  // repeated inserter" per the trace evidence) — built ONCE from the
  // CURRENT full itinerary and mutated as this loop replaces items, so day
  // 30's repair sees day 2's content as used. The old code rebuilt a fresh
  // Set from only `mutableDay.items` (the single day being repaired) on
  // every replacement, despite `mutableDays` already being in scope right
  // here — the fix this whole pass exists for.
  const usageState = buildItineraryUsageState(mutableDays);
  // Spec "GEOGRAPHIC CORRECTNESS REDESIGN" §2 — the trip's own known real
  // candidates, consulted ONCE, so a coordinate-less item that actually
  // matches one gets its real coordinates attached instead of falling
  // straight to a text-only guess.
  const candidatePool = [...payload.recommendations, ...payload.selectedPlaces];
  // Section "TRANSFER DAY DETOUR FEASIBILITY" — one real origin/destination
  // transition per phase boundary, the same primitive
  // reorderAreasForDepartureFeasibility and the intercity feasibility check
  // in attemptStayStructureRepair already use; never a second computation
  // of "what is this transfer day's origin and destination."
  const stayTransitions = buildStayTransitions(tripFrame, areaAnchors);
  const dailyCapacityMinutes = deriveDailyCapacityMinutes(payload.preferences.tripPace);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    // Detour+visit minutes already committed to earlier detour activities
    // THIS day — reset per day, accumulated across this day's own item
    // loop below, so two individually-fine detours that together exceed
    // the slack are correctly rejected (spec "combined, not per-activity
    // in isolation").
    let usedTransferSlackMinutes = 0;
    // Section "DAY-TRIP EXEMPTION IS TOO PERMISSIVE" / "TRANSFER DAY MUST
    // MATCH ACTUAL STAY TRANSITION" — a day-trip/transfer label used to
    // exempt EVERY item on the day from any locality check at all (the
    // exact root cause behind e.g. "Chicago -> Point Reyes" and the New
    // Orleans transfer day leaking Cleveland/Beverly Hills/LAX content).
    // These day types are still exempt from the "must match my OWN base"
    // rule below (their whole point is content away from base) but are no
    // longer exempt from the "must not positively match a DIFFERENT real
    // stay elsewhere in this same trip" check — that specific signal is
    // never legitimate for either day type.
    //
    // Section "א-סימטריה בין normal לday-trip/transfer" — the exemption
    // itself is now decided by deriveDayType (real TripFrame stay
    // comparison + coordinate geometry), never by whether Gemini's own
    // title/notes/transportation text happens to contain a day-trip or
    // transfer keyword. A day whose real stay does not change and whose
    // items don't form a genuine round-trip is judged as a normal day
    // under full fail-closed rules, regardless of what Gemini called it.
    const derivedDayType = deriveDayType(day, tripFrame, arrivalDepartureWindow);
    const isExemptDayType = derivedDayType === "transfer" || derivedDayType === "day_trip";

    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    // Section "FAIL CLOSED ON MISSING COMPARISON GEOMETRY" — real bug
    // found via a real 43-day US replay: no phase mapped to this day at
    // all is a genuinely different, rarer case (never block on missing
    // structure) — but a REAL phase whose anchor can't be resolved
    // (areaAnchors has no entry for it, e.g. after a relabeling that lost
    // its coordinate-bearing original label) used to silently skip the
    // day's ENTIRE geography check. A resolved real place can never be
    // validated against a stay with no usable coordinates — that must be
    // a hard violation (unresolved_owner_geometry, below), never a silent
    // "passed"/legMinutes:null. Only "no phase at all" still continues.
    if (!phase) continue;
    const ownAnchor = areaAnchors.get(phase.areaLabel);

    let mutableDay = day;
    let changed = false;

    for (const item of day.items) {
      let violationReason: LocalityViolation["reason"] | null = null;
      let distanceFromOwnKm = 0;
      let note: string | undefined;

      // Spec "GEOGRAPHIC CORRECTNESS REDESIGN" §1/§2 — real coordinates
      // are the identity; a coordinate-less item gets ONE real chance to
      // be resolved against the trip's own known candidate pool before
      // any text-only guess. A resolved item is then judged by the exact
      // same coordinate-based rule as any other item, for every day type.
      // Spec "SEPARATE NON-PLACE SCHEDULE ITEMS" — a synthetic
      // meal-opportunity/free-time block (isSyntheticScheduleItem, itself
      // authoritative via item.itemRole, never inferred from its display
      // text) is never a real-place claim regardless of its category —
      // the real bug this closes: a free-exploration block labeled
      // category "attraction" used to attempt real-POI resolution and
      // could surface a misleading "verdict: passed" as if it were a
      // validated real place.
      const isRealCandidateSlot = (item.lat == null || item.lon == null) && !isSyntheticScheduleItem(item)
        ? !isFoodItem(item.category) && item.category !== "transportation" && item.category !== "practical"
        : false;
      const resolvedCoords =
        item.lat == null && item.lon == null && isRealCandidateSlot ? resolveItemGeography(item, candidatePool) : null;
      const effectiveLat = item.lat ?? resolvedCoords?.lat ?? null;
      const effectiveLon = item.lon ?? resolvedCoords?.lon ?? null;
      const geographySource: GeographyResolutionSource | undefined =
        item.lat != null && item.lon != null ? "provider" : (resolvedCoords?.source ?? (isRealCandidateSlot ? "unresolved" : undefined));

      if (effectiveLat != null && effectiveLon != null && !ownAnchor) {
        // Section "FAIL CLOSED ON MISSING COMPARISON GEOMETRY" — a real,
        // resolved place can never be validated against a stay with no
        // usable geographic anchor. This must be a hard violation
        // (repaired/removed below, same as any other), never a silent
        // "passed" with legMinutes left null — the exact real bug: a
        // broad/relabeled stay with no anchor let genuinely unrelated
        // real POIs "pass" purely because there was nothing to compare
        // against.
        violationReason = "unresolved_owner_geometry";
        note = `this day's owning stay ("${phase.areaLabel}") has no resolvable geographic anchor — a real POI cannot be validated against it`;
        if (isPlannerQaTraceEnabled()) {
          console.log("[PlannerQA] OWNER_ANCHOR_MISSING", {
            dayNumber: day.dayNumber,
            areaLabel: phase.areaLabel,
            item: item.name,
          });
        }
      } else if (effectiveLat != null && effectiveLon != null && ownAnchor) {
        distanceFromOwnKm = haversineKm(ownAnchor.lat, ownAnchor.lon, effectiveLat, effectiveLon);

        // Section "TRANSFER DAY DETOUR FEASIBILITY" — real detour math
        // replaces the old blanket exemption for transfer days specifically
        // (day_trip days and every other day type keep the untouched logic
        // in the else branch below). Falls through to that same untouched
        // logic when this day's real StayTransition data isn't available —
        // never blocks on missing geography.
        const transition = derivedDayType === "transfer" ? stayTransitions.find((candidate) => candidate.dayNumber === day.dayNumber) : undefined;
        const origin = transition?.fromCoordinates;
        const destination = transition?.toCoordinates;
        const directTransferMinutes = transition?.estimatedTravelMinutes;
        const isTransferWithRealData = derivedDayType === "transfer" && origin && destination && directTransferMinutes != null;

        // On a transfer day, being near yesterday's own stay (origin) is
        // legitimate — the "belongs to another stay" signal must only ever
        // mean a THIRD, unrelated region, never this day's own origin.
        let closestOtherDistanceKm = Infinity;
        for (const otherPhase of tripFrame.phases) {
          if (otherPhase === phase) continue;
          if (isTransferWithRealData && otherPhase.areaLabel === transition!.fromBase) continue;
          const otherAnchor = areaAnchors.get(otherPhase.areaLabel);
          if (!otherAnchor) continue;
          const distanceKm = haversineKm(otherAnchor.lat, otherAnchor.lon, effectiveLat, effectiveLon);
          if (distanceKm < closestOtherDistanceKm) closestOtherDistanceKm = distanceKm;
        }
        const belongsToAnotherStay =
          closestOtherDistanceKm < mobilityProfile.localityRadiusKm && closestOtherDistanceKm < distanceFromOwnKm;

        if (isTransferWithRealData && origin && destination && directTransferMinutes != null) {
          if (belongsToAnotherStay) {
            violationReason = "belongs_to_another_stay";
          } else {
            const distanceFromOriginKm = haversineKm(origin.lat, origin.lon, effectiveLat, effectiveLon);
            const distanceFromDestinationKm = haversineKm(destination.lat, destination.lon, effectiveLat, effectiveLon);
            const nearOrigin = distanceFromOriginKm <= mobilityProfile.localityRadiusKm;
            const nearDestination = distanceFromDestinationKm <= mobilityProfile.localityRadiusKm;

            if (!nearOrigin && !nearDestination) {
              const outboundMinutes = estimateMinutesForMode(distanceFromOriginKm, selectTransportMode(distanceFromOriginKm, { isIntercity: true }));
              const toDestinationMinutes = estimateMinutesForMode(
                distanceFromDestinationKm,
                selectTransportMode(distanceFromDestinationKm, { isIntercity: true })
              );
              const availableSlackMinutes = Math.max(0, dailyCapacityMinutes - directTransferMinutes);
              const visitMinutes = item.estimatedDurationMinutes ?? 90;

              const detourFeasibility = evaluateTransferDetourFeasibility({
                outboundToCandidateMinutes: outboundMinutes,
                candidateToDestinationMinutes: toDestinationMinutes,
                directTransferMinutes,
                visitMinutes,
                availableSlackMinutes,
                usedSlackMinutes: usedTransferSlackMinutes,
              });

              if (!detourFeasibility.feasible) {
                violationReason = "infeasible_transfer_detour";
                note = `real detour ${Math.round(detourFeasibility.detourMinutes)} min + visit ${Math.round(visitMinutes)} min exceeds this transfer day's remaining slack (${Math.round(availableSlackMinutes - usedTransferSlackMinutes)} min)`;
              } else {
                usedTransferSlackMinutes += detourFeasibility.totalMinutes;
              }
            }
          }
        } else if (isExemptDayType) {
          // Section "EXEMPT DAY GEOGRAPHY MUST NOT BE UNCONDITIONAL" — real
          // bug from a real QA replay: a day_trip-category item ~9459
          // minutes from its own day's owner anchor received an
          // unconditional pass purely because the day was classified
          // day_trip/transfer — no real feasibility basis was ever
          // checked, only "does this positively match some OTHER known
          // stay" (belongsToAnotherStay, still checked first below). A
          // day_trip day, and a transfer day lacking a real modeled
          // StayTransition (the branch above), are both now evaluated as
          // "is this genuinely feasible as an excursion FROM this day's
          // own base" — the exact same real evaluateDayTripFeasibility
          // math already used for cluster-level day-trip acceptance
          // (route-optimization.ts), applied per-item here. A day-trip/
          // transfer label is no longer permission to skip geography
          // entirely — only permission to be away from base AT ALL,
          // which still has to be a real, feasible excursion.
          if (belongsToAnotherStay) {
            violationReason = "belongs_to_another_stay";
          } else {
            const outboundMinutes = estimateMinutesForMode(distanceFromOwnKm, selectTransportMode(distanceFromOwnKm, { isIntercity: true }));
            const visitMinutes = item.estimatedDurationMinutes ?? 90;
            const feasibility = evaluateDayTripFeasibility({
              outboundTravelMinutes: outboundMinutes,
              returnTravelMinutes: outboundMinutes,
              internalTravelMinutes: 0,
              visitMinutes,
              usableMinutes: dailyCapacityMinutes,
            });
            if (!feasibility.feasible) {
              violationReason = "infeasible_day_excursion";
              note = `real round-trip ~${Math.round(outboundMinutes * 2)} min + visit ${Math.round(visitMinutes)} min is not a feasible day excursion from this day's own base (valueRatio ${feasibility.valueRatio.toFixed(2)})`;
            }
          }
        } else {
          const tooFarFromBase = distanceFromOwnKm > mobilityProfile.localityRadiusKm;
          // Round 6 — a coordinate-having POI whose OWN location text
          // positively names a different, genuinely-separate known area is
          // "somewhere else" even when the single trip-wide radius (120 km
          // on the sparse tier) happens to accept the raw kilometres. This
          // is the coordinate-having twin of the text check in the
          // isRealCandidateSlot branch below — the Smithsonian ("Washington,
          // DC") on a "West Virginia" day, at ~100 km, is the exact shape.
          const namesElsewhere =
            isScheduledRealPlace(item) &&
            realPlaceNamesADifferentKnownArea(effectiveLat, effectiveLon, item.location, phase.areaLabel, ownAnchor, areaAnchors, tripFrame).matched;
          if (belongsToAnotherStay) violationReason = "belongs_to_another_stay";
          else if (tooFarFromBase) violationReason = "too_far_from_base";
          else if (namesElsewhere) {
            violationReason = "belongs_to_another_stay";
            note = `location text "${item.location}" names a different known area than this day's own stay (${phase.areaLabel})`;
          }
        }
      } else if (isRealCandidateSlot) {
        // Section "GEMINI ITEMS ARE BYPASSING GEOGRAPHIC VALIDATION" §2/§4/
        // §5 — a Gemini-authored real POI with NO coordinates AND no match
        // in the trip's own known candidates used to skip this whole check
        // entirely (the exact root cause of e.g. "Golden Gate Bridge"
        // appearing on a New York day). Coordinates are never fabricated
        // here — the item's own real `location` text is compared against
        // the trip's own known stay areas, the same normalization every
        // area label already goes through.
        //
        // Spec "GEOGRAPHIC CORRECTNESS REDESIGN" §4/§10 — "geography
        // should be proven, not presumed": an unresolved item with NO real
        // coordinates is no longer given a free pass just because it can't
        // be textually DISPROVEN — unproven geography is itself the
        // defect, on EVERY day type. This closes the previously-deferred
        // gap (real 43-day US replay: Yellowstone/Yosemite/Grand Canyon/
        // Mount Rushmore each landed on a day_trip/transfer-classified day
        // with no real coordinates and a Hebrew location string that
        // matched no known stay's area label — so the old
        // "isExemptDayType ? positively matches ANOTHER stay : doesn't
        // match its own" rule found neither condition true and silently
        // passed). A day-trip/transfer label is real permission to be away
        // from base — but ONLY when that can be verified against real
        // coordinates (the branch above, which still does a full
        // evaluateDayTripFeasibility/evaluateTransferDetourFeasibility
        // check); it was never meant to be permission to skip verification
        // entirely just because coordinates happen to be missing. A
        // coordinate-less item is therefore judged the exact same way
        // regardless of day type: legal only if its own location text
        // positively matches THIS day's own stay.
        const itemLocation = item.location.trim();
        const matchesOwnArea = itemLocation ? resolveTextualAreaMatch(itemLocation, phase.areaLabel) : false;
        const matchedOtherPhase = itemLocation
          ? tripFrame.phases.find((otherPhase) => otherPhase !== phase && resolveTextualAreaMatch(itemLocation, otherPhase.areaLabel))
          : undefined;

        const isViolation = !matchesOwnArea;
        if (isViolation) {
          violationReason = "unverified_region_mismatch";
          note = matchedOtherPhase
            ? `location text "${itemLocation}" matches a different stay (${matchedOtherPhase.areaLabel}), not this day's own stay (${phase.areaLabel})`
            : itemLocation
              ? `location text "${itemLocation}" does not match this day's own stay (${phase.areaLabel}) and has no real coordinates to verify otherwise`
              : `no location text and no real coordinates — geography cannot be proven, so it is not presumed local`;
        }
      }

      if (!violationReason) continue;

      if (isProtectedItem(item)) {
        violations.push({
          dayNumber: day.dayNumber,
          itemName: item.name,
          distanceFromBaseKm: Math.round(distanceFromOwnKm * 10) / 10,
          reason: violationReason,
          repaired: false,
          note,
          geographySource,
        });
        continue;
      }

      // Repair (spec §S): a real, geographically-compatible nearby
      // candidate first, a generic neutral placeholder second — never left
      // in place, never silently deleted.
      releaseItineraryUsage(usageState, item);
      const replacement = pickReplacementRecommendation({
        traceSource: "locality_repair",
        payload,
        day: mutableDay,
        item,
        profile,
        usageState,
        maxDistanceKm: mobilityProfile.localityRadiusKm,
        stayAreaAnchor: ownAnchor ?? null,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, mutableDay, payload)
        : buildFreeExplorationReplacement(item, mutableDay);
      registerItineraryUsage(usageState, nextItem);
      mutableDay = { ...mutableDay, items: mutableDay.items.map((entry) => (entry === item ? nextItem : entry)) };
      changed = true;

      violations.push({
        dayNumber: day.dayNumber,
        itemName: item.name,
        distanceFromBaseKm: Math.round(distanceFromOwnKm * 10) / 10,
        reason: violationReason,
        repaired: true,
        note,
        geographySource,
      });
    }

    if (changed) {
      mutableDays[dayIndex] = fillDerivedDayFields(
        resequenceDayItems(normalizeDayCollections(mutableDay)),
        payload,
        profile
      );
    }
  }

  return { days: mutableDays, violations };
}

// ==================================================
// Spec "מכני, לא קריאה ידנית של PDF" — a dev-only, generation-time
// geographic diagnostic. Never runs in production, never gates
// acceptance, never mutates the plan — a read-only report over the SAME
// real functions/resolvers already used for the real repair (never a
// parallel, drifting copy of their logic).
// ==================================================

export type TextualDayType = "day_trip" | "transfer" | "normal";

export interface ItemGeographyDiagnostic {
  itemId: string;
  itemName: string;
  category: RecommendationCategory;
  /** "provider" = the item already had real coordinates. "n/a" = a food/transportation/practical item, never subject to place-geography at all. */
  geoSource: GeographyResolutionSource | "n/a";
  precision: "point" | "none";
  ownerStay: string;
  legMinutes: number | null;
  verdict: "passed" | "repaired" | "removed" | "flagged_protected";
  verdictRule: string | null;
}

export interface DayGeographyDiagnostic {
  dayNumber: number;
  ownerStay: string;
  derivedDayType: DerivedDayType;
  textualDayType: TextualDayType;
  dayTypeMismatch: boolean;
  totalLegMinutes: number;
  maxLegMinutes: number;
  unresolvedItemCount: number;
  items: ItemGeographyDiagnostic[];
}

function textualDayType(day: AiGeneratedDay): TextualDayType {
  if (isIntercityTransferDay(day)) return "transfer";
  if (isDayTripDay(day)) return "day_trip";
  return "normal";
}

/**
 * Spec "DIAGNOSTICS MUST EXPOSE MISSING GEOMETRY" — trip-wide counts summarizing
 * computeGeographyDiagnostics' own per-day/per-item output, so a missing
 * owner anchor (the real replay's root cause — a broad/relabeled stay
 * with no resolvable coordinates) is a visible, explicit number, never
 * just a scatter of individual null legMinutes easy to miss. Never counts
 * synthetic MealOpportunity/FreeTimeBlock items (geoSource "n/a" is never
 * a real-place claim in the first place).
 */
export interface GeographyDiagnosticsSummary {
  /** Real, resolved-coordinate items whose legMinutes could not be computed — owner anchor missing, never a genuinely-computed zero. */
  realItemsWithNullLegGeometry: number;
  /** Real items specifically flagged unresolved_owner_geometry by enforceNormalDayLocality. */
  realItemsWithUnresolvedOwnerGeometry: number;
  /** Distinct days whose owning stay has no resolvable geographic anchor at all. */
  ownerGeometryMissingDays: number;
  /**
   * Spec "DAY-LEVEL POI GEOGRAPHY / LEGALITY" §H "run a pure invariant
   * validator... there must be zero illegalScheduledRealPlaces" — real
   * places that a geography violation was found for AND that survive into
   * the final plan anyway (verdict "flagged_protected": a locked/fixed-time
   * item enforceNormalDayLocality deliberately never repairs). "repaired"/
   * "removed" verdicts mean the violation was already caught and fixed —
   * they are NOT counted here, since nothing illegal actually survives
   * from those. Zero is the acceptance bar; a positive count here means a
   * real, resolved POI failed evaluateScheduledPlaceLegality's rules and
   * is still in the plan (only ever possible for a protected item, by
   * construction — enforceNormalDayLocality repairs/removes every other
   * violation it finds).
   */
  illegalScheduledRealPlaces: number;
}

export function summarizeGeographyDiagnostics(diagnostics: DayGeographyDiagnostic[]): GeographyDiagnosticsSummary {
  let realItemsWithNullLegGeometry = 0;
  let realItemsWithUnresolvedOwnerGeometry = 0;
  let illegalScheduledRealPlaces = 0;
  const ownerGeometryMissingDayNumbers = new Set<number>();

  for (const day of diagnostics) {
    for (const item of day.items) {
      if (item.geoSource === "n/a") continue;
      if (item.legMinutes == null && item.precision === "point") {
        realItemsWithNullLegGeometry += 1;
        ownerGeometryMissingDayNumbers.add(day.dayNumber);
      }
      if (item.verdictRule === "enforceNormalDayLocality: unresolved_owner_geometry") {
        realItemsWithUnresolvedOwnerGeometry += 1;
      }
      if (item.verdict === "flagged_protected") {
        illegalScheduledRealPlaces += 1;
      }
    }
  }

  return {
    realItemsWithNullLegGeometry,
    realItemsWithUnresolvedOwnerGeometry,
    ownerGeometryMissingDays: ownerGeometryMissingDayNumbers.size,
    illegalScheduledRealPlaces,
  };
}

/**
 * Spec "מכני, לא קריאה ידנית" — runs enforceNormalDayLocality itself (the
 * real repair, on a throwaway copy) purely to harvest its own violations
 * list for `verdict`/`verdictRule`, then independently resolves EVERY
 * item's geography (not just flagged ones — spec: "geoSource נדרש לכל
 * פריט") via the exact same resolveItemGeography used in production. The
 * input `days` are never mutated or returned; this is read-only.
 */
export function computeGeographyDiagnostics(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  arrivalDepartureWindow: ArrivalDepartureWindow | null
): DayGeographyDiagnostic[] {
  const candidatePool = [...payload.recommendations, ...payload.selectedPlaces];
  const { violations } = enforceNormalDayLocality(days, tripFrame, areaAnchors, mobilityProfile, payload, profile, arrivalDepartureWindow);

  return days.map((day) => {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const ownAnchor = phase ? areaAnchors.get(phase.areaLabel) : null;
    const derived = deriveDayType(day, tripFrame, arrivalDepartureWindow);
    const textual = textualDayType(day);
    const dayViolations = violations.filter((violation) => violation.dayNumber === day.dayNumber);

    let totalLegMinutes = 0;
    let maxLegMinutes = 0;
    let unresolvedItemCount = 0;

    const items: ItemGeographyDiagnostic[] = day.items.map((item) => {
      // Spec "SEPARATE NON-PLACE SCHEDULE ITEMS" — see the matching
      // enforceNormalDayLocality comment; the same authoritative
      // itemRole-based exclusion applies to this diagnostic's own
      // geoSource classification, so a free-time/meal-opportunity block
      // is reported "n/a", never "unresolved" (which would imply a real,
      // unverifiable place claim) and never gets a misleading "verdict:
      // passed" as if it were a validated real POI.
      const isRealCandidateSlot =
        !isSyntheticScheduleItem(item) && !isFoodItem(item.category) && item.category !== "transportation" && item.category !== "practical";
      let geoSource: GeographyResolutionSource | "n/a" = "n/a";
      let effectiveLat = item.lat;
      let effectiveLon = item.lon;

      if (isRealCandidateSlot) {
        if (item.lat != null && item.lon != null) {
          geoSource = "provider";
        } else {
          const resolved = resolveItemGeography(item, candidatePool);
          if (resolved) {
            geoSource = resolved.source;
            effectiveLat = resolved.lat;
            effectiveLon = resolved.lon;
          } else {
            geoSource = "unresolved";
          }
        }
      }

      const precision: "point" | "none" = effectiveLat != null && effectiveLon != null ? "point" : "none";
      if (precision === "none" && isRealCandidateSlot) unresolvedItemCount += 1;

      const legMinutes =
        ownAnchor && effectiveLat != null && effectiveLon != null
          ? Math.round(estimateTravelMinutes(ownAnchor.lat, ownAnchor.lon, effectiveLat, effectiveLon, payload.preferences.tripPace, ""))
          : null;
      if (legMinutes != null) {
        totalLegMinutes += legMinutes;
        maxLegMinutes = Math.max(maxLegMinutes, legMinutes);
      }

      const matchingViolation = dayViolations.find((violation) => violation.itemName === item.name);
      const verdict: ItemGeographyDiagnostic["verdict"] = !matchingViolation
        ? "passed"
        : !matchingViolation.repaired
          ? "flagged_protected"
          : "repaired";
      const verdictRule = matchingViolation ? `enforceNormalDayLocality: ${matchingViolation.reason}` : null;

      return {
        itemId: item.recommendationId || `${day.dayNumber}:${item.name}`,
        itemName: item.name,
        category: item.category,
        geoSource,
        precision,
        ownerStay: phase?.areaLabel ?? "",
        legMinutes,
        verdict,
        verdictRule,
      };
    });

    return {
      dayNumber: day.dayNumber,
      ownerStay: phase?.areaLabel ?? "",
      derivedDayType: derived,
      textualDayType: textual,
      dayTypeMismatch: derived !== textual && !(derived === "arrival" || derived === "departure"),
      totalLegMinutes: Math.round(totalLegMinutes),
      maxLegMinutes: Math.round(maxLegMinutes),
      unresolvedItemCount,
      items,
    };
  });
}

export interface NormalDayTravelOutlier {
  dayNumber: number;
  itemName: string;
  travelMinutes: number;
  repaired: boolean;
}

/**
 * Spec "PART A — MAKE TRAVEL METRICS ACTUALLY ACTIVE" / A1 — a real,
 * itinerary-wide check on the single-segment travel TIME between
 * consecutive items, distinct from enforceNormalDayLocality's own
 * distance-from-base check just above (a day can be entirely within its
 * own stay's locality radius and still have one genuinely bad point-to-
 * point hop, e.g. a large/sparse destination's own wide radius). Skips
 * day-trip and transfer days entirely (spec A2/A3 — their longer travel is
 * expected, never penalized here). Repair order matches A1 exactly: a
 * real nearby candidate first, a free-exploration placeholder second —
 * never a raised threshold, never a silent removal.
 */
export function repairNormalDayTravelOutliers(
  days: AiGeneratedDay[],
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  removedItemKeysByDay: Map<number, Set<string>> = new Map()
): { days: AiGeneratedDay[]; outliers: NormalDayTravelOutlier[] } {
  const outliers: NormalDayTravelOutlier[] = [];
  const mutableDays = [...days];
  // Root-cause fix (spec §A/§F) — see enforceNormalDayLocality's identical
  // comment; this function shares the exact same "locality_repair" trace
  // source and the same day-local bug.
  const usageState = buildItineraryUsageState(mutableDays);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    if (isIntercityTransferDay(day) || isDayTripDay(day)) continue;

    const outlierItem = day.items.find(
      (item) => item.travelMinutes != null && item.travelMinutes > mobilityProfile.normalDayTravelBudgetMinutes
    );
    if (!outlierItem) continue;

    if (isProtectedItem(outlierItem)) {
      outliers.push({ dayNumber: day.dayNumber, itemName: outlierItem.name, travelMinutes: outlierItem.travelMinutes ?? 0, repaired: false });
      continue;
    }

    // Spec "נדנוד אינסופי" (ב) — never re-offer a place already rejected
    // from THIS day earlier in the same repairPlan run.
    const previouslyRemovedFromThisDay = removedItemKeysByDay.get(day.dayNumber) ?? new Set<string>();

    // pickReplacementRecommendation excludes `item` (the outlier) from its
    // own internal anchor/scoring context itself (spec "תיקון גנרי, לא
    // תיקון תשיעי") — the actual mechanism behind picking Thor's
    // Well/Mendenhall Ice Caves for a day nowhere near them used to be
    // that this call passed a day view still including the outlier, so
    // pickReplacementRecommendation's hard geographic filter
    // (isCandidateGeographicallyCompatibleWithDay) accepted a candidate
    // close to ANY existing item it was handed, outlier included. Now
    // guaranteed by the function itself, not by this call site.
    releaseItineraryUsage(usageState, outlierItem);
    const rawReplacement = pickReplacementRecommendation({
      traceSource: "locality_repair",
      payload,
      day,
      item: outlierItem,
      profile,
      usageState,
      maxDistanceKm: mobilityProfile.localityRadiusKm,
    });
    // Spec "נדנוד אינסופי" (ב) — a candidate already rejected from THIS
    // day earlier in the same repairPlan run is a separate exclusion from
    // itinerary-wide usage (it may never have been genuinely scheduled
    // anywhere), preserved here exactly as before this pass.
    const replacement =
      rawReplacement &&
      previouslyRemovedFromThisDay.has(
        buildItemKey({
          recommendationId: rawReplacement.id,
          name: rawReplacement.name,
          lat: rawReplacement.lat,
          lon: rawReplacement.lon,
          location: rawReplacement.location,
        })
      )
        ? null
        : rawReplacement;
    // A real replacement candidate already gets a real recomputed
    // travelMinutes (buildReplacementItem). buildFreeExplorationReplacement
    // does not touch travelMinutes at all (it has no coordinates to
    // compute a real one from) and would otherwise silently inherit the
    // very outlier value this repair exists to fix — a short, honest
    // nearby-wandering estimate replaces it instead, same convention
    // buildFallbackMealPlaceholder already uses for a coordinate-less item.
    // No candidate passing the geographic filter above (the outlier is
    // never counted as its own valid anchor, exactly as intended) lands
    // here too — a local free-exploration block, never "closest among the
    // far ones".
    const nextItem = replacement
      ? buildReplacementItem(replacement, outlierItem, day, payload)
      : { ...buildFreeExplorationReplacement(outlierItem, day), travelMinutes: 10 };
    registerItineraryUsage(usageState, nextItem);
    const updatedDay = fillDerivedDayFields(
      resequenceDayItems(normalizeDayCollections({ ...day, items: day.items.map((entry) => (entry === outlierItem ? nextItem : entry)) })),
      payload,
      profile
    );
    mutableDays[dayIndex] = updatedDay;

    removedItemKeysByDay.set(day.dayNumber, new Set([...previouslyRemovedFromThisDay, buildItemKey(outlierItem)]));

    outliers.push({ dayNumber: day.dayNumber, itemName: outlierItem.name, travelMinutes: outlierItem.travelMinutes ?? 0, repaired: true });
  }

  return { days: mutableDays, outliers };
}

// Section "AIRPORTS ARE NOT ATTRACTIONS" / "TRANSPORT INFRASTRUCTURE ROLE
// GUARD" — generic name patterns (English/Hebrew), never a hardcoded list
// of specific airport/station names, matching the same convention already
// used by TRANSFER_DAY_PATTERN/DAY_TRIP_PATTERN.
//
// Round 3 addition (real replay: "Chicago Union Station" surviving inside
// a normal Chicago sightseeing day) — the earlier pattern only matched a
// "station" preceded by an explicit mode word (train/railway/bus/metro/
// subway). Major intercity rail terminals are very commonly named
// "<City> Union Station" / "<City> Central Station" / "Grand Central
// Terminal" / "<City> Penn Station" / a "transit center"/"port authority"
// / a "<mode> terminal" — a worldwide naming convention, not a specific
// place. The Hebrew forms also now allow the definite article ("שדה
// התעופה", "תחנת הרכבת").
const TRANSPORT_INFRASTRUCTURE_NAME_PATTERN =
  /international airport|\bairport\b|train station|railway station|\bunion station\b|\bcentral station\b|\bgrand central\b|\bpenn station\b|bus terminal|bus station|coach station|metro station|subway station|\btransit (?:center|centre|hub)\b|port authority|(?:train|rail|bus|ferry|coach|cruise|airport) terminal|נמל ?ה?תעופה|שדה ?ה?תעופה|תחנת ?ה?רכבת|תחנה מרכזית|מסוף (?:נוסעים|אוטובוסים)/i;

export interface TransportRoleViolation {
  dayNumber: number;
  itemName: string;
  repaired: boolean;
}

/**
 * Root-cause fix (real 43-day US replay: "O'Hare International Airport"
 * scheduled as a 09:00 Chicago activity, "Los Angeles International
 * Airport" scheduled as an LA activity) — the ONE real, structural marker
 * a genuinely synthesized ground-transfer item carries (buildStayTransitionItem
 * always sets this exact prefix on canonicalPlaceId; nothing else in this
 * codebase produces it). This is deliberately NOT `category ===
 * "transportation"` and NOT `isIntercityTransferDay(day)` — both used to be
 * the guard's exemption and both are defeated by circularity: Gemini (or
 * normalizeCategory) can tag a hallucinated sightseeing-airport item
 * "transportation" with zero real transfer context behind it, and a day's
 * own transportSegments/notes are partly SYNTHESIZED from its own items
 * (fillDerivedDayFields), so an airport item's own text can make
 * isIntercityTransferDay(day) true for the very day that contains it. A
 * real synthesized transition never even matches
 * TRANSPORT_INFRASTRUCTURE_NAME_PATTERN in the first place (its name is
 * "<mode>: <fromBase> → <toBase>", never an airport/station name), so
 * requiring this marker for the exemption costs nothing on the legitimate
 * path and closes both circular escape hatches on the illegitimate one.
 */
function isStayTransitionItem(item: Pick<AiGeneratedItem, "canonicalPlaceId">): boolean {
  return item.canonicalPlaceId?.startsWith("transition:") ?? false;
}

/**
 * Spec "AIRPORTS ARE NOT ATTRACTIONS" / "SEMANTIC ROLE GATE" — transport
 * infrastructure (an airport, station, terminal) and accommodation (a
 * hotel) may never occupy a generic activity slot; the ONLY legitimate
 * transfer-role item is the one this codebase itself synthesizes
 * (isStayTransitionItem, above) — never granted by category label or by a
 * day's own (partly self-generated) transfer-sounding text. A hotel is
 * judged purely by its structured category, never by name, since "hotel"
 * is already a first-class RecommendationCategory value with no
 * legitimate reason to appear as a day.items entry at all (accommodation
 * lives on the stay's own accommodationLat/Lon fields, never as a
 * scheduled activity). Anywhere a violation is found, it's repaired the
 * same way any other invalid item is (real nearby candidate first, free
 * exploration second) — never removed silently, never kept.
 */
export function enforceTransportRoleGuard(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  tripFrame?: TripFrame,
  areaAnchors?: Map<string, { lat: number; lon: number } | null>
): { days: AiGeneratedDay[]; violations: TransportRoleViolation[] } {
  const violations: TransportRoleViolation[] = [];
  const mutableDays = [...days];
  // Root-cause fix (spec §A/§F) — see enforceNormalDayLocality's identical comment.
  const usageState = buildItineraryUsageState(mutableDays);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    let mutableDay = day;
    let changed = false;
    const phase = tripFrame ? findFramePhaseForDay(tripFrame, day.dayNumber) : null;
    const stayAreaAnchor = phase && areaAnchors ? (areaAnchors.get(phase.areaLabel) ?? null) : null;

    for (const item of day.items) {
      const isTransportRoleMatch = TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(item.name);
      const isHotelRoleMatch = item.category === "hotel";
      if (!isTransportRoleMatch && !isHotelRoleMatch) continue;
      if (isTransportRoleMatch && isStayTransitionItem(item)) continue; // the real, structurally-marked ground transfer — a legitimate mention

      if (isProtectedItem(item)) {
        violations.push({ dayNumber: day.dayNumber, itemName: item.name, repaired: false });
        continue;
      }

      releaseItineraryUsage(usageState, item);
      const rawReplacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day: mutableDay,
        item,
        profile,
        usageState,
        stayAreaAnchor,
      });
      // Root-cause fix (real replay: LAX "replaced" by LAX) — pickReplacementRecommendation
      // never applies TRANSPORT_INFRASTRUCTURE_NAME_PATTERN or a hotel-category
      // check to its own candidate pool, and releaseItineraryUsage just
      // freed the offending item, so the closest candidate to the stay
      // anchor is very often the SAME airport/station/hotel. A replacement
      // that is itself a semantic-role violation is discarded here — the
      // day gets a synthetic free-exploration block instead, never another
      // masquerading infrastructure item.
      const replacement =
        rawReplacement &&
        !TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(rawReplacement.name) &&
        rawReplacement.category !== "hotel"
          ? rawReplacement
          : null;
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, mutableDay, payload)
        : buildFreeExplorationReplacement(item, mutableDay);
      registerItineraryUsage(usageState, nextItem);
      mutableDay = { ...mutableDay, items: mutableDay.items.map((entry) => (entry === item ? nextItem : entry)) };
      changed = true;
      violations.push({ dayNumber: day.dayNumber, itemName: item.name, repaired: true });
    }

    if (changed) {
      mutableDays[dayIndex] = fillDerivedDayFields(resequenceDayItems(normalizeDayCollections(mutableDay)), payload, profile);
    }
  }

  return { days: mutableDays, violations };
}

export interface FinalPlaceLegalityViolation {
  dayNumber: number;
  itemName: string;
  rule: ScheduledPlaceLegalityRule;
  repaired: boolean;
}

/**
 * Spec "DAY-LEVEL POI GEOGRAPHY / LEGALITY" §Step 3 "ONE AUTHORITATIVE
 * FINAL GATE" — a genuinely independent last-mile check, run after every
 * other repair (enforceNormalDayLocality, enforceTransportRoleGuard,
 * ensureArrivalDepartureDayHasContent) on the EXACT days object about to
 * be returned, using the same evaluateScheduledPlaceLegality primitive
 * unit-tested in tests/scheduled-place-legality.test.ts — never a
 * duplicate reimplementation, and never the day's own pre-repair state.
 * This is deliberately NOT a replacement for enforceNormalDayLocality (its
 * own inline day-trip/transfer detour math is the real, historically
 * battle-tested source of truth for THOSE day types, and rewriting it
 * risked regressing 700+ passing scenarios) — it is the belt-and-suspenders
 * backstop the spec asks for: whatever upstream repair pass missed, has a
 * bug in, or gets added later without threading a stay anchor through
 * correctly, this still catches on the FINAL object before it is ever
 * persisted or rendered.
 *
 * No category exemption: only synthetic items (isSyntheticScheduleItem),
 * food (its own opening-hours/meal-spacing repairs own that class), and
 * the two semantic-role categories enforceTransportRoleGuard just handled
 * (transportation — including the real, structurally-marked stay
 * transition, which legitimately connects two different anchors and is
 * never subject to a single-stay-anchor distance rule; hotel) are skipped.
 * Every other real item — attraction, museum, nature, restaurant does NOT
 * apply here since it's food, hidden_gem, shopping, nightlife, family,
 * seasonal_event, day_trip — is judged, regardless of what category label
 * it carries, using the day's own FINAL derived day type/stay anchor/
 * transfer context, never a stale pre-repair value.
 */
export function enforceFinalPlaceLegalityGate(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  arrivalDepartureWindow: ArrivalDepartureWindow | null = null
): { days: AiGeneratedDay[]; violations: FinalPlaceLegalityViolation[] } {
  const violations: FinalPlaceLegalityViolation[] = [];
  const mutableDays = [...days];
  const usageState = buildItineraryUsageState(mutableDays);
  const dailyCapacityMinutes = deriveDailyCapacityMinutes(payload.preferences.tripPace);
  const stayTransitions = buildStayTransitions(tripFrame, areaAnchors);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) continue; // no phase at all — same "never block on missing structure" convention as enforceNormalDayLocality
    const stayAnchor = areaAnchors.get(phase.areaLabel) ?? null;
    const dayType = deriveDayType(day, tripFrame, arrivalDepartureWindow);
    const transition =
      dayType === "transfer" ? stayTransitions.find((candidate) => candidate.dayNumber === day.dayNumber) : undefined;

    let mutableDay = day;
    let changed = false;

    for (const item of day.items) {
      // Round 6 — THE one authoritative real-place predicate. A museum, a
      // landmark, a shopping venue, a restaurant: all judged identically.
      if (!isScheduledRealPlace(item)) continue;

      const result = evaluateScheduledPlaceLegality({
        placeLat: item.lat,
        placeLon: item.lon,
        dayType,
        stayAnchor,
        mobilityProfile,
        dailyCapacityMinutes,
        visitMinutes: item.estimatedDurationMinutes,
        transferOrigin: transition?.fromCoordinates ?? undefined,
        transferDestination: transition?.toCoordinates ?? undefined,
        directTransferMinutes: transition?.estimatedTravelMinutes ?? undefined,
      });

      // Round 6 — the raw-kilometre rule alone can accept a POI in an
      // entirely different metro/region on the sparse tier (120 km). If
      // the item's OWN location text positively names a different known
      // area that is genuinely separate from the owner, it does not
      // belong on this day regardless of what the single trip-wide radius
      // says. Never applied to a transfer day (its corridor is judged by
      // real detour math above).
      const namesElsewhere =
        dayType !== "transfer"
          ? realPlaceNamesADifferentKnownArea(item.lat, item.lon, item.location, phase.areaLabel, stayAnchor, areaAnchors, tripFrame)
          : { matched: false as const };
      if (result.legal && !namesElsewhere.matched) continue;
      const effectiveRule: ScheduledPlaceLegalityRule = result.legal ? "invalid_normal_day_distance" : result.rule;

      if (isProtectedItem(item)) {
        violations.push({ dayNumber: day.dayNumber, itemName: item.name, rule: effectiveRule, repaired: false });
        continue;
      }

      releaseItineraryUsage(usageState, item);
      const rawReplacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day: mutableDay,
        item,
        profile,
        usageState,
        maxDistanceKm: mobilityProfile.localityRadiusKm,
        stayAreaAnchor: stayAnchor,
      });
      // Round 3 — re-validate the replacement against the SAME authoritative
      // check before accepting it. pickReplacementRecommendation's own
      // geographic filter can still pass a candidate (e.g. via a stale/
      // coarse anchor) that this gate's stricter derived-day-type +
      // evaluateScheduledPlaceLegality would reject; without this, the gate
      // could "repair" an illegal place with another illegal place and
      // still report repaired:true.
      const replacement =
        rawReplacement &&
        evaluateScheduledPlaceLegality({
          placeLat: rawReplacement.lat,
          placeLon: rawReplacement.lon,
          dayType,
          stayAnchor,
          mobilityProfile,
          dailyCapacityMinutes,
          visitMinutes: rawReplacement.estimatedDurationMinutes ?? undefined,
          transferOrigin: transition?.fromCoordinates ?? undefined,
          transferDestination: transition?.toCoordinates ?? undefined,
          directTransferMinutes: transition?.estimatedTravelMinutes ?? undefined,
        }).legal &&
        !(dayType !== "transfer" &&
          realPlaceNamesADifferentKnownArea(rawReplacement.lat, rawReplacement.lon, rawReplacement.location, phase.areaLabel, stayAnchor, areaAnchors, tripFrame).matched)
          ? rawReplacement
          : null;
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, mutableDay, payload)
        : buildFreeExplorationReplacement(item, mutableDay);
      registerItineraryUsage(usageState, nextItem);
      mutableDay = { ...mutableDay, items: mutableDay.items.map((entry) => (entry === item ? nextItem : entry)) };
      changed = true;
      violations.push({ dayNumber: day.dayNumber, itemName: item.name, rule: effectiveRule, repaired: true });
    }

    if (changed) {
      mutableDays[dayIndex] = fillDerivedDayFields(resequenceDayItems(normalizeDayCollections(mutableDay)), payload, profile);
    }
  }

  return { days: mutableDays, violations };
}

export interface FinalItineraryInvariantReport {
  /** Real scheduled POIs that fail evaluateScheduledPlaceLegality against the FINAL day/frame. */
  illegalScheduledRealPlaces: number;
  /** transition:-marked items whose from/to no longer match the day's own current TripFrame phase boundary (or that sit on a non-transfer day). */
  invalidTransitionOwnership: number;
  /** Airports/stations/hotels occupying a generic activity slot with no structural transport/accommodation context. */
  invalidSemanticRolePlacements: number;
  /** Distinct days that have a real scheduled place but whose owning phase has no resolvable geographic anchor. */
  ownerGeometryMissingDays: number;
  /** Real scheduled POIs with no coordinates at all — geography can never be verified for them. */
  realItemsWithNullLegGeometry: number;
  /** Round 4 — days that map to NO TripFrame phase at all yet carry real scheduled content (no structural owner exists). */
  dayOwnerMismatch: number;
  /** Round 4 — days whose displayed area (cityRegion) does not share the owning phase's area label. */
  invalidDayDisplayOwnership: number;
  /** Round 4 — days whose lodging base (accommodation) does not share the owning phase's area label. */
  lodgingOwnerMismatch: number;
  /** Round 4 — synthetic items (free-time / meal-opportunity / transit-practical) whose area label does not share the owning phase's area label. */
  syntheticOwnerMismatch: number;
  /** Round 5 — REAL named food venues (restaurant / cafe / bar) that fail evaluateScheduledPlaceLegality against the FINAL day owner (subset of illegalScheduledRealPlaces, surfaced separately). */
  realFoodVenueOwnerMismatch: number;
  /**
   * Round 6 — a purely diagnostic 3-way split of the SAME
   * `illegalScheduledRealPlaces` total (attractions/museums/landmarks/nature/
   * shopping/other non-food POIs vs. food venues vs. anything else real).
   * `illegalRealAttractions + illegalRealFoodVenues + illegalRealOtherVenues
   * === illegalScheduledRealPlaces` always. NEVER gate on these — the
   * authoritative acceptance counter is `illegalScheduledRealPlaces`.
   */
  illegalRealAttractions: number;
  illegalRealFoodVenues: number;
  illegalRealOtherVenues: number;
  /** Round 5 — days whose narrative text (day.notes) positively names a DIFFERENT TripFrame phase's area than the day's owner. */
  narrativeOwnerMismatch: number;
  /**
   * Round 7 — the ONE authoritative opening-hours acceptance counter: every
   * real scheduled venue with PARSEABLE hours whose scheduled activity
   * interval cannot legally fit an opening interval for that day's local
   * weekday (start before opening / after closing / in a gap / duration
   * overruns closing / closed that weekday). Locked/fixedTime conflicts are
   * NOT included here — they are counted in `lockedOpeningHoursConflicts`.
   */
  openingHoursViolations: number;
  /** Round 7 — real scheduled venues whose hours could not be parsed at all (never a violation, surfaced so "unknown" is visibly distinct from "known-legal"). */
  openingHoursUnknownItems: number;
  /** Round 7 — locked / fixedTime real venues that DO conflict with their own opening hours; preserved (never silently moved), reported so the itinerary is never falsely "fully legal". */
  lockedOpeningHoursConflicts: number;
  /**
   * Round 7 — purely diagnostic split of `openingHoursViolations` by shape.
   * `opensAfterScheduledStart + closesBeforeScheduledEnd + closedAtStart +
   * closedAllDay === openingHoursViolations` always. NEVER gate on these.
   */
  opensAfterScheduledStart: number;
  closesBeforeScheduledEnd: number;
  closedAtStart: number;
  closedAllDay: number;
  /** Per-violation detail, for logging/tests — never used to gate anything. */
  details: Array<{ dayNumber: number; itemName: string; kind: string; note?: string }>;
}

function parseTransitionMarker(canonicalPlaceId: string): { fromBase: string; toBase: string } | null {
  if (!canonicalPlaceId.startsWith("transition:")) return null;
  const body = canonicalPlaceId.slice("transition:".length);
  const sep = body.indexOf("->");
  if (sep === -1) return null;
  return { fromBase: body.slice(0, sep), toBase: body.slice(sep + 2) };
}

/**
 * Spec "TRIP-FRAME / DAY OWNERSHIP / FINAL GEOGRAPHY INVARIANT" §Step 5 —
 * a PURE validator over the EXACT final itinerary. It NEVER mutates and it
 * NEVER re-runs a repair function (the previous "diagnostic" re-ran
 * enforceNormalDayLocality, which is a tautology). Every real scheduled
 * place is judged by evaluateScheduledPlaceLegality against the FINAL
 * day/frame; every transition:-marked item is judged by whether its
 * from/to still matches the day's own current TripFrame phase boundary;
 * every airport/station/hotel by whether it has real structural context.
 * Acceptance requires every count to be zero. Worldwide/generic — no
 * country, city or place name is referenced.
 */
export function validateFinalItineraryInvariants(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  arrivalDepartureWindow: ArrivalDepartureWindow | null = null
): FinalItineraryInvariantReport {
  const dailyCapacityMinutes = deriveDailyCapacityMinutes(payload.preferences.tripPace);
  const stayTransitions = buildStayTransitions(tripFrame, areaAnchors);
  const details: FinalItineraryInvariantReport["details"] = [];
  let illegalScheduledRealPlaces = 0;
  let invalidTransitionOwnership = 0;
  let invalidSemanticRolePlacements = 0;
  let realItemsWithNullLegGeometry = 0;
  let dayOwnerMismatch = 0;
  let invalidDayDisplayOwnership = 0;
  let lodgingOwnerMismatch = 0;
  let syntheticOwnerMismatch = 0;
  let realFoodVenueOwnerMismatch = 0;
  let narrativeOwnerMismatch = 0;
  let illegalRealAttractions = 0;
  let illegalRealFoodVenues = 0;
  let illegalRealOtherVenues = 0;
  let openingHoursViolations = 0;
  let openingHoursUnknownItems = 0;
  let lockedOpeningHoursConflicts = 0;
  let opensAfterScheduledStart = 0;
  let closesBeforeScheduledEnd = 0;
  let closedAtStart = 0;
  let closedAllDay = 0;
  // Purely diagnostic: split ONE `illegalScheduledRealPlaces` hit into exactly
  // one of three buckets so they always sum back to the authoritative total.
  const SIGHTSEEING_CATEGORIES = new Set<RecommendationCategory>([
    "museum",
    "nature",
    "shopping",
    "hidden_gem",
    "seasonal_event",
    "day_trip",
  ]);
  const bucketIllegalRealPlace = (item: Pick<AiGeneratedItem, "category">): void => {
    if (isFoodItem(item.category)) illegalRealFoodVenues += 1;
    else if (SIGHTSEEING_CATEGORIES.has(item.category)) illegalRealAttractions += 1;
    else illegalRealOtherVenues += 1;
  };
  const ownerGeometryMissingDayNumbers = new Set<number>();
  const allPhaseLabels = tripFrame.phases.map((phase) => phase.areaLabel);

  for (const day of days) {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const previousPhase = day.dayNumber > 1 ? findFramePhaseForDay(tripFrame, day.dayNumber - 1) : null;
    const stayAnchor = phase ? (areaAnchors.get(phase.areaLabel) ?? null) : null;
    const dayType = deriveDayType(day, tripFrame, arrivalDepartureWindow);

    // Round 4 — structural ownership consistency (spec "ONE DAY HAS ONE
    // AUTHORITATIVE STRUCTURAL OWNER"). Display / lodging / synthetic-item
    // area labels must all agree with the owning phase; a day with no
    // phase at all yet carrying real content has no owner.
    const hasRealContent = day.items.some(
      (candidate) => !isSyntheticScheduleItem(candidate) && !isStayTransitionItem(candidate)
    );
    if (!phase) {
      if (hasRealContent) {
        dayOwnerMismatch += 1;
        details.push({ dayNumber: day.dayNumber, itemName: "(day)", kind: "day_owner_mismatch", note: "no TripFrame phase owns this day" });
      }
    } else {
      if (!sharesDayArea(day.cityRegion, phase.areaLabel)) {
        invalidDayDisplayOwnership += 1;
        details.push({ dayNumber: day.dayNumber, itemName: "(day)", kind: "invalid_day_display_ownership", note: `cityRegion "${day.cityRegion}" != owner "${phase.areaLabel}"` });
      }
      if (!phraseNamesArea(day.accommodation, phase.areaLabel)) {
        lodgingOwnerMismatch += 1;
        details.push({ dayNumber: day.dayNumber, itemName: "(day)", kind: "lodging_owner_mismatch", note: `accommodation "${day.accommodation}" != owner "${phase.areaLabel}"` });
      }
      // Round 5 — the day's narrative names a DIFFERENT phase's area.
      if (
        allPhaseLabels.some((label) => !sharesDayArea(label, phase.areaLabel) && phraseNamesArea(day.notes, label))
      ) {
        narrativeOwnerMismatch += 1;
        details.push({ dayNumber: day.dayNumber, itemName: "(day)", kind: "narrative_owner_mismatch", note: `day.notes names an area other than owner "${phase.areaLabel}"` });
      }
      for (const synthetic of day.items) {
        // Round 5 — a generic meal-opportunity placeholder whose itemRole
        // was dropped (e.g. on a save round-trip) still reads as a synthetic
        // area label that must match the owner.
        if (!isSyntheticScheduleItem(synthetic) && !isGenericMealOpportunity(synthetic)) continue;
        if (synthetic.location && !sharesDayArea(synthetic.location, phase.areaLabel)) {
          syntheticOwnerMismatch += 1;
          details.push({ dayNumber: day.dayNumber, itemName: synthetic.name, kind: "synthetic_owner_mismatch", note: `synthetic location "${synthetic.location}" != owner "${phase.areaLabel}"` });
        }
      }
    }
    const transition =
      dayType === "transfer" ? stayTransitions.find((candidate) => candidate.dayNumber === day.dayNumber) : undefined;
    // The one marker that is legitimate ON THIS DAY: the current frame's
    // own phase boundary here, and only when this really is a transfer day.
    const expectedMarker =
      dayType === "transfer" && previousPhase && phase
        ? buildTransitionMarker(previousPhase.areaLabel, phase.areaLabel)
        : null;

    for (const item of day.items) {
      // Structural transition item — validate OWNERSHIP, not distance.
      if (isStayTransitionItem(item)) {
        const parsed = parseTransitionMarker(item.canonicalPlaceId);
        if (item.canonicalPlaceId !== expectedMarker) {
          invalidTransitionOwnership += 1;
          details.push({
            dayNumber: day.dayNumber,
            itemName: item.name,
            kind: "invalid_transition_ownership",
            note: parsed
              ? `marker ${parsed.fromBase} -> ${parsed.toBase} does not match this day's own frame boundary${
                  expectedMarker ? ` (expected ${expectedMarker.slice("transition:".length)})` : " (this day is not a transfer day)"
                }`
              : "unparseable transition marker",
          });
        }
        continue;
      }

      // Round 5/6 — a GENERIC meal-opportunity placeholder has no
      // coordinate to judge (its owner-label consistency is checked in the
      // day block above); every OTHER real scheduled place — museum,
      // landmark, shopping, restaurant alike — is judged here.
      if (isGenericMealOpportunity(item)) continue;
      if (!isScheduledRealPlace(item) && !TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(item.name) && item.category !== "hotel" && item.category !== "transportation") continue;

      // Semantic role — an airport/station/hotel in a generic activity
      // slot. The ONLY legitimate transport-role item is the structural
      // transition handled above; a hotel is never a day.items entry.
      const isTransportInfraName = TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(item.name);
      if (isTransportInfraName || item.category === "hotel" || item.category === "transportation") {
        invalidSemanticRolePlacements += 1;
        details.push({
          dayNumber: day.dayNumber,
          itemName: item.name,
          kind: "invalid_semantic_role_placement",
          note: item.category === "hotel"
            ? "hotel category in a scheduled activity slot"
            : item.category === "transportation"
              ? "transportation-category item with no structural transition marker"
              : "transport-infrastructure name in a scheduled activity slot with no transition context",
        });
        continue;
      }

      // Round 7 — opening-hours legality (a separate axis from geography):
      // the scheduled activity interval must fit a real opening interval
      // for this day's local weekday. Applies to every real scheduled
      // venue, food included. Locked/fixedTime conflicts are preserved and
      // reported separately, never counted as a repairable violation.
      const ohStatus = evaluateItemOpeningHoursLegality(item, day.date).status;
      if (ohStatus === "UNKNOWN") {
        openingHoursUnknownItems += 1;
      } else if (isKnownHoursViolation(ohStatus)) {
        if (item.locked || item.fixedTime) {
          lockedOpeningHoursConflicts += 1;
          details.push({ dayNumber: day.dayNumber, itemName: item.name, kind: `locked_opening_hours_conflict:${ohStatus}` });
        } else {
          openingHoursViolations += 1;
          if (ohStatus === "OPENS_AFTER_START") opensAfterScheduledStart += 1;
          else if (ohStatus === "CLOSES_BEFORE_END") closesBeforeScheduledEnd += 1;
          else if (ohStatus === "CLOSED_ALL_DAY") closedAllDay += 1;
          else closedAtStart += 1;
          details.push({ dayNumber: day.dayNumber, itemName: item.name, kind: `opening_hours_violation:${ohStatus}` });
        }
      }

      // Real named venue — restaurant / cafe / bar / attraction / museum /
      // park alike (Round 5: `category === "food"` is NOT an exemption).
      const isFoodVenue = isFoodItem(item.category);
      if (item.lat == null || item.lon == null) {
        realItemsWithNullLegGeometry += 1;
        illegalScheduledRealPlaces += 1;
        bucketIllegalRealPlace(item);
        if (isFoodVenue) realFoodVenueOwnerMismatch += 1;
        details.push({ dayNumber: day.dayNumber, itemName: item.name, kind: isFoodVenue ? "real_food_venue_null_geometry" : "real_item_null_geometry" });
        continue;
      }
      if (phase && !stayAnchor) {
        ownerGeometryMissingDayNumbers.add(day.dayNumber);
      }
      const result = evaluateScheduledPlaceLegality({
        placeLat: item.lat,
        placeLon: item.lon,
        dayType,
        stayAnchor,
        mobilityProfile,
        dailyCapacityMinutes,
        visitMinutes: item.estimatedDurationMinutes,
        transferOrigin: transition?.fromCoordinates ?? undefined,
        transferDestination: transition?.toCoordinates ?? undefined,
        directTransferMinutes: transition?.estimatedTravelMinutes ?? undefined,
      });
      // Round 6 — a POI whose own location text positively names a
      // different, genuinely-separate known area is illegal even when the
      // single trip-wide radius happens to accept the raw kilometres.
      const namesElsewhere =
        dayType !== "transfer" &&
        !!phase &&
        realPlaceNamesADifferentKnownArea(item.lat, item.lon, item.location, phase.areaLabel, stayAnchor, areaAnchors, tripFrame).matched;
      if (!result.legal || namesElsewhere) {
        illegalScheduledRealPlaces += 1;
        bucketIllegalRealPlace(item);
        if (isFoodVenue) realFoodVenueOwnerMismatch += 1;
        const kindBase = isFoodVenue ? "illegal_real_food_venue" : "illegal_real_place";
        details.push({ dayNumber: day.dayNumber, itemName: item.name, kind: namesElsewhere && result.legal ? `${kindBase}:names_a_different_known_area` : `${kindBase}:${result.rule}` });
      }
    }
  }

  return {
    illegalScheduledRealPlaces,
    invalidTransitionOwnership,
    invalidSemanticRolePlacements,
    ownerGeometryMissingDays: ownerGeometryMissingDayNumbers.size,
    realItemsWithNullLegGeometry,
    dayOwnerMismatch,
    invalidDayDisplayOwnership,
    lodgingOwnerMismatch,
    syntheticOwnerMismatch,
    realFoodVenueOwnerMismatch,
    narrativeOwnerMismatch,
    illegalRealAttractions,
    illegalRealFoodVenues,
    illegalRealOtherVenues,
    openingHoursViolations,
    openingHoursUnknownItems,
    lockedOpeningHoursConflicts,
    opensAfterScheduledStart,
    closesBeforeScheduledEnd,
    closedAtStart,
    closedAllDay,
    details,
  };
}

/**
 * Spec §Step 6 "REPAIR, THEN VALIDATE" — runs the PURE validator over the
 * final object; if anything is non-zero, applies ONE bounded, deterministic
 * repair (remove a stale/ownerless transition marker; remove or
 * legal-replace an illegal real place or a masquerading airport/station/
 * hotel — a replacement is re-checked with the SAME pure per-item rules
 * before being accepted, else a synthetic FreeTimeBlock is used); then
 * re-runs the PURE validator. No real place is inserted after the second
 * validation.
 */
export function enforceItineraryInvariantsWithRepair(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  window: ArrivalDepartureWindow
): { days: AiGeneratedDay[]; before: FinalItineraryInvariantReport; after: FinalItineraryInvariantReport } {
  const before = validateFinalItineraryInvariants(days, tripFrame, areaAnchors, mobilityProfile, payload, window);
  const total =
    before.illegalScheduledRealPlaces +
    before.invalidTransitionOwnership +
    before.invalidSemanticRolePlacements +
    before.realItemsWithNullLegGeometry +
    before.dayOwnerMismatch +
    before.invalidDayDisplayOwnership +
    before.lodgingOwnerMismatch +
    before.syntheticOwnerMismatch +
    before.realFoodVenueOwnerMismatch +
    before.narrativeOwnerMismatch +
    // Round 7 — a repairable known-hours conflict also forces the bounded
    // repair below (lockedOpeningHoursConflicts is NOT included: it cannot
    // be repaired, only reported).
    before.openingHoursViolations;
  if (total === 0) {
    return { days, before, after: before };
  }

  const dailyCapacityMinutes = deriveDailyCapacityMinutes(payload.preferences.tripPace);
  const stayTransitions = buildStayTransitions(tripFrame, areaAnchors);
  // Round 7 — opening-hours repair runs FIRST in the bounded repair (it
  // reorders / replaces within a day; it never changes which day owns an
  // item, so it cannot regress geography). The geometry/owner repair below
  // then runs on the result, and the PURE validator re-runs at the end.
  days = before.openingHoursViolations > 0
    ? repairOpeningHoursViolations(days, payload, profile)
    : days;
  // Round 4 — deterministically re-bind every day to its canonical owner
  // and re-derive display / lodging / synthetic labels BEFORE the per-item
  // repair below, so those repairs see a structurally consistent day.
  const mutableDays = [...normalizeDayOwnershipToFrame(days, tripFrame, payload, profile)];
  const usageState = buildItineraryUsageState(mutableDays);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const previousPhase = day.dayNumber > 1 ? findFramePhaseForDay(tripFrame, day.dayNumber - 1) : null;
    const stayAnchor = phase ? (areaAnchors.get(phase.areaLabel) ?? null) : null;
    const dayType = deriveDayType(day, tripFrame, window);
    const transition =
      dayType === "transfer" ? stayTransitions.find((candidate) => candidate.dayNumber === day.dayNumber) : undefined;
    const expectedMarker =
      dayType === "transfer" && previousPhase && phase
        ? buildTransitionMarker(previousPhase.areaLabel, phase.areaLabel)
        : null;

    let mutableDay = day;
    let changed = false;

    for (const item of day.items) {
      // Stale/ownerless transition marker — remove outright (the correct
      // transition, if any, was already inserted by enforceStayTransitions).
      if (isStayTransitionItem(item)) {
        if (item.canonicalPlaceId !== expectedMarker) {
          mutableDay = { ...mutableDay, items: mutableDay.items.filter((entry) => entry !== item) };
          changed = true;
        }
        continue;
      }
      // Round 5/6 — a GENERIC meal-opportunity placeholder was already
      // owner-normalized by normalizeDayOwnershipToFrame above; every OTHER
      // real scheduled place (museum, landmark, shopping, restaurant) is
      // repaired here identically via the ONE authoritative predicate.
      if (isGenericMealOpportunity(item) || isSyntheticScheduleItem(item) || item.category === "practical") continue;
      if (isProtectedItem(item)) continue; // reported, never force-removed

      const isSemanticRoleViolation =
        TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(item.name) ||
        item.category === "hotel" ||
        item.category === "transportation";
      const namesElsewhere =
        dayType !== "transfer" &&
        realPlaceNamesADifferentKnownArea(item.lat, item.lon, item.location, phase ? phase.areaLabel : "", stayAnchor, areaAnchors, tripFrame).matched;
      const isIllegalRealPlace =
        isScheduledRealPlace(item) &&
        (item.lat == null ||
          item.lon == null ||
          namesElsewhere ||
          !evaluateScheduledPlaceLegality({
            placeLat: item.lat,
            placeLon: item.lon,
            dayType,
            stayAnchor,
            mobilityProfile,
            dailyCapacityMinutes,
            visitMinutes: item.estimatedDurationMinutes,
            transferOrigin: transition?.fromCoordinates ?? undefined,
            transferDestination: transition?.toCoordinates ?? undefined,
            directTransferMinutes: transition?.estimatedTravelMinutes ?? undefined,
          }).legal);

      if (!isSemanticRoleViolation && !isIllegalRealPlace) continue;

      releaseItineraryUsage(usageState, item);
      const rawReplacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day: mutableDay,
        item,
        profile,
        usageState,
        maxDistanceKm: mobilityProfile.localityRadiusKm,
        stayAreaAnchor: stayAnchor,
      });
      const replacement =
        rawReplacement &&
        !TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(rawReplacement.name) &&
        rawReplacement.category !== "hotel" &&
        rawReplacement.category !== "transportation" &&
        rawReplacement.lat != null &&
        rawReplacement.lon != null &&
        !(dayType !== "transfer" &&
          realPlaceNamesADifferentKnownArea(rawReplacement.lat, rawReplacement.lon, rawReplacement.location, phase ? phase.areaLabel : "", stayAnchor, areaAnchors, tripFrame).matched) &&
        evaluateScheduledPlaceLegality({
          placeLat: rawReplacement.lat,
          placeLon: rawReplacement.lon,
          dayType,
          stayAnchor,
          mobilityProfile,
          dailyCapacityMinutes,
          visitMinutes: rawReplacement.estimatedDurationMinutes ?? undefined,
          transferOrigin: transition?.fromCoordinates ?? undefined,
          transferDestination: transition?.toCoordinates ?? undefined,
          directTransferMinutes: transition?.estimatedTravelMinutes ?? undefined,
        }).legal
          ? rawReplacement
          : null;
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, mutableDay, payload)
        : buildFreeExplorationReplacement(item, mutableDay);
      registerItineraryUsage(usageState, nextItem);
      mutableDay = { ...mutableDay, items: mutableDay.items.map((entry) => (entry === item ? nextItem : entry)) };
      changed = true;
    }

    if (changed) {
      mutableDays[dayIndex] = fillDerivedDayFields(resequenceDayItems(normalizeDayCollections(mutableDay)), payload, profile);
    }
  }

  // Round 7 — the geometry/owner repair above resequences every changed
  // day, which can re-time an item the opening-hours pass had already
  // moved into a legal slot. Re-run the (idempotent) opening-hours repair
  // on the settled object so the PURE re-validation below sees the final
  // truth. Nothing after this line changes an item's scheduled time.
  const openingHoursSettled = repairOpeningHoursViolations(mutableDays, payload, profile);
  for (let i = 0; i < mutableDays.length; i += 1) mutableDays[i] = openingHoursSettled[i];

  const after = validateFinalItineraryInvariants(mutableDays, tripFrame, areaAnchors, mobilityProfile, payload, window);
  return { days: mutableDays, before, after };
}

/* ================================================================== *
 * Round 8 — real-activity QUALITY (a safe, empty itinerary is a fail)  *
 * ================================================================== */

/**
 * Round 8 — THE meaningful-real-activity predicate. A narrower subset of
 * isScheduledRealPlace: excludes real MEAL VENUES too (a real restaurant is
 * a real place for geography/hours purposes, but the product's "did this
 * day give the traveler something to actually DO" question is about
 * sightseeing/activity content — attraction, museum, landmark, nature,
 * shopping, nightlife, hidden_gem, seasonal_event, day_trip). A real meal
 * venue still counts toward the broader `realActivityCount`, never toward
 * `meaningfulRealActivityCount` — matches the spec's own GOOD examples
 * (museum + historic district + shopping, meals listed separately).
 *
 * Round 9.2.1 §1/§18/§19 — rewired from the plain `!isFoodItem(category)`
 * check to the shared classification-based determinePlanningRole, so a
 * genuine food EXPERIENCE (food tour, cooking class, tasting, market tour —
 * classified via activity-taxonomy's own existing food_experience keyword
 * match) still counts as meaningful, even when its raw provider category
 * happens to be "restaurant"/"cafe" — an ordinary restaurant/cafe/bakery/
 * bar never does, regardless of fame (spec §31 "do not call a restaurant a
 * food experience merely to satisfy activity coverage" — this only ever
 * recognizes food_experience via the SAME deterministic keyword evidence
 * activity-taxonomy already uses everywhere else, never a new bespoke rule
 * here).
 */
function isMeaningfulRealActivity(item: AiGeneratedItem): boolean {
  if (!isScheduledRealPlace(item)) return false;
  const classification = classifyActivity({
    category: item.category,
    name: item.name,
    shortDescription: item.shortDescription,
    reservationRequired: item.reservationRequired,
    approximatePrice: item.approximatePrice,
  });
  return determinePlanningRole(item.category, classification) !== "MEAL_VENUE";
}

/**
 * Round 8 — the hard minimum count of meaningful real activities a day of
 * this derived type must carry before it counts as "below minimum". Never
 * city/country-specific; purely a function of day type + whether an
 * EXPLICIT rest/buffer window already justifies a lighter day (spec
 * "restWindow should be explicit on lighter days" — an explicit restWindow
 * is the one honest signal that a day was deliberately made lighter, not
 * merely a repair pass giving up).
 */
function minimumMeaningfulRealActivities(dayType: DerivedDayType, hasExplicitRestWindow: boolean): number {
  if (dayType === "arrival" || dayType === "departure") return 0; // spec: 0-2 depending on usable time
  if (dayType === "transfer") return 0; // spec: 0-1 light real activity only if feasible
  if (dayType === "day_trip") return 1; // the day-trip anchor itself
  return hasExplicitRestWindow ? 1 : 2; // normal day: light (explicit) = 1, full sightseeing day = 2
}

export interface ItineraryQualityDayDetail {
  dayNumber: number;
  dayType: DerivedDayType;
  meaningfulRealActivityCount: number;
  realActivityCount: number;
  syntheticActivityCount: number;
  minimumRequired: number;
  belowMinimum: boolean;
  /** True when a day with zero meaningful real activity is structurally expected (arrival/departure/transfer) or explicitly marked as a rest day (restWindow). */
  justifiedLight: boolean;
  onlySyntheticContent: boolean;
  /** Round 9 — the day's first meaningful real activity's own classification (schedule order = the day's own "opening act"); null on a day with no meaningful real activity at all. */
  dominantFamily: ActivityFamily | null;
  dominantSubtype: ActivitySubtype | null;
}

export interface ItineraryQualityReport {
  /** All real scheduled places, food venues included (subset semantics match isScheduledRealPlace). */
  realActivityCount: number;
  /** Non-food sightseeing/activity real places only — the count the hard minimum is judged against. */
  meaningfulRealActivityCount: number;
  syntheticActivityCount: number;
  /** syntheticActivityCount / (realActivityCount + syntheticActivityCount), 0 when the day/trip has no scheduled content at all. */
  syntheticShare: number;
  daysWithZeroRealActivities: number;
  /** A day with zero REAL activity of any kind (food included) that still carries at least one synthetic filler item — the exact "free_time + meal_opportunity + free_time" failure shape. */
  daysWithOnlySyntheticContent: number;
  /** daysWithOnlySyntheticContent that are NOT structurally justified (not arrival/departure/transfer, no explicit restWindow) — the real acceptance signal. */
  unjustifiedDaysWithOnlySyntheticContent: number;
  daysBelowMinimumRealActivities: number;
  /** Normal days whose synthetic share exceeds the budget (~35%) AND are below the real-activity minimum — a day can be synthetic-heavy AND still meet its minimum (e.g. one landmark + a long deliberate free afternoon), which is fine. */
  excessiveSyntheticDays: number;
  /** Days where a zero/below-minimum result IS structurally justified (arrival/departure/transfer/explicit rest) — reported so the total is never mistaken for a hidden failure. */
  structurallyJustifiedLightDays: number;
  /** Round 9 §23 — counts of every meaningful real activity's own classification, trip-wide. */
  familyDistribution: Partial<Record<ActivityFamily, number>>;
  subtypeDistribution: Partial<Record<ActivitySubtype, number>>;
  /** Round 9 §23 — the longest run of consecutive days sharing the same dominant primary family / subtype (1 when no two adjacent days repeat; 0 when the trip has no meaningful real activity at all). */
  consecutiveSameFamilyDays: number;
  consecutiveSameSubtypeDays: number;
  /**
   * Round 9 §19/§24 — synthetic items on a day that was BELOW its own
   * meaningful-real-activity minimum: synthetic content that exists
   * because a real one could not be found, as distinct from a deliberate
   * free/shopping/rest block on a day that already met its minimum. A
   * proxy (this codebase does not yet persist a `flexibleReason` field on
   * AiGeneratedItem — spec §19's tagging is a disclosed gap), but a
   * deterministic and honest one: never fabricated, always derived from
   * the same real/synthetic counts already computed above.
   */
  candidateExhaustionFallbackCount: number;
  /** Round 9.2.1 §20 — real MEAL_VENUE-role places only (ordinary restaurant/cafe/bakery/bar), the complement of meaningfulRealActivityCount within realActivityCount. Never used to satisfy activity coverage. */
  realMealVenueCount: number;
  /** Round 9.2.1 §20 — synthetic 🍽 MealOpportunity placeholders specifically, a subset of syntheticActivityCount (the rest being free_time/other synthetic filler). */
  syntheticMealOpportunityCount: number;
  /** Round 9.2.1 §18/§20 — real places classified as a genuine food EXPERIENCE (food tour, cooking class, tasting, market tour) — counted separately for visibility even though they already count toward meaningfulRealActivityCount above (spec §18: these belong to the activity portfolio, never the meal system). */
  foodExperienceActivityCount: number;
  /**
   * Round 9.2.1 §20 — a real meal venue scheduled in a slot its own
   * suitableMealTypes evidence does NOT support (spec §9's whole point,
   * audited here independently of whichever pipeline scheduled it — this
   * catches a mismatch even on a Gemini-authored day that never went
   * through scoreMealCandidate's own gate at all).
   */
  mealTypeMismatchCount: number;
  /** Round 9.2.1 §20 — a real meal venue whose distance from its own day's adjacent anchors is large enough to read as an unreasonable detour (spec §10/§26) — a post-hoc geographic audit, independent of whichever selection path produced the day. */
  mealRouteDetourViolations: number;
  /** Round 9.2.1 §20 — a cuisine subtype repeated within RECENT_MEAL_HISTORY_DECAY_DAYS of its own previous occurrence, trip-wide (spec §12/§27) — a soft-diversity AUDIT count, never itself a validation gate. */
  repeatedCuisineCount: number;
  /** Round 9.2.1 §20/§21 — same signal as syntheticMealOpportunityCount, named to match spec §20's own vocabulary exactly; kept as a distinct alias rather than a second independent counter so the two can never drift apart. */
  syntheticMealFallbackCount: number;
  /** Round 9.2.1 §20 — days where EVERY feasible meal slot ended up synthetic (both lunch and dinner, when both were feasible) — the honest proxy available at this pure-validator layer for genuine meal-POOL exhaustion (this function only sees the final days, never the live StayMealVenuePool a generation run actually built; a single mismatched slot is mealTypeMismatchCount/syntheticMealOpportunityCount's own signal, this one is reserved for the stronger "the whole day's meal supply came up empty" shape). */
  mealPoolExhaustionCount: number;
  perDay: ItineraryQualityDayDetail[];
}

/** Normal-day synthetic-share budget (spec §4: "should generally not exceed ~25-35%"). Not a hard block by itself — only combined with belowMinimum counts toward excessiveSyntheticDays. */
const NORMAL_DAY_SYNTHETIC_SHARE_BUDGET = 0.35;

/**
 * Round 8 — THE pure product-quality validator, run AFTER legality/hours
 * validation on the EXACT final itinerary. A day can have
 * illegalScheduledRealPlaces = 0, duplicatePlaces = 0 and
 * openingHoursViolations = 0 while still being a failed itinerary (every
 * "activity" is free_time/meal_opportunity) — this is the counter that
 * catches that shape. Never mutates; never re-runs a repair.
 */
export function validateItineraryQuality(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  arrivalDepartureWindow: ArrivalDepartureWindow | null = null
): ItineraryQualityReport {
  let realActivityCount = 0;
  let meaningfulRealActivityCount = 0;
  let syntheticActivityCount = 0;
  let daysWithZeroRealActivities = 0;
  let daysWithOnlySyntheticContent = 0;
  let unjustifiedDaysWithOnlySyntheticContent = 0;
  let daysBelowMinimumRealActivities = 0;
  let excessiveSyntheticDays = 0;
  let structurallyJustifiedLightDays = 0;
  let candidateExhaustionFallbackCount = 0;
  let realMealVenueCount = 0;
  let syntheticMealOpportunityCount = 0;
  let foodExperienceActivityCount = 0;
  const familyDistribution: Partial<Record<ActivityFamily, number>> = {};
  const subtypeDistribution: Partial<Record<ActivitySubtype, number>> = {};
  const perDay: ItineraryQualityDayDetail[] = [];

  for (const day of days) {
    const dayType = deriveDayType(day, tripFrame, arrivalDepartureWindow);
    const hasExplicitRestWindow = Boolean(day.restWindow && day.restWindow.trim());
    let dayReal = 0;
    let dayMeaningfulReal = 0;
    let daySynthetic = 0;
    let dominantFamily: ActivityFamily | null = null;
    let dominantSubtype: ActivitySubtype | null = null;

    for (const item of day.items) {
      if (isStayTransitionItem(item) || item.category === "hotel" || item.category === "transportation" || item.category === "practical") continue;
      if (isScheduledRealPlace(item)) {
        dayReal += 1;
        const classification = classifyActivity({
          category: item.category,
          name: item.name,
          shortDescription: item.shortDescription,
          reservationRequired: item.reservationRequired,
          approximatePrice: item.approximatePrice,
        });
        if (determinePlanningRole(item.category, classification) === "MEAL_VENUE") {
          realMealVenueCount += 1;
        } else {
          dayMeaningfulReal += 1;
          if (classification.subtype === "food_experience") foodExperienceActivityCount += 1;
          familyDistribution[classification.primaryFamily] = (familyDistribution[classification.primaryFamily] ?? 0) + 1;
          subtypeDistribution[classification.subtype] = (subtypeDistribution[classification.subtype] ?? 0) + 1;
          if (dominantFamily == null) {
            dominantFamily = classification.primaryFamily;
            dominantSubtype = classification.subtype;
          }
        }
      } else if (isSyntheticScheduleItem(item) || isGenericMealOpportunity(item)) {
        daySynthetic += 1;
        if (isGenericMealOpportunity(item)) syntheticMealOpportunityCount += 1;
      }
    }

    realActivityCount += dayReal;
    meaningfulRealActivityCount += dayMeaningfulReal;
    syntheticActivityCount += daySynthetic;

    const minimumRequired = minimumMeaningfulRealActivities(dayType, hasExplicitRestWindow);
    const belowMinimum = dayMeaningfulReal < minimumRequired;
    const justifiedLight = dayType !== "normal" || hasExplicitRestWindow;
    const onlySyntheticContent = dayReal === 0 && daySynthetic > 0;
    const total = dayReal + daySynthetic;
    const syntheticShare = total > 0 ? daySynthetic / total : 0;

    if (dayReal === 0) daysWithZeroRealActivities += 1;
    if (onlySyntheticContent) {
      daysWithOnlySyntheticContent += 1;
      if (!justifiedLight) unjustifiedDaysWithOnlySyntheticContent += 1;
    }
    if (belowMinimum) {
      daysBelowMinimumRealActivities += 1;
      candidateExhaustionFallbackCount += daySynthetic;
      if (justifiedLight) structurallyJustifiedLightDays += 1;
      else if (dayType === "normal" && syntheticShare > NORMAL_DAY_SYNTHETIC_SHARE_BUDGET) excessiveSyntheticDays += 1;
    }

    perDay.push({
      dayNumber: day.dayNumber,
      dayType,
      meaningfulRealActivityCount: dayMeaningfulReal,
      realActivityCount: dayReal,
      syntheticActivityCount: daySynthetic,
      minimumRequired,
      belowMinimum,
      justifiedLight,
      onlySyntheticContent,
      dominantFamily,
      dominantSubtype,
    });
  }

  let consecutiveSameFamilyDays = 0;
  let consecutiveSameSubtypeDays = 0;
  let runFamily = 0;
  let runSubtype = 0;
  for (let i = 0; i < perDay.length; i += 1) {
    const current = perDay[i];
    const previous = i > 0 ? perDay[i - 1] : null;
    runFamily = current.dominantFamily != null && previous?.dominantFamily === current.dominantFamily ? runFamily + 1 : current.dominantFamily != null ? 1 : 0;
    runSubtype = current.dominantSubtype != null && previous?.dominantSubtype === current.dominantSubtype ? runSubtype + 1 : current.dominantSubtype != null ? 1 : 0;
    consecutiveSameFamilyDays = Math.max(consecutiveSameFamilyDays, runFamily);
    consecutiveSameSubtypeDays = Math.max(consecutiveSameSubtypeDays, runSubtype);
  }

  // Round 9.2.1 §20 — meal-specific audit metrics, computed independently
  // of whichever pipeline produced these days (they re-classify every real
  // meal venue from scratch), so they catch a mismatch even on a
  // Gemini-authored day that never went through scoreMealCandidate's own
  // gate. A strictly additive second pass — never changes any count above.
  let mealTypeMismatchCount = 0;
  let mealRouteDetourViolations = 0;
  let repeatedCuisineCount = 0;
  let mealPoolExhaustionCount = 0;
  const cuisineHistory: Array<{ dayIndex: number; subtypes: string[] }> = [];

  for (const day of days) {
    const orderedItems = sortItems(day.items);
    let daySyntheticMealSlots = 0;
    let dayFeasibleMealSlots = 0;

    for (let i = 0; i < orderedItems.length; i += 1) {
      const item = orderedItems[i];
      const isMealSlot = item.slot === "lunch" || item.slot === "dinner";
      if (isGenericMealOpportunity(item) && isMealSlot) {
        daySyntheticMealSlots += 1;
        dayFeasibleMealSlots += 1;
        continue;
      }
      if (!isScheduledRealPlace(item) || !isMealSlot) continue;
      const classification = classifyActivity({
        category: item.category,
        name: item.name,
        shortDescription: item.shortDescription,
        reservationRequired: item.reservationRequired,
        approximatePrice: item.approximatePrice,
      });
      if (determinePlanningRole(item.category, classification) !== "MEAL_VENUE") continue;
      dayFeasibleMealSlots += 1;

      const mealClassification = classifyMealVenue({
        category: item.category,
        name: item.name,
        shortDescription: item.shortDescription,
        openingHours: item.openingHours,
        approximatePrice: item.approximatePrice,
        reservationRequired: item.reservationRequired,
      });
      const requiredMealType: MealType = item.slot === "dinner" ? "DINNER" : "LUNCH";
      if (!mealClassification.suitableMealTypes.includes(requiredMealType)) mealTypeMismatchCount += 1;

      const previous = orderedItems[i - 1];
      const next = orderedItems[i + 1];
      const neighborKms = [previous, next]
        .filter((neighbor): neighbor is AiGeneratedItem => neighbor != null && hasValidCoordinates(neighbor) && hasValidCoordinates(item))
        .map((neighbor) => haversineKm(neighbor.lat as number, neighbor.lon as number, item.lat as number, item.lon as number));
      // A generous, disclosed threshold (never the hard MEAL_MAX_* walking/
      // driving-minutes limits enforced elsewhere) — this is a QUALITY
      // audit signal, not a legality gate; flags only a clear, unambiguous
      // detour rather than every mildly-inconvenient placement.
      if (neighborKms.some((km) => km > 12)) mealRouteDetourViolations += 1;

      if (mealClassification.cuisineSubtypes.length > 0) {
        const repeated = cuisineHistory.some(
          (entry) =>
            day.dayNumber - entry.dayIndex < RECENT_MEAL_HISTORY_DECAY_DAYS &&
            entry.subtypes.some((s) => mealClassification.cuisineSubtypes.includes(s as never))
        );
        if (repeated) repeatedCuisineCount += 1;
        cuisineHistory.push({ dayIndex: day.dayNumber, subtypes: mealClassification.cuisineSubtypes });
      }
    }

    if (dayFeasibleMealSlots >= 2 && daySyntheticMealSlots === dayFeasibleMealSlots) {
      mealPoolExhaustionCount += 1;
    }
  }

  const totalContent = realActivityCount + syntheticActivityCount;
  return {
    realActivityCount,
    meaningfulRealActivityCount,
    syntheticActivityCount,
    syntheticShare: totalContent > 0 ? syntheticActivityCount / totalContent : 0,
    daysWithZeroRealActivities,
    daysWithOnlySyntheticContent,
    unjustifiedDaysWithOnlySyntheticContent,
    daysBelowMinimumRealActivities,
    excessiveSyntheticDays,
    structurallyJustifiedLightDays,
    familyDistribution,
    subtypeDistribution,
    consecutiveSameFamilyDays,
    consecutiveSameSubtypeDays,
    candidateExhaustionFallbackCount,
    realMealVenueCount,
    syntheticMealOpportunityCount,
    foodExperienceActivityCount,
    mealTypeMismatchCount,
    mealRouteDetourViolations,
    repeatedCuisineCount,
    syntheticMealFallbackCount: syntheticMealOpportunityCount,
    mealPoolExhaustionCount,
    perDay,
  };
}

/**
 * Round 8 — quality acceptance: legality/hours/duplicate validators being
 * zero is NOT sufficient (spec: "A legally safe but empty itinerary is not
 * acceptable"). Fails only on the UNJUSTIFIED shape — a normal/day-trip day
 * with no meaningful real content at all when nothing structural explains
 * it. A trip with genuinely justified light days (arrival/departure/
 * transfer/explicit rest) always passes regardless of how many of those
 * exist.
 */
export function passesQualityValidation(report: ItineraryQualityReport): boolean {
  return report.unjustifiedDaysWithOnlySyntheticContent === 0;
}

/** Round 9.3.5 §17 — one row per stay in the coverage-failure diagnostic, so "X/Y days empty despite Z candidates" is never trip-wide-only again; distinguishes "one stay has no supply" from "every stay has supply but composer underuses it" at a glance. */
export interface StayCoverageSummary {
  stayId: string;
  owner: string;
  normalDays: number;
  uncoveredDays: number;
  poolSize: number;
  portfolioSelected: number;
  unusedCandidates: number;
}

/**
 * Round 9.3.6 — the exact `phase.id -> {poolSize, portfolioSelected}` shape
 * `assertRealActivityCoverage`'s `staySupplyContext` expects, extracted so
 * every call site builds it the SAME way instead of hand-rolling an inline
 * `new Map(...)` each time. This was the missing piece at repairPlan's own
 * internal call site: it never built this map at all (no poolsByStay in
 * scope), so `assertRealActivityCoverage` silently defaulted every stay's
 * poolSize/portfolioSelected to 0 via its own `?? 0` fallback — matching a
 * real production trip that showed poolSize: 0 for all 7 stays despite
 * payload.recommendations having 39 real candidates and 16/34 days already
 * carrying real content (the supply was never absent, the diagnostic was
 * blind). Never used to gate/filter anything — purely observational.
 */
export function buildStaySupplyDiagnosticsMap(
  tripFrame: TripFrame,
  poolsByStay: Map<string, StayActivityPool>,
  portfoliosByStay: Map<string, StayActivityPortfolio>
): Map<string, { poolSize: number; portfolioSelected: number; isCatastrophicProviderFailure: boolean }> {
  // Round 9.3.7 §D/§K — buildStayFailureDetails/isCatastrophicallyDiscoveryUnavailable
  // are the SAME confirmed-provider-failure signal assessTripDiscoveryHealth
  // uses; folded in here so assertRealActivityCoverage's own stricter
  // per-stay gate can tell "this stay had a confirmed real provider outage"
  // apart from "this stay's pool is just naturally near-empty" (spec
  // §12A's protected genuine-scarcity case) without a second, parallel
  // classification.
  const catastrophicStayIds = new Set(
    buildStayFailureDetails(poolsByStay)
      .filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay))
      .map((stay) => stay.stayId)
  );
  return new Map(
    tripFrame.phases.map((phase) => [
      phase.id,
      {
        poolSize: poolsByStay.get(phase.id)?.candidates.length ?? 0,
        portfolioSelected: portfoliosByStay.get(phase.id)?.selected.length ?? 0,
        isCatastrophicProviderFailure: catastrophicStayIds.has(phase.id),
      },
    ])
  );
}

/**
 * Round 9.3.6 §14 — `payload.recommendations` mixes real ACTIVITY
 * candidates with real MEAL_VENUE candidates (and, in principle, other
 * non-activity roles), but the coverage gate is asking one specific
 * question: is there enough real ACTIVITY supply to explain why so many
 * days are empty? Counting meal venues toward that number overstates
 * activity supply (a trip-wide pool that is mostly restaurants can pass
 * the "non-trivial pool" gate while genuinely having almost no real
 * ACTIVITY candidates — exactly the kind of silent misclassification spec
 * item 14 flagged), so this splits the trip-wide pool the same
 * classifyActivity/determinePlanningRole way computeTruthfulScheduleMetrics
 * already does for scheduled items, applied here to the CANDIDATE pool
 * instead.
 */
function countRecommendationsByPlanningRole(recommendations: TripRecommendation[]): {
  totalRecommendations: number;
  realActivityRecommendations: number;
  realMealVenueRecommendations: number;
} {
  let realActivityRecommendations = 0;
  let realMealVenueRecommendations = 0;
  for (const rec of recommendations) {
    const classification = classifyActivity({
      category: rec.category,
      name: rec.name,
      shortDescription: rec.shortDescription,
    });
    if (determinePlanningRole(rec.category, classification) === "MEAL_VENUE") {
      realMealVenueRecommendations += 1;
    } else {
      realActivityRecommendations += 1;
    }
  }
  return { totalRecommendations: recommendations.length, realActivityRecommendations, realMealVenueRecommendations };
}

export class InsufficientRealActivityCoverageError extends Error {
  readonly code = "INSUFFICIENT_REAL_ACTIVITY_COVERAGE" as const;
  readonly report: ItineraryQualityReport;
  readonly diagnostics: {
    normalDayCount: number;
    unjustifiedZeroRealDayNumbers: number[];
    /** Round 9.3.6 §14 — now the real-ACTIVITY-only count (meal venues and other non-activity roles excluded), never the raw trip-wide recommendation total; see totalRecommendations for that. */
    recommendationPoolSize: number;
    /** Round 9.3.6 §14 — the raw, unfiltered size of payload.recommendations, kept alongside recommendationPoolSize so a caller can see how much of the trip-wide pool was actually activity-eligible. */
    totalRecommendations: number;
    /** Round 9.3.6 §14 — how many of totalRecommendations were real MEAL_VENUE candidates, never counted as activity coverage supply. */
    realMealVenueRecommendations: number;
    /** Round 9.3.5 §17 — omitted only when the caller has no per-stay pool/portfolio data to report (the deterministic-fallback-template call site, which never built one). */
    stays?: StayCoverageSummary[];
  };
  constructor(report: ItineraryQualityReport, diagnostics: InsufficientRealActivityCoverageError["diagnostics"]) {
    super(
      `Insufficient real-activity coverage: ${diagnostics.unjustifiedZeroRealDayNumbers.length}/${diagnostics.normalDayCount} normal days have no real content despite ${diagnostics.recommendationPoolSize} real-activity candidates loaded (${diagnostics.totalRecommendations} total recommendations, ${diagnostics.realMealVenueRecommendations} of them meal venues).`
    );
    this.name = "InsufficientRealActivityCoverageError";
    this.report = report;
    this.diagnostics = diagnostics;
  }
}

/**
 * Round 8 spec §12 — "a failed generation is preferable to a useless
 * itinerary pretending to be complete." Deliberately conservative: only
 * throws when the shape is unambiguous — a MAJORITY of normal days have
 * zero meaningful real content with no structural excuse, AND the provider
 * pool was demonstrably non-trivial (so this is a planning failure, not
 * genuine destination scarcity, which degrades silently instead per spec
 * §12A). Never called for the deterministic template fallback path (which
 * legitimately may have few/no real candidates).
 */
/**
 * Round 9.3 §16 — the ratio check above is gated on a non-trivial
 * `payload.recommendations` pool (a genuine destination-scarcity signal,
 * spec §12A) — but Round 9.2 made `payload.recommendations` start EMPTY
 * for every normal wizard trip (the client no longer pre-fetches it), so
 * that gate alone can no longer catch the exact catastrophic shape this
 * round's real 42-day US replay produced (one phase whose OWN area is the
 * country itself, ~100% unjustified-empty days). `tripFrameContext` below
 * adds the ONE unconditional, pool-size-independent signal for that exact
 * shape: a country-level single stay is never legitimate scarcity — a
 * real city/region always exists regardless of how many candidates were
 * found for it.
 */
export function assertRealActivityCoverage(
  report: ItineraryQualityReport,
  payload: Pick<AiItineraryRequest, "recommendations">,
  /** Round 9.3 §16/§7 — when supplied, a single phase whose own area IS the destination country (never resolved to a real local stay) is itself treated as catastrophic for any trip long enough that a genuine single-country-wide base is implausible (matches needsStaySkeleton's own bucket-free reasoning: this is about the SHAPE of the failure, not a day-count constant). */
  tripFrameContext?: { tripFrame: TripFrame; countryName: string },
  /** Round 9.3.5 §17 — per-stay pool/portfolio sizes, when the caller has them (the composed path always does), so a thrown failure names exactly which stays own the uncovered days instead of only a trip-wide total. */
  staySupplyContext?: Map<string, { poolSize: number; portfolioSelected: number; isCatastrophicProviderFailure?: boolean }>,
  /** Round 9.4.2 §G — purely reported in RealPlaceContentLostError's own diagnostics, never affects the throw decision itself. */
  fallbackUsed = false
): void {
  const normalDays = report.perDay.filter((day) => day.dayType === "normal");
  if (normalDays.length === 0) return;
  const unjustified = normalDays.filter((day) => day.onlySyntheticContent && !day.justifiedLight);
  const { totalRecommendations, realActivityRecommendations, realMealVenueRecommendations } = countRecommendationsByPlanningRole(
    payload.recommendations
  );
  const recommendationPoolSize = realActivityRecommendations;
  const unjustifiedRatio = unjustified.length / normalDays.length;
  const MIN_POOL_TO_EXPECT_COVERAGE = 10;
  const MAJORITY_FAILURE_RATIO = 0.5;

  // Unconditional (never excused by a small recommendation pool, spec §7):
  // a single phase whose OWN area is literally the destination country,
  // for a trip too long to plausibly be one genuine country-wide base —
  // this is a structural planning failure, not scarcity. A real city/
  // region always exists regardless of how many candidates were found for
  // it, so "the pool was tiny" is never a legitimate excuse for this shape.
  const isCountryLevelSingleStay =
    tripFrameContext != null &&
    tripFrameContext.tripFrame.phases.length === 1 &&
    normalizeAreaLabel(tripFrameContext.tripFrame.phases[0].areaLabel) === normalizeAreaLabel(tripFrameContext.countryName) &&
    normalDays.length > TRIP_LENGTH_BUCKETS.find((b) => b.id === "single_base")!.maxDays!;

  // The plain ratio-based ceiling stays gated on a non-trivial pool (spec
  // §12A's own "genuine destination scarcity degrades silently") — a tiny
  // real pool (e.g. 1 candidate for a remote destination) can legitimately
  // still leave 100% of normal days empty; that's Round 8 J's own
  // established, deliberately-preserved case, untouched here.
  const isMajorityFailure = recommendationPoolSize >= MIN_POOL_TO_EXPECT_COVERAGE && unjustifiedRatio > MAJORITY_FAILURE_RATIO;

  // Round 9.3.7 §D/§K — computed whenever the caller has a TripFrame,
  // regardless of whether the TRIP-WIDE ratio above already trips: a
  // single provider-failed stay can legitimately be a small fraction of a
  // large multi-stay trip (never triggering the >50% trip-wide gate) while
  // STILL leaving every one of ITS OWN normal sightseeing days entirely
  // synthetic — silently accepted as "successful" would be exactly the
  // "all-FreeTime stay counted as real" outcome spec item K forbids.
  // Deliberately narrower than "poolSize === 0": requires
  // isCatastrophicProviderFailure specifically (a CONFIRMED real provider
  // outage, from buildStaySupplyDiagnosticsMap), never a genuinely tiny/
  // empty pool caused by ordinary destination scarcity (spec §12A's own
  // protected "degrades silently" case, Round 8 J) — and gated strictly on
  // staySupplyContext being ACTUALLY PROVIDED (never inferred from its
  // absence, or every pre-existing caller that omits it would newly and
  // incorrectly throw here).
  let stays: StayCoverageSummary[] | undefined;
  let isAnyStayFullyUnrecoverable = false;
  if (tripFrameContext) {
    const byPhase = new Map<string, { owner: string; normalDays: number; uncoveredDays: number }>();
    for (const day of normalDays) {
      const phase = findFramePhaseForDay(tripFrameContext.tripFrame, day.dayNumber);
      if (!phase) continue;
      const entry = byPhase.get(phase.id) ?? { owner: phase.areaLabel, normalDays: 0, uncoveredDays: 0 };
      entry.normalDays += 1;
      if (day.onlySyntheticContent && !day.justifiedLight) entry.uncoveredDays += 1;
      byPhase.set(phase.id, entry);
    }
    stays = [...byPhase.entries()].map(([stayId, entry]) => {
      const supply = staySupplyContext?.get(stayId);
      const poolSize = supply?.poolSize ?? 0;
      const portfolioSelected = supply?.portfolioSelected ?? 0;
      return {
        stayId,
        owner: entry.owner,
        normalDays: entry.normalDays,
        uncoveredDays: entry.uncoveredDays,
        poolSize,
        portfolioSelected,
        unusedCandidates: Math.max(0, poolSize - portfolioSelected),
      };
    });
    if (staySupplyContext) {
      isAnyStayFullyUnrecoverable = [...byPhase.entries()].some(([stayId, entry]) => {
        const supply = staySupplyContext.get(stayId);
        return supply != null && supply.isCatastrophicProviderFailure === true && entry.normalDays > 0 && entry.uncoveredDays === entry.normalDays;
      });
    }
  }

  // Round 9.4.2 §G — the regression firewall, checked BEFORE (and
  // independently of) the ratio-based majority-failure logic above: a
  // non-trivial real candidate pool existed (the SAME >=10 threshold
  // isMajorityFailure already uses, preserving the established spec
  // §12A "genuine scarcity degrades silently" precedent — this is never
  // "totalRealActivityCandidates > 0" literally, which would break every
  // existing small-pool test) and the FINAL itinerary has LITERALLY zero
  // scheduled real activities across every normal day. This is
  // deliberately UNCONDITIONAL on the ratio math above: the proven
  // production case (traceId gen-mu7ihdq8-545bii8p) reached persistence
  // with recommendationPoolSize well over 10 and realActivities===0
  // WITHOUT this coverage check ever throwing — an edge case in the
  // ratio/majority judgment call that this direct, unconditional check
  // exists specifically to backstop.
  const finalRealActivityCount = normalDays.reduce((sum, day) => sum + day.meaningfulRealActivityCount, 0);
  const isTotalRealPlaceLoss = recommendationPoolSize >= MIN_POOL_TO_EXPECT_COVERAGE && finalRealActivityCount === 0;

  if (isTotalRealPlaceLoss) {
    throw new RealPlaceContentLostError(
      `Real-place content was completely lost: ${recommendationPoolSize} real activity candidates existed but the final itinerary scheduled zero across ${normalDays.length} normal days.`,
      {
        totalRealActivityCandidates: recommendationPoolSize,
        finalRealActivities: 0,
        normalDayCount: normalDays.length,
        fallbackUsed,
        perStay: stays,
      }
    );
  }

  if (isCountryLevelSingleStay || isMajorityFailure || isAnyStayFullyUnrecoverable) {
    throw new InsufficientRealActivityCoverageError(report, {
      normalDayCount: normalDays.length,
      unjustifiedZeroRealDayNumbers: unjustified.map((day) => day.dayNumber),
      recommendationPoolSize,
      totalRecommendations,
      realMealVenueRecommendations,
      stays,
    });
  }
}

/**
 * Round 8 — repair order §5/§6/§8: for a day below its meaningful-real
 * minimum, pull UNUSED, LEGAL real candidates from the pool ALREADY LOADED
 * for this owner/stay (pickReplacementRecommendation already applies the
 * geography filter, dedup-against-usageState, and category/proximity
 * ranking) and use them to DEMOTE synthetic filler back into real content —
 * never appended past the day's real capacity, never reusing a globally-
 * used place. Provider network refill (spec §6 steps 2-3 — fetching MORE
 * candidates for the same owner when the loaded pool itself is too thin) is
 * a documented gap: this function only ever draws from
 * `payload.recommendations` as already loaded by the caller.
 */
export function backfillRealActivities(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  arrivalDepartureWindow: ArrivalDepartureWindow | null,
  /**
   * Round 9 §21/§22 — when the caller has already built per-stay portfolios
   * (buildTripActivityPortfolios), this is now a LAST-resort quality
   * repair, not the primary mechanism: an unused portfolio candidate (the
   * planner's own deliberately-selected, diversity-scored content) is tried
   * BEFORE ever falling back to a raw pickReplacementRecommendation scan of
   * the whole payload pool. Omitted entirely, this behaves exactly as
   * Round 8 did (pool-only) — no behavior change for any existing caller.
   */
  portfoliosByStay?: Map<string, StayActivityPortfolio>
): { days: AiGeneratedDay[]; insertions: Array<{ dayNumber: number; itemName: string; reason: "portfolio" | "pool" }> } {
  const usageState = buildItineraryUsageState(days);
  const insertions: Array<{ dayNumber: number; itemName: string; reason: "portfolio" | "pool" }> = [];
  const recommendationsById = new Map(payload.recommendations.map((r) => [r.id, r]));

  const nextDays = days.map((day) => {
    const dayType = deriveDayType(day, tripFrame, arrivalDepartureWindow);
    // Only normal/day_trip days are backfilled — arrival/departure/transfer
    // days having zero real content is structurally expected (spec §3) and
    // never force-filled.
    if (dayType !== "normal" && dayType !== "day_trip") return day;
    const hasExplicitRestWindow = Boolean(day.restWindow && day.restWindow.trim());
    const minimumRequired = minimumMeaningfulRealActivities(dayType, hasExplicitRestWindow);

    let mutableDay = day;
    let meaningfulCount = day.items.filter((item) => isMeaningfulRealActivity(item)).length;
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const stayAnchor = phase ? (areaAnchors.get(phase.areaLabel) ?? null) : null;
    const portfolio = phase ? portfoliosByStay?.get(phase.id) : undefined;

    // Round 9.3.3 continuation §2 — "REAL-BEFORE-FREETIME": the ORIGINAL
    // gate here (`meaningfulCount < minimumRequired`) only topped a day up
    // to its historical minimum, so a day that already reached that
    // minimum could still carry a free_time item sitting on an
    // activity-anchor slot while its own stay's portfolio had a further
    // legal, unused real candidate available — that candidate was simply
    // never used. The second disjunct below closes that gap: as long as
    // the day still has a free_time-role item occupying a slot, keep
    // trying to replace it with real supply, past the minimum, UNTIL
    // supply is genuinely exhausted (the loop's own `!rawReplacement
    // break` below, unchanged) or the day is a deliberate rest/flex day
    // (`hasExplicitRestWindow`), which is explicitly exempted — a user who
    // asked for flexibility there keeps it, this never overrides that.
    let attempts = 0;
    while (
      (meaningfulCount < minimumRequired ||
        (!hasExplicitRestWindow && mutableDay.items.some((item) => item.itemRole === "free_time"))) &&
      attempts < 6
    ) {
      attempts += 1;
      // Prefer demoting an existing synthetic filler (free_time, or a
      // coordinate-less generic meal placeholder is left alone — meals stay
      // meals); fall back to the day's own template item so
      // pickReplacementRecommendation still has a slot/area/anchor to work
      // from when the day has no synthetic filler to reclaim.
      const syntheticTarget =
        mutableDay.items.find((item) => item.itemRole === "free_time") ??
        buildInsertionTemplateItem(mutableDay);

      // Round 9 §21 step 1: an unused, legal portfolio candidate (selected,
      // then optional) — the planner's own deliberate, diversity-scored
      // choice — beats a fresh raw-pool scan.
      let candidateRecommendation: AiItineraryRequest["recommendations"][number] | null = null;
      let reason: "portfolio" | "pool" = "pool";
      if (portfolio) {
        for (const poolCandidate of [...portfolio.selected, ...portfolio.optional]) {
          if (isItineraryPlaceUsed(usageState, { id: poolCandidate.recommendationId, name: poolCandidate.name, lat: poolCandidate.lat, lon: poolCandidate.lon })) continue;
          const full = recommendationsById.get(poolCandidate.recommendationId);
          if (!full) continue;
          candidateRecommendation = full;
          reason = "portfolio";
          break;
        }
      }
      const rawReplacement =
        candidateRecommendation ??
        pickReplacementRecommendation({
          traceSource: "quality_backfill",
          payload,
          day: mutableDay,
          item: syntheticTarget,
          profile,
          usageState,
          replacementMode: "non_food",
          stayAreaAnchor: stayAnchor,
          maxDistanceKm: mobilityProfile.localityRadiusKm,
        });
      if (!rawReplacement) break; // pool exhausted — never widen to a distant region, never reuse a used place

      const candidateItem = buildReplacementItem(rawReplacement, syntheticTarget, mutableDay, payload);
      // Defense in depth: re-verify BOTH axes Round 6/7 already gate on —
      // a backfilled item must never itself become the next regression.
      const legal = evaluateScheduledPlaceLegality({
        placeLat: candidateItem.lat,
        placeLon: candidateItem.lon,
        dayType,
        stayAnchor,
        mobilityProfile,
        dailyCapacityMinutes: deriveDailyCapacityMinutes(payload.preferences.tripPace),
        visitMinutes: candidateItem.estimatedDurationMinutes,
      }).legal;
      if (!legal) {
        // A portfolio pick that turns out illegal here (e.g. stale
        // ownership) never blocks the pool fallback — try again next
        // iteration, which re-scans the (now-excluded) portfolio first.
        if (reason === "portfolio") {
          registerItineraryUsage(usageState, candidateItem); // mark it used-and-rejected so it isn't retried forever
          releaseItineraryUsage(usageState, candidateItem);
          continue;
        }
        break;
      }

      const isReplacingSynthetic = mutableDay.items.includes(syntheticTarget) && syntheticTarget.itemRole === "free_time";
      const nextItems = isReplacingSynthetic
        ? mutableDay.items.map((entry) => (entry === syntheticTarget ? candidateItem : entry))
        : [...mutableDay.items, candidateItem];

      registerItineraryUsage(usageState, candidateItem);
      mutableDay = fillDerivedDayFields(resequenceDayItems({ ...mutableDay, items: nextItems }), payload, profile);
      const ohStatus = evaluateItemOpeningHoursLegality(
        mutableDay.items.find((entry) => entry.name === candidateItem.name) ?? candidateItem,
        mutableDay.date
      ).status;
      if (isKnownHoursViolation(ohStatus)) {
        // The exact slot scheduleDayItems gave it doesn't fit its hours —
        // undo rather than hand the next stage a fresh violation.
        releaseItineraryUsage(usageState, candidateItem);
        mutableDay = isReplacingSynthetic
          ? fillDerivedDayFields(resequenceDayItems({ ...mutableDay, items: mutableDay.items.map((entry) => (entry === candidateItem ? syntheticTarget : entry)) }), payload, profile)
          : fillDerivedDayFields(resequenceDayItems({ ...mutableDay, items: mutableDay.items.filter((entry) => entry !== candidateItem) }), payload, profile);
        continue;
      }

      meaningfulCount += 1;
      insertions.push({ dayNumber: day.dayNumber, itemName: candidateItem.name, reason });
    }

    return mutableDay;
  });

  return { days: nextDays, insertions };
}

/**
 * Round 9.3.3 continuation §4 — "REAL-MEAL-BEFORE-MEALOPPORTUNITY": the
 * meal analogue of backfillRealActivities just above. insertMealsFromPool
 * already prefers a real StayMealVenuePool candidate over a synthetic
 * MealOpportunity DURING initial composition, but until now nothing ever
 * revisited that choice later — a MealOpportunity scheduled because the
 * pool looked exhausted (or wasn't built yet at that point in the
 * pipeline) stayed a MealOpportunity forever, even once
 * finalizeArrivalDepartureContent rebuilds a fresh, fuller pool from the
 * FINAL candidate set. This tries, for every already-scheduled
 * MealOpportunity, to replace it with a real venue from that fresh
 * pool — reusing selectMealVenueFromPool/buildSupplementalMealItem
 * unchanged (no cuisine-logic redesign), gated by the exact same
 * geography/meal-type/timing/collision constraints insertMealsFromPool
 * already enforces, and never double-booking a venue already used
 * anywhere else in the trip.
 */
export function backfillRealMealVenues(
  days: AiGeneratedDay[],
  tripFrame: TripFrame,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  mealPoolsByStay: Map<string, StayMealVenuePool>,
  dayCount?: number,
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
): { days: AiGeneratedDay[]; insertions: Array<{ dayNumber: number; itemName: string }> } {
  const usedMealRecommendationIds = new Set<string>();
  const usedMealNames = new Set<string>();
  for (const day of days) {
    for (const item of day.items) {
      if (isFoodItem(item.category) && !isGenericMealOpportunity(item)) {
        if (item.recommendationId) usedMealRecommendationIds.add(item.recommendationId);
        usedMealNames.add(item.name.trim().toLowerCase());
      }
    }
  }
  const recentMealHistory: RecentMealHistoryEntry[] = [];
  const cuisineWeights = buildCuisinePreferenceWeights([...profile.strongPreferences, ...profile.softPreferences]);
  const insertions: Array<{ dayNumber: number; itemName: string }> = [];

  const nextDays = days.map((day) => {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    const mealPool = phase ? mealPoolsByStay.get(phase.id) : undefined;
    if (!mealPool || mealPool.venues.length === 0) return day;

    const isArrivalDay = dayCount != null && day.dayNumber === 1;
    const isDepartureDay = dayCount != null && day.dayNumber === dayCount;
    let mutableDay = day;

    for (const opportunity of mutableDay.items.filter((item) => isGenericMealOpportunity(item))) {
      const slot: DayPart = opportunity.category === "cafe" ? "lunch" : "dinner";
      const isFeasible = hasUsableGapForMeal(
        mutableDay,
        slot === "lunch" ? LUNCH_WINDOW_MINUTES : DINNER_WINDOW_MINUTES,
        isArrivalDay,
        isDepartureDay,
        arrivalDepartureWindow ?? null
      );
      if (arrivalDepartureWindow && !isFeasible) continue;

      const { anchor, nextAnchor } = getRelevantMealAnchors(mutableDay, slot);
      const best = selectMealVenueFromPool(
        mealPool,
        {
          mealType: slot === "lunch" ? "LUNCH" : "DINNER",
          anchor,
          nextAnchor,
          pace: payload.preferences.tripPace,
          transportation: payload.preferences.transportationPreferences || mutableDay.transportation || "תחבורה מקומית",
          recentHistory: recentMealHistory,
          dayIndex: mutableDay.dayNumber,
          cuisineWeights,
          usedRecommendationIds: usedMealRecommendationIds,
        },
        profile
      );
      const fullRecommendation = best ? payload.recommendations.find((r) => r.id === best.candidate.recommendationId) ?? null : null;
      if (!best || !fullRecommendation) continue; // pool genuinely has nothing more usable — the MealOpportunity stays, honestly

      const realItem = buildSupplementalMealItem(fullRecommendation, slot, mutableDay, payload);
      mutableDay = {
        ...mutableDay,
        items: mutableDay.items.map((entry) => (entry === opportunity ? realItem : entry)),
      };
      usedMealRecommendationIds.add(best.candidate.recommendationId);
      usedMealNames.add(fullRecommendation.name.trim().toLowerCase());
      recentMealHistory.push({
        dayIndex: mutableDay.dayNumber,
        mealType: slot === "lunch" ? "LUNCH" : "DINNER",
        cuisineFamilies: best.candidate.classification.cuisineFamilies,
        cuisineSubtypes: best.candidate.classification.cuisineSubtypes,
      });
      insertions.push({ dayNumber: mutableDay.dayNumber, itemName: realItem.name });
    }

    return mutableDay.items === day.items ? day : fillDerivedDayFields(resequenceDayItems(mutableDay), payload, profile);
  });

  return { days: nextDays, insertions };
}

/* ================================================================== *
 * Round 9.2 — INITIAL day composition FROM the stay activity portfolio *
 * (spec "THE STAY ACTIVITY PORTFOLIO MUST BECOME THE AUTHORITATIVE     *
 * INPUT FOR INITIAL DAY CONSTRUCTION") — this is no longer a repair    *
 * layer bolted on after the fact (Round 8/9's backfillRealActivities   *
 * remains, but only as the EXCEPTIONAL safety net spec §10 asks for);  *
 * this function is what actually DECIDES a healthy day's real content *
 * before anything else runs.                                          *
 * ================================================================== */

export interface ComposedPortfolioPlan {
  plan: AiItineraryResponse;
  /** Every real activity this composer itself placed — the metric spec §12 wants to dominate backfilledRealActivities for a healthy trip. */
  initialRealActivitiesScheduled: number;
}

/** Round 9.2 §8 — within-day-assignment geographic cohesion: candidates near what's ALREADY chosen today score higher, so diversity never creates inefficient zig-zag travel. Worldwide/generic — plain distance, no place names, no country-specific constant. */
const GEOGRAPHIC_COHESION_BONUS_KM = 15;
/** Round 9.2 §7 — a mild same-day family-repetition nudge (e.g. two museums the same morning), independent of the trip-wide recency penalty (computeRecencyPenalty) which looks at OTHER days. */
const SAME_DAY_FAMILY_REPEAT_PENALTY = 6;

/** Exported for direct unit testing (Round 9.2) — isolates the trip-wide
 * recency term from the same-day family and geographic-cohesion terms,
 * since a full composeDaysFromStayPortfolios run can't reliably isolate it:
 * selectStayPortfolio already diversifies WHICH candidates make it into
 * `.selected`, so a fixture built only from full composition can pass even
 * with this function's own recency penalty removed. */
export function scoreCandidateForDayAssignment(
  candidate: StayActivityPoolCandidate,
  recentHistory: RecentActivityHistoryEntry[],
  dayNumber: number,
  todaysChosen: StayActivityPoolCandidate[]
): number {
  let score = candidate.significance;
  score -= computeRecencyPenalty(candidate.classification, recentHistory, dayNumber);

  const sameFamilyToday = todaysChosen.filter((c) => c.classification.primaryFamily === candidate.classification.primaryFamily).length;
  score -= SAME_DAY_FAMILY_REPEAT_PENALTY * sameFamilyToday;

  if (candidate.lat != null && candidate.lon != null) {
    const distancesKm = todaysChosen
      .filter((c): c is StayActivityPoolCandidate & { lat: number; lon: number } => c.lat != null && c.lon != null)
      .map((c) => haversineKm(c.lat, c.lon, candidate.lat as number, candidate.lon as number));
    if (distancesKm.length > 0) {
      const avgDistanceKm = distancesKm.reduce((sum, km) => sum + km, 0) / distancesKm.length;
      score += Math.max(0, GEOGRAPHIC_COHESION_BONUS_KM - avgDistanceKm);
    }
  }
  return score;
}

function buildEmptyComposedDay(dayNumber: number, date: string, cityRegion: string): AiGeneratedDay {
  return {
    dayNumber,
    date,
    title: "",
    cityRegion,
    theme: "",
    accommodation: "",
    notes: "",
    transportation: "",
    estimatedCost: null,
    activityCost: null,
    foodCost: null,
    transportCost: null,
    accommodationCost: null,
    totalTravelMinutes: null,
    warnings: [],
    alternatives: [],
    bookingRequirements: [],
    safetyNotes: [],
    restWindow: "",
    transportSegments: [],
    items: [],
  };
}

/**
 * Round 9.3 §11 — the composer's OWN meal insertion, consuming a literal
 * StayMealVenuePool via selectMealVenueFromPool — no second inline pseudo-
 * pool. Falls back to the pre-Round-9.3 insertMissingMeals machinery only
 * when no real pool exists for this stay (e.g. a caller that hasn't built
 * one yet, or a stay with genuinely zero meal-venue supply at all) so this
 * never regresses a day to having no meal at all.
 */
function insertMealsFromPool(
  day: AiGeneratedDay,
  mealPool: StayMealVenuePool | undefined,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>,
  usedMealRecommendationIds: Set<string>,
  recentMealHistory: RecentMealHistoryEntry[],
  cuisineWeights: Record<CuisineFamily, number>,
  dayCount?: number,
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
): AiGeneratedDay {
  if (!mealPool || mealPool.venues.length === 0) {
    return insertMissingMeals(day, payload, profile, usedMealNames, dayCount, arrivalDepartureWindow, recentMealHistory, cuisineWeights);
  }

  let nextDay = day;
  const isArrivalDay = dayCount != null && day.dayNumber === 1;
  const isDepartureDay = dayCount != null && day.dayNumber === dayCount;
  const lunchIsFeasible = !arrivalDepartureWindow || hasUsableGapForMeal(nextDay, LUNCH_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);
  const dinnerIsFeasible = !arrivalDepartureWindow || hasUsableGapForMeal(nextDay, DINNER_WINDOW_MINUTES, isArrivalDay, isDepartureDay, arrivalDepartureWindow);

  for (const missingMealSlot of findMissingMealSlots(nextDay.items)) {
    if (missingMealSlot === "lunch" && !lunchIsFeasible) continue;
    if (missingMealSlot === "dinner" && !dinnerIsFeasible) continue;

    const { anchor, nextAnchor } = getRelevantMealAnchors(nextDay, missingMealSlot);
    const mealType: MealType = missingMealSlot === "dinner" ? "DINNER" : "LUNCH";
    const best = selectMealVenueFromPool(
      mealPool,
      {
        mealType,
        anchor,
        nextAnchor,
        pace: payload.preferences.tripPace,
        transportation: payload.preferences.transportationPreferences || nextDay.transportation || "תחבורה מקומית",
        recentHistory: recentMealHistory,
        dayIndex: day.dayNumber,
        cuisineWeights,
        usedRecommendationIds: usedMealRecommendationIds,
      },
      profile
    );
    const fullRecommendation = best ? payload.recommendations.find((r) => r.id === best.candidate.recommendationId) ?? null : null;

    const nextMealItem = fullRecommendation
      ? buildSupplementalMealItem(fullRecommendation, missingMealSlot, nextDay, payload)
      : buildFallbackMealPlaceholder(nextDay, missingMealSlot, payload, usedMealNames);

    if (best && fullRecommendation) {
      usedMealRecommendationIds.add(best.candidate.recommendationId);
      usedMealNames.add(fullRecommendation.name.trim().toLowerCase());
      recentMealHistory.push({
        dayIndex: day.dayNumber,
        mealType,
        cuisineFamilies: best.candidate.classification.cuisineFamilies,
        cuisineSubtypes: best.candidate.classification.cuisineSubtypes,
      });
    }

    if (nextMealItem && nextMealItem.name) {
      nextDay = { ...nextDay, items: [...nextDay.items, nextMealItem] };
    }
  }
  return nextDay;
}

/**
 * Round 9.2 — THE deterministic, portfolio-driven initial day composer.
 * Produces a COMPLETE AiItineraryResponse directly from
 * StayActivityPool/StayActivityPortfolio data — no Gemini call required
 * (spec §5: "Gemini must not be required... the deterministic planner
 * must be capable of constructing the itinerary directly from
 * StayActivityPortfolios"). Real anchors are assigned to normal/day_trip
 * days FIRST (spec §6), scored by significance, trip-wide diversity decay
 * (computeRecencyPenalty — the SAME function selectStayPortfolio itself
 * uses, spec §7: "do not merely select a diverse portfolio and then
 * distribute it badly"), same-day family repetition, and geographic
 * cohesion (spec §8) — never a hard ban, always a soft score. Meals and
 * free time are added afterward via the SAME existing machinery
 * (insertMissingMeals, resequenceDayItems's own free-time filler) — never
 * reinvented. `portfolio.optional` is drawn from only once `.selected` is
 * exhausted for a stay (spec §9: the reserve stays unused otherwise).
 */
export function composeDaysFromStayPortfolios(
  tripFrame: TripFrame,
  dayCount: number,
  arrivalDepartureWindow: ArrivalDepartureWindow,
  poolsByStay: Map<string, StayActivityPool>,
  portfoliosByStay: Map<string, StayActivityPortfolio>,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /**
   * Round 9.3 §11 — the composer's own meal source. When a real, non-empty
   * pool exists for a stay, meal selection consumes it LITERALLY
   * (selectMealVenueFromPool) — no second inline pseudo-pool. Optional and
   * defaulted to an empty Map ONLY so every pre-Round-9.3 test/caller that
   * never built one keeps compiling and falls back to the existing
   * insertMissingMeals machinery (itself already classification-correct
   * since Round 9.2.1) — production always passes a real one now.
   */
  mealPoolsByStay: Map<string, StayMealVenuePool> = new Map()
): ComposedPortfolioPlan {
  const recommendationsById = new Map(payload.recommendations.map((recommendation) => [recommendation.id, recommendation]));
  const dayTypesByStay = estimatePreGenerationDayTypesByStay(tripFrame, dayCount, arrivalDepartureWindow);
  const dayTypeByDayNumber = new Map<number, StayDayCapacityInput>();
  // Every normal/day_trip day number for a given stay, ascending — used
  // below to PACE portfolio consumption across the whole stay (a real bug
  // found writing this function's own tests: a stay whose pool was thinner
  // than `target × stayDays` got its portfolio fully drained by the middle
  // of the stay, leaving its LAST day with zero real content even though
  // the pool was never actually empty at the trip level — just spent
  // unevenly). Never a hardcoded per-day count; always derived from
  // however many normal/day_trip days this specific stay actually has.
  const normalDayNumbersByStay = new Map<string, number[]>();
  for (const [stayId, list] of dayTypesByStay) {
    normalDayNumbersByStay.set(
      stayId,
      list.filter((entry) => entry.dayType === "normal" || entry.dayType === "day_trip").map((entry) => entry.dayNumber)
    );
    for (const entry of list) dayTypeByDayNumber.set(entry.dayNumber, entry);
  }

  const usedCandidateIds = new Set<string>();
  let recentHistory: RecentActivityHistoryEntry[] = [];
  const usedMealNames = new Set<string>();
  const usedMealRecommendationIds = new Set<string>();
  const recentMealHistory: RecentMealHistoryEntry[] = [];
  const cuisineWeights = buildCuisinePreferenceWeights([...profile.strongPreferences, ...profile.softPreferences]);
  let initialRealActivitiesScheduled = 0;
  const days: AiGeneratedDay[] = [];

  // Round 9.4 §K — logged once per stay, before composition consumes
  // anything, so CompositionOutput below can be read as "what changed",
  // not just an isolated final count.
  if (isPlannerQaTraceEnabled()) {
    for (const [stayId, dayNumbers] of normalDayNumbersByStay) {
      const portfolio = portfoliosByStay.get(stayId);
      const mealPool = mealPoolsByStay.get(stayId);
      logRealPlaceQA("CompositionInput", {
        stayId,
        normalDays: dayNumbers.length,
        portfolioSelected: portfolio?.selected.length ?? 0,
        portfolioReserve: portfolio?.optional.length ?? 0,
        mealPoolSize: mealPool?.venues.length ?? 0,
      });
    }
  }

  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const phase = findFramePhaseForDay(tripFrame, dayNumber);
    const dayType: DerivedDayType = dayTypeByDayNumber.get(dayNumber)?.dayType ?? "normal";
    const date = dateForDayNumber(payload.preferences.startDate, dayNumber) || payload.preferences.startDate;

    let day = buildEmptyComposedDay(dayNumber, date, phase?.areaLabel ?? "");

    // Real anchors FIRST (spec §6) — only on normal/day_trip days, the same
    // gate backfillRealActivities already uses (arrival/departure/transfer
    // having zero real content at THIS stage is structurally expected;
    // Round 8's exceptional backfill can still add one later if capacity
    // genuinely allows).
    if (phase && (dayType === "normal" || dayType === "day_trip")) {
      const portfolio = portfoliosByStay.get(phase.id);
      const rawTarget = Math.max(1, Math.round(estimateDayActivityTarget({ dayNumber, dayType, hasExplicitRestWindow: false })));
      // Pace consumption across the REST of this stay's own normal/day_trip
      // days (this one included) so a thin-relative-to-target portfolio is
      // spread evenly rather than front-loaded, leaving a later day empty.
      const remainingStayDayNumbers = (normalDayNumbersByStay.get(phase.id) ?? []).filter((d) => d >= dayNumber);
      const remainingUnusedSupply = portfolio
        ? portfolio.selected.filter((c) => !usedCandidateIds.has(c.recommendationId)).length +
          portfolio.optional.filter((c) => !usedCandidateIds.has(c.recommendationId)).length
        : 0;
      const fairShare = remainingStayDayNumbers.length > 0 ? Math.round(remainingUnusedSupply / remainingStayDayNumbers.length) : rawTarget;
      // fairShare can legitimately be 0 when supply for this stay is
      // already exhausted — the loop below still breaks correctly via its
      // own `available.length === 0` check regardless of `target`'s value,
      // so clamping the floor to 1 here never causes an incorrect
      // over-assignment.
      const target = Math.max(1, Math.min(rawTarget, fairShare));
      const todaysChosen: StayActivityPoolCandidate[] = [];

      while (portfolio && todaysChosen.length < target) {
        const unused = (bucket: StayActivityPoolCandidate[]) => bucket.filter((c) => !usedCandidateIds.has(c.recommendationId));
        const fromSelected = unused(portfolio.selected);
        const available = fromSelected.length > 0 ? fromSelected : unused(portfolio.optional);
        if (available.length === 0) break;

        let best = available[0];
        let bestScore = -Infinity;
        for (const candidate of available) {
          const score = scoreCandidateForDayAssignment(candidate, recentHistory, dayNumber, todaysChosen);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        const fullRecommendation = recommendationsById.get(best.recommendationId);
        usedCandidateIds.add(best.recommendationId); // never retried this pass either way — a missing lookup is a data-integrity gap, not a reason to loop
        if (!fullRecommendation) continue;

        const template = buildInsertionTemplateItem(day);
        const newItem = buildReplacementItem(fullRecommendation, template, day, payload);
        day = { ...day, items: [...day.items, newItem] };
        todaysChosen.push(best);
        initialRealActivitiesScheduled += 1;
      }

      recentHistory = [
        ...recentHistory,
        ...todaysChosen.map((candidate) => ({
          dayIndex: dayNumber,
          stayId: phase.id,
          primaryFamily: candidate.classification.primaryFamily,
          subtype: candidate.classification.subtype,
        })),
      ];
    }

    // Meals — Round 9.3 §11: the composer's own literal StayMealVenuePool
    // consumer (falls back to insertMissingMeals only when this stay has no
    // real pool at all). Scheduling/free-time filler after that is the SAME
    // existing machinery every other pass in this file already uses.
    day = insertMealsFromPool(day, phase ? mealPoolsByStay.get(phase.id) : undefined, payload, profile, usedMealNames, usedMealRecommendationIds, recentMealHistory, cuisineWeights, dayCount, arrivalDepartureWindow);
    day = fillDerivedDayFields(resequenceDayItems(day), payload, profile);
    days.push(day);
  }

  const plan: AiItineraryResponse = {
    title: `מסלול ל${payload.countryName}`,
    summary: "",
    totalEstimatedCost: null,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days,
  };

  // Round 9.4 §K — did the composer receive real candidates and simply
  // fail to schedule them, or did it never have them to begin with? Grouped
  // by stay so this reconciles directly against the Portfolio/ActivityPool
  // logs above (same phase.id) and the CandidateConservation record below.
  if (isPlannerQaTraceEnabled()) {
    const byStay = new Map<string, { normalDays: number; real: number; realMeals: number; synthetic: number; mealOpportunities: number; freeTime: number; days: Array<{ dayNumber: number; dayType: string; realActivities: number; realMeals: number; freeTime: number; mealOpportunities: number }> }>();
    for (const day of days) {
      const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
      const stayId = phase?.id ?? "unowned";
      const dayType = dayTypeByDayNumber.get(day.dayNumber)?.dayType ?? "normal";
      const entry = byStay.get(stayId) ?? { normalDays: 0, real: 0, realMeals: 0, synthetic: 0, mealOpportunities: 0, freeTime: 0, days: [] };
      let dayReal = 0;
      let dayRealMeals = 0;
      let dayFreeTime = 0;
      let dayMealOpportunities = 0;
      for (const item of day.items) {
        if (isScheduledRealPlace(item)) {
          if (item.category === "restaurant" || item.category === "cafe") dayRealMeals += 1;
          else dayReal += 1;
        } else if (isGenericMealOpportunity(item)) {
          dayMealOpportunities += 1;
        } else if (isSyntheticScheduleItem(item)) {
          dayFreeTime += 1;
        }
      }
      if (dayType === "normal" || dayType === "day_trip") entry.normalDays += 1;
      entry.real += dayReal;
      entry.realMeals += dayRealMeals;
      entry.mealOpportunities += dayMealOpportunities;
      entry.freeTime += dayFreeTime;
      entry.days.push({ dayNumber: day.dayNumber, dayType, realActivities: dayReal, realMeals: dayRealMeals, freeTime: dayFreeTime, mealOpportunities: dayMealOpportunities });
      byStay.set(stayId, entry);
    }
    const usedRealIds = new Set(
      days.flatMap((day) => day.items.filter((item) => isScheduledRealPlace(item) && item.recommendationId).map((item) => item.recommendationId!))
    );
    for (const [stayId, entry] of byStay) {
      const portfolio = portfoliosByStay.get(stayId);
      const unusedSelected = portfolio ? portfolio.selected.filter((c) => !usedRealIds.has(c.recommendationId)).length : undefined;
      const unusedReserve = portfolio ? portfolio.optional.filter((c) => !usedRealIds.has(c.recommendationId)).length : undefined;
      logRealPlaceQA("CompositionOutput", {
        stayId,
        normalDays: entry.normalDays,
        realActivitiesScheduled: entry.real,
        realMealsScheduled: entry.realMeals,
        syntheticActivities: entry.freeTime,
        mealOpportunities: entry.mealOpportunities,
        unusedSelectedCandidates: unusedSelected,
        unusedReserveCandidates: unusedReserve,
        days: entry.days,
      });
    }
  }

  return { plan, initialRealActivitiesScheduled };
}

/* ================================================================== *
 * Round 9.2 — OPTIONAL Gemini refinement of an already-composed plan.  *
 * ID-only contract (spec §3/§4): Gemini receives ONLY stable           *
 * candidateIds already validated/scheduled by composeDaysFromStay-     *
 * Portfolios, never a raw country-wide list, and may not invent a new  *
 * name/coordinate/category for anything. It may only:                 *
 *   - reorder a day's ALREADY-scheduled candidates (never move one     *
 *     across days — that is deliberately out of scope this round, a   *
 *     disclosed gap, not a "Gemini determines real content" risk)      *
 *   - swap ONE scheduled candidate for ONE of that SAME stay's own     *
 *     reserve candidates                                               *
 * Every returned id is re-validated against the ORIGINAL portfolio     *
 * before being trusted; an unknown id, a cross-stay id, or a malformed *
 * response is rejected FOR THAT DAY ONLY — never a reason to fail the  *
 * whole refinement, and the whole call is wrapped so ANY failure       *
 * (timeout, invalid JSON, no API key, quota) falls back to the         *
 * deterministic composed plan UNCHANGED (spec §5: Gemini optional).    *
 * ================================================================== */

const GEMINI_REFINEMENT_MODEL = "gemini-flash-lite-latest";
const GEMINI_REFINEMENT_TIMEOUT_MS = 20_000;

const GEMINI_REFINEMENT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    days: {
      type: Type.ARRAY,
      description: "One entry per day this call included, in any order.",
      items: {
        type: Type.OBJECT,
        properties: {
          dayNumber: { type: Type.NUMBER },
          preferredOrder: {
            type: Type.ARRAY,
            description: "The exact same candidateIds provided for this day, reordered. Must not add, remove, or invent an id.",
            items: { type: Type.STRING },
          },
          swapOutCandidateId: { type: Type.STRING, description: "Optional: a scheduled candidateId to replace, from the SAME day." },
          swapInCandidateId: { type: Type.STRING, description: "Optional: a reserve candidateId (from this day's own stay reserve list) to use instead." },
        },
        required: ["dayNumber"],
      },
    },
  },
  required: ["days"],
};

interface GeminiRefinementDayInput {
  dayNumber: number;
  candidates: Array<{ candidateId: string; name: string; family: string; subtype: string; significance: number }>;
}
interface GeminiRefinementStayInput {
  stayId: string;
  owner: string;
  days: GeminiRefinementDayInput[];
  reserve: Array<{ candidateId: string; name: string; family: string; subtype: string; significance: number }>;
}

function buildGeminiRefinementPrompt(stays: GeminiRefinementStayInput[], countryName: string): string {
  return [
    `להלן מסלול טיול ב${countryName} שכבר נבנה באופן דטרמיניסטי מתוך מאגר מקומות אמיתיים, מאורגן לפי אזורי לינה (stay) וימים.`,
    `לכל מקום יש candidateId יציב. אתה יכול להשפיע רק על שני דברים, ואך ורק דרך candidateId קיים:`,
    `1. סדר הביקור באותו יום (preferredOrder) — אותה קבוצת candidateId בדיוק, בסדר אחר.`,
    `2. החלפה בודדת ביום נתון (swapOutCandidateId/swapInCandidateId) — רק מתוך רשימת "reserve" של אותו stay.`,
    `אסור לך להמציא שם, קטגוריה, קואורדינטות, או candidateId חדש. אם אין לך שיפור אמיתי להציע ליום מסוים — פשוט השאר אותו כפי שהוא (אל תכלול אותו, או החזר preferredOrder זהה).`,
    `הנתונים:`,
    JSON.stringify(stays, null, 2),
  ].join("\n");
}

interface GeminiRefinementResponseDay {
  dayNumber: number;
  preferredOrder?: string[];
  swapOutCandidateId?: string;
  swapInCandidateId?: string;
}

export async function refineComposedPlanWithGemini(
  composedPlan: AiItineraryResponse,
  tripFrame: TripFrame,
  portfoliosByStay: Map<string, StayActivityPortfolio>,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  /** Injectable — tests pass a fake to avoid any real Gemini call; production omits this and gets the real GoogleGenAI-backed default. Returns the raw JSON text, or null/throws for "no usable response". */
  geminiCallOverride?: (prompt: string) => Promise<string | null>
): Promise<{
  plan: AiItineraryResponse;
  refinementApplied: boolean;
  /** Round 9.2 §12 observability — a swapInCandidateId Gemini named that
   * doesn't exist in ANY stay's reserve at all (invented/stale/typo'd id). */
  unknownCandidateIds: number;
  /** Round 9.2 §12 observability — a swapInCandidateId that IS a real
   * candidate somewhere in the trip, but belongs to a different stay than
   * the day being edited (the contract's cross-stay rejection firing). */
  crossStayCandidateIds: number;
}> {
  const noRefinement = { plan: composedPlan, refinementApplied: false, unknownCandidateIds: 0, crossStayCandidateIds: 0 };
  const apiKey = process.env.GEMINI_API_KEY;
  if (!geminiCallOverride && !apiKey) return noRefinement;

  // Build the ID-only, stay-scoped input — never the raw recommendation pool.
  const stayInputs: GeminiRefinementStayInput[] = [];
  const candidateOwnerStay = new Map<string, string>(); // candidateId -> stayId, for cross-stay rejection below
  for (const phase of tripFrame.phases) {
    const portfolio = portfoliosByStay.get(phase.id);
    if (!portfolio) continue;
    const daysInStay = composedPlan.days.filter((day) => day.dayNumber >= phase.startDayNumber && day.dayNumber <= phase.endDayNumber);
    const dayInputs: GeminiRefinementDayInput[] = [];
    for (const day of daysInStay) {
      const candidates = day.items
        .filter((item) => item.recommendationId != null && isScheduledRealPlace(item))
        .map((item) => {
          const classification = classifyActivity({ category: item.category, name: item.name, shortDescription: item.shortDescription, reservationRequired: item.reservationRequired, approximatePrice: item.approximatePrice });
          candidateOwnerStay.set(item.recommendationId!, phase.id);
          return { candidateId: item.recommendationId!, name: item.name, family: classification.primaryFamily, subtype: classification.subtype, significance: 50 };
        });
      if (candidates.length > 0) dayInputs.push({ dayNumber: day.dayNumber, candidates });
    }
    if (dayInputs.length === 0) continue;
    for (const candidate of portfolio.optional) candidateOwnerStay.set(candidate.recommendationId, phase.id);
    stayInputs.push({
      stayId: phase.id,
      owner: phase.areaLabel,
      days: dayInputs,
      reserve: portfolio.optional.map((c) => ({ candidateId: c.recommendationId, name: c.name, family: c.classification.primaryFamily, subtype: c.classification.subtype, significance: c.significance })),
    });
  }
  if (stayInputs.length === 0) return noRefinement;

  let responseDays: GeminiRefinementResponseDay[];
  try {
    const prompt = buildGeminiRefinementPrompt(stayInputs, payload.countryName);
    const callGemini =
      geminiCallOverride ??
      (async (thePrompt: string) => {
        const client = new GoogleGenAI({ apiKey: apiKey! });
        const response = await client.models.generateContent({
          model: GEMINI_REFINEMENT_MODEL,
          contents: thePrompt,
          config: { responseMimeType: "application/json", responseSchema: GEMINI_REFINEMENT_SCHEMA },
        });
        return response.text ?? null;
      });
    const raw = await Promise.race([
      callGemini(prompt),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Gemini refinement timeout")), GEMINI_REFINEMENT_TIMEOUT_MS)),
    ]);
    if (!raw) return noRefinement;
    const parsed = JSON.parse(raw) as { days?: GeminiRefinementResponseDay[] };
    responseDays = Array.isArray(parsed.days) ? parsed.days : [];
  } catch {
    // Any failure at all (no network, invalid JSON, quota, timeout) — the
    // deterministic composed plan is already a complete, valid itinerary;
    // Gemini's refinement is a pure enhancement, never a requirement.
    return noRefinement;
  }
  if (responseDays.length === 0) return noRefinement;

  const dayById = new Map(composedPlan.days.map((day) => [day.dayNumber, day]));
  let anyChange = false;
  // Tracked across the WHOLE response, not just the original plan — a
  // reserve candidate Gemini names for two different days in the same
  // response must still only ever be swapped in once.
  const swappedInThisRefinement = new Set<string>();
  let unknownCandidateIds = 0;
  let crossStayCandidateIds = 0;

  for (const responseDay of responseDays) {
    const day = dayById.get(responseDay.dayNumber);
    if (!day) continue;
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) continue;

    let nextItems = [...day.items];

    // Swap: only a reserve candidate belonging to the SAME stay, replacing
    // a candidate CURRENTLY scheduled on THIS exact day.
    if (responseDay.swapOutCandidateId && responseDay.swapInCandidateId) {
      const outItem = nextItems.find((item) => item.recommendationId === responseDay.swapOutCandidateId);
      const inOwnerStay = candidateOwnerStay.get(responseDay.swapInCandidateId);
      const portfolio = portfoliosByStay.get(phase.id);
      const inCandidate = portfolio?.optional.find((c) => c.recommendationId === responseDay.swapInCandidateId);
      const alreadyUsedElsewhere =
        composedPlan.days.some((d) => d.items.some((item) => item.recommendationId === responseDay.swapInCandidateId)) ||
        swappedInThisRefinement.has(responseDay.swapInCandidateId);
      // No geography re-check needed here: `inCandidate` came from
      // `portfolio.optional`, and buildStayActivityPool already applied
      // evaluateScheduledPlaceLegality against this exact stay's own
      // anchor before any candidate was ever admitted to the pool — a
      // second check here would need an anchor this function doesn't have
      // and would only re-verify what's already guaranteed.
      if (outItem && inCandidate && inOwnerStay === phase.id && !alreadyUsedElsewhere) {
        const fullRecommendation = payload.recommendations.find((r) => r.id === inCandidate.recommendationId);
        if (fullRecommendation) {
          const newItem = buildReplacementItem(fullRecommendation, outItem, day, payload);
          nextItems = nextItems.map((item) => (item === outItem ? newItem : item));
          swappedInThisRefinement.add(responseDay.swapInCandidateId);
          anyChange = true;
        }
      } else if (outItem && !inOwnerStay) {
        unknownCandidateIds += 1;
      } else if (outItem && inOwnerStay && inOwnerStay !== phase.id) {
        crossStayCandidateIds += 1;
      }
    }

    // Reorder: must be an EXACT permutation of this day's own real
    // scheduled candidateIds — anything else (missing/added/unknown id) is
    // rejected for this day only.
    if (responseDay.preferredOrder && responseDay.preferredOrder.length > 0) {
      const currentRealIds = nextItems.filter((item) => item.recommendationId != null).map((item) => item.recommendationId as string);
      const isExactPermutation =
        responseDay.preferredOrder.length === currentRealIds.length &&
        new Set(responseDay.preferredOrder).size === currentRealIds.length &&
        responseDay.preferredOrder.every((id) => currentRealIds.includes(id));
      if (isExactPermutation) {
        const realItemsById = new Map(nextItems.filter((item) => item.recommendationId != null).map((item) => [item.recommendationId as string, item]));
        const nonRealItems = nextItems.filter((item) => item.recommendationId == null);
        const reorderedReal = responseDay.preferredOrder.map((id) => realItemsById.get(id)!).filter(Boolean);
        nextItems = [...reorderedReal, ...nonRealItems];
        anyChange = true;
      }
    }

    if (nextItems !== day.items) {
      dayById.set(day.dayNumber, fillDerivedDayFields(resequenceDayItems({ ...day, items: nextItems }), payload, profile));
    }
  }

  if (!anyChange) return { ...noRefinement, unknownCandidateIds, crossStayCandidateIds };
  return {
    plan: { ...composedPlan, days: composedPlan.days.map((day) => dayById.get(day.dayNumber) ?? day) },
    refinementApplied: true,
    unknownCandidateIds,
    crossStayCandidateIds,
  };
}

export function finalizeArrivalDepartureContent(
  plan: AiItineraryResponse,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayCount: number,
  window: ArrivalDepartureWindow,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  /** Round 9.2 §12 observability only — reports how many real activities THIS
   * finalization pass's own exceptional Round-8 backfill inserted, so a
   * caller (the portfolio-composed path) can log initialReal vs backfilled
   * side by side without this function's return type or other call sites
   * changing. Never affects behavior. */
  onBackfillMetrics?: (insertions: number) => void
): AiItineraryResponse {
  // Spec "ONE DAY HAS ONE AUTHORITATIVE STRUCTURAL OWNER" (Round 4) — the
  // FINAL pipeline order starts by binding every day to its canonical
  // TripFrame owner and re-deriving display / lodging / synthetic-item
  // labels from it, THEN rebuilding the required stay transitions from the
  // FINAL frame (removing any that no longer match a real phase boundary),
  // and only THEN running the real-POI / semantic-role / invariant gates.
  const ownerBoundDays = normalizeDayOwnershipToFrame(plan.days, tripFrame, payload, profile);
  const finalTransitions = buildStayTransitions(tripFrame, areaAnchors);
  const { days: transitionRebuiltDays } = enforceStayTransitions(ownerBoundDays, finalTransitions, payload, profile);

  const { days: localityRepairedDays } = enforceNormalDayLocality(
    removeFuzzyDuplicatePlaces(transitionRebuiltDays, payload, profile),
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile,
    window
  );
  // Section "AIRPORTS ARE NOT ATTRACTIONS" — same final-gate position as
  // the locality check just above (spec "GEOGRAPHIC VALIDATION MUST RUN
  // AFTER ALL REPAIRS").
  const { days: roleRepairedDays } = enforceTransportRoleGuard(localityRepairedDays, payload, profile, tripFrame, areaAnchors);
  const arrivalRepairedDays = ensureArrivalDepartureDayHasContent(roleRepairedDays, payload, profile, dayCount, window);
  // Spec "DAY-LEVEL POI GEOGRAPHY / LEGALITY" §Step 3 "ONE AUTHORITATIVE
  // FINAL GATE" — the last mutation capable of adding/moving a real place
  // in this pipeline is ensureArrivalDepartureDayHasContent just above (it
  // only ever inserts a synthetic practical block into an EMPTY day, never
  // a real POI, but this gate still runs after it so nothing added later
  // could ever bypass it either). Runs on the exact object about to be
  // costed and returned below — never a throwaway copy.
  const { days: legalityGatedDays, violations: finalLegalityViolations } = enforceFinalPlaceLegalityGate(
    arrivalRepairedDays,
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile,
    window
  );

  // Round 7 — required pipeline order: day/stay ownership fixed →
  // geography legality fixed (everything above) → schedule stabilized →
  // OPENING-HOURS REPAIR → schedule stabilized → PURE FINAL VALIDATOR.
  // The geography gates above are time-independent for normal/arrival/
  // departure days (pure distance), so re-timing an item here can never
  // regress them. This is the last stage allowed to change an item's
  // scheduled time; the PURE validator (inside enforceItineraryInvariants-
  // WithRepair) then runs on the settled object and re-runs after its own
  // bounded repair.
  const openingHoursRepairedDays = repairOpeningHoursViolations(legalityGatedDays, payload, profile);

  // Round 9 — build each stay's REAL (item-aware deriveDayType) pool +
  // diversity-scored portfolio from the settled object, so the Round-8
  // backfill below draws from the planner's own deliberate selection first
  // (spec §21/§22 — backfill is now a LAST-resort quality repair, not the
  // primary content mechanism).
  const dayCapacityByStay = new Map<string, StayDayCapacityInput[]>();
  for (const day of openingHoursRepairedDays) {
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) continue;
    const list = dayCapacityByStay.get(phase.id) ?? [];
    list.push({
      dayNumber: day.dayNumber,
      dayType: deriveDayType(day, tripFrame, window),
      hasExplicitRestWindow: Boolean(day.restWindow && day.restWindow.trim()),
    });
    dayCapacityByStay.set(phase.id, list);
  }
  const { portfoliosByStay } = buildTripActivityPortfolios(
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload.recommendations,
    dayCapacityByStay,
    profile.mustVisitKeywords,
    [...profile.strongPreferences, ...profile.softPreferences],
    profile.dailyCapacityMinutes,
    normalizeAreaLabel,
    resolveTextualAreaMatch
  );

  // Round 8 — spec "THE PLANNER MUST CHOOSE REAL THINGS FOR THE USER TO DO":
  // a day can be geographically/hours legal and still be a failed
  // itinerary (every "activity" is free_time/meal_opportunity). Before the
  // final legality/invariant gate, pull unused legal real candidates
  // already loaded for this owner/stay and use them to demote synthetic
  // filler back into real content — never past the day's own real
  // capacity, never a globally-used place, every inserted item re-checked
  // against BOTH the geography and opening-hours rules before it's kept.
  const backfillResult = backfillRealActivities(
    openingHoursRepairedDays,
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile,
    window,
    portfoliosByStay
  );
  if (backfillResult.insertions.length > 0) {
    logGenerationStage("quality backfill: real activities inserted", { insertions: backfillResult.insertions });
  }
  onBackfillMetrics?.(backfillResult.insertions.length);
  // A backfilled item can shift a day's schedule enough to nudge another
  // item's timing — settle opening hours once more on the exact object
  // about to reach the final gate (same "settle" pattern as Round 7).
  const backfilledDays = repairOpeningHoursViolations(backfillResult.days, payload, profile);

  // Round 9.3.3 continuation §4 — the meal analogue of the activity
  // backfill just above, using the SAME final anchors/mobility/candidate
  // set (never a second country-wide or inline pseudo-pool).
  const finalMealPoolsByStay = buildTripMealVenuePools(
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload.recommendations,
    profile.dailyCapacityMinutes,
    normalizeAreaLabel,
    resolveTextualAreaMatch
  );
  const mealBackfillResult = backfillRealMealVenues(backfilledDays, tripFrame, payload, profile, finalMealPoolsByStay, dayCount, window);
  if (mealBackfillResult.insertions.length > 0) {
    logGenerationStage("quality backfill: real meal venues inserted", { insertions: mealBackfillResult.insertions });
  }
  const mealBackfilledDays = repairOpeningHoursViolations(mealBackfillResult.days, payload, profile);

  // Spec "TRIP-FRAME / DAY OWNERSHIP / FINAL GEOGRAPHY INVARIANT" §Step 6 —
  // PURE validator over the exact object, then ONE bounded deterministic
  // repair, then the PURE validator again. This is the acceptance gate:
  // illegalScheduledRealPlaces / invalidTransitionOwnership /
  // invalidSemanticRolePlacements / realItemsWithNullLegGeometry /
  // openingHoursViolations must all be zero on `finalizedDays`. No real
  // place is inserted, and no scheduled time is changed, after this.
  const { days: finalizedDays, before: invariantBefore, after: invariantAfter } = enforceItineraryInvariantsWithRepair(
    mealBackfilledDays,
    tripFrame,
    areaAnchors,
    mobilityProfile,
    payload,
    profile,
    window
  );
  const invariantBeforeTotal =
    invariantBefore.illegalScheduledRealPlaces +
    invariantBefore.invalidTransitionOwnership +
    invariantBefore.invalidSemanticRolePlacements +
    invariantBefore.realItemsWithNullLegGeometry +
    invariantBefore.dayOwnerMismatch +
    invariantBefore.invalidDayDisplayOwnership +
    invariantBefore.lodgingOwnerMismatch +
    invariantBefore.syntheticOwnerMismatch +
    invariantBefore.realFoodVenueOwnerMismatch +
    invariantBefore.narrativeOwnerMismatch +
    invariantBefore.openingHoursViolations +
    invariantBefore.lockedOpeningHoursConflicts;
  if (invariantBeforeTotal > 0) {
    logGenerationStage("final itinerary invariant repair", { before: invariantBefore, after: invariantAfter });
  }

  // Spec "DAY-LEVEL POI GEOGRAPHY / LEGALITY" §Step 2/3 — the true,
  // independent count of real places this final gate itself found illegal
  // ON THE OBJECT ACTUALLY BEING RETURNED, never a re-run of the same
  // repair being audited. Any entry with repaired:false is a locked/
  // fixed-time item that survives by design (never silently dropped) —
  // this must be visible in dev diagnostics even when it's 0, so a future
  // regression here is never silently invisible again.
  if (finalLegalityViolations.length > 0) {
    logGenerationStage("final legality gate violations", {
      total: finalLegalityViolations.length,
      unrepairedProtected: finalLegalityViolations.filter((v) => !v.repaired).length,
      violations: finalLegalityViolations,
    });
  }

  // Spec "מכני, לא קריאה ידנית" — a dev-only mechanical geography report,
  // never gates acceptance, never runs in production. QA_DEBUG_GEOGRAPHY=1
  // (env var — never a production default) prints one row per item.
  // Also the ONLY place the full 4-value geoSource taxonomy still exists
  // once generation finishes — CAPTURE_FIXTURES=1 writes it to
  // geo-resolution.json here (spec "סוגר את הפער בלי לגעת בסכימה") since
  // nothing about it survives onto the saved trip otherwise.
  if (process.env.QA_DEBUG_GEOGRAPHY === "1" || isFixtureCaptureEnabled()) {
    const diagnostics = computeGeographyDiagnostics(finalizedDays, tripFrame, areaAnchors, mobilityProfile, payload, profile, window);
    logGenerationStage("geography diagnostics summary", { ...summarizeGeographyDiagnostics(diagnostics) });

    // Overpass calls happen across several separate requests (recommendations,
    // food, hotels) before generation ever runs, not just here — this is a
    // process-lifetime count, so a debug session can immediately tell "every
    // Overpass call this session failed" (a synthetic/fallback run) apart
    // from a real one, instead of misreading a fallback run as production.
    const overpassStats = getOverpassCallStats();
    logGenerationStage("overpass call stats (process lifetime)", overpassStats);
    if (isFixtureCaptureEnabled()) {
      captureOverpassStatsFixture(overpassStats);
    }

    if (process.env.QA_DEBUG_GEOGRAPHY === "1" || isPlannerQaTraceEnabled()) {
      for (const day of diagnostics) {
        const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
        const anchor = phase ? areaAnchors.get(phase.areaLabel) : undefined;
        const anchorExists = anchor != null;
        const realItems = day.items.filter((item) => item.geoSource !== "n/a");
        const realItemsWithNullLegGeometry = realItems.filter(
          (item) => item.legMinutes == null && item.precision === "point"
        ).length;

        logGenerationStage(
          `geo-diagnostic day ${day.dayNumber}`,
          {
            areaLabel: phase?.areaLabel ?? null,
            anchorExists,
            anchorLat: anchor?.lat ?? null,
            anchorLon: anchor?.lon ?? null,
            ownerStay: day.ownerStay,
            derivedDayType: day.derivedDayType,
            textualDayType: day.textualDayType,
            dayTypeMismatch: day.dayTypeMismatch,
            totalLegMinutes: day.totalLegMinutes,
            maxLegMinutes: day.maxLegMinutes,
            unresolvedItemCount: day.unresolvedItemCount,
            realPlaceCount: realItems.length,
            realItemsWithNullLegGeometry,
            items: day.items,
          }
        );

        // Spec "OBSERVABILITY ONLY" §I/§J — the two failure-shaped states
        // this whole pass exists to make visible, tagged distinctly so a
        // human (or a future test) can grep for them without parsing the
        // full per-day block above. Deliberately not fixed here — the
        // request is explicit that this pass only observes.
        if (!anchorExists) {
          console.log("[PlannerQA] OWNER_ANCHOR_MISSING", {
            dayNumber: day.dayNumber,
            areaLabel: phase?.areaLabel ?? null,
            ownerStay: day.ownerStay,
          });
        }
        if (day.dayTypeMismatch) {
          console.log("[PlannerQA] DAY_TYPE_MISMATCH", {
            dayNumber: day.dayNumber,
            derivedDayType: day.derivedDayType,
            textualDayType: day.textualDayType,
            derivedDayTypeSource: "deriveDayType (TripFrame stay comparison + coordinate geometry)",
            textualDayTypeSource: "textualDayType (isIntercityTransferDay/isDayTripDay prose-shape heuristics)",
            survivesFinalization: true,
          });
        }
      }
    }

    if (isFixtureCaptureEnabled()) {
      // Keyed by recommendationId when the item has one, else day+name —
      // the only join key that still means the same thing once this item
      // is saved as a TripItineraryItem with its own fresh, unrelated id
      // (see geoResolutionJoinKey's docstring in
      // itinerary-day-view-helpers.ts, which the render-time overlay uses
      // to look this same entry back up — keep both formulas identical).
      const geoResolutionMap: Record<string, GeoResolutionFixtureEntry> = {};
      finalizedDays.forEach((day, dayIndex) => {
        const diagnosticDay = diagnostics[dayIndex];
        const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
        day.items.forEach((item, itemIndex) => {
          const diagnosticItem = diagnosticDay?.items[itemIndex];
          if (!diagnosticItem || diagnosticItem.geoSource === "n/a") return;
          const key = item.recommendationId || `name:${day.dayNumber}:${item.name}`;
          geoResolutionMap[key] = {
            geoSource: diagnosticItem.geoSource,
            dayIndex: day.dayNumber,
            itemName: item.name,
            stayId: phase?.id ?? null,
          };
        });
      });
      captureGeoResolutionFixture(geoResolutionMap);
    }
  }

  // Round 8 — observability: log the quality shape on the EXACT object
  // about to be returned, regardless of whether it ends up accepted or
  // retried by the caller (repairPlan recomputes the same pure function on
  // this same `finalizedDays` to decide accept-vs-retry / hard-fail).
  const qualityReport = validateItineraryQuality(finalizedDays, tripFrame, window);
  if (qualityReport.unjustifiedDaysWithOnlySyntheticContent > 0 || qualityReport.daysBelowMinimumRealActivities > 0) {
    logGenerationStage("itinerary quality", { ...qualityReport });
  }
  // Round 9 §37 [ActivityPortfolioQA] / [StayActivityPoolQA] — QA-gated
  // trip-wide + per-stay diversity/pool observability on the exact
  // returned object. Never spams normal production logs.
  if (isPlannerQaTraceEnabled()) {
    // portfoliosByStay's own StayActivityPool objects were already logged
    // pre-generation by refillTripRecommendationPool ([StayActivityPoolQA]
    // "initialCandidates"/"refillCandidates"); this block reports the
    // FINAL, post-backfill portfolio usage on the exact returned object.
    for (const [stayId, portfolio] of portfoliosByStay) {
      const scheduledIds = new Set(
        finalizedDays.flatMap((day) => day.items.map((item) => item.recommendationId).filter((id): id is string => id != null))
      );
      logGenerationStage("[StayActivityPoolQA] portfolio usage", {
        stayId,
        selectedPortfolioCount: portfolio.selected.length,
        scheduledFromPortfolio: portfolio.selected.filter((c) => scheduledIds.has(c.recommendationId)).length,
        unusedLegalCount: portfolio.optional.length,
      });
    }
    logGenerationStage("[ActivityPortfolioQA]", {
      realActivities: qualityReport.realActivityCount,
      meaningfulRealActivities: qualityReport.meaningfulRealActivityCount,
      syntheticBlocks: qualityReport.syntheticActivityCount,
      candidateExhaustionFallbacks: qualityReport.candidateExhaustionFallbackCount,
      daysWithZeroRealActivities: qualityReport.daysWithZeroRealActivities,
      syntheticOnlyNormalDays: qualityReport.unjustifiedDaysWithOnlySyntheticContent,
      familyDistribution: qualityReport.familyDistribution,
      subtypeDistribution: qualityReport.subtypeDistribution,
      consecutiveSameFamilyDays: qualityReport.consecutiveSameFamilyDays,
      consecutiveSameSubtypeDays: qualityReport.consecutiveSameSubtypeDays,
      backfillInsertions: backfillResult.insertions.length,
    });
  }

  const computedCosts = buildCostsFromDays(finalizedDays, payload.preferences.travelers, payload.preferences.flights);
  const costPerTraveler =
    computedCosts.totalEstimatedCost != null && payload.preferences.travelers > 0
      ? Math.round(computedCosts.totalEstimatedCost / payload.preferences.travelers)
      : null;
  return {
    ...plan,
    totalEstimatedCost: computedCosts.totalEstimatedCost,
    estimatedTransportCost: computedCosts.estimatedTransportCost,
    averageDailyCost: computedCosts.averageDailyCost,
    costPerTraveler,
    categoryBreakdown: computedCosts.categoryBreakdown,
    days: finalizedDays,
  };
}

export function repairPlan(
  raw: RawGeneratedPlan,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  tripFrame: TripFrame,
  exchangeRateContext: ExchangeRateContext | null,
  arrivalDepartureWindow: ArrivalDepartureWindow = computeArrivalDepartureWindow(
    payload.preferences.flights,
    payload.isoA2
  ),
  /** Observability only — which Gemini call produced `raw` (null for the deterministic-template fallback, which never calls repairPlan through Gemini output). Used only to tag gemini_initial vs gemini_retry ingestion trace events below; changes no behavior. */
  geminiAttempt: 1 | 2 | null = null
): AiItineraryResponse {
  const fallback = buildFallbackAiItinerary(payload);
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  const days: AiGeneratedDay[] = [];
  const usedMealNames = new Set<string>();
  // Round 9.2.1 §12 — same by-reference threading as usedMealNames just
  // above, shared across every day/attempt in this whole repairPlan call.
  const recentMealHistory: RecentMealHistoryEntry[] = [];
  const cuisineWeights = buildCuisinePreferenceWeights([...profile.strongPreferences, ...profile.softPreferences]);
  // Root-cause fix (spec §G "Gemini can still author duplicates... at
  // ingestion: if resolved canonical identity is already present elsewhere,
  // reject/replace it before downstream repairs") — shared and mutated
  // across this whole per-day build loop AND threaded into
  // repairDayStructure/repairDayGeography below (same object, same
  // itinerary-wide semantics point A demands for every repair pass).
  const usageState = createItineraryUsageState();

  // Round 9.4.1 §F — the ingestion round-trip: `raw` (from
  // toRawGeneratedPlan, e.g. the composed plan serialized back down to
  // RawGeneratedItem, which has NO itemRole/lat/lon fields at all) is
  // re-hydrated per-day by enrichAiDay, which re-attaches recommendationId
  // ONLY via an exact case-insensitive NAME match against
  // payload.recommendations/selectedPlaces. "before" here is the INTENDED
  // identity (what name-matching SHOULD find, computed independently of
  // enrichAiDay's own internal logic, using the same recommendations
  // list); "after" is what enrichAiDay ACTUALLY produced — any divergence
  // between them is a real round-trip identity loss, never inferred.
  const roundTripBefore: RepairSnapshotItem[] = [];
  const roundTripAfter: RepairSnapshotItem[] = [];
  const recommendationsByName = isPlannerQaTraceEnabled()
    ? new Map([...payload.recommendations, ...payload.selectedPlaces].map((r) => [r.name.trim().toLowerCase(), r]))
    : null;

  for (let index = 0; index < dayCount; index += 1) {
    const expectedDayNumber = index + 1;
    const rawDay =
      raw.days.find((day) => day.dayNumber === expectedDayNumber) ??
      raw.days[index] ??
      null;

    if (!rawDay) {
      days.push(fallback.days[index]);
      continue;
    }

    if (recommendationsByName) {
      for (const item of rawDay.items) {
        const matched = recommendationsByName.get(item.name.trim().toLowerCase());
        if (!matched) continue;
        roundTripBefore.push({
          id: matched.id,
          name: item.name,
          category: item.category,
          itemRole: null, // RawGeneratedItem has no itemRole field at all — the exact gap this log exists to surface
          phaseId: null,
          dayNumber: expectedDayNumber,
          lat: matched.lat,
          lon: matched.lon,
          kind: matched.category === "restaurant" || matched.category === "cafe" ? "real_meal" : "real_activity",
          hasRecommendationId: true,
        });
      }
    }

    const rawEnriched = enrichAiDay(
      {
        ...rawDay,
        dayNumber: expectedDayNumber,
        date: dateForDayNumber(payload.preferences.startDate, expectedDayNumber) || rawDay.date,
      },
      payload,
      exchangeRateContext
    );

    // Root-cause fix (spec §G) — Gemini can (and, per the real 43-day
    // replay's gemini_initial/gemini_retry duplicate sources, sometimes
    // does) author the SAME real place on two different days on its own.
    // Enforced at the exact point Gemini's output is first ingested, before
    // any downstream repair pass ever sees it: a real item whose canonical
    // identity is already used by an EARLIER day in this same loop is
    // replaced with a generic placeholder right here, never scheduled
    // twice. This is uniqueness enforcement only — not the "Gemini ID-only
    // scheduling" the spec explicitly says NOT to build yet.
    const dedupedItems = rawEnriched.items.map((item) => {
      if (!isItineraryPlaceUsed(usageState, item)) return item;
      const replacement = buildFreeExplorationReplacement(item, rawEnriched);
      tracePlaceInsertion({
        item: replacement,
        normalizedName: normalizePlaceNameSlug(replacement.name),
        dayNumber: expectedDayNumber,
        source: "duplicate_repair",
        action: "REPLACE",
        ownerStay: rawEnriched.cityRegion,
        reason: `gemini-authored duplicate rejected at ingestion (geminiAttempt=${geminiAttempt ?? "n/a"})`,
      });
      return replacement;
    });
    const enriched: AiGeneratedDay = { ...rawEnriched, items: dedupedItems };

    if (recommendationsByName) {
      for (const item of enriched.items) {
        if (item.recommendationId == null) continue;
        roundTripAfter.push({
          id: item.recommendationId,
          name: item.name,
          category: item.category,
          itemRole: item.itemRole ?? null,
          phaseId: null,
          dayNumber: expectedDayNumber,
          lat: item.lat,
          lon: item.lon,
          kind: item.category === "restaurant" || item.category === "cafe" ? "real_meal" : "real_activity",
          hasRecommendationId: true,
        });
      }
    }

    if (geminiAttempt != null) {
      for (const item of enriched.items) {
        if (item.recommendationId == null) continue;
        tracePlaceInsertion({
          item,
          normalizedName: normalizePlaceNameSlug(item.name),
          dayNumber: expectedDayNumber,
          source: geminiAttempt === 1 ? "gemini_initial" : "gemini_retry",
          action: "INSERT",
          ownerStay: enriched.cityRegion,
          reason: `geminiAttempt=${geminiAttempt}`,
        });
      }
    }
    for (const item of enriched.items) registerItineraryUsage(usageState, item);

    const fallbackDay = fallback.days[index];
    const normalizedDay: AiGeneratedDay = {
      ...fallbackDay,
      ...enriched,
      dayNumber: expectedDayNumber,
      date: dateForDayNumber(payload.preferences.startDate, expectedDayNumber) || enriched.date,
      title: enriched.title || fallbackDay.title,
      cityRegion: enriched.cityRegion || fallbackDay.cityRegion,
      accommodation: enriched.accommodation || fallbackDay.accommodation,
      transportation: enriched.transportation || fallbackDay.transportation,
      notes: enriched.notes || fallbackDay.notes,
      warnings: enriched.warnings.length > 0 ? enriched.warnings : fallbackDay.warnings,
      alternatives: enriched.alternatives.length > 0 ? enriched.alternatives : fallbackDay.alternatives,
      bookingRequirements:
        enriched.bookingRequirements.length > 0
          ? enriched.bookingRequirements
          : fallbackDay.bookingRequirements,
      safetyNotes: enriched.safetyNotes.length > 0 ? enriched.safetyNotes : fallbackDay.safetyNotes,
      restWindow: enriched.restWindow || fallbackDay.restWindow,
      transportSegments:
        enriched.transportSegments.length > 0 ? enriched.transportSegments : fallbackDay.transportSegments,
      items: enriched.items.length > 0 ? enriched.items : fallbackDay.items,
    };

    days.push(repairDayStructure(normalizedDay, payload, profile, index, dayCount, usedMealNames, usageState, arrivalDepartureWindow, recentMealHistory, cuisineWeights));
  }
  if (recommendationsByName) {
    logRepairRoundTrip("toRawGeneratedPlan -> enrichAiDay (ingestion)", roundTripBefore, roundTripAfter);
  }

  let repairedDays = days;
  let lastPlan: AiItineraryResponse | null = null;

  // Shared across every repair attempt (not recreated per attempt) so
  // repeat-restaurant suppression pressure accumulates instead of being
  // wiped on every retry. (`usedPlaceKeys` below stays attempt-scoped and
  // freshly built each time on purpose — `rebalanceDayItems` relies on
  // seeing each item's *first* occurrence as non-duplicate while it builds
  // that set up incrementally as it walks the days in order.)
  const iterationMealNames = new Set(usedMealNames);
  // Spec "נדנוד אינסופי" — a place repairNormalDayTravelOutliers already
  // rejected from a given day earlier in THIS repairPlan run must never
  // come back as someone else's replacement on a later attempt (the real
  // symptom: one day cycling "free block -> Mystery Spot -> free block ->
  // Mystery Spot" across 4 attempts, because usedPlaceKeys was rebuilt
  // fresh each attempt with no memory of what had already been tried and
  // rejected). Shared across every attempt like iterationMealNames above,
  // keyed by day number so it only ever suppresses re-selection for the
  // SAME day, never bleeding into another day's own repair.
  const removedItemKeysByDay = new Map<number, Set<string>>();
  // Reset per attempt (content moves around every attempt) and read back
  // into that attempt's own collectPlanDiagnostics call below.
  let protectedGeographicConflicts: ProtectedGeographicConflict[] = [];
  let impossibleStayTransitionDetails: ImpossibleStayTransition[] = [];
  // Round 9.4.2 §B/§H — real coordinate centroid per area, shared by the
  // structural-repair feasibility check below, the initial StayTransition
  // build, AND (critically) every pool-rebuild inside
  // assertFinalRealActivityCoverage below. This used to be the RAW
  // computeAreaAnchors(payload) — derived ONLY from recommendations' own
  // location TEXT matching tripFrame.phases[].areaLabel exactly. Proven
  // root cause (traceId gen-mu7ihdq8-545bii8p): when a stay-skeleton-
  // resolved TripFrame's phases already carry the AUTHORITATIVE resolved
  // coordinate (phase.anchor, set by buildTripFrameFromResolvedStays) but
  // no recommendation's own location field happens to textually match
  // that exact area label, computeAreaAnchors silently produced NO entry
  // for that phase at all — every downstream ownership check
  // (assignCandidatesToStays) then saw zero candidates for every stay,
  // regardless of how many real candidates payload.recommendations
  // actually held (291 in production). resolveAreaAnchorsForFrame is the
  // SAME merge (tripFrame.phase.anchor authoritative, recommendation-
  // derived text match only as a fallback for the older POI-clustering
  // path) already used everywhere else in generateCountryItineraryPlan
  // (finalAreaAnchors/preGenerationAreaAnchors) — repairPlan's own
  // internal anchors were the one place still missing it.
  const areaAnchors = resolveAreaAnchorsForFrame(tripFrame, computeAreaAnchors(payload));
  // Locality-first architecture (spec §C/§D) — one adaptive radius derived
  // from this trip's own candidate density, computed once, used by every
  // locality-aware repair step below instead of one fixed worldwide km.
  const mobilityProfile = computeDestinationMobilityProfile(
    [...payload.recommendations, ...payload.selectedPlaces].map((recommendation) => ({
      lat: recommendation.lat,
      lon: recommendation.lon,
    }))
  );
  // The pool of areas real candidates exist in, beyond whatever the frame
  // currently uses — spec §A3's "another candidate" for base reselection.
  const candidateAreas = [
    ...new Set(
      [...payload.recommendations, ...payload.selectedPlaces]
        .map((recommendation) => normalizeAreaLabel(recommendation.location))
        .filter((area): area is string => Boolean(area))
    ),
  ];
  // Mutable across attempts (spec §A6) — a successful structural repair
  // replaces both; every other repair step below always reads the CURRENT
  // value, never the original tripFrame parameter.
  let currentTripFrame = tripFrame;
  let stayTransitions = buildStayTransitions(currentTripFrame, areaAnchors);

  // Round 9.3.6.1 §1/§12 — ONE shared final-coverage boundary, called at
  // EVERY successful exit from repairPlan (never only the loop-exhaustion
  // path). Previously the "legally-clean plan reaches its final attempt"
  // return below accepted a real-activity-poor plan WITHOUT ever running
  // this check, making coverage non-authoritative for exactly the shape a
  // real 34-day/7-stay production trip hit (34 normal days, 18 unjustified
  // zero-real days, real pools/portfolios existing all along). Reads
  // currentTripFrame/areaAnchors/mobilityProfile at CALL time (a closure
  // over the `let` bindings above, not a snapshot), so a structural repair
  // that reassigns currentTripFrame mid-loop is still reflected correctly
  // no matter which attempt this fires on. Throws exactly the same
  // InsufficientRealActivityCoverageError/isMajorityFailure-gated
  // invariant as before — genuine low supply (a small real pool) still
  // degrades silently per spec §12A; this never fabricates content and
  // never requires a fixed POIs/day count.
  const assertFinalRealActivityCoverage = (finalDays: AiGeneratedDay[]) => {
    const activityPools = buildTripActivityPortfolios(
      currentTripFrame,
      areaAnchors,
      mobilityProfile,
      payload.recommendations,
      estimatePreGenerationDayTypesByStay(currentTripFrame, dayCount, arrivalDepartureWindow),
      profile.mustVisitKeywords,
      [...profile.strongPreferences, ...profile.softPreferences],
      profile.dailyCapacityMinutes,
      normalizeAreaLabel,
      resolveTextualAreaMatch
    );
    assertRealActivityCoverage(
      validateItineraryQuality(finalDays, currentTripFrame, arrivalDepartureWindow),
      payload,
      { tripFrame: currentTripFrame, countryName: payload.countryName },
      buildStaySupplyDiagnosticsMap(currentTripFrame, activityPools.poolsByStay, activityPools.portfoliosByStay)
    );
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Round 9.4.1 §B/§E — stepIndex resets per attempt (step 1, 2, 3... of
    // THIS attempt), so RepairStepDelta logs read as a clean sequence
    // within each attempt boundary rather than an ever-growing global
    // counter.
    let stepIndex = 0;
    if (isPlannerQaTraceEnabled()) {
      logRepairAttemptStart(attempt, snapshotDayItemsForRepairTrace(repairedDays, currentTripFrame));
    }
    // Root-cause fix (spec §C — "build canonical usage state from the
    // CURRENT itinerary" before each pass, "do not recompute from the
    // original pre-repair itinerary after mutations") — fresh from
    // repairedDays as this attempt actually starts, not reused across
    // attempts and not the empty state the very first build loop began
    // with.
    const structuralRepairUsageState = buildItineraryUsageState(repairedDays);
    repairedDays = traceRepairStep(attempt, stepIndex++, "repairDayStructure", currentTripFrame, repairedDays, () =>
      repairedDays.map((day, index) =>
        repairDayStructure(normalizeDayCollections(day), payload, profile, index, dayCount, iterationMealNames, structuralRepairUsageState, arrivalDepartureWindow, recentMealHistory, cuisineWeights)
      )
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "ensureMustVisitCoverage", currentTripFrame, repairedDays, () =>
      ensureMustVisitCoverage(repairedDays, payload, profile)
    );

    // Repairs content Gemini itself already returned wrong BEFORE the
    // title/cityRegion sync below — otherwise alignDaysToTripFrame would
    // just relabel a day to match its base while the day still contains
    // another region's activities (spec §B/§C6).
    let crossRegionRepair!: ReturnType<typeof repairCrossRegionDayContent>;
    repairedDays = traceRepairStep(attempt, stepIndex++, "repairCrossRegionDayContent", currentTripFrame, repairedDays, () => {
      crossRegionRepair = repairCrossRegionDayContent(repairedDays, payload, profile, currentTripFrame);
      return crossRegionRepair.days;
    });
    protectedGeographicConflicts = crossRegionRepair.protectedGeographicConflicts;

    // Section A1 — before enforceStayTransitions can ever report an
    // impossible transition, try generic structural repair on the frame
    // itself (boundary shift / base reselection / merge), respecting
    // whatever content is currently locked/fixedTime (spec §A5). A
    // successful repair immediately rebuilds stayTransitions from the new
    // frame (spec §A6) and the day/base alignment right below picks it up
    // in the very same attempt.
    const protectedDayNumbers = new Set(
      repairedDays.filter((day) => day.items.some((item) => isProtectedItem(item))).map((day) => day.dayNumber)
    );
    const structureRepair = attemptStayStructureRepair(
      currentTripFrame,
      areaAnchors,
      candidateAreas,
      protectedDayNumbers,
      profile
    );
    if (structureRepair.changed) {
      // Round 9.4.1 §H — a genuine, real suspect for the "stale supply
      // context" mystery: areaAnchors (used by every ownership-based pool
      // rebuild, including repairPlan's own assertFinalRealActivityCoverage
      // below) is a Map keyed by AREA-LABEL TEXT, built ONCE near the top
      // of repairPlan from payload's OWN candidates — never recomputed
      // after a structural repair changes a phase's areaLabel. If the new
      // label isn't a key that map already has, every candidate whose
      // ownership depends on that anchor silently resolves to zero, no
      // matter how healthy the ORIGINAL discovery was for the OLD label.
      // Logged here, never fixed — this round is forensics only.
      if (isPlannerQaTraceEnabled()) {
        const oldLabels = currentTripFrame.phases.map((p) => ({ id: p.id, areaLabel: p.areaLabel }));
        const newLabels = structureRepair.tripFrame.phases.map((p) => ({ id: p.id, areaLabel: p.areaLabel }));
        logRealPlaceQA("StructuralRepairFrameChange", {
          attempt,
          stepIndex,
          before: oldLabels,
          after: newLabels,
          anyNewLabelMissingFromAreaAnchors: newLabels.some((p) => !areaAnchors.has(p.areaLabel)),
        });
      }
      currentTripFrame = structureRepair.tripFrame;
      stayTransitions = structureRepair.stayTransitions;
    }

    repairedDays = traceRepairStep(attempt, stepIndex++, "alignDaysToTripFrame", currentTripFrame, repairedDays, () =>
      alignDaysToTripFrame(repairedDays, currentTripFrame)
    );

    // Section C2/C3: no overnight teleportation — every base change gets a
    // real, visible transition item reserving its own real time, before
    // any later step (rebalance/overload/budget) decides how much
    // optional content the day can still hold.
    let transitionRepair!: ReturnType<typeof enforceStayTransitions>;
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceStayTransitions", currentTripFrame, repairedDays, () => {
      transitionRepair = enforceStayTransitions(repairedDays, stayTransitions, payload, profile);
      return transitionRepair.days;
    });
    impossibleStayTransitionDetails = transitionRepair.impossibleStayTransitionDetails;

    const rebalanceUsageState = createItineraryUsageState();
    repairedDays = traceRepairStep(attempt, stepIndex++, "rebalanceDayItems", currentTripFrame, repairedDays, () =>
      repairedDays.map((day) => rebalanceDayItems(normalizeDayCollections(day), payload, profile, rebalanceUsageState))
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "fixOverloadedDays", currentTripFrame, repairedDays, () =>
      fixOverloadedDays(repairedDays, payload, profile)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "repairOpeningHoursViolations", currentTripFrame, repairedDays, () =>
      repairOpeningHoursViolations(repairedDays, payload, profile)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceMealCountLimit", currentTripFrame, repairedDays, () =>
      enforceMealCountLimit(repairedDays, payload, profile)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceMealSpacing_1", currentTripFrame, repairedDays, () =>
      enforceMealSpacing(repairedDays, payload, profile)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "ensureWeatherBackup", currentTripFrame, repairedDays, () =>
      ensureWeatherBackup(repairedDays, payload)
    );

    // Real fix, not just a diagnostic (spec item 23) — arrival/departure
    // days are skipped here since their window is intentionally narrower
    // and already handled by their own dedicated enforcement below.
    const fillUsageState = buildItineraryUsageState(repairedDays);
    repairedDays = traceRepairStep(attempt, stepIndex++, "fillUnderfilledDay", currentTripFrame, repairedDays, () =>
      repairedDays.map((day) =>
        day.dayNumber === 1 || day.dayNumber === dayCount
          ? day
          : fillUnderfilledDay(day, payload, profile, fillUsageState)
      )
    );

    repairedDays = traceRepairStep(attempt, stepIndex++, "capArrivalDepartureDays", currentTripFrame, repairedDays, () =>
      capArrivalDepartureDays(repairedDays, payload, profile, dayCount)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceArrivalDepartureWindow_1", currentTripFrame, repairedDays, () =>
      enforceArrivalDepartureWindow(repairedDays, payload, profile, arrivalDepartureWindow, dayCount)
    );
    // Deliberately NOT ensureArrivalDepartureDayHasContent here — this
    // whole block sits inside the attempt loop below, and the NEXT
    // attempt's repairDayStructure unconditionally re-runs
    // resequenceDayItems at its very top, which re-derives every item's
    // plannedStartTime/endTime from the generic day window regardless of
    // locked/fixedTime (a real bug found during end-to-end QA generation:
    // scheduleDayItems never actually checks either flag) — silently
    // discarding the pinned, window-safe time this step would have just
    // set. It's applied once, after the loop, to whatever plan is
    // actually returned, so nothing later can undo it.
    repairedDays = traceRepairStep(attempt, stepIndex++, "lightenHighEnergyStreaks", currentTripFrame, repairedDays, () =>
      lightenHighEnergyStreaks(repairedDays, payload, profile)
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceBudgetOnDays", currentTripFrame, repairedDays, () =>
      enforceBudgetOnDays(repairedDays, payload, profile).map((day) => fillDerivedDayFields(normalizeDayCollections(day), payload, profile))
    );

    // Real bug found during end-to-end QA generation (a live France trip
    // with Disneyland Paris): a day starting out with a genuine full-day
    // anchor correctly has its meals omitted — but several of the repair
    // steps above (rebalanceDayItems, diversifyActivities,
    // enforceBudgetOnDays, lightenHighEnergyStreaks, ...) can replace an
    // anchor item outright, including a full-day one, well after
    // repairDayStructure already ran and decided meals weren't needed.
    // Once that anchor is gone, the day is a normal day again and DOES
    // need meals, but nothing re-checked — missingMeals stayed non-zero
    // for the rest of this attempt (and often every attempt), since
    // meal insertion otherwise only happens once, near the top of
    // repairDayStructure. One final sweep here catches exactly that,
    // regardless of which upstream step is what changed the day's shape.
    //
    // insertMissingMeals returns the SAME object reference when nothing
    // was actually missing (findMissingMealSlots found nothing to insert)
    // — deliberately checked here and skipped in that case. A second real
    // bug found while tracing mealSpacingViolations: unconditionally
    // wrapping every day in resequenceDayItems (even ones needing no meal
    // insertion at all) re-scheduled every item from a plain sequential
    // cursor, which has no notion of the 180/240-minute minimum meal gap
    // enforceMealSpacing had already established a few steps above —
    // silently undoing it on every single day, every attempt.
    // enforceMealSpacing is re-run afterward for the same reason: a day
    // that DID get a fresh meal inserted (or rescheduled) here needs its
    // spacing re-checked, not just the one earlier pass.
    repairedDays = traceRepairStep(attempt, stepIndex++, "insertMissingMeals", currentTripFrame, repairedDays, () =>
      repairedDays.map((day) => {
        const withMeals = insertMissingMeals(day, payload, profile, iterationMealNames, dayCount, arrivalDepartureWindow, recentMealHistory, cuisineWeights);
        return withMeals === day ? day : fillDerivedDayFields(resequenceDayItems(withMeals), payload, profile);
      })
    );
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceMealSpacing_2", currentTripFrame, repairedDays, () =>
      enforceMealSpacing(repairedDays, payload, profile)
    );
    // Defense in depth, same reasoning as enforceMealSpacing just above:
    // insertMissingMeals is now window-aware and should never insert an
    // infeasible meal in the first place, but re-running the window
    // enforcement here catches anything else this whole block (or any
    // earlier repair step not itself window-aware) could have pushed past
    // the real arrival/departure cutoff.
    repairedDays = traceRepairStep(attempt, stepIndex++, "enforceArrivalDepartureWindow_2", currentTripFrame, repairedDays, () =>
      enforceArrivalDepartureWindow(repairedDays, payload, profile, arrivalDepartureWindow, dayCount)
    );

    // Section "MAKE TRAVEL METRICS ACTUALLY ACTIVE" (Part A) — a real,
    // production repair pass over the plan's own already-computed
    // travelMinutes, mobility-profile-aware rather than a fixed constant.
    // A2/A3: day-trip/transfer days are explicitly exempt inside the
    // function itself, never penalized here.
    if (isPlannerQaTraceEnabled()) {
      // classifyDayType is precomputed against the real AiGeneratedDay
      // shape (isDayTripDay/isIntercityTransferDay need title/notes/
      // transportation/transportSegments, which computeItineraryTravelMetrics'
      // own minimal day type doesn't carry) and looked up by dayNumber —
      // both metric calls below only ever need the lookup. Gated behind the
      // QA flag itself (hygiene pass), not NODE_ENV — logGenerationStage
      // already no-ops without it, so this used to compute beforeMetrics/
      // afterMetrics on every plain `npm run dev` request for nothing.
      const classifyDayType = new Map(
        repairedDays.map((day) => [
          day.dayNumber,
          isDayTripDay(day) ? ("day_trip" as const) : isIntercityTransferDay(day) ? ("transfer" as const) : ("normal" as const),
        ])
      );
      const stayAnchorsInVisitOrder = currentTripFrame.phases
        .map((phase) => areaAnchors.get(phase.areaLabel))
        .filter((anchor): anchor is { lat: number; lon: number } => anchor != null);
      const beforeMetrics = computeItineraryTravelMetrics(
        repairedDays,
        (day) => classifyDayType.get(day.dayNumber) ?? "normal",
        stayAnchorsInVisitOrder
      );
      let travelRepair!: ReturnType<typeof repairNormalDayTravelOutliers>;
      repairedDays = traceRepairStep(attempt, stepIndex++, "repairNormalDayTravelOutliers", currentTripFrame, repairedDays, () => {
        travelRepair = repairNormalDayTravelOutliers(repairedDays, mobilityProfile, payload, profile, removedItemKeysByDay);
        return travelRepair.days;
      });
      const afterMetrics = computeItineraryTravelMetrics(
        repairedDays,
        (day) => classifyDayType.get(day.dayNumber) ?? "normal",
        stayAnchorsInVisitOrder
      );
      if (travelRepair.outliers.length > 0) {
        logGenerationStage("normal-day travel outlier repair", {
          outliers: travelRepair.outliers,
          before: beforeMetrics,
          after: afterMetrics,
        });
      }
    } else {
      repairedDays = repairNormalDayTravelOutliers(repairedDays, mobilityProfile, payload, profile, removedItemKeysByDay).days;
    }

    // Round 9.4.3 §C/§D/§G — a single, authoritative, idempotent cleanup
    // pass over exact-recommendationId duplicates, run once every attempt
    // AFTER every content-mutating repair step above (whichever of them
    // introduced a duplicate, this pass sees and resolves it — never a
    // per-function audit-and-patch of all twelve listed insertion paths,
    // which risks exactly the "broadly redesign repairPlan" this round
    // explicitly rules out). Monotonic by construction (only ever shrinks
    // an existing duplicate group's size, never creates one), so running
    // it unconditionally every attempt cannot itself cause the count to
    // rise again.
    const duplicatesBefore = isPlannerQaTraceEnabled() ? computeRealPlaceDuplicateGroups(repairedDays, currentTripFrame).length : 0;
    repairedDays = traceRepairStep(attempt, stepIndex++, "resolveExactIdDuplicates", currentTripFrame, repairedDays, () =>
      resolveExactIdDuplicates(repairedDays, currentTripFrame, areaAnchors, mobilityProfile, payload, profile)
    );
    if (isPlannerQaTraceEnabled()) {
      const duplicatesAfter = computeRealPlaceDuplicateGroups(repairedDays, currentTripFrame).length;
      logRealPlaceQA("DuplicateRepairAttempt", { attempt, duplicateCanonicalIdentitiesBefore: duplicatesBefore, duplicateCanonicalIdentitiesAfter: duplicatesAfter });
    }

    let computedCosts = buildCostsFromDays(repairedDays, payload.preferences.travelers, payload.preferences.flights);
    let totalEstimatedCost = computedCosts.totalEstimatedCost;
    let estimatedTransportCost = computedCosts.estimatedTransportCost;
    let averageDailyCost = computedCosts.averageDailyCost;
    let costPerTraveler =
      totalEstimatedCost != null && payload.preferences.travelers > 0
        ? Math.round(totalEstimatedCost / payload.preferences.travelers)
        : null;

    let repairedPlan: AiItineraryResponse = {
      title: raw.title || fallback.title,
      summary: raw.summary || fallback.summary,
      totalEstimatedCost,
      estimatedTransportCost,
      averageDailyCost,
      costPerTraveler,
      categoryBreakdown: computedCosts.categoryBreakdown,
      days: repairedDays,
    };

    let diagnostics = collectPlanDiagnostics(repairedPlan, profile, currentTripFrame, arrivalDepartureWindow, payload.preferences.flights, protectedGeographicConflicts, impossibleStayTransitionDetails, mobilityProfile);
    // A plan can pass every hard gate yet still score under the quality
    // target on advisory-only signals (spec item 81) — one extra
    // diversify pass when an attempt remains, never more than that (this
    // is a nudge, not a loop-until-perfect; the plan is still accepted
    // below regardless of the score after this single extra try).
    const qualifiesForQualityDiversify =
      !diagnostics.diversityRisk &&
      passesValidation(diagnostics) &&
      computeQualityScore(diagnostics) < QUALITY_SCORE_TARGET &&
      attempt < 3;

    if (diagnostics.diversityRisk || qualifiesForQualityDiversify) {
      repairedDays = traceRepairStep(attempt, stepIndex++, "diversifyActivities", currentTripFrame, repairedDays, () =>
        diversifyActivities(repairedDays, payload, profile, diagnostics.dominantCategory, diagnostics.activityMixSkew).map((day) =>
          fillDerivedDayFields(normalizeDayCollections(day), payload, profile)
        )
      );

      computedCosts = buildCostsFromDays(repairedDays, payload.preferences.travelers, payload.preferences.flights);
      totalEstimatedCost = computedCosts.totalEstimatedCost;
      estimatedTransportCost = computedCosts.estimatedTransportCost;
      averageDailyCost = computedCosts.averageDailyCost;
      costPerTraveler =
        totalEstimatedCost != null && payload.preferences.travelers > 0
          ? Math.round(totalEstimatedCost / payload.preferences.travelers)
          : null;
      repairedPlan = {
        title: raw.title || fallback.title,
        summary: raw.summary || fallback.summary,
        totalEstimatedCost,
        estimatedTransportCost,
        averageDailyCost,
        costPerTraveler,
        categoryBreakdown: computedCosts.categoryBreakdown,
        days: repairedDays,
      };
      diagnostics = collectPlanDiagnostics(repairedPlan, profile, currentTripFrame, arrivalDepartureWindow, payload.preferences.flights, protectedGeographicConflicts, impossibleStayTransitionDetails, mobilityProfile);
    }

    lastPlan = repairedPlan;
    if (passesValidation(diagnostics)) {
      const beforeFinalizeSnapshot = isPlannerQaTraceEnabled() ? snapshotDayItemsForRepairTrace(repairedPlan.days, currentTripFrame) : null;
      const finalPlan = finalizeArrivalDepartureContent(repairedPlan, payload, profile, dayCount, arrivalDepartureWindow, currentTripFrame, areaAnchors, mobilityProfile);
      if (beforeFinalizeSnapshot) {
        logRepairStepDelta(attempt, stepIndex++, "finalizeArrivalDepartureContent (in-loop)", beforeFinalizeSnapshot, snapshotDayItemsForRepairTrace(finalPlan.days, currentTripFrame));
      }
      // Round 8 — legality/hours/duplicates being zero is necessary but not
      // sufficient (spec "A legally safe but empty itinerary is not
      // acceptable"). A legally-clean plan that is still real-activity-poor
      // gets ONE more attempt (same "not a loop-until-perfect" shape as
      // qualifiesForQualityDiversify above) before being accepted anyway —
      // never blocks acceptance forever, since backfillRealActivities has
      // already run inside finalizeArrivalDepartureContent and a further
      // attempt draws from the same finite candidate pool.
      const qualityReport = validateItineraryQuality(finalPlan.days, currentTripFrame, arrivalDepartureWindow);
      if (passesQualityValidation(qualityReport) || attempt >= 3) {
        if (!passesQualityValidation(qualityReport)) {
          // Last attempt and still real-activity-poor — degrade explicitly
          // (spec §12A) rather than silently returning a synthetic-heavy
          // plan with no trace of why.
          logGenerationStage("itinerary quality: accepted with unresolved gaps after final attempt", { ...qualityReport });
        }
        if (isPlannerQaTraceEnabled()) {
          logRepairAttemptEnd(attempt, snapshotDayItemsForRepairTrace(finalPlan.days, currentTripFrame));
        }
        // Round 9.3.6.1 §1 — this used to return unconditionally once
        // attempt >= 3, regardless of qualityReport, making real-activity
        // coverage non-authoritative on the exact path most real multi-day
        // trips actually take. Same shared invariant as every other exit
        // now: throws only on the same unambiguous majority-synthetic
        // shape with a non-trivial real pool as always (never a fixed
        // POIs/day requirement); a genuinely small real pool still returns
        // normally here, unchanged.
        assertFinalRealActivityCoverage(finalPlan.days);
        // Round 9.4.3 §J — the final duplicate firewall, same boundary as
        // assertFinalRealActivityCoverage immediately above. resolveExactIdDuplicates
        // already runs every attempt, so this should never fire in
        // practice — it exists so a surviving exact-ID duplicate is
        // reported with its precise identity instead of silently
        // persisting or surfacing as a generic PLAN_NOT_FEASIBLE.
        assertNoRealPlaceDuplicatesRemain(finalPlan.days, currentTripFrame);
        return {
          ...finalPlan,
          summary: buildGenerationSummary(finalPlan, profile),
        };
      }
      // Retry: keep this plan as the best-so-far fallback and let the loop
      // continue (a fresh Gemini/deterministic attempt, or another
      // structural repair pass, may surface more usable real candidates).
      lastPlan = repairedPlan;
    }
    if (isPlannerQaTraceEnabled()) {
      logRepairAttemptEnd(attempt, snapshotDayItemsForRepairTrace(repairedDays, currentTripFrame));
    }
  }

  const finalFallbackPlan = finalizeArrivalDepartureContent(lastPlan ?? fallback, payload, profile, dayCount, arrivalDepartureWindow, currentTripFrame, areaAnchors, mobilityProfile);
  // Round 8 spec §12 — a failed generation is preferable to a useless
  // itinerary pretending to be complete. Deliberately conservative (see
  // assertRealActivityCoverage's own docstring): only throws on an
  // unambiguous majority-synthetic shape with a non-trivial candidate pool,
  // which is exactly the reported "38/44 lighter days" shape. Genuine
  // destination scarcity (a small/empty recommendation pool) degrades
  // silently instead, as it always has. Round 9.3.6.1 §12 — same shared
  // assertFinalRealActivityCoverage boundary as every other successful
  // exit above, not a separately-maintained duplicate.
  assertFinalRealActivityCoverage(finalFallbackPlan.days);
  // Round 9.4.3 §J — same final duplicate firewall as the in-loop success
  // exit above.
  assertNoRealPlaceDuplicatesRemain(finalFallbackPlan.days, currentTripFrame);
  return {
    ...finalFallbackPlan,
    summary: buildGenerationSummary(finalFallbackPlan, profile),
  };
}

function isPlanComplete(plan: RawGeneratedPlan, payload: AiItineraryRequest) {
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  return dayCount > 0 && Array.isArray(plan.days) && plan.days.length === dayCount;
}

// Phase 10/12/24 (generic worldwide architecture): foodDominantDays and
// diversityRisk are deliberately NOT in the hard gate below — real bug
// found in live QA: with zero real candidates (or a genuinely
// food-culture-heavy destination), a physically feasible, otherwise-sound
// itinerary kept failing validation purely on category variety, forcing a
// fallback to the generic template far more often than a real physical
// problem warranted. They still cost real points in computeQualityScore
// (a real repair target — qualifiesForQualityDiversify still triggers an
// extra diversifyActivities attempt when the score is low), they simply
// no longer block acceptance outright the way a genuine physical
// impossibility (missing meals, overlapping times, an impossible
// transfer) does.
export function passesValidation(diagnostics: ReturnType<typeof collectPlanDiagnostics>) {
  return (
    diagnostics.missingMeals === 0 &&
    diagnostics.duplicatePlaces === 0 &&
    diagnostics.duplicateWarnings === 0 &&
    diagnostics.overloadedDays === 0 &&
    diagnostics.missingAccommodation === 0 &&
    diagnostics.missingTransport === 0 &&
    diagnostics.avoidConflicts === 0 &&
    diagnostics.missingMustVisitKeywords.length === 0 &&
    diagnostics.invalidCoordinates === 0 &&
    diagnostics.crossCityDays === 0 &&
    diagnostics.longTravelDays === 0 &&
    diagnostics.missingAnchorDays === 0 &&
    diagnostics.longMealDetours === 0 &&
    diagnostics.baseMismatchDays === 0 &&
    !diagnostics.overSoftBudget &&
    !diagnostics.outOfBudget &&
    diagnostics.arrivalDepartureWindowViolations === 0 &&
    diagnostics.timeOverlaps === 0 &&
    diagnostics.openingHoursViolations === 0 &&
    diagnostics.excessFoodStopsDays === 0 &&
    diagnostics.mealSpacingViolations === 0 &&
    diagnostics.duplicateRestaurants === 0 &&
    diagnostics.invalidFlightLegs === 0 &&
    diagnostics.airportBaseMismatches === 0 &&
    diagnostics.impossibleStayTransitions === 0 &&
    (diagnostics.normalDayTravelOutliers ?? 0) === 0
  );
}

/**
 * Round 9.4.2 §C/§E — "PLAN STRUCTURE INVALID" vs "REAL PLACE SUPPLY
 * INVALID": a NARROWER gate than passesValidation, checking only fields
 * that indicate genuine structural/geographic/temporal/data-integrity
 * corruption — never a mere quality/pacing signal. Proven root cause
 * (traceId gen-mu7ihdq8-545bii8p): the composed plan failed ONLY
 * missingMeals/overloadedDays/longTravelDays (none of which corrupt the
 * 100+ real places already scheduled) and was discarded wholesale to a
 * legacy free-text Gemini path and then a StayActivityPool-unaware
 * deterministic template — losing every real place in the process. This
 * function is what lets generateCountryItineraryPlan tell "this plan's
 * REAL CONTENT is fine, it just isn't perfectly paced" apart from "this
 * plan is genuinely broken" — used ONLY to decide whether the composed
 * plan may be kept as a recovery checkpoint instead of discarded;
 * passesValidation itself is UNCHANGED and still governs the normal
 * success path exactly as before.
 *
 * Deliberately EXCLUDES (soft/pacing/preference signals, never real-place
 * corruption): missingMeals, overloadedDays, missingAccommodation,
 * missingTransport, missingMustVisitKeywords, longTravelDays,
 * longMealDetours, overSoftBudget, excessFoodStopsDays,
 * mealSpacingViolations, normalDayTravelOutliers.
 */
export function passesHardInvariantsForFallbackRecovery(diagnostics: ReturnType<typeof collectPlanDiagnostics>): boolean {
  return (
    diagnostics.duplicatePlaces === 0 &&
    diagnostics.duplicateWarnings === 0 &&
    diagnostics.avoidConflicts === 0 &&
    diagnostics.invalidCoordinates === 0 &&
    diagnostics.crossCityDays === 0 &&
    diagnostics.missingAnchorDays === 0 &&
    diagnostics.baseMismatchDays === 0 &&
    !diagnostics.outOfBudget &&
    diagnostics.arrivalDepartureWindowViolations === 0 &&
    diagnostics.timeOverlaps === 0 &&
    diagnostics.openingHoursViolations === 0 &&
    diagnostics.duplicateRestaurants === 0 &&
    diagnostics.invalidFlightLegs === 0 &&
    diagnostics.airportBaseMismatches === 0 &&
    diagnostics.impossibleStayTransitions === 0
  );
}

/** Dev-log-friendly summary of exactly which validation gates a plan failed (never all 18 — just the ones that are non-zero/true). */
function describeFailingDiagnostics(diagnostics: PlanDiagnostics): Record<string, number | boolean> {
  const failing: Record<string, number | boolean> = {};
  const numericFields: Array<keyof PlanDiagnostics> = [
    "missingMeals",
    "duplicatePlaces",
    "duplicateWarnings",
    "overloadedDays",
    "missingAccommodation",
    "missingTransport",
    "avoidConflicts",
    "invalidCoordinates",
    "crossCityDays",
    "longTravelDays",
    "normalDayTravelOutliers",
    "foodDominantDays",
    "missingAnchorDays",
    "longMealDetours",
    "baseMismatchDays",
    "arrivalDepartureWindowViolations",
    "timeOverlaps",
    "openingHoursViolations",
    "excessFoodStopsDays",
    "mealSpacingViolations",
    "duplicateRestaurants",
    "invalidFlightLegs",
    "airportBaseMismatches",
    "protectedGeographicConflicts",
    "impossibleStayTransitions",
  ];
  for (const field of numericFields) {
    const value = diagnostics[field];
    if (typeof value === "number" && value > 0) failing[field] = value;
  }
  if (diagnostics.missingMustVisitKeywords.length > 0) {
    failing.missingMustVisitKeywords = diagnostics.missingMustVisitKeywords.length;
  }
  if (diagnostics.overSoftBudget) failing.overSoftBudget = true;
  if (diagnostics.outOfBudget) failing.outOfBudget = true;
  if (diagnostics.diversityRisk) failing.diversityRisk = true;
  return failing;
}

function toRawGeneratedPlan(plan: AiItineraryResponse): RawGeneratedPlan {
  return {
    title: plan.title,
    summary: plan.summary,
    totalEstimatedCost: plan.totalEstimatedCost ?? undefined,
    estimatedTransportCost: plan.estimatedTransportCost ?? undefined,
    averageDailyCost: plan.averageDailyCost ?? undefined,
    costPerTraveler: plan.costPerTraveler ?? undefined,
    categoryBreakdown: plan.categoryBreakdown,
    days: plan.days.map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      title: day.title,
      cityRegion: day.cityRegion,
      accommodation: day.accommodation,
      notes: day.notes,
      transportation: day.transportation,
      estimatedCost: day.estimatedCost ?? undefined,
      activityCost: day.activityCost ?? undefined,
      foodCost: day.foodCost ?? undefined,
      transportCost: day.transportCost ?? undefined,
      accommodationCost: day.accommodationCost ?? undefined,
      totalTravelMinutes: day.totalTravelMinutes ?? undefined,
      warnings: day.warnings,
      alternatives: day.alternatives,
      bookingRequirements: day.bookingRequirements,
      safetyNotes: day.safetyNotes,
      restWindow: day.restWindow,
      transportSegments: day.transportSegments,
      items: day.items.map((item) => ({
        name: item.name,
        category: item.category,
        location: item.location,
        shortDescription: item.shortDescription,
        slot: item.slot,
        plannedStartTime: item.plannedStartTime,
        estimatedDurationMinutes: item.estimatedDurationMinutes ?? undefined,
        approximatePrice: item.approximatePrice ?? undefined,
        travelMinutes: item.travelMinutes ?? undefined,
        openingHours: item.openingHours,
        reservationRequired: item.reservationRequired,
        transportation: item.transportation,
        bookingWarning: item.bookingWarning,
        alternativeSuggestion: item.alternativeSuggestion,
      })),
    })),
  };
}

/**
 * Round 9 — a PRE-generation, per-stay day-type estimate (no Gemini output
 * exists yet, so day_trip can never be known this early — every non-
 * arrival/departure/transfer day is conservatively treated as "normal",
 * which is the right default for SIZING a candidate pool: a day_trip day
 * still wants real candidates). Used ONLY to size/target the refill pass
 * below; the real, item-aware deriveDayType is used everywhere once actual
 * days exist (finalizeArrivalDepartureContent and everything after it).
 */
export function estimatePreGenerationDayTypesByStay(
  tripFrame: TripFrame,
  dayCount: number,
  arrivalDepartureWindow: ArrivalDepartureWindow
): Map<string, StayDayCapacityInput[]> {
  const byStay = new Map<string, StayDayCapacityInput[]>();
  for (const phase of tripFrame.phases) byStay.set(phase.id, []);

  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const phase = findFramePhaseForDay(tripFrame, dayNumber);
    if (!phase) continue;
    const previousPhase = dayNumber > 1 ? findFramePhaseForDay(tripFrame, dayNumber - 1) : null;

    let dayType: DerivedDayType = "normal";
    let usableHours: number | null = null;
    if (dayNumber === 1 && arrivalDepartureWindow.earliestUsableTimeOnArrivalDay) {
      dayType = "arrival";
      const startMinutes = clockToMinutes(arrivalDepartureWindow.earliestUsableTimeOnArrivalDay.time);
      usableHours = startMinutes != null ? Math.max(0, (22 * 60 - startMinutes) / 60) : null;
    } else if (dayNumber === dayCount && arrivalDepartureWindow.latestUsableTimeOnDepartureDay) {
      dayType = "departure";
      const endMinutes = clockToMinutes(arrivalDepartureWindow.latestUsableTimeOnDepartureDay.time);
      usableHours = endMinutes != null ? Math.max(0, (endMinutes - 9 * 60) / 60) : null;
    } else if (previousPhase && previousPhase.id !== phase.id) {
      dayType = "transfer";
    }

    byStay.get(phase.id)!.push({ dayNumber, dayType, hasExplicitRestWindow: false, usableHours });
  }
  return byStay;
}

/**
 * Round 9 §4 — the ONE pre-generation entry point for real provider refill.
 * Builds a pool per stay from whatever candidates discovery already loaded
 * (payload.recommendations), and for any stay below its own
 * desiredCandidateCount, runs a bounded, stay-scoped, geography-bounded
 * Overpass refill (refillStayActivityPool) BEFORE Gemini ever sees the
 * pool — spec's own required order ("discover a LARGE real candidate pool
 * for that stay" happens before day construction, not mid-repair).
 * Strictly additive: on any provider failure the original payload is
 * returned unchanged, generation never blocks or fails because of this.
 */
/**
 * Round 9.1 §7 — a tiny bounded-concurrency mapper. No dependency added:
 * this is the entire "hard concurrency limit" the spec asks for. Runs
 * `worker` over `items`, never more than `limit` in flight at once. A
 * single item's rejection never aborts the others — callers are expected
 * to have already wrapped `worker` in its own try/catch when a failure
 * should degrade rather than propagate (refillTripRecommendationPool below
 * always does).
 */
async function mapWithConcurrencyLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runOne()));
  return results;
}

/** Round 9.1 §6/§7 — centralized, not scattered: how many stays refill concurrently, and the total wall-clock budget the WHOLE refill pass (every stay combined) may spend on the provider before stopping. Deliberately NOT the per-request Overpass timeout (fetchOverpass's own REQUEST_TIMEOUT_MS is untouched, per the round's own "do not increase timeouts") — this is an outer, cross-stay budget that stops issuing NEW rounds once exceeded, which is what actually bounds a many-stay trip's total refill time.
 *
 * Round 9.3.3 — raised from the original 12_000. Live-traced Overpass
 * round-trips against the real public API from this environment measured
 * 8_818-34_141ms for a SINGLE combined round-0 query (see the round's QA
 * trace). At 12s, any stay queued behind the first REFILL_CONCURRENCY_LIMIT
 * concurrent stays had its deadline already expired before it could even
 * start its one real provider attempt — real Chicago-anchor discovery in a
 * live replay ended with 0 candidates and ~50s spent, entirely consistent
 * with this. 60s keeps a real cross-stay ceiling (this is still the exact
 * mechanism that fixed the Round 9.1 11-minute/PLAN_NOT_FEASIBLE
 * regression — it must never go back to unbounded) while giving realistic
 * headroom, at the high end of measured latency, for multiple stays to
 * each get at least one real round-0 attempt through the shared
 * concurrency pool instead of being starved by a budget smaller than a
 * single query's own observed worst case. */
const REFILL_CONCURRENCY_LIMIT = 3;
const REFILL_GLOBAL_TIME_BUDGET_MS = 60_000;

export interface StayRefillOutcome {
  pool: StayActivityPool;
  addedCount: number;
}

/**
 * Round 9 §4, rebuilt in Round 9.1 to fix a real production regression: a
 * live 44-day/multi-stay US generation took ~11.2 minutes and ended in
 * PLAN_NOT_FEASIBLE, with real Overpass timeouts/ECONNREFUSED observed
 * during the SAME request. Root cause traced to this exact function: it
 * ran refillStayActivityPool SEQUENTIALLY, one stay at a time, with NO
 * overall time budget — a multi-stay trip where several stays' Overpass
 * calls are slow/failing waits out EVERY one of them in series (up to
 * ~2 rounds × ~50s worst-case per stay × N stays). Fixed here with (a) a
 * bounded-concurrency batch runner (never more than
 * REFILL_CONCURRENCY_LIMIT stays refilling at once) and (b) one GLOBAL
 * deadline shared by every stay's refillStayActivityPool call — once
 * passed, no stay starts a new round; whatever it already collected is
 * kept and its pool is marked `supplyDegraded`. Still additive/failure-
 * tolerant: any single stay's own throw is caught and never blocks the
 * others or the caller.
 */
/** Round 9.3.4 §3/§5 — one unit of GROUPED discovery work: either one stay's one activity query group, or one stay's meal-venue group. Flattening (stay × group) into a single array is what lets ONE shared mapWithConcurrencyLimit pool bound concurrency across stays AND groups together, rather than nesting a per-stay limiter inside a per-group limiter (which would multiply, not share, the ceiling). */
type DiscoveryWorkItem =
  | { kind: "activity"; phaseId: string; group: ActivityQueryGroupDefinition }
  | { kind: "meal"; phaseId: string };

interface PhaseDiscoveryState {
  pool: StayActivityPool;
  seenActivityKeys: Set<string>;
  seenMealKeys: Set<string>;
  groupResults: QueryGroupResult[];
  addedRecommendations: TripRecommendation[];
  addedMealRecommendations: TripRecommendation[];
}

/** Round 9.3.4 §2/§8 — uniform per-group fetch, whether the caller injected a simple test override or this is the real Overpass-backed path; both report the SAME QueryGroupResult shape so diagnostics never differ by code path. */
async function fetchDiscoveryGroupRaw(
  categories: RecommendationCategory[],
  anchor: { lat: number; lon: number },
  perCategoryLimit: number,
  fetchCandidatesOverride?: RefillOptions["fetchCandidates"]
): Promise<{
  results: OverpassGroupCandidate[];
  providerFailed: boolean;
  failureReason: string | null;
  rawElementCount: number;
  selectorCount: number;
  queryLength: number;
  elapsedMs: number;
  endpoint: string | null;
}> {
  if (fetchCandidatesOverride) {
    const startedAt = Date.now();
    try {
      const results = await fetchCandidatesOverride(anchor, ACTIVITY_DISCOVERY_RADIUS_CAP_KM, categories, perCategoryLimit);
      return { results, providerFailed: false, failureReason: null, rawElementCount: results.length, selectorCount: 0, queryLength: 0, elapsedMs: Date.now() - startedAt, endpoint: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : message;
      return { results: [], providerFailed: true, failureReason: reason, rawElementCount: 0, selectorCount: 0, queryLength: 0, elapsedMs: Date.now() - startedAt, endpoint: null };
    }
  }
  return queryNearbyRecommendationsDetailed(anchor.lat, anchor.lon, ACTIVITY_DISCOVERY_RADIUS_CAP_KM * 1000, categories, perCategoryLimit);
}

/**
 * Round 9.3.5 — the one activity-group work item body, extracted so both
 * the INITIAL grouped discovery pass (refillTripRecommendationPool) and
 * the NEW bounded final-supply refill (refillDeficientStaysAfterReallocation,
 * below) apply the EXACT same early-stop / shared-deadline / partial-
 * success / cross-group-dedupe rules — never two subtly different
 * discovery implementations to keep in sync.
 */
async function runActivityGroupWorkItem(
  state: PhaseDiscoveryState,
  group: ActivityQueryGroupDefinition,
  anchor: { lat: number; lon: number },
  mobilityProfile: DestinationMobilityProfile,
  dailyCapacityMinutes: number,
  mustVisitKeywords: string[],
  deadline: number,
  fetchCandidatesOverride?: RefillOptions["fetchCandidates"]
): Promise<void> {
  // §14 EARLY STOP — re-checked at dequeue time, not just at enqueue time,
  // since an earlier group for this SAME stay may have already satisfied
  // it while this item was queued behind the concurrency limit.
  if (state.pool.candidates.length >= state.pool.desiredCandidateCount) {
    state.groupResults.push(emptyGroupResult(group.groupId, "SKIPPED_ENOUGH_SUPPLY"));
    return;
  }
  // §6 SHARED DEADLINE — checked before starting, never mid-flight.
  if (Date.now() >= deadline) {
    state.groupResults.push(emptyGroupResult(group.groupId, "SKIPPED_DEADLINE"));
    state.pool = { ...state.pool, diagnostics: { ...state.pool.diagnostics, supplyDegraded: true } };
    return;
  }
  const detail = await fetchDiscoveryGroupRaw(group.categories, anchor, 8, fetchCandidatesOverride);
  const outcome = classifyQueryGroupOutcome(detail);
  const diagnostics = { ...state.pool.diagnostics };
  diagnostics.refillAttempts += 1;
  diagnostics.providerElapsedMs += detail.elapsedMs;
  let acceptedCount = 0;
  if (detail.providerFailed) {
    diagnostics.providerFailures += 1;
    if (outcome === "TIMEOUT") diagnostics.providerTimeouts += 1;
  } else if (detail.results.length > 0) {
    // §7 PARTIAL SUCCESS IS SUCCESSFUL SUPPLY — this group's own accepted
    // candidates are merged in regardless of any OTHER group's outcome;
    // §9 cross-group dedupe is the shared seenActivityKeys set every group
    // for this stay writes into.
    const candidates = [...state.pool.candidates];
    const result = acceptRawCandidatesIntoPool(
      detail.results,
      { candidates, seenKeys: state.seenActivityKeys, diagnostics },
      { anchor, mobilityProfile, dailyCapacityMinutes, mustVisitKeywords, desiredCandidateCount: state.pool.desiredCandidateCount }
    );
    acceptedCount = result.acceptedCount;
    state.addedRecommendations.push(...result.addedRecommendations);
    state.pool = { ...state.pool, candidates, categorySupply: diagnostics.classificationBreakdown };
  }
  state.pool = { ...state.pool, diagnostics };
  state.groupResults.push({
    groupId: group.groupId,
    selectorCount: detail.selectorCount,
    queryLength: detail.queryLength,
    attempts: 1,
    endpointResults: [detail.endpoint ?? "none"],
    rawElementCount: detail.rawElementCount,
    normalizedCandidateCount: detail.results.length,
    acceptedCandidateCount: acceptedCount,
    elapsedMs: detail.elapsedMs,
    outcome,
  });
}

export async function refillTripRecommendationPool(
  payload: AiItineraryRequest,
  tripFrame: TripFrame,
  dayCount: number,
  arrivalDepartureWindow: ArrivalDepartureWindow,
  profile: TripPreferenceProfile,
  /** Injectable — tests pass a fake to avoid any real network call; production omits this and gets the real Overpass-backed default. */
  fetchCandidatesOverride?: RefillOptions["fetchCandidates"],
  /** Injectable — tests pass a short budget to exercise degradation without a real 12s wait; production omits this and gets REFILL_GLOBAL_TIME_BUDGET_MS. */
  globalTimeBudgetMsOverride?: number,
  /** Round 9.3.3 §22 — called once per stay, right when that stay's OWN real discovery attempt has actually finished (success, skip, or failure) — never on a timer, never before the stay's own pool is settled. */
  onStayDiscovered?: (completed: number, total: number) => void
): Promise<{ payload: AiItineraryRequest; poolsByStay: Map<string, StayActivityPool> }> {
  if (tripFrame.phases.length === 0) return { payload, poolsByStay: new Map() };

  const areaAnchors = resolveAreaAnchorsForFrame(tripFrame, computeAreaAnchors(payload));
  const mobilityProfile = computeDestinationMobilityProfile([...payload.recommendations, ...payload.selectedPlaces]);
  const dailyCapacityMinutes = profile.dailyCapacityMinutes;
  const dayTypesByStay = estimatePreGenerationDayTypesByStay(tripFrame, dayCount, arrivalDepartureWindow);
  const ownershipByStay = assignCandidatesToStays(
    payload.recommendations,
    tripFrame,
    areaAnchors,
    normalizeAreaLabel,
    resolveTextualAreaMatch
  );

  const deadline = Date.now() + (globalTimeBudgetMsOverride ?? REFILL_GLOBAL_TIME_BUDGET_MS);
  const poolsByStay = new Map<string, StayActivityPool>();
  const totalStays = tripFrame.phases.length;

  // --- Build every stay's initial pool + discovery state up front (cheap, sync). ---
  const stateByPhaseId = new Map<string, PhaseDiscoveryState>();
  for (const phase of tripFrame.phases) {
    const capacity = computeStayCapacity(dayTypesByStay.get(phase.id) ?? []);
    const anchor = areaAnchors.get(phase.areaLabel) ?? null;
    const pool = buildStayActivityPool(
      phase,
      ownershipByStay.get(phase.id) ?? [],
      anchor,
      mobilityProfile,
      capacity,
      profile.mustVisitKeywords,
      dailyCapacityMinutes
    );
    stateByPhaseId.set(phase.id, {
      pool,
      seenActivityKeys: new Set(pool.candidates.map((c) => c.recommendationId)),
      seenMealKeys: new Set(),
      groupResults: [],
      addedRecommendations: [],
      addedMealRecommendations: [],
    });
  }

  // --- Round 9.3.4 §3/§4 — flatten (stay × query group) into ONE priority-ordered queue. ---
  const orderedGroups = orderActivityQueryGroupsByPreference([...profile.strongPreferences, ...profile.softPreferences]);
  const needsActivityDiscovery = (phase: TripFramePhase) => {
    const state = stateByPhaseId.get(phase.id)!;
    return state.pool.anchor != null && state.pool.candidates.length < state.pool.desiredCandidateCount;
  };
  const workItems: DiscoveryWorkItem[] = [];
  for (const [groupIndex, group] of orderedGroups.entries()) {
    for (const phase of tripFrame.phases) {
      if (needsActivityDiscovery(phase)) workItems.push({ kind: "activity", phaseId: phase.id, group });
    }
    // Round 9.3.4 continuation — meal discovery interleaved right after the
    // FIRST (highest-priority) activity group's items, not appended after
    // ALL activity groups. Measured, not assumed: with meal appended last,
    // a single-stay trip's 3 concurrent activity groups (concurrency limit
    // 3) filled every slot immediately, so the meal work item never started
    // until the FIRST activity group finished — a real recorded 15s delay
    // in this environment before the meal query even began, on top of its
    // own multi-second latency, made it far more likely to miss the shared
    // deadline or get squeezed into whatever budget remained than an
    // isolated call ever would. Interleaving it here gives it a fair,
    // early concurrency slot instead of being queued dead-last.
    if (groupIndex === 0) {
      for (const phase of tripFrame.phases) {
        if (areaAnchors.get(phase.areaLabel) != null) workItems.push({ kind: "meal", phaseId: phase.id });
      }
    }
  }

  await mapWithConcurrencyLimit(workItems, REFILL_CONCURRENCY_LIMIT, async (item) => {
    const state = stateByPhaseId.get(item.phaseId)!;
    const anchor = state.pool.anchor;
    if (!anchor) return;

    if (item.kind === "activity") {
      await runActivityGroupWorkItem(state, item.group, anchor, mobilityProfile, dailyCapacityMinutes, profile.mustVisitKeywords, deadline, fetchCandidatesOverride);
      return;
    }

    // item.kind === "meal"
    if (Date.now() >= deadline) return; // §6 — same shared deadline governs the meal group too
    const detail = await fetchDiscoveryGroupRaw(MEAL_QUERY_GROUP.categories, anchor, 8, fetchCandidatesOverride);
    if (!detail.providerFailed && detail.results.length > 0) {
      const result = acceptRawMealCandidates(detail.results, state.seenMealKeys, { anchor, mobilityProfile, dailyCapacityMinutes });
      state.addedMealRecommendations.push(...result.addedRecommendations);
    }
  });

  // --- Round 1+ single-most-undersupplied-category top-up (unchanged, existing, already-small mechanism) for any stay STILL below its desired count. ---
  const stillNeedingPhases = tripFrame.phases.filter((phase) => needsActivityDiscovery(phase));
  await mapWithConcurrencyLimit(stillNeedingPhases, REFILL_CONCURRENCY_LIMIT, async (phase) => {
    const state = stateByPhaseId.get(phase.id)!;
    if (Date.now() >= deadline) {
      state.pool = { ...state.pool, diagnostics: { ...state.pool.diagnostics, supplyDegraded: true } };
      return;
    }
    const { pool: refilledPool, addedRecommendations: added } = await refillStayActivityPool(
      state.pool,
      mobilityProfile,
      dailyCapacityMinutes,
      profile.mustVisitKeywords,
      { ...(fetchCandidatesOverride ? { fetchCandidates: fetchCandidatesOverride } : {}), deadline, skipRound0: true, maxRounds: 2 }
    ).catch(() => ({ pool: { ...state.pool, diagnostics: { ...state.pool.diagnostics, supplyDegraded: true } }, addedRecommendations: [] as TripRecommendation[] }));
    state.pool = refilledPool;
    state.addedRecommendations.push(...added);
  });

  const allAddedRecommendations: TripRecommendation[] = [];
  let discoveredCount = 0;
  for (const phase of tripFrame.phases) {
    const state = stateByPhaseId.get(phase.id)!;
    const finalPool: StayActivityPool = {
      ...state.pool,
      diagnostics: {
        ...state.pool.diagnostics,
        resolvedCandidateCount: state.pool.candidates.length,
        legalCandidateCount: state.pool.candidates.length,
        supplyDegraded: state.pool.diagnostics.supplyDegraded || state.pool.candidates.length < state.pool.desiredCandidateCount,
        groupResults: state.groupResults,
      },
    };
    poolsByStay.set(phase.id, finalPool);
    allAddedRecommendations.push(...state.addedRecommendations, ...state.addedMealRecommendations);
    if (isPlannerQaTraceEnabled()) logStayActivityPoolQA(finalPool);
    discoveredCount += 1;
    onStayDiscovered?.(discoveredCount, totalStays);
  }

  const nextPayload = allAddedRecommendations.length === 0 ? payload : { ...payload, recommendations: [...payload.recommendations, ...allAddedRecommendations] };
  return { payload: nextPayload, poolsByStay };
}

/** Round 9.3.5 — bounded, separate from the initial 60s discovery pass: this only tops up stays that ALREADY discovered something but whose FINAL (post-reallocation) requirement grew past it, so a much shorter budget is appropriate (it is never doing first-time discovery for a stay with zero anchor). */
const FINAL_SUPPLY_REFILL_BUDGET_MS = 25_000;

export interface FinalSupplyRefillResult {
  payload: AiItineraryRequest;
  poolsByStay: Map<string, StayActivityPool>;
  /** Round 9.3.5 §17 — which stays were actually found deficient and refilled, for the failure diagnostic and QA trace; empty when every stay's existing pool already met its FINAL requirement. */
  refilledStayIds: string[];
}

/**
 * Round 9.3.5 — THE root-cause fix for "real candidates exist but don't
 * reach enough days": night reallocation/reserve promotion can change a
 * stay's FINAL duration well after its OWN discovery pass already
 * early-stopped against the SMALLER preliminary target (measured and
 * confirmed this round — a stay whose nights grow from 3 to 9 needs ~3x
 * the real anchors its own pre-reallocation desiredCandidateCount ever
 * aimed for, and nothing before this function ever revisited that pool).
 *
 * Called ONCE, after tripFrame is truly FINAL (post-reallocation, post
 * reserve-promotion), against dayTypesByStay computed from that SAME final
 * frame. For every phase, the pool's OWN target fields
 * (requiredRealActivityTarget/desiredCandidateCount/minimumViableCandidateCount)
 * are first resized to reflect the final requirement — regardless of
 * whether a refill actually runs, so nothing downstream ever compares
 * against a stale target again. Only phases that are STILL short of their
 * (possibly now-larger) minimum-viable floor get a real, bounded, grouped,
 * concurrency-limited, early-stop-respecting refill — reusing
 * runActivityGroupWorkItem unchanged (§5/§6/§7/§9/§14 all apply exactly as
 * they do in the initial pass). A healthy stay is never re-queried.
 */
export async function refillDeficientStaysAfterReallocation(
  payload: AiItineraryRequest,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  profile: TripPreferenceProfile,
  poolsByStay: Map<string, StayActivityPool>,
  finalDayTypesByStay: Map<string, StayDayCapacityInput[]>,
  /** Injectable — tests pass a fake to avoid any real network call; production omits this and gets the real Overpass-backed default. */
  fetchCandidatesOverride?: RefillOptions["fetchCandidates"],
  /** Injectable — tests pass a short budget for deterministic timing. */
  globalTimeBudgetMsOverride?: number
): Promise<FinalSupplyRefillResult> {
  const dailyCapacityMinutes = profile.dailyCapacityMinutes;
  const deadline = Date.now() + (globalTimeBudgetMsOverride ?? FINAL_SUPPLY_REFILL_BUDGET_MS);
  const resizedPoolsByStay = new Map(poolsByStay);
  const stateByPhaseId = new Map<string, PhaseDiscoveryState>();
  const deficientPhases: TripFramePhase[] = [];

  for (const phase of tripFrame.phases) {
    const existingPool = resizedPoolsByStay.get(phase.id);
    if (!existingPool) continue;
    const finalCapacity = computeStayCapacity(finalDayTypesByStay.get(phase.id) ?? []);
    const finalRequiredTarget = finalCapacity.requiredRealActivityTarget;
    const resizedPool: StayActivityPool = {
      ...existingPool,
      requiredRealActivityTarget: finalRequiredTarget,
      desiredCandidateCount: computeDesiredCandidateCount(finalRequiredTarget),
      minimumViableCandidateCount: computeMinimumViableCandidateCount(finalRequiredTarget),
    };
    resizedPoolsByStay.set(phase.id, resizedPool);
    if (!resizedPool.anchor) continue; // no anchor — nothing a refill could ever search around
    if (resizedPool.candidates.length < resizedPool.minimumViableCandidateCount) {
      deficientPhases.push(phase);
      stateByPhaseId.set(phase.id, {
        pool: resizedPool,
        seenActivityKeys: new Set(resizedPool.candidates.map((c) => c.recommendationId)),
        seenMealKeys: new Set(),
        groupResults: [...(resizedPool.diagnostics.groupResults ?? [])],
        addedRecommendations: [],
        addedMealRecommendations: [],
      });
    }
  }

  if (deficientPhases.length === 0) {
    return { payload, poolsByStay: resizedPoolsByStay, refilledStayIds: [] };
  }

  logGenerationStage("[StaySupplyQA] final-duration supply deficit detected — bounded refill", {
    deficientStays: deficientPhases.map((p) => ({ stayId: p.id, owner: p.areaLabel, nights: p.nights })),
  });

  const orderedGroups = orderActivityQueryGroupsByPreference([...profile.strongPreferences, ...profile.softPreferences]);
  const needsMore = (phase: TripFramePhase) => {
    const state = stateByPhaseId.get(phase.id)!;
    return state.pool.candidates.length < state.pool.desiredCandidateCount;
  };
  const workItems: DiscoveryWorkItem[] = [];
  for (const group of orderedGroups) {
    for (const phase of deficientPhases) {
      if (needsMore(phase)) workItems.push({ kind: "activity", phaseId: phase.id, group });
    }
  }

  await mapWithConcurrencyLimit(workItems, REFILL_CONCURRENCY_LIMIT, async (item) => {
    const state = stateByPhaseId.get(item.phaseId)!;
    const anchor = state.pool.anchor;
    if (!anchor || item.kind !== "activity") return;
    await runActivityGroupWorkItem(state, item.group, anchor, mobilityProfile, dailyCapacityMinutes, profile.mustVisitKeywords, deadline, fetchCandidatesOverride);
  });

  const allAdded: TripRecommendation[] = [];
  const refilledStayIds: string[] = [];
  for (const phase of deficientPhases) {
    const state = stateByPhaseId.get(phase.id)!;
    const finalPool: StayActivityPool = {
      ...state.pool,
      diagnostics: {
        ...state.pool.diagnostics,
        resolvedCandidateCount: state.pool.candidates.length,
        legalCandidateCount: state.pool.candidates.length,
        supplyDegraded: state.pool.diagnostics.supplyDegraded || state.pool.candidates.length < state.pool.desiredCandidateCount,
        groupResults: state.groupResults,
      },
    };
    resizedPoolsByStay.set(phase.id, finalPool);
    allAdded.push(...state.addedRecommendations);
    refilledStayIds.push(phase.id);
    if (isPlannerQaTraceEnabled()) logStayActivityPoolQA(finalPool);
  }

  const nextPayload = allAdded.length === 0 ? payload : { ...payload, recommendations: [...payload.recommendations, ...allAdded] };
  return { payload: nextPayload, poolsByStay: resizedPoolsByStay, refilledStayIds };
}

function emptyGroupResult(groupId: string, outcome: QueryGroupOutcome): QueryGroupResult {
  return {
    groupId,
    selectorCount: 0,
    queryLength: 0,
    attempts: 0,
    endpointResults: [],
    rawElementCount: 0,
    normalizedCandidateCount: 0,
    acceptedCandidateCount: 0,
    elapsedMs: 0,
    outcome,
  };
}

/** Spec §37 [StayActivityPoolQA] — QA-gated only, never spams normal production logs. */
function logStayActivityPoolQA(pool: StayActivityPool): void {
  logGenerationStage("[StayActivityPoolQA]", {
    stayId: pool.stayId,
    owner: pool.ownerArea,
    usableDays: pool.usableDayCapacity,
    requiredRealActivities: pool.requiredRealActivityTarget,
    desiredCandidateCount: pool.desiredCandidateCount,
    initialCandidates: pool.diagnostics.initialCandidateCount,
    refillCandidates: pool.diagnostics.refillCandidateCount,
    finalLegalCandidates: pool.diagnostics.legalCandidateCount,
    categorySupply: pool.categorySupply,
    providerFailures: pool.diagnostics.providerFailures,
    dedupeRejected: pool.diagnostics.dedupeRejected,
    geographyRejected: pool.diagnostics.geographyRejected,
  });
}

export interface PlanFailureClassification {
  code: "PLAN_NOT_FEASIBLE" | "BUDGET_NOT_FEASIBLE" | "INSUFFICIENT_REAL_ACTIVITY_SUPPLY" | "REAL_PLACE_DISCOVERY_UNAVAILABLE";
  primaryFailure: "budget" | "provider_supply" | "duplicates" | "geography";
  secondaryFailures: string[];
  stayFailures: StayFailureDetail[];
}

function buildStayFailureDetails(poolsByStay: Map<string, StayActivityPool>): StayFailureDetail[] {
  return [...poolsByStay.values()].map((pool) => {
    const belowMinimum = pool.requiredRealActivityTarget > 0 && pool.diagnostics.legalCandidateCount < pool.minimumViableCandidateCount;
    return {
      stayId: pool.stayId,
      owner: pool.ownerArea,
      requiredRealActivities: pool.requiredRealActivityTarget,
      desiredCandidates: pool.desiredCandidateCount,
      legalCandidates: pool.diagnostics.legalCandidateCount,
      providerRequests: pool.diagnostics.refillAttempts,
      providerFailures: pool.diagnostics.providerFailures,
      supplyDegraded: pool.diagnostics.supplyDegraded,
      belowMinimum,
      supplyState: classifyStaySupplyState({ belowMinimum, providerFailures: pool.diagnostics.providerFailures }),
    };
  });
}

/**
 * Round 9.3.3 continuation §7 — a stay counts as CATASTROPHICALLY
 * discovery-unavailable only when ALL of: it genuinely needed real content
 * (requiredRealActivities > 0), it ended up with literally zero legal real
 * candidates, and at least one real provider outage/timeout actually
 * happened. A stay with SOME real candidates (even if below its minimum)
 * is a partial failure, not catastrophic — spec's own "partial provider
 * failure must NOT automatically fail generation if enough verified real
 * supply was successfully collected" (judged trip-wide by the existing
 * classifyPlanFailure/fallback-validation flow, unchanged).
 */
function isCatastrophicallyDiscoveryUnavailable(stay: StayFailureDetail): boolean {
  return stay.requiredRealActivities > 0 && stay.legalCandidates === 0 && stay.providerFailures > 0;
}

/**
 * Round 9.3.7 — the trip-level analogue of StaySupplyState/supplyState:
 * whether the WHOLE trip's real-place discovery is viable, not whether any
 * one stay individually is. The old decision (`classifyPlanFailure`/the
 * unconditional fallback-template check) treated ANY single catastrophic
 * stay as fatal for the entire generation — a real 43-day/7-stay US trip
 * with a genuine 3/3-provider-outage on ONE stay (New York) was thrown
 * away after ~4 minutes of otherwise-healthy work on the other 6 stays.
 * HEALTHY: no stay is catastrophically discovery-unavailable. CATASTROPHIC:
 * the trip genuinely cannot produce a minimally meaningful real-place
 * itinerary — a single-stay trip whose only stay failed, every stay
 * failing, or failed stays collectively owning a MAJORITY of the trip's
 * normal days (reusing assertRealActivityCoverage's own established >50%
 * "majority" bar, never a new invented threshold). Anything else with at
 * least one catastrophic stay is PARTIALLY_DEGRADED — the trip continues,
 * and the EXISTING per-day/per-stay coverage machinery
 * (assertRealActivityCoverage, extended below) is what actually decides
 * whether the final result is honestly acceptable.
 */
export type TripDiscoveryHealthState = "HEALTHY" | "PARTIALLY_DEGRADED" | "CATASTROPHIC_PROVIDER_FAILURE";

export interface TripDiscoveryHealthAssessment {
  tripSupplyState: TripDiscoveryHealthState;
  totalStays: number;
  healthyStays: number;
  providerFailedStays: number;
  totalNormalDays: number;
  failedNormalDays: number;
  totalRealActivityCandidates: number;
  recoverableFailedStays: number;
  unrecoverableFailedStays: number;
  stayFailures: StayFailureDetail[];
}

/**
 * Round 9.3.7 §B — a pure function so the trip-level decision itself is
 * directly unit-testable, same discipline as classifyPlanFailure. Reads
 * `recoveredStayIds` (populated by attemptBoundedRecoveryForFailedStays)
 * only to report recoverable-vs-unrecoverable counts truthfully — it
 * never changes a stay's own supplyState/providerFailures (see
 * attemptBoundedStayRecovery's own docstring: recovery must never lie
 * about provider health).
 */
export function assessTripDiscoveryHealth(
  poolsByStay: Map<string, StayActivityPool>,
  tripFrame: TripFrame,
  startDate: string,
  arrivalDepartureWindow: ArrivalDepartureWindow,
  recoveredStayIds: ReadonlySet<string> = new Set()
): TripDiscoveryHealthAssessment {
  const stayFailures = buildStayFailureDetails(poolsByStay);
  const totalStays = stayFailures.length;
  const catastrophicStays = stayFailures.filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay));
  const catastrophicStayIds = new Set(catastrophicStays.map((stay) => stay.stayId));
  const healthyStays = stayFailures.filter((stay) => !stay.belowMinimum).length;
  const totalRealActivityCandidates = stayFailures.reduce((sum, stay) => sum + stay.legalCandidates, 0);

  let totalNormalDays = 0;
  let failedNormalDays = 0;
  for (const phase of tripFrame.phases) {
    const isPhaseCatastrophic = catastrophicStayIds.has(phase.id);
    for (let dayNumber = phase.startDayNumber; dayNumber <= phase.endDayNumber; dayNumber += 1) {
      const date = dateForDayNumber(startDate, dayNumber) || startDate;
      const dayType = deriveDayType({ dayNumber, date, items: [] }, tripFrame, arrivalDepartureWindow);
      if (dayType !== "normal") continue;
      totalNormalDays += 1;
      if (isPhaseCatastrophic) failedNormalDays += 1;
    }
  }

  const recoverableFailedStays = catastrophicStays.filter((stay) => recoveredStayIds.has(stay.stayId)).length;
  const unrecoverableFailedStays = catastrophicStays.length - recoverableFailedStays;

  const isSingleStayTrip = totalStays <= 1;
  const allStaysCatastrophic = catastrophicStays.length > 0 && catastrophicStays.length === totalStays;
  const failedDayRatio = totalNormalDays > 0 ? failedNormalDays / totalNormalDays : 0;
  const majorityDaysFailed = failedDayRatio > 0.5;

  const tripSupplyState: TripDiscoveryHealthState =
    catastrophicStays.length === 0
      ? "HEALTHY"
      : isSingleStayTrip || allStaysCatastrophic || majorityDaysFailed
        ? "CATASTROPHIC_PROVIDER_FAILURE"
        : "PARTIALLY_DEGRADED";

  return {
    tripSupplyState,
    totalStays,
    healthyStays,
    providerFailedStays: catastrophicStays.length,
    totalNormalDays,
    failedNormalDays,
    totalRealActivityCandidates,
    recoverableFailedStays,
    unrecoverableFailedStays,
    stayFailures,
  };
}

/**
 * Round 9.3.7 §C — bounded recovery for ONE catastrophically-discovery-
 * unavailable stay, using ONLY data already loaded in this generation.
 * `assignCandidatesToStays` (the ownership assignment every activity pool
 * already goes through) is called with `payload.recommendations`
 * EVERYWHERE in this pipeline — `payload.selectedPlaces` (a user's own
 * explicitly chosen/must-visit real places) is never assigned to any
 * stay's pool at all. That is a genuine, previously-unused recovery
 * source, not a duplicate of what discovery already tried: reusing it
 * here requires no new network request, no new provider budget, and can
 * never borrow another stay's candidates (ownership is the SAME
 * nearest-anchor/text-match rule every other candidate uses). The stay's
 * pool is rebuilt via buildStayActivityPool — the same function every
 * other pool in this pipeline is built with, so legality/classification/
 * meal-venue exclusion are identical, never a relaxed or parallel rule.
 */
export function attemptBoundedStayRecovery(
  phase: TripFramePhase,
  payload: AiItineraryRequest,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  profile: TripPreferenceProfile,
  existingPool: StayActivityPool,
  dayTypesByStay: Map<string, StayDayCapacityInput[]>
): { pool: StayActivityPool; recovered: boolean; recoveredRecommendations: TripRecommendation[] } {
  const alreadyOwnedIds = new Set(payload.recommendations.map((rec) => rec.id));
  const unownedSelectedPlaces = payload.selectedPlaces.filter((place) => !alreadyOwnedIds.has(place.id));
  if (unownedSelectedPlaces.length === 0) {
    return { pool: existingPool, recovered: false, recoveredRecommendations: [] };
  }

  const selectedPlaceOwnership = assignCandidatesToStays(unownedSelectedPlaces, tripFrame, areaAnchors, normalizeAreaLabel, resolveTextualAreaMatch);
  const recoveredForThisStay = selectedPlaceOwnership.get(phase.id) ?? [];
  if (recoveredForThisStay.length === 0) {
    return { pool: existingPool, recovered: false, recoveredRecommendations: [] };
  }

  const recommendationOwnership = assignCandidatesToStays(payload.recommendations, tripFrame, areaAnchors, normalizeAreaLabel, resolveTextualAreaMatch);
  const alreadyOwnedForThisStay = recommendationOwnership.get(phase.id) ?? [];

  const capacity = computeStayCapacity(dayTypesByStay.get(phase.id) ?? []);
  const rebuiltPool = buildStayActivityPool(
    phase,
    [...alreadyOwnedForThisStay, ...recoveredForThisStay],
    existingPool.anchor,
    mobilityProfile,
    capacity,
    profile.mustVisitKeywords,
    profile.dailyCapacityMinutes
  );

  // Recovery found candidates ATTRIBUTED to this stay's area, but none
  // survived legality (evaluateScheduledPlaceLegality, the same gate
  // every other candidate must pass) — never claim recovery succeeded
  // when nothing legally usable came of it.
  if (rebuiltPool.candidates.length === 0) {
    return { pool: existingPool, recovered: false, recoveredRecommendations: [] };
  }

  const recoveredPool: StayActivityPool = {
    ...rebuiltPool,
    diagnostics: {
      ...rebuiltPool.diagnostics,
      // Round 9.3.7 §G/§D — a successful bounded recovery must never erase
      // the fact that a real provider outage genuinely happened: the
      // ORIGINAL provider telemetry survives unchanged even though the
      // stay may now continue with real (non-Overpass-sourced) content.
      refillAttempts: existingPool.diagnostics.refillAttempts,
      providerFailures: existingPool.diagnostics.providerFailures,
      providerElapsedMs: existingPool.diagnostics.providerElapsedMs,
      providerTimeouts: existingPool.diagnostics.providerTimeouts,
    },
  };

  return { pool: recoveredPool, recovered: true, recoveredRecommendations: recoveredForThisStay };
}

/**
 * Round 9.3.7 §C — runs attemptBoundedStayRecovery for every
 * catastrophically-discovery-unavailable stay in the trip. Never touches a
 * healthy stay (spec §H — "healthy stays are never re-queried by
 * recovery"; there is no query here at all, but the SAME no-touch
 * guarantee applies to the reuse-existing-data path). Never adds a
 * network request, never extends a budget/deadline.
 */
export function attemptBoundedRecoveryForFailedStays(
  payload: AiItineraryRequest,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile,
  profile: TripPreferenceProfile,
  poolsByStay: Map<string, StayActivityPool>,
  dayTypesByStay: Map<string, StayDayCapacityInput[]>
): { payload: AiItineraryRequest; poolsByStay: Map<string, StayActivityPool>; recoveredStayIds: string[] } {
  const stayFailures = buildStayFailureDetails(poolsByStay);
  const catastrophicStayIds = new Set(
    stayFailures.filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay)).map((stay) => stay.stayId)
  );
  if (catastrophicStayIds.size === 0) {
    return { payload, poolsByStay, recoveredStayIds: [] };
  }

  const updatedPools = new Map(poolsByStay);
  let updatedPayload = payload;
  const recoveredStayIds: string[] = [];
  for (const phase of tripFrame.phases) {
    if (!catastrophicStayIds.has(phase.id)) continue;
    const existingPool = updatedPools.get(phase.id);
    if (!existingPool) continue;
    const result = attemptBoundedStayRecovery(phase, updatedPayload, tripFrame, areaAnchors, mobilityProfile, profile, existingPool, dayTypesByStay);
    if (!result.recovered) continue;
    updatedPools.set(phase.id, result.pool);
    if (result.recoveredRecommendations.length > 0) {
      updatedPayload = { ...updatedPayload, recommendations: [...updatedPayload.recommendations, ...result.recoveredRecommendations] };
    }
    recoveredStayIds.push(phase.id);
  }
  if (recoveredStayIds.length > 0) {
    logGenerationStage("[StaySupplyQA] bounded recovery from existing data (selectedPlaces) for provider-failed stays", { recoveredStayIds });
  }
  return { payload: updatedPayload, poolsByStay: updatedPools, recoveredStayIds };
}

/**
 * Round 9.1 §16/§17 — THE decision point between a genuine SUPPLY failure
 * (a stay's own legal candidate pool never reached its minimum-viable
 * floor, even after bounded refill) and a PLANNER/QUALITY failure (a
 * healthy supply existed but the deterministic fallback still couldn't
 * produce a valid plan — budget, duplicates, or geography). A pure
 * function so the decision itself — not just its consequences — is
 * directly unit-testable without exercising the full 8000-line pipeline.
 */
export function classifyPlanFailure(
  poolsByStay: Map<string, StayActivityPool>,
  fallbackDiagnostics: Pick<PlanDiagnostics, "outOfBudget" | "duplicatePlaces">
): PlanFailureClassification {
  const stayFailures = buildStayFailureDetails(poolsByStay);
  const supplyFailedStays = stayFailures.filter((stay) => stay.belowMinimum);
  const catastrophicStays = stayFailures.filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay));

  // Round 9.3.3 continuation §7 / Round 9.3.7 §B — checked FIRST: a genuine
  // provider-infrastructure catastrophe is a more fundamental, more
  // actionable diagnosis than any downstream budget/duplicate/geography
  // symptom it might also happen to trigger — never disguised as one of
  // those. This function has no TripFrame/day-count context (a deliberate,
  // pre-existing, separately-tested pure-function boundary), so it uses the
  // narrower trip-level signals it CAN compute without one: a single-stay
  // trip whose only stay is catastrophic, or every stay being catastrophic,
  // is still trip-wide catastrophic; one catastrophic stay out of several
  // healthy ones is NOT (Round 9.3.7's own fix — the real 43-day/7-stay US
  // trip's ONE provider-failed New York stay must never disguise an
  // unrelated budget/duplicate/geography problem on this path, nor abort a
  // trip whose other stays are healthy). The full day-ratio-aware
  // assessment (assessTripDiscoveryHealth) already gates this function's
  // one real call site earlier, with the TripFrame it needs; this is a
  // lighter, context-free consistency backstop for this function alone.
  const isTripWideCatastrophic = catastrophicStays.length > 0 && (stayFailures.length <= 1 || catastrophicStays.length === stayFailures.length);
  if (isTripWideCatastrophic) {
    return {
      code: "REAL_PLACE_DISCOVERY_UNAVAILABLE",
      primaryFailure: "provider_supply",
      secondaryFailures: fallbackDiagnostics.duplicatePlaces > 0 ? ["duplicates"] : [],
      stayFailures,
    };
  }
  if (fallbackDiagnostics.outOfBudget) {
    return { code: "BUDGET_NOT_FEASIBLE", primaryFailure: "budget", secondaryFailures: [], stayFailures };
  }
  if (supplyFailedStays.length > 0) {
    return {
      code: "INSUFFICIENT_REAL_ACTIVITY_SUPPLY",
      primaryFailure: "provider_supply",
      secondaryFailures: fallbackDiagnostics.duplicatePlaces > 0 ? ["duplicates"] : [],
      stayFailures,
    };
  }
  if (fallbackDiagnostics.duplicatePlaces > 0) {
    return { code: "PLAN_NOT_FEASIBLE", primaryFailure: "duplicates", secondaryFailures: [], stayFailures };
  }
  return { code: "PLAN_NOT_FEASIBLE", primaryFailure: "geography", secondaryFailures: [], stayFailures };
}

/**
 * Round 9.2 — the decision between the NEW portfolio-first composition
 * path (spec "THE STAY ACTIVITY PORTFOLIO MUST BECOME THE AUTHORITATIVE
 * INPUT FOR INITIAL DAY CONSTRUCTION") and the OLD Gemini-first free-text
 * path. Healthy (every real-activity-needing stay reached its own
 * minimumViableCandidateCount) → compose deterministically, Gemini only
 * ever refines via candidate IDs (never required, spec §5). Thin/degraded
 * supply → the old Gemini-first path remains — the SAME honest "supply
 * limitation, not a planning failure" distinction Round 8 already
 * established (a destination with genuinely few real candidates still
 * needs Gemini's own knowledge to produce ANY content, real or not).
 */
export function isSupplyHealthyForComposition(poolsByStay: Map<string, StayActivityPool>): boolean {
  if (poolsByStay.size === 0) return false;
  return buildStayFailureDetails(poolsByStay).every((stay) => !stay.belowMinimum);
}

/**
 * Round 9.3.2 §2-6/§13-15 — THE reserve-stay competition orchestrator.
 * Bounded to AT MOST ONE promotion per generation (a deliberate scope
 * limit, disclosed in the round's own final report) — never a full
 * iterative depth-vs-breadth optimizer, which would risk far more of the
 * pipeline than this round's stated goal warrants.
 *
 * Stage A (cheap, no network): rankReserveStaysForPromotion ranks every
 * preserved reserve by a skeleton-signal-only estimate.
 * Stage B (bounded, ONE stay only): builds a REAL StayActivityPool/
 * StayMealVenuePool for just the top-ranked reserve (a short refill
 * budget, spec §5 "keep provider budgets bounded") and re-decides with
 * real data via decideReservePromotion.
 *
 * Existing active-stay pools are never rediscovered (spec §15 — no NEW
 * provider call for an already-active stay). The promoted reserve's own
 * real candidates (Stage B's `addedRecommendations`) are handed back to
 * the caller to merge into payload.recommendations — the SAME
 * assignCandidatesToStays/buildTripActivityPortfolios/
 * buildTripMealVenuePools pass the caller already runs unconditionally
 * right after this (present or not) then naturally attributes them to the
 * new phase by real geography, with zero additional network cost either
 * way — never a second, hand-maintained pool-map merge here.
 */
export async function attemptReservePromotion(
  tripFrame: TripFrame,
  dayCount: number,
  reserveStays: ResolvedStay[],
  activeStays: ResolvedStay[],
  poolsByStay: Map<string, StayActivityPool>,
  mealPoolsByStay: Map<string, StayMealVenuePool>,
  mobilityProfile: DestinationMobilityProfile,
  profile: TripPreferenceProfile,
  arrivalAnchor: { lat: number; lon: number } | null,
  departureAnchor: { lat: number; lon: number } | null,
  /** Injectable — tests pass a fake to avoid any real network call; production omits this and gets the real Overpass-backed default. */
  fetchCandidatesOverride?: RefillOptions["fetchCandidates"]
): Promise<{
  tripFrame: TripFrame;
  addedRecommendations: TripRecommendation[];
  /** The promoted reserve's own freshly-built pools — set only when promoted:true, so the caller can seed its own poolsByStay/mealPoolsByStay maps for the isSupplyHealthyForComposition check that immediately follows, without waiting for a later full rebuild. */
  reservePool: StayActivityPool | null;
  reserveMealPool: StayMealVenuePool | null;
  reserveStayId: string | null;
  promoted: boolean;
}> {
  const unchanged = { tripFrame, addedRecommendations: [], reservePool: null, reserveMealPool: null, reserveStayId: null, promoted: false };
  if (reserveStays.length === 0 || tripFrame.phases.length === 0) return unchanged;

  // Stage A — cheap ranking, no network call at all.
  const ranked = rankReserveStaysForPromotion(reserveStays, activeStays);
  const top = ranked[0];
  if (!top || top.netStageAScore <= 0) return unchanged;

  // Fresh allocationDetails for the CURRENT (already-reallocated) active
  // stays — the same computeStayValueProfile/allocateNightsByMarginalValue
  // pair reallocateNightsAfterDiscovery itself uses, recomputed here only
  // because that function's own return type stays TripFrame-only (spec
  // §18: never redesign the existing marginal-value system).
  const activeProfiles = tripFrame.phases.map((phase) => computeStayValueProfile(phase.id, phase.areaLabel, poolsByStay.get(phase.id), mealPoolsByStay.get(phase.id), [], false));
  const currentAllocation = allocateNightsByMarginalValue(activeProfiles, dayCount);

  // Stage B — bounded, single-stay real discovery for the top reserve only.
  const reservePhase: TripFramePhase = {
    id: top.reserve.stayId,
    areaLabel: top.reserve.areaLabel,
    nights: 1,
    startDayNumber: 0,
    endDayNumber: 0,
    intent: "mixed",
    anchor: { lat: top.reserve.lat, lon: top.reserve.lon },
  };
  const reserveCapacity = computeStayCapacity([{ dayNumber: 1, dayType: "normal", hasExplicitRestWindow: false }]);
  const basePool = buildStayActivityPool(reservePhase, [], reservePhase.anchor!, mobilityProfile, reserveCapacity, profile.mustVisitKeywords, profile.dailyCapacityMinutes);
  const { pool: reservePool, addedRecommendations } = await refillStayActivityPool(basePool, mobilityProfile, profile.dailyCapacityMinutes, profile.mustVisitKeywords, {
    fetchCandidates: fetchCandidatesOverride,
    maxRounds: 1,
    deadline: Date.now() + 6_000,
  }).catch(() => ({ pool: basePool, addedRecommendations: [] as TripRecommendation[] }));
  const reserveMealPool = buildStayMealVenuePool(reservePhase, addedRecommendations, reservePhase.anchor!, mobilityProfile, profile.dailyCapacityMinutes);

  const reserveProfile = computeStayValueProfile(top.reserve.stayId, top.reserve.areaLabel, reservePool, reserveMealPool, top.reserve.reasons, false);
  const decision = decideReservePromotion(top.reserve, reserveProfile, top.transferCostKm, currentAllocation);

  logGenerationStage("[StaySupplyQA] reserve promotion evaluated", {
    reserve: top.reserve.areaLabel,
    stageAScore: top.netStageAScore,
    transferCostKm: top.transferCostKm,
    realActivityCandidates: reservePool.candidates.length,
    decision: decision.reason,
    promoted: decision.promote,
  });

  if (!decision.promote || !decision.demoteFromStayId) return unchanged;

  const newFrame = applyReservePromotion(tripFrame, top.reserve, decision.demoteFromStayId, arrivalAnchor, departureAnchor);
  if (newFrame === tripFrame) return unchanged; // refused (demote-from stay already at its own minimum)

  return { tripFrame: newFrame, addedRecommendations, reservePool, reserveMealPool, reserveStayId: top.reserve.stayId, promoted: true };
}

export async function generateCountryItineraryPlan(
  payload: AiItineraryRequest,
  knowledge?: CountryAiRecommendation | null,
  /** Round 9.3.3 §22 — purely observational: called at real, already-completed pipeline checkpoints. Never awaited for planner decisions, never changes what gets generated. */
  onProgress?: GenerationProgressReporter
): Promise<GeneratedCountryItineraryPlan> {
  const generationStartedAt = Date.now();
  // Round 9.4 §R — lightweight stage timing, reusing the EXISTING
  // onProgress stage-transition calls (Round 9.3.3 §22) rather than
  // rewriting the pipeline to wrap each stage individually: every one of
  // the ~15 onProgress call sites already marks a real stage boundary, so
  // wrapping the callback ONCE here reports elapsed time between
  // consecutive stage transitions with zero changes to any call site and
  // zero effect on what onProgress itself reports to the caller.
  if (isPlannerQaTraceEnabled()) {
    const originalOnProgress = onProgress;
    let lastStageAt = generationStartedAt;
    let lastStage = "INITIALIZING";
    onProgress = (event) => {
      const now = Date.now();
      logRealPlaceQA("Timing", { stage: lastStage, elapsedMs: now - lastStageAt });
      lastStageAt = now;
      lastStage = event.stage;
      originalOnProgress?.(event);
    };
  }
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  if (!payload.countryId || !payload.countryName || !payload.isoA2) {
    throw new Error("countryId, countryName and isoA2 are required");
  }
  if (!payload.preferences.startDate || !payload.preferences.endDate || dayCount <= 0) {
    throw new Error("יש לבחור תאריכי התחלה וסיום תקפים לפני יצירת מסלול.");
  }

  startFixtureCaptureSession(payload.isoA2.toUpperCase(), {
    isoA2: payload.isoA2,
    countryName: payload.countryName,
    startDate: payload.preferences.startDate,
    endDate: payload.preferences.endDate,
    dayCount,
  });

  const exchangeRateContext = await loadExchangeRateContext(payload.isoA2);
  logGenerationStage("flight data: parsed", { hasFlights: Boolean(payload.preferences.flights?.outbound || payload.preferences.flights?.return) });
  let normalizedPayload = normalizePayloadPrices(payload, exchangeRateContext);
  logGenerationStage("airport data: normalized", { recommendations: normalizedPayload.recommendations.length });
  const profile = buildTripPreferenceProfile(
    normalizedPayload.preferences,
    normalizedPayload.countryName,
    dayCount
  );
  logGenerationStage("dietary preferences: parsed", { hasDietaryPreferences: Boolean(normalizedPayload.preferences.dietaryPreferences?.trim()) });
  onProgress?.({ stage: "INITIALIZING", message: "אוספים את נתוני הטיול" });
  const tripFrameResult = await buildTripFrame(normalizedPayload, dayCount, knowledge);
  let tripFrame = tripFrameResult.frame;
  const skeletonReserveStays = tripFrameResult.reserveStays;
  const arrivalDepartureWindow = computeArrivalDepartureWindow(
    normalizedPayload.preferences.flights,
    normalizedPayload.isoA2
  );
  onProgress?.({ stage: "TRIP_FRAME", message: "בונים את מבנה המסלול", completedUnits: tripFrame.phases.length, totalUnits: tripFrame.phases.length });
  // Stay resolution (which real areas/anchors this trip visits) is already
  // decided as part of buildTripFrame's own output (each phase's anchor,
  // including Round 9.3.1's stay-anchor fix) — there is no separate later
  // async step to observe, so this reports real, already-true state rather
  // than waiting on work that doesn't exist as a distinct stage here.
  onProgress?.({ stage: "STAY_RESOLUTION", message: "מאתרים יעדים ואזורי לינה" });

  // Round 9 §4 / Round 9.1 §6-§9 — real, stay-scoped, bounded-concurrency,
  // time-budgeted provider refill BEFORE Gemini ever sees the candidate
  // pool. Strictly additive and failure-tolerant — on any provider trouble
  // this returns the original payload unchanged. `poolsByStay` is kept for
  // the failure-code decision below (§16/§17) and the failure summary.
  const beforeRefillCount = normalizedPayload.recommendations.length;
  const refillOutcome = await refillTripRecommendationPool(
    normalizedPayload,
    tripFrame,
    dayCount,
    arrivalDepartureWindow,
    profile,
    undefined,
    undefined,
    (completed, total) =>
      onProgress?.({
        stage: "PLACE_DISCOVERY",
        message: `מחפשים מקומות ואטרקציות — ${completed} מתוך ${total} אזורים`,
        completedUnits: completed,
        totalUnits: total,
      })
  ).catch(() => ({ payload: normalizedPayload, poolsByStay: new Map<string, StayActivityPool>() }));
  normalizedPayload = refillOutcome.payload;
  const preGenerationPoolsByStay = refillOutcome.poolsByStay;
  if (normalizedPayload.recommendations.length !== beforeRefillCount) {
    logGenerationStage("stay activity pool: refilled", {
      before: beforeRefillCount,
      after: normalizedPayload.recommendations.length,
      added: normalizedPayload.recommendations.length - beforeRefillCount,
    });
  }
  // Round 9.3.3 §22 — a real completion tick even for a single-stay trip
  // (onStayDiscovered fires per-stay above; this guarantees PLACE_DISCOVERY
  // reaches its own range's end once discovery is fully done, even if the
  // catch() above skipped every per-stay tick entirely).
  onProgress?.({ stage: "PLACE_DISCOVERY", message: "מחפשים מקומות ואטרקציות אמיתיים", completedUnits: tripFrame.phases.length, totalUnits: Math.max(tripFrame.phases.length, 1) });

  // Round 9.3.1 §4/§9 — "separate stay selection from night allocation":
  // buildTripFrame's own night counts (skeleton-proposed or POI-cluster
  // proportional) are a PRELIMINARY estimate only, needed to give
  // refillTripRecommendationPool day ranges to discover against. Now that
  // real per-stay supply exists (preGenerationPoolsByStay, built above),
  // the deterministic planner recomputes FINAL durations via joint
  // marginal-value allocation (spec §5/§6) — never a bucket, never equal
  // share. Candidate OWNERSHIP is untouched (still keyed by the same
  // stable phase.id/anchor), so this never re-triggers discovery.
  const preGenerationAreaAnchors = resolveAreaAnchorsForFrame(tripFrame, computeAreaAnchors(normalizedPayload));
  const preGenerationMobilityProfile = computeDestinationMobilityProfile([
    ...normalizedPayload.recommendations,
    ...normalizedPayload.selectedPlaces,
  ]);
  if (tripFrame.phases.length > 1) {
    const preGenerationMealPoolsByStay = buildTripMealVenuePools(
      tripFrame,
      preGenerationAreaAnchors,
      preGenerationMobilityProfile,
      normalizedPayload.recommendations,
      profile.dailyCapacityMinutes,
      normalizeAreaLabel,
      resolveTextualAreaMatch
    );
    onProgress?.({ stage: "POOL_CONSTRUCTION", message: "אוספים את המקומות שנמצאו" });
    const reallocationArrivalAirport = normalizedPayload.preferences.flights?.outbound?.arrivalAirport || null;
    const reallocationArrivalAnchor = reallocationArrivalAirport ? findAirportByIata(reallocationArrivalAirport) : null;
    const reallocationDepartureAirport = normalizedPayload.preferences.flights?.return?.departureAirport || null;
    const reallocationDepartureAnchor = reallocationDepartureAirport ? findAirportByIata(reallocationDepartureAirport) : null;
    const beforeNights = tripFrame.phases.map((p) => ({ area: p.areaLabel, nights: p.nights }));
    // Round 9.3.2 §7 — the SAME pre-generation day-type/usableHours
    // estimator the rest of the pipeline already relies on, computed
    // against the CURRENT (pre-reallocation) frame so arrival/departure/
    // transfer classification reflects real phase boundaries.
    const preReallocationDayTypesByStay = estimatePreGenerationDayTypesByStay(tripFrame, dayCount, arrivalDepartureWindow);
    tripFrame = reallocateNightsAfterDiscovery(
      tripFrame,
      dayCount,
      preGenerationPoolsByStay,
      preGenerationMealPoolsByStay,
      profile.mustVisitKeywords,
      reallocationArrivalAnchor,
      reallocationDepartureAnchor,
      preReallocationDayTypesByStay
    );
    logGenerationStage("[StaySupplyQA] night reallocation after real discovery", {
      before: beforeNights,
      after: tripFrame.phases.map((p) => ({ area: p.areaLabel, nights: p.nights })),
    });
    onProgress?.({ stage: "NIGHT_ALLOCATION", message: "מחלקים את הימים בין היעדים" });

    // Round 9.3.2 §2-6/§13 — reserve stays the skeleton resolved but did not
    // select may still compete for a trip day against the weakest active
    // stay's own next unallocated day. Bounded to at most one promotion.
    if (skeletonReserveStays.length > 0) {
      const activeStaysForRanking: ResolvedStay[] = tripFrame.phases.map((p) => ({
        stayId: p.id,
        proposedId: null,
        areaLabel: p.areaLabel,
        lat: p.anchor?.lat ?? preGenerationAreaAnchors.get(p.areaLabel)?.lat ?? 0,
        lon: p.anchor?.lon ?? preGenerationAreaAnchors.get(p.areaLabel)?.lon ?? 0,
        nights: p.nights,
        reasons: [],
        source: "gemini_resolved",
        confidence: "high",
        countryIso: normalizedPayload.isoA2,
      }));
      const promotionResult = await attemptReservePromotion(
        tripFrame,
        dayCount,
        skeletonReserveStays,
        activeStaysForRanking,
        preGenerationPoolsByStay,
        preGenerationMealPoolsByStay,
        preGenerationMobilityProfile,
        profile,
        reallocationArrivalAnchor,
        reallocationDepartureAnchor
      ).catch(() => ({ tripFrame, addedRecommendations: [] as TripRecommendation[], reservePool: null, reserveMealPool: null, reserveStayId: null, promoted: false }));
      if (promotionResult.promoted) {
        tripFrame = promotionResult.tripFrame;
        // The reserve's own real candidates join the trip's pool exactly
        // like any other refill result (spec §14: no stale state) — every
        // later rebuild (portfolios, meal pools) sees them through the
        // SAME normalizedPayload.recommendations list every other stay's
        // candidates already flow through, never a separate code path.
        normalizedPayload = { ...normalizedPayload, recommendations: [...normalizedPayload.recommendations, ...promotionResult.addedRecommendations] };
        if (promotionResult.reserveStayId && promotionResult.reservePool) preGenerationPoolsByStay.set(promotionResult.reserveStayId, promotionResult.reservePool);
        logGenerationStage("[StaySupplyQA] reserve promoted", {
          finalStays: tripFrame.phases.map((p) => ({ area: p.areaLabel, nights: p.nights })),
        });
      }
      onProgress?.({ stage: "RESERVE_EVALUATION", message: "בודקים יעדים נוספים אפשריים" });
    } else {
      onProgress?.({ stage: "RESERVE_EVALUATION", message: "בודקים יעדים נוספים אפשריים" });
    }
  } else {
    // A single-stay trip has no reallocation/reserve-competition work to
    // do (both are inherently multi-stay concepts) — report both stages as
    // genuinely complete (there was nothing to do) rather than stalling
    // progress waiting for a step that will never run for this trip shape.
    onProgress?.({ stage: "POOL_CONSTRUCTION", message: "אוספים את המקומות שנמצאו" });
    onProgress?.({ stage: "NIGHT_ALLOCATION", message: "מחלקים את הימים בין היעדים" });
    onProgress?.({ stage: "RESERVE_EVALUATION", message: "בודקים יעדים נוספים אפשריים" });
  }

  // Round 9.3.5 — tripFrame is now truly FINAL (post night-reallocation,
  // post reserve-promotion). A stay's real duration can have grown well
  // past what its OWN pre-reallocation discovery pass ever targeted
  // (measured and confirmed this round: early-stop correctly closes the
  // book against the SMALLER preliminary target, and nothing before this
  // point ever revisits that pool once nights change) — recompute every
  // stay's real anchor/day-type/target against the FINAL frame and run a
  // bounded, grouped refill ONLY for stays that are still genuinely short,
  // never re-discovering an already-healthy one.
  const finalAreaAnchors = resolveAreaAnchorsForFrame(tripFrame, computeAreaAnchors(normalizedPayload));
  const finalDayTypesByStay = estimatePreGenerationDayTypesByStay(tripFrame, dayCount, arrivalDepartureWindow);
  const finalMobilityProfile = computeDestinationMobilityProfile([...normalizedPayload.recommendations, ...normalizedPayload.selectedPlaces]);
  const finalSupplyRefill = await refillDeficientStaysAfterReallocation(
    normalizedPayload,
    tripFrame,
    finalAreaAnchors,
    finalMobilityProfile,
    profile,
    preGenerationPoolsByStay,
    finalDayTypesByStay
  ).catch(() => ({ payload: normalizedPayload, poolsByStay: preGenerationPoolsByStay, refilledStayIds: [] as string[] }));
  normalizedPayload = finalSupplyRefill.payload;
  for (const [stayId, pool] of finalSupplyRefill.poolsByStay) preGenerationPoolsByStay.set(stayId, pool);
  if (finalSupplyRefill.refilledStayIds.length > 0) {
    logGenerationStage("[StaySupplyQA] final-duration supply refill complete", {
      refilledStayIds: finalSupplyRefill.refilledStayIds,
      finalPoolSizes: finalSupplyRefill.refilledStayIds.map((id) => ({ stayId: id, size: preGenerationPoolsByStay.get(id)?.candidates.length ?? 0 })),
    });
  }

  // Round 9.3.7 §A/§H — the earliest point every stay's FINAL pool shape
  // is known (post-initial-discovery, post-reallocation-refill, before any
  // Gemini/composed-path/routing/finalization work begins) is also the
  // earliest point a genuinely catastrophic trip-wide provider failure is
  // deterministically knowable. The OLD unconditional check further below
  // (fallback-template stage) only ever ran AFTER the full Gemini-first
  // pipeline had already been attempted — the real 43-day US trip spent
  // ~233-240s of work before ever reaching it. Bounded, no-new-network-
  // call recovery (existing selectedPlaces/must-visit data, never another
  // stay's candidates, never a fabricated place) runs first so a stay is
  // never given up on before data ALREADY in this generation is tried.
  const boundedRecovery = attemptBoundedRecoveryForFailedStays(
    normalizedPayload,
    tripFrame,
    finalAreaAnchors,
    finalMobilityProfile,
    profile,
    preGenerationPoolsByStay,
    finalDayTypesByStay
  );
  normalizedPayload = boundedRecovery.payload;
  for (const [stayId, pool] of boundedRecovery.poolsByStay) preGenerationPoolsByStay.set(stayId, pool);

  const tripDiscoveryHealth = assessTripDiscoveryHealth(
    preGenerationPoolsByStay,
    tripFrame,
    normalizedPayload.preferences.startDate,
    arrivalDepartureWindow,
    new Set(boundedRecovery.recoveredStayIds)
  );
  if (tripDiscoveryHealth.tripSupplyState !== "HEALTHY") {
    logGenerationStage("[TripDiscoveryHealthQA]", { ...tripDiscoveryHealth, stayFailures: undefined });
  }
  if (tripDiscoveryHealth.tripSupplyState === "CATASTROPHIC_PROVIDER_FAILURE") {
    throw new RealPlaceDiscoveryUnavailableError(
      "לא הצלחנו לאתר מקומות אמיתיים בטיול הזה בגלל תקלת ספק זמנית — לא בגלל מיעוט אמיתי של מקומות ביעד. כדאי לנסות שוב בעוד כמה דקות.",
      tripDiscoveryHealth.stayFailures.filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay))
    );
  }

  logGenerationStage("AI generation started", {
    isoA2: normalizedPayload.isoA2,
    dayCount,
    candidateRecommendations: normalizedPayload.recommendations.length,
    selectedPlaces: normalizedPayload.selectedPlaces.length,
  });

  // Round 9.2 — "THE STAY ACTIVITY PORTFOLIO MUST BECOME THE AUTHORITATIVE
  // INPUT FOR INITIAL DAY CONSTRUCTION." Portfolios are built HERE, before
  // Gemini is ever consulted. When every stay that actually needs real
  // content reached its own minimum-viable supply (isSupplyHealthyForComposition),
  // the deterministic composer — not Gemini, not backfill — decides the
  // itinerary's real content. Gemini participates only as an OPTIONAL,
  // ID-only refinement on top of an already-complete, already-valid plan.
  // A thin/degraded supply (genuine destination scarcity, Round 8's own
  // established distinction) falls through to the existing Gemini-first
  // free-text path below — Gemini's own world knowledge is the only
  // reasonable source of ANY content in that case.
  if (isSupplyHealthyForComposition(preGenerationPoolsByStay)) {
    // Round 9.3.5 — final*, not preGeneration*: tripFrame's day ranges (and,
    // for a promoted reserve, its very phase) may have just been rebuilt by
    // night reallocation/reserve promotion above — always the FINAL frame's
    // own anchors/mobility/day-types, never the preliminary ones refill
    // discovery used (a promoted reserve is never in preGenerationAreaAnchors
    // at all, since that map predates its phase existing).
    const { poolsByStay: composedPoolsByStay, portfoliosByStay } = buildTripActivityPortfolios(
      tripFrame,
      finalAreaAnchors,
      finalMobilityProfile,
      normalizedPayload.recommendations,
      finalDayTypesByStay,
      profile.mustVisitKeywords,
      [...profile.strongPreferences, ...profile.softPreferences],
      profile.dailyCapacityMinutes,
      normalizeAreaLabel,
      resolveTextualAreaMatch
    );
    onProgress?.({ stage: "PORTFOLIO_CONSTRUCTION", message: "בוחרים את המקומות המתאימים ביותר" });
    // Round 9.3 §10/§11 — the composer's own literal StayMealVenuePool per
    // stay, built the SAME call-shape as the activity portfolios just
    // above (same ownership pass, same anchors/mobility profile) — never a
    // second country-wide or inline pseudo-pool.
    const mealPoolsByStay = buildTripMealVenuePools(
      tripFrame,
      finalAreaAnchors,
      finalMobilityProfile,
      normalizedPayload.recommendations,
      profile.dailyCapacityMinutes,
      normalizeAreaLabel,
      resolveTextualAreaMatch
    );
    logGenerationStage("[StaySupplyQA]", {
      stays: tripFrame.phases.map((phase) => ({
        stayId: phase.id,
        owner: phase.areaLabel,
        nights: phase.nights,
        activityCandidates: composedPoolsByStay.get(phase.id)?.candidates.length ?? 0,
        mealCandidates: mealPoolsByStay.get(phase.id)?.venues.length ?? 0,
      })),
    });
    const composed = composeDaysFromStayPortfolios(
      tripFrame,
      dayCount,
      arrivalDepartureWindow,
      composedPoolsByStay,
      portfoliosByStay,
      normalizedPayload,
      profile,
      mealPoolsByStay
    );
    logGenerationStage("portfolio-first composition", { initialRealActivitiesScheduled: composed.initialRealActivitiesScheduled });
    onProgress?.({ stage: "DAY_COMPOSITION", message: "בונים את תוכנית הימים", completedUnits: dayCount, totalUnits: dayCount });

    const composedRepaired = repairPlan(toRawGeneratedPlan(composed.plan), normalizedPayload, profile, tripFrame, exchangeRateContext, arrivalDepartureWindow, null);
    // Round 9.4 §M — repairPlan is a single opaque call from here (its own
    // ~20 internal repair steps are not individually instrumented this
    // round — a real scope limit, disclosed in the report, not a per-
    // substep trace); this is the before/after identity diff across the
    // WHOLE repair pass, which is what previous rounds' evidence actually
    // needed ("did repair as a whole remove real content"). No invented
    // reason: repairPlan has no single attributable cause for a removal at
    // this granularity, so `reason` is honestly "UNKNOWN" per spec §M.
    if (isPlannerQaTraceEnabled()) {
      const repairDelta = diffRealActivitySnapshots(snapshotRealActivities(composed.plan.days), snapshotRealActivities(composedRepaired.days));
      logRealPlaceQA("RepairDelta", {
        repairStage: "repairPlan (composed path)",
        beforeRealActivityCount: repairDelta.beforeCount,
        afterRealActivityCount: repairDelta.afterCount,
        addedRealActivityIds: repairDelta.addedIds,
        removedRealActivityIds: repairDelta.removedIds,
        removed: repairDelta.removed.map((entry) => ({ ...entry, stayId: findFramePhaseForDay(tripFrame, entry.dayNumber)?.id, reason: "UNKNOWN" })),
      });
    }
    const composedDiagnostics = collectPlanDiagnostics(composedRepaired, profile, tripFrame, arrivalDepartureWindow, normalizedPayload.preferences.flights);
    onProgress?.({ stage: "REPAIR_VALIDATION", message: "בודקים את המסלול ומתקנים התנגשויות" });

    if (isPlanComplete(toRawGeneratedPlan(composed.plan), normalizedPayload) && passesValidation(composedDiagnostics)) {
      logGenerationStage("portfolio-first composition passed validation");
      const refinement = await refineComposedPlanWithGemini(composedRepaired, tripFrame, portfoliosByStay, normalizedPayload, profile).catch(
        () => ({ plan: composedRepaired, refinementApplied: false, unknownCandidateIds: 0, crossStayCandidateIds: 0 })
      );
      onProgress?.({ stage: "AI_REFINEMENT", message: "מתאימים מסעדות וארוחות" });
      let finalCandidatePlan = composedRepaired;
      if (refinement.refinementApplied) {
        // Same discipline as every other repair step: re-repair and
        // re-validate what Gemini touched — never trust it silently.
        const reRepaired = repairPlan(toRawGeneratedPlan(refinement.plan), normalizedPayload, profile, tripFrame, exchangeRateContext, arrivalDepartureWindow, null);
        const reDiagnostics = collectPlanDiagnostics(reRepaired, profile, tripFrame, arrivalDepartureWindow, normalizedPayload.preferences.flights);
        if (passesValidation(reDiagnostics)) {
          finalCandidatePlan = reRepaired;
          logGenerationStage("Gemini portfolio refinement applied and re-validated");
        } else {
          logGenerationStage("Gemini portfolio refinement broke validation — discarded, keeping the deterministic composition");
        }
      }
      if (refinement.unknownCandidateIds > 0 || refinement.crossStayCandidateIds > 0) {
        logGenerationStage("Gemini portfolio refinement contract violations rejected", {
          unknownGeminiCandidateIds: refinement.unknownCandidateIds,
          crossStayGeminiCandidateIds: refinement.crossStayCandidateIds,
        });
      }

      const validated = await applyBestEffortRoutingValidation(finalCandidatePlan, normalizedPayload, profile).catch(() => finalCandidatePlan);
      onProgress?.({ stage: "ROUTING", message: "מחשבים זמני נסיעה ומעברים" });
      // Round 9.4 §N — before finalization (which itself contains
      // finalizeArrivalDepartureContent's own real-before-freetime backfill
      // AND every settle-pass it runs), so a later "AfterFinalization" diff
      // reveals whether finalization is a net destroyer or net restorer of
      // real content — never assumed either way.
      if (isPlannerQaTraceEnabled()) {
        const before = snapshotRealActivities(validated.days);
        logRealPlaceQA("BeforeFinalization", {
          realActivities: before.length,
          realMeals: validated.days.reduce((sum, d) => sum + d.items.filter((i) => isScheduledRealPlace(i) && (i.category === "restaurant" || i.category === "cafe")).length, 0),
          freeTime: validated.days.reduce((sum, d) => sum + d.items.filter((i) => isSyntheticScheduleItem(i) && !isGenericMealOpportunity(i)).length, 0),
          mealOpportunities: validated.days.reduce((sum, d) => sum + d.items.filter((i) => isGenericMealOpportunity(i)).length, 0),
        });
      }
      let backfilledRealActivities = 0;
      const finalPlan = finalizeArrivalDepartureContent(
        validated,
        normalizedPayload,
        profile,
        dayCount,
        arrivalDepartureWindow,
        tripFrame,
        finalAreaAnchors,
        finalMobilityProfile,
        (insertions) => {
          backfilledRealActivities = insertions;
        }
      );
      if (isPlannerQaTraceEnabled()) {
        const finalizationDelta = diffRealActivitySnapshots(snapshotRealActivities(validated.days), snapshotRealActivities(finalPlan.days));
        logRealPlaceQA("AfterFinalization", {
          realActivities: finalizationDelta.afterCount,
          realMeals: finalPlan.days.reduce((sum, d) => sum + d.items.filter((i) => isScheduledRealPlace(i) && (i.category === "restaurant" || i.category === "cafe")).length, 0),
          freeTime: finalPlan.days.reduce((sum, d) => sum + d.items.filter((i) => isSyntheticScheduleItem(i) && !isGenericMealOpportunity(i)).length, 0),
          mealOpportunities: finalPlan.days.reduce((sum, d) => sum + d.items.filter((i) => isGenericMealOpportunity(i)).length, 0),
          addedRealActivityIds: finalizationDelta.addedIds,
          removedRealActivityIds: finalizationDelta.removedIds,
        });
      }
      // Round 9.2 §12 — the headline observability signal for this whole
      // round: for a healthy-supply trip, initialRealActivitiesScheduled
      // (from the deterministic composer, BEFORE Gemini or backfill ever
      // ran) should dwarf backfilledRealActivities (this finalization
      // pass's own EXCEPTIONAL last-resort repair). If backfill regularly
      // matches or exceeds the initial count, that's a supply or pacing
      // regression to investigate — never a reason to relax validation.
      logGenerationStage("portfolio-composed generation: initial vs backfilled real activities", {
        initialRealActivitiesScheduled: composed.initialRealActivitiesScheduled,
        backfilledRealActivities,
        unknownGeminiCandidateIds: refinement.unknownCandidateIds,
        crossStayGeminiCandidateIds: refinement.crossStayCandidateIds,
      });
      // Round 9.3.6 §13 — a bounded conservation log for the exact question
      // this round's real production evidence made unanswerable at a
      // glance: of the real activity candidates the trip actually
      // collected, how many made it into a final per-stay pool, how many
      // survived into a portfolio (selected vs. reserve), and how many
      // were actually scheduled? Reuses existing counts already computed
      // for this same call (composedPoolsByStay/portfoliosByStay/
      // countRecommendationsByPlanningRole) — no new tracking state, no
      // second observability system (spec item 10).
      {
        const { realActivityRecommendations: totalRealActivityRecommendations } = countRecommendationsByPlanningRole(
          normalizedPayload.recommendations
        );
        let inFinalPools = 0;
        let portfolioSelected = 0;
        let portfolioReserve = 0;
        for (const phase of tripFrame.phases) {
          inFinalPools += composedPoolsByStay.get(phase.id)?.candidates.length ?? 0;
          portfolioSelected += portfoliosByStay.get(phase.id)?.selected.length ?? 0;
          portfolioReserve += portfoliosByStay.get(phase.id)?.optional.length ?? 0;
        }
        const scheduled = finalPlan.days.reduce(
          (sum, day) => sum + day.items.filter((item) => isScheduledRealPlace(item) && item.category !== "restaurant" && item.category !== "cafe").length,
          0
        );
        logGenerationStage("[FinalActivityCandidateAccounting]", {
          totalRealActivityRecommendations,
          inFinalPools,
          portfolioSelected,
          portfolioReserve,
          scheduled,
        });

        // Round 9.4 §L — "the single most important diagnostic": one
        // compact per-stay conservation record, discovered through every
        // stage a real candidate could be lost at. Every number here comes
        // from state already computed above/earlier in this same call
        // (preGenerationPoolsByStay, composedPoolsByStay, portfoliosByStay,
        // composed.plan.days, composedRepaired.days, finalPlan.days) —
        // never a second parallel tracking system.
        const countRealForStay = (dayList: AiGeneratedDay[], stayId: string) =>
          dayList.reduce((sum, day) => {
            const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
            if (phase?.id !== stayId) return sum;
            return sum + day.items.filter((item) => isScheduledRealPlace(item) && item.category !== "restaurant" && item.category !== "cafe").length;
          }, 0);
        for (const phase of tripFrame.phases) {
          const discoveryPool = preGenerationPoolsByStay.get(phase.id);
          const finalPool = composedPoolsByStay.get(phase.id);
          const portfolio = portfoliosByStay.get(phase.id);
          logRealPlaceQA("CandidateConservation", {
            stayId: phase.id,
            owner: phase.areaLabel,
            discovered: discoveryPool?.diagnostics.initialCandidateCount ?? 0,
            geographicallyLegal: discoveryPool?.diagnostics.legalCandidateCount ?? 0,
            activityPool: finalPool?.candidates.length ?? 0,
            portfolioSelected: portfolio?.selected.length ?? 0,
            portfolioReserve: portfolio?.optional.length ?? 0,
            initiallyScheduled: countRealForStay(composed.plan.days, phase.id),
            afterRepair: countRealForStay(composedRepaired.days, phase.id),
            finalScheduled: countRealForStay(finalPlan.days, phase.id),
          });
        }
      }
      // Round 9.3 §16 — same catastrophic-quality ceiling as the Gemini-
      // first/fallback paths below; defense in depth even though a healthy
      // portfolio composition should never actually reach this shape once
      // the stay skeleton itself is real.
      assertRealActivityCoverage(
        validateItineraryQuality(finalPlan.days, tripFrame, arrivalDepartureWindow),
        normalizedPayload,
        { tripFrame, countryName: normalizedPayload.countryName },
        buildStaySupplyDiagnosticsMap(tripFrame, composedPoolsByStay, portfoliosByStay)
      );
      // Round 9.4 §P — the per-stay FinalResult, from INSIDE the pipeline
      // where pool/portfolio sizes are still in scope (country-itineraries.ts
      // logs the trip-wide, PERSISTED analogue of this once the itinerary
      // is actually saved — this is the planner's own view, before that).
      if (isPlannerQaTraceEnabled()) {
        const finalQuality = validateItineraryQuality(finalPlan.days, tripFrame, arrivalDepartureWindow);
        const normalDaysReport = finalQuality.perDay.filter((d) => d.dayType === "normal");
        const totalRealActivities = finalQuality.perDay.reduce((sum, d) => sum + d.meaningfulRealActivityCount, 0);
        logRealPlaceQA("FinalResult", {
          totalDays: dayCount,
          stays: tripFrame.phases.length,
          realActivities: totalRealActivities,
          normalDays: normalDaysReport.length,
          normalDaysWithRealActivity: normalDaysReport.filter((d) => d.meaningfulRealActivityCount > 0).length,
          zeroRealActivityDays: normalDaysReport.filter((d) => d.meaningfulRealActivityCount === 0).length,
          perStay: tripFrame.phases.map((phase) => {
            const stayNormalDays = normalDaysReport.filter((d) => findFramePhaseForDay(tripFrame, d.dayNumber)?.id === phase.id);
            return {
              stayId: phase.id,
              name: phase.areaLabel,
              normalDays: stayNormalDays.length,
              poolSize: composedPoolsByStay.get(phase.id)?.candidates.length ?? 0,
              portfolioSize: portfoliosByStay.get(phase.id)?.selected.length ?? 0,
              finalRealActivities: stayNormalDays.reduce((sum, d) => sum + d.meaningfulRealActivityCount, 0),
              zeroRealDays: stayNormalDays.filter((d) => d.meaningfulRealActivityCount === 0).length,
            };
          }),
        });
        if (totalRealActivities === 0) logRealPlaceQACompact("ZERO_REAL_ACTIVITY_SUCCESS", { totalDays: dayCount, stays: tripFrame.phases.length, generationSource: "portfolio_composed" });
      }
      return {
        ...finalPlan,
        summary: buildGenerationSummary(finalPlan, profile),
        model: ITINERARY_MODEL,
        usedFallback: false,
        generationSource: "portfolio_composed",
        candidateProviderStatus: resolveCandidateProviderStatus(normalizedPayload),
      };
    }
    // Round 9.4.2 §C/§D/§E/§F — PROVEN root cause of a real 41-day/7-stay
    // production trip persisting with 0 real activities/0 real meals
    // (traceId gen-mu7ihdq8-545bii8p): composedRepaired already had 100+
    // real places (missingMeals/overloadedDays/longTravelDays are pacing
    // diagnostics, never real-content corruption), but failing
    // passesValidation here discarded it WHOLESALE — falling through to a
    // free-text Gemini loop (which can fail independently) and ultimately
    // buildFallbackAiItinerary, a StayActivityPool/portfolio-UNAWARE
    // legacy candidate-selection mechanism that produced near-zero real
    // content for a complex multi-stay trip. This is the fix: when the
    // ONLY failures are soft/pacing diagnostics (passesHardInvariantsForFallbackRecovery
    // still holds — no duplicate/geographic/temporal/legal corruption),
    // keep composedRepaired as a real-place-preserving checkpoint and
    // finalize+validate it through the EXACT SAME gate
    // (assertRealActivityCoverage) the healthy-success path above already
    // uses, instead of discarding it. Never reruns discovery, never makes
    // a new provider call — reuses composedPoolsByStay/portfoliosByStay/
    // mealPoolsByStay already computed above. If ANYTHING about this
    // checkpoint attempt fails (hard invariants unmet, or the coverage
    // gate itself throws), execution falls through to the EXISTING
    // Gemini-first + deterministic-template path completely unchanged —
    // this is a strict ADDITION, never a replacement, of the prior safety
    // net.
    if (passesHardInvariantsForFallbackRecovery(composedDiagnostics)) {
      try {
        const checkpointFinalPlan = finalizeArrivalDepartureContent(
          composedRepaired,
          normalizedPayload,
          profile,
          dayCount,
          arrivalDepartureWindow,
          tripFrame,
          finalAreaAnchors,
          finalMobilityProfile
        );
        assertRealActivityCoverage(
          validateItineraryQuality(checkpointFinalPlan.days, tripFrame, arrivalDepartureWindow),
          normalizedPayload,
          { tripFrame, countryName: normalizedPayload.countryName },
          buildStaySupplyDiagnosticsMap(tripFrame, composedPoolsByStay, portfoliosByStay),
          false
        );
        logGenerationStage("portfolio-first composition failed ONLY soft/pacing validation — kept as a real-place-preserving checkpoint instead of discarding", {
          failingDiagnostics: describeFailingDiagnostics(composedDiagnostics),
        });
        return {
          ...checkpointFinalPlan,
          summary: buildGenerationSummary(checkpointFinalPlan, profile),
          model: ITINERARY_MODEL,
          usedFallback: false,
          generationSource: "portfolio_composed_soft_checkpoint",
          candidateProviderStatus: resolveCandidateProviderStatus(normalizedPayload),
        };
      } catch (checkpointError) {
        logGenerationStage("real-place-preserving checkpoint attempt failed — falling back to Gemini-first path", {
          message: checkpointError instanceof Error ? checkpointError.message : String(checkpointError),
        });
      }
    }
    // The composed plan itself failed validation (rare — a healthy pool
    // does not guarantee a healthy SCHEDULE, e.g. a genuine budget
    // conflict) — fall through to the existing Gemini-first path as a
    // safety net rather than ever returning an invalid plan.
    logGenerationStage("portfolio-first composition failed validation — falling back to Gemini-first path", {
      failingDiagnostics: describeFailingDiagnostics(composedDiagnostics),
    });
  }

  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const raw = await generateWithGemini(
        normalizedPayload,
        profile,
        exchangeRateContext,
        tripFrame,
        arrivalDepartureWindow,
        knowledge
      );
      logGenerationStage(`AI response parsing: received (attempt ${attempts})`);
      onProgress?.({ stage: "DAY_COMPOSITION", message: "בונים את תוכנית הימים", completedUnits: dayCount, totalUnits: dayCount });
      const repaired = repairPlan(
        raw,
        normalizedPayload,
        profile,
        tripFrame,
        exchangeRateContext,
        arrivalDepartureWindow,
        attempts === 1 ? 1 : 2
      );
      const diagnostics = collectPlanDiagnostics(repaired, profile, tripFrame, arrivalDepartureWindow, normalizedPayload.preferences.flights);
      onProgress?.({ stage: "REPAIR_VALIDATION", message: "בודקים את המסלול ומתקנים התנגשויות" });
      if (isPlanComplete(raw, normalizedPayload) && passesValidation(diagnostics)) {
        logGenerationStage(`schema validation: passed (attempt ${attempts})`);
        logGenerationStage(`AI generation parsed and validated (attempt ${attempts})`);
        const validated = await applyBestEffortRoutingValidation(repaired, normalizedPayload, profile).catch(
          () => repaired
        );
        onProgress?.({ stage: "ROUTING", message: "מחשבים זמני נסיעה ומעברים" });
        return {
          ...validated,
          model: ITINERARY_MODEL,
          usedFallback: false,
          generationSource: "gemini_repaired",
          candidateProviderStatus: resolveCandidateProviderStatus(normalizedPayload),
        };
      }
      logGenerationStage(`Gemini attempt ${attempts} produced an incomplete/invalid plan`, {
        isPlanComplete: isPlanComplete(raw, normalizedPayload),
        failingDiagnostics: describeFailingDiagnostics(diagnostics),
      });
      logGenerationStage(`schema validation: failed (attempt ${attempts})`);
    } catch (error) {
      logGenerationStage(`Gemini attempt ${attempts} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logGenerationStage("both Gemini attempts failed validation — falling back to deterministic template");

  // Round 9.4.1 §G — the exact question: does the fallback template
  // receive a trip that STILL genuinely has real supply (meaning the
  // composed/Gemini paths failed for reasons unrelated to real content,
  // and fallback itself is what goes on to build a synthetic-heavy plan),
  // or was real supply already gone by this point (meaning something
  // upstream already destroyed it and fallback is just inheriting the
  // damage)? Uses payload.recommendations (the supply) and
  // preGenerationPoolsByStay (already computed earlier in this same
  // call) — never a fresh discovery/pool rebuild just for this log.
  if (isPlannerQaTraceEnabled()) {
    const { realActivityRecommendations, realMealVenueRecommendations } = countRecommendationsByPlanningRole(normalizedPayload.recommendations);
    let activityPoolCandidates = 0;
    for (const pool of preGenerationPoolsByStay.values()) activityPoolCandidates += pool.candidates.length;
    logRealPlaceQA("FallbackEntry", {
      realActivities: realActivityRecommendations,
      realMeals: realMealVenueRecommendations,
      availableRecommendationCount: normalizedPayload.recommendations.length,
      activityPoolCandidates,
      reasonForFallback: "both Gemini attempts failed validation",
    });
  }

  onProgress?.({ stage: "DAY_COMPOSITION", message: "בונים את תוכנית הימים", completedUnits: dayCount, totalUnits: dayCount });
  const fallback = repairPlan(
    toRawGeneratedPlan(buildFallbackAiItinerary(normalizedPayload)),
    normalizedPayload,
    profile,
    tripFrame,
    exchangeRateContext,
    arrivalDepartureWindow
  );
  if (isPlannerQaTraceEnabled()) {
    const fallbackSnapshot = snapshotDayItemsForRepairTrace(fallback.days, tripFrame);
    const fallbackCounts = {
      realActivities: fallbackSnapshot.filter((i) => i.kind === "real_activity").length,
      realMeals: fallbackSnapshot.filter((i) => i.kind === "real_meal").length,
      freeTime: fallbackSnapshot.filter((i) => i.kind === "synthetic_activity").length,
      mealOpportunities: fallbackSnapshot.filter((i) => i.kind === "meal_opportunity").length,
    };
    logRealPlaceQA("FallbackOutput", fallbackCounts);
  }
  const fallbackDiagnostics = collectPlanDiagnostics(fallback, profile, tripFrame, arrivalDepartureWindow, normalizedPayload.preferences.flights);
  onProgress?.({ stage: "REPAIR_VALIDATION", message: "בודקים את המסלול ומתקנים התנגשויות" });

  // Round 9.3.3 continuation §7 / Round 9.3.7 §E — checked UNCONDITIONALLY,
  // never only as a side effect of the fallback template ALSO failing
  // budget/duplicates/cross-city: a deterministic template built from an
  // empty pool can be "clean" by every one of those measures (it has
  // nothing real to violate them with) while still being a catastrophic,
  // all-synthetic result of a genuine provider outage — that must never
  // reach the caller disguised as a normal successful itinerary just
  // because it happens not to also trip an unrelated diagnostic. Uses the
  // SAME trip-level assessment as the early gate above (never "any single
  // stay catastrophic") for consistency — a 1-of-7-stays provider failure
  // reaching this fallback-of-last-resort for an UNRELATED reason (e.g. a
  // genuine budget/duplicate problem) must still be diagnosed as THAT
  // problem, not disguised as a trip-wide discovery catastrophe.
  const fallbackStageTripHealth = assessTripDiscoveryHealth(
    preGenerationPoolsByStay,
    tripFrame,
    normalizedPayload.preferences.startDate,
    arrivalDepartureWindow
  );
  if (fallbackStageTripHealth.tripSupplyState === "CATASTROPHIC_PROVIDER_FAILURE") {
    throw new RealPlaceDiscoveryUnavailableError(
      "לא הצלחנו לאתר מקומות אמיתיים באזור אחד או יותר של הטיול בגלל תקלת ספק זמנית — לא בגלל מיעוט אמיתי של מקומות ביעד. כדאי לנסות שוב בעוד כמה דקות.",
      fallbackStageTripHealth.stayFailures.filter((stay) => isCatastrophicallyDiscoveryUnavailable(stay))
    );
  }

  if (fallbackDiagnostics.outOfBudget || fallbackDiagnostics.duplicatePlaces > 0 || fallbackDiagnostics.crossCityDays > 0) {
    // The deterministic template is budget-driven by construction, so this
    // should be unreachable in practice — but per spec, a severely broken
    // plan must never be saved silently. Fail loudly with a clear reason
    // instead of returning something invalid.
    //
    // crossCityDays added here as a real fix, not just a stricter check
    // (generic worldwide architecture pass): this fallback path used to be
    // accepted purely on budget/duplicates, with no geographic check at
    // all — real Gemini output already gets rejected for a cross-city day
    // (passesValidation requires crossCityDays === 0), but the fallback
    // template had no equivalent backstop. selectFallbackCandidate now
    // hard-filters candidates geographically at the source, so this should
    // be unreachable in practice too — but the same "never save it
    // silently" principle applies here as it does to budget/duplicates.
    logGenerationStage("failed at fallback-template stage", {
      failingDiagnostics: describeFailingDiagnostics(fallbackDiagnostics),
    });

    // Round 9.1 §16/§17 — the decision between a genuine SUPPLY failure and
    // a PLANNER/QUALITY failure, using the SAME pool diagnostics the
    // failure summary below reports (never inferred from the HTTP status
    // alone). Computed unconditionally (not just under the QA flag) since
    // it decides WHICH error class is thrown further down.
    const failureClassification = classifyPlanFailure(preGenerationPoolsByStay, fallbackDiagnostics);

    // Spec "FINAL FAILURE SUMMARY" — one compact block right before the
    // PLAN_NOT_FEASIBLE/BUDGET_NOT_FEASIBLE/INSUFFICIENT_REAL_ACTIVITY_SUPPLY
    // throw, aggregating every trace signal this pass added so the NEXT
    // real replay explains itself causally instead of only showing the
    // final diagnostic counts. QA-gated like every other trace output in
    // this pass — never runs in production, never changes which error is
    // thrown (that decision is made above, unconditionally).
    if (isPlannerQaTraceEnabled()) {
      const identityCounts = new Map<string, number>();
      const identitySources = new Map<string, Set<string>>();
      for (const day of fallback.days) {
        for (const item of day.items) {
          const identity = computeCanonicalPlaceIdentity(item, normalizePlaceNameSlug(item.name));
          if (identity.kind !== "real" || !identity.identity) continue;
          identityCounts.set(identity.identity, (identityCounts.get(identity.identity) ?? 0) + 1);
          for (const event of findInsertionsByIdentity(identity.identity)) {
            const set = identitySources.get(identity.identity) ?? new Set<string>();
            set.add(event.source);
            identitySources.set(identity.identity, set);
          }
        }
      }
      const duplicateCanonicalIdentities = [...identityCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([identity]) => identity);
      const duplicateSources = Object.fromEntries(
        duplicateCanonicalIdentities.map((identity) => [identity, [...(identitySources.get(identity) ?? [])]])
      );

      const areaAnchors = computeAreaAnchors(normalizedPayload);
      const mobilityProfile = computeDestinationMobilityProfile(
        [...normalizedPayload.recommendations, ...normalizedPayload.selectedPlaces].map((recommendation) => ({
          lat: recommendation.lat,
          lon: recommendation.lon,
        }))
      );
      const geoDiagnostics = computeGeographyDiagnostics(
        fallback.days,
        tripFrame,
        areaAnchors,
        mobilityProfile,
        normalizedPayload,
        profile,
        arrivalDepartureWindow
      );
      const geoSummary = summarizeGeographyDiagnostics(geoDiagnostics);
      const dayTypeMismatchDays = geoDiagnostics.filter((day) => day.dayTypeMismatch).length;
      const legalPoolExhaustionCount = getPoolStageLogs().filter(
        (log) => log.stage === "final_legal_pool" && log.size === 0
      ).length;
      // Spec §E "explain the legal-pool exhaustions" — a pure aggregate
      // read of the same pool-stage logs, never new per-item spam. When
      // exhaustion is dominated by already_used_filter, that is the
      // CORRECT outcome once §A-§D are fixed (every local real candidate
      // genuinely already scheduled elsewhere) — the right next step is a
      // FreeTimeBlock/sparse day, never recycling, so a HIGHER count here
      // after this pass is expected, not itself a regression.
      const legalPoolExhaustionReasons = classifyPoolExhaustionReasons();

      console.log(
        "[PlannerFailureSummary]",
        JSON.stringify(
          {
            code: failureClassification.code,
            primaryFailure: failureClassification.primaryFailure,
            secondaryFailures: failureClassification.secondaryFailures,
            elapsedMs: Date.now() - generationStartedAt,
            stays: failureClassification.stayFailures.map((stay) => ({
              stayId: stay.stayId,
              owner: stay.owner,
              requiredRealActivities: stay.requiredRealActivities,
              desiredCandidates: stay.desiredCandidates,
              legalCandidates: stay.legalCandidates,
              providerRequests: stay.providerRequests,
              providerFailures: stay.providerFailures,
              scheduledRealActivities: null, // no finalized days exist at this failure point (both Gemini attempts + the fallback template all failed before finalization)
              qualityFailure: stay.belowMinimum ? "supply" : null,
            })),
            duplicatePlaces: fallbackDiagnostics.duplicatePlaces,
            illegalScheduledRealPlaces: geoSummary.illegalScheduledRealPlaces,
            openingHoursViolations: fallbackDiagnostics.openingHoursViolations,
            syntheticOnlyNormalDays: null, // quality validation runs post-finalization; unreachable at this failure point
            stage: "fallback-template",
            failingDiagnostics: describeFailingDiagnostics(fallbackDiagnostics),
            duplicateCanonicalIdentities,
            duplicateSources,
            ownerAnchorMissingDays: geoSummary.ownerGeometryMissingDays,
            realItemsWithNullLegGeometry: geoSummary.realItemsWithNullLegGeometry,
            dayTypeMismatchDays,
            legalPoolExhaustionCount,
            legalPoolExhaustionReasons,
            overpassStats: getOverpassCallStats(),
          },
          null,
          2
        )
      );
    }

    if (failureClassification.code === "REAL_PLACE_DISCOVERY_UNAVAILABLE") {
      throw new RealPlaceDiscoveryUnavailableError(
        "לא הצלחנו לאתר מקומות אמיתיים באזור אחד או יותר של הטיול בגלל תקלת ספק זמנית — לא בגלל מיעוט אמיתי של מקומות ביעד. כדאי לנסות שוב בעוד כמה דקות.",
        failureClassification.stayFailures
      );
    }
    if (failureClassification.code === "INSUFFICIENT_REAL_ACTIVITY_SUPPLY") {
      throw new InsufficientRealActivitySupplyError(
        "הספק האמיתי של פעילויות באזור אחד או יותר של הטיול היה נמוך מדי כדי לבנות מסלול שימושי, גם אחרי ניסיון השלמה.",
        failureClassification.stayFailures
      );
    }
    // Round 9.4.3 §J — the same "do not return generic PLAN_NOT_FEASIBLE
    // when exact real-place duplicate identity is known" rule as
    // repairPlan's own firewall, applied here too since `fallback` was
    // already fully repaired (including resolveExactIdDuplicates every
    // attempt) and repairPlan's own internal firewall would already have
    // thrown a precise error if it detected a survivor — this is a second,
    // independent computation directly off `fallback.days` in case that
    // internal firewall's own duplicate view (built from `repairedDays`
    // mid-loop) ever diverges from `fallbackDiagnostics.duplicatePlaces`
    // (built from the fully finalized `fallback`).
    if (fallbackDiagnostics.duplicatePlaces > 0) {
      const duplicates = computeRealPlaceDuplicateGroups(fallback.days, tripFrame);
      if (duplicates.length > 0) {
        throw new RealPlaceDuplicatesRemainError(
          `${duplicates.length} real place(s) are scheduled more than once across the itinerary: ${duplicates.map((group) => group.name).join(", ")}.`,
          { duplicateCount: duplicates.length, duplicates }
        );
      }
    }
    throw new ItineraryGenerationInfeasibleError(
      failureClassification.code === "BUDGET_NOT_FEASIBLE" ? "BUDGET_NOT_FEASIBLE" : "PLAN_NOT_FEASIBLE",
      fallbackDiagnostics.outOfBudget
        ? "לא הצלחנו לבנות מסלול בטווח התקציב שהוגדר, גם אחרי תיקון אוטומטי."
        : fallbackDiagnostics.duplicatePlaces > 0
          ? "לא הצלחנו להסיר כפילויות מהמסלול, גם אחרי תיקון אוטומטי."
          : "לא הצלחנו לשמור על עקביות גאוגרפית במסלול, גם אחרי תיקון אוטומטי."
    );
  }

  logGenerationStage("fallback template accepted");

  return {
    ...fallback,
    summary: buildGenerationSummary(fallback, profile),
    model: ITINERARY_MODEL,
    usedFallback: true,
    generationSource: "fallback_template",
    candidateProviderStatus: resolveCandidateProviderStatus(normalizedPayload),
  };
}
