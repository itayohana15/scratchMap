"use client";

import { useQuery } from "@tanstack/react-query";

import { tripDurationDays } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

export interface CountryStats {
  citiesVisited: number;
  citiesPlanned: number;
  citiesTotal: number;
  tripCount: number;
  totalDays: number;
  totalCost: number;
  photoCount: number;
}

export function useCountryStats(countryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: ["country-stats", countryId ?? ""],
    enabled: !!countryId,
    queryFn: async (): Promise<CountryStats> => {
      const { data: cities, error: citiesError } = await supabase
        .from("cities")
        .select("id, status")
        .eq("country_id", countryId!);
      if (citiesError) throw citiesError;

      const cityIds = cities.map((c) => c.id);

      let tripCount = 0;
      let totalDays = 0;
      let totalCost = 0;

      if (cityIds.length > 0) {
        const { data: tripCities, error: tripCitiesError } = await supabase
          .from("trip_cities")
          .select("trips(id, start_date, end_date, cost)")
          .in("city_id", cityIds);
        if (tripCitiesError) throw tripCitiesError;

        const uniqueTrips = new Map<
          string,
          { id: string; start_date: string | null; end_date: string | null; cost: number | null }
        >();
        for (const row of tripCities) {
          const trip = row.trips;
          if (trip) uniqueTrips.set(trip.id, trip);
        }

        tripCount = uniqueTrips.size;
        for (const trip of uniqueTrips.values()) {
          totalDays += tripDurationDays(trip.start_date, trip.end_date) ?? 0;
          totalCost += trip.cost ?? 0;
        }
      }

      const { count: photoCount, error: photosError } = await supabase
        .from("photos")
        .select("id", { count: "exact", head: true })
        .or(`country_id.eq.${countryId},city_id.in.(${cityIds.join(",") || "00000000-0000-0000-0000-000000000000"})`);
      if (photosError) throw photosError;

      return {
        citiesVisited: cities.filter((c) => c.status === "visited").length,
        citiesPlanned: cities.filter((c) => c.status === "planned").length,
        citiesTotal: cities.length,
        tripCount,
        totalDays,
        totalCost,
        photoCount: photoCount ?? 0,
      };
    },
  });
}
