"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/types";

export const cityKeys = {
  all: ["cities"] as const,
  byCountry: (countryId: string) => ["cities", "country", countryId] as const,
  byId: (id: string) => ["cities", "id", id] as const,
};

export function useCitiesByCountry(countryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: cityKeys.byCountry(countryId ?? ""),
    enabled: !!countryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cities")
        .select("*")
        .eq("country_id", countryId!)
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCity(id: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: cityKeys.byId(id ?? ""),
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cities")
        .select("*, countries(id, name, iso_a2)")
        .eq("id", id!)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertCity() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      values: TablesInsert<"cities"> | (TablesUpdate<"cities"> & { id: string })
    ) => {
      const { data, error } = await supabase
        .from("cities")
        .upsert(values as TablesInsert<"cities">)
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"cities">;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cityKeys.all });
    },
  });
}
