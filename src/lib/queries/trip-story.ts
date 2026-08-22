"use client";

import { useMutation } from "@tanstack/react-query";

async function parseJson<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

/** User-triggered only — never auto-invoked (spec §9's "AI may help", opt-in). */
export function useGenerateTripStory(iso: string) {
  return useMutation({
    mutationFn: async ({ itineraryId }: { itineraryId: string }) => {
      const data = await parseJson<{ story: string }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/story`, {
          method: "POST",
        })
      );
      return data.story;
    },
  });
}
