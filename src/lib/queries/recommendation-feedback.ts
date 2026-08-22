"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { buildPlaceKey } from "@/lib/preference-learning";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/types";

export { buildPlaceKey };

export const recommendationFeedbackKeys = {
  root: ["recommendation-feedback"] as const,
  forPlace: (placeKey: string) => ["recommendation-feedback", "place", placeKey] as const,
};

export function useAllRecommendationFeedback() {
  const supabase = createClient();

  return useQuery({
    queryKey: recommendationFeedbackKeys.root,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recommendation_feedback")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useFeedbackForPlace(placeKey: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: recommendationFeedbackKeys.forPlace(placeKey ?? ""),
    enabled: !!placeKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recommendation_feedback")
        .select("*")
        .eq("place_key", placeKey!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

interface SubmitFeedbackInput {
  placeKey: string;
  tripId: string | null;
  category: string;
  feedback: "up" | "down";
  reason?: string | null;
}

export function useSubmitFeedback() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SubmitFeedbackInput) => {
      const { data, error } = await supabase
        .from("recommendation_feedback")
        .insert({
          place_key: input.placeKey,
          trip_id: input.tripId,
          category: input.category,
          feedback: input.feedback,
          reason: input.reason ?? null,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as Tables<"recommendation_feedback">;
    },
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: recommendationFeedbackKeys.root });
      queryClient.invalidateQueries({ queryKey: recommendationFeedbackKeys.forPlace(row.place_key) });
    },
  });
}
