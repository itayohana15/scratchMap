"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { GeoResolutionOverrideMap } from "@/lib/itinerary-day-view-helpers";

/**
 * Reads ?debugGeo=1 directly off window.location.search (client-only,
 * false on first render to avoid a hydration mismatch) rather than
 * next/navigation's useSearchParams — a couple of call sites for this
 * (trips-page-client.tsx's per-card PDF export menu,
 * country-itinerary-history-section.tsx) sit on pages with no Suspense
 * boundary today, and useSearchParams would force one just for a
 * dev-only overlay flag. Matches how openItineraryPdfExport itself
 * already reads the same flag.
 */
export function useDebugGeoFlag(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).get("debugGeo") === "1");
  }, []);
  return enabled;
}

async function fetchGeoResolutionOverride(isoA2: string): Promise<GeoResolutionOverrideMap | null> {
  const res = await fetch(`/api/debug/geo-resolution?iso=${encodeURIComponent(isoA2)}`);
  // A non-ok response (production, a network hiccup) is "couldn't check" —
  // the same "nothing to report" state as the route's own explicit null,
  // never the empty-object "file exists but matches nothing" state.
  if (!res.ok) return null;
  return (await res.json()) as GeoResolutionOverrideMap | null;
}

/**
 * Spec "מכני, לא קריאה ידנית" — loads the full 4-value geoSource taxonomy
 * a real CAPTURE_FIXTURES=1 generation run wrote to
 * fixtures/<ISO>-<timestamp>/geo-resolution.json, when one exists, so the
 * debug overlay can show it instead of its own degraded
 * provider/unresolved guess. Only fetched when the overlay is actually on
 * (?debugGeo=1) — this must never run for a normal page view. `null` (no
 * capture ever ran for this country, or a network hiccup) is a distinct,
 * meaningful result, never collapsed into an empty map — see
 * ItemGeoSourceDebug's own note on why "no file" and "file with no entry
 * for this item" are two different findings, not one.
 */
export function useGeoResolutionDebugMap(isoA2: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["geo-resolution-debug", isoA2],
    queryFn: () => fetchGeoResolutionOverride(isoA2!),
    enabled: enabled && Boolean(isoA2),
    staleTime: 1000 * 60,
    retry: false,
  });
}
