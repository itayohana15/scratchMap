"use client";

import { Clock, Coins, MapPin, Tag, Thermometer, Timer } from "lucide-react";

import { formatCurrency } from "@/lib/format";
import { useCountryWeather, WEATHER_CODE_LABELS } from "@/lib/weather/country-weather";
import { RECOMMENDATION_CATEGORY_LABELS, type TripItineraryItem } from "@/lib/trip-workspace";

/**
 * Same "only render the fields we actually have" contract as the
 * country-page QuickInfoGrid, rebuilt against TripItineraryItem's own
 * fields (it lacks isFree/wheelchairAccessible, which that component reads
 * from TripRecommendation, so this isn't a drop-in reuse — see spec item 9).
 */
export function ActivityQuickInfoGrid({ item }: { item: TripItineraryItem }) {
  const { data: weather } = useCountryWeather(item.lat ?? undefined, item.lon ?? undefined);

  const entries = [
    {
      icon: Timer,
      label: "משך מומלץ",
      value: item.estimatedDurationMinutes ? `${item.estimatedDurationMinutes} דקות` : null,
    },
    { icon: Clock, label: "שעות פתיחה", value: item.openingHours || null },
    {
      icon: Coins,
      label: "מחיר",
      value: item.approximatePrice != null ? formatCurrency(item.approximatePrice) : "חינם",
    },
    { icon: Tag, label: "סוג פעילות", value: RECOMMENDATION_CATEGORY_LABELS[item.category] },
    { icon: MapPin, label: "אזור", value: item.location || null },
    {
      icon: Thermometer,
      label: "מזג אוויר עכשיו",
      value: weather ? `${weather.current.temperature}° · ${WEATHER_CODE_LABELS[weather.current.weatherCode] ?? ""}` : null,
    },
  ].filter((entry) => entry.value != null);

  if (entries.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {entries.map((entry) => (
        <div key={entry.label} className="rounded-2xl border border-border/60 bg-card/60 p-3.5">
          <entry.icon className="size-4 text-primary" />
          <p className="mt-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{entry.label}</p>
          <p className="mt-1 text-sm font-semibold">{entry.value}</p>
        </div>
      ))}
    </div>
  );
}
