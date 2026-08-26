"use client";

import { useQuery } from "@tanstack/react-query";

import type { NearbyCategory } from "@/lib/places/overpass";
import type { TripRecommendation, RecommendationCategory } from "@/lib/trip-workspace";

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

export interface CategoryRecommendationsMeta {
  category: RecommendationCategory;
  count: number;
  available: boolean;
  reason: "no-reliable-free-source" | null;
  source: string | null;
  sourceUrl: string | null;
  retrievedAt: string;
}

export interface CategoryRecommendationsResult {
  places: TripRecommendation[];
  meta: CategoryRecommendationsMeta;
}

export async function fetchCategoryRecommendations(
  iso: string,
  category: RecommendationCategory,
  count = 10,
  startDate?: string,
  endDate?: string
): Promise<CategoryRecommendationsResult> {
  const params = new URLSearchParams({ category, count: String(count) });
  if (startDate) params.set("start", startDate);
  if (endDate) params.set("end", endDate);

  const res = await fetch(`/api/countries/${iso.toLowerCase()}/recommendations?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.message ?? body?.error ?? "Failed to load category recommendations");
  }
  return res.json();
}

// Real, sourced places for a category (OpenStreetMap via Overpass) — not
// AI-generated. Categories with no reliable open data source (hidden gems,
// day trips, seasonal events) come back with meta.available = false instead
// of invented content.
export function useCategoryRecommendations(
  iso: string | undefined,
  category: RecommendationCategory | undefined,
  count = 10,
  startDate?: string,
  endDate?: string
) {
  return useQuery({
    queryKey: [
      "category-recommendations",
      iso?.toUpperCase() ?? "",
      category ?? "",
      count,
      startDate ?? "",
      endDate ?? "",
    ],
    enabled: !!iso && !!category,
    queryFn: () => fetchCategoryRecommendations(iso!, category!, count, startDate, endDate),
    // The server already caches Overpass responses. Keeping the client query
    // fresh avoids getting stuck with a stale "0 results" response after a
    // transient API issue or server-side fix.
    staleTime: 0,
    gcTime: 1000 * 60 * 60,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export interface NearbyPlaceResult {
  name: string;
  category: NearbyCategory;
  lat: number;
  lon: number;
  distanceMeters: number;
  openingHours: string | null;
}

export interface NearbyPlacesMeta {
  source: string;
  sourceUrl: string;
  radiusMeters: number;
  retrievedAt: string;
}

async function fetchNearbyPlaces(
  lat: number,
  lon: number
): Promise<{ places: NearbyPlaceResult[]; meta: NearbyPlacesMeta }> {
  const res = await fetch(`/api/places/nearby?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error("Failed to load nearby places");
  return res.json();
}

// Real nearby amenities from OpenStreetMap (Overpass), radius-searched
// around a single point — used by the attraction modal's "Nearby" section.
export function useNearbyPlaces(lat: number | null | undefined, lon: number | null | undefined) {
  return useQuery({
    queryKey: ["nearby-places", lat?.toFixed(4) ?? "", lon?.toFixed(4) ?? ""],
    enabled: lat != null && lon != null,
    queryFn: () => fetchNearbyPlaces(lat!, lon!),
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
  });
}
