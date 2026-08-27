"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import type { CountryItineraryRecord } from "@/lib/itineraries";
import { usePreferenceProfile } from "@/lib/queries/preference-profile";
import {
  useArchiveCountryItinerary,
  useCountryItineraryVersions,
  useDeleteCountryItinerary,
  useDuplicateCountryItinerary,
  useRegenerateCountryItinerary,
  useRestoreCountryItineraryVersion,
  useUpdateCountryItinerary,
} from "@/lib/queries/country-itineraries";
import { explainPersonalizationInGeneration } from "@/lib/preference-learning";
import { computePlannedCategoryBreakdown } from "@/lib/trip-memories";
import type { DayOptimizeMode, TripItineraryDay, TripItineraryItem } from "@/lib/trip-workspace";

function cloneItinerary(itinerary: CountryItineraryRecord) {
  return JSON.parse(JSON.stringify(itinerary)) as CountryItineraryRecord;
}

function draftSignature(itinerary: CountryItineraryRecord | null) {
  if (!itinerary) return "";
  return JSON.stringify({
    title: itinerary.title,
    summary: itinerary.summary,
    preferencesSnapshot: itinerary.preferencesSnapshot,
    itineraryDays: itinerary.itineraryDays,
    budget: itinerary.budget,
    generationMode: itinerary.generationMode,
    journalEntries: itinerary.workspaceSnapshot?.journalEntries,
    tripSummary: itinerary.workspaceSnapshot?.summary,
    bookings: itinerary.workspaceSnapshot?.bookings,
    documents: itinerary.workspaceSnapshot?.documents,
    checklist: itinerary.workspaceSnapshot?.checklist,
  });
}

/**
 * Shared draft/mutation wiring for CountryItineraryDetailsDialog, reused by
 * both the country page's itinerary history section and the My Trips page
 * so the two surfaces open the exact same modal with identical behavior.
 */
export function useItineraryDialogController(iso: string) {
  const updateItinerary = useUpdateCountryItinerary(iso);
  const duplicateItinerary = useDuplicateCountryItinerary(iso);
  const archiveItinerary = useArchiveCountryItinerary(iso);
  const deleteItinerary = useDeleteCountryItinerary(iso);
  const regenerateItinerary = useRegenerateCountryItinerary(iso);
  const restoreVersion = useRestoreCountryItineraryVersion(iso);
  const preferenceProfileQuery = usePreferenceProfile();

  const [activeItinerary, setActiveItinerary] = useState<CountryItineraryRecord | null>(null);
  const [draft, setDraft] = useState<CountryItineraryRecord | null>(null);

  const { data: versions = [] } = useCountryItineraryVersions(iso, activeItinerary?.id);

  const isDirty = draftSignature(activeItinerary) !== draftSignature(draft);

  function openItinerary(itinerary: CountryItineraryRecord) {
    setActiveItinerary(itinerary);
    setDraft(cloneItinerary(itinerary));
  }

  function closeItinerary() {
    setActiveItinerary(null);
    setDraft(null);
  }

  // Stable identity matters here: these are threaded down into the route-map
  // components' effect dependency arrays, and a function literal recreated
  // on every render there was the root cause of a "Maximum update depth
  // exceeded" loop when the map and timeline stayed mounted together.
  const patchDraft = useCallback(
    (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
      setDraft((current) => (current ? updater(current) : current));
    },
    []
  );

  const patchDay = useCallback(
    (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => {
      patchDraft((current) => ({
        ...current,
        itineraryDays: current.itineraryDays.map((day) => (day.id === dayId ? updater(day) : day)),
      }));
    },
    [patchDraft]
  );

  const patchItem = useCallback(
    (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => {
      patchDay(dayId, (day) => ({
        ...day,
        items: day.items.map((item) => (item.id === itemId ? updater(item) : item)),
      }));
    },
    [patchDay]
  );

  // "הסר מהמסלול" (activity details modal's overflow menu) — same
  // dirty-draft + existing save flow as every other edit, no new mutation
  // path.
  const removeItemFromDay = useCallback(
    (dayId: string, itemId: string) => {
      patchDay(dayId, (day) => ({ ...day, items: day.items.filter((item) => item.id !== itemId) }));
    },
    [patchDay]
  );

  // "העבר ליום אחר" — touches two days at once, so it goes through
  // patchDraft directly rather than the single-day patchDay.
  const moveItemToDay = useCallback(
    (fromDayId: string, toDayId: string, itemId: string) => {
      if (fromDayId === toDayId) return;
      patchDraft((current) => {
        const fromDay = current.itineraryDays.find((day) => day.id === fromDayId);
        const item = fromDay?.items.find((candidate) => candidate.id === itemId);
        if (!item) return current;

        return {
          ...current,
          itineraryDays: current.itineraryDays.map((day) => {
            if (day.id === fromDayId) return { ...day, items: day.items.filter((candidate) => candidate.id !== itemId) };
            if (day.id === toDayId) return { ...day, items: [...day.items, item] };
            return day;
          }),
        };
      });
    },
    [patchDraft]
  );

  async function saveDraft() {
    if (!draft) return;
    try {
      const itinerary = await updateItinerary.mutateAsync({
        itineraryId: draft.id,
        title: draft.title,
        summary: draft.summary,
        itineraryDays: draft.itineraryDays,
        preferencesSnapshot: draft.preferencesSnapshot,
        workspaceSnapshot: {
          ...(draft.workspaceSnapshot ?? {}),
          preferences: draft.preferencesSnapshot,
          itineraryDays: draft.itineraryDays,
          lastAiPlanSummary: draft.summary,
        },
        budget: draft.budget,
        generationMode: draft.generationMode,
        manuallyEdited: true,
        changeReason: "manual edit from modal",
      });
      setActiveItinerary(itinerary);
      setDraft(cloneItinerary(itinerary));
      toast.success("המסלול נשמר");
      return itinerary;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שמירת המסלול נכשלה");
      throw error;
    }
  }

  function closeModal(nextOpen: boolean) {
    if (nextOpen) return;
    if (isDirty && !window.confirm("יש שינויים שלא נשמרו. לסגור בכל זאת?")) {
      return;
    }
    closeItinerary();
  }

  function resetDraft() {
    if (!activeItinerary) return;
    setDraft(cloneItinerary(activeItinerary));
  }

  async function handleArchive(itineraryId: string) {
    try {
      await archiveItinerary.mutateAsync(itineraryId);
      toast.success("המסלול הועבר לארכיון");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "הארכוב נכשל");
    }
  }

  async function handleDelete(itineraryId: string) {
    if (!window.confirm("למחוק את המסלול מההיסטוריה?")) return;
    try {
      await deleteItinerary.mutateAsync(itineraryId);
      if (activeItinerary?.id === itineraryId) {
        closeItinerary();
      }
      toast.success("המסלול נמחק");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "המחיקה נכשלה");
    }
  }

  async function handleDuplicate(itineraryId: string) {
    try {
      const duplicate = await duplicateItinerary.mutateAsync(itineraryId);
      toast.success("נוצר עותק חדש");
      openItinerary(duplicate);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "השכפול נכשל");
    }
  }

  async function handleRegenerate(
    itineraryId: string,
    scope: "full" | "day" | "activity" | "optimize_route" | "recalculate_costs" | "live_replan" | "live_replace_item",
    targetDayId?: string | null,
    targetItemId?: string | null,
    optimizeMode?: DayOptimizeMode | null,
    liveInstruction?: string | null
  ) {
    try {
      const itinerary = await regenerateItinerary.mutateAsync({
        itineraryId,
        scope,
        targetDayId,
        targetItemId,
        optimizeMode,
        liveInstruction,
      });
      toast.success("המסלול עודכן מחדש");
      if (scope === "full" && preferenceProfileQuery.data) {
        const bullets = explainPersonalizationInGeneration(
          computePlannedCategoryBreakdown(itinerary),
          preferenceProfileQuery.data.explicit_preferences ?? {}
        );
        if (bullets.length > 0) {
          toast.message("התאמתי את המסלול להעדפות שלך", { description: bullets.join(" · ") });
        }
      }
      if (activeItinerary?.id === itineraryId) {
        setActiveItinerary(itinerary);
        setDraft(cloneItinerary(itinerary));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ה-regeneration נכשל");
    }
  }

  async function handleRestore(versionId: string) {
    if (!activeItinerary) return;
    try {
      const itinerary = await restoreVersion.mutateAsync({
        itineraryId: activeItinerary.id,
        versionId,
      });
      setActiveItinerary(itinerary);
      setDraft(cloneItinerary(itinerary));
      toast.success("הגרסה שוחזרה");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שחזור הגרסה נכשל");
    }
  }

  function exportItinerary(itinerary: CountryItineraryRecord) {
    const blob = new Blob([JSON.stringify(itinerary, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${itinerary.title}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return {
    activeItinerary,
    draft,
    versions,
    isDirty,
    isSaving: updateItinerary.isPending,
    isRegenerating: regenerateItinerary.isPending,
    isDuplicating: duplicateItinerary.isPending,
    openItinerary,
    closeItinerary,
    closeModal,
    resetDraft,
    patchDraft,
    patchDay,
    patchItem,
    removeItemFromDay,
    moveItemToDay,
    saveDraft,
    handleArchive,
    handleDelete,
    handleDuplicate,
    handleRegenerate,
    handleRestore,
    exportItinerary,
  };
}
