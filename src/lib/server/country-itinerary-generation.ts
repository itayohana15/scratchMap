import { GoogleGenAI, Type } from "@google/genai";

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
import {
  buildFallbackAiItinerary,
  buildMapLink,
  dateForDayNumber,
  getTripDayCount,
  ITINERARY_GENERATION_MODE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryRequest,
  type AiItineraryResponse,
  type DayPart,
  type RecommendationCategory,
} from "@/lib/trip-workspace";

export const ITINERARY_MODEL = "gemini-flash-lite-latest";

interface RawGeneratedItem {
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

interface RawGeneratedDay {
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

interface RawGeneratedPlan {
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
          notes: stringField("Practical planning notes for the day."),
          transportation: stringField("Main transport strategy for the day."),
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
          restWindow: stringField("Rest, free time, or laundry window when relevant."),
          transportSegments: stringArrayField("Travel segments during the day.", "One transport segment in Hebrew."),
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: stringField("Activity or meal stop name in Hebrew."),
                category: stringField("One supported category keyword."),
                location: stringField("Area, neighborhood, or address cue."),
                shortDescription: stringField("Short practical description in Hebrew."),
                slot: stringField("morning, lunch, afternoon, dinner, evening, or night."),
                plannedStartTime: stringField("Suggested start time in HH:mm."),
                estimatedDurationMinutes: numberField("Estimated duration in minutes."),
                approximatePrice: numberField("Estimated price."),
                travelMinutes: numberField("Travel time from previous stop in minutes."),
                openingHours: stringField("Opening hours if known, otherwise state unavailable."),
                reservationRequired: { type: Type.BOOLEAN, description: "Whether booking is recommended." },
                transportation: stringField("Transport used to reach this stop."),
                bookingWarning: stringField("Booking or timing warning."),
                alternativeSuggestion: stringField("Alternative stop if this one is unavailable."),
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

function buildPrompt(payload: AiItineraryRequest, knowledge?: CountryAiRecommendation | null) {
  const exactDayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  const candidates = payload.recommendations.slice(0, 48).map((recommendation) => ({
    id: recommendation.id,
    name: recommendation.name,
    category: recommendation.category,
    categoryLabel: RECOMMENDATION_CATEGORY_LABELS[recommendation.category],
    location: recommendation.location,
    description: recommendation.shortDescription,
    price: recommendation.approximatePrice,
    durationMinutes: recommendation.estimatedDurationMinutes,
    openingHours: recommendation.openingHours || "לא זמין",
    recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
    reservationRequired: recommendation.reservationRequired,
    lat: recommendation.lat,
    lon: recommendation.lon,
  }));

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

  return [
    "You are a practical itinerary planner, not a travel writer.",
    "Return JSON only, matching the schema exactly.",
    "Write all human-readable text in natural Hebrew.",
    "Use exact selected dates and create one day for every calendar date in the range.",
    "Do not invent live events, precise opening hours, or real-time weather. If unknown, label values as unavailable or estimated.",
    "Respect the user's pace, budget, transport preferences, dietary needs, accessibility needs, must-visit places, places to avoid, bookings, and preferred regions.",
    "For long trips, include travel days, rest windows, laundry/free time, and realistic arrival/departure structure.",
    "Avoid repeating similar activities too often. Group nearby places geographically and minimize backtracking.",
    `Destination: ${payload.countryName} (${payload.isoA2}).`,
    `Country ID: ${payload.countryId}.`,
    `Travel dates: ${payload.preferences.startDate} to ${payload.preferences.endDate}.`,
    `Exact day count required: ${exactDayCount}.`,
    `Travelers: ${payload.preferences.travelers}.`,
    `Budget: ${payload.preferences.budget ?? "לא הוגדר"}.`,
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
    `Existing bookings JSON: ${JSON.stringify(bookings, null, 2)}`,
    `Static country guide JSON: ${summarizeCountryKnowledge(knowledge)}`,
    "Use provided candidates first whenever they fit. Preserve chosen candidate names exactly.",
    "Each day may include fewer than five stops when that is more realistic.",
    "Arrival or transfer days can be lighter. Rest windows should be explicit when helpful.",
    "Output categoryBreakdown numbers so they sum roughly to the total estimated cost.",
    `Candidate places JSON: ${JSON.stringify(candidates, null, 2)}`,
  ].join("\n");
}

function enrichAiDay(day: RawGeneratedDay, payload: AiItineraryRequest): AiGeneratedDay {
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

    return {
      name: item.name,
      category,
      location,
      shortDescription: item.shortDescription,
      slot: normalizeSlot(item.slot),
      plannedStartTime: item.plannedStartTime,
      estimatedDurationMinutes: item.estimatedDurationMinutes ?? matchedRecommendation?.estimatedDurationMinutes ?? null,
      approximatePrice: item.approximatePrice ?? matchedRecommendation?.approximatePrice ?? null,
      travelMinutes: item.travelMinutes ?? null,
      openingHours: item.openingHours ?? matchedRecommendation?.openingHours ?? "לא זמין",
      reservationRequired: item.reservationRequired ?? matchedRecommendation?.reservationRequired ?? false,
      transportation: item.transportation ?? day.transportation,
      mapLink: matchedRecommendation?.mapLink || buildMapLink(item.name, lat, lon),
      lat,
      lon,
      bookingWarning: item.bookingWarning ?? "",
      alternativeSuggestion: item.alternativeSuggestion ?? "",
      recommendationId: matchedRecommendation?.id ?? null,
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
  knowledge?: CountryAiRecommendation | null
) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: ITINERARY_MODEL,
    contents: buildPrompt(payload, knowledge),
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

function mergeCategoryBreakdown(
  input: Record<string, number> | undefined,
  fallback: AiItineraryResponse
) {
  const fallbackBreakdown = fallback.categoryBreakdown;
  return {
    attractions: input?.attractions ?? fallbackBreakdown.attractions ?? 0,
    food: input?.food ?? fallbackBreakdown.food ?? 0,
    transportation: input?.transportation ?? fallbackBreakdown.transportation ?? 0,
    accommodation: input?.accommodation ?? fallbackBreakdown.accommodation ?? 0,
    other: input?.other ?? fallbackBreakdown.other ?? 0,
  };
}

function repairPlan(
  raw: RawGeneratedPlan,
  payload: AiItineraryRequest
): AiItineraryResponse {
  const fallback = buildFallbackAiItinerary(payload);
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  const days: AiGeneratedDay[] = [];

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
      payload
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

    days.push(normalizedDay);
  }

  const totalEstimatedCost =
    raw.totalEstimatedCost ??
    (days.reduce((sum, day) => sum + (day.estimatedCost ?? 0), 0) || null);
  const estimatedTransportCost =
    raw.estimatedTransportCost ??
    (days.reduce((sum, day) => sum + (day.transportCost ?? 0), 0) || null);
  const averageDailyCost =
    raw.averageDailyCost ??
    (totalEstimatedCost != null && days.length > 0 ? Math.round(totalEstimatedCost / days.length) : null);
  const costPerTraveler =
    raw.costPerTraveler ??
    (totalEstimatedCost != null && payload.preferences.travelers > 0
      ? Math.round(totalEstimatedCost / payload.preferences.travelers)
      : null);

  return {
    title: raw.title || fallback.title,
    summary: raw.summary || fallback.summary,
    totalEstimatedCost,
    estimatedTransportCost,
    averageDailyCost,
    costPerTraveler,
    categoryBreakdown: mergeCategoryBreakdown(raw.categoryBreakdown, fallback),
    days,
  };
}

function isPlanComplete(plan: RawGeneratedPlan, payload: AiItineraryRequest) {
  const dayCount = getTripDayCount(payload.preferences.startDate, payload.preferences.endDate, 0);
  return dayCount > 0 && Array.isArray(plan.days) && plan.days.length === dayCount;
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

  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const raw = await generateWithGemini(payload, knowledge);
      const repaired = repairPlan(raw, payload);
      if (isPlanComplete(raw, payload)) {
        return { ...repaired, model: ITINERARY_MODEL, usedFallback: false };
      }
    } catch {
      // Retry once before falling back.
    }
  }

  return {
    ...buildFallbackAiItinerary(payload),
    model: ITINERARY_MODEL,
    usedFallback: true,
  };
}
