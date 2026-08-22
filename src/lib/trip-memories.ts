import type { CountryItineraryRecord } from "@/lib/itineraries";
import { actualDayItems } from "@/lib/trip-actual";
import type { Tables } from "@/lib/supabase/types";
import {
  haversineKm,
  RECOMMENDATION_CATEGORY_LABELS,
  type RecommendationCategory,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export interface HasDataValue {
  value: number;
  hasData: boolean;
}

export interface TripMemoryStats {
  durationDays: number;
  cities: string[];
  regions: string[];
  accommodationBases: string[];
  placesVisited: number;
  activitiesCompleted: number;
  activitiesSkipped: number;
  spontaneousActivities: number;
  restaurantsVisited: number;
  journalEntriesCount: number;
  photosCount: number;
  actualSpend: HasDataValue;
  distanceKm: HasDataValue;
  transportationBreakdown: Record<string, number>;
}

/**
 * Deterministic, actual-data-only trip stats (spec §4). Every count
 * distinguishes "0" from "no data" — actualSpend/distanceKm carry an
 * explicit hasData flag rather than silently reading as 0.
 */
export function computeTripMemoryStats(
  itinerary: CountryItineraryRecord,
  options?: { photosCount?: number; journalEntriesCount?: number }
): TripMemoryStats {
  const days = itinerary.itineraryDays;
  const allItems = days.flatMap((day) => day.items);
  const completedItems = allItems.filter((item) => item.completed);
  const skippedItems = allItems.filter((item) => item.skipped);
  const spontaneousItems = allItems.filter((item) => item.spontaneous);

  const cities = uniqueNonEmpty(days.map((day) => day.cityRegion));
  const accommodationBases = uniqueNonEmpty(
    days.flatMap((day) => [day.actualAccommodation, day.accommodation])
  );

  const actualCostItems = completedItems.filter((item) => item.actualCost != null);
  const actualSpend: HasDataValue = {
    value: actualCostItems.reduce((sum, item) => sum + (item.actualCost ?? 0), 0),
    hasData: actualCostItems.length > 0,
  };

  let distanceKm = 0;
  let hasDistanceData = false;
  for (const day of days) {
    const stops = actualDayItems(day).filter((item) => item.lat != null && item.lon != null);
    for (let index = 1; index < stops.length; index += 1) {
      distanceKm += haversineKm(stops[index - 1].lat, stops[index - 1].lon, stops[index].lat, stops[index].lon);
      hasDistanceData = true;
    }
  }

  const transportationBreakdown: Record<string, number> = {};
  for (const item of completedItems) {
    const mode = (item.actualTransportation || item.transportation).trim();
    if (!mode) continue;
    transportationBreakdown[mode] = (transportationBreakdown[mode] ?? 0) + 1;
  }

  return {
    durationDays: itinerary.daysCount,
    cities,
    regions: cities,
    accommodationBases,
    placesVisited: allItems.filter((item) => item.completed || item.spontaneous).length,
    activitiesCompleted: completedItems.length,
    activitiesSkipped: skippedItems.length,
    spontaneousActivities: spontaneousItems.length,
    restaurantsVisited: completedItems.filter((item) => item.category === "restaurant" || item.category === "cafe").length,
    journalEntriesCount: options?.journalEntriesCount ?? 0,
    photosCount: options?.photosCount ?? 0,
    actualSpend,
    distanceKm: { value: Number(distanceKm.toFixed(1)), hasData: hasDistanceData },
    transportationBreakdown,
  };
}

/**
 * Ordered city/base progression from actual (falling back to planned)
 * accommodation, collapsing consecutive duplicates — spec §7's "Tokyo →
 * Nikko → Tokyo" example.
 */
export function computeTripRouteStory(itinerary: CountryItineraryRecord): string[] {
  const story: string[] = [];
  for (const day of itinerary.itineraryDays) {
    const base = (day.actualAccommodation || day.accommodation || day.cityRegion).trim();
    if (!base) continue;
    if (story.at(-1) !== base) story.push(base);
  }
  return story;
}

/** Actual experience distribution — completed + spontaneous items only (spec §11). */
export function computeCategoryBreakdown(itinerary: CountryItineraryRecord): Array<{
  category: RecommendationCategory;
  label: string;
  count: number;
}> {
  const counts = new Map<RecommendationCategory, number>();
  for (const day of itinerary.itineraryDays) {
    for (const item of actualDayItems(day)) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, label: RECOMMENDATION_CATEGORY_LABELS[category], count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Planned-item category distribution — for a freshly generated itinerary
 * (nothing completed/actual yet), used by Stage 7's post-generation
 * personalization summary (spec §29).
 */
export function computePlannedCategoryBreakdown(itinerary: CountryItineraryRecord): Array<{
  category: RecommendationCategory;
  label: string;
  count: number;
}> {
  const counts = new Map<RecommendationCategory, number>();
  for (const day of itinerary.itineraryDays) {
    for (const item of day.items) {
      if (!item.name.trim()) continue;
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, label: RECOMMENDATION_CATEGORY_LABELS[category], count }))
    .sort((a, b) => b.count - a.count);
}

export interface TripHighlights {
  favoriteActivities: TripItineraryItem[];
  favoriteMeals: TripItineraryItem[];
  favoritePhotos: Tables<"photos">[];
}

/**
 * Explicit favorites first (spec §13) — never inferred from a high public
 * rating, only from the user's own favorite/personalRating fields.
 */
export function computeTripHighlights(
  itinerary: CountryItineraryRecord,
  photos: Tables<"photos">[]
): TripHighlights {
  const allItems = itinerary.itineraryDays.flatMap((day) => day.items);
  const favoriteActivities = allItems.filter(
    (item) => item.completed && (item.favorite || (item.personalRating ?? 0) >= 8) && item.category !== "restaurant" && item.category !== "cafe"
  );
  const favoriteMeals = allItems.filter(
    (item) => item.completed && (item.category === "restaurant" || item.category === "cafe") && (item.favorite || (item.personalRating ?? 0) >= 8)
  );
  return {
    favoriteActivities,
    favoriteMeals,
    favoritePhotos: photos.filter((photo) => photo.favorite),
  };
}

export interface AiStoryContext {
  countryName: string;
  startDate: string | null;
  endDate: string | null;
  cities: string[];
  days: Array<{
    dayNumber: number;
    date: string;
    base: string;
    activities: Array<{ name: string; category: string; time: string; place: string; note: string }>;
  }>;
  journalEntries: Array<{ date: string | null; title: string; text: string }>;
  photoCaptions: string[];
  favorites: { activities: string[]; meals: string[] };
  ratingOverall: number | null;
}

/**
 * Structured, factual-only context for the AI Trip Story — assembled BEFORE
 * the model ever sees anything, so a skipped/planned-only item structurally
 * cannot appear (spec §46). Journal text/photo captions are the only
 * free-text fields included, since those are the user's own words.
 */
export function buildAiStoryContext(
  itinerary: CountryItineraryRecord,
  countryName: string,
  photos: Tables<"photos">[],
  journalEntries: Array<{ date: string | null; title: string; text: string }>,
  ratingOverall: number | null
): AiStoryContext {
  const highlights = computeTripHighlights(itinerary, photos);
  return {
    countryName,
    startDate: itinerary.startDate,
    endDate: itinerary.endDate,
    cities: uniqueNonEmpty(itinerary.itineraryDays.map((day) => day.cityRegion)),
    days: itinerary.itineraryDays.map((day: TripItineraryDay) => ({
      dayNumber: day.dayNumber,
      date: day.date,
      base: (day.actualAccommodation || day.accommodation || "").trim(),
      activities: actualDayItems(day).map((item) => ({
        name: item.name,
        category: item.category,
        time: item.actualStartTime || item.plannedStartTime,
        place: item.actualPlaceName || item.location,
        note: item.journalNotes,
      })),
    })),
    journalEntries: journalEntries.filter((entry) => entry.text.trim()),
    photoCaptions: photos.map((photo) => photo.caption ?? "").filter(Boolean),
    favorites: {
      activities: highlights.favoriteActivities.map((item) => item.name),
      meals: highlights.favoriteMeals.map((item) => item.name),
    },
    ratingOverall,
  };
}
