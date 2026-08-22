import type { CountryItineraryRecord } from "@/lib/itineraries";
import { createId, type TripExpense } from "@/lib/trip-workspace";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

export function actualExpenses(itinerary: CountryItineraryRecord | null): TripExpense[] {
  return itinerary?.workspaceSnapshot?.actualExpenses ?? [];
}

export function createQuickExpense(dayId: string | null, itemId: string | null = null): TripExpense {
  return {
    id: createId("expense"),
    category: "other",
    label: "",
    amount: 0,
    amountOriginalCurrency: null,
    exchangeRate: null,
    rateTimestamp: null,
    date: new Date().toISOString().slice(0, 10),
    dayId,
    itemId,
    notes: "",
  };
}

export function upsertActualExpense(patchDraft: PatchDraft, expense: TripExpense) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      actualExpenses: [...actualExpenses(current).filter((entry) => entry.id !== expense.id), expense],
    },
  }));
}

export function removeActualExpense(patchDraft: PatchDraft, expenseId: string) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      actualExpenses: actualExpenses(current).filter((entry) => entry.id !== expenseId),
    },
  }));
}

export interface TodaySpend {
  total: number;
  // Distinguishes "nothing logged yet" from "confirmed ₪0 spent" (spec:
  // don't treat unknown expenses as zero-confidence actual data).
  hasData: boolean;
}

/** Sums quick-add expenses + item-level actualCost for one day — actual data only, never planned estimates. */
export function todaySpend(itinerary: CountryItineraryRecord | null, dayId: string): TodaySpend {
  const dayExpenses = actualExpenses(itinerary).filter((expense) => expense.dayId === dayId);
  const day = itinerary?.itineraryDays.find((entry) => entry.id === dayId);
  const itemCosts = (day?.items ?? []).filter((item) => item.actualCost != null);

  const total =
    dayExpenses.reduce((sum, expense) => sum + expense.amount, 0) +
    itemCosts.reduce((sum, item) => sum + (item.actualCost ?? 0), 0);

  return { total, hasData: dayExpenses.length > 0 || itemCosts.length > 0 };
}
