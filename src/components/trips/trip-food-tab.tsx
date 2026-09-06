"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, RotateCcw, Utensils, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { useFoodRecommendations } from "@/lib/hooks/use-food-recommendations";
import { insertFoodItemIntoDay, removeFoodItemFromDay } from "@/lib/food-ui-helpers";
import type { FoodMealSlot, RankedFoodPlace } from "@/lib/food";
import type { TripItineraryDay } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

const MEAL_SLOTS: { slot: FoodMealSlot; label: string }[] = [
  { slot: "breakfast", label: "בוקר" },
  { slot: "lunch", label: "צהריים" },
  { slot: "dinner", label: "ערב" },
];

/** Real per-day route anchor (spec §W: relevance is route-aware, never "same city alone") — the centroid of that day's own real-coordinate items, same pattern buildStayBlocks uses for hotels. */
function dayRouteAnchor(day: TripItineraryDay): { lat: number; lon: number } | null {
  const coords = day.items.filter((item) => item.lat != null && item.lon != null) as Array<{ lat: number; lon: number }>;
  if (coords.length === 0) return null;
  return {
    lat: coords.reduce((sum, c) => sum + c.lat, 0) / coords.length,
    lon: coords.reduce((sum, c) => sum + c.lon, 0) / coords.length,
  };
}

function FoodRowSkeleton() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
      <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

function MealSlotPicker({
  day,
  isoA2,
  slot,
  label,
  routeAnchor,
  onPatchDay,
  isFocused,
  registerRef,
}: {
  day: TripItineraryDay;
  isoA2: string;
  slot: FoodMealSlot;
  label: string;
  routeAnchor: { lat: number; lon: number } | null;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  isFocused: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const [conflictWarning, setConflictWarning] = useState(false);
  const dayPart = slot === "breakfast" ? "morning" : slot === "dinner" ? "dinner" : "lunch";
  const selected = day.items.find((item) => item.slot === dayPart && item.recommendationId?.startsWith("osm:"));

  const { data, isLoading, isError, refetch, isRefetching } = useFoodRecommendations({
    iso: isoA2,
    lat: routeAnchor?.lat ?? null,
    lon: routeAnchor?.lon ?? null,
    slot,
  });

  function handleSelect(place: RankedFoodPlace) {
    onPatchDay(day.id, (current) => {
      const { day: updated, timelineConflict } = insertFoodItemIntoDay(current, place, slot);
      setConflictWarning(timelineConflict);
      return updated;
    });
  }

  function handleRemove() {
    if (!selected) return;
    setConflictWarning(false);
    onPatchDay(day.id, (current) => removeFoodItemFromDay(current, selected.id));
  }

  return (
    <div
      ref={registerRef}
      className={cn(
        "space-y-1.5 rounded-lg border p-2.5 transition-colors",
        isFocused ? "border-primary ring-2 ring-primary/30" : "border-border/60"
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>

      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 p-2 text-sm">
          <div className="flex min-w-0 items-center gap-1.5">
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate font-medium">{selected.name}</span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={handleRemove}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {conflictWarning ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          שים לב: יש חפיפה בלוח הזמנים של היום מול הפעילות הזו.
        </p>
      ) : null}

      {!routeAnchor ? (
        <p className="text-xs text-muted-foreground">
          עדיין אין ביום הזה פעילויות עם מיקום ידוע כדי להציע מסעדות אמיתיות בקרבתן.
        </p>
      ) : isLoading ? (
        <div className="space-y-1.5">
          <FoodRowSkeleton />
          <FoodRowSkeleton />
        </div>
      ) : isError ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-sm">
          <span className="text-destructive">לא הצלחנו לטעון מסעדות באזור הזה</span>
          <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => void refetch()} disabled={isRefetching}>
            <RotateCcw className="size-3.5" />
            נסה שוב
          </Button>
        </div>
      ) : !data || data.places.length === 0 ? (
        <p className="text-xs text-muted-foreground">לא נמצאו מסעדות אמיתיות בקרבת המסלול של היום הזה.</p>
      ) : (
        <div className="space-y-1.5">
          {data.places
            .filter((place) => place.name !== selected?.name)
            .slice(0, 5)
            .map((place) => (
              <div key={`${place.name}-${place.lat}-${place.lon}`} className="flex items-center gap-2 rounded-lg border border-border/60 p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{place.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {place.travelMinutesFromRoute != null ? `כ-${Math.round(place.travelMinutesFromRoute)} דק' מהמסלול` : "מרחק לא ידוע"}
                    {" · מחיר ודירוג לא זמינים"}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => handleSelect(place)}>
                  הוסף למסלול
                </Button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Real, route-aware, day-by-day food recommendations (browser QA Parts
 * T-W) — a dedicated tab rather than folded into the itinerary, mirroring
 * the accommodation tab's own per-block picker pattern. Never fabricates
 * price/rating (same honest-data-source contract as hotels.ts).
 */
export function TripFoodTab({
  days,
  isoA2,
  onPatchDay,
  focusDayId,
  focusSlot,
  focusToken,
}: {
  days: TripItineraryDay[];
  isoA2: string;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  /** Section "FOOD TAB FILTERING" — set when the user clicked a meal opportunity in the itinerary; scrolls to and highlights that exact day/slot. */
  focusDayId?: string | null;
  focusSlot?: FoodMealSlot | null;
  /** Changes on every click, even to the same day/slot, so the scroll/highlight re-fires even when it's already focused there. */
  focusToken?: number | null;
}) {
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focusToken || !focusRef.current) return;
    focusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusToken]);

  if (days.length === 0) {
    return <p className="section-card p-4 text-sm text-muted-foreground">עדיין אין ימים במסלול הזה.</p>;
  }

  return (
    <div className="space-y-3">
      {days.map((day) => {
        const routeAnchor = dayRouteAnchor(day);
        return (
          <div key={day.id} className="section-card space-y-2.5 p-4">
            <div className="flex items-center gap-2.5">
              <Utensils className="size-4 shrink-0 text-primary" />
              <div>
                <h4 className="font-semibold text-foreground">
                  יום {day.dayNumber}
                  {day.title ? ` · ${day.title}` : ""}
                </h4>
                <p className="text-xs text-muted-foreground">
                  {day.date ? formatDate(day.date, "d בMMM") : ""}
                  {day.cityRegion ? ` · ${day.cityRegion}` : ""}
                </p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {MEAL_SLOTS.map(({ slot, label }) => {
                const isFocused = focusDayId === day.id && focusSlot === slot;
                return (
                  <MealSlotPicker
                    key={slot}
                    day={day}
                    isoA2={isoA2}
                    slot={slot}
                    label={label}
                    routeAnchor={routeAnchor}
                    onPatchDay={onPatchDay}
                    isFocused={isFocused}
                    registerRef={(el) => {
                      if (isFocused) focusRef.current = el;
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
