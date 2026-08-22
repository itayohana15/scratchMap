import {
  Bike,
  Bus,
  Car,
  CarTaxiFront,
  Footprints,
  Plane,
  Route,
  Ship,
  TrainFront,
  TramFront,
  type LucideIcon,
} from "lucide-react";

import { ITEM_PRIORITY_LABELS, type TripBooking, type TripItineraryItem } from "@/lib/trip-workspace";

export interface BookingStatusGlyph {
  glyph: string;
  label: string;
  bookingId: string | null;
}

// Deterministic, category-based confidence tier (spec: never claim
// "must book" without supporting data) -- hotel/transportation items are
// structurally almost always booking-gated, everything else is a softer
// recommendation to double-check.
export function bookingRequirementLabel(item: Pick<TripItineraryItem, "category">): string {
  return item.category === "hotel" || item.category === "transportation" ? "חובה להזמין" : "בדיקת הזמנה מומלצת";
}

export function bookingStatusForItem(
  item: Pick<TripItineraryItem, "id" | "category" | "reservationRequired" | "bookingCompleted">,
  bookingList: TripBooking[]
): BookingStatusGlyph | null {
  if (!item.reservationRequired) return null;

  const linkedBooking = bookingList.find((booking) => booking.itineraryItemId === item.id && booking.status !== "cancelled");
  if (linkedBooking) {
    if (linkedBooking.paymentStatus === "paid") return { glyph: "💳", label: "שולם", bookingId: linkedBooking.id };
    if (linkedBooking.status === "booked" || linkedBooking.status === "reserved") {
      return { glyph: "✓", label: "הוזמן", bookingId: linkedBooking.id };
    }
    return { glyph: "⚠", label: "דרושה הזמנה", bookingId: linkedBooking.id };
  }

  if (item.bookingCompleted) return { glyph: "✓", label: "הוזמן", bookingId: null };
  return { glyph: "⚠", label: bookingRequirementLabel(item), bookingId: null };
}

export function activityStateBadges(item: TripItineraryItem) {
  const badges: Array<{ key: string; label: string }> = [];
  if (item.reservationRequired && item.bookingCompleted) {
    badges.push({ key: "booked", label: "הוזמן" });
  } else if (item.reservationRequired) {
    badges.push({ key: "reservation", label: "דורש הזמנה" });
  }
  badges.push({ key: "priority", label: ITEM_PRIORITY_LABELS[item.priority] });
  if (item.fixedTime) badges.push({ key: "fixedTime", label: "שעה קבועה" });
  if (item.locked) badges.push({ key: "locked", label: "נעול" });
  if (item.completed) badges.push({ key: "completed", label: "בוצע" });
  if (item.skipped) badges.push({ key: "skipped", label: "דולג" });
  if (item.spontaneous) badges.push({ key: "spontaneous", label: "נוסף במהלך הטיול" });
  if (item.favorite) badges.push({ key: "favorite", label: "מועדף" });
  return badges;
}

export function transportModeIcon(mode: string): LucideIcon {
  const lower = mode.toLowerCase();
  if (/walk|הליכ/.test(lower)) return Footprints;
  if (/metro|subway|תחתית|רכבת תחתית/.test(lower)) return TramFront;
  if (/train|רכבת/.test(lower)) return TrainFront;
  if (/bus|אוטובוס/.test(lower)) return Bus;
  if (/taxi|מונית|uber/.test(lower)) return CarTaxiFront;
  if (/car|רכב|נהיגה|drive/.test(lower)) return Car;
  if (/bike|bicycle|אופני/.test(lower)) return Bike;
  if (/ferry|מעבור|boat|סירה/.test(lower)) return Ship;
  if (/flight|טיסה|plane/.test(lower)) return Plane;
  return Route;
}
