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

/**
 * Guidance only (spec item 24 — "do not spend money just to spend it"),
 * never an auto-spend action. Empty unless remaining is meaningfully
 * positive. Returns several concrete options rather than one generic
 * sentence, picked from which categories look like they have real
 * headroom in the actual categoryBreakdown — still just suggestions, the
 * traveler decides.
 */
export function buildUpgradeSuggestions(summary: TripBudgetSummary): string[] {
  if (summary.remaining == null || summary.originalBudget == null || summary.originalBudget <= 0) return [];
  if (summary.remaining / summary.originalBudget < UPGRADE_SUGGESTION_THRESHOLD) return [];

  const breakdown = summary.categoryBreakdown;
  const totalSpend = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const shareOf = (category: string) => (totalSpend > 0 ? (breakdown[category] ?? 0) / totalSpend : 0);

  const suggestions: string[] = [];
  if (shareOf("accommodation") < 0.3) suggestions.push("שדרוג לינה למיקום מרכזי יותר או לחדר גדול יותר");
  if (breakdown.flights != null && shareOf("flights") < 0.25) suggestions.push("טיסה ישירה במקום עם קונקשן");
  suggestions.push("ארוחת ערב מיוחדת באחד הימים במסלול");
  suggestions.push("טיול פרטי או חוויה מודרכת ביום פנוי");
  if (summary.remaining >= 3000) suggestions.push("שכירת רכב לחלק מהטיול, אם זה משרת את המסלול");

  return suggestions;
}
