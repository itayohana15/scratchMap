"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/types";

export const countryKeys = {
  all: ["countries"] as const,
  byIso: (iso: string) => ["countries", "iso", iso.toLowerCase()] as const,
};

export function useCountries() {
  const supabase = createClient();

  return useQuery({
    queryKey: countryKeys.all,
    queryFn: async () => {
      const { data, error } = await supabase.from("countries").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCountryByIso(iso: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: countryKeys.byIso(iso ?? ""),
    enabled: !!iso,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("countries")
        .select("*")
        .eq("iso_a2", iso!.toUpperCase())
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertCountry() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      values: TablesInsert<"countries"> | (TablesUpdate<"countries"> & { id: string })
    ) => {
      const query = supabase.from("countries");
      const isUpdate = "id" in values && typeof values.id === "string";

      const { data, error } = isUpdate
        ? await (() => {
            const updateValues = values as TablesUpdate<"countries"> & { id: string };
            const { id, ...patch } = updateValues;
            return query.update(patch).eq("id", id).select().single();
          })()
        : await query
            .upsert(values as TablesInsert<"countries">, { onConflict: "iso_a2" })
            .select()
            .single();

      if (error) throw error;
      return data as Tables<"countries">;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(countryKeys.byIso(data.iso_a2), data);
      queryClient.invalidateQueries({ queryKey: countryKeys.all });
      queryClient.invalidateQueries({ queryKey: countryKeys.byIso(data.iso_a2) });
    },
  });
}
