"use client";

import type { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { CountryFeatureProperties } from "@/lib/map/geo";

const SOURCE_ID = "country-outline";
const LINE_LAYER_ID = "country-outline-line";

// Free, keyless raster basemap (real streets/places/labels, like Google
// Maps) — CARTO's Voyager/Dark Matter tiles, built on OpenStreetMap data.
// Attribution is required and added via MapLibre's AttributionControl.
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

interface UseCountryMiniMapOptions {
  isDark: boolean;
  feature: Feature<Polygon | MultiPolygon, CountryFeatureProperties> | undefined;
}

// A lean, single-country MapLibre map for embedding in a small box (e.g. the
// country page's Cities tab) — unlike `useMaplibreMap`, this shows a real
// street-level basemap (not the flag/status-fill world view) so individual
// places are visually recognizable, with just the country's own border
// highlighted on top.
export function useCountryMiniMap({ isDark, feature }: UseCountryMiniMapOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
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

      // Constructing a MapLibre/WebGL map inside a zero-size container (as
      // can happen for a fraction of a frame when the container's height
      // comes from `flex-1`/percentage layout rather than a fixed size)
      // leaves the canvas's drawing buffer in a bad state that a later
      // `.resize()` call doesn't reliably fix — the map stays blank forever
      // even though tiles load fine. So: don't construct until the
      // container actually has a real, laid-out size.
      function construct() {
        if (constructed || cancelled) return;
        constructed = true;

        map = new maplibregl.Map({
          container,
          style: buildStyle(isDark),
          center: [0, 0],
          zoom: 1,
          attributionControl: { compact: true },
          renderWorldCopies: false,
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

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
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !feature) return;

    const source = map.getSource<GeoJSONSource>(SOURCE_ID);
    if (source) {
      source.setData(feature);
    } else {
      map.addSource(SOURCE_ID, { type: "geojson", data: feature });
      map.addLayer({
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#6366f1", "line-width": 2 },
      });
    }

    const [west, south, east, north] = feature.properties.bbox;
    const bounds: LngLatBoundsLike = [
      [west, south],
      [east, north],
    ];
    map.fitBounds(bounds, { padding: 32, duration: 0, maxZoom: 9 });
  }, [feature, ready]);

  // Basemap tiles are theme-specific (voyager/dark_all), so a theme change
  // needs a full style swap, not just a paint-property tweak.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setStyle(buildStyle(isDark));
    map.once("styledata", () => {
      if (!feature) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, { type: "geojson", data: feature });
        map.addLayer({
          id: LINE_LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          paint: { "line-color": "#6366f1", "line-width": 2 },
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark]);

  return { containerRef, mapRef, ready };
}
