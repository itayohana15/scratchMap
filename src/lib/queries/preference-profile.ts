"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/types";

// A fixed, well-known singleton row id — this app has no real authentication
// (every table is a permissive `using (true)` policy, same TODO(auth)
// posture as everywhere else), so there is exactly one profile, always.
// Using a fixed id (rather than "select first row, insert if none") avoids
// any race that could create two singleton rows.
const PROFILE_ID = "00000000-0000-0000-0000-000000000001";

export const preferenceProfileKeys = {
  root: ["preference-profile"] as const,
};

async function ensureProfile(supabase: ReturnType<typeof createClient>): Promise<Tables<"preference_profile">> {
  const { data: existing } = await supabase
    .from("preference_profile")
    .select("*")
    .eq("id", PROFILE_ID)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("preference_profile")
    .upsert({ id: PROFILE_ID }, { onConflict: "id" })
    .select("*")
    .single();
  if (error) throw error;
  return created;
}

export function usePreferenceProfile() {
  const supabase = createClient();

  return useQuery({
    queryKey: preferenceProfileKeys.root,
    queryFn: () => ensureProfile(supabase),
  });
}

function useUpdateProfile() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: Partial<Tables<"preference_profile">>) => {
      const { data, error } = await supabase
        .from("preference_profile")
        .update(patch)
        .eq("id", PROFILE_ID)
        .select("*")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (profile) => queryClient.setQueryData(preferenceProfileKeys.root, profile),
  });
}

export function usePatchExplicitPreference() {
  const update = useUpdateProfile();
  const profileQuery = usePreferenceProfile();

  return useMutation({
    mutationFn: async ({ category, level }: { category: string; level: number | null }) => {
      const current = profileQuery.data?.explicit_preferences ?? {};
      const next = { ...current };
      if (level == null) delete next[category];
      else next[category] = level;
      return update.mutateAsync({ explicit_preferences: next });
    },
  });
}

export function useAcceptSuggestion() {
  const update = useUpdateProfile();
  const profileQuery = usePreferenceProfile();

  return useMutation({
    mutationFn: async ({ category, level }: { category: string; level: number }) => {
      const current = profileQuery.data?.explicit_preferences ?? {};
      return update.mutateAsync({ explicit_preferences: { ...current, [category]: level } });
    },
  });
}

export function useDismissSuggestion() {
  const update = useUpdateProfile();
  const profileQuery = usePreferenceProfile();

  return useMutation({
    mutationFn: async ({ suggestionKey, permanently }: { suggestionKey: string; permanently: boolean }) => {
      if (!permanently) return profileQuery.data;
      const current = profileQuery.data?.dismissed_suggestions ?? [];
      if (current.includes(suggestionKey)) return profileQuery.data;
      return update.mutateAsync({ dismissed_suggestions: [...current, suggestionKey] });
    },
  });
}

export function useSetLearningEnabled() {
  const update = useUpdateProfile();
  return useMutation({
    mutationFn: (enabled: boolean) => update.mutateAsync({ learning_enabled: enabled }),
  });
}

/** Preferences only — never touches trips/journal/photos (this table has no FK to any of them). */
export function useResetInferredProfile() {
  const update = useUpdateProfile();
  return useMutation({
    mutationFn: () => update.mutateAsync({ inferred_preferences: {}, dismissed_suggestions: [] }),
  });
}

/** Persists a freshly-recomputed inferred profile — a no-op when learning is disabled (caller gates the recompute itself). */
export function useSaveInferredPreferences() {
  const update = useUpdateProfile();
  return useMutation({
    mutationFn: (inferred: Tables<"preference_profile">["inferred_preferences"]) =>
      update.mutateAsync({ inferred_preferences: inferred }),
  });
}
