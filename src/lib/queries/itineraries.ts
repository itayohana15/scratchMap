"use client";

import { useQuery } from "@tanstack/react-query";

import type { CountryItineraryRecord } from "@/lib/itineraries";

export const itineraryByIdKeys = {
  detail: (itineraryId: string) => ["itinerary-by-id", itineraryId] as const,
};

async function fetchItineraryById(itineraryId: string): Promise<CountryItineraryRecord | null> {
  const res = await fetch(`/api/itineraries/${itineraryId}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? "Failed to load itinerary");
  }
  const data = (await res.json()) as { itinerary: CountryItineraryRecord };
  return data.itinerary;
}

/** Country-agnostic itinerary lookup for `/trips/[tripId]` — the one place in the app that only knows an itinerary id, not its country. */
export function useItineraryById(itineraryId: string | undefined) {
  return useQuery({
    queryKey: itineraryByIdKeys.detail(itineraryId ?? ""),
    enabled: !!itineraryId,
    queryFn: () => fetchItineraryById(itineraryId!),
  });
}
