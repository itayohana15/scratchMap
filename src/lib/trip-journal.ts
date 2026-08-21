import type { CountryItineraryRecord } from "@/lib/itineraries";
import { createId, type TripJournalEntry, type TripSummary } from "@/lib/trip-workspace";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

/**
 * Some itineraries saved before this trip-scoped journal model existed may
 * still carry the old, auto-created-one-per-day entries (no `createdAt`,
 * none of the new fields ever set) in workspace_snapshot.journalEntries.
 * Those are empty placeholder noise, not real content, so they're filtered
 * out here rather than surfaced as blank "untitled" entries.
 */
export function journalEntries(itinerary: CountryItineraryRecord | null): TripJournalEntry[] {
  const raw = itinerary?.workspaceSnapshot?.journalEntries ?? [];
  return raw.filter((entry) => typeof entry.createdAt === "string" && entry.createdAt.length > 0);
}

export function createEmptyJournalEntry(): TripJournalEntry {
  const now = new Date().toISOString();
  return {
    id: createId("journal"),
    dayId: null,
    date: null,
    city: null,
    place: null,
    title: "",
    text: "",
    mood: null,
    rating: null,
    photoIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertJournalEntry(patchDraft: PatchDraft, entry: TripJournalEntry) {
  patchDraft((current) => {
    const existing = journalEntries(current);
    const nextEntry: TripJournalEntry = { ...entry, updatedAt: new Date().toISOString() };
    return {
      ...current,
      workspaceSnapshot: {
        ...current.workspaceSnapshot,
        journalEntries: [...existing.filter((item) => item.id !== nextEntry.id), nextEntry],
      },
    };
  });
}

export function removeJournalEntry(patchDraft: PatchDraft, entryId: string) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      journalEntries: journalEntries(current).filter((item) => item.id !== entryId),
    },
  }));
}

export function tripSummary(itinerary: CountryItineraryRecord | null): TripSummary {
  return (
    itinerary?.workspaceSnapshot?.summary ?? {
      overallTripSummary: "",
      favoriteMemory: "",
      favoritePlace: "",
      favoriteRestaurant: "",
      bestDay: "",
      biggestSurprise: "",
      differentlyNextTime: "",
      personalRating: null,
      tripHighlights: "",
      lessonsLearned: "",
      recommendationsForOthers: "",
    }
  );
}

export function patchSummary(patchDraft: PatchDraft, partial: Partial<TripSummary>) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      summary: { ...tripSummary(current), ...partial },
    },
  }));
}
