"use client";

import { ArrowLeft, Bus } from "lucide-react";

import { formatCurrency, formatDate } from "@/lib/format";
import type { TripItineraryDay } from "@/lib/trip-workspace";

interface TransportLeg {
  fromCity: string;
  toCity: string;
  date: string;
  mode: string;
  durationMinutes: number | null;
  cost: number | null;
}

/** Two days are "the same city" when their canonical ids match; falls back to raw text for days generated before city-normalization.ts existed. */
function isSameCity(a: TripItineraryDay, b: TripItineraryDay): boolean {
  if (a.cityCanonicalId && b.cityCanonicalId) return a.cityCanonicalId === b.cityCanonicalId;
  return a.cityRegion === b.cityRegion;
}

/** Inter-city legs derived from consecutive days where the city changes (spec §18). */
function buildInterCityLegs(days: TripItineraryDay[]): TransportLeg[] {
  const legs: TransportLeg[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const previous = days[i - 1];
    const current = days[i];
    if (!previous.cityRegion || !current.cityRegion) continue;
    if (isSameCity(previous, current)) continue;
    legs.push({
      fromCity: previous.cityRegion,
      toCity: current.cityRegion,
      date: current.date,
      mode: current.transportation || "תחבורה",
      durationMinutes: current.totalTravelMinutes,
      cost: current.transportCost,
    });
  }
  return legs;
}

function formatDurationLabel(minutes: number | null) {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} דק׳`;
  return rest > 0 ? `${hours}:${String(rest).padStart(2, "0")} שעות` : `${hours} שעות`;
}

export function TripTransportTab({ days }: { days: TripItineraryDay[] }) {
  const legs = buildInterCityLegs(days);
  const localTransportDays = days.filter((day) => day.transportation.trim() && day.cityRegion);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="font-heading text-base font-semibold">מעברים בין ערים</h3>
        {legs.length === 0 ? (
          <p className="section-card p-4 text-sm text-muted-foreground">אין מעברים בין ערים במסלול הזה.</p>
        ) : (
          legs.map((leg, index) => (
            <div key={index} className="section-card space-y-2 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span>{leg.fromCity}</span>
                <ArrowLeft className="size-4 text-muted-foreground" />
                <span>{leg.toCity}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Bus className="size-3.5" />
                  {leg.mode}
                </span>
                {leg.date ? <span>{formatDate(leg.date, "d בMMM")}</span> : null}
                {formatDurationLabel(leg.durationMinutes) ? <span>{formatDurationLabel(leg.durationMinutes)}</span> : null}
                {leg.cost != null ? <span>{formatCurrency(leg.cost)}</span> : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-3">
        <h3 className="font-heading text-base font-semibold">תחבורה מקומית</h3>
        {localTransportDays.length === 0 ? (
          <p className="section-card p-4 text-sm text-muted-foreground">אין הערות תחבורה מקומית לימים אלה.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {localTransportDays.map((day) => (
              <div key={day.id} className="section-card p-3 text-sm">
                <p className="font-medium text-foreground">
                  יום {day.dayNumber} · {day.cityRegion}
                </p>
                <p className="text-xs text-muted-foreground">{day.transportation}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
