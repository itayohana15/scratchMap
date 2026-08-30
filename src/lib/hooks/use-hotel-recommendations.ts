"use client";

import { useQuery } from "@tanstack/react-query";

import type { RankedHotel } from "@/lib/hotels";

interface HotelSearchArgs {
  iso: string;
  lat: number | null;
  lon: number | null;
  activityClusters: Array<{ lat: number; lon: number }>;
  airportCoords: { lat: number; lon: number } | null;
}

interface HotelSearchResponse {
  hotels: RankedHotel[];
  meta: { source: string; sourceUrl: string; retrievedAt: string };
}

async function fetchHotelRecommendations(args: HotelSearchArgs): Promise<HotelSearchResponse> {
  const params = new URLSearchParams({ lat: String(args.lat), lon: String(args.lon) });
  if (args.activityClusters.length > 0) {
    params.set("activityClusters", args.activityClusters.map((cluster) => `${cluster.lat},${cluster.lon}`).join(";"));
  }
  if (args.airportCoords) {
    params.set("airportLat", String(args.airportCoords.lat));
    params.set("airportLon", String(args.airportCoords.lon));
  }

  const res = await fetch(`/api/countries/${args.iso.toLowerCase()}/hotels?${params.toString()}`);
  if (!res.ok) throw new Error("Hotel search failed");
  return (await res.json()) as HotelSearchResponse;
}

/**
 * Real, ranked hotel candidates near a trip phase's own activity area
 * (spec items 26/28-30) — only fetched once a real center point is known
 * (`enabled`), never preloaded for the whole trip (spec item 99).
 */
export function useHotelRecommendations(args: HotelSearchArgs) {
  return useQuery({
    queryKey: [
      "hotel-recommendations",
      args.iso.toUpperCase(),
      args.lat,
      args.lon,
      args.activityClusters.length,
      args.airportCoords?.lat ?? null,
    ],
    queryFn: () => fetchHotelRecommendations(args),
    enabled: args.lat != null && args.lon != null,
    staleTime: 1000 * 60 * 30,
    retry: false,
  });
}
