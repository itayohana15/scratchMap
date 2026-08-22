import { parseTimeToMinutes } from "@/lib/live-trip-planner";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";

export type DerivedItemStatus = "planned" | "completed" | "skipped" | "replaced";

/**
 * Derived, never stored — avoids a second source of truth alongside the
 * existing completed/skipped/replaced booleans. "cancelled" (spec §2) is
 * intentionally not distinct from "skipped" here: the app has no separate
 * cancel flow and the spec doesn't define a behavioral difference between
 * the two, so introducing one would just fragment the existing mutual
 * exclusion without giving the user anything new.
 */
export function itemStatus(item: Pick<TripItineraryItem, "completed" | "skipped" | "replaced">): DerivedItemStatus {
  if (item.completed) return "completed";
  if (item.skipped) return "skipped";
  if (item.replaced) return "replaced";
  return "planned";
}

/** The "בפועל" item list for a day — what actually happened, spontaneous included. */
export function actualDayItems(day: Pick<TripItineraryDay, "items">): TripItineraryItem[] {
  return day.items.filter((item) => item.completed || item.spontaneous);
}

/**
 * The "מתוכנן" item list — the original plan, exactly as it was, never
 * retroactively including anything added live (spec §22).
 */
export function plannedDayItems(day: Pick<TripItineraryDay, "items">): TripItineraryItem[] {
  return day.items.filter((item) => !item.spontaneous);
}

export interface HasDataValue {
  value: number;
  hasData: boolean;
}

export interface DayComparison {
  activitiesPlanned: number;
  activitiesCompleted: number;
  activitiesSkipped: number;
  spontaneousActivities: number;
  plannedCost: number;
  actualCost: HasDataValue;
  plannedTravelMinutes: number;
  actualTravelMinutes: HasDataValue;
}

/** Sum of consecutive-item real time gaps, only where both endpoints are known — never guessed. */
function computeActualTravelMinutes(day: Pick<TripItineraryDay, "items">): HasDataValue {
  const ordered = actualDayItems(day)
    .map((item) => ({ item, start: parseTimeToMinutes(item.actualStartTime) }))
    .filter((entry): entry is { item: TripItineraryItem; start: number } => entry.start != null)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let hasData = false;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].item;
    const previousEnd = parseTimeToMinutes(previous.actualEndTime);
    const currentStart = ordered[index].start;
    if (previousEnd == null) continue;
    const gap = currentStart - previousEnd;
    if (gap < 0) continue;
    total += gap;
    hasData = true;
  }
  return { value: total, hasData };
}

/** Unknown ≠ 0 — cost/travel-time fields carry an explicit hasData flag rather than silently reading as 0. */
export function computeDayComparison(day: Pick<TripItineraryDay, "items">): DayComparison {
  const planned = plannedDayItems(day);
  const completed = day.items.filter((item) => item.completed);
  const skipped = day.items.filter((item) => item.skipped);
  const spontaneous = day.items.filter((item) => item.spontaneous);

  const plannedCost = planned.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const actualCostItems = actualDayItems(day).filter((item) => item.actualCost != null);
  const actualCost: HasDataValue = {
    value: actualCostItems.reduce((sum, item) => sum + (item.actualCost ?? 0), 0),
    hasData: actualCostItems.length > 0,
  };

  const plannedTravelMinutes = planned.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);

  return {
    activitiesPlanned: planned.length,
    activitiesCompleted: completed.length,
    activitiesSkipped: skipped.length,
    spontaneousActivities: spontaneous.length,
    plannedCost,
    actualCost,
    plannedTravelMinutes,
    actualTravelMinutes: computeActualTravelMinutes(day),
  };
}

export interface ExpenseCategoryComparisonRow {
  category: ExpenseCategory;
  label: string;
  planned: number;
  actual: HasDataValue;
  difference: number | null;
}

/**
 * Per-category planned vs actual, unlike buildTripComparison's totals-only
 * view. Planned = estimatedExpenses + every item's approximatePrice; actual
 * = actualExpenses + every item's actualCost, both grouped by
 * ExpenseCategory (item categories are mapped onto the closest expense
 * category — attraction-like items -> "attractions", food-like -> "food",
 * everything else falls back to "other").
 */
function expenseCategoryForItem(item: TripItineraryItem): ExpenseCategory {
  if (item.category === "restaurant" || item.category === "cafe") return "food";
  if (item.category === "hotel") return "accommodation";
  if (item.category === "transportation") return "local_transportation";
  if (item.category === "shopping") return "shopping";
  if (item.category === "attraction" || item.category === "museum" || item.category === "nature") {
    return "attractions";
  }
  return "other";
}

export function expenseCategoryComparison(itinerary: CountryItineraryRecord): ExpenseCategoryComparisonRow[] {
  const estimated = itinerary.workspaceSnapshot?.estimatedExpenses ?? [];
  const actual = itinerary.workspaceSnapshot?.actualExpenses ?? [];
  const allItems = itinerary.itineraryDays.flatMap((day) => day.items);

  const planned = new Map<ExpenseCategory, number>();
  const actualTotals = new Map<ExpenseCategory, number>();
  const actualPresence = new Map<ExpenseCategory, boolean>();

  for (const expense of estimated) {
    planned.set(expense.category, (planned.get(expense.category) ?? 0) + expense.amount);
  }
  for (const item of allItems) {
    if (item.approximatePrice == null) continue;
    const category = expenseCategoryForItem(item);
    planned.set(category, (planned.get(category) ?? 0) + item.approximatePrice);
  }

  for (const expense of actual) {
    actualTotals.set(expense.category, (actualTotals.get(expense.category) ?? 0) + expense.amount);
    actualPresence.set(expense.category, true);
  }
  for (const item of allItems) {
    if (item.actualCost == null) continue;
    const category = expenseCategoryForItem(item);
    actualTotals.set(category, (actualTotals.get(category) ?? 0) + item.actualCost);
    actualPresence.set(category, true);
  }

  const categories = new Set<ExpenseCategory>([...planned.keys(), ...actualTotals.keys()]);

  return [...categories]
    .map((category) => {
      const plannedValue = planned.get(category) ?? 0;
      const hasData = actualPresence.get(category) ?? false;
      const actualValue = actualTotals.get(category) ?? 0;
      return {
        category,
        label: EXPENSE_CATEGORY_LABELS[category],
        planned: plannedValue,
        actual: { value: actualValue, hasData },
        difference: hasData ? actualValue - plannedValue : null,
      };
    })
    .sort((a, b) => b.planned - a.planned);
}

/** Excludes skipped planned activities from the actual map (spec §21) — spontaneous stops are included. */
export function actualMapItemIds(day: Pick<TripItineraryDay, "items">): Set<string> {
  return new Set(actualDayItems(day).map((item) => item.id));
}
