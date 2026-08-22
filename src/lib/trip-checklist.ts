import countryFactsData from "@/lib/facts/country-facts-data.json";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  createId,
  type ChecklistCategory,
  type TripBooking,
  type TripChecklistItem,
  type TripDocument,
} from "@/lib/trip-workspace";
import { bookings } from "@/lib/trip-bookings";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

interface RawCountryFactsRecord {
  currencies?: Array<{ code?: string }>;
}

// Small, local lookup (duplicated from country-itinerary-generation.ts's
// getCountryCurrencyCode rather than imported) — that file pulls in
// server-only AI generation dependencies, which would be wasteful and wrong
// to bundle into this client-usable module for a 3-line JSON lookup.
function getCountryCurrencyCode(isoA2: string): string | null {
  const record = (countryFactsData as Record<string, RawCountryFactsRecord>)[isoA2.toUpperCase()];
  return record?.currencies?.[0]?.code?.toUpperCase() ?? null;
}

export function checklist(itinerary: CountryItineraryRecord | null): TripChecklistItem[] {
  return itinerary?.workspaceSnapshot?.checklist ?? [];
}

export function createUserChecklistItem(tripId: string): TripChecklistItem {
  const now = new Date().toISOString();
  return {
    id: createId("checklist"),
    tripId,
    title: "",
    category: "other",
    dueDate: null,
    completed: false,
    source: "user",
    autoKey: null,
    linkedBookingId: null,
    linkedDocumentId: null,
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertChecklistItem(patchDraft: PatchDraft, item: TripChecklistItem) {
  patchDraft((current) => {
    const existing = checklist(current);
    const nextItem: TripChecklistItem = { ...item, updatedAt: new Date().toISOString() };
    return {
      ...current,
      workspaceSnapshot: {
        ...current.workspaceSnapshot,
        checklist: [...existing.filter((entry) => entry.id !== nextItem.id), nextItem],
      },
    };
  });
}

export function removeChecklistItem(patchDraft: PatchDraft, itemId: string) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      checklist: checklist(current).filter((entry) => entry.id !== itemId),
    },
  }));
}

interface AutoChecklistCandidate {
  autoKey: string;
  title: string;
  category: ChecklistCategory;
  linkedBookingId?: string | null;
}

function detectAutoCandidates(itinerary: CountryItineraryRecord, isoA2: string): AutoChecklistCandidate[] {
  const candidates: AutoChecklistCandidate[] = [];
  const allItems = itinerary.itineraryDays.flatMap((day) => day.items);
  const tripBookings = bookings(itinerary);

  const hasFlight =
    tripBookings.some((booking) => booking.type === "flight") ||
    allItems.some(
      (item) => item.category === "transportation" && /טיסה|flight/i.test(`${item.name} ${item.shortDescription}`)
    );
  if (hasFlight) {
    candidates.push({ autoKey: "flight-passport", title: "בדקו תוקף דרכון (לפחות 6 חודשים מיום הנסיעה)", category: "documents" });
    candidates.push({ autoKey: "flight-insurance", title: "הוסיפו ביטוח נסיעות", category: "health" });
    candidates.push({ autoKey: "flight-airport-transport", title: "תכננו הגעה לשדה התעופה", category: "transport" });
  }

  const carRentalBooking = tripBookings.find((booking) => booking.type === "car_rental");
  const hasCarRentalItem = allItems.some(
    (item) => item.category === "transportation" && /השכרת רכב|car rental|rental car/i.test(`${item.name} ${item.shortDescription}`)
  );
  if (carRentalBooking || hasCarRentalItem) {
    candidates.push({ autoKey: "car-rental-license", title: "בדקו רישיון נהיגה בתוקף", category: "documents" });
    candidates.push({ autoKey: "car-rental-permit", title: "בררו אם נדרש רישיון נהיגה בינלאומי ביעד", category: "documents" });
    candidates.push({
      autoKey: "car-rental-confirmation",
      title: "ודאו אישור השכרת הרכב",
      category: "bookings",
      linkedBookingId: carRentalBooking?.id ?? null,
    });
  }

  const reservedItems = allItems.filter((item) => item.reservationRequired && !item.bookingCompleted);
  for (const item of reservedItems.slice(0, 8)) {
    const linkedBooking = tripBookings.find((booking) => booking.itineraryItemId === item.id);
    candidates.push({
      autoKey: `reserve-item-${item.name.trim().toLowerCase()}`,
      title: `אשרו/הזמינו: ${item.name}`,
      category: "bookings",
      linkedBookingId: linkedBooking?.id ?? null,
    });
  }

  const currencyCode = getCountryCurrencyCode(isoA2);
  if (currencyCode && currencyCode !== "ILS") {
    candidates.push({
      autoKey: "currency-plan",
      title: `בדקו תוכנית תשלום/מזומן במטבע המקומי (${currencyCode})`,
      category: "money",
    });
  }

  return candidates;
}

/**
 * Regenerates the auto-sourced portion of the checklist from real trip data
 * (no AI). Matches existing auto items by autoKey and updates them in
 * place; adds newly-detected ones; NEVER deletes anything — a stale auto
 * item (its trigger no longer applies) is simply left for the user to
 * remove, and every source: "user" item is always kept untouched.
 */
export function regenerateSmartChecklist(patchDraft: PatchDraft, itinerary: CountryItineraryRecord, isoA2: string) {
  const candidates = detectAutoCandidates(itinerary, isoA2);
  const now = new Date().toISOString();

  patchDraft((current) => {
    const existing = checklist(current);
    const existingByAutoKey = new Map(existing.filter((item) => item.autoKey).map((item) => [item.autoKey!, item]));
    const seenAutoKeys = new Set<string>();
    const regenerated: TripChecklistItem[] = [];

    for (const candidate of candidates) {
      seenAutoKeys.add(candidate.autoKey);
      const match = existingByAutoKey.get(candidate.autoKey);
      if (match) {
        regenerated.push({
          ...match,
          title: candidate.title,
          category: candidate.category,
          linkedBookingId: candidate.linkedBookingId ?? match.linkedBookingId,
          updatedAt: now,
        });
        continue;
      }
      regenerated.push({
        id: createId("checklist"),
        tripId: itinerary.id,
        title: candidate.title,
        category: candidate.category,
        dueDate: null,
        completed: false,
        source: "auto",
        autoKey: candidate.autoKey,
        linkedBookingId: candidate.linkedBookingId ?? null,
        linkedDocumentId: null,
        notes: "",
        createdAt: now,
        updatedAt: now,
      });
    }

    const untouched = existing.filter(
      (item) => item.source === "user" || !item.autoKey || !seenAutoKeys.has(item.autoKey)
    );

    return {
      ...current,
      workspaceSnapshot: {
        ...current.workspaceSnapshot,
        checklist: [...regenerated, ...untouched],
      },
    };
  });
}

/**
 * Pure, render-time completion sync — auto items with a real linked booking
 * or document reflect that record's actual state; everything else
 * (unlinked auto items, all user items) is left exactly as the user set it.
 * Never infers completion from anything but a concrete linked record.
 */
export function syncChecklistCompletion(
  items: TripChecklistItem[],
  bookingList: TripBooking[],
  documentList: TripDocument[]
): TripChecklistItem[] {
  return items.map((item) => {
    if (item.source !== "auto") return item;

    if (item.linkedBookingId) {
      const booking = bookingList.find((entry) => entry.id === item.linkedBookingId);
      if (booking) {
        return { ...item, completed: booking.status === "booked" || booking.status === "reserved" };
      }
    }

    if (item.linkedDocumentId) {
      const exists = documentList.some((entry) => entry.id === item.linkedDocumentId);
      return { ...item, completed: exists };
    }

    return item;
  });
}

export function upcomingChecklistItems(items: TripChecklistItem[], limit = 5): TripChecklistItem[] {
  return items
    .filter((item) => !item.completed && item.dueDate)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, limit);
}
