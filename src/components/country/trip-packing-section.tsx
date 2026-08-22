"use client";

import { Luggage, Minus, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { createUserPackingItem, generatePackingList, mergeGeneratedPacking, packingList, packingProgress } from "@/lib/packing";
import { useCountryWeather } from "@/lib/weather/country-weather";
import { PACKING_CATEGORY_LABELS, type PackingCategory, type PackingItem } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface TripPackingSectionProps {
  draft: CountryItineraryRecord;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
}

const RAIN_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

function upsertPacking(
  onPatchDraft: TripPackingSectionProps["onPatchDraft"],
  items: PackingItem[]
) {
  onPatchDraft((current) => ({
    ...current,
    workspaceSnapshot: { ...current.workspaceSnapshot, packingList: items },
  }));
}

export function TripPackingSection({ draft, onPatchDraft }: TripPackingSectionProps) {
  const items = packingList(draft);
  const progress = packingProgress(items);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newItem, setNewItem] = useState(createUserPackingItem);

  const anchor = useMemo(() => {
    const firstDayWithCoords = draft.itineraryDays.find((day) => day.accommodationLat != null && day.accommodationLon != null);
    if (firstDayWithCoords) return { lat: firstDayWithCoords.accommodationLat!, lon: firstDayWithCoords.accommodationLon! };
    const firstItemWithCoords = draft.itineraryDays.flatMap((day) => day.items).find((item) => item.lat != null && item.lon != null);
    return firstItemWithCoords ? { lat: firstItemWithCoords.lat!, lon: firstItemWithCoords.lon! } : null;
  }, [draft.itineraryDays]);

  const { data: weather } = useCountryWeather(anchor?.lat, anchor?.lon);
  const weatherOptions = useMemo(() => {
    if (!weather || weather.daily.length === 0) return undefined;
    const avgLowC = weather.daily.reduce((sum, day) => sum + day.tempMin, 0) / weather.daily.length;
    const avgHighC = weather.daily.reduce((sum, day) => sum + day.tempMax, 0) / weather.daily.length;
    const rainProbable = weather.daily.some((day) => RAIN_WEATHER_CODES.has(day.weatherCode));
    return { avgLowC, avgHighC, rainProbable };
  }, [weather]);

  function handleRegenerate() {
    const generated = generatePackingList(draft, weatherOptions);
    upsertPacking(onPatchDraft, mergeGeneratedPacking(items, generated));
  }

  function patchItem(id: string, patch: Partial<PackingItem>) {
    upsertPacking(onPatchDraft, items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeItem(id: string) {
    upsertPacking(onPatchDraft, items.filter((item) => item.id !== id));
  }

  function handleAddItem() {
    if (!newItem.name.trim()) return;
    upsertPacking(onPatchDraft, [...items, newItem]);
    setNewItem(createUserPackingItem());
    setShowAddForm(false);
  }

  const byCategory = new Map<PackingCategory, PackingItem[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-lg font-semibold text-foreground">אריזה חכמה</h3>
          <p className="text-sm text-muted-foreground">
            מותאם ליעד, לעונה, למשך הטיול ולפעילויות שבמסלול.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={handleRegenerate} className="gap-1.5">
          <RefreshCcw className="size-4" />
          {items.length === 0 ? "צור רשימת אריזה" : "רענן הצעות אוטומטיות"}
        </Button>
      </div>

      {items.length > 0 ? (
        <div className="section-card space-y-1.5 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Luggage className="size-4" />
              {progress.packed} / {progress.total} ארוזים
            </span>
            <span className="text-muted-foreground">{progress.percent}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      ) : (
        <div className="section-card p-6 text-center text-sm text-muted-foreground">
          עדיין אין רשימת אריזה. אפשר ליצור הצעה אוטומטית מותאמת לטיול הזה.
        </div>
      )}

      {[...byCategory.entries()].map(([category, categoryItems]) => (
        <div key={category} className="section-card space-y-2 p-4">
          <h4 className="font-medium text-foreground">{PACKING_CATEGORY_LABELS[category]}</h4>
          <div className="space-y-1.5">
            {categoryItems.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => patchItem(item.id, { packed: !item.packed })}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md border text-xs transition-colors",
                    item.packed ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
                  )}
                  aria-label={item.packed ? "סמן כלא ארוז" : "סמן כארוז"}
                >
                  {item.packed ? "✓" : ""}
                </button>
                <span className={cn("min-w-0 flex-1 truncate text-sm", item.packed && "text-muted-foreground line-through")}>
                  {item.name}
                </span>
                {item.required ? (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    נדרש
                  </Badge>
                ) : null}
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => patchItem(item.id, { quantity: Math.max(1, item.quantity - 1) })}
                    aria-label="הפחת כמות"
                  >
                    <Minus className="size-3.5" />
                  </Button>
                  <span className="w-5 text-center text-sm">{item.quantity}</span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => patchItem(item.id, { quantity: item.quantity + 1 })}
                    aria-label="הוסף כמות"
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </div>
                {item.source === "automatic" ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => removeItem(item.id)}
                    aria-label="הסתר הצעה"
                    title="הסתר הצעה"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : (
                  <Button size="icon-sm" variant="ghost" onClick={() => removeItem(item.id)} aria-label="הסר פריט">
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {showAddForm ? (
        <div className="section-card grid gap-2 p-4 sm:grid-cols-[1fr_auto_auto]">
          <Input
            value={newItem.name}
            onChange={(event) => setNewItem((current) => ({ ...current, name: event.target.value }))}
            placeholder="שם הפריט"
          />
          <Select
            value={newItem.category}
            onValueChange={(value) => setNewItem((current) => ({ ...current, category: value as PackingCategory }))}
          >
            <SelectTrigger size="sm" className="min-w-36">
              <span>{PACKING_CATEGORY_LABELS[newItem.category]}</span>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PACKING_CATEGORY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleAddItem}>
            הוסף
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setShowAddForm(true)} className="gap-1.5">
          <Plus className="size-4" />
          הוסף פריט
        </Button>
      )}
    </section>
  );
}
