"use client";

import { formatCurrency, tripDurationDays } from "@/lib/format";
import { computeTripBudgetSummary } from "@/lib/trip-budget";
import { isReadinessApplicable, computeTripReadiness } from "@/lib/trip-readiness";
import type { TripHubTrip } from "@/lib/trip-hub";
import { cn } from "@/lib/utils";

interface Metric {
  label: string;
  value: string;
}

function BudgetTile({ trip }: { trip: TripHubTrip }) {
  const summary = computeTripBudgetSummary(trip.itinerary);
  if (summary.originalBudget == null) return null;

  return (
    <div
      className={cn(
        "section-card flex flex-col items-center gap-1 px-3 py-4 text-center",
        summary.isOverBudget && "border-destructive/40 bg-destructive/5"
      )}
    >
      <span
        className={cn(
          "text-lg font-bold sm:text-xl",
          summary.isOverBudget ? "text-destructive" : "text-foreground"
        )}
      >
        {summary.isOverBudget
          ? `חריגה של ${formatCurrency(summary.overBudgetAmount)}`
          : summary.remaining != null
            ? formatCurrency(summary.remaining)
            : "—"}
      </span>
      <span className="text-xs text-muted-foreground">
        {summary.isOverBudget ? "מעל התקציב" : "נותר מהתקציב"}
      </span>
      <span className="text-[11px] text-muted-foreground/80">
        מתוך {formatCurrency(summary.originalBudget)}
      </span>
    </div>
  );
}

/**
 * The 4-6 headline facts about the trip — each one has exactly this single
 * home (spec §5/§6); nothing here is repeated elsewhere on the page as a
 * separate badge/summary box. The budget tile shows remaining budget, never
 * raw cost (spec §C2/§C4 — see trip-budget.ts for why that distinction
 * matters and what bug it replaces).
 */
export function TripPrimaryMetrics({ trip }: { trip: TripHubTrip }) {
  const { itinerary } = trip;
  const durationDays = tripDurationDays(itinerary.startDate, itinerary.endDate) ?? itinerary.daysCount;
  const readiness = isReadinessApplicable(itinerary.status) ? computeTripReadiness(itinerary) : null;

  const metrics: Metric[] = [
    { label: "ימים", value: String(durationDays) },
    { label: "נוסעים", value: String(trip.travelers) },
  ];

  if (itinerary.costSummary.estimatedTransportCost != null) {
    metrics.push({ label: "תחבורה", value: formatCurrency(itinerary.costSummary.estimatedTransportCost) });
  }
  if (readiness) {
    metrics.push({ label: "מוכנות", value: `${readiness.overallPercent}%` });
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
      {metrics.slice(0, 2).map((metric) => (
        <div key={metric.label} className="section-card flex flex-col items-center gap-1 px-3 py-4 text-center">
          <span className="text-lg font-bold text-foreground sm:text-xl">{metric.value}</span>
          <span className="text-xs text-muted-foreground">{metric.label}</span>
        </div>
      ))}
      <BudgetTile trip={trip} />
      {metrics.slice(2).map((metric) => (
        <div key={metric.label} className="section-card flex flex-col items-center gap-1 px-3 py-4 text-center">
          <span className="text-lg font-bold text-foreground sm:text-xl">{metric.value}</span>
          <span className="text-xs text-muted-foreground">{metric.label}</span>
        </div>
      ))}
    </div>
  );
}
