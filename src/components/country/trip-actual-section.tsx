"use client";

import { Heart, MapPinOff, Sparkles } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { formatCurrency, formatDate } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { parseTimeToMinutes } from "@/lib/live-trip-planner";
import { actualDayItems, computeDayComparison, expenseCategoryComparison, plannedDayItems } from "@/lib/trip-actual";
import type { TripItineraryDay, TripItineraryItem } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface TripActualSectionProps {
  draft: CountryItineraryRecord;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
}

type ViewMode = "planned" | "actual" | "compare";

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  planned: "מתוכנן",
  actual: "בפועל",
  compare: "השוואה",
};

function notEntered(hasData: boolean, formatted: string) {
  return hasData ? formatted : "לא הוזן";
}

function FavoriteToggle({ item, onToggle }: { item: TripItineraryItem; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={item.favorite ? "הסרה מהמועדפים" : "הוספה למועדפים"}
      className="shrink-0"
    >
      <Heart className={cn("size-4", item.favorite ? "fill-destructive text-destructive" : "text-muted-foreground/50")} />
    </button>
  );
}

function ItemRow({
  item,
  detail,
  onToggleFavorite,
}: {
  item: TripItineraryItem;
  detail: string;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.name || "פעילות ללא שם"}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {item.spontaneous ? (
        <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]">
          <Sparkles className="size-3" />
          נוסף במהלך הטיול
        </Badge>
      ) : null}
      <FavoriteToggle item={item} onToggle={onToggleFavorite} />
    </div>
  );
}

function diffLabel(day: TripItineraryDay, item: TripItineraryItem): string {
  if (item.skipped) return "דולג";
  if (!item.completed) return "טרם בוצע";
  const planned = parseTimeToMinutes(item.plannedStartTime);
  const actual = parseTimeToMinutes(item.actualStartTime);
  if (planned == null || actual == null) return item.actualPlaceName ? `בפועל: ${item.actualPlaceName}` : "בוצע";
  const diff = actual - planned;
  if (diff === 0) return "בזמן";
  return `${diff > 0 ? "+" : ""}${diff} דק'`;
}

function DayCard({
  day,
  onPatchDay,
  onPatchItem,
}: {
  day: TripItineraryDay;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("planned");
  const [detailedRating, setDetailedRating] = useState(false);
  const comparison = computeDayComparison(day);
  const planned = plannedDayItems(day);
  const actual = actualDayItems(day);
  const spontaneousOnly = actual.filter((item) => item.spontaneous && !planned.some((p) => p.id === item.id));

  function toggleFavorite(item: TripItineraryItem) {
    onPatchItem(day.id, item.id, (current) => ({ ...current, favorite: !current.favorite }));
  }

  return (
    <div className="section-card space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="font-medium text-foreground">
            יום {day.dayNumber}
            {day.date ? ` · ${formatDate(day.date)}` : ""}
          </h4>
          {day.cityRegion ? <p className="text-xs text-muted-foreground">{day.cityRegion}</p> : null}
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border/60 bg-background/60 p-1">
          {(["planned", "actual", "compare"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                mode === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/60"
              )}
            >
              {VIEW_MODE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      {mode === "planned" ? (
        planned.length === 0 ? (
          <p className="text-sm text-muted-foreground">אין פעילויות מתוכננות ליום הזה.</p>
        ) : (
          <div className="space-y-1.5">
            {planned.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                detail={[item.plannedStartTime, item.location].filter(Boolean).join(" · ")}
                onToggleFavorite={() => toggleFavorite(item)}
              />
            ))}
          </div>
        )
      ) : mode === "actual" ? (
        actual.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPinOff className="size-4" />
            לא תועד מה קרה ביום הזה בפועל.
          </p>
        ) : (
          <div className="space-y-1.5">
            {actual.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                detail={[
                  item.actualStartTime || item.plannedStartTime,
                  item.actualPlaceName || item.location,
                  item.actualTransportation || null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onToggleFavorite={() => toggleFavorite(item)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-border/60 bg-background/60 p-2 text-center">
              <p className="text-[11px] text-muted-foreground">בוצעו</p>
              <p className="text-sm font-semibold">
                {comparison.activitiesCompleted}/{comparison.activitiesPlanned}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/60 p-2 text-center">
              <p className="text-[11px] text-muted-foreground">דולגו</p>
              <p className="text-sm font-semibold">{comparison.activitiesSkipped}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/60 p-2 text-center">
              <p className="text-[11px] text-muted-foreground">ספונטני</p>
              <p className="text-sm font-semibold">{comparison.spontaneousActivities}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-background/60 p-2 text-center">
              <p className="text-[11px] text-muted-foreground">עלות</p>
              <p className="text-sm font-semibold">
                {formatCurrency(comparison.plannedCost)} → {notEntered(comparison.actualCost.hasData, formatCurrency(comparison.actualCost.value))}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            {planned.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-xl border px-3 py-2",
                  item.skipped ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-background/60"
                )}
              >
                <p className="min-w-0 truncate text-sm text-foreground">{item.name || "פעילות ללא שם"}</p>
                <Badge variant={item.skipped ? "destructive" : "outline"} className="shrink-0 text-[11px]">
                  {diffLabel(day, item)}
                </Badge>
              </div>
            ))}
            {spontaneousOnly.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2"
              >
                <p className="min-w-0 truncate text-sm text-foreground">{item.name || "פעילות ללא שם"}</p>
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  נוסף: {item.actualStartTime || "—"}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode !== "planned" ? (
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <label className="text-xs font-medium text-muted-foreground">לינה בפועל (אם שונתה)</label>
          <Input
            value={day.actualAccommodation}
            onChange={(event) =>
              onPatchDay(day.id, (current) => ({ ...current, actualAccommodation: event.target.value }))
            }
            placeholder={day.accommodation || "לא הוזן"}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-3">
        <label className="text-xs font-medium text-muted-foreground">דירוג היום</label>
        <Select
          value={day.dayRating?.toString() ?? ""}
          onValueChange={(value) =>
            onPatchDay(day.id, (current) => ({ ...current, dayRating: value ? Number(value) : null }))
          }
        >
          <SelectTrigger size="sm" className="w-20">
            <span>{day.dayRating ?? "—"}</span>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
              <SelectItem key={n} value={n.toString()}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setDetailedRating((value) => !value)}>
          דירוג מפורט
        </Button>
      </div>

      {detailedRating ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["activities", "food", "pace", "weather"] as const).map((category) => (
            <div key={category} className="space-y-1">
              <label className="text-[11px] text-muted-foreground">
                {category === "activities" ? "פעילויות" : category === "food" ? "אוכל" : category === "pace" ? "קצב" : "מזג אוויר"}
              </label>
              <Select
                value={day.dayRatingCategories[category]?.toString() ?? ""}
                onValueChange={(value) =>
                  onPatchDay(day.id, (current) => ({
                    ...current,
                    dayRatingCategories: { ...current.dayRatingCategories, [category]: value ? Number(value) : undefined },
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <span>{day.dayRatingCategories[category] ?? "—"}</span>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
                    <SelectItem key={n} value={n.toString()}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TripActualSection({ draft, onPatchDay, onPatchItem }: TripActualSectionProps) {
  const expenseRows = expenseCategoryComparison(draft);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-heading text-lg font-semibold text-foreground">בפועל</h3>
        <p className="text-sm text-muted-foreground">
          מה תוכנן מול מה שבאמת קרה — יום אחרי יום, בלי לאבד אף גרסה.
        </p>
      </div>

      {draft.itineraryDays.length === 0 ? (
        <div className="section-card p-6 text-center text-sm text-muted-foreground">
          אין ימי מסלול מתועדים לטיול הזה עדיין. אפשר להוסיף אותם בלשונית &quot;מסלול&quot;.
        </div>
      ) : (
        <>
          {expenseRows.length > 0 ? (
            <div className="section-card space-y-2 p-4">
              <h4 className="font-medium text-foreground">הוצאות לפי קטגוריה</h4>
              <div className="space-y-1.5">
                {expenseRows.map((row) => (
                  <div key={row.category} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-foreground/80">{row.label}</span>
                    <span className="text-muted-foreground">
                      {formatCurrency(row.planned)} → {notEntered(row.actual.hasData, formatCurrency(row.actual.value))}
                      {row.difference != null ? (
                        <span className={cn("mr-2", row.difference > 0 ? "text-destructive" : "text-primary")}>
                          ({row.difference > 0 ? "+" : ""}
                          {formatCurrency(row.difference)})
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {draft.itineraryDays.map((day) => (
              <DayCard key={day.id} day={day} onPatchDay={onPatchDay} onPatchItem={onPatchItem} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
