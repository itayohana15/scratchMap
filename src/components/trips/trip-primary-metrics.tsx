"use client";

import { CalendarDays, CarFront, ShieldCheck, UsersRound, WalletCards, type LucideIcon } from "lucide-react";

import { formatCurrency, tripDurationDays } from "@/lib/format";
import { computeTripBudgetSummary } from "@/lib/trip-budget";
import { isReadinessApplicable, computeTripReadiness } from "@/lib/trip-readiness";
import type { TripHubTrip } from "@/lib/trip-hub";
import { cn } from "@/lib/utils";

interface Metric {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: "amber" | "teal" | "sky" | "coral";
  detail?: string;
  progress?: number;
}

const METRIC_ACCENTS = {
  amber: "border-amber-200/80 bg-gradient-to-br from-amber-50 via-card to-card text-amber-700",
  teal: "border-teal-200/80 bg-gradient-to-br from-teal-50 via-card to-card text-teal-700",
  sky: "border-sky-200/80 bg-gradient-to-br from-sky-50 via-card to-card text-sky-700",
  coral: "border-orange-200/80 bg-gradient-to-br from-orange-50 via-card to-card text-orange-700",
} as const;

function MetricTile({ metric }: { metric: Metric }) {
  const Icon = metric.icon;

  return (
    <div
      className={cn(
        "group relative h-[118px] overflow-hidden rounded-[22px] border p-3.5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md",
        METRIC_ACCENTS[metric.accent]
      )}
    >
      <div className="absolute -top-8 -left-8 size-24 rounded-full bg-current opacity-[0.07] transition-transform duration-300 group-hover:scale-125" />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-muted-foreground">{metric.label}</span>
          <span className="rounded-xl bg-background/80 p-2 shadow-sm">
            <Icon className="size-4" />
          </span>
        </div>
        <div className="mt-auto">
          <span className="block text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {metric.value}
          </span>
          {metric.detail ? (
            <span className="mt-1 block text-[11px] text-muted-foreground">{metric.detail}</span>
          ) : null}
        </div>
        {metric.progress != null ? (
          <div className="pt-2">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-current/10"
              aria-label={`אחוזי ארגון: ${metric.progress}%`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={metric.progress}
            >
              <div className="h-full rounded-full bg-current" style={{ width: `${metric.progress}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BudgetTile({ trip }: { trip: TripHubTrip }) {
  const summary = computeTripBudgetSummary(trip.itinerary);
  if (summary.originalBudget == null) return null;
  const usedAmount = summary.actualCost.hasData ? summary.actualCost.value : summary.plannedCost;
  const spentPercentage = usedAmount != null
    ? Math.min(100, Math.round((usedAmount / summary.originalBudget) * 100))
    : 0;

  return (
    <div
      className={cn(
        "group relative h-[118px] overflow-hidden rounded-[22px] border p-3.5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md",
        summary.isOverBudget
          ? "border-destructive/40 bg-gradient-to-br from-destructive/10 via-card to-card"
          : "border-violet-200/80 bg-gradient-to-br from-violet-50 via-card to-card"
      )}
    >
      <div className="absolute -top-8 -left-8 size-24 rounded-full bg-violet-500 opacity-[0.08] transition-transform duration-300 group-hover:scale-125" />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold text-muted-foreground">נוצל מהתקציב</span>
          <span className="rounded-xl bg-background/80 p-2 text-violet-700 shadow-sm">
            <WalletCards className="size-4" />
          </span>
        </div>
        <div className="mt-auto flex items-baseline gap-2">
          <span className={cn("text-2xl font-bold tracking-tight sm:text-3xl", summary.isOverBudget ? "text-destructive" : "text-foreground")}>
            {formatCurrency(usedAmount)}
          </span>
          <span className="text-xs text-muted-foreground">מתוך {formatCurrency(summary.originalBudget)}</span>
        </div>
        <div className="pt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className={cn("h-full rounded-full", summary.isOverBudget ? "bg-destructive" : "bg-violet-500")}
              style={{ width: `${spentPercentage}%` }}
            />
          </div>
        </div>
      </div>
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
    {
      label: "ימי טיול",
      value: String(durationDays),
      detail: "במסלול המתוכנן",
      icon: CalendarDays,
      accent: "amber",
    },
    {
      label: "נוסעים",
      value: String(trip.travelers),
      detail: "משתתפים בטיול",
      icon: UsersRound,
      accent: "teal",
    },
  ];

  if (itinerary.costSummary.estimatedTransportCost != null) {
    metrics.push({
      label: "תחבורה",
      value: formatCurrency(itinerary.costSummary.estimatedTransportCost),
      detail: "עלות משוערת",
      icon: CarFront,
      accent: "sky",
    });
  }
  if (readiness) {
    metrics.push({
      label: "מוכנות לטיול",
      value: `${readiness.overallPercent}%`,
      icon: ShieldCheck,
      accent: "coral",
      progress: readiness.overallPercent,
    });
  }

  const tileCount = metrics.length + (itinerary.budget != null ? 1 : 0);
  const gridColumns =
    tileCount >= 5
      ? "lg:grid-cols-5"
      : tileCount === 4
        ? "lg:grid-cols-4"
        : tileCount === 3
          ? "lg:grid-cols-3"
          : "lg:grid-cols-2";

  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", gridColumns)}>
      {metrics.slice(0, 2).map((metric) => (
        <MetricTile key={metric.label} metric={metric} />
      ))}
      <BudgetTile trip={trip} />
      {metrics.slice(2).map((metric) => (
        <MetricTile key={metric.label} metric={metric} />
      ))}
    </div>
  );
}
