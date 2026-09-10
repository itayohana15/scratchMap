"use client";

import { useMemo } from "react";

import { useTripHubTrips } from "@/lib/queries/trip-hub";
import { useMapCountryStatuses } from "@/lib/queries/countries";
import { useTripRatingsForItineraries } from "@/lib/queries/trip-ratings";
import {
  computePassportStats,
  favoriteCountries,
  getCompletedTrips,
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
 * populate. Spec "PART B — MAP STATUS MUST BE SERVER AUTHORITATIVE" —
 * `countriesPlanned` reads the same server-computed `effectiveStatus`
 * (`useMapCountryStatuses` -> /api/map/countries) every other
 * status-showing surface renders, so it can never disagree with the map.
 */
export function useDashboardStats() {
  const tripsQuery = useTripHubTrips();
  const mapStatusesQuery = useMapCountryStatuses();
  const trips = useMemo(() => tripsQuery.data ?? [], [tripsQuery.data]);

  const completedIds = useMemo(() => getCompletedTrips(trips).map((trip) => trip.id), [trips]);
  const ratingsQuery = useTripRatingsForItineraries(completedIds);

  const isLoading = tripsQuery.isLoading || mapStatusesQuery.isLoading || ratingsQuery.isLoading;

  const data = useMemo<DashboardStats | undefined>(() => {
    if (tripsQuery.isLoading || mapStatusesQuery.isLoading) return undefined;

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
      countriesPlanned: (mapStatusesQuery.data ?? []).filter((country) => country.effectiveStatus === "planned").length,
      citiesVisited: passportStats.citiesVisited,
      totalTrips: completed.length,
      totalDaysTraveled: passportStats.knownTravelDays,
      totalExpenses,
      averageRating,
      favoriteCountry: favorites[0] ?? null,
      latestTrips: completed.slice().sort((a, b) => b.sortDate.localeCompare(a.sortDate)).slice(0, 5),
      upcomingTrips: trips
        .filter((trip) => trip.status === "active" || trip.status === "upcoming")
        .sort((first, second) => {
          if (first.status === "active" && second.status !== "active") return -1;
          if (second.status === "active" && first.status !== "active") return 1;
          return first.sortDate.localeCompare(second.sortDate);
        })
        .slice(0, 5),
    };
  }, [trips, tripsQuery.isLoading, mapStatusesQuery.data, mapStatusesQuery.isLoading, ratingsQuery.data]);

  return { data, isLoading };
}
