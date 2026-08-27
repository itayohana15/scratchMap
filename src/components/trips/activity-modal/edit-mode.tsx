"use client";

import { Pencil } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { TripItineraryDay, TripItineraryItem } from "@/lib/trip-workspace";

interface ActivityEditModeProps {
  item: TripItineraryItem;
  day: TripItineraryDay;
  otherDays: TripItineraryDay[];
  onUpdate: (patch: Partial<TripItineraryItem>) => void;
  onMoveToDay: (toDayId: string) => void;
}

/**
 * Collapsed by default, separate from the read view (spec item 24) — the
 * same <details> pattern already used for the wizard's manual
 * arrival-time override (step-flights.tsx). Writes go through the same
 * onPatchItem/onMoveToDay the rest of the modal already uses — no parallel
 * save mechanism.
 */
export function ActivityEditMode({ item, day, otherDays, onUpdate, onMoveToDay }: ActivityEditModeProps) {
  return (
    <details className="rounded-2xl border border-border/60 p-3.5">
      <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
        <Pencil className="size-3.5" />
        עריכת פעילות
      </summary>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">שעה מתוכננת</label>
          <Input
            type="time"
            value={item.plannedStartTime}
            onChange={(event) => onUpdate({ plannedStartTime: event.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">משך (דקות)</label>
          <Input
            type="number"
            min={0}
            value={item.estimatedDurationMinutes ?? ""}
            onChange={(event) =>
              onUpdate({ estimatedDurationMinutes: event.target.value ? Number(event.target.value) : null })
            }
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">עלות משוערת (₪)</label>
          <Input
            type="number"
            min={0}
            value={item.approximatePrice ?? ""}
            onChange={(event) => onUpdate({ approximatePrice: event.target.value ? Number(event.target.value) : null })}
          />
        </div>

        {otherDays.length > 0 ? (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">יום</label>
            <Select value={day.id} onValueChange={(value) => value && value !== day.id && onMoveToDay(value)}>
              <SelectTrigger>
                <span>
                  יום {day.dayNumber}
                  {day.title ? ` — ${day.title}` : ""}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={day.id}>
                  יום {day.dayNumber}
                  {day.title ? ` — ${day.title}` : ""}
                </SelectItem>
                {otherDays.map((otherDay) => (
                  <SelectItem key={otherDay.id} value={otherDay.id}>
                    יום {otherDay.dayNumber}
                    {otherDay.title ? ` — ${otherDay.title}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </details>
  );
}
