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
  mostRecentVisit: string | null;
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
    const startDates = completed.map((itinerary) => itinerary.startDate).filter(Boolean) as string[];
    const cities = completed.flatMap((itinerary) =>
      itinerary.itineraryDays.map((day) => day.cityRegion)
    );
    const totalPlaces = completed.reduce((sum, itinerary) => {
      const workspace = createWorkspaceFromItineraryRecord(itinerary, countryName);
      return sum + buildTripStatistics(workspace).placesVisited;
    }, 0);
    return {
      tripCount: completed.length,
      totalDays: completed.reduce((sum, itinerary) => sum + itinerary.daysCount, 0),
      uniqueCities: uniqueNonEmpty(cities),
      totalPlaces,
      firstVisit: startDates.length > 0 ? startDates.slice().sort()[0] : null,
      mostRecentVisit: startDates.length > 0 ? startDates.slice().sort().at(-1)! : null,
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
  };
}

export function findEarliestTripYear(itinerary: CountryItineraryRecord) {
  return (itinerary.startDate ?? itinerary.endDate ?? itinerary.createdAt).slice(0, 4);
}
