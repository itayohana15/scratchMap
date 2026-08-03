"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/types";

export const tripKeys = {
  all: ["trips"] as const,
  byCity: (cityId: string) => ["trips", "city", cityId] as const,
  byCountry: (countryId: string) => ["trips", "country", countryId] as const,
};

export interface CountryTimelineEntry extends Tables<"trip_cities"> {
  trips: Tables<"trips">;
  cities: Pick<Tables<"cities">, "id" | "name">;
}

export function useTripsForCountry(countryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: tripKeys.byCountry(countryId ?? ""),
    enabled: !!countryId,
    queryFn: async () => {
      const { data: cities, error: citiesError } = await supabase
        .from("cities")
        .select("id")
        .eq("country_id", countryId!);
      if (citiesError) throw citiesError;

      const cityIds = cities.map((c) => c.id);
      if (cityIds.length === 0) return [] as CountryTimelineEntry[];

      const { data, error } = await supabase
        .from("trip_cities")
        .select("*, trips(*), cities(id, name)")
        .in("city_id", cityIds)
        .order("arrival_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as CountryTimelineEntry[];
    },
  });
}

export function useTrips() {
  const supabase = createClient();

  return useQuery({
    queryKey: tripKeys.all,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trips")
        .select("*")
        .order("start_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data;
    },
  });
}

export interface TripCityWithTrip extends Tables<"trip_cities"> {
  trips: Tables<"trips">;
}

export function useTripCitiesForCity(cityId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: tripKeys.byCity(cityId ?? ""),
    enabled: !!cityId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trip_cities")
        .select("*, trips(*)")
        .eq("city_id", cityId!)
        .order("arrival_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data as TripCityWithTrip[];
    },
  });
}

export function useUpsertTrip() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      values: TablesInsert<"trips"> | (TablesUpdate<"trips"> & { id: string })
    ) => {
      const { data, error } = await supabase
        .from("trips")
        .upsert(values as TablesInsert<"trips">)
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"trips">;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tripKeys.all });
    },
  });
}

export function useUpsertTripCity() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      values: TablesInsert<"trip_cities"> | (TablesUpdate<"trip_cities"> & { id: string })
    ) => {
      const { data, error } = await supabase
        .from("trip_cities")
        .upsert(values as TablesInsert<"trip_cities">)
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"trip_cities">;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: tripKeys.byCity(data.city_id) });
      queryClient.invalidateQueries({ queryKey: tripKeys.all });
    },
  });
}
