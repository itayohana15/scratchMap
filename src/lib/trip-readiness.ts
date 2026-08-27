import type { CountryItineraryRecord, CountryItineraryStatus } from "@/lib/itineraries";
import { isIntercityTransferDay } from "@/lib/server/itinerary-generation-constraints";
import { bookings } from "@/lib/trip-bookings";
import { checklist } from "@/lib/trip-checklist";
import { documents } from "@/lib/trip-documents";
import { packingList, requiredPackingStatus } from "@/lib/packing";
import type { TripDocumentType } from "@/lib/trip-workspace";

export type ReadinessStatus = "complete" | "partial" | "missing" | "not_applicable";

export interface ReadinessCategory {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  /** Which trip section clicking this category's warning should open. */
  section: "route" | "bookings" | "wallet" | "checklist" | "trip_summary" | "packing";
}

export interface TripReadiness {
  overallPercent: number;
  categories: ReadinessCategory[];
}

const CATEGORY_WEIGHT: Record<ReadinessStatus, number> = {
  complete: 1,
  partial: 0.5,
  missing: 0,
  not_applicable: 0,
};

// Deterministic only — readiness is never asked of the AI. Historical/
// completed trips don't get a readiness score at all (spec: readiness is
// for planning/upcoming/active trips).
export function isReadinessApplicable(status: CountryItineraryStatus): boolean {
  return status !== "completed" && status !== "archived";
}

const DOCUMENT_TYPE_FOR_INSURANCE: TripDocumentType = "insurance";

export function computeTripReadiness(itinerary: CountryItineraryRecord): TripReadiness {
  const days = itinerary.itineraryDays;
  const allItems = days.flatMap((day) => day.items);
  const tripBookings = bookings(itinerary);
  const activeBookings = tripBookings.filter((booking) => booking.status !== "cancelled");
  const tripDocuments = documents(itinerary);
  const tripChecklist = checklist(itinerary);

  const categories: ReadinessCategory[] = [];

  // Flights
  const flightBookings = activeBookings.filter((booking) => booking.type === "flight");
  categories.push(
    flightBookings.length === 0
      ? { key: "flights", label: "טיסות", status: "missing", detail: "לא נוספה הזמנת טיסה.", section: "bookings" }
      : {
          key: "flights",
          label: "טיסות",
          status: flightBookings.every((booking) => booking.status === "booked") ? "complete" : "partial",
          detail: `${flightBookings.filter((booking) => booking.status === "booked").length}/${flightBookings.length} טיסות הוזמנו.`,
          section: "bookings",
        }
  );

  // Accommodation
  const daysNeedingAccommodation = days.filter((day) => day.items.length > 0);
  const daysWithAccommodation = daysNeedingAccommodation.filter((day) => day.accommodation.trim().length > 0);
  categories.push(
    daysNeedingAccommodation.length === 0
      ? { key: "accommodation", label: "מלונות", status: "not_applicable", detail: "", section: "route" }
      : {
          key: "accommodation",
          label: "מלונות",
          status:
            daysWithAccommodation.length === daysNeedingAccommodation.length
              ? "complete"
              : daysWithAccommodation.length > 0
                ? "partial"
                : "missing",
          detail: `${daysWithAccommodation.length}/${daysNeedingAccommodation.length} ימים עם לינה מוגדרת.`,
          section: "route",
        }
  );

  // Main itinerary
  const daysWithItems = days.filter((day) => day.items.length > 0);
  categories.push({
    key: "itinerary",
    label: "מסלול",
    status: days.length === 0 ? "missing" : daysWithItems.length === days.length ? "complete" : "partial",
    detail: `${daysWithItems.length}/${days.length} ימים עם פעילויות.`,
    section: "route",
  });

  // Day load — deterministic only (spec Part F1/F2): flags days that are
  // genuinely too dense to safely execute. Unlike the removed pre-generation
  // "SmartPlanningInsights" heuristic this never suggests the AI should have
  // added a specific nearby stop — that's the generator's job, not a
  // readiness issue for the traveler to act on.
  const overloadedDays = days.filter((day) => {
    const totalMinutes = day.items.reduce(
      (sum, item) => sum + (item.estimatedDurationMinutes ?? 90) + (item.travelMinutes ?? 0),
      0
    );
    return day.items.length > 5 || totalMinutes > 540;
  });
  categories.push(
    days.length === 0
      ? { key: "day_load", label: "עומס ימים", status: "not_applicable", detail: "", section: "route" }
      : {
          key: "day_load",
          label: "עומס ימים",
          status: overloadedDays.length === 0 ? "complete" : "partial",
          detail:
            overloadedDays.length === 0
              ? "העומס בכל הימים סביר."
              : `${overloadedDays.length} ימים עמוסים יחסית: ${overloadedDays.map((day) => day.title).join(", ")}.`,
          section: "route",
        }
  );

  // Long travel segments — days with an unusually long single travel leg,
  // excluding intercity transfer days (already an expected long-travel day).
  const LONG_TRAVEL_MINUTES = 90;
  const daysWithLongTravel = days.filter(
    (day) => !isIntercityTransferDay(day) && day.items.some((item) => (item.travelMinutes ?? 0) > LONG_TRAVEL_MINUTES)
  );
  categories.push(
    days.length === 0
      ? { key: "travel_time", label: "זמני נסיעה", status: "not_applicable", detail: "", section: "route" }
      : {
          key: "travel_time",
          label: "זמני נסיעה",
          status: daysWithLongTravel.length === 0 ? "complete" : "partial",
          detail:
            daysWithLongTravel.length === 0
              ? "אין נסיעות ארוכות במיוחד בתוך הימים."
              : `נסיעה ארוכה ב-${daysWithLongTravel.length} ימים: ${daysWithLongTravel.map((day) => day.title).join(", ")}.`,
          section: "route",
        }
  );

  // Intercity transportation
  const transferDays = days.filter((day) => isIntercityTransferDay(day));
  const transferDayHasTransport = (day: (typeof days)[number]) =>
    activeBookings.some((booking) => booking.dayId === day.id && ["train", "bus", "ferry", "flight"].includes(booking.type)) ||
    day.items.some((item) => item.category === "transportation");
  categories.push(
    transferDays.length === 0
      ? { key: "intercity", label: "מעברים בין ערים", status: "not_applicable", detail: "", section: "route" }
      : {
          key: "intercity",
          label: "מעברים בין ערים",
          status: transferDays.every(transferDayHasTransport)
            ? "complete"
            : transferDays.some(transferDayHasTransport)
              ? "partial"
              : "missing",
          detail: `${transferDays.filter(transferDayHasTransport).length}/${transferDays.length} ימי מעבר עם תחבורה מוגדרת.`,
          section: "route",
        }
  );

  // Required bookings
  const linkedItemIds = new Set(activeBookings.map((booking) => booking.itineraryItemId).filter(Boolean));
  const requiresBooking = allItems.filter((item) => item.reservationRequired);
  const satisfied = requiresBooking.filter((item) => item.bookingCompleted || linkedItemIds.has(item.id));
  categories.push(
    requiresBooking.length === 0
      ? { key: "required_bookings", label: "הזמנות נדרשות", status: "not_applicable", detail: "", section: "bookings" }
      : {
          key: "required_bookings",
          label: "הזמנות נדרשות",
          status:
            satisfied.length === requiresBooking.length ? "complete" : satisfied.length > 0 ? "partial" : "missing",
          detail: `${requiresBooking.length - satisfied.length} הזמנות חסרות מתוך ${requiresBooking.length}.`,
          section: "bookings",
        }
  );

  // Documents (general) & Insurance (specific document type)
  categories.push({
    key: "documents",
    label: "מסמכים",
    status: tripDocuments.length === 0 ? "missing" : "complete",
    detail: tripDocuments.length === 0 ? "לא נשמרו מסמכים לטיול." : `${tripDocuments.length} מסמכים נשמרו.`,
    section: "wallet",
  });
  const hasInsurance = tripDocuments.some((document) => document.type === DOCUMENT_TYPE_FOR_INSURANCE);
  categories.push({
    key: "insurance",
    label: "ביטוח נסיעות",
    status: hasInsurance ? "complete" : "missing",
    detail: hasInsurance ? "מסמך ביטוח נמצא." : "לא נוסף מסמך ביטוח.",
    section: "wallet",
  });

  // Budget
  const budget = itinerary.budget;
  const estimated = itinerary.costSummary.totalEstimatedCost;
  categories.push(
    budget == null || estimated == null
      ? { key: "budget", label: "תקציב", status: "not_applicable", detail: "", section: "trip_summary" }
      : {
          key: "budget",
          label: "תקציב",
          status: estimated <= budget * 1.05 ? "complete" : "partial",
          detail: `${Math.round(estimated).toLocaleString("he-IL")} מתוך ${Math.round(budget).toLocaleString("he-IL")} ₪.`,
          section: "trip_summary",
        }
  );

  // Packing (Stage 5) — sourced from the real Smart Packing list, and only
  // required items count toward completeness (spec: optional suggestions
  // never block 100%).
  const tripPackingItems = packingList(itinerary);
  const requiredItems = tripPackingItems.filter((item) => item.required);
  categories.push(
    requiredItems.length === 0
      ? { key: "packing", label: "אריזה", status: "not_applicable", detail: "", section: "checklist" }
      : {
          key: "packing",
          label: "אריזה",
          status: requiredPackingStatus(tripPackingItems),
          detail: `${requiredItems.filter((item) => item.packed).length}/${requiredItems.length} פריטי אריזה נדרשים ארוזים.`,
          section: "packing",
        }
  );

  // Pre-trip checklist (everything except packing, already scored above)
  const relevantChecklist = tripChecklist.filter((item) => item.category !== "packing");
  categories.push(
    relevantChecklist.length === 0
      ? { key: "checklist", label: "צ'קליסט לפני הטיול", status: "not_applicable", detail: "", section: "checklist" }
      : {
          key: "checklist",
          label: "צ'קליסט לפני הטיול",
          status: relevantChecklist.every((item) => item.completed)
            ? "complete"
            : relevantChecklist.some((item) => item.completed)
              ? "partial"
              : "missing",
          detail: `${relevantChecklist.filter((item) => item.completed).length}/${relevantChecklist.length} משימות הושלמו.`,
          section: "checklist",
        }
  );

  const applicable = categories.filter((category) => category.status !== "not_applicable");
  const overallPercent =
    applicable.length === 0
      ? 100
      : Math.round((applicable.reduce((sum, category) => sum + CATEGORY_WEIGHT[category.status], 0) / applicable.length) * 100);

  return { overallPercent, categories };
}
