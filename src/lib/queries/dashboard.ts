"use client";

import { useMemo } from "react";

import { useTripHubTrips } from "@/lib/queries/trip-hub";
import { useCountries } from "@/lib/queries/countries";
import { useTripRatingsForItineraries } from "@/lib/queries/trip-ratings";
import {
  computePassportStats,
  favoriteCountries,
  getCompletedTrips,
  getUpcomingTrips,
  type FavoriteCountry,
} from "@/lib/travel-passport";
import type { TripHubTrip } from "@/lib/trip-hub";

export interface HasDataValue {
  value: number;
  hasData: boolean;
}

export interface DashboardStats {
  countriesVisited: number;
  countriesPlanned: number;
  citiesVisited: { value: number; isPartial: boolean };
  totalTrips: number;
  totalDaysTraveled: { value: number; isPartial: boolean };
  totalExpenses: HasDataValue;
  averageRating: number | null;
  favoriteCountry: FavoriteCountry | null;
  latestTrips: TripHubTrip[];
  upcomingTrips: TripHubTrip[];
}

/**
 * Derives every number from the same central trip source Trips/Passport
 * already use (`useTripHubTrips()` -> `country_itineraries`), instead of
 * the legacy, disconnected `trips`/`country_ratings` tables the seeds never
 * populate. `countriesPlanned` is the one legacy read kept — it answers a
 * genuinely different question (manually-flagged map intent), not trip
 * history, so there's no `country_itineraries` equivalent to derive it from.
 */
export function useDashboardStats() {
  const tripsQuery = useTripHubTrips();
  const countriesQuery = useCountries();
  const trips = useMemo(() => tripsQuery.data ?? [], [tripsQuery.data]);

  const completedIds = useMemo(() => getCompletedTrips(trips).map((trip) => trip.id), [trips]);
  const ratingsQuery = useTripRatingsForItineraries(completedIds);

  const isLoading = tripsQuery.isLoading || countriesQuery.isLoading || ratingsQuery.isLoading;

  const data = useMemo<DashboardStats | undefined>(() => {
    if (tripsQuery.isLoading || countriesQuery.isLoading) return undefined;

    const completed = getCompletedTrips(trips);
    const passportStats = computePassportStats(trips);

    const costedTrips = completed.filter((trip) => trip.displayCost != null);
    const totalExpenses: HasDataValue = {
      value: costedTrips.reduce((sum, trip) => sum + (trip.displayCost ?? 0), 0),
      hasData: costedTrips.length > 0,
    };

    const ratingRows = ratingsQuery.data ?? [];
    const ratedValues = ratingRows.map((row) => row.overall).filter((value): value is number => value != null);
    const averageRating = ratedValues.length > 0 ? ratedValues.reduce((sum, value) => sum + value, 0) / ratedValues.length : null;

    const overallByItinerary = new Map<string, number | null>();
    for (const row of ratingRows) overallByItinerary.set(row.itinerary_id, row.overall);
    const favorites = favoriteCountries(trips, overallByItinerary);

    return {
      countriesVisited: passportStats.countriesVisited,
      countriesPlanned: (countriesQuery.data ?? []).filter((country) => country.status === "planned").length,
      citiesVisited: passportStats.citiesVisited,
      totalTrips: completed.length,
      totalDaysTraveled: passportStats.knownTravelDays,
      totalExpenses,
      averageRating,
      favoriteCountry: favorites[0] ?? null,
      latestTrips: completed.slice().sort((a, b) => b.sortDate.localeCompare(a.sortDate)).slice(0, 5),
      upcomingTrips: getUpcomingTrips(trips).slice(0, 5),
    };
  }, [trips, tripsQuery.isLoading, countriesQuery.data, countriesQuery.isLoading, ratingsQuery.data]);

  return { data, isLoading };
}
