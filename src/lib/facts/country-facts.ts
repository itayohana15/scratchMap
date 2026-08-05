"use client";

import { useQuery } from "@tanstack/react-query";

export interface CountryFacts {
  capital: string | null;
  population: number | null;
  area: number | null;
  continent: string | null;
  currency: string | null;
  languages: string[];
}

async function fetchCountryFacts(isoA2: string): Promise<CountryFacts> {
  const res = await fetch(`/api/countries/${isoA2.toLowerCase()}/facts`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to load country facts");
  }
  return res.json();
}

export function useCountryFacts(isoA2: string | undefined) {
  return useQuery({
    queryKey: ["country-facts", isoA2?.toUpperCase() ?? ""],
    enabled: !!isoA2,
    queryFn: () => fetchCountryFacts(isoA2!),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
