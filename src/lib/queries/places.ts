"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { PlaceKind, Tables, TablesInsert } from "@/lib/supabase/types";

export const placeKeys = {
  byCity: (cityId: string) => ["places", "city", cityId] as const,
  byCountry: (countryId: string) => ["places", "country", countryId] as const,
};

export function usePlacesForCity(cityId: string | undefined, kind?: PlaceKind) {
  const supabase = createClient();

  return useQuery({
    queryKey: [...placeKeys.byCity(cityId ?? ""), kind ?? "all"],
    enabled: !!cityId,
    queryFn: async () => {
      let query = supabase.from("places").select("*").eq("city_id", cityId!).order("name");
      if (kind) query = query.eq("kind", kind);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

export function usePlacesForCountry(countryId: string | undefined, kind?: PlaceKind) {
  const supabase = createClient();

  return useQuery({
    queryKey: [...placeKeys.byCountry(countryId ?? ""), kind ?? "all"],
    enabled: !!countryId,
    queryFn: async () => {
      let query = supabase.from("places").select("*").eq("country_id", countryId!).order("name");
      if (kind) query = query.eq("kind", kind);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertPlace() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: TablesInsert<"places">) => {
      const { data, error } = await supabase.from("places").upsert(values).select().single();
      if (error) throw error;
      return data as Tables<"places">;
    },
    onSuccess: (data) => {
      if (data.city_id) queryClient.invalidateQueries({ queryKey: placeKeys.byCity(data.city_id) });
      if (data.country_id)
        queryClient.invalidateQueries({ queryKey: placeKeys.byCountry(data.country_id) });
    },
  });
}

export function useDeletePlace() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (place: Tables<"places">) => {
      const { error } = await supabase.from("places").delete().eq("id", place.id);
      if (error) throw error;
      return place;
    },
    onSuccess: (data) => {
      if (data.city_id) queryClient.invalidateQueries({ queryKey: placeKeys.byCity(data.city_id) });
      if (data.country_id)
        queryClient.invalidateQueries({ queryKey: placeKeys.byCountry(data.country_id) });
    },
  });
}
