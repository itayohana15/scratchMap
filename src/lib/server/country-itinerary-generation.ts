import { GoogleGenAI, Type } from "@google/genai";

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
import countryFactsData from "@/lib/facts/country-facts-data.json";
import {
  analyzeDayGeography,
  buildGenerationSummary,
  buildTripPreferenceProfile,
  calculateDayLoadMinutes,
  collectPlanDiagnostics,
  findFramePhaseForDay,
  IDEAL_LOCAL_TRAVEL_MINUTES,
  isIntercityTransferDay,
  getBudgetCapForItem,
  MAX_LOCAL_TRAVEL_MINUTES,
  MAX_NORMAL_DAY_TRAVEL_MINUTES,
  isPremiumVenue,
  normalizeCoordinatePair,
  normalizeActionableMessages,
  scoreRouteProximity,
  scoreBudgetFitness,
  summarizeItemCosts,
  withNormalizedRecommendationPrice,
  type ExchangeRateContext,
  type PlanDiagnostics,
  type TripFrame,
  type TripFramePhase,
  type TripPreferenceProfile,
} from "@/lib/server/itinerary-generation-constraints";
import {
  buildTripFramePhases,
  classifyActivityTier,
  classifyItemEnergy,
  getTripLengthBucket,
  MAX_CONSECUTIVE_HIGH_ENERGY_DAYS,
  describeActivityMixTargets,
} from "@/lib/server/itinerary-planning-principles";
import { fetchDrivingRouteBestEffort } from "@/lib/routing/osrm-server";
import {
  buildFallbackAiItinerary,
  buildMapLink,
  buildWarnings,
  dateForDayNumber,
  estimateTravelMinutes,
  getTripDayCount,
  haversineKm,
  ITINERARY_GENERATION_MODE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryRequest,
  type AiItineraryResponse,
  type DayPart,
  type ItemPriority,
  type RecommendationCategory,
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
  approximatePrice?: number;
  travelMinutes?: number;
  openingHours?: string;
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

export interface GeneratedCountryItineraryPlan extends AiItineraryResponse {
  model: string;
  usedFallback: boolean;
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
                approximatePrice: numberField("Estimated price."),
                travelMinutes: numberField("Travel time from previous stop in minutes."),
                openingHours: stringField("Opening hours if known, otherwise state unavailable."),
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
function buildDeterministicTripFrame(payload: AiItineraryRequest, dayCount: number): TripFrame {
  const bucket = getTripLengthBucket(dayCount);
  const areaCounts = new Map<string, number>();

  for (const recommendation of [...payload.recommendations, ...payload.selectedPlaces]) {
    const area = normalizeAreaLabel(recommendation.location);
    if (!area) continue;
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }

  const pinnedArea = normalizeAreaLabel(
    payload.preferences.accommodationArea || payload.preferences.preferredRegions || ""
  );

  let rankedAreas = [...areaCounts.entries()].sort((left, right) => right[1] - left[1]).map(([area]) => area);
  if (rankedAreas.length === 0) {
    rankedAreas = [normalizeAreaLabel(payload.countryName) || payload.countryName];
  }

  const phases = buildTripFramePhases(rankedAreas, areaCounts, dayCount, bucket, pinnedArea || null);
  return { bucketId: bucket.id, phases, source: "deterministic" };
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
    if (!raw) return frame;

    const parsed = JSON.parse(raw) as { phases?: Array<{ index: number; areaLabel: string; intent: string }> };
    if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) return frame;

    const nextPhases = frame.phases.map((phase, index) => {
      const match = parsed.phases!.find((entry) => entry.index === index);
      if (!match || !match.areaLabel?.trim()) return phase;
      const intent = TRIP_FRAME_INTENT_VALUES.has(match.intent as TripFramePhase["intent"])
        ? (match.intent as TripFramePhase["intent"])
        : phase.intent;
      return { ...phase, areaLabel: match.areaLabel.trim(), intent };
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
  return frame.phases
    .map((phase) => {
      const dayLabel = phase.startDayNumber === phase.endDayNumber
        ? `Day ${phase.startDayNumber}`
        : `Days ${phase.startDayNumber}-${phase.endDayNumber}`;
      return `${dayLabel} base: ${phase.areaLabel} (${phase.nights} night${phase.nights === 1 ? "" : "s"}, intent: ${phase.intent})`;
    })
    .join(" | ");
}

function buildPrompt(
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  exchangeRateContext: ExchangeRateContext | null,
  tripFrame: TripFrame,
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
          name: booking.name,
          type: booking.type,
          date: booking.date,
          time: booking.time,
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

  const tripFrameGuidance = [
    `Locked trip frame (decided before this prompt, geography-first): ${describeTripFrame(tripFrame)}.`,
    "Treat this trip frame as a hard constraint: every day's cityRegion and accommodation must match its assigned base/phase above, except for the specific day(s) where the frame itself transitions between phases (those become transfer days).",
    "Do not invent a different base city on a day that the frame assigns elsewhere.",
    `Advisory activity-mix target across the whole trip (guidance, not a hard rule): ${describeActivityMixTargets()}.`,
  ];

  return [
    "You are a practical itinerary planner, not a travel writer.",
    "Behavioral reference: plan like a strong independent traveler's multi-week trip, not like a generic sightseeing brochure.",
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
    `Dietary preferences: ${payload.preferences.dietaryPreferences || "ללא"}.`,
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
    `Daily capacity limit in minutes including travel and meals: ${profile.dailyCapacityMinutes}.`,
    `Budget allocation in percent: accommodation ${Math.round(profile.budgetAllocation.accommodation * 100)}%, food ${Math.round(profile.budgetAllocation.food * 100)}%, transportation ${Math.round(profile.budgetAllocation.transportation * 100)}%, attractions ${Math.round(profile.budgetAllocation.attractions * 100)}%, buffer ${Math.round(profile.budgetAllocation.buffer * 100)}%.`,
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
    "Every item's approximatePrice must be a realistic estimate in the destination's local currency (not ILS) — do not attempt to convert it yourself. The system converts every price to ILS and enforces the budget automatically after generation, using the local-currency estimate you provide.",
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
  return !isFoodItem(item.category) && item.category !== "transportation" && item.category !== "hotel";
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

function resequenceDayItems(day: AiGeneratedDay) {
  const normalizedItems = sortItems(day.items.map(normalizeGeneratedItemCoordinates));
  const transferDay = isIntercityTransferDay(day);

  if (transferDay) {
    return {
      ...day,
      items: normalizedItems.map<AiGeneratedItem>((item, index) => {
        const slot: DayPart =
          item.category === "transportation"
            ? index === 0
              ? "morning"
              : "afternoon"
            : item.slot;
        return {
          ...item,
          plannedStartTime: item.plannedStartTime || defaultSlotTime(slot),
          slot,
        };
      }),
    };
  }

  const transportationItems = normalizedItems.filter((item) => item.category === "transportation");
  const anchorItems = sortAnchorsByCluster(
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

  const lunch =
    mealItems.find((item) => item.slot === "lunch") ??
    mealItems.find((item) => item.category === "cafe") ??
    mealItems[0] ??
    null;
  const dinner =
    mealItems.find((item) => item.slot === "dinner") ??
    mealItems.find((item) => item !== lunch) ??
    null;
  const leftoverMeals = mealItems.filter((item) => item !== lunch && item !== dinner);
  const firstHalfCount = anchorItems.length >= 3 ? 2 : Math.min(anchorItems.length, 1);
  const firstHalfAnchors = anchorItems.slice(0, firstHalfCount);
  const secondHalfAnchors = anchorItems.slice(firstHalfCount);
  const ordered = [
    ...transportationItems.filter((item) => item.slot === "morning"),
    ...firstHalfAnchors,
    ...(lunch ? [lunch] : []),
    ...secondHalfAnchors,
    ...(dinner && dinner !== lunch ? [dinner] : []),
    ...leftoverMeals,
    ...transportationItems.filter((item) => item.slot !== "morning"),
    ...nonAnchorSupportingItems,
  ];

  let morningCount = 0;
  let afternoonCount = 0;
  let eveningCount = 0;
  let lunchAssigned = false;
  let dinnerAssigned = false;

  return {
    ...day,
    items: ordered.map<AiGeneratedItem>((item) => {
      if (isFoodItem(item.category)) {
        if (!lunchAssigned) {
          lunchAssigned = true;
          return { ...item, slot: "lunch", plannedStartTime: "12:45" };
        }
        if (!dinnerAssigned) {
          dinnerAssigned = true;
          return { ...item, slot: "dinner", plannedStartTime: "19:30" };
        }

        eveningCount += 1;
        return {
          ...item,
          slot: item.category === "cafe" ? "evening" : "night",
          plannedStartTime: item.category === "cafe" ? "21:00" : eveningCount > 1 ? "22:30" : "22:00",
        };
      }

      if (item.category === "transportation") {
        const slot = lunchAssigned && !dinnerAssigned ? "afternoon" : dinnerAssigned ? "evening" : "morning";
        return {
          ...item,
          slot,
          plannedStartTime:
            slot === "morning" ? "08:15" : slot === "afternoon" ? "14:15" : "20:30",
        };
      }

      if (!lunchAssigned) {
        morningCount += 1;
        return {
          ...item,
          slot: morningCount > 1 ? "afternoon" : "morning",
          plannedStartTime: morningCount > 1 ? "11:15" : "09:00",
        };
      }

      if (!dinnerAssigned) {
        afternoonCount += 1;
        return {
          ...item,
          slot: "afternoon",
          plannedStartTime: afternoonCount > 1 ? "16:30" : "14:45",
        };
      }

      eveningCount += 1;
      return {
        ...item,
        slot: item.category === "nightlife" ? "night" : "evening",
        plannedStartTime: item.category === "nightlife" ? "22:00" : eveningCount > 1 ? "21:45" : "21:00",
      };
    }),
  };
}

function findMissingMealSlots(items: AiGeneratedItem[]) {
  const missingSlots: DayPart[] = [];
  const hasLunch = items.some((item) => item.slot === "lunch" && isFoodItem(item.category));
  const hasDinner = items.some((item) => item.slot === "dinner" && isFoodItem(item.category));
  const hasDaytimeActivity = items.some(
    (item) =>
      !isFoodItem(item.category) &&
      (item.slot === "morning" || item.slot === "afternoon" || item.slot === "lunch")
  );
  const hasEveningActivity = items.some(
    (item) =>
      !isFoodItem(item.category) &&
      (item.slot === "afternoon" || item.slot === "evening" || item.slot === "night")
  );

  if (!hasLunch && hasDaytimeActivity) {
    missingSlots.push("lunch");
  }

  if (!hasDinner && (hasEveningActivity || items.length >= 2)) {
    missingSlots.push("dinner");
  }

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
  const proximity = scoreRouteProximity(recommendation, {
    anchor,
    nextStop: nextAnchor,
    pace: payload.preferences.tripPace,
    transportation:
      recommendation.category === "cafe"
        ? "הליכה"
        : payload.preferences.transportationPreferences ||
          day.transportation ||
          "תחבורה מקומית",
    hardLimitMinutes: MAX_LOCAL_TRAVEL_MINUTES,
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
  const ranked = [...payload.recommendations, ...payload.selectedPlaces]
    .filter((recommendation) => isFoodItem(recommendation.category))
    .filter((recommendation) => !isAccessibilityConflict(recommendation, payload))
    .filter((recommendation) => !isDietaryConflict(recommendation, profile))
    .filter((recommendation) => !usedNames.has(recommendation.name.trim().toLowerCase()))
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

  const closeEnough = ranked.find((entry) => entry.score > -20)?.recommendation;
  return closeEnough ?? ranked[0]?.recommendation ?? null;
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
    ...resolveItemPriceFields(recommendation.approximatePrice, recommendation, null),
    travelMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
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

function buildFallbackMealPlaceholder(
  day: AiGeneratedDay,
  slot: DayPart,
  payload: AiItineraryRequest
): AiGeneratedItem {
  const area = normalizeAreaLabel(day.cityRegion || day.items[0]?.location || payload.countryName);
  const isLunch = slot === "lunch";
  return {
    name: isLunch ? `שוק/אזור אוכל מקומי ב${area}` : `ארוחת ערב מקומית באזור ${area}`,
    category: isLunch ? "cafe" : "restaurant",
    location: area,
    shortDescription: isLunch
      ? `עצירת אוכל גמישה בתוך אזור ${area} כדי לא לייצר מעקף מיותר באמצע היום.`
      : `סיום יום נוח עם אוכל מקומי באזור ${area}, קרוב ללינה או לעצירה האחרונה.`,
    slot,
    plannedStartTime: defaultSlotTime(slot),
    estimatedDurationMinutes: isLunch ? 60 : 75,
    approximatePrice: null,
    priceOriginalAmount: null,
    priceOriginalCurrency: null,
    priceConvertedAmount: null,
    priceExchangeRate: null,
    priceRateTimestamp: null,
    convertedCurrency: null,
    sourceType: null,
    travelMinutes: 10,
    openingHours: "לא זמין",
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

function fillDerivedDayFields(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile?: TripPreferenceProfile
): AiGeneratedDay {
  const sourceItems = sortItems(day.items.map(normalizeGeneratedItemCoordinates));
  const items = sourceItems.map((item, index, currentItems) => {
      const previous = index > 0 ? currentItems[index - 1] : null;
      const travelMinutes =
        item.travelMinutes != null && item.travelMinutes > 0
          ? item.travelMinutes
          : previous
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

function replaceItemInDay(
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
  profile: TripPreferenceProfile
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
      const replacement = pickReplacementRecommendation({
        payload,
        day: nextDay,
        item: invalidItem,
        profile,
        usedPlaceKeys: new Set(nextDay.items.map((item) => buildItemKey(item))),
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, invalidItem, nextDay, payload)
        : buildFreeExplorationReplacement(invalidItem, nextDay);
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
        const replacement = pickReplacementRecommendation({
          payload,
          day: nextDay,
          item: invalidItem,
          profile,
          usedPlaceKeys: new Set(nextDay.items.map((item) => buildItemKey(item))),
        });
        const nextItem = replacement
          ? buildReplacementItem(replacement, invalidItem, nextDay, payload)
          : buildFreeExplorationReplacement(invalidItem, nextDay);
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
        const replacement = pickReplacementRecommendation({
          payload,
          day: nextDay,
          item: extraFoodItem,
          profile,
          usedPlaceKeys: new Set(nextDay.items.map((item) => buildItemKey(item))),
          replacementMode: "non_food",
          anchor: getPrimaryAnchor(nextDay),
        });

        if (replacement) {
          nextDay = fillDerivedDayFields(
            resequenceDayItems(
              replaceItemInDay(
                nextDay,
                extraFoodItem,
                buildReplacementItem(replacement, extraFoodItem, nextDay, payload)
              )
            ),
            payload,
            profile
          );
          changed = true;
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
        const replacement = pickNearbyMealRecommendation(
          payload,
          dayWithoutMeal,
          mealToReplace.slot === "dinner" ? "dinner" : "lunch",
          profile,
          new Set(
            dayWithoutMeal.items
              .filter((item) => isFoodItem(item.category))
              .map((item) => item.name.trim().toLowerCase())
          )
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
              payload
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
        const replacement = pickReplacementRecommendation({
          payload,
          day: nextDay,
          item: outlier,
          profile,
          usedPlaceKeys: new Set(nextDay.items.map((item) => buildItemKey(item))),
          anchor: primaryAnchor,
        });
        const nextItem = replacement
          ? buildReplacementItem(replacement, outlier, nextDay, payload)
          : buildFreeExplorationReplacement(outlier, nextDay);
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

function repairDayStructure(
  day: AiGeneratedDay,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  dayIndex: number,
  dayCount: number,
  usedMealNames: Set<string>
) {
  let nextDay = resequenceDayItems({ ...day, items: sortItems(day.items.map(normalizeGeneratedItemCoordinates)) });
  for (const missingMealSlot of findMissingMealSlots(nextDay.items)) {
    const recommendation = pickNearbyMealRecommendation(
      payload,
      nextDay,
      missingMealSlot,
      profile,
      usedMealNames
    );

    const nextMealItem = recommendation
      ? buildSupplementalMealItem(recommendation, missingMealSlot, nextDay, payload)
      : buildFallbackMealPlaceholder(nextDay, missingMealSlot, payload);

    if (nextMealItem && nextMealItem.name) {
      nextDay = {
        ...nextDay,
        items: [...nextDay.items, nextMealItem],
      };
    }
  }

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

  nextDay = repairDayGeography(nextDay, payload, profile);

  for (const meal of nextDay.items.filter((item) => isFoodItem(item.category))) {
    usedMealNames.add(meal.name.trim().toLowerCase());
  }

  return fillDerivedDayFields(resequenceDayItems(nextDay), payload, profile);
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
export function resolveItemPriceFields(
  rawPrice: number | null | undefined,
  matchedRecommendation: TripRecommendation | null,
  exchangeRateContext: ExchangeRateContext | null
): Pick<
  AiGeneratedItem,
  | "approximatePrice"
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
      priceOriginalAmount: matchedRecommendation.priceOriginalAmount ?? rawPrice ?? null,
      priceOriginalCurrency: matchedRecommendation.priceOriginalCurrency,
      priceConvertedAmount: matchedRecommendation.priceConvertedAmount,
      priceExchangeRate: matchedRecommendation.priceExchangeRate ?? null,
      priceRateTimestamp: matchedRecommendation.priceRateTimestamp ?? null,
      convertedCurrency: exchangeRateContext?.targetCurrency ?? "ILS",
      sourceType: "candidate",
    };
  }

  const price = rawPrice ?? matchedRecommendation?.approximatePrice ?? null;
  if (price != null && exchangeRateContext) {
    const convertedAmount = Math.round(price * exchangeRateContext.rateToTarget * 100) / 100;
    return {
      approximatePrice: convertedAmount,
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
    const priceFields = resolveItemPriceFields(item.approximatePrice, matchedRecommendation, exchangeRateContext);
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
  knowledge?: CountryAiRecommendation | null
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: ITINERARY_MODEL,
    contents: buildPrompt(payload, profile, exchangeRateContext, tripFrame, knowledge),
    config: {
      responseMimeType: "application/json",
      responseSchema: ITINERARY_SCHEMA,
    },
  });

  const raw = response.text;
  if (!raw) {
    throw new Error("Empty itinerary response from Gemini");
  }

  return JSON.parse(raw) as RawGeneratedPlan;
}

export function buildItemKey(item: Pick<AiGeneratedItem, "recommendationId" | "name" | "lat" | "lon" | "location">) {
  if (item.recommendationId) return `id:${item.recommendationId}`;
  if (item.lat != null && item.lon != null) {
    return `coords:${item.lat.toFixed(4)}:${item.lon.toFixed(4)}`;
  }
  return `name:${item.name.trim().toLowerCase()}::${item.location.trim().toLowerCase()}`;
}

function isAvoidedItem(item: Pick<AiGeneratedItem, "name" | "location" | "shortDescription">, profile: TripPreferenceProfile) {
  if (profile.avoidKeywords.length === 0) return false;
  return includesAnyKeyword(
    `${item.name} ${item.location} ${item.shortDescription}`,
    profile.avoidKeywords
  );
}

function buildCostsFromDays(days: AiGeneratedDay[], travelers: number) {
  return summarizeItemCosts(days, travelers);
}

function buildReplacementItem(
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

function buildFreeExplorationReplacement(item: AiGeneratedItem, day: AiGeneratedDay): AiGeneratedItem {
  const area = normalizeAreaLabel(day.cityRegion || item.location || day.accommodation || "");
  return {
    ...item,
    name: area ? `שיטוט חופשי ב${area}` : "שיטוט חופשי וגמיש",
    category:
      item.category === "museum" || isFoodItem(item.category) || item.category === "transportation"
        ? "hidden_gem"
        : item.category,
    location: area || item.location,
    shortDescription: area
      ? `חלופה גמישה וזולה באזור ${area} כדי לשמור על הקצב והתקציב בלי לנסוע רחוק.`
      : "חלופה גמישה וזולה באותו אזור כדי לשמור על קצב ותקציב.",
    approximatePrice: 0,
    priceOriginalAmount: 0,
    priceOriginalCurrency: "ILS",
    priceConvertedAmount: 0,
    priceExchangeRate: 1,
    priceRateTimestamp: new Date().toISOString(),
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
    ...resolveItemPriceFields(recommendation.approximatePrice, recommendation, null),
    travelMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
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

function pickReplacementRecommendation(args: {
  payload: AiItineraryRequest;
  day: AiGeneratedDay;
  item: AiGeneratedItem;
  profile: TripPreferenceProfile;
  usedPlaceKeys: Set<string>;
  replacementMode?: "match" | "non_food" | "food";
  anchor?: AiGeneratedItem | null;
  nextStop?: AiGeneratedItem | null;
}) {
  const area = normalizeAreaLabel(args.day.cityRegion || args.item.location);
  const replacementMode = args.replacementMode ?? "match";
  const anchor = args.anchor ?? getRelevantMealAnchors(args.day, args.item.slot).anchor ?? getPrimaryAnchor(args.day);
  const nextStop = args.nextStop ?? getRelevantMealAnchors(args.day, args.item.slot).nextAnchor ?? null;
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
    .filter((candidate) =>
      !args.usedPlaceKeys.has(
        buildItemKey({
          recommendationId: candidate.id,
          name: candidate.name,
          lat: candidate.lat,
          lon: candidate.lon,
          location: candidate.location,
        })
      )
    )
    .filter((candidate) => !includesAnyKeyword(`${candidate.name} ${candidate.location}`, args.profile.avoidKeywords))
    .filter((candidate) => !isAccessibilityConflict(candidate, args.payload))
    .filter((candidate) => !isDietaryConflict(candidate, args.profile))
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
          args.day.transportation ||
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
          args.day.transportation ||
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

  return candidates[0] ?? null;
}

function chooseTargetDayIndexForRecommendation(
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
    const score = areaScore + preferredAreaScore + capacityScore / 20 + transferPenalty;

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

    const replaceableEntry = [...targetDay.items]
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !isFoodItem(item.category))
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
  usedPlaceKeys: Set<string>
) {
  const nextItems: AiGeneratedItem[] = [];
  const mealNamesInDay = new Set<string>();

  for (const item of sortItems(day.items)) {
    const duplicateKey = buildItemKey(item);
    const duplicatePlace = usedPlaceKeys.has(duplicateKey);
    const premiumConflict =
      isFoodItem(item.category) &&
      (mealNamesInDay.has(item.name.trim().toLowerCase()) ||
        (!profile.luxuryEnabled && isPremiumVenue(item)));

    if ((isAvoidedItem(item, profile) || duplicatePlace || premiumConflict) && !item.locked && !item.fixedTime) {
      const replacement = pickReplacementRecommendation({
        payload,
        day: { ...day, items: nextItems },
        item,
        profile,
        usedPlaceKeys,
      });
      const nextItem = replacement
        ? buildReplacementItem(replacement, item, { ...day, items: nextItems }, payload)
        : buildFreeExplorationReplacement(item, day);
      nextItems.push(nextItem);
      usedPlaceKeys.add(buildItemKey(nextItem));
      if (isFoodItem(nextItem.category)) {
        mealNamesInDay.add(nextItem.name.trim().toLowerCase());
      }
      continue;
    }

    nextItems.push(item);
    usedPlaceKeys.add(duplicateKey);
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

export function enforceBudgetOnDays(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
) {
  if (profile.budgetSoftCeiling == null) return days;

  const mutableDays = [...days];
  let attempts = 0;

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
        const replacement = pickReplacementRecommendation({
          payload,
          day,
          item: targetItem,
          profile,
          usedPlaceKeys: new Set(
            mutableDays.flatMap((entry) => entry.items.map((item) => buildItemKey(item)))
          ),
        });

        const nextItems = [...day.items];
        nextItems[expensiveIndex] = replacement
          ? buildReplacementItem(replacement, targetItem, day, payload)
          : buildFreeExplorationReplacement(targetItem, day);

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

function alignDaysToTripFrame(days: AiGeneratedDay[], tripFrame: TripFrame): AiGeneratedDay[] {
  return days.map((day) => {
    if (isIntercityTransferDay(day)) return day;
    const phase = findFramePhaseForDay(tripFrame, day.dayNumber);
    if (!phase) return day;
    if (sharesDayArea(day.cityRegion || day.accommodation, phase.areaLabel)) return day;

    return {
      ...day,
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

function lightenHighEnergyStreaks(
  days: AiGeneratedDay[],
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile
): AiGeneratedDay[] {
  const mutableDays = [...days];
  let streak = 0;

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
    const highAnchor = anchors.find((item) => classifyItemEnergy(item) === "high");

    if (highAnchor) {
      const replacement = pickReplacementRecommendation({
        payload,
        day,
        item: highAnchor,
        profile,
        usedPlaceKeys: new Set(mutableDays.flatMap((entry) => entry.items.map((item) => buildItemKey(item)))),
        replacementMode: "non_food",
      });
      const nextItem = replacement ? buildReplacementItem(replacement, highAnchor, day, payload) : null;

      if (nextItem && classifyItemEnergy(nextItem) !== "high") {
        mutableDays[index] = fillDerivedDayFields(
          resequenceDayItems(replaceItemInDay(day, highAnchor, nextItem)),
          payload,
          profile
        );
        streak = 0;
        continue;
      }
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

  const costs = buildCostsFromDays(days, payload.preferences.travelers);
  return {
    ...plan,
    days,
    totalEstimatedCost: costs.totalEstimatedCost ?? plan.totalEstimatedCost,
    estimatedTransportCost: costs.estimatedTransportCost ?? plan.estimatedTransportCost,
    averageDailyCost: costs.averageDailyCost ?? plan.averageDailyCost,
    categoryBreakdown: costs.categoryBreakdown,
  };
}

export function repairPlan(
  raw: RawGeneratedPlan,
  payload: AiItineraryRequest,
  profile: TripPreferenceProfile,
  tripFrame: TripFrame,
  exchangeRateContext: ExchangeRateContext | null
): AiItineraryResponse {
  const fallback = buildFallbackAiItinerary(payload);
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  const days: AiGeneratedDay[] = [];
  const usedMealNames = new Set<string>();

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

    const enriched = enrichAiDay(
      {
        ...rawDay,
        dayNumber: expectedDayNumber,
        date: dateForDayNumber(payload.preferences.startDate, expectedDayNumber) || rawDay.date,
      },
      payload,
      exchangeRateContext
    );

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

    days.push(repairDayStructure(normalizedDay, payload, profile, index, dayCount, usedMealNames));
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

  for (let attempt = 0; attempt < 4; attempt += 1) {
    repairedDays = repairedDays.map((day, index) =>
      repairDayStructure(normalizeDayCollections(day), payload, profile, index, dayCount, iterationMealNames)
    );
    repairedDays = ensureMustVisitCoverage(repairedDays, payload, profile);
    repairedDays = alignDaysToTripFrame(repairedDays, tripFrame);

    const usedPlaceKeys = new Set<string>();
    repairedDays = repairedDays.map((day) =>
      rebalanceDayItems(normalizeDayCollections(day), payload, profile, usedPlaceKeys)
    );
    repairedDays = fixOverloadedDays(repairedDays, payload, profile);
    repairedDays = capArrivalDepartureDays(repairedDays, payload, profile, dayCount);
    repairedDays = lightenHighEnergyStreaks(repairedDays, payload, profile);
    repairedDays = enforceBudgetOnDays(repairedDays, payload, profile).map((day) =>
      fillDerivedDayFields(normalizeDayCollections(day), payload, profile)
    );

    let computedCosts = buildCostsFromDays(repairedDays, payload.preferences.travelers);
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

    let diagnostics = collectPlanDiagnostics(repairedPlan, profile, tripFrame);
    if (diagnostics.diversityRisk) {
      repairedDays = diversifyActivities(
        repairedDays,
        payload,
        profile,
        diagnostics.dominantCategory,
        diagnostics.activityMixSkew
      ).map((day) => fillDerivedDayFields(normalizeDayCollections(day), payload, profile));

      computedCosts = buildCostsFromDays(repairedDays, payload.preferences.travelers);
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
      diagnostics = collectPlanDiagnostics(repairedPlan, profile, tripFrame);
    }

    lastPlan = repairedPlan;
    if (passesValidation(diagnostics)) {
      return {
        ...repairedPlan,
        summary: buildGenerationSummary(repairedPlan, profile),
      };
    }
  }

  return {
    ...(lastPlan ?? fallback),
    summary: buildGenerationSummary(lastPlan ?? fallback, profile),
  };
}

function isPlanComplete(plan: RawGeneratedPlan, payload: AiItineraryRequest) {
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  return dayCount > 0 && Array.isArray(plan.days) && plan.days.length === dayCount;
}

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
    diagnostics.foodDominantDays === 0 &&
    diagnostics.missingAnchorDays === 0 &&
    diagnostics.longMealDetours === 0 &&
    diagnostics.baseMismatchDays === 0 &&
    !diagnostics.overSoftBudget &&
    !diagnostics.outOfBudget &&
    !diagnostics.diversityRisk
  );
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

  const exchangeRateContext = await loadExchangeRateContext(payload.isoA2);
  const normalizedPayload = normalizePayloadPrices(payload, exchangeRateContext);
  const profile = buildTripPreferenceProfile(
    normalizedPayload.preferences,
    normalizedPayload.countryName,
    dayCount
  );
  const tripFrame = await buildTripFrame(normalizedPayload, dayCount, knowledge);

  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const raw = await generateWithGemini(
        normalizedPayload,
        profile,
        exchangeRateContext,
        tripFrame,
        knowledge
      );
      const repaired = repairPlan(raw, normalizedPayload, profile, tripFrame, exchangeRateContext);
      const diagnostics = collectPlanDiagnostics(repaired, profile, tripFrame);
      if (isPlanComplete(raw, normalizedPayload) && passesValidation(diagnostics)) {
        const validated = await applyBestEffortRoutingValidation(repaired, normalizedPayload, profile).catch(
          () => repaired
        );
        return { ...validated, model: ITINERARY_MODEL, usedFallback: false };
      }
    } catch {
      // Retry once before falling back.
    }
  }

  const fallback = repairPlan(
    toRawGeneratedPlan(buildFallbackAiItinerary(normalizedPayload)),
    normalizedPayload,
    profile,
    tripFrame,
    exchangeRateContext
  );
  const fallbackDiagnostics = collectPlanDiagnostics(fallback, profile, tripFrame);
  if (fallbackDiagnostics.outOfBudget || fallbackDiagnostics.duplicatePlaces > 0) {
    // The deterministic template is budget-driven by construction, so this
    // should be unreachable in practice — but per spec, a severely broken
    // plan must never be saved silently. Fail loudly with a clear reason
    // instead of returning something invalid.
    throw new Error(
      fallbackDiagnostics.outOfBudget
        ? "לא הצלחנו לבנות מסלול בטווח התקציב שהוגדר, גם אחרי תיקון אוטומטי."
        : "לא הצלחנו להסיר כפילויות מהמסלול, גם אחרי תיקון אוטומטי."
    );
  }

  return {
    ...fallback,
    summary: buildGenerationSummary(fallback, profile),
    model: ITINERARY_MODEL,
    usedFallback: true,
  };
}
