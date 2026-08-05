"use client";

import { useQuery } from "@tanstack/react-query";

export interface CountryPhoto {
  photoUrl: string | null;
  photographer: string | null;
  photographerUrl: string | null;
}

async function fetchCountryPhoto(isoA2: string): Promise<CountryPhoto> {
  const res = await fetch(`/api/countries/${isoA2.toLowerCase()}/photo`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to load country photo");
  }
  return res.json();
}

export function useCountryPhoto(isoA2: string | undefined) {
  return useQuery({
    queryKey: ["country-photo", isoA2?.toUpperCase() ?? ""],
    enabled: !!isoA2,
    queryFn: () => fetchCountryPhoto(isoA2!),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}
