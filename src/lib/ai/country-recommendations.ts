"use client";

import { useQuery } from "@tanstack/react-query";

export interface CountryAiRecommendation {
  summary: string;
  highlights: string[];
  food: string[];
  bestTimeToVisit: string;
  tips: string[];
}

interface CountryAiRecommendationResponse {
  content: CountryAiRecommendation;
  cached: boolean;
  cacheWriteFailed?: boolean;
}

async function fetchCountryAiRecommendation(
  isoA2: string,
  countryName: string
): Promise<CountryAiRecommendation> {
  const res = await fetch("/api/ai/country-recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isoA2, countryName }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to load AI recommendations");
  }

  const data = (await res.json()) as CountryAiRecommendationResponse;
  return data.content;
}

export function useCountryAiRecommendation(isoA2: string | undefined, countryName: string | undefined) {
  return useQuery({
    queryKey: ["ai-country-recommendation", isoA2?.toUpperCase() ?? ""],
    enabled: !!isoA2 && !!countryName,
    queryFn: () => fetchCountryAiRecommendation(isoA2!, countryName!),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
