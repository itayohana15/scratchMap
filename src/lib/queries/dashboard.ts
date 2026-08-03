"use client";

import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { tripDurationDays } from "@/lib/format";
import type { Tables } from "@/lib/supabase/types";

export interface DashboardStats {
  countriesVisited: number;
  countriesPlanned: number;
  citiesVisited: number;
  citiesPlanned: number;
  totalTrips: number;
  totalDaysTraveled: number;
  totalExpenses: number;
  averageRating: number | null;
  favoriteCountry: Tables<"countries"> | null;
  latestTrips: Tables<"trips">[];
  upcomingTrips: Tables<"trips">[];
}

export const dashboardKeys = {
  stats: ["dashboard-stats"] as const,
};

export function useDashboardStats() {
  const supabase = createClient();

  return useQuery({
    queryKey: dashboardKeys.stats,
    queryFn: async (): Promise<DashboardStats> => {
      const [countriesRes, citiesRes, tripsRes, ratingsRes] = await Promise.all([
        supabase.from("countries").select("*"),
        supabase.from("cities").select("id, status"),
        supabase.from("trips").select("*").order("start_date", { ascending: false, nullsFirst: false }),
        supabase.from("country_ratings").select("country_id, overall"),
      ]);

      if (countriesRes.error) throw countriesRes.error;
      if (citiesRes.error) throw citiesRes.error;
      if (tripsRes.error) throw tripsRes.error;
      if (ratingsRes.error) throw ratingsRes.error;

      const countries = countriesRes.data;
      const cities = citiesRes.data;
      const trips = tripsRes.data;
      const ratings = ratingsRes.data;

      const totalDaysTraveled = trips.reduce((sum, trip) => {
        const days = tripDurationDays(trip.start_date, trip.end_date);
        return sum + (days ?? 0);
      }, 0);

      const totalExpenses = trips.reduce((sum, trip) => sum + (trip.cost ?? 0), 0);

      const ratedValues = ratings.filter((r) => r.overall != null).map((r) => r.overall!);
      const averageRating =
        ratedValues.length > 0
          ? ratedValues.reduce((sum, v) => sum + v, 0) / ratedValues.length
          : null;

      const topRating = ratings.reduce<{ country_id: string; overall: number } | null>(
        (best, r) => (r.overall != null && (!best || r.overall > best.overall) ? { country_id: r.country_id, overall: r.overall } : best),
        null
      );
      const favoriteCountry = topRating
        ? (countries.find((c) => c.id === topRating.country_id) ?? null)
        : null;

      const today = new Date().toISOString().slice(0, 10);

      return {
        countriesVisited: countries.filter((c) => c.status === "visited").length,
        countriesPlanned: countries.filter((c) => c.status === "planned").length,
        citiesVisited: cities.filter((c) => c.status === "visited").length,
        citiesPlanned: cities.filter((c) => c.status === "planned").length,
        totalTrips: trips.length,
        totalDaysTraveled,
        totalExpenses,
        averageRating,
        favoriteCountry,
        latestTrips: trips.filter((t) => t.end_date && t.end_date < today).slice(0, 5),
        upcomingTrips: trips
          .filter((t) => t.start_date && t.start_date >= today)
          .sort((a, b) => (a.start_date! < b.start_date! ? -1 : 1))
          .slice(0, 5),
      };
    },
  });
}
