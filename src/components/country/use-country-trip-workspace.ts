"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  applyAiPlanToWorkspace,
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  createId,
  normalizeWorkspace,
  recommendationToItineraryItem,
  type AiItineraryResponse,
  type CountryTripWorkspaceState,
  type DayPart,
  type TripBooking,
  type TripExpense,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripMemoryPhoto,
  type TripPhase,
  type TripPreferences,
  type TripRecommendation,
  type TripSummary,
} from "@/lib/trip-workspace";

function storageKey(countryId: string) {
  return `scratchmap-country-workspace:${countryId}`;
}

type ExpenseBucket = "estimatedExpenses" | "actualExpenses";

export function useCountryTripWorkspace(countryId: string, countryName: string) {
  const [hydrated, setHydrated] = useState(false);
  const [workspace, setWorkspace] = useState<CountryTripWorkspaceState>(() =>
    createDefaultWorkspace(countryName)
  );

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey(countryId));
    if (!raw) {
      const initial = createDefaultWorkspace(countryName);
      setWorkspace(initial);
      setHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as CountryTripWorkspaceState;
      setWorkspace(normalizeWorkspace(parsed, countryName));
    } catch {
      setWorkspace(createDefaultWorkspace(countryName));
    } finally {
      setHydrated(true);
    }
  }, [countryId, countryName]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(storageKey(countryId), JSON.stringify(workspace));
  }, [countryId, hydrated, workspace]);

  const updateWorkspace = useCallback((
    updater: (current: CountryTripWorkspaceState) => CountryTripWorkspaceState
  ) => {
    setWorkspace((current) => {
      const updated = updater(current);
      return normalizeWorkspace(updated, countryName);
    });
  }, [countryName]);

  const actions = useMemo(
    () => ({
      setTripStatus(status: TripPhase) {
        updateWorkspace((current) => ({ ...current, tripStatus: status }));
      },
      updatePreferences(patch: Partial<TripPreferences>) {
        updateWorkspace((current) => ({
          ...current,
          preferences: { ...current.preferences, ...patch },
        }));
      },
      updateSummary(patch: Partial<TripSummary>) {
        updateWorkspace((current) => ({
          ...current,
          summary: { ...current.summary, ...patch },
        }));
      },
      addOrUpdateRecommendation(recommendation: TripRecommendation) {
        updateWorkspace((current) => {
          const existingIndex = current.recommendations.findIndex(
            (item) => item.id === recommendation.id
          );
          if (existingIndex === -1) {
            return {
              ...current,
              recommendations: [...current.recommendations, recommendation],
            };
          }

          const nextRecommendations = [...current.recommendations];
          nextRecommendations[existingIndex] = recommendation;
          return { ...current, recommendations: nextRecommendations };
        });
      },
      removeRecommendation(recommendationId: string) {
        updateWorkspace((current) => ({
          ...current,
          recommendations: current.recommendations.filter(
            (recommendation) => recommendation.id !== recommendationId
          ),
        }));
      },
      addDay(date = "") {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: [
            ...current.itineraryDays,
            createEmptyDay(current.itineraryDays.length + 1, date),
          ],
        }));
      },
      duplicateDay(dayId: string) {
        updateWorkspace((current) => {
          const index = current.itineraryDays.findIndex((day) => day.id === dayId);
          if (index === -1) return current;
          const day = current.itineraryDays[index];
          const duplicateIdMap = new Map<string, string>();
          const duplicatedItems = day.items.map((item) => {
            const nextId = createId("item");
            duplicateIdMap.set(item.id, nextId);
            return { ...item, id: nextId, completed: false, skipped: false };
          });
          const duplicatedDay: TripItineraryDay = {
            ...day,
            id: createId("day"),
            title: `${day.title} (copy)`,
            items: duplicatedItems,
          };
          const nextDays = [...current.itineraryDays];
          nextDays.splice(index + 1, 0, duplicatedDay);
          return {
            ...current,
            itineraryDays: nextDays,
          };
        });
      },
      updateDay(dayId: string, patch: Partial<TripItineraryDay>) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId ? { ...day, ...patch } : day
          ),
        }));
      },
      removeDay(dayId: string) {
        updateWorkspace((current) => {
          const nextDays = current.itineraryDays.filter((day) => day.id !== dayId);
          return {
            ...current,
            itineraryDays: nextDays.length > 0 ? nextDays : [createEmptyDay(1)],
            journalEntries: current.journalEntries.filter((entry) => entry.dayId !== dayId),
            estimatedExpenses: current.estimatedExpenses.filter((expense) => expense.dayId !== dayId),
            actualExpenses: current.actualExpenses.filter((expense) => expense.dayId !== dayId),
          };
        });
      },
      addItem(dayId: string, slot: DayPart = "morning") {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId ? { ...day, items: [...day.items, createEmptyItineraryItem(slot)] } : day
          ),
        }));
      },
      addRecommendationToDay(dayId: string, recommendation: TripRecommendation, slot?: DayPart) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId
              ? {
                  ...day,
                  items: [
                    ...day.items,
                    recommendationToItineraryItem(
                      recommendation,
                      slot ?? recommendation.recommendedTimeOfDay === "any"
                        ? "morning"
                        : recommendation.recommendedTimeOfDay
                    ),
                  ],
                }
              : day
          ),
        }));
      },
      // Marks a recommendation as visited even if it was never added to the
      // itinerary — adds it (to the given day) and completes it atomically
      // so the attraction modal's "mark visited" button works either way.
      markRecommendationVisited(dayId: string, recommendation: TripRecommendation) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId
              ? {
                  ...day,
                  items: [
                    ...day.items,
                    {
                      ...recommendationToItineraryItem(
                        recommendation,
                        recommendation.recommendedTimeOfDay === "any"
                          ? "morning"
                          : recommendation.recommendedTimeOfDay
                      ),
                      completed: true,
                    },
                  ],
                }
              : day
          ),
        }));
      },
      updateItem(dayId: string, itemId: string, patch: Partial<TripItineraryItem>) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId
              ? {
                  ...day,
                  items: day.items.map((item) =>
                    item.id === itemId ? { ...item, ...patch } : item
                  ),
                }
              : day
          ),
        }));
      },
      duplicateItem(dayId: string, itemId: string) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) => {
            if (day.id !== dayId) return day;
            const index = day.items.findIndex((item) => item.id === itemId);
            if (index === -1) return day;
            const item = day.items[index];
            const duplicate = {
              ...item,
              id: createId("item"),
              completed: false,
              skipped: false,
            };
            const nextItems = [...day.items];
            nextItems.splice(index + 1, 0, duplicate);
            return { ...day, items: nextItems };
          }),
        }));
      },
      removeItem(dayId: string, itemId: string) {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) =>
            day.id === dayId
              ? { ...day, items: day.items.filter((item) => item.id !== itemId) }
              : day
          ),
        }));
      },
      moveItem(dayId: string, itemId: string, direction: "up" | "down") {
        updateWorkspace((current) => ({
          ...current,
          itineraryDays: current.itineraryDays.map((day) => {
            if (day.id !== dayId) return day;
            const index = day.items.findIndex((item) => item.id === itemId);
            if (index === -1) return day;
            const targetIndex = direction === "up" ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= day.items.length) return day;
            const nextItems = [...day.items];
            const [moved] = nextItems.splice(index, 1);
            nextItems.splice(targetIndex, 0, moved);
            return { ...day, items: nextItems };
          }),
        }));
      },
      moveItemToDay(fromDayId: string, toDayId: string, itemId: string) {
        updateWorkspace((current) => {
          let movedItem: TripItineraryItem | null = null;
          const nextDays = current.itineraryDays.map((day) => {
            if (day.id === fromDayId) {
              const item = day.items.find((entry) => entry.id === itemId) ?? null;
              movedItem = item;
              return {
                ...day,
                items: day.items.filter((entry) => entry.id !== itemId),
              };
            }
            return day;
          });

          if (!movedItem) return current;

          return {
            ...current,
            itineraryDays: nextDays.map((day) =>
              day.id === toDayId ? { ...day, items: [...day.items, movedItem!] } : day
            ),
          };
        });
      },
      replaceWithAiPlan(plan: AiItineraryResponse) {
        updateWorkspace((current) => applyAiPlanToWorkspace(current, plan));
      },
      upsertBooking(booking: TripBooking) {
        updateWorkspace((current) => {
          const index = current.bookings.findIndex((item) => item.id === booking.id);
          if (index === -1) {
            return { ...current, bookings: [...current.bookings, booking] };
          }
          const nextBookings = [...current.bookings];
          nextBookings[index] = booking;
          return { ...current, bookings: nextBookings };
        });
      },
      removeBooking(bookingId: string) {
        updateWorkspace((current) => ({
          ...current,
          bookings: current.bookings.filter((booking) => booking.id !== bookingId),
        }));
      },
      addExpense(bucket: ExpenseBucket, expense?: Partial<TripExpense>) {
        updateWorkspace((current) => ({
          ...current,
          [bucket]: [
            ...current[bucket],
            {
              id: createId(bucket === "estimatedExpenses" ? "estimate" : "expense"),
              category: "food",
              label: "",
              amount: 0,
              date: "",
              dayId: null,
              notes: "",
              ...expense,
            },
          ],
        }));
      },
      updateExpense(bucket: ExpenseBucket, expenseId: string, patch: Partial<TripExpense>) {
        updateWorkspace((current) => ({
          ...current,
          [bucket]: current[bucket].map((expense) =>
            expense.id === expenseId ? { ...expense, ...patch } : expense
          ),
        }));
      },
      removeExpense(bucket: ExpenseBucket, expenseId: string) {
        updateWorkspace((current) => ({
          ...current,
          [bucket]: current[bucket].filter((expense) => expense.id !== expenseId),
        }));
      },
      upsertMemory(memory: TripMemoryPhoto) {
        updateWorkspace((current) => {
          const sanitizedMemory = memory.cover
            ? { ...memory, favorite: true }
            : memory;
          const nextMemories = current.memories
            .filter((item) => item.id !== memory.id)
            .map((item) => ({
              ...item,
              cover: sanitizedMemory.cover ? false : item.cover,
            }));
          return {
            ...current,
            memories: [...nextMemories, sanitizedMemory],
          };
        });
      },
      removeMemory(memoryId: string) {
        updateWorkspace((current) => ({
          ...current,
          memories: current.memories.filter((memory) => memory.id !== memoryId),
        }));
      },
      resetWorkspace() {
        const fresh = createDefaultWorkspace(countryName);
        setWorkspace(fresh);
      },
      loadWorkspace(nextWorkspace: CountryTripWorkspaceState) {
        setWorkspace(normalizeWorkspace(nextWorkspace, countryName));
      },
      createBooking(): TripBooking {
        const now = new Date().toISOString();
        return {
          id: createId("booking"),
          tripId: "",
          dayId: null,
          itineraryItemId: null,
          type: "other",
          title: "",
          provider: "",
          confirmationNumber: "",
          bookingReference: "",
          startDateTime: "",
          endDateTime: "",
          location: "",
          status: "not_booked",
          paymentStatus: "unpaid",
          amountOriginal: null,
          amountOriginalCurrency: null,
          amountConverted: null,
          exchangeRate: null,
          rateTimestamp: null,
          documentIds: [],
          notes: "",
          createdAt: now,
          updatedAt: now,
        };
      },
      createMemory(): TripMemoryPhoto {
        return {
          id: createId("memory"),
          imageUrl: "",
          caption: "",
          date: "",
          location: "",
          relatedItemId: null,
          favorite: false,
          cover: false,
        };
      },
    }),
    [countryName, updateWorkspace]
  );

  return { workspace, actions, hydrated };
}
