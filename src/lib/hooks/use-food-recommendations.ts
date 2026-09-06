"use client";

import { useQuery } from "@tanstack/react-query";

import type { FoodMealSlot, RankedFoodPlace } from "@/lib/food";

interface FoodSearchArgs {
  iso: string;
  lat: number | null;
  lon: number | null;
  slot: FoodMealSlot;
}

interface FoodSearchResponse {
  places: RankedFoodPlace[];
  meta: { source: string; sourceUrl: string; retrievedAt: string };
}

async function fetchFoodRecommendations(args: FoodSearchArgs): Promise<FoodSearchResponse> {
  const params = new URLSearchParams({ lat: String(args.lat), lon: String(args.lon), slot: args.slot });
  const res = await fetch(`/api/countries/${args.iso.toLowerCase()}/food?${params.toString()}`);
  if (!res.ok) throw new Error("Food search failed");
  return (await res.json()) as FoodSearchResponse;
}

/**
 * Real, route-aware food candidates for one day's one meal slot (browser
 * QA Parts U-W) — only fetched once a real day anchor point is known.
 */
export function useFoodRecommendations(args: FoodSearchArgs) {
  return useQuery({
    queryKey: ["food-recommendations", args.iso.toUpperCase(), args.lat, args.lon, args.slot],
    queryFn: () => fetchFoodRecommendations(args),
    enabled: args.lat != null && args.lon != null,
    staleTime: 1000 * 60 * 30,
    retry: false,
  });
}
