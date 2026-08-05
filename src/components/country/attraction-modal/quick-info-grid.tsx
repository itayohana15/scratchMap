"use client";

import { Accessibility, Clock, Coins, Thermometer, Timer } from "lucide-react";

import { formatCurrency } from "@/lib/format";
import { useCountryWeather, WEATHER_CODE_LABELS } from "@/lib/weather/country-weather";
import type { TripRecommendation } from "@/lib/trip-workspace";

// Built from whatever real fields the recommendation actually carries.
// Cards for fields we have no data source for (booking required as a true
// tri-state, parking, pets) are simply never added here — future providers
// slot in by adding another entry, not by editing this component.
export function QuickInfoGrid({ recommendation }: { recommendation: TripRecommendation }) {
  const { data: weather } = useCountryWeather(recommendation.lat ?? undefined, recommendation.lon ?? undefined);

  const entranceFee =
    recommendation.isFree === true
      ? "כניסה חופשית"
      : recommendation.approximatePrice != null
        ? formatCurrency(recommendation.approximatePrice)
        : null;

  const items = [
    { icon: Clock, label: "שעות פתיחה", value: recommendation.openingHours || null },
    {
      icon: Thermometer,
      label: "מזג אוויר עכשיו",
      value: weather ? `${weather.current.temperature}° · ${WEATHER_CODE_LABELS[weather.current.weatherCode] ?? ""}` : null,
    },
    {
      icon: Timer,
      label: "משך ביקור מומלץ",
      value: recommendation.estimatedDurationMinutes ? `${recommendation.estimatedDurationMinutes} דקות` : null,
    },
    { icon: Coins, label: "דמי כניסה", value: entranceFee },
    {
      icon: Accessibility,
      label: "נגישות",
      value:
        recommendation.wheelchairAccessible === true
          ? "נגיש לכיסא גלגלים"
          : recommendation.wheelchairAccessible === false
            ? "לא נגיש"
            : null,
    },
  ].filter((item) => item.value != null);

  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="animate-in fade-in rounded-2xl border border-border/60 bg-card/60 p-3.5 duration-300"
        >
          <item.icon className="size-4 text-primary" />
          <p className="mt-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {item.label}
          </p>
          <p className="mt-1 text-sm font-semibold">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
