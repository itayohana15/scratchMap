"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useMaplibreMap } from "@/components/map/use-maplibre-map";
import { useWorldCountriesGeoJson } from "@/lib/map/geo";
import type { Status } from "@/lib/supabase/types";

interface PassportWorldMapProps {
  statuses: Record<string, Status>;
  onCountryClick: (isoA2: string) => void;
}

/**
 * Reuses the existing MapLibre choropleth machinery (useMaplibreMap +
 * useWorldCountriesGeoJson) as-is — only the status source is different
 * (derived from real completed/upcoming trips instead of the disconnected
 * countries.status column).
 */
export function PassportWorldMap({ statuses, onCountryClick }: PassportWorldMapProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { data: geojson, isLoading } = useWorldCountriesGeoJson();

  const { containerRef, ready, syncCountryStatuses } = useMaplibreMap({
    isDark,
    onCountryClick,
    geojson,
  });

  useEffect(() => {
    if (!ready) return;
    syncCountryStatuses(statuses);
  }, [ready, statuses, syncCountryStatuses]);

  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-3xl border border-border">
      {(!ready || isLoading) && <Skeleton className="absolute inset-0 rounded-3xl" />}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
