"use client";

import { formatCurrency } from "@/lib/format";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { buildUpgradeSuggestion, computeTripBudgetSummary } from "@/lib/trip-budget";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

export function TripBudgetTab({ itinerary }: { itinerary: CountryItineraryRecord }) {
  const summary = computeTripBudgetSummary(itinerary);
  const upgradeSuggestion = buildUpgradeSuggestion(summary);
  const breakdownEntries = Object.entries(summary.categoryBreakdown) as Array<[string, number]>;
  const breakdownTotal = breakdownEntries.reduce((sum, [, value]) => sum + value, 0) || 1;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="section-card p-4 text-center">
          <p className="text-xs text-muted-foreground">תקציב התחלתי</p>
          <p className="mt-1 text-lg font-bold">
            {summary.originalBudget != null ? formatCurrency(summary.originalBudget) : "לא הוגדר"}
          </p>
        </div>
        <div className="section-card p-4 text-center">
          <p className="text-xs text-muted-foreground">הוצאה מתוכננת</p>
          <p className="mt-1 text-lg font-bold">
            {summary.plannedCost != null ? formatCurrency(summary.plannedCost) : "—"}
          </p>
        </div>
        <div
          className={cn(
            "section-card p-4 text-center",
            summary.isOverBudget && "border-destructive/40 bg-destructive/5"
          )}
        >
          <p className="text-xs text-muted-foreground">{summary.isOverBudget ? "חריגה" : "נותר"}</p>
          <p className={cn("mt-1 text-lg font-bold", summary.isOverBudget && "text-destructive")}>
            {summary.isOverBudget
              ? formatCurrency(summary.overBudgetAmount)
              : summary.remaining != null
                ? formatCurrency(summary.remaining)
                : "—"}
          </p>
        </div>
      </div>

      {summary.originalBudget != null && summary.remaining != null ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", summary.isOverBudget ? "bg-destructive" : "bg-primary")}
            style={{
              width: `${Math.min(
                100,
                Math.round(
                  ((summary.originalBudget - Math.max(summary.remaining, 0)) / summary.originalBudget) * 100
                )
              )}%`,
            }}
          />
        </div>
      ) : null}

      {upgradeSuggestion ? (
        <p className="section-card p-3 text-sm text-muted-foreground">{upgradeSuggestion}</p>
      ) : null}

      {breakdownEntries.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <h3 className="font-heading text-base font-semibold">פילוח לפי קטגוריה</h3>
          <div className="space-y-2.5">
            {breakdownEntries
              .sort((a, b) => b[1] - a[1])
              .map(([category, amount]) => (
                <div key={category} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span>{EXPENSE_CATEGORY_LABELS[category as ExpenseCategory] ?? category}</span>
                    <span className="font-medium">{formatCurrency(amount)}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round((amount / breakdownTotal) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
