"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { BadgeAlert, BedDouble, LoaderCircle, MapPinned, RotateCcw, Shrink, Expand } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useCountryMiniMap } from "@/components/country/use-country-mini-map";
import { formatCurrency } from "@/lib/format";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import { fetchDrivingRouteGeometry } from "@/lib/routing/osrm";
import {
  buildMapLink,
  DAY_PART_LABELS,
  haversineKm,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

type MapStopKind = "accommodation" | "activity" | "meal" | "station" | "airport" | "practical";

interface MapStop {
  key: string;
  dayId: string;
  dayNumber: number;
  itemId: string | null;
  kind: MapStopKind;
  order: number;
  name: string;
  location: string;
  lat: number;
  lon: number;
  mapLink: string;
  plannedStartTime: string;
  slotLabel: string;
  durationMinutes: number | null;
  approximatePrice: number | null;
  transportation: string;
}

interface MapSegment {
  key: string;
  dayId: string;
  dayNumber: number;
  from: MapStop;
  to: MapStop;
  mode: string;
  estimated: boolean;
  distanceKm: number | null;
  durationMinutes: number | null;
  cost: number | null;
  departureTime: string;
  arrivalTime: string;
  transferCount: number | null;
  geometry: [number, number][];
  sourceLabel: string;
}

interface GeocodedResult {
  lat: number;
  lon: number;
  name: string;
}

interface PendingStopTarget {
  key: string;
  dayId: string;
  itemId: string | null;
  query: string;
  name: string;
  kind: MapStopKind;
  location: string;
  mapLink: string;
}

const geocodeCache = new Map<string, Promise<GeocodedResult | null>>();
const routeCache = new Map<string, Promise<Awaited<ReturnType<typeof fetchDrivingRouteGeometry>>>>();

function trimToQuery(parts: Array<string | null | undefined>) {
  return parts.map((part) => part?.trim() ?? "").filter(Boolean).join(", ");
}

function buildGeocodeKey(query: string, isoA2: string) {
  return `${isoA2.toLowerCase()}::${query.toLowerCase()}`;
}

async function fetchGeocodedPlace(query: string, isoA2: string): Promise<GeocodedResult | null> {
  const params = new URLSearchParams({ q: query, iso: isoA2 });
  const response = await fetch(`/api/places/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error("שירות הגאוקודינג לא זמין כרגע.");
  }

  const data = (await response.json()) as {
    results?: Array<{ name?: string; lat?: number; lon?: number }>;
  };
  const top = data.results?.[0];
  if (!top || typeof top.lat !== "number" || typeof top.lon !== "number") return null;

  return {
    name: top.name?.trim() || query,
    lat: top.lat,
    lon: top.lon,
  };
}

function geocodeWithCache(query: string, isoA2: string) {
  const cacheKey = buildGeocodeKey(query, isoA2);
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetchGeocodedPlace(query, isoA2).catch((error) => {
    geocodeCache.delete(cacheKey);
    throw error;
  });

  geocodeCache.set(cacheKey, promise);
  return promise;
}

function buildRouteKey(segment: Pick<MapSegment, "from" | "to" | "mode">) {
  return `${segment.mode.toLowerCase()}::${segment.from.lat.toFixed(5)},${segment.from.lon.toFixed(5)}::${segment.to.lat.toFixed(5)},${segment.to.lon.toFixed(5)}`;
}

function routeWithCache(segment: Pick<MapSegment, "from" | "to" | "mode">) {
  const cacheKey = buildRouteKey(segment);
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetchDrivingRouteGeometry(
    { lat: segment.from.lat, lon: segment.from.lon },
    { lat: segment.to.lat, lon: segment.to.lon }
  ).catch((error) => {
    routeCache.delete(cacheKey);
    throw error;
  });

  routeCache.set(cacheKey, promise);
  return promise;
}

function readCssHsl(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value ? `hsl(${value})` : fallback;
}

function classifyStopKind(item: TripItineraryItem): MapStopKind {
  const haystack = `${item.name} ${item.location} ${item.shortDescription}`.toLowerCase();

  if (item.category === "restaurant" || item.category === "cafe") return "meal";
  if (item.category === "transportation") {
    if (/airport|שדה|נמל תעופה/.test(haystack)) return "airport";
    if (/station|תחנה|terminal|harbor|port|ferry|רציף/.test(haystack)) return "station";
    if (/צ'ק|מזווד|laundry|כביסה|planning|תכנון|סידור/.test(haystack)) return "practical";
    return "station";
  }

  return "activity";
}

function kindLabel(kind: MapStopKind) {
  switch (kind) {
    case "accommodation":
      return "לינה";
    case "meal":
      return "אוכל";
    case "station":
      return "תחנה";
    case "airport":
      return "שדה תעופה";
    case "practical":
      return "סידור";
    case "activity":
    default:
      return "פעילות";
  }
}

function getMarkerShapeClass(kind: MapStopKind) {
  switch (kind) {
    case "accommodation":
      return "rounded-[16px]";
    case "meal":
      return "rounded-full";
    case "station":
      return "rounded-md";
    case "airport":
      return "rounded-[999px] px-2";
    case "practical":
      return "rounded-[14px] border-dashed";
    case "activity":
    default:
      return "rounded-[12px]";
  }
}

function isRoutableWithProvider(mode: string) {
  const lower = mode.toLowerCase();
  return /car|drive|driving|taxi|מונית|רכב|נהיגה/.test(lower);
}

function estimateDurationFromMode(mode: string, distanceKm: number) {
  const lower = mode.toLowerCase();
  const speed =
    /walk|הליכ/.test(lower)
      ? 4.6
      : /bike|bicycle|אופני/.test(lower)
        ? 14
        : /train|רכבת/.test(lower)
          ? 55
          : /ferry|מעבור/.test(lower)
            ? 28
            : /car|drive|driving|taxi|מונית|רכב|נהיגה/.test(lower)
              ? 32
              : 20;

  return distanceKm > 0 ? Math.max(5, Math.round((distanceKm / speed) * 60)) : 0;
}

function offsetDuplicateStops(stops: MapStop[]) {
  const byCoordinate = new Map<string, number>();

  return stops.map((stop) => {
    const key = `${stop.lat.toFixed(5)},${stop.lon.toFixed(5)}`;
    const existingCount = byCoordinate.get(key) ?? 0;
    byCoordinate.set(key, existingCount + 1);

    if (existingCount === 0) return stop;

    const offset = 0.00035 * existingCount;
    return {
      ...stop,
      lat: stop.lat + offset,
      lon: stop.lon + offset,
    };
  });
}

function buildDayStops(day: TripItineraryDay, countryName: string) {
  const stops: MapStop[] = [];
  const validItems = day.items
    .filter((item) => item.lat != null && item.lon != null)
    .sort((left, right) =>
      left.plannedStartTime && right.plannedStartTime
        ? left.plannedStartTime.localeCompare(right.plannedStartTime)
        : 0
    );

  let order = 1;

  if (day.accommodationLat != null && day.accommodationLon != null && day.accommodation.trim()) {
    stops.push({
      key: `${day.id}-start-accommodation`,
      dayId: day.id,
      dayNumber: day.dayNumber,
      itemId: null,
      kind: "accommodation",
      order: order++,
      name: day.accommodation,
      location: day.accommodation,
      lat: day.accommodationLat,
      lon: day.accommodationLon,
      mapLink: day.accommodationMapLink || buildMapLink(day.accommodation, day.accommodationLat, day.accommodationLon),
      plannedStartTime: validItems[0]?.plannedStartTime || "08:30",
      slotLabel: "תחילת יום",
      durationMinutes: null,
      approximatePrice: null,
      transportation: day.transportation || "תחבורה מקומית",
    });
  }

  for (const item of validItems) {
    stops.push({
      key: item.id,
      dayId: day.id,
      dayNumber: day.dayNumber,
      itemId: item.id,
      kind: classifyStopKind(item),
      order: order++,
      name: item.name || item.location || countryName,
      location: item.location || countryName,
      lat: item.lat!,
      lon: item.lon!,
      mapLink: item.mapLink || buildMapLink(item.name, item.lat, item.lon),
      plannedStartTime: item.plannedStartTime,
      slotLabel: DAY_PART_LABELS[item.slot],
      durationMinutes: item.estimatedDurationMinutes,
      approximatePrice: item.approximatePrice,
      transportation: item.transportation || day.transportation || "תחבורה מקומית",
    });
  }

  if (day.accommodationLat != null && day.accommodationLon != null && day.accommodation.trim()) {
    stops.push({
      key: `${day.id}-end-accommodation`,
      dayId: day.id,
      dayNumber: day.dayNumber,
      itemId: null,
      kind: "accommodation",
      order: order++,
      name: day.accommodation,
      location: day.accommodation,
      lat: day.accommodationLat,
      lon: day.accommodationLon,
      mapLink: day.accommodationMapLink || buildMapLink(day.accommodation, day.accommodationLat, day.accommodationLon),
      plannedStartTime: validItems.at(-1)?.plannedStartTime || "21:00",
      slotLabel: "סיום יום",
      durationMinutes: null,
      approximatePrice: null,
      transportation: day.transportation || "תחבורה מקומית",
    });
  }

  return offsetDuplicateStops(stops);
}

function buildPendingDayTargets(day: TripItineraryDay) {
  const targets: PendingStopTarget[] = [];

  if (
    day.accommodation.trim() &&
    (day.accommodationLat == null || day.accommodationLon == null)
  ) {
    targets.push({
      key: `${day.id}-accommodation`,
      dayId: day.id,
      itemId: null,
      query: trimToQuery([day.accommodation, day.cityRegion]),
      name: day.accommodation,
      kind: "accommodation",
      location: day.accommodation,
      mapLink: day.accommodationMapLink,
    });
  }

  for (const item of day.items) {
    if (item.lat != null && item.lon != null) continue;
    const query = trimToQuery([item.name, item.location, day.cityRegion]);
    if (!query) continue;
    targets.push({
      key: item.id,
      dayId: day.id,
      itemId: item.id,
      query,
      name: item.name || item.location,
      kind: classifyStopKind(item),
      location: item.location,
      mapLink: item.mapLink,
    });
  }

  return targets;
}

function buildTripStops(days: TripItineraryDay[], countryName: string) {
  return offsetDuplicateStops(
    days.flatMap((day) => {
      const perDay = buildDayStops(day, countryName);
      return perDay.filter((stop, index) => stop.kind !== "accommodation" || index === 0);
    })
  );
}

function buildPendingTripTargets(days: TripItineraryDay[]) {
  return days.flatMap((day) => buildPendingDayTargets(day));
}

function addMinutesToTime(time: string, minutes: number | null) {
  if (!time || minutes == null || minutes <= 0) return "";
  const [hours, mins] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return "";

  const total = hours * 60 + mins + minutes;
  const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  const nextHours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const nextMinutes = String(normalized % 60).padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}

function formatDistance(distanceKm: number | null) {
  if (distanceKm == null) return "לא זמין";
  return distanceKm >= 10 ? `${distanceKm.toFixed(1)} ק\"מ` : `${distanceKm.toFixed(2)} ק\"מ`;
}

function extractTransferCount(segmentText: string) {
  const match = segmentText.match(/(\d+)\s*(?:החלפ(?:ה|ות)|transfers?)/i);
  return match ? Number(match[1]) : null;
}

function parseSegmentCost(segmentText: string) {
  const match = segmentText.match(/(\d[\d,.]*)/);
  return match ? Number(match[1].replace(/,/g, "")) || null : null;
}

function buildDaySegments(day: TripItineraryDay, stops: MapStop[]) {
  const segments: MapSegment[] = [];

  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1];
    const to = stops[index];
    const sourceLabel = day.transportSegments[Math.max(0, Math.min(index - 1, day.transportSegments.length - 1))] ?? "";
    const distanceKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
    const durationMinutes =
      to.itemId != null
        ? day.items.find((item) => item.id === to.itemId)?.travelMinutes ?? estimateDurationFromMode(to.transportation, distanceKm)
        : estimateDurationFromMode(to.transportation || day.transportation, distanceKm);
    const departureTime = from.plannedStartTime || "";

    segments.push({
      key: `${day.id}-segment-${index}`,
      dayId: day.id,
      dayNumber: day.dayNumber,
      from,
      to,
      mode: to.transportation || day.transportation || "תחבורה מקומית",
      estimated: !isRoutableWithProvider(to.transportation || day.transportation || ""),
      distanceKm,
      durationMinutes,
      cost:
        sourceLabel ? parseSegmentCost(sourceLabel) : /walk|הליכ/.test((to.transportation || "").toLowerCase()) ? 0 : null,
      departureTime,
      arrivalTime: addMinutesToTime(departureTime, durationMinutes),
      transferCount: extractTransferCount(sourceLabel),
      geometry: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
      sourceLabel: sourceLabel || "הערכת מסלול",
    });
  }

  return segments;
}

function buildTripSegments(days: TripItineraryDay[], stops: MapStop[]) {
  const byDay = new Map<number, MapStop[]>();
  for (const stop of stops) {
    const next = byDay.get(stop.dayNumber) ?? [];
    next.push(stop);
    byDay.set(stop.dayNumber, next);
  }

  const segments: MapSegment[] = [];

  for (const day of days) {
    const dayStops = byDay.get(day.dayNumber) ?? [];
    segments.push(...buildDaySegments(day, dayStops));
  }

  return segments;
}

function useResolvedCoordinates(args: {
  pendingTargets: PendingStopTarget[];
  isoA2: string;
  onResolveDayAccommodation?: (dayId: string, coords: GeocodedResult, query: string) => void;
  onResolveItem?: (dayId: string, itemId: string, coords: GeocodedResult, query: string) => void;
}) {
  const { pendingTargets, isoA2, onResolveDayAccommodation, onResolveItem } = args;
  const [resolvedCoords, setResolvedCoords] = useState<Record<string, GeocodedResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingKeys, setLoadingKeys] = useState<string[]>([]);
  const retryTokenRef = useRef(0);

  const pendingKey = pendingTargets
    .map((target) => `${target.key}:${target.query}`)
    .sort()
    .join("|");

  useEffect(() => {
    let cancelled = false;
    const nextTargets = pendingTargets.filter((target) => !resolvedCoords[target.key]);
    if (nextTargets.length === 0) return;

    setLoadingKeys((current) => Array.from(new Set([...current, ...nextTargets.map((target) => target.key)])));

    Promise.allSettled(
      nextTargets.map(async (target) => {
        const result = await geocodeWithCache(target.query, isoA2);
        return { target, result };
      })
    ).then((results) => {
      if (cancelled) return;

      const resolvedPatch: Record<string, GeocodedResult> = {};
      const errorPatch: Record<string, string> = {};

      for (const result of results) {
        if (result.status === "rejected") {
          const target = nextTargets[results.indexOf(result)];
          if (target) {
            errorPatch[target.key] = result.reason instanceof Error ? result.reason.message : "לא הצלחנו לאתר את המקום.";
          }
          continue;
        }

        const { target, result: coords } = result.value;
        if (!coords) {
          errorPatch[target.key] = "לא נמצאו קואורדינטות למקום הזה.";
          continue;
        }

        resolvedPatch[target.key] = coords;

        if (target.itemId) {
          onResolveItem?.(target.dayId, target.itemId, coords, target.query);
        } else {
          onResolveDayAccommodation?.(target.dayId, coords, target.query);
        }
      }

      setResolvedCoords((current) => ({ ...current, ...resolvedPatch }));
      setErrors((current) => ({ ...current, ...errorPatch }));
      setLoadingKeys((current) =>
        current.filter((key) => !nextTargets.some((target) => target.key === key))
      );
    });

    return () => {
      cancelled = true;
    };
  }, [isoA2, onResolveDayAccommodation, onResolveItem, pendingKey, pendingTargets, resolvedCoords]);

  function retry() {
    retryTokenRef.current += 1;
    for (const target of pendingTargets) {
      geocodeCache.delete(buildGeocodeKey(target.query, isoA2));
    }
    setErrors({});
    setResolvedCoords({});
    setLoadingKeys([]);
  }

  return {
    resolvedCoords,
    errors,
    loading: loadingKeys.length > 0,
    retry,
    unresolvedNames: pendingTargets
      .filter((target) => !resolvedCoords[target.key])
      .map((target) => target.name || target.query),
  };
}

function useRouteGeometry(segments: MapSegment[]) {
  const [routeResults, setRouteResults] = useState<Record<string, Awaited<ReturnType<typeof fetchDrivingRouteGeometry>>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingKeys, setLoadingKeys] = useState<string[]>([]);

  const supportedSegments = useMemo(
    () => segments.filter((segment) => isRoutableWithProvider(segment.mode)),
    [segments]
  );
  const supportedKey = supportedSegments.map((segment) => segment.key).join("|");

  useEffect(() => {
    let cancelled = false;
    const nextSegments = supportedSegments.filter((segment) => routeResults[segment.key] === undefined);
    if (nextSegments.length === 0) return;

    setLoadingKeys((current) => Array.from(new Set([...current, ...nextSegments.map((segment) => segment.key)])));

    Promise.allSettled(
      nextSegments.map(async (segment) => {
        const result = await routeWithCache(segment);
        return { key: segment.key, result };
      })
    ).then((results) => {
      if (cancelled) return;

      const resolvedPatch: Record<string, Awaited<ReturnType<typeof fetchDrivingRouteGeometry>>> = {};
      const errorPatch: Record<string, string> = {};

      for (const outcome of results) {
        if (outcome.status === "rejected") {
          const key = nextSegments[results.indexOf(outcome)]?.key;
          if (key) {
            errorPatch[key] =
              outcome.reason instanceof Error ? outcome.reason.message : "שירות הניתוב לא זמין כרגע.";
          }
          continue;
        }

        resolvedPatch[outcome.value.key] = outcome.value.result;
      }

      setRouteResults((current) => ({ ...current, ...resolvedPatch }));
      setErrors((current) => ({ ...current, ...errorPatch }));
      setLoadingKeys((current) =>
        current.filter((key) => !nextSegments.some((segment) => segment.key === key))
      );
    });

    return () => {
      cancelled = true;
    };
  }, [routeResults, supportedKey, supportedSegments]);

  function retry() {
    for (const segment of supportedSegments) {
      routeCache.delete(buildRouteKey(segment));
    }
    setErrors({});
    setRouteResults({});
    setLoadingKeys([]);
  }

  return {
    routeResults,
    errors,
    loading: loadingKeys.length > 0,
    retry,
  };
}

function useDayRouteData(args: {
  day: TripItineraryDay;
  countryName: string;
  isoA2: string;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (
    dayId: string,
    itemId: string,
    updater: (item: TripItineraryItem) => TripItineraryItem
  ) => void;
}) {
  const { day, countryName, isoA2, onPatchDay, onPatchItem } = args;
  const pendingTargets = useMemo(() => buildPendingDayTargets(day), [day]);
  const geocoding = useResolvedCoordinates({
    pendingTargets,
    isoA2,
    onResolveDayAccommodation: (dayId, coords, query) => {
      onPatchDay(dayId, (current) =>
        current.accommodationLat != null && current.accommodationLon != null
          ? current
          : {
              ...current,
              accommodationLat: coords.lat,
              accommodationLon: coords.lon,
              accommodationMapLink:
                current.accommodationMapLink || buildMapLink(query, coords.lat, coords.lon),
            }
      );
    },
    onResolveItem: (dayId, itemId, coords, query) => {
      onPatchItem(dayId, itemId, (current) =>
        current.lat != null && current.lon != null
          ? current
          : {
              ...current,
              lat: coords.lat,
              lon: coords.lon,
              mapLink: current.mapLink || buildMapLink(query, coords.lat, coords.lon),
            }
      );
    },
  });

  const hydratedDay = useMemo(() => {
    if (Object.keys(geocoding.resolvedCoords).length === 0) return day;

    const nextItems = day.items.map((item) => {
      const resolved = geocoding.resolvedCoords[item.id];
      return resolved && (item.lat == null || item.lon == null)
        ? {
            ...item,
            lat: resolved.lat,
            lon: resolved.lon,
            mapLink: item.mapLink || buildMapLink(item.name || item.location, resolved.lat, resolved.lon),
          }
        : item;
    });

    const accommodationResolved = geocoding.resolvedCoords[`${day.id}-accommodation`];

    return {
      ...day,
      accommodationLat:
        day.accommodationLat != null ? day.accommodationLat : accommodationResolved?.lat ?? null,
      accommodationLon:
        day.accommodationLon != null ? day.accommodationLon : accommodationResolved?.lon ?? null,
      accommodationMapLink:
        day.accommodationMapLink ||
        (accommodationResolved
          ? buildMapLink(day.accommodation, accommodationResolved.lat, accommodationResolved.lon)
          : ""),
      items: nextItems,
    };
  }, [day, geocoding.resolvedCoords]);

  const stops = useMemo(() => buildDayStops(hydratedDay, countryName), [countryName, hydratedDay]);
  const baseSegments = useMemo(() => buildDaySegments(hydratedDay, stops), [hydratedDay, stops]);
  const routing = useRouteGeometry(baseSegments);

  const segments = useMemo(
    () =>
      baseSegments.map((segment) => {
        const route = routing.routeResults[segment.key];
        if (!route || !isRoutableWithProvider(segment.mode)) return segment;
        return {
          ...segment,
          estimated: false,
          distanceKm: Number((route.distanceMeters / 1000).toFixed(2)),
          durationMinutes: Math.max(1, Math.round(route.durationSeconds / 60)),
          geometry: route.geometry.map((point) => [point.lon, point.lat] as [number, number]),
        };
      }),
    [baseSegments, routing.routeResults]
  );

  return {
    hydratedDay,
    stops,
    segments,
    geocoding,
    routing,
  };
}

function useTripRouteData(args: {
  days: TripItineraryDay[];
  countryName: string;
  isoA2: string;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (
    dayId: string,
    itemId: string,
    updater: (item: TripItineraryItem) => TripItineraryItem
  ) => void;
}) {
  const { days, countryName, isoA2, onPatchDay, onPatchItem } = args;
  const pendingTargets = useMemo(() => buildPendingTripTargets(days), [days]);
  const geocoding = useResolvedCoordinates({
    pendingTargets,
    isoA2,
    onResolveDayAccommodation: (dayId, coords, query) => {
      onPatchDay(dayId, (current) =>
        current.accommodationLat != null && current.accommodationLon != null
          ? current
          : {
              ...current,
              accommodationLat: coords.lat,
              accommodationLon: coords.lon,
              accommodationMapLink:
                current.accommodationMapLink || buildMapLink(query, coords.lat, coords.lon),
            }
      );
    },
    onResolveItem: (dayId, itemId, coords, query) => {
      onPatchItem(dayId, itemId, (current) =>
        current.lat != null && current.lon != null
          ? current
          : {
              ...current,
              lat: coords.lat,
              lon: coords.lon,
              mapLink: current.mapLink || buildMapLink(query, coords.lat, coords.lon),
            }
      );
    },
  });

  const hydratedDays = useMemo(
    () =>
      days.map((day) => {
        const accommodationResolved = geocoding.resolvedCoords[`${day.id}-accommodation`];
        return {
          ...day,
          accommodationLat:
            day.accommodationLat != null ? day.accommodationLat : accommodationResolved?.lat ?? null,
          accommodationLon:
            day.accommodationLon != null ? day.accommodationLon : accommodationResolved?.lon ?? null,
          accommodationMapLink:
            day.accommodationMapLink ||
            (accommodationResolved
              ? buildMapLink(day.accommodation, accommodationResolved.lat, accommodationResolved.lon)
              : ""),
          items: day.items.map((item) => {
            const resolved = geocoding.resolvedCoords[item.id];
            return resolved && (item.lat == null || item.lon == null)
              ? {
                  ...item,
                  lat: resolved.lat,
                  lon: resolved.lon,
                  mapLink: item.mapLink || buildMapLink(item.name || item.location, resolved.lat, resolved.lon),
                }
              : item;
          }),
        };
      }),
    [days, geocoding.resolvedCoords]
  );

  const stops = useMemo(() => buildTripStops(hydratedDays, countryName), [countryName, hydratedDays]);
  const baseSegments = useMemo(() => buildTripSegments(hydratedDays, stops), [hydratedDays, stops]);
  const routing = useRouteGeometry(baseSegments);

  const segments = useMemo(
    () =>
      baseSegments.map((segment) => {
        const route = routing.routeResults[segment.key];
        if (!route || !isRoutableWithProvider(segment.mode)) return segment;
        return {
          ...segment,
          estimated: false,
          distanceKm: Number((route.distanceMeters / 1000).toFixed(2)),
          durationMinutes: Math.max(1, Math.round(route.durationSeconds / 60)),
          geometry: route.geometry.map((point) => [point.lon, point.lat] as [number, number]),
        };
      }),
    [baseSegments, routing.routeResults]
  );

  return {
    hydratedDays,
    stops,
    segments,
    geocoding,
    routing,
  };
}

function DayMapCanvas({
  mapId,
  stops,
  segments,
  loading,
  activeStopKey,
  activeSegmentKey,
  onSelectStop,
  onSelectSegment,
  onMarkerOpenDay,
  className,
}: {
  mapId: string;
  stops: MapStop[];
  segments: MapSegment[];
  loading: boolean;
  activeStopKey: string | null;
  activeSegmentKey: string | null;
  onSelectStop: (stopKey: string | null) => void;
  onSelectSegment: (segmentKey: string | null) => void;
  onMarkerOpenDay?: (dayId: string) => void;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { containerRef, mapRef, ready } = useCountryMiniMap({ isDark, feature: undefined });
  const markersRef = useRef<Array<{ remove: () => void }>>([]);
  const listenersRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const coords = stops.map((stop) => [stop.lon, stop.lat] as const);
    if (coords.length === 0) return;

    const lngs = coords.map(([lng]) => lng);
    const lats = coords.map(([, lat]) => lat);
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];

    map.fitBounds(bounds, {
      padding: 56,
      duration: 0,
      maxZoom: coords.length === 1 ? 15 : 13,
    });
  }, [mapRef, ready, stops]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    let cancelled = false;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled || !mapRef.current) return;

      const surface = readCssHsl("--background", "#ffffff");
      const border = readCssHsl("--border", "#d4d4d8");
      const foreground = readCssHsl("--foreground", "#111827");
      const accent = readCssHsl("--primary", "#0f172a");

      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];

      for (const stop of stops) {
        const markerNode = document.createElement("button");
        markerNode.type = "button";
        markerNode.className = cn(
          "flex min-w-[2.1rem] items-center justify-center gap-1 border px-2 py-1 text-[11px] font-semibold shadow-lg",
          getMarkerShapeClass(stop.kind),
          activeStopKey === stop.key ? "ring-2 ring-offset-2" : ""
        );
        markerNode.style.background = surface;
        markerNode.style.borderColor = activeStopKey === stop.key ? accent : border;
        markerNode.style.color = foreground;
        markerNode.style.setProperty("--tw-ring-color", accent);
        markerNode.textContent = `${stop.order}`;
        markerNode.addEventListener("click", () => {
          onSelectStop(stop.key);
          if (onMarkerOpenDay) {
            onMarkerOpenDay(stop.dayId);
          }
        });

        const popupNode = document.createElement("div");
        popupNode.className = "w-56 space-y-2 p-1 text-sm";

        const title = document.createElement("p");
        title.className = "font-medium";
        title.textContent = `${stop.order}. ${stop.name}`;
        popupNode.appendChild(title);

        const meta = document.createElement("p");
        meta.className = "text-xs";
        meta.textContent = `${kindLabel(stop.kind)}${stop.plannedStartTime ? ` · ${stop.plannedStartTime}` : ""}`;
        popupNode.appendChild(meta);

        const location = document.createElement("p");
        location.className = "text-xs";
        location.textContent = stop.location;
        popupNode.appendChild(location);

        const details = document.createElement("p");
        details.className = "text-xs";
        details.textContent = [
          stop.durationMinutes != null ? `משך ${stop.durationMinutes} דק׳` : null,
          stop.approximatePrice != null ? formatCurrency(stop.approximatePrice) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        if (details.textContent) popupNode.appendChild(details);

        const link = document.createElement("a");
        link.href = stop.mapLink || buildMapLink(stop.name, stop.lat, stop.lon);
        link.target = "_blank";
        link.rel = "noreferrer";
        link.className = "mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-xs font-medium";
        link.textContent = "פתח בניווט";
        popupNode.appendChild(link);

        const popup = new maplibregl.Popup({ offset: 12 }).setDOMContent(popupNode);

        const marker = new maplibregl.Marker({ element: markerNode })
          .setLngLat([stop.lon, stop.lat])
          .setPopup(popup)
          .addTo(mapRef.current);

        markersRef.current.push(marker);
      }
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [activeStopKey, mapRef, onMarkerOpenDay, onSelectStop, ready, stops]);

  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const accent = readCssHsl("--primary", "#0f172a");
    const muted = readCssHsl("--muted-foreground", "#64748b");
    const cleanupIds: Array<{ sourceId: string; layerId: string; click: () => void; enter: () => void; leave: () => void }> = [];

    listenersRef.current.forEach((dispose) => dispose());
    listenersRef.current = [];

    const sourceIds = segments.map((segment) => `${mapId}-${segment.key}-source`);
    const layerIds = segments.map((segment) => `${mapId}-${segment.key}-layer`);

    for (const layerId of layerIds) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    for (const sourceId of sourceIds) {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }

    for (const segment of segments) {
      const sourceId = `${mapId}-${segment.key}-source`;
      const layerId = `${mapId}-${segment.key}-layer`;
      map.addSource(sourceId, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: segment.geometry,
              },
              properties: {
                segmentKey: segment.key,
              },
            },
          ],
        },
      });

      map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": activeSegmentKey === segment.key ? accent : muted,
          "line-width": activeSegmentKey === segment.key ? 5 : 3,
          "line-opacity": segment.estimated ? 0.7 : 0.9,
          "line-dasharray": segment.estimated ? [2, 2] : [1, 0],
        },
      });

      const handleClick = () => onSelectSegment(segment.key);
      const handleEnter = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const handleLeave = () => {
        map.getCanvas().style.cursor = "";
      };

      map.on("click", layerId, handleClick);
      map.on("mouseenter", layerId, handleEnter);
      map.on("mouseleave", layerId, handleLeave);
      cleanupIds.push({ sourceId, layerId, click: handleClick, enter: handleEnter, leave: handleLeave });
    }

    listenersRef.current = cleanupIds.map(({ sourceId, layerId, click, enter, leave }) => () => {
      if (!map.getStyle()) return;
      map.off("click", layerId, click);
      map.off("mouseenter", layerId, enter);
      map.off("mouseleave", layerId, leave);
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    });

    return () => {
      listenersRef.current.forEach((dispose) => dispose());
      listenersRef.current = [];
    };
  }, [activeSegmentKey, mapId, mapRef, onSelectSegment, ready, segments]);

  return (
    <div className={cn("relative min-h-[18rem] overflow-hidden rounded-[24px] border border-border/70 bg-background/70", className)}>
      {!ready || loading ? <Skeleton className="absolute inset-0 rounded-[24px]" /> : null}
      <div ref={containerRef} className="h-[20rem] w-full sm:h-[24rem]" />
    </div>
  );
}

function SegmentDetailPanel({
  segments,
  selectedSegmentKey,
  onSelectSegment,
  unresolvedNames,
  geocodeErrors,
  routeErrors,
}: {
  segments: MapSegment[];
  selectedSegmentKey: string | null;
  onSelectSegment: (segmentKey: string | null) => void;
  unresolvedNames: string[];
  geocodeErrors: string[];
  routeErrors: string[];
}) {
  const selectedSegment =
    segments.find((segment) => segment.key === selectedSegmentKey) ?? segments[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">מקטעי מסלול</p>
            <p className="mt-1 text-xs text-muted-foreground">
              לחצו על מקטע כדי להדגיש אותו על המפה ולקשר אותו לטיימליין.
            </p>
          </div>
          <Badge variant="outline">{segments.length}</Badge>
        </div>

        {segments.length > 0 ? (
          <div className="mt-4 space-y-2">
            {segments.map((segment) => (
              <button
                key={segment.key}
                type="button"
                onClick={() => onSelectSegment(segment.key)}
                className={cn(
                  "w-full rounded-[18px] border px-3 py-3 text-right transition-colors",
                  selectedSegment?.key === segment.key
                    ? "border-primary/40 bg-primary/10"
                    : "border-border/60 bg-background/70 hover:bg-muted/50"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">
                    {segment.from.order} → {segment.to.order}
                  </span>
                  {segment.estimated ? <Badge variant="outline">הערכה</Badge> : <Badge variant="secondary">מסלול מחושב</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {segment.from.name} → {segment.to.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {segment.mode || "תחבורה מקומית"} · {segment.durationMinutes != null ? `${segment.durationMinutes} דק׳` : "ללא זמן"}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            עדיין אין מספיק נקודות עם קואורדינטות כדי לחשב מסלול מלא.
          </p>
        )}
      </div>

      {selectedSegment ? (
        <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
          <p className="text-sm font-semibold text-foreground">פרטי המקטע הנבחר</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">מוצא</p>
              <p className="mt-1 font-medium">{selectedSegment.from.name}</p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">יעד</p>
              <p className="mt-1 font-medium">{selectedSegment.to.name}</p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">אמצעי תחבורה</p>
              <p className="mt-1 font-medium">{selectedSegment.mode || "תחבורה מקומית"}</p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">מרחק</p>
              <p className="mt-1 font-medium">{formatDistance(selectedSegment.distanceKm)}</p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">זמן נסיעה</p>
              <p className="mt-1 font-medium">
                {selectedSegment.durationMinutes != null ? `${selectedSegment.durationMinutes} דק׳` : "לא זמין"}
              </p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">עלות משוערת</p>
              <p className="mt-1 font-medium">
                {selectedSegment.cost != null ? formatCurrency(selectedSegment.cost) : "לא צוין"}
              </p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">שעת יציאה</p>
              <p className="mt-1 font-medium">{selectedSegment.departureTime || "לא צוין"}</p>
            </div>
            <div className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
              <p className="text-xs text-muted-foreground">שעת הגעה</p>
              <p className="mt-1 font-medium">{selectedSegment.arrivalTime || "לא צוין"}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {selectedSegment.transferCount != null
              ? `מספר החלפות: ${selectedSegment.transferCount}. `
              : ""}
            {selectedSegment.estimated ? "הקו על המפה הוא חיבור מוערך כי אין geometry מאומת למצב התחבורה הזה." : "הקו חושב משירות הניתוב הקיים."}
          </p>
        </div>
      ) : null}

      {unresolvedNames.length > 0 || geocodeErrors.length > 0 || routeErrors.length > 0 ? (
        <div className="rounded-[24px] border border-dashed border-border/70 bg-background/70 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <BadgeAlert className="size-4 text-primary" />
            מצב נתוני מפה
          </div>
          {unresolvedNames.length > 0 ? (
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              עדיין מנסים לאתר: {unresolvedNames.join(", ")}.
            </p>
          ) : null}
          {geocodeErrors.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs leading-6 text-muted-foreground">
              {geocodeErrors.map((error, index) => (
                <li key={`geo-error-${index}`}>{error}</li>
              ))}
            </ul>
          ) : null}
          {routeErrors.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs leading-6 text-muted-foreground">
              {routeErrors.map((error, index) => (
                <li key={`route-error-${index}`}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ItineraryDayRouteSection({
  day,
  countryName,
  isoA2,
  onPatchDay,
  onPatchItem,
  onActiveItemIdsChange,
}: {
  day: TripItineraryDay;
  countryName: string;
  isoA2: string;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (
    dayId: string,
    itemId: string,
    updater: (item: TripItineraryItem) => TripItineraryItem
  ) => void;
  onActiveItemIdsChange: (itemIds: string[]) => void;
}) {
  const [mapCollapsed, setMapCollapsed] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [selectedStopKey, setSelectedStopKey] = useState<string | null>(null);
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  const { hydratedDay, stops, segments, geocoding, routing } = useDayRouteData({
    day,
    countryName,
    isoA2,
    onPatchDay,
    onPatchItem,
  });

  useEffect(() => {
    if (selectedSegmentKey) {
      const segment = segments.find((entry) => entry.key === selectedSegmentKey);
      if (segment) {
        onActiveItemIdsChange(
          [segment.from.itemId, segment.to.itemId].filter(Boolean) as string[]
        );
        return;
      }
    }

    if (selectedStopKey) {
      const stop = stops.find((entry) => entry.key === selectedStopKey);
      onActiveItemIdsChange(stop?.itemId ? [stop.itemId] : []);
      return;
    }

    onActiveItemIdsChange([]);
  }, [onActiveItemIdsChange, segments, selectedSegmentKey, selectedStopKey, stops]);

  const sharedMapProps = {
    mapId: `day-map-${day.id}`,
    stops,
    segments,
    loading: geocoding.loading || routing.loading,
    activeStopKey: selectedStopKey,
    activeSegmentKey: selectedSegmentKey,
    onSelectStop: (stopKey: string | null) => {
      setSelectedStopKey(stopKey);
      setSelectedSegmentKey(null);
    },
    onSelectSegment: (segmentKey: string | null) => {
      setSelectedSegmentKey(segmentKey);
      setSelectedStopKey(null);
    },
  } as const;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h5 className="font-heading text-lg font-semibold text-foreground">מפת המסלול היומית</h5>
          <p className="mt-1 text-sm text-muted-foreground">
            המפה מתעדכנת לפי העצירות, הלינה והמסלול של היום הנבחר.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {geocoding.loading || routing.loading ? (
            <Badge variant="outline" className="gap-1">
              <LoaderCircle className="size-3.5 animate-spin" />
              מחשבים מסלול
            </Badge>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setMapCollapsed((current) => !current)}>
            {mapCollapsed ? <Expand className="size-4" /> : <Shrink className="size-4" />}
            {mapCollapsed ? "הצג מפה" : "הסתר מפה"}
          </Button>
          <Button variant="outline" size="sm" className="lg:hidden" onClick={() => setFullscreenOpen(true)}>
            <MapPinned className="size-4" />
            פתח מפה מלאה
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              geocoding.retry();
              routing.retry();
            }}
          >
            <RotateCcw className="size-4" />
            נסה שוב
          </Button>
        </div>
      </div>

      {!mapCollapsed ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.95fr)]">
          <div className="space-y-3">
            <DayMapCanvas {...sharedMapProps} className="hidden lg:block" />
            <DayMapCanvas {...sharedMapProps} className="lg:hidden" />
            {stops.length < 2 ? (
              <div className="rounded-[22px] border border-dashed border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">
                {stops.length === 1
                  ? "יש כרגע רק נקודה אחת עם קואורדינטות, לכן מוצג marker יחיד עד שנאסוף עוד נתוני מסלול."
                  : "אין עדיין מספיק נקודות עם קואורדינטות כדי לחשב route מלא."}
              </div>
            ) : null}
          </div>

          <SegmentDetailPanel
            segments={segments}
            selectedSegmentKey={selectedSegmentKey}
            onSelectSegment={(segmentKey) => {
              setSelectedSegmentKey(segmentKey);
              setSelectedStopKey(null);
            }}
            unresolvedNames={geocoding.unresolvedNames}
            geocodeErrors={Object.values(geocoding.errors)}
            routeErrors={Object.values(routing.errors)}
          />
        </div>
      ) : null}

      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent className="h-[100dvh] max-h-[100dvh] w-screen max-w-none rounded-none border-0 bg-background/95 p-4 shadow-none sm:h-auto sm:max-h-[90dvh] sm:w-[min(94vw,1200px)] sm:rounded-[2rem] sm:border sm:border-border/70">
          <div className="space-y-4">
            <div>
              <DialogTitle>מפת המסלול היומית</DialogTitle>
              <DialogDescription>
                תצוגה מלאה של העצירות, מקטעי הדרך והלינה ביום {hydratedDay.dayNumber}.
              </DialogDescription>
            </div>
            <DayMapCanvas {...sharedMapProps} className="min-h-[70dvh]" />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[18px] border border-border/60 bg-background/70 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

export function ItineraryTripSummarySection({
  days,
  countryName,
  isoA2,
  onPatchDay,
  onPatchItem,
  onOpenDay,
}: {
  days: TripItineraryDay[];
  countryName: string;
  isoA2: string;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (
    dayId: string,
    itemId: string,
    updater: (item: TripItineraryItem) => TripItineraryItem
  ) => void;
  onOpenDay: (dayId: string) => void;
}) {
  const [visibleDayIds, setVisibleDayIds] = useState<Set<string>>(new Set(days.map((day) => day.id)));
  const [showMeals, setShowMeals] = useState(true);
  const [showAccommodations, setShowAccommodations] = useState(true);
  const [showActivities, setShowActivities] = useState(true);
  const [showTransport, setShowTransport] = useState(true);
  const [selectedSegmentKey, setSelectedSegmentKey] = useState<string | null>(null);
  const { hydratedDays, stops, segments, geocoding, routing } = useTripRouteData({
    days,
    countryName,
    isoA2,
    onPatchDay,
    onPatchItem,
  });

  useEffect(() => {
    setVisibleDayIds(new Set(days.map((day) => day.id)));
  }, [days]);

  const filteredStops = useMemo(
    () =>
      stops.filter((stop) => {
        if (!visibleDayIds.has(stop.dayId)) return false;
        if (stop.kind === "accommodation" && !showAccommodations) return false;
        if (stop.kind === "meal" && !showMeals) return false;
        if ((stop.kind === "station" || stop.kind === "airport" || stop.kind === "practical") && !showTransport) {
          return false;
        }
        if (stop.kind === "activity" && !showActivities) return false;
        return true;
      }),
    [showAccommodations, showActivities, showMeals, showTransport, stops, visibleDayIds]
  );

  const filteredSegments = useMemo(
    () =>
      segments.filter(
        (segment) =>
          visibleDayIds.has(segment.dayId) &&
          filteredStops.some((stop) => stop.key === segment.from.key) &&
          filteredStops.some((stop) => stop.key === segment.to.key)
      ),
    [filteredStops, segments, visibleDayIds]
  );

  const totalDistanceKm = filteredSegments.reduce((sum, segment) => sum + (segment.distanceKm ?? 0), 0);
  const totalTravelMinutes = filteredSegments.reduce((sum, segment) => sum + (segment.durationMinutes ?? 0), 0);
  const totalTransportCost = filteredSegments.reduce((sum, segment) => sum + (segment.cost ?? 0), 0);
  const accommodationCount = new Set(
    hydratedDays.map((day) => day.accommodation.trim()).filter(Boolean)
  ).size;
  const travelDays = hydratedDays.filter(
    (day) =>
      (day.totalTravelMinutes ?? 0) > 120 ||
      /מעבר|רכבת|טיסה|צ'ק-אאוט|צ'ק-אין/.test(`${day.notes} ${day.transportation}`)
  ).length;
  const restDays = hydratedDays.filter(
    (day) =>
      Boolean(day.restWindow.trim()) ||
      /רגוע|מנוחה|גמיש|כביסה/.test(`${day.restWindow} ${day.notes}`)
  ).length;

  const cityRuns = useMemo(() => {
    const runs: Array<{ city: string; nights: number; transport: string }> = [];
    for (const day of hydratedDays) {
      const city = day.cityRegion || countryName;
      const last = runs.at(-1);
      if (last && last.city === city) {
        last.nights += 1;
      } else {
        runs.push({ city, nights: 1, transport: day.transportation || "תחבורה מקומית" });
      }
    }
    return runs;
  }, [countryName, hydratedDays]);

  const summaryMapId = "trip-summary-map";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-heading text-xl font-semibold text-foreground">סיכום המסלול</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            מפה מלאה של כל הימים, הלינות והמעברים לאורך הטיול.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={showAccommodations ? "secondary" : "outline"} size="sm" onClick={() => setShowAccommodations((current) => !current)}>
            <BedDouble className="size-4" />
            לינות
          </Button>
          <Button variant={showMeals ? "secondary" : "outline"} size="sm" onClick={() => setShowMeals((current) => !current)}>
            אוכל
          </Button>
          <Button variant={showActivities ? "secondary" : "outline"} size="sm" onClick={() => setShowActivities((current) => !current)}>
            אטרקציות
          </Button>
          <Button variant={showTransport ? "secondary" : "outline"} size="sm" onClick={() => setShowTransport((current) => !current)}>
            תחבורה
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {hydratedDays.map((day) => {
          const active = visibleDayIds.has(day.id);
          return (
            <Button
              key={day.id}
              variant={active ? "secondary" : "outline"}
              size="sm"
              onClick={() =>
                setVisibleDayIds((current) => {
                  const next = new Set(current);
                  if (next.has(day.id)) next.delete(day.id);
                  else next.add(day.id);
                  return next;
                })
              }
            >
              Day {day.dayNumber}
            </Button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.95fr)]">
        <DayMapCanvas
          mapId={summaryMapId}
          stops={filteredStops}
          segments={filteredSegments.map((segment) => ({
            ...segment,
            sourceLabel: `Day ${segment.dayNumber}`,
          }))}
          loading={geocoding.loading || routing.loading}
          activeStopKey={null}
          activeSegmentKey={selectedSegmentKey}
          onSelectStop={(stopKey) => {
            const stop = filteredStops.find((entry) => entry.key === stopKey);
            if (stop) onOpenDay(stop.dayId);
          }}
          onSelectSegment={(segmentKey) => {
            setSelectedSegmentKey(segmentKey);
            const segment = filteredSegments.find((entry) => entry.key === segmentKey);
            if (segment) onOpenDay(segment.dayId);
          }}
        />

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryMetric label="סך מרחק" value={formatDistance(Number(totalDistanceKm.toFixed(1)))} />
            <SummaryMetric label="סך זמן נסיעה" value={`${totalTravelMinutes} דק׳`} />
            <SummaryMetric label="עלות תחבורה" value={totalTransportCost > 0 ? formatCurrency(totalTransportCost) : "לא צוין"} />
            <SummaryMetric label="מספר עצירות" value={`${filteredStops.length}`} />
            <SummaryMetric label="מספר לינות" value={`${accommodationCount}`} />
            <SummaryMetric label="ימי מעבר" value={`${travelDays}`} />
            <SummaryMetric label="ימי מנוחה" value={`${restDays}`} />
            <SummaryMetric label={'סה"כ ימים'} value={`${hydratedDays.length}`} />
          </div>

          <div className="rounded-[24px] border border-border/70 bg-background/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">סדר ערים ולינות</p>
              <Badge variant="outline">{cityRuns.length}</Badge>
            </div>
            <ol className="mt-4 space-y-2">
              {cityRuns.map((entry, index) => (
                <li key={`${entry.city}-${index}`} className="rounded-[18px] border border-border/60 bg-muted/20 p-3 text-sm">
                  <p className="font-medium">{index + 1}. {entry.city}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.nights} לילות · מעבר עיקרי: {entry.transport || "תחבורה מקומית"}
                  </p>
                </li>
              ))}
            </ol>
          </div>

          {(geocoding.unresolvedNames.length > 0 || Object.values(geocoding.errors).length > 0 || Object.values(routing.errors).length > 0) ? (
            <div className="rounded-[24px] border border-dashed border-border/70 bg-background/70 p-4">
              <p className="text-sm font-semibold text-foreground">מה עדיין חסר למפה מלאה</p>
              {geocoding.unresolvedNames.length > 0 ? (
                <p className="mt-2 text-xs leading-6 text-muted-foreground">
                  מנסים לפתור: {geocoding.unresolvedNames.join(", ")}.
                </p>
              ) : null}
              {Object.values(geocoding.errors).length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs leading-6 text-muted-foreground">
                  {Object.values(geocoding.errors).map((error, index) => (
                    <li key={`summary-geo-${index}`}>{error}</li>
                  ))}
                </ul>
              ) : null}
              {Object.values(routing.errors).length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs leading-6 text-muted-foreground">
                  {Object.values(routing.errors).map((error, index) => (
                    <li key={`summary-route-${index}`}>{error}</li>
                  ))}
                </ul>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                onClick={() => {
                  geocoding.retry();
                  routing.retry();
                }}
              >
                <RotateCcw className="size-4" />
                נסה שוב
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
