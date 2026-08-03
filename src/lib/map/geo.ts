"use client";

import { useQuery } from "@tanstack/react-query";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export interface CountryFeatureProperties {
  name: string;
  iso_a2: string;
  iso_a3: string | null;
  bbox: [number, number, number, number];
}

export type CountryFeatureCollection = FeatureCollection<Polygon | MultiPolygon, CountryFeatureProperties>;

export function useWorldCountriesGeoJson() {
  return useQuery({
    queryKey: ["world-countries-geojson"],
    queryFn: async (): Promise<CountryFeatureCollection> => {
      const res = await fetch("/data/world-countries.geojson");
      if (!res.ok) throw new Error("Failed to load world-countries.geojson");
      return res.json();
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
