"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

import { OCEAN_COLOR } from "@/components/map/country-layer";
import { statusColor } from "@/components/map/status-colors";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { Status } from "@/lib/supabase/types";

interface CityMapSectionProps {
  latitude: number | null;
  longitude: number | null;
  status: Status;
}

export function CityMapSection({ latitude, longitude, status }: CityMapSectionProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!containerRef.current || latitude == null || longitude == null) return;
    const container = containerRef.current;
    let cancelled = false;
    let map: MapLibreMap | undefined;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled) return;

      map = new maplibregl.Map({
        container,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": isDark ? OCEAN_COLOR.dark : OCEAN_COLOR.light },
            },
          ],
        },
        center: [longitude, latitude],
        zoom: 9,
        attributionControl: false,
        interactive: true,
      });
      mapRef.current = map;

      const el = document.createElement("div");
      el.className = "size-4 rounded-full border-2 border-white shadow-lg dark:border-neutral-900";
      el.style.backgroundColor = statusColor(status, isDark);
      new maplibregl.Marker({ element: el }).setLngLat([longitude, latitude]).addTo(map);
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude, isDark]);

  if (latitude == null || longitude == null) {
    return (
      <div className="glass-card flex h-64 items-center justify-center text-sm text-muted-foreground">
        לא נשמרו קואורדינטות לעיר הזו עדיין.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-64 w-full overflow-hidden rounded-2xl border border-border sm:h-80"
    />
  );
}
