"use client";

import { ArrowDown, Footprints, MapPin, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { ItineraryDayRouteSection } from "@/components/country/itinerary-route-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatDate } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  DAY_PART_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}:${String(rest).padStart(2, "0")} שעות` : `${hours} שעות`;
}

function TransportConnector({ item }: { item: TripItineraryItem }) {
  if (!item.travelMinutes && !item.transportation) return null;
  return (
    <div className="flex items-center gap-2 py-1 pr-6 text-xs text-muted-foreground">
      <ArrowDown className="size-3.5 shrink-0" />
      <Footprints className="size-3.5 shrink-0" />
      <span>
        {item.transportation || "הליכה"}
        {item.travelMinutes ? ` · ${formatMinutes(item.travelMinutes)}` : ""}
      </span>
    </div>
  );
}

function ActivityCard({
  item,
  onFocus,
}: {
  item: TripItineraryItem;
  onFocus: (itemId: string) => void;
}) {
  const bookingLabel = item.reservationRequired
    ? item.bookingCompleted
      ? "הוזמן"
      : "דרושה הזמנה"
    : null;

  return (
    <button
      type="button"
      onClick={() => onFocus(item.id)}
      className="section-card w-full space-y-1.5 p-4 text-right transition-shadow hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tabular-nums text-primary">
            {item.plannedStartTime || DAY_PART_LABELS[item.slot]}
          </p>
          <h4 className="truncate text-base font-semibold text-foreground">{item.name}</h4>
        </div>
        {bookingLabel ? (
          <Badge variant={item.bookingCompleted ? "secondary" : "outline"} className="shrink-0">
            {bookingLabel}
          </Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {RECOMMENDATION_CATEGORY_LABELS[item.category]}
        {item.location ? ` · ${item.location}` : ""}
      </p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {item.estimatedDurationMinutes ? <span>משך: {formatMinutes(item.estimatedDurationMinutes)}</span> : null}
        <span>עלות: {item.approximatePrice ? formatCurrency(item.approximatePrice) : "חינם"}</span>
      </div>

      {item.plannedNotes ? <p className="text-xs text-muted-foreground">{item.plannedNotes}</p> : null}
    </button>
  );
}

function DayAiActionsMenu({
  onImproveDay,
  onFindAlternative,
  isRegenerating,
}: {
  onImproveDay: () => void;
  onFindAlternative?: () => void;
  isRegenerating: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={isRegenerating} />}>
        <Sparkles className="size-4" />
        פעולות AI
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onImproveDay}>שפר את היום</DropdownMenuItem>
        {onFindAlternative ? (
          <DropdownMenuItem onClick={onFindAlternative}>מצא חלופה לפעילות נבחרת</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface TripItineraryTabProps {
  itinerary: CountryItineraryRecord;
  countryName: string;
  selectedDayId: string;
  onSelectDay: (dayId: string) => void;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
  onRegenerateDay: (dayId: string) => void;
  isRegenerating: boolean;
}

export function TripItineraryTab({
  itinerary,
  countryName,
  selectedDayId,
  onSelectDay,
  onPatchDay,
  onPatchItem,
  onRegenerateDay,
  isRegenerating,
}: TripItineraryTabProps) {
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const days = itinerary.itineraryDays;
  const selectedDay = days.find((day) => day.id === selectedDayId) ?? days[0] ?? null;

  const sortedItems = useMemo(() => {
    if (!selectedDay) return [];
    return [...selectedDay.items].sort((a, b) => a.plannedStartTime.localeCompare(b.plannedStartTime));
  }, [selectedDay]);

  return (
    <div className="space-y-4">
      <div
        className="flex gap-1.5 overflow-x-auto pb-1"
        role="tablist"
        aria-label="ימי המסלול"
      >
        {days.map((day) => (
          <button
            key={day.id}
            type="button"
            role="tab"
            aria-selected={selectedDay?.id === day.id}
            onClick={() => onSelectDay(day.id)}
            className={cn(
              "flex shrink-0 flex-col items-center gap-0.5 rounded-2xl border px-4 py-2.5 text-center transition-colors",
              selectedDay?.id === day.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/70 bg-card text-foreground hover:bg-muted"
            )}
          >
            <span className="text-sm font-semibold">יום {day.dayNumber}</span>
            <span className="text-[11px] opacity-80">
              {day.date ? formatDate(day.date, "d בMMM") : ""}
            </span>
            {day.cityRegion ? <span className="max-w-28 truncate text-[11px] opacity-80">{day.cityRegion}</span> : null}
          </button>
        ))}
      </div>

      {selectedDay ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,60%)_minmax(0,40%)]">
          <div className="space-y-1">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h3 className="font-heading text-lg font-semibold">{selectedDay.title}</h3>
                {selectedDay.cityRegion ? (
                  <p className="flex items-center gap-1 text-sm text-muted-foreground">
                    <MapPin className="size-3.5" />
                    {selectedDay.cityRegion}
                  </p>
                ) : null}
              </div>
              <DayAiActionsMenu
                isRegenerating={isRegenerating}
                onImproveDay={() => onRegenerateDay(selectedDay.id)}
              />
            </div>

            {sortedItems.length === 0 ? (
              <p className="section-card p-4 text-sm text-muted-foreground">
                אין עדיין פעילויות מתוכננות ליום הזה.
              </p>
            ) : (
              sortedItems.map((item, index) => (
                <div key={item.id}>
                  {index > 0 ? <TransportConnector item={item} /> : null}
                  <ActivityCard item={item} onFocus={setFocusItemId} />
                </div>
              ))
            )}
          </div>

          <div className="lg:sticky lg:top-[64px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
            <ItineraryDayRouteSection
              day={selectedDay}
              countryName={countryName}
              isoA2={itinerary.isoA2}
              onPatchDay={onPatchDay}
              onPatchItem={onPatchItem}
              onActiveItemIdsChange={() => {}}
              focusItemId={focusItemId}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
