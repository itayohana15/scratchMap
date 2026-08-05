"use client";

import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useRef } from "react";

import { statusColor } from "@/components/map/status-colors";
import { loadMaplibreGl } from "@/lib/map/load-maplibre";
import type { Tables } from "@/lib/supabase/types";

interface CityMarkersProps {
  map: MapLibreMap | null;
  cities: Tables<"cities">[];
  isDark: boolean;
  onCityClick: (city: Tables<"cities">) => void;
}

export function CityMarkers({ map, cities, isDark, onCityClick }: CityMarkersProps) {
  const markersRef = useRef<Marker[]>([]);
  const onCityClickRef = useRef(onCityClick);
  onCityClickRef.current = onCityClick;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled) return;

      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];

      const geolocated = cities.filter((city) => city.latitude != null && city.longitude != null);

      geolocated.forEach((city, index) => {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("aria-label", city.name);
        el.className =
          "size-4 rounded-full border-2 border-white shadow-lg shadow-black/30 dark:border-neutral-900";
        el.style.backgroundColor = statusColor(city.status, isDark);
        el.style.cursor = "pointer";
        el.style.animation = `city-marker-pop 0.35s ease-out ${index * 40}ms backwards`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onCityClickRef.current(city);
        });

        const marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([city.longitude!, city.latitude!])
          .addTo(map);

        markersRef.current.push(marker);
      });
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [map, cities, isDark]);

  return null;
}
