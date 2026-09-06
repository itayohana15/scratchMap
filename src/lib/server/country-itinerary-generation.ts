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

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { estimateMinutesForMode, selectTransportMode, type TransportMode } from "@/lib/transport-mode";
import countryFactsData from "@/lib/facts/country-facts-data.json";
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
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
  MAX_STAY_STRUCTURE_REPAIR_PASSES,
  describeActivityMixTargets,
  applyShortStayViabilityRepair,
  buildStayTransitions,
  repairImpossibleStayTransition,
  reorderAreasForDepartureFeasibility,
  reorderAreasToMinimizeBacktracking,
  type TripFrameDayTripHint,
  type TripFramePlanningTrace,
  resolveItemEffectiveEndTime,
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
import { describeHolidayContext } from "@/lib/facts/jewish-holidays";
import { getOverpassCallStats } from "@/lib/places/overpass";
import { fetchDrivingRouteBestEffort } from "@/lib/routing/osrm-server";
import {
  captureGeminiFixture,
  captureGeoResolutionFixture,
  captureOverpassStatsFixture,
  isFixtureCaptureEnabled,
  startFixtureCaptureSession,
  type GeoResolutionFixtureEntry,
} from "@/lib/server/fixture-capture";
import { violatesOpeningHours } from "./opening-hours";
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
  FUZZY_DUPLICATE_MAX_KM,
  isFuzzyDuplicatePlace,
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
export type ItineraryGenerationSource = "gemini_repaired" | "fallback_template";

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
]);

const SLOT_VALUES = new Set<DayPart>(["morning", "lunch", "afternoon", "dinner", "evening", "night"]);
const SLOT_ORDER: DayPart[] = ["morning", "lunch", "afternoon", "dinner", "evening", "night"];
const FOOD_CATEGORIES = new Set<RecommendationCategory>(["restaurant", "cafe"]);
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
function computeAreaAnchors(payload: AiItineraryRequest): Map<string, { lat: number; lon: number } | null> {
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

  let backtrackingReordered = false;
  if (!pinnedArea && phases.length >= 2) {
    const selectedAreaOrder = phases.map((phase) => phase.areaLabel);

    // Section "WIRE BACKTRACKING" — a real, coordinate-based reorder,
    // adopted only when it genuinely reduces the route's own backtracking
    // score.
    let finalAreaOrder = reorderAreasToMinimizeBacktracking(selectedAreaOrder, areaAnchors);
    backtrackingReordered = finalAreaOrder !== selectedAreaOrder;

    // The hard departure-airport constraint always has the final say on
    // which area ends the trip (spec "DO NOT REORDER FIXED CONSTRAINTS" —
    // optimization is subordinate to hard constraints) — applied last, on
    // whatever order backtracking optimization produced.
    finalAreaOrder = reorderAreasForDepartureFeasibility(
      finalAreaOrder,
      areaAnchors,
      payload.preferences.flights?.return?.departureAirport || null,
      payload.preferences.flights?.return?.departureTime || null
    );

    if (finalAreaOrder !== selectedAreaOrder) {
      phases = reorderPhasesByArea(phases, finalAreaOrder);
    }
  }

  // Section "WIRE SHORT-STAY VIABILITY" — every interior 1-night phase
  // must earn its own hotel change; a real production pass, not a
  // QA-only computation.
  const shortStayResult = applyShortStayViabilityRepair({ bucketId: bucket.id, phases, source: "deterministic" }, areaAnchors, areaCounts);
  phases = shortStayResult.frame.phases;

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
    const nextPhases = frame.phases.map((phase, index) => {
      const match = parsed.phases!.find((entry) => entry.index === index);
      if (!match || !match.areaLabel?.trim()) return phase;
      const intent = TRIP_FRAME_INTENT_VALUES.has(match.intent as TripFramePhase["intent"])
        ? (match.intent as TripFramePhase["intent"])
        : phase.intent;
      const proposedLabel = match.areaLabel.trim();
      const proposedHasAnchor = areaAnchors.get(normalizeAreaLabel(proposedLabel)) != null;
      if (!proposedHasAnchor) {
        logGenerationStage("refineTripFrameWithGemini: rejected an anchor-less rename", {
          phaseIndex: index,
          originalAreaLabel: phase.areaLabel,
          rejectedProposedLabel: proposedLabel,
        });
      }
      return { ...phase, areaLabel: proposedHasAnchor ? proposedLabel : phase.areaLabel, intent };
    });

    return { ...frame, phases: nextPhases, source: "ai" };
  } catch {
    return frame;
  }
}

async function buildTripFrame(
  payload: AiItineraryRequest,
  dayCount: number,
  knowledge?: CountryAiRecommendation | null
): Promise<TripFrame> {
  const deterministicFrame = buildDeterministicTripFrame(payload, dayCount);
  if (deterministicFrame.phases.length <= 1) return deterministicFrame;
  return refineTripFrameWithGemini(deterministicFrame, payload, knowledge);
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

function sharesDayArea(left: string, right: string) {
  const normalizedLeft = normalizeAreaLabel(left).toLowerCase();
  const normalizedRight = normalizeAreaLabel(right).toLowerCase();
  return (
    !!normalizedLeft &&
    !!normalizedRight &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  );
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

export function scoreMealCandidate(
  recommendation: AiItineraryRequest["recommendations"][number],
  day: AiGeneratedDay,
  slot: DayPart,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>,
  payload: AiItineraryRequest
) {
  let score = 0;
  const { anchor, nextAnchor } = getRelevantMealAnchors(day, slot);
  const isExplicitMealRequest = payload.selectedPlaces.some((place) => place.id === recommendation.id);
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

  if (slot === "lunch" && recommendation.category === "cafe") score += 18;
  if (slot === "dinner" && recommendation.category === "restaurant") score += 18;
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
  return score;
}

export function pickNearbyMealRecommendation(
  payload: AiItineraryRequest,
  day: AiGeneratedDay,
  slot: DayPart,
  profile: TripPreferenceProfile,
  usedMealNames: Set<string>
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
  const geographicallyCompatible = candidates.filter((recommendation) =>
    isCandidateGeographicallyCompatibleWithDay(recommendation, day.items, {
      isDayTripDay: isDayTripDay(day),
    })
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
        payload
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
 * Real code-level opening-hours enforcement (spec items 16/17, regression
 * tests 84/85) — items are only ever swapped when `violatesOpeningHours`
 * confidently says so (parsed both the hours and the planned start time;
 * see opening-hours.ts's "never reject what we can't parse" rule), never
 * guessed from ambiguous source text. Same substitution pattern as
 * `repairDayGeography`: prefer a real matching candidate, fall back to a
 * generic free-exploration replacement. Bounded per day so a day with
 * several violations still converges without looping the whole plan.
 */
export function repairOpeningHoursViolations(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  // Root-cause fix (spec §A/§F "opening_hours_repair must never reinsert a
  // globally used real POI") — built ONCE from the CURRENT full itinerary,
  // then mutated in place across every day this .map() processes, so a
  // replacement chosen for day 3 is visible as used when day 30 runs its
  // own repair later in this SAME pass. The old code rebuilt a fresh Set
  // from only `nextDay.items` (that one day alone) on every call, so this
  // function had zero visibility into any other day's content at all.
  const usageState = buildItineraryUsageState(days);
  return days.map((day) => {
    let nextDay = day;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const violatingItem = nextDay.items.find(
        (item) => !item.locked && !item.fixedTime && violatesOpeningHours(item)
      );
      if (!violatingItem) break;

      releaseItineraryUsage(usageState, violatingItem);
      const replacement = pickReplacementRecommendation({
        traceSource: "opening_hours_repair",
        payload,
        day: nextDay,
        item: violatingItem,
        profile,
        usageState,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, violatingItem, nextDay, payload)
        : buildFreeExplorationReplacement(violatingItem, nextDay);
      registerItineraryUsage(usageState, nextItem);
      nextDay = fillDerivedDayFields(
        resequenceDayItems(replaceItemInDay(nextDay, violatingItem, nextItem)),
        payload,
        profile
      );
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
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
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
      usedMealNames
    );

    const nextMealItem = recommendation
      ? buildSupplementalMealItem(recommendation, missingMealSlot, nextDay, payload)
      : buildFallbackMealPlaceholder(nextDay, missingMealSlot, payload, usedMealNames);

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
  arrivalDepartureWindow?: ArrivalDepartureWindow | null
) {
  let nextDay = resequenceDayItems({ ...day, items: sortItems(day.items.map(normalizeGeneratedItemCoordinates)) });
  for (const item of nextDay.items) releaseItineraryUsage(usageState, item);
  nextDay = insertMissingMeals(nextDay, payload, profile, usedMealNames, dayCount, arrivalDepartureWindow);

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
  nextDay = insertMissingMeals(resequenceDayItems(nextDay), payload, profile, usedMealNames, dayCount, arrivalDepartureWindow);

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
    // Generic worldwide architecture (Phase 5/14): a HARD reject, not just
    // a scoring penalty — a candidate that scoreRouteProximity would rank
    // well on other dimensions could still be genuinely in a different
    // city/region from everything already in this day. Judged against
    // every existing item's real coordinates, not just the immediate
    // anchor, so it still catches a mismatch even when the "anchor" happens
    // to be the one out-of-place item itself.
    .filter((candidate) =>
      isCandidateGeographicallyCompatibleWithDay(candidate, dayExcludingTarget.items, {
        isDayTripDay: isDayTripDay(dayExcludingTarget),
        maxDistanceKm: args.maxDistanceKm,
      })
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
      .filter((recommendation) =>
        isCandidateGeographicallyCompatibleWithDay(
          recommendation,
          day.items.filter((entry) => entry !== replaceableEntry.item),
          { isDayTripDay: isDayTripDay(day) }
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
        .filter(({ item }) => !isFoodItem(item.category) && !item.locked && !item.fixedTime)
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
        isCandidateGeographicallyCompatibleWithDay(candidate, day.items, { isDayTripDay: isDayTripDay(day) })
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
  profile: TripPreferenceProfile
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

      const targetIndex = findCompatibleDayIndexForOutlier(workingDays, dayIndex, outlier, profile);
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

/** Nearest OTHER day whose own items already sit close to the outlier, with room left under its own capacity — never a day already flagged as a transfer/day-trip, whose cross-region spread is expected. */
function findCompatibleDayIndexForOutlier(
  days: AiGeneratedDay[],
  originIndex: number,
  outlier: AiGeneratedItem,
  profile: TripPreferenceProfile
): number | null {
  if (outlier.lat == null || outlier.lon == null) return null;

  let bestIndex: number | null = null;
  let bestDistanceKm = CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM;

  for (let index = 0; index < days.length; index += 1) {
    if (index === originIndex) continue;
    const candidateDay = days[index];
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

function buildStayTransitionItem(transition: StayTransition): AiGeneratedItem {
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

  for (const transition of transitions) {
    const requiredMinutes = transition.estimatedTravelMinutes;
    if (requiredMinutes == null || requiredMinutes <= 0) continue;

    const dayIndex = mutableDays.findIndex((day) => day.dayNumber === transition.dayNumber);
    if (dayIndex === -1) continue;
    let day = mutableDays[dayIndex];

    // Section Q — a marked item from an EARLIER structural repair pass
    // (spec §A) whose fromBase/toBase no longer matches the current
    // TripFrame is demonstrably stale (only this function ever sets this
    // marker, so there's no ambiguity about whose content it is) — the
    // exact real bug: "day base = Mitzpe Ramon, transportation item =
    // Tel Aviv → Jerusalem" surviving a stay-structure change. Removed and
    // rebuilt from the FINAL frame below. A transportation item with no
    // marker at all (Gemini's own real content) is never touched here —
    // only ever a candidate for the OTHER geographic repair passes, never
    // deleted outright by this one.
    const currentMarker = buildTransitionMarker(transition.fromBase, transition.toBase);
    const staleMarkedItems = day.items.filter(
      (item) => item.canonicalPlaceId.startsWith("transition:") && item.canonicalPlaceId !== currentMarker
    );
    if (staleMarkedItems.length > 0) {
      day = { ...day, items: day.items.filter((item) => !staleMarkedItems.includes(item)) };
      mutableDays[dayIndex] = day;
    }

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
    if (isIntercityTransferDay(day)) return day;
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
          if (belongsToAnotherStay) violationReason = "belongs_to_another_stay";
          else if (tooFarFromBase) violationReason = "too_far_from_base";
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
        // should be proven, not presumed": on a NORMAL day, an unresolved
        // item with NO location text at all is no longer given a free
        // pass just because it can't be textually disproven — unproven
        // geography on a normal day is itself the defect. Day-trip/
        // transfer days keep the lighter rule (a positive match to a
        // DIFFERENT modeled stay only) — those day types are explicitly
        // *supposed* to have real content away from base, so "did not
        // resolve, no text at all" is not by itself suspicious there the
        // way it is on a normal day; a full real travel-time/value-ratio
        // feasibility check (never applied only to this quick rule) is
        // deferred (see final report).
        const itemLocation = item.location.trim();
        const matchesOwnArea = itemLocation ? resolveTextualAreaMatch(itemLocation, phase.areaLabel) : false;
        const matchedOtherPhase = itemLocation
          ? tripFrame.phases.find((otherPhase) => otherPhase !== phase && resolveTextualAreaMatch(itemLocation, otherPhase.areaLabel))
          : undefined;

        const isViolation = isExemptDayType ? Boolean(matchedOtherPhase) : !matchesOwnArea;
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
}

export function summarizeGeographyDiagnostics(diagnostics: DayGeographyDiagnostic[]): GeographyDiagnosticsSummary {
  let realItemsWithNullLegGeometry = 0;
  let realItemsWithUnresolvedOwnerGeometry = 0;
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
    }
  }

  return {
    realItemsWithNullLegGeometry,
    realItemsWithUnresolvedOwnerGeometry,
    ownerGeometryMissingDays: ownerGeometryMissingDayNumbers.size,
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
const TRANSPORT_INFRASTRUCTURE_NAME_PATTERN =
  /international airport|\bairport\b|train station|railway station|bus terminal|bus station|metro station|subway station|נמל תעופה|שדה תעופה|תחנת רכבת|תחנה מרכזית/i;

export interface TransportRoleViolation {
  dayNumber: number;
  itemName: string;
  repaired: boolean;
}

/**
 * Spec "AIRPORTS ARE NOT ATTRACTIONS" — transport infrastructure (an
 * airport, station, terminal) may only occupy a normal-attraction slot
 * when it's genuinely serving a transfer role: either already categorized
 * as transportation, or on a day this codebase already classifies as an
 * intercity transfer. Anywhere else, a Gemini-authored item that's really
 * just a famous airport/station masquerading as a sightseeing stop is
 * repaired the same way any other invalid item is (real nearby candidate
 * first, free exploration second) — never removed silently, never kept.
 */
export function enforceTransportRoleGuard(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): { days: AiGeneratedDay[]; violations: TransportRoleViolation[] } {
  const violations: TransportRoleViolation[] = [];
  const mutableDays = [...days];
  // Root-cause fix (spec §A/§F) — see enforceNormalDayLocality's identical comment.
  const usageState = buildItineraryUsageState(mutableDays);

  for (let dayIndex = 0; dayIndex < mutableDays.length; dayIndex += 1) {
    const day = mutableDays[dayIndex];
    let mutableDay = day;
    let changed = false;

    for (const item of day.items) {
      if (item.category === "transportation") continue; // already the legitimate role
      if (!TRANSPORT_INFRASTRUCTURE_NAME_PATTERN.test(item.name)) continue;
      if (isIntercityTransferDay(day)) continue; // arrival/departure/connection context — a legitimate mention

      if (isProtectedItem(item)) {
        violations.push({ dayNumber: day.dayNumber, itemName: item.name, repaired: false });
        continue;
      }

      releaseItineraryUsage(usageState, item);
      const replacement = pickReplacementRecommendation({
        traceSource: "other_existing_path",
        payload,
        day: mutableDay,
        item,
        profile,
        usageState,
      });
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

function finalizeArrivalDepartureContent(
  plan: AiItineraryResponse,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayCount: number,
  window: ArrivalDepartureWindow,
  tripFrame: TripFrame,
  areaAnchors: Map<string, { lat: number; lon: number } | null>,
  mobilityProfile: DestinationMobilityProfile
): AiItineraryResponse {
  const { days: localityRepairedDays } = enforceNormalDayLocality(
    removeFuzzyDuplicatePlaces(plan.days, payload, profile),
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
  const { days: roleRepairedDays } = enforceTransportRoleGuard(localityRepairedDays, payload, profile);
  const finalizedDays = ensureArrivalDepartureDayHasContent(roleRepairedDays, payload, profile, dayCount, window);

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
  // Root-cause fix (spec §G "Gemini can still author duplicates... at
  // ingestion: if resolved canonical identity is already present elsewhere,
  // reject/replace it before downstream repairs") — shared and mutated
  // across this whole per-day build loop AND threaded into
  // repairDayStructure/repairDayGeography below (same object, same
  // itinerary-wide semantics point A demands for every repair pass).
  const usageState = createItineraryUsageState();

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

    days.push(repairDayStructure(normalizedDay, payload, profile, index, dayCount, usedMealNames, usageState, arrivalDepartureWindow));
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
  // Real coordinate centroid per area — shared by the structural-repair
  // feasibility check below and the initial StayTransition build, one
  // geography source rather than two.
  const areaAnchors = computeAreaAnchors(payload);
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

  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Root-cause fix (spec §C — "build canonical usage state from the
    // CURRENT itinerary" before each pass, "do not recompute from the
    // original pre-repair itinerary after mutations") — fresh from
    // repairedDays as this attempt actually starts, not reused across
    // attempts and not the empty state the very first build loop began
    // with.
    const structuralRepairUsageState = buildItineraryUsageState(repairedDays);
    repairedDays = repairedDays.map((day, index) =>
      repairDayStructure(normalizeDayCollections(day), payload, profile, index, dayCount, iterationMealNames, structuralRepairUsageState, arrivalDepartureWindow)
    );
    repairedDays = ensureMustVisitCoverage(repairedDays, payload, profile);

    // Repairs content Gemini itself already returned wrong BEFORE the
    // title/cityRegion sync below — otherwise alignDaysToTripFrame would
    // just relabel a day to match its base while the day still contains
    // another region's activities (spec §B/§C6).
    const crossRegionRepair = repairCrossRegionDayContent(repairedDays, payload, profile);
    repairedDays = crossRegionRepair.days;
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
      currentTripFrame = structureRepair.tripFrame;
      stayTransitions = structureRepair.stayTransitions;
    }

    repairedDays = alignDaysToTripFrame(repairedDays, currentTripFrame);

    // Section C2/C3: no overnight teleportation — every base change gets a
    // real, visible transition item reserving its own real time, before
    // any later step (rebalance/overload/budget) decides how much
    // optional content the day can still hold.
    const transitionRepair = enforceStayTransitions(repairedDays, stayTransitions, payload, profile);
    repairedDays = transitionRepair.days;
    impossibleStayTransitionDetails = transitionRepair.impossibleStayTransitionDetails;

    const rebalanceUsageState = createItineraryUsageState();
    repairedDays = repairedDays.map((day) =>
      rebalanceDayItems(normalizeDayCollections(day), payload, profile, rebalanceUsageState)
    );
    repairedDays = fixOverloadedDays(repairedDays, payload, profile);
    repairedDays = repairOpeningHoursViolations(repairedDays, payload, profile);
    repairedDays = enforceMealCountLimit(repairedDays, payload, profile);
    repairedDays = enforceMealSpacing(repairedDays, payload, profile);
    repairedDays = ensureWeatherBackup(repairedDays, payload);

    // Real fix, not just a diagnostic (spec item 23) — arrival/departure
    // days are skipped here since their window is intentionally narrower
    // and already handled by their own dedicated enforcement below.
    const fillUsageState = buildItineraryUsageState(repairedDays);
    repairedDays = repairedDays.map((day) =>
      day.dayNumber === 1 || day.dayNumber === dayCount
        ? day
        : fillUnderfilledDay(day, payload, profile, fillUsageState)
    );

    repairedDays = capArrivalDepartureDays(repairedDays, payload, profile, dayCount);
    repairedDays = enforceArrivalDepartureWindow(repairedDays, payload, profile, arrivalDepartureWindow, dayCount);
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
    repairedDays = lightenHighEnergyStreaks(repairedDays, payload, profile);
    repairedDays = enforceBudgetOnDays(repairedDays, payload, profile).map((day) =>
      fillDerivedDayFields(normalizeDayCollections(day), payload, profile)
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
    repairedDays = repairedDays.map((day) => {
      const withMeals = insertMissingMeals(day, payload, profile, iterationMealNames, dayCount, arrivalDepartureWindow);
      return withMeals === day ? day : fillDerivedDayFields(resequenceDayItems(withMeals), payload, profile);
    });
    repairedDays = enforceMealSpacing(repairedDays, payload, profile);
    // Defense in depth, same reasoning as enforceMealSpacing just above:
    // insertMissingMeals is now window-aware and should never insert an
    // infeasible meal in the first place, but re-running the window
    // enforcement here catches anything else this whole block (or any
    // earlier repair step not itself window-aware) could have pushed past
    // the real arrival/departure cutoff.
    repairedDays = enforceArrivalDepartureWindow(repairedDays, payload, profile, arrivalDepartureWindow, dayCount);

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
      const travelRepair = repairNormalDayTravelOutliers(repairedDays, mobilityProfile, payload, profile, removedItemKeysByDay);
      repairedDays = travelRepair.days;
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
      repairedDays = diversifyActivities(
        repairedDays,
        payload,
        profile,
        diagnostics.dominantCategory,
        diagnostics.activityMixSkew
      ).map((day) => fillDerivedDayFields(normalizeDayCollections(day), payload, profile));

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
      const finalPlan = finalizeArrivalDepartureContent(repairedPlan, payload, profile, dayCount, arrivalDepartureWindow, currentTripFrame, areaAnchors, mobilityProfile);
      return {
        ...finalPlan,
        summary: buildGenerationSummary(finalPlan, profile),
      };
    }
  }

  const finalFallbackPlan = finalizeArrivalDepartureContent(lastPlan ?? fallback, payload, profile, dayCount, arrivalDepartureWindow, currentTripFrame, areaAnchors, mobilityProfile);
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

export async function generateCountryItineraryPlan(
  payload: AiItineraryRequest,
  knowledge?: CountryAiRecommendation | null
): Promise<GeneratedCountryItineraryPlan> {
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
  const normalizedPayload = normalizePayloadPrices(payload, exchangeRateContext);
  logGenerationStage("airport data: normalized", { recommendations: normalizedPayload.recommendations.length });
  const profile = buildTripPreferenceProfile(
    normalizedPayload.preferences,
    normalizedPayload.countryName,
    dayCount
  );
  logGenerationStage("dietary preferences: parsed", { hasDietaryPreferences: Boolean(normalizedPayload.preferences.dietaryPreferences?.trim()) });
  const tripFrame = await buildTripFrame(normalizedPayload, dayCount, knowledge);
  const arrivalDepartureWindow = computeArrivalDepartureWindow(
    normalizedPayload.preferences.flights,
    normalizedPayload.isoA2
  );

  logGenerationStage("AI generation started", {
    isoA2: normalizedPayload.isoA2,
    dayCount,
    candidateRecommendations: normalizedPayload.recommendations.length,
    selectedPlaces: normalizedPayload.selectedPlaces.length,
  });

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
      if (isPlanComplete(raw, normalizedPayload) && passesValidation(diagnostics)) {
        logGenerationStage(`schema validation: passed (attempt ${attempts})`);
        logGenerationStage(`AI generation parsed and validated (attempt ${attempts})`);
        const validated = await applyBestEffortRoutingValidation(repaired, normalizedPayload, profile).catch(
          () => repaired
        );
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

  const fallback = repairPlan(
    toRawGeneratedPlan(buildFallbackAiItinerary(normalizedPayload)),
    normalizedPayload,
    profile,
    tripFrame,
    exchangeRateContext,
    arrivalDepartureWindow
  );
  const fallbackDiagnostics = collectPlanDiagnostics(fallback, profile, tripFrame, arrivalDepartureWindow, normalizedPayload.preferences.flights);
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

    // Spec "FINAL FAILURE SUMMARY" — one compact block right before the
    // PLAN_NOT_FEASIBLE/BUDGET_NOT_FEASIBLE throw, aggregating every trace
    // signal this pass added so the NEXT real replay explains itself
    // causally instead of only showing the final diagnostic counts.
    // QA-gated like every other trace output in this pass — never runs in
    // production, never changes which error is thrown.
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
            stage: "fallback-template",
            failingDiagnostics: describeFailingDiagnostics(fallbackDiagnostics),
            duplicateCount: fallbackDiagnostics.duplicatePlaces,
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

    throw new ItineraryGenerationInfeasibleError(
      fallbackDiagnostics.outOfBudget ? "BUDGET_NOT_FEASIBLE" : "PLAN_NOT_FEASIBLE",
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
