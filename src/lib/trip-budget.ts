import type { CountryItineraryRecord } from "@/lib/itineraries";
import { computeTripMemoryStats, type HasDataValue } from "@/lib/trip-memories";

export interface TripBudgetSummary {
  /** The budget the user actually set for the trip — never shadowed by cost. */
  originalBudget: number | null;
  plannedCost: number | null;
  /** "Unknown" ≠ "0" — a trip with no tracked actual spend has hasData:false, never a silent 0. */
  actualCost: HasDataValue;
  /** originalBudget - (actualCost when known, else plannedCost). Null when no budget was set. */
  remaining: number | null;
  isOverBudget: boolean;
  /** Always >= 0; the positive amount by which cost exceeds budget when isOverBudget is true. */
  overBudgetAmount: number;
  categoryBreakdown: Record<string, number>;
}

const UPGRADE_SUGGESTION_THRESHOLD = 0.15;

/**
 * The one place "how much budget is left" gets computed — spec §C1: keep
 * the original budget, planned cost, and actual cost distinct, then derive
 * remaining from them, rather than ever showing raw cost as if it were the
 * budget (the bug this replaces: trip.displayCost, which is cost with
 * budget only as its last-resort fallback, was being labeled "תקציב").
 */
export function computeTripBudgetSummary(itinerary: CountryItineraryRecord): TripBudgetSummary {
  const originalBudget = itinerary.budget;
  const plannedCost = itinerary.costSummary.totalEstimatedCost;
  const actualCost = computeTripMemoryStats(itinerary).actualSpend;

  const effectiveCost = actualCost.hasData ? actualCost.value : plannedCost;
  const remaining = originalBudget != null && effectiveCost != null ? originalBudget - effectiveCost : null;
  const isOverBudget = remaining != null && remaining < 0;

  return {
    originalBudget,
    plannedCost,
    actualCost,
    remaining,
    isOverBudget,
    overBudgetAmount: isOverBudget && remaining != null ? Math.abs(remaining) : 0,
    categoryBreakdown: itinerary.costSummary.categoryBreakdown ?? {},
  };
}

/** Guidance only (spec §C6) — never auto-spends the remainder. Null unless remaining is meaningfully positive. */
export function buildUpgradeSuggestion(summary: TripBudgetSummary): string | null {
  if (summary.remaining == null || summary.originalBudget == null || summary.originalBudget <= 0) return null;
  if (summary.remaining / summary.originalBudget < UPGRADE_SUGGESTION_THRESHOLD) return null;

  const amount = Math.round(summary.remaining).toLocaleString("he-IL");
  return `נותרו ₪${amount} מהתקציב. אפשר לשקול שדרוג לינה או טיסות.`;
}
