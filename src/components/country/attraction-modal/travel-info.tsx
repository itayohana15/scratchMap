"use client";

import { Route } from "lucide-react";

import { ModalSection, UnavailableRow } from "@/components/country/attraction-modal/shared";
import type { DrivingRoute } from "@/lib/routing/osrm";
import type { TripItineraryItem } from "@/lib/trip-workspace";

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} ק"מ` : `${Math.round(meters)} מ'`;
}

function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} שעות ${minutes % 60} דק'` : `${minutes} דק'`;
}

interface TravelInfoSectionProps {
  previousItem: TripItineraryItem | null;
  drivingRoute: DrivingRoute | null | undefined;
  drivingRouteLoading: boolean;
}

// Everything here comes from a real routing call (OSRM) or is explicitly
// marked unavailable — we never estimate walking/transit time, taxi fare,
// or fuel cost without a real source for them.
export function TravelInfoSection({
  previousItem,
  drivingRoute,
  drivingRouteLoading,
}: TravelInfoSectionProps) {
  if (!previousItem) return null;

  const distanceValue = drivingRouteLoading
    ? "טוען..."
    : drivingRoute
      ? formatDistance(drivingRoute.distanceMeters)
      : null;
  const durationValue = drivingRouteLoading
    ? "טוען..."
    : drivingRoute
      ? formatDuration(drivingRoute.durationSeconds)
      : null;

  return (
    <ModalSection title="מידע נסיעה מהעצירה הקודמת" icon={Route}>
      <p className="text-xs text-muted-foreground">
        מ&quot;{previousItem.name}&quot; אל האטרקציה הזו.
      </p>
      <div className="divide-y divide-border/40">
        <UnavailableRow label="מרחק נסיעה" value={distanceValue} />
        <UnavailableRow label="זמן נסיעה משוער ברכב" value={durationValue} />
        <UnavailableRow label="זמן הליכה משוער" value={null} />
        <UnavailableRow label="זמן תחבורה ציבורית משוער" value={null} />
        <UnavailableRow label="עלות מונית משוערת" value={null} />
        <UnavailableRow label="עלות דלק משוערת" value={null} />
        <UnavailableRow label="מרחק הליכה מהחניה" value={null} />
      </div>
    </ModalSection>
  );
}
