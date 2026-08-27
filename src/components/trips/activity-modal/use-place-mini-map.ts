"use client";

import type { Map as MapLibreMap, Marker, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { loadMaplibreGl } from "@/lib/map/load-maplibre";

// Same free, keyless CARTO raster basemap as the country mini-map
// (use-country-mini-map.ts) — real streets/places, not the flag/fill world
// view, so a single point actually reads as a real location.
function buildStyle(isDark: boolean): StyleSpecification {
  const variant = isDark ? "dark_all" : "voyager";
  return {
    version: 8,
    sources: {
      basemap: {
        type: "raster",
        tiles: [`https://a.basemaps.cartocdn.com/rastertiles/${variant}/{z}/{x}/{y}.png`],
        tileSize: 256,
        attribution: '© <a href="https://carto.com/">CARTO</a> © OpenStreetMap contributors',
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

interface UsePlaceMiniMapOptions {
  isDark: boolean;
  lat: number | null;
  lon: number | null;
}

/**
 * A minimal, single-marker MapLibre preview for one activity's location
 * inside the details modal — deliberately not a route/day map (that's
 * ItineraryDayRouteSection, one click away via "הצג במסלול היומי"), just
 * enough to show "this is roughly where it is."
 */
export function usePlaceMiniMap({ isDark, lat, lon }: UsePlaceMiniMapOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    let map: MapLibreMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let constructed = false;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled) return;

      function construct() {
        if (constructed || cancelled) return;
        constructed = true;

        map = new maplibregl.Map({
          container,
          style: buildStyle(isDark),
          center: lat != null && lon != null ? [lon, lat] : [0, 0],
          zoom: lat != null && lon != null ? 14 : 1,
          attributionControl: { compact: true },
          interactive: false,
          renderWorldCopies: false,
        });
        mapRef.current = map;

        map.on("load", () => {
          if (!map) return;
          map.resize();
          setReady(true);
        });
      }

      if (container.clientWidth > 0 && container.clientHeight > 0) {
        construct();
      }

      resizeObserver = new ResizeObserver((entries) => {
        if (!constructed) {
          const rect = entries[0]?.contentRect;
          if (rect && rect.width > 0 && rect.height > 0) construct();
          return;
        }
        map?.resize();
      });
      resizeObserver.observe(container);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || lat == null || lon == null) return;

    map.jumpTo({ center: [lon, lat], zoom: 14 });

    loadMaplibreGl().then((maplibregl) => {
      if (mapRef.current !== map) return;
      markerRef.current?.remove();
      markerRef.current = new maplibregl.Marker().setLngLat([lon, lat]).addTo(map);
    });
  }, [lat, lon, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setStyle(buildStyle(isDark));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark]);

  return { containerRef, ready };
}
