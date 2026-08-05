"use client";

import { useQuery } from "@tanstack/react-query";

export interface PlaceSearchResult {
  name: string;
  lat: number;
  lon: number;
}

async function fetchPlaceSearch(query: string, iso: string): Promise<PlaceSearchResult[]> {
  const res = await fetch(`/api/places/search?q=${encodeURIComponent(query)}&iso=${iso}`);
  if (!res.ok) throw new Error("Place search failed");
  const data = (await res.json()) as { results: PlaceSearchResult[] };
  return data.results;
}

export function usePlaceSearch(query: string, iso: string) {
  return useQuery({
    queryKey: ["place-search", iso.toUpperCase(), query],
    queryFn: () => fetchPlaceSearch(query, iso),
    enabled: query.trim().length >= 2,
    staleTime: 1000 * 60 * 5,
    retry: false,
  });
}

export interface RecommendedPlace {
  label: string;
  name: string;
  lat: number;
  lon: number;
}

async function fetchRecommendedPlaces(iso: string): Promise<RecommendedPlace[]> {
  const res = await fetch(`/api/countries/${iso.toLowerCase()}/recommended-places`);
  if (!res.ok) throw new Error("Failed to load recommended places");
  const data = (await res.json()) as { places: RecommendedPlace[] };
  return data.places;
}

export function useRecommendedPlaces(iso: string) {
  return useQuery({
    queryKey: ["recommended-places", iso.toUpperCase()],
    queryFn: () => fetchRecommendedPlaces(iso),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
