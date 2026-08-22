import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  createId,
  type BookingStatus,
  type BookingType,
  type RecommendationCategory,
  type TripBooking,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";

type PatchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;

export function bookings(itinerary: CountryItineraryRecord | null): TripBooking[] {
  return itinerary?.workspaceSnapshot?.bookings ?? [];
}

export function createEmptyBooking(tripId: string): TripBooking {
  const now = new Date().toISOString();
  return {
    id: createId("booking"),
    tripId,
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
}

const BOOKING_TYPE_BY_CATEGORY: Partial<Record<RecommendationCategory, BookingType>> = {
  hotel: "accommodation",
  restaurant: "restaurant",
  transportation: "train",
};

/**
 * Pre-fills a new booking from an itinerary item that likely needs one
 * (used by the timeline's "הוסף הזמנה" action) -- title/type/location come
 * straight from the item so the user isn't retyping what's already known.
 */
export function createBookingLinkedToItem(tripId: string, dayId: string, item: TripItineraryItem): TripBooking {
  return {
    ...createEmptyBooking(tripId),
    dayId,
    itineraryItemId: item.id,
    type: BOOKING_TYPE_BY_CATEGORY[item.category] ?? "other",
    title: item.name,
    location: item.location,
    startDateTime: item.plannedStartTime,
  };
}

export function upsertBooking(patchDraft: PatchDraft, booking: TripBooking) {
  patchDraft((current) => {
    const existing = bookings(current);
    const nextBooking: TripBooking = { ...booking, updatedAt: new Date().toISOString() };
    return {
      ...current,
      workspaceSnapshot: {
        ...current.workspaceSnapshot,
        bookings: [...existing.filter((item) => item.id !== nextBooking.id), nextBooking],
      },
    };
  });
}

export function removeBooking(patchDraft: PatchDraft, bookingId: string) {
  patchDraft((current) => ({
    ...current,
    workspaceSnapshot: {
      ...current.workspaceSnapshot,
      bookings: bookings(current).filter((item) => item.id !== bookingId),
    },
  }));
}

const ACTIVE_BOOKING_STATUSES = new Set<BookingStatus>(["reserved", "booked"]);

export interface BookingSummary {
  total: number;
  needBooking: number;
  booked: number;
  paid: number;
  missing: number;
}

/**
 * "Missing" = an item that likely needs a booking (reservationRequired, not
 * yet marked bookingCompleted) with no linked TripBooking record at all —
 * distinct from "needBooking", which counts existing TripBooking rows that
 * simply haven't been booked yet.
 */
export function bookingSummary(bookingList: TripBooking[], days: TripItineraryDay[]): BookingSummary {
  const active = bookingList.filter((booking) => booking.status !== "cancelled" && booking.status !== "not_required");
  const linkedItemIds = new Set(bookingList.map((booking) => booking.itineraryItemId).filter(Boolean));
  const missingItems = days
    .flatMap((day) => day.items)
    .filter((item) => item.reservationRequired && !item.bookingCompleted && !linkedItemIds.has(item.id));

  return {
    total: active.length,
    needBooking: active.filter((booking) => booking.status === "not_booked" || booking.status === "booking_needed").length,
    booked: active.filter((booking) => ACTIVE_BOOKING_STATUSES.has(booking.status)).length,
    paid: active.filter((booking) => booking.paymentStatus === "paid").length,
    missing: missingItems.length,
  };
}

/**
 * Substitutes a linked booking's converted amount for that item's own
 * approximatePrice, so a booked/paid amount doesn't get double-counted
 * against the itinerary item's original AI estimate. Returns a derived copy
 * — never mutates the saved days — for feeding into summarizeItemCosts.
 */
export function applyBookingOverrides(days: TripItineraryDay[], bookingList: TripBooking[]): TripItineraryDay[] {
  const overrideByItemId = new Map<string, number>();
  for (const booking of bookingList) {
    if (booking.status === "cancelled") continue;
    if (!booking.itineraryItemId || booking.amountConverted == null) continue;
    overrideByItemId.set(booking.itineraryItemId, booking.amountConverted);
  }
  if (overrideByItemId.size === 0) return days;

  return days.map((day) => ({
    ...day,
    items: day.items.map((item) =>
      overrideByItemId.has(item.id) ? { ...item, approximatePrice: overrideByItemId.get(item.id)! } : item
    ),
  }));
}
