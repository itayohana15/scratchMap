// Server-safe counterpart to osrm.ts (which is "use client" and exposes
// react-query hooks for the map UI). This module has no client directive so
// it can be imported from server-only itinerary generation code.
//
// Same free, keyless public OSRM demo server — car-routing profile only.
const OSRM_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";

export interface RoutePoint {
  lat: number;
  lon: number;
}

export interface DrivingRoute {
  distanceMeters: number;
  durationSeconds: number;
}

interface OsrmResponse {
  code: string;
  routes?: {
    distance: number;
    duration: number;
  }[];
}

/**
 * Best-effort real driving time between two points. Never throws — returns
 * null on any failure (timeout, non-200, network error, malformed data) so
 * callers can safely fall back to the heuristic estimate.
 */
export async function fetchDrivingRouteBestEffort(
  from: RoutePoint,
  to: RoutePoint,
  timeoutMs = 4000
): Promise<DrivingRoute | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${OSRM_ENDPOINT}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const data = (await res.json()) as OsrmResponse;
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route) return null;

    return { distanceMeters: route.distance, durationSeconds: route.duration };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
