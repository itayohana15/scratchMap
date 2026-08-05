"use client";

import { useMemo } from "react";

import { useNearbyPlaces } from "@/lib/places/country-places";
import { useDrivingRoute } from "@/lib/routing/osrm";
import {
  findItineraryPlacement,
  type CountryTripWorkspaceState,
  type TripRecommendation,
} from "@/lib/trip-workspace";
import { useWikipediaSummary } from "@/lib/wikipedia/summary";

export function useAttractionModalData(
  recommendation: TripRecommendation | null,
  workspace: CountryTripWorkspaceState
) {
  const placement = useMemo(
    () => (recommendation ? findItineraryPlacement(workspace, recommendation) : null),
    [recommendation, workspace]
  );

  const previousItem = useMemo(() => {
    if (!placement || placement.itemIndex === 0) return null;
    return placement.day.items[placement.itemIndex - 1];
  }, [placement]);

  const wikipedia = useWikipediaSummary(recommendation?.wikipediaUrl);
  const nearby = useNearbyPlaces(recommendation?.lat, recommendation?.lon);

  const drivingRoute = useDrivingRoute(
    previousItem?.lat != null && previousItem?.lon != null
      ? { lat: previousItem.lat, lon: previousItem.lon }
      : null,
    recommendation?.lat != null && recommendation?.lon != null
      ? { lat: recommendation.lat, lon: recommendation.lon }
      : null
  );

  return { placement, previousItem, wikipedia, nearby, drivingRoute };
}
