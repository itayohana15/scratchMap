"use client";

import {
  Building2,
  Cake,
  Fuel,
  Landmark,
  MapPinned,
  ParkingSquare,
  ShoppingCart,
  Soup,
  ToiletIcon,
  UtensilsCrossed,
} from "lucide-react";
import type { ComponentType } from "react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import type { NearbyPlaceResult } from "@/lib/places/country-places";
import type { NearbyCategory } from "@/lib/places/overpass";
import { buildMapLink } from "@/lib/trip-workspace";

const CATEGORY_ICONS: Record<NearbyCategory, ComponentType<{ className?: string }>> = {
  restaurant: UtensilsCrossed,
  cafe: Soup,
  dessert: Cake,
  hotel: Building2,
  fuel: Fuel,
  supermarket: ShoppingCart,
  parking: ParkingSquare,
  restroom: ToiletIcon,
  attraction: Landmark,
};

const CATEGORY_LABELS: Record<NearbyCategory, string> = {
  restaurant: "מסעדות",
  cafe: "בתי קפה",
  dessert: "קינוחים",
  hotel: "מלונות",
  fuel: "תחנות דלק",
  supermarket: "סופרמרקטים",
  parking: "חניה",
  restroom: "שירותים",
  attraction: "אטרקציות נוספות",
};

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} ק"מ` : `${meters} מ'`;
}

interface NearbySectionProps {
  places: NearbyPlaceResult[] | undefined;
  isLoading: boolean;
}

export function NearbySection({ places, isLoading }: NearbySectionProps) {
  if (!isLoading && (!places || places.length === 0)) return null;

  const grouped = new Map<NearbyCategory, NearbyPlaceResult[]>();
  for (const place of places ?? []) {
    const bucket = grouped.get(place.category) ?? [];
    bucket.push(place);
    grouped.set(place.category, bucket);
  }

  return (
    <ModalSection title="בסביבה" icon={MapPinned}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">מחפש מקומות בסביבה...</p>
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([category, categoryPlaces]) => {
            const Icon = CATEGORY_ICONS[category];
            return (
              <div key={category} className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  <Icon className="size-3.5" />
                  {CATEGORY_LABELS[category]}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {categoryPlaces.map((place) => (
                    <a
                      key={`${place.name}-${place.lat}-${place.lon}`}
                      href={buildMapLink(place.name, place.lat, place.lon)}
                      target="_blank"
                      rel="noreferrer"
                      className="animate-in fade-in flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card/60 p-3 text-sm transition-colors duration-300 hover:bg-card"
                    >
                      <span className="truncate font-medium">{place.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDistance(place.distanceMeters)}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ModalSection>
  );
}
