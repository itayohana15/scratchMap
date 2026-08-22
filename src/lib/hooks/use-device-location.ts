"use client";

import { useEffect, useState } from "react";

export interface DeviceLocation {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
}

export type DeviceLocationStatus = "idle" | "requesting" | "granted" | "denied" | "unavailable";

/**
 * Device location only after the normal browser permission prompt (spec
 * §21) — never required for Live Mode to function; callers must fall back
 * to the last itinerary location when this stays null. `enabled` gates the
 * request so Live Mode doesn't prompt for location on every page load,
 * only when the Today screen is actually open.
 */
export function useDeviceLocation(enabled: boolean) {
  const [location, setLocation] = useState<DeviceLocation | null>(null);
  const [status, setStatus] = useState<DeviceLocationStatus>("idle");

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unavailable");
      return;
    }

    setStatus("requesting");
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setStatus("granted");
        setLocation({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyMeters: position.coords.accuracy ?? null,
        });
      },
      () => {
        setStatus("denied");
        setLocation(null);
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [enabled]);

  return { location, status };
}
