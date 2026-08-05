import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";

import {
  buildFallbackAiItinerary,
  buildMapLink,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryRequest,
  type RecommendationCategory,
  type DayPart,
  RECOMMENDATION_CATEGORY_LABELS,
} from "@/lib/trip-workspace";

const MODEL = "gemini-flash-lite-latest";

const ITINERARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    days: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          dayNumber: { type: Type.NUMBER },
          date: { type: Type.STRING },
          title: { type: Type.STRING },
          notes: { type: Type.STRING },
          transportation: { type: Type.STRING },
          estimatedCost: { type: Type.NUMBER },
          totalTravelMinutes: { type: Type.NUMBER },
          warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
          nearbyRestaurantSuggestion: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                category: { type: Type.STRING },
                location: { type: Type.STRING },
                shortDescription: { type: Type.STRING },
                slot: { type: Type.STRING },
                plannedStartTime: { type: Type.STRING },
                estimatedDurationMinutes: { type: Type.NUMBER },
                approximatePrice: { type: Type.NUMBER },
                travelMinutes: { type: Type.NUMBER },
                openingHours: { type: Type.STRING },
                reservationRequired: { type: Type.BOOLEAN },
                transportation: { type: Type.STRING },
                bookingWarning: { type: Type.STRING },
                alternativeSuggestion: { type: Type.STRING },
              },
              required: [
                "name",
                "category",
                "location",
                "shortDescription",
                "slot",
                "plannedStartTime",
                "transportation",
                "reservationRequired",
                "bookingWarning",
                "alternativeSuggestion",
              ],
            },
          },
        },
        required: [
          "dayNumber",
          "date",
          "title",
          "notes",
          "transportation",
          "warnings",
          "nearbyRestaurantSuggestion",
          "items",
        ],
      },
    },
  },
  required: ["summary", "days"],
};

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

async function generateWithGemini(payload: AiItineraryRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const candidates = payload.recommendations.map((recommendation) => ({
    id: recommendation.id,
    name: recommendation.name,
    category: recommendation.category,
    categoryLabel: RECOMMENDATION_CATEGORY_LABELS[recommendation.category],
    location: recommendation.location,
    description: recommendation.shortDescription,
    price: recommendation.approximatePrice,
    durationMinutes: recommendation.estimatedDurationMinutes,
    openingHours: recommendation.openingHours,
    recommendedTimeOfDay: recommendation.recommendedTimeOfDay,
    reservationRequired: recommendation.reservationRequired,
    lat: recommendation.lat,
    lon: recommendation.lon,
  }));

  const selectedNames =
    payload.selectedPlaces.length > 0
      ? payload.selectedPlaces.map((place) => place.name).join(", ")
      : "אין בחירה ידנית, בחרו מתוך רשימת ההמלצות";

  const prompt = [
    "You are a practical trip-planning assistant.",
    "Return JSON only, in Hebrew, matching the schema exactly.",
    "Build a day-by-day itinerary, not a generic travel article.",
    `Destination: ${payload.countryName} (${payload.isoA2}).`,
    `Trip status: ${payload.tripStatus}.`,
    `Dates: ${payload.preferences.startDate || "not set"} to ${payload.preferences.endDate || "not set"}.`,
    `Travelers: ${payload.preferences.travelers}.`,
    `Budget: ${payload.preferences.budget ?? "not set"}.`,
    `Trip pace: ${payload.preferences.tripPace}.`,
    `Trip style: ${payload.preferences.tripStyle || "not set"}.`,
    `Interests: ${payload.preferences.interests || "not set"}.`,
    `Transportation: ${payload.preferences.transportationPreferences || "not set"}.`,
    `Dietary preferences: ${payload.preferences.dietaryPreferences || "none"}.`,
    `Accessibility needs: ${payload.preferences.accessibilityNeeds || "none"}.`,
    `Preferred accommodation area: ${payload.preferences.accommodationArea || "not set"}.`,
    `Selected places: ${selectedNames}.`,
    "Use the provided candidate places first whenever possible. Preserve their names exactly when you choose them.",
    "Balance geography, opening hours, and meal timing. Warn when a day is crowded or needs reservations.",
    "Each day should usually include morning activity, lunch, afternoon activity, dinner, and optional evening activity when appropriate.",
    `Candidates: ${JSON.stringify(candidates)}`,
  ].join("\n");

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: ITINERARY_SCHEMA,
    },
  });

  const raw = response.text;
  if (!raw) {
    throw new Error("Empty itinerary response from Gemini");
  }

  return JSON.parse(raw) as {
    summary: string;
    days: Array<{
      dayNumber: number;
      date: string;
      title: string;
      notes: string;
      transportation: string;
      estimatedCost?: number;
      totalTravelMinutes?: number;
      warnings?: string[];
      nearbyRestaurantSuggestion?: string;
      items: Array<{
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
      }>;
    }>;
  };
}

function enrichAiDay(
  day: {
    dayNumber: number;
    date: string;
    title: string;
    notes: string;
    transportation: string;
    estimatedCost?: number;
    totalTravelMinutes?: number;
    warnings?: string[];
    nearbyRestaurantSuggestion?: string;
    items: Array<{
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
    }>;
  },
  payload: AiItineraryRequest
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
      openingHours: item.openingHours ?? matchedRecommendation?.openingHours ?? "",
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
    notes: day.notes,
    transportation: day.transportation,
    estimatedCost: day.estimatedCost ?? null,
    totalTravelMinutes: day.totalTravelMinutes ?? null,
    warnings: day.warnings ?? [],
    nearbyRestaurantSuggestion: day.nearbyRestaurantSuggestion ?? "",
    items,
  };
}

export async function POST(request: Request) {
  let payload: AiItineraryRequest;
  try {
    payload = (await request.json()) as AiItineraryRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!payload.countryName || !payload.isoA2) {
    return NextResponse.json({ error: "countryName and isoA2 are required" }, { status: 400 });
  }

  try {
    const generated = await generateWithGemini(payload);
    const days = generated.days.map((day) => enrichAiDay(day, payload));
    return NextResponse.json({ summary: generated.summary, days });
  } catch {
    return NextResponse.json(buildFallbackAiItinerary(payload));
  }
}
