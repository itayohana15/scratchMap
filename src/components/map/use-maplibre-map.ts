"use client";

import type {
  Map as MapLibreMap,
  LngLatBoundsLike,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
  StyleSpecification,
} from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import {
  COUNTRY_BORDER_COLOR,
  countryFillColorExpression,
  OCEAN_COLOR,
} from "@/components/map/country-layer";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { CountryFeatureCollection, CountryFeatureProperties } from "@/lib/map/geo";
import type { Status } from "@/lib/supabase/types";

const SOURCE_ID = "countries";
const FILL_LAYER_ID = "countries-fill";
const LINE_LAYER_ID = "countries-line";
const HIT_LAYER_ID = "countries-hit-area";
const FLAG_OVERLAY_MAX_DIM = 512;

const WORLD_VIEW = { center: [12, 15] as [number, number], zoom: 1.15 };
// A `maxBounds` constraint here (restricting pan to the world extent) was
// tried and reliably crashed MapLibre's internal _calcMatrices during the
// map's first construction-time resize ("Cannot read properties of null
// (reading '0')") — a real bug in this MapLibre version's bounds-constrain
// math, not something fixable from the options passed in. Left out; revisit
// with a manual moveend-based clamp instead if this is needed again.

function buildStyle(isDark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": isDark ? OCEAN_COLOR.dark : OCEAN_COLOR.light },
      },
    ],
  };
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

// Renders a single flag image, stretched (not tiled) to the country's
// bbox and clipped to its actual polygon silhouette, onto an offscreen
// canvas — used as a MapLibre "image" source so the flag reads as one
// coherent picture of the country rather than a repeating pattern.
function buildClippedFlagCanvas(
  bbox: CountryFeatureProperties["bbox"],
  geometry: Polygon | MultiPolygon,
  flagImg: HTMLImageElement
): HTMLCanvasElement | null {
  const [west, south, east, north] = bbox;
  const lonSpan = east - west;
  const latSpan = north - south;
  if (lonSpan <= 0 || latSpan <= 0) return null;

  const canvasWidth =
    lonSpan >= latSpan ? FLAG_OVERLAY_MAX_DIM : Math.max(32, Math.round((FLAG_OVERLAY_MAX_DIM * lonSpan) / latSpan));
  const canvasHeight =
    lonSpan >= latSpan ? Math.max(32, Math.round((FLAG_OVERLAY_MAX_DIM * latSpan) / lonSpan)) : FLAG_OVERLAY_MAX_DIM;

  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const project = (lon: number, lat: number): [number, number] => [
    ((lon - west) / lonSpan) * canvasWidth,
    ((north - lat) / latSpan) * canvasHeight,
  ];

  const fragments = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  ctx.beginPath();
  for (const fragment of fragments) {
    for (const ring of fragment) {
      ring.forEach((coord, i) => {
        const [x, y] = project(coord[0], coord[1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
  ctx.clip("evenodd");
  ctx.drawImage(flagImg, 0, 0, canvasWidth, canvasHeight);

  return canvas;
}

function isPolygonCountryFeature(
  feature: Feature | undefined
): feature is Feature<Polygon | MultiPolygon, CountryFeatureProperties> {
  return !!feature && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon");
}

interface FlagOverlay {
  sourceId: string;
  layerId: string;
}

async function ensureFlagOverlay(
  map: MapLibreMap,
  iso: string,
  feature: Feature<Polygon | MultiPolygon, CountryFeatureProperties>,
  overlays: Map<string, FlagOverlay>,
  loading: Set<string>
) {
  if (overlays.has(iso) || loading.has(iso)) return;
  loading.add(iso);
  try {
    const flagImg = await loadImageElement(`/flags/${iso.toLowerCase()}.png`);
    const canvas = buildClippedFlagCanvas(feature.properties.bbox, feature.geometry, flagImg);
    if (!canvas || !map.getSource(SOURCE_ID) || map.getSource(`flag-src-${iso}`)) return;

    const [west, south, east, north] = feature.properties.bbox;
    const sourceId = `flag-src-${iso}`;
    const layerId = `flag-layer-${iso}`;

    map.addSource(sourceId, {
      type: "image",
      url: canvas.toDataURL(),
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    });
    map.addLayer(
      { id: layerId, type: "raster", source: sourceId, paint: { "raster-fade-duration": 0 } },
      map.getLayer(LINE_LAYER_ID) ? LINE_LAYER_ID : undefined
    );
    overlays.set(iso, { sourceId, layerId });
    syncFillLayerFilter(map, overlays);
  } catch {
    // No flag asset for this code, or the map/source is gone mid-flight —
    // the solid-color fill layer underneath stays visible either way.
  } finally {
    loading.delete(iso);
  }
}

function removeFlagOverlay(map: MapLibreMap, iso: string, overlays: Map<string, FlagOverlay>) {
  const entry = overlays.get(iso);
  if (!entry) return;
  if (map.getLayer(entry.layerId)) map.removeLayer(entry.layerId);
  if (map.getSource(entry.sourceId)) map.removeSource(entry.sourceId);
  overlays.delete(iso);
}

// The raster flag overlay is clipped from a canvas rasterized at a fixed
// resolution, so its edge anti-aliasing never lines up pixel-for-pixel with
// the vector fill layer underneath — leaving a thin sliver of the solid
// status color visible around the country's outline. Once a country's flag
// overlay is actually on the map, hide the vector fill for that country
// entirely rather than just layering the raster on top of it.
function syncFillLayerFilter(map: MapLibreMap, overlays: Map<string, FlagOverlay>) {
  if (!map.getLayer(FILL_LAYER_ID)) return;
  const overlaidIsos = Array.from(overlays.keys());
  map.setFilter(
    FILL_LAYER_ID,
    overlaidIsos.length > 0 ? ["!", ["in", ["get", "iso_a2"], ["literal", overlaidIsos]]] : null
  );
}

interface UseMaplibreMapOptions {
  isDark: boolean;
  onCountryClick: (iso: string) => void;
  geojson: CountryFeatureCollection | undefined;
}

export function useMaplibreMap({ isDark, onCountryClick, geojson }: UseMaplibreMapOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onCountryClickRef = useRef(onCountryClick);
  onCountryClickRef.current = onCountryClick;
  const geojsonRef = useRef(geojson);
  geojsonRef.current = geojson;
  const loadingFlagsRef = useRef<Set<string>>(new Set());
  const flagOverlaysRef = useRef<Map<string, FlagOverlay>>(new Map());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let cancelled = false;
    let map: MapLibreMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    loadingFlagsRef.current = new Set();
    flagOverlaysRef.current = new Map();

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled) return;

      map = new maplibregl.Map({
        container,
        style: buildStyle(isDark),
        center: WORLD_VIEW.center,
        zoom: WORLD_VIEW.zoom,
        minZoom: WORLD_VIEW.zoom,
        maxZoom: 9,
        attributionControl: false,
        renderWorldCopies: false,
      });
      mapRef.current = map;
      resizeObserver = new ResizeObserver(() => {
        map?.resize();
      });
      resizeObserver.observe(container);

      map.on("load", () => {
        if (!map) return;
        map.resize();
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: "/data/world-countries.geojson",
          promoteId: "iso_a2",
        });

        map.addLayer({
          id: FILL_LAYER_ID,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            "fill-color": countryFillColorExpression(isDark),
            "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.85],
          },
        });

        map.addLayer({
          id: LINE_LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": isDark ? COUNTRY_BORDER_COLOR.dark : COUNTRY_BORDER_COLOR.light,
            "line-width": 0.6,
          },
        });

        // Keep an invisible interaction layer above the visual country layers
        // so flagged/rasterized countries stay clickable even when the base
        // fill layer is hidden for them.
        map.addLayer({
          id: HIT_LAYER_ID,
          type: "fill",
          source: SOURCE_ID,
          paint: {
            "fill-color": "#ffffff",
            "fill-opacity": 0.001,
          },
        });

        setReady(true);
      });

      let hoveredId: string | null = null;
      map.on("mousemove", HIT_LAYER_ID, (e: MapLayerMouseEvent) => {
        if (!map) return;
        map.getCanvas().style.cursor = "pointer";
        const feature = e.features?.[0] as MapGeoJSONFeature | undefined;
        const iso = feature?.properties?.iso_a2 as string | undefined;
        if (!iso || iso === hoveredId) return;
        if (hoveredId) {
          map.setFeatureState({ source: SOURCE_ID, id: hoveredId }, { hover: false });
        }
        hoveredId = iso;
        map.setFeatureState({ source: SOURCE_ID, id: hoveredId }, { hover: true });
      });

      map.on("mouseleave", HIT_LAYER_ID, () => {
        if (!map) return;
        map.getCanvas().style.cursor = "";
        if (hoveredId) {
          map.setFeatureState({ source: SOURCE_ID, id: hoveredId }, { hover: false });
          hoveredId = null;
        }
      });

      map.on("click", HIT_LAYER_ID, (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0] as MapGeoJSONFeature | undefined;
        const iso = feature?.properties?.iso_a2 as string | undefined;
        if (iso) onCountryClickRef.current(iso);
      });
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
    if (!map || !ready) return;
    map.setPaintProperty("background", "background-color", isDark ? OCEAN_COLOR.dark : OCEAN_COLOR.light);
    if (map.getLayer(FILL_LAYER_ID)) {
      map.setPaintProperty(FILL_LAYER_ID, "fill-color", countryFillColorExpression(isDark));
    }
    if (map.getLayer(LINE_LAYER_ID)) {
      map.setPaintProperty(
        LINE_LAYER_ID,
        "line-color",
        isDark ? COUNTRY_BORDER_COLOR.dark : COUNTRY_BORDER_COLOR.light
      );
    }
  }, [isDark, ready]);

  const syncCountryStatuses = useCallback(
    (statuses: Record<string, Status>) => {
      const map = mapRef.current;
      if (!map || !ready) return;

      const markedIsos = new Set<string>();
      for (const [iso, status] of Object.entries(statuses)) {
        map.setFeatureState({ source: SOURCE_ID, id: iso }, { status });
        if (status === "visited" || status === "planned") {
          markedIsos.add(iso);
          const feature = geojsonRef.current?.features.find((f) => f.properties.iso_a2 === iso);
          if (isPolygonCountryFeature(feature)) {
            ensureFlagOverlay(map, iso, feature, flagOverlaysRef.current, loadingFlagsRef.current);
          }
        }
      }

      let removedAny = false;
      for (const iso of Array.from(flagOverlaysRef.current.keys())) {
        if (!markedIsos.has(iso)) {
          removeFlagOverlay(map, iso, flagOverlaysRef.current);
          removedAny = true;
        }
      }
      if (removedAny) syncFillLayerFilter(map, flagOverlaysRef.current);
    },
    [ready]
  );

  const flyToBbox = useCallback((bbox: [number, number, number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    const bounds: LngLatBoundsLike = [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ];
    map.fitBounds(bounds, { padding: 64, duration: 1400, essential: true, maxZoom: 6.5 });
  }, []);

  const resetToWorld = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({ center: WORLD_VIEW.center, zoom: WORLD_VIEW.zoom, duration: 1200, essential: true });
  }, []);

  return { containerRef, mapRef, ready, syncCountryStatuses, flyToBbox, resetToWorld };
}
