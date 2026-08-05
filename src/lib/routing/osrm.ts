"use client";

import { useQuery } from "@tanstack/react-query";

// Free, keyless public OSRM demo server. It only serves a driving (car)
// profile — the /foot/ and /bike/ endpoints on this particular public
// instance silently fall back to car routing weights, so we never call them
// and never label a number as "walking time" unless we actually have one.
const OSRM_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";

export interface DrivingRoute {
  distanceMeters: number;
  durationSeconds: number;
}

export interface RoutePoint {
  lat: number;
  lon: number;
}

interface OsrmResponse {
  code: string;
  routes?: { distance: number; duration: number }[];
}

async function fetchDrivingRoute(from: RoutePoint, to: RoutePoint): Promise<DrivingRoute | null> {
  const url = `${OSRM_ENDPOINT}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as OsrmResponse;
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route) return null;

  return { distanceMeters: route.distance, durationSeconds: route.duration };
}

export function useDrivingRoute(from: RoutePoint | null, to: RoutePoint | null) {
  return useQuery({
    queryKey: [
      "osrm-driving-route",
      from ? `${from.lat.toFixed(4)},${from.lon.toFixed(4)}` : "",
      to ? `${to.lat.toFixed(4)},${to.lon.toFixed(4)}` : "",
    ],
    enabled: from != null && to != null,
    queryFn: () => fetchDrivingRoute(from!, to!),
    staleTime: 1000 * 60 * 60,
    retry: false,
  });
}
