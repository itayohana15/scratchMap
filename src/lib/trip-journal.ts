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
    time: "",
    city: null,
    place: null,
    title: "",
    text: "",
    mood: null,
    rating: null,
    photoIds: [],
    tags: [],
    activityId: null,
    favoriteMemory: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Never re-uploads or duplicates a photo record — just links an existing id (spec §20). */
export function attachPhotoToEntry(entry: TripJournalEntry, photoId: string): TripJournalEntry {
  if (entry.photoIds.includes(photoId)) return entry;
  return { ...entry, photoIds: [...entry.photoIds, photoId] };
}

export interface JournalDayGroup {
  dayId: string | null;
  label: string;
  entries: TripJournalEntry[];
}

/** Groups by day, in day order; entries with no dayId land in a trailing "ללא יום מסוים" group. */
export function groupEntriesByDay(
  entries: TripJournalEntry[],
  days: Array<{ id: string; dayNumber: number }>
): JournalDayGroup[] {
  const byDay = new Map<string, TripJournalEntry[]>();
  const unassigned: TripJournalEntry[] = [];

  for (const entry of entries) {
    if (!entry.dayId) {
      unassigned.push(entry);
      continue;
    }
    const list = byDay.get(entry.dayId) ?? [];
    list.push(entry);
    byDay.set(entry.dayId, list);
  }

  const groups: JournalDayGroup[] = days
    .filter((day) => byDay.has(day.id))
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((day) => ({ dayId: day.id, label: `יום ${day.dayNumber}`, entries: byDay.get(day.id)! }));

  if (unassigned.length > 0) {
    groups.push({ dayId: null, label: "ללא יום מסוים", entries: unassigned });
  }

  return groups;
}

export interface JournalCityGroup {
  city: string;
  entries: TripJournalEntry[];
}

/** Groups by the entry's free-text city, preserving first-seen order; unset city -> "ללא עיר". */
export function groupEntriesByCity(entries: TripJournalEntry[]): JournalCityGroup[] {
  const byCity = new Map<string, TripJournalEntry[]>();
  const order: string[] = [];

  for (const entry of entries) {
    const city = entry.city?.trim() || "ללא עיר";
    if (!byCity.has(city)) {
      byCity.set(city, []);
      order.push(city);
    }
    byCity.get(city)!.push(entry);
  }

  return order.map((city) => ({ city, entries: byCity.get(city)! }));
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
