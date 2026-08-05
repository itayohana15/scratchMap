"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables, TablesInsert } from "@/lib/supabase/types";

export const ratingKeys = {
  byCountry: (countryId: string) => ["country_ratings", countryId] as const,
};

export const RATING_CATEGORIES = [
  { key: "nature", label: "טבע" },
  { key: "food", label: "אוכל" },
  { key: "transportation", label: "תחבורה" },
  { key: "safety", label: "בטיחות" },
  { key: "cleanliness", label: "ניקיון" },
  { key: "value_for_money", label: "תמורה למחיר" },
  { key: "nightlife", label: "חיי לילה" },
  { key: "friendliness", label: "ידידותיות" },
] as const;

export const PERSONAL_RATING_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1);

export function useCountryRating(countryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: ratingKeys.byCountry(countryId ?? ""),
    enabled: !!countryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("country_ratings")
        .select("*")
        .eq("country_id", countryId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertCountryRating() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: TablesInsert<"country_ratings">) => {
      const { data, error } = await supabase
        .from("country_ratings")
        .upsert(values, { onConflict: "country_id" })
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"country_ratings">;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ratingKeys.byCountry(data.country_id) });
    },
  });
}
