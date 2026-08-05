"use client";

import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useRef } from "react";

import { loadMaplibreGl } from "@/lib/map/load-maplibre";

export interface MapPlace {
  id: string;
  label: string;
  lat: number;
  lon: number;
  // English-ish search term for the photo lookup (Pexels searches poorly
  // on Hebrew text) — falls back to `label` when not provided.
  photoQuery?: string;
}

interface PlaceMarkersProps {
  map: MapLibreMap | null;
  places: MapPlace[];
  color: string;
  onAdd: (place: MapPlace) => void;
}

const STAR_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="white"><path d="M12 2l2.9 6.9 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7-5.4-4.7 7.1-.6z"/></svg>';

interface PlacePhotoResponse {
  photoUrl: string | null;
}

// Deduped across marker rebuilds (theme toggles, list updates, etc.) so
// re-opening a popup never re-fetches a photo it already has.
const photoCache = new Map<string, Promise<PlacePhotoResponse>>();

function fetchPlacePhoto(query: string): Promise<PlacePhotoResponse> {
  let pending = photoCache.get(query);
  if (!pending) {
    pending = fetch(`/api/places/photo?q=${encodeURIComponent(query)}`).then((res) =>
      res.ok ? (res.json() as Promise<PlacePhotoResponse>) : { photoUrl: null }
    );
    photoCache.set(query, pending);
  }
  return pending;
}

export function PlaceMarkers({ map, places, color, onAdd }: PlaceMarkersProps) {
  const markersRef = useRef<Marker[]>([]);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    loadMaplibreGl().then((maplibregl) => {
      if (cancelled) return;

      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];

      places.forEach((place) => {
        const el = document.createElement("button");
        el.type = "button";
        el.setAttribute("aria-label", place.label);
        el.className =
          "flex size-6 items-center justify-center rounded-full border-2 border-white shadow-lg shadow-black/30 dark:border-neutral-900";
        el.style.backgroundColor = color;
        el.style.cursor = "pointer";
        el.innerHTML = STAR_SVG;
        // No stopPropagation here — MapLibre's own popup-toggle (wired via
        // `.setPopup()`) listens on the map's click event and checks
        // whether the click target was this marker element, so the click
        // must be allowed to bubble up to the map for the popup to open.

        const popupNode = document.createElement("div");
        popupNode.className = "w-44 space-y-2 p-1 text-sm";

        const photoBox = document.createElement("div");
        photoBox.className = "h-24 w-full animate-pulse rounded-md bg-muted";
        popupNode.appendChild(photoBox);

        const title = document.createElement("p");
        title.className = "font-medium text-foreground";
        title.textContent = place.label;
        popupNode.appendChild(title);

        const addButton = document.createElement("button");
        addButton.type = "button";
        addButton.className =
          "w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90";
        addButton.textContent = "הוספה כעיר";
        addButton.addEventListener("click", () => onAddRef.current(place));
        popupNode.appendChild(addButton);

        const popup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: "220px" }).setDOMContent(
          popupNode
        );

        let photoRequested = false;
        popup.on("open", () => {
          if (photoRequested) return;
          photoRequested = true;
          fetchPlacePhoto(place.photoQuery ?? place.label).then(({ photoUrl }) => {
            if (!photoUrl) {
              photoBox.remove();
              return;
            }
            const img = document.createElement("img");
            img.src = photoUrl;
            img.alt = "";
            img.className = "h-24 w-full rounded-md object-cover";
            photoBox.replaceWith(img);
          });
        });

        const marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([place.lon, place.lat])
          .setPopup(popup)
          .addTo(map);

        markersRef.current.push(marker);
      });
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [map, places, color]);

  return null;
}
