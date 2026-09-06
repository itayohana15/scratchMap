import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

import { isClientDebugEnabled } from "@/lib/client-debug";

export type MapFocusBbox = [number, number, number, number];
export type MapFocusCenter = [number, number];

export interface CountryFocusFeatureProperties {
  iso_a2: string;
  bbox: [number, number, number, number];
  focusBbox?: [number, number, number, number];
}

export interface MapFocus {
  bbox: MapFocusBbox;
  center: MapFocusCenter;
  longitudeSpan: number;
  crossesAntimeridian: boolean;
  droppedCoordinateCount: number;
  source: "geometry" | "focus-bbox" | "bbox";
}

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

export function normalizeLongitude(lon: number) {
  const normalized = positiveModulo(lon + 180, 360) - 180;
  return normalized === -180 && lon > 0 ? 180 : normalized;
}

export function sanitizeGeoJsonCoordinate(coord: Position): [number, number] | null {
  const [rawLon, rawLat] = coord;
  if (!Number.isFinite(rawLon) || !Number.isFinite(rawLat)) return null;
  if (rawLat < -90 || rawLat > 90) return null;
  return [normalizeLongitude(rawLon), rawLat];
}

function computeLongitudeWindow(longitudes: number[]) {
  if (longitudes.length === 0) return null;

  const sorted = longitudes.map(normalizeLongitude).sort((left, right) => left - right);
  if (sorted.length === 1) {
    return {
      west: sorted[0],
      east: sorted[0],
      span: 0,
      center: sorted[0],
    };
  }

  let largestGap = -Infinity;
  let largestGapIndex = sorted.length - 1;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1] - sorted[index];
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const wrapGap = sorted[0] + 360 - sorted[sorted.length - 1];
  if (wrapGap > largestGap) {
    largestGap = wrapGap;
    largestGapIndex = sorted.length - 1;
  }

  const nextIndex = (largestGapIndex + 1) % sorted.length;
  const start = sorted[nextIndex];
  const rawEnd = sorted[largestGapIndex];
  const end = largestGapIndex === sorted.length - 1 ? rawEnd : rawEnd + 360;
  const span = end - start;

  return {
    west: normalizeLongitude(start),
    east: normalizeLongitude(end),
    span,
    center: normalizeLongitude(start + span / 2),
  };
}

function buildMapFocus(
  coordinates: Position[],
  source: MapFocus["source"]
): MapFocus | null {
  const valid: Array<[number, number]> = [];
  let droppedCoordinateCount = 0;

  for (const coord of coordinates) {
    const sanitized = sanitizeGeoJsonCoordinate(coord);
    if (sanitized) valid.push(sanitized);
    else droppedCoordinateCount += 1;
  }

  if (valid.length === 0) return null;

  const longitudeWindow = computeLongitudeWindow(valid.map(([lon]) => lon));
  if (!longitudeWindow) return null;

  const latitudes = valid.map(([, lat]) => lat);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);

  return {
    bbox: [longitudeWindow.west, south, longitudeWindow.east, north],
    center: [longitudeWindow.center, (south + north) / 2],
    longitudeSpan: longitudeWindow.span,
    crossesAntimeridian: longitudeWindow.west > longitudeWindow.east,
    droppedCoordinateCount,
    source,
  };
}

export function computeMapFocusFromCoordinates(coordinates: Position[]) {
  return buildMapFocus(coordinates, "geometry");
}

export function computeMapFocusFromBbox(
  bbox: [number, number, number, number] | undefined,
  source: Extract<MapFocus["source"], "focus-bbox" | "bbox"> = "bbox"
) {
  if (!bbox) return null;

  const [west, south, east, north] = bbox;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(east) ||
    !Number.isFinite(south) ||
    !Number.isFinite(north) ||
    south < -90 ||
    north > 90 ||
    south > north
  ) {
    return null;
  }

  return buildMapFocus(
    [
      [west, south],
      [east, north],
    ],
    source
  );
}

function approximateRingArea(ring: Position[]) {
  if (ring.length < 3) return 0;

  let total = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
    total += x1 * y2 - x2 * y1;
  }

  return Math.abs(total) / 2;
}

function largestFragment(geometry: Polygon | MultiPolygon) {
  const fragments = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (fragments.length === 1) return fragments[0];

  let best = fragments[0];
  let bestArea = -Infinity;

  for (const fragment of fragments) {
    const area = approximateRingArea(fragment[0] ?? []);
    if (area > bestArea) {
      bestArea = area;
      best = fragment;
    }
  }

  return best;
}

function flattenFragment(fragment: Position[][]) {
  const coordinates: Position[] = [];
  for (const ring of fragment) {
    coordinates.push(...ring);
  }
  return coordinates;
}

export function computeCountryFeatureMapFocus(
  feature: Feature<Polygon | MultiPolygon, CountryFocusFeatureProperties> | null | undefined
) {
  if (!feature) return null;

  const geometryFocus = computeMapFocusFromCoordinates(flattenFragment(largestFragment(feature.geometry)));
  if (geometryFocus) return geometryFocus;

  return (
    computeMapFocusFromBbox(feature.properties.focusBbox, "focus-bbox") ??
    computeMapFocusFromBbox(feature.properties.bbox, "bbox")
  );
}

export function toUnwrappedMapBbox([west, south, east, north]: MapFocusBbox): MapFocusBbox {
  return west > east ? [west, south, east + 360, north] : [west, south, east, north];
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

export function logMapFocus(context: string, destination: string, focus: MapFocus, zoom: number | undefined) {
  if (!isClientDebugEnabled()) return;

  console.info(`[map-focus:${context}]`, {
    destination,
    lat: round(focus.center[1], 6),
    lon: round(focus.center[0], 6),
    zoom: zoom == null ? null : round(zoom, 2),
    bbox: focus.bbox.map((value) => round(value, 6)),
    fitBoundsBbox: toUnwrappedMapBbox(focus.bbox).map((value) => round(value, 6)),
    source: focus.source,
    longitudeSpan: round(focus.longitudeSpan, 6),
    crossesAntimeridian: focus.crossesAntimeridian,
    droppedCoordinateCount: focus.droppedCoordinateCount,
  });
}
