"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { EffectiveCountryStatus } from "@/lib/server/country-statuses";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/types";

export const countryKeys = {
  all: ["countries"] as const,
  byIso: (iso: string) => ["countries", "iso", iso.toLowerCase()] as const,
  /** Spec "MAP STATUS MUST BE SERVER AUTHORITATIVE" — the server-computed effective-status list. */
  mapStatuses: ["countries", "map-statuses"] as const,
};

/**
 * Spec "PART B — MAP STATUS MUST BE SERVER AUTHORITATIVE" — the ONE hook
 * every status-showing surface (map fill, sidebar, filters, country detail
 * badge, dashboard counters) reads. It returns the server-derived
 * `effectiveStatus` per country; the client never re-derives the rule from
 * trips. Invalidated by every trip create/delete/edit (see trip-hub.ts /
 * country-itineraries.ts) and by manual `countries.status` edits.
 */
export function useMapCountryStatuses() {
  return useQuery({
    queryKey: countryKeys.mapStatuses,
    queryFn: async (): Promise<EffectiveCountryStatus[]> => {
      const response = await fetch("/api/map/countries");
      if (!response.ok) throw new Error("Failed to load country statuses");
      const data = (await response.json()) as { countries: EffectiveCountryStatus[] };
      return data.countries;
    },
  });
}

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
      // A manual status change on a trip-less country must repaint the map.
      queryClient.invalidateQueries({ queryKey: countryKeys.mapStatuses });
    },
  });
}
