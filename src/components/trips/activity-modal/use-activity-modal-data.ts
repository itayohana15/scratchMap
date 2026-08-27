"use client";

import { useNearbyPlaces } from "@/lib/places/country-places";
import { useDrivingRoute } from "@/lib/routing/osrm";
import type { TripItineraryItem } from "@/lib/trip-workspace";

/**
 * Mirrors the country page's use-attraction-modal-data.ts, but for a
 * TripItineraryItem that's already placed in the trip (no "find its
 * placement" step needed — the caller already knows the day/previous item).
 * Both network calls only fire while the modal is open (gated by `enabled`)
 * and are cached by React Query, so reopening the same activity is instant.
 */
export function useActivityModalData(
  item: TripItineraryItem | null,
  previousItem: TripItineraryItem | null,
  enabled: boolean
) {
  const nearby = useNearbyPlaces(enabled ? item?.lat : undefined, enabled ? item?.lon : undefined);

  const drivingRoute = useDrivingRoute(
    enabled && previousItem?.lat != null && previousItem?.lon != null
      ? { lat: previousItem.lat, lon: previousItem.lon }
      : null,
    enabled && item?.lat != null && item?.lon != null ? { lat: item.lat, lon: item.lon } : null
  );

  return { nearby, drivingRoute };
}
