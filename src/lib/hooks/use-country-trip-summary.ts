"use client";

import { useMemo } from "react";

import { createWorkspaceFromItineraryRecord, type CountryItineraryRecord } from "@/lib/itineraries";
import { useCountryItineraries } from "@/lib/queries/country-itineraries";
import { usePhotosForItineraries } from "@/lib/queries/photos";
import {
  TRIP_RATING_CATEGORIES,
  useTripRatingsForItineraries,
  type TripRatingCategoryKey,
} from "@/lib/queries/trip-ratings";
import { effectiveSortDate, hasExactDate } from "@/lib/trip-hub";
import { journalEntries } from "@/lib/trip-journal";
import { buildTripStatistics } from "@/lib/trip-workspace";
import type { Tables } from "@/lib/supabase/types";

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface CountryTripSummaryStats {
  tripCount: number;
  totalDays: number;
  uniqueCities: string[];
  totalPlaces: number;
  firstVisit: string | null;
  firstVisitExact: boolean;
  mostRecentVisit: string | null;
  mostRecentVisitExact: boolean;
  totalPhotos: number;
  totalJournalEntries: number;
}

export function useCountryTripSummary(iso: string | undefined, countryName: string) {
  const { data: itineraries = [], isLoading: isLoadingItineraries } = useCountryItineraries(iso);

  const completed = useMemo(
    () => itineraries.filter((itinerary) => itinerary.status === "completed"),
    [itineraries]
  );
  const upcoming = useMemo(
    () =>
      itineraries.filter(
        (itinerary) => itinerary.status !== "completed" && itinerary.status !== "archived"
      ),
    [itineraries]
  );
  const completedIds = useMemo(() => completed.map((itinerary) => itinerary.id), [completed]);

  const { data: ratingRows = [], isLoading: isLoadingRatings } =
    useTripRatingsForItineraries(completedIds);
  const { data: photos = [], isLoading: isLoadingPhotos } = usePhotosForItineraries(completedIds);

  const ratingsByItinerary = useMemo(() => {
    const map = new Map<string, Tables<"trip_ratings">>();
    for (const row of ratingRows) map.set(row.itinerary_id, row);
    return map;
  }, [ratingRows]);

  const categoryAverages = useMemo(() => {
    return TRIP_RATING_CATEGORIES.map(({ key, label }) => {
      const values = ratingRows
        .map((row) => row[key as TripRatingCategoryKey])
        .filter((value): value is number => value != null);
      return { key, label, average: average(values), tripCount: values.length };
    });
  }, [ratingRows]);

  const overallRating = useMemo(() => {
    const values = ratingRows.map((row) => row.overall).filter((value): value is number => value != null);
    return average(values);
  }, [ratingRows]);

  const stats: CountryTripSummaryStats = useMemo(() => {
    const sortedByDate = completed
      .slice()
      .sort((a, b) => effectiveSortDate(a).localeCompare(effectiveSortDate(b)));
    const cities = completed.flatMap((itinerary) =>
      itinerary.itineraryDays.map((day) => day.cityRegion)
    );
    const totalPlaces = completed.reduce((sum, itinerary) => {
      const workspace = createWorkspaceFromItineraryRecord(itinerary, countryName);
      return sum + buildTripStatistics(workspace).placesVisited;
    }, 0);
    const first = sortedByDate[0] ?? null;
    const last = sortedByDate.at(-1) ?? null;
    return {
      tripCount: completed.length,
      totalDays: completed.reduce((sum, itinerary) => sum + itinerary.daysCount, 0),
      uniqueCities: uniqueNonEmpty(cities),
      totalPlaces,
      firstVisit: first ? effectiveSortDate(first) : null,
      firstVisitExact: first ? hasExactDate(first) : false,
      mostRecentVisit: last ? effectiveSortDate(last) : null,
      mostRecentVisitExact: last ? hasExactDate(last) : false,
      totalPhotos: photos.length,
      totalJournalEntries: completed.reduce(
        (sum, itinerary) => sum + journalEntries(itinerary).length,
        0
      ),
    };
  }, [completed, photos, countryName]);

  const favoritePhotos = useMemo(() => photos.filter((photo) => photo.favorite), [photos]);

  const favoriteJournalEntries = useMemo(() => {
    return completed
      .flatMap((itinerary) =>
        journalEntries(itinerary)
          .filter((entry) => (entry.rating ?? 0) >= 8)
          .map((entry) => ({ itinerary, entry }))
      )
      .sort((a, b) => (b.entry.rating ?? 0) - (a.entry.rating ?? 0));
  }, [completed]);

  const favoriteCities = useMemo(() => {
    const counts = new Map<string, number>();
    for (const photo of favoritePhotos) {
      if (!photo.city_id) continue;
      counts.set(photo.city_id, (counts.get(photo.city_id) ?? 0) + 1);
    }
    return counts;
  }, [favoritePhotos]);

  // Favorite places (attractions/restaurants/experiences), deduped by
  // normalized name with a visit count — spec §22: the same place favorited
  // on 3 trips shows once, "❤️ Visited 3 times", not three rows.
  const favoritePlaces = useMemo(() => {
    const counts = new Map<string, { name: string; category: string; count: number }>();
    for (const itinerary of completed) {
      for (const day of itinerary.itineraryDays) {
        for (const item of day.items) {
          if (!item.favorite || !item.name.trim()) continue;
          const key = item.name.trim().toLowerCase();
          const existing = counts.get(key);
          if (existing) existing.count += 1;
          else counts.set(key, { name: item.name.trim(), category: item.category, count: 1 });
        }
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [completed]);

  // New vs. repeated places per completed trip, compared against every
  // earlier completed trip to this country (spec §21) — place names
  // normalized case/whitespace-insensitively, never comparing across
  // countries since `completed` is already scoped to this one iso.
  const newVsRepeatedPlaces = useMemo(() => {
    const sortedByDate = completed
      .slice()
      .sort((a, b) => effectiveSortDate(a).localeCompare(effectiveSortDate(b)));

    const result = new Map<string, { newPlaces: string[]; repeatedPlaces: string[] }>();
    const seenSoFar = new Set<string>();

    for (const itinerary of sortedByDate) {
      const placesThisTrip = uniqueNonEmpty(
        itinerary.itineraryDays.flatMap((day) => day.items.filter((item) => item.completed).map((item) => item.name))
      );
      const newPlaces: string[] = [];
      const repeatedPlaces: string[] = [];
      for (const place of placesThisTrip) {
        const key = place.toLowerCase();
        if (seenSoFar.has(key)) repeatedPlaces.push(place);
        else newPlaces.push(place);
      }
      for (const place of placesThisTrip) seenSoFar.add(place.toLowerCase());
      result.set(itinerary.id, { newPlaces, repeatedPlaces });
    }

    return result;
  }, [completed]);

  return {
    isLoading: isLoadingItineraries || isLoadingRatings || isLoadingPhotos,
    completed,
    upcoming,
    stats,
    categoryAverages,
    overallRating,
    ratingsByItinerary,
    photos,
    favoritePhotos,
    favoriteJournalEntries,
    favoriteCities,
    favoritePlaces,
    newVsRepeatedPlaces,
  };
}

export function findEarliestTripYear(itinerary: CountryItineraryRecord) {
  return (itinerary.startDate ?? itinerary.endDate ?? itinerary.createdAt).slice(0, 4);
}
