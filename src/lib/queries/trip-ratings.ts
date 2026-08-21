"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables, TablesInsert } from "@/lib/supabase/types";

export const tripRatingKeys = {
  byItinerary: (itineraryId: string) => ["trip_ratings", itineraryId] as const,
  byItineraries: (itineraryIds: string[]) => ["trip_ratings", "batch", [...itineraryIds].sort()] as const,
};

export const TRIP_RATING_CATEGORIES = [
  { key: "food", label: "אוכל" },
  { key: "culture", label: "תרבות" },
  { key: "nature", label: "טבע" },
  { key: "attractions", label: "אטרקציות" },
  { key: "nightlife", label: "חיי לילה" },
  { key: "transportation", label: "תחבורה" },
  { key: "value_for_money", label: "תמורה למחיר" },
  { key: "safety", label: "בטיחות" },
  { key: "cleanliness", label: "ניקיון" },
  { key: "tourist_convenience", label: "נוחות לתייר" },
  { key: "locals_hospitality", label: "מקומיים / אירוח" },
  { key: "shopping", label: "קניות" },
  { key: "weather", label: "מזג אוויר" },
  { key: "would_return", label: "רצון לחזור" },
] as const;

export type TripRatingCategoryKey = (typeof TRIP_RATING_CATEGORIES)[number]["key"];

export const PERSONAL_RATING_OPTIONS = Array.from({ length: 10 }, (_, index) => index + 1);

export function useTripRating(itineraryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: tripRatingKeys.byItinerary(itineraryId ?? ""),
    enabled: !!itineraryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trip_ratings")
        .select("*")
        .eq("itinerary_id", itineraryId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/**
 * One batched lookup for all completed trips' ratings, used by the
 * country-level aggregate summary instead of N+1 per-trip queries.
 */
export function useTripRatingsForItineraries(itineraryIds: string[]) {
  const supabase = createClient();
  const sortedIds = [...itineraryIds].sort();

  return useQuery({
    queryKey: tripRatingKeys.byItineraries(sortedIds),
    enabled: sortedIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trip_ratings")
        .select("*")
        .in("itinerary_id", sortedIds);
      if (error) throw error;
      return data;
    },
  });
}

export function useUpsertTripRating() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: TablesInsert<"trip_ratings">) => {
      const { data, error } = await supabase
        .from("trip_ratings")
        .upsert(values, { onConflict: "itinerary_id" })
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"trip_ratings">;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: tripRatingKeys.byItinerary(data.itinerary_id) });
      queryClient.invalidateQueries({ queryKey: ["trip_ratings", "batch"] });
    },
  });
}
