"use client";

import { ItineraryTripSummarySection } from "@/components/country/itinerary-route-map";
import { TripReadinessIndicator } from "@/components/trips/trip-readiness-indicator";
import { formatCurrency } from "@/lib/format";
import type { ReadinessCategory } from "@/lib/trip-readiness";
import type { TripHubTrip } from "@/lib/trip-hub";
import { computeTripBudgetSummary } from "@/lib/trip-budget";
import type { FlightBookingStatus, TripFlightLeg, TripItineraryDay, TripItineraryItem } from "@/lib/trip-workspace";
import { BOOKING_STATUS_LABELS } from "@/lib/trip-workspace";
import { bookings } from "@/lib/trip-bookings";
import { cn } from "@/lib/utils";

const FLIGHT_BOOKING_STATUS_LABELS: Record<FlightBookingStatus, string> = {
  not_booked: "לא הוזמן",
  booked: "הוזמן",
  paid: "שולם",
};

function FlightLegRow({ label, leg }: { label: string; leg: TripFlightLeg }) {
  const hasRoute = leg.departureAirport || leg.arrivalAirport;
  if (!hasRoute && !leg.departureDate) return null;

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground">{label}</span>
        <span className="flex items-center gap-2 font-medium">
          <bdi dir="ltr">
            {leg.departureAirport || "?"} → {leg.arrivalAirport || "?"}
          </bdi>
          <span className="text-xs text-muted-foreground">
            {leg.departureDate} {leg.departureTime}
          </span>
        </span>
      </summary>
      <div className="mt-1.5 space-y-1 rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
        {leg.airline || leg.flightNumber ? (
          <p>
            {leg.airline} {leg.flightNumber}
          </p>
        ) : null}
        <p>
          המראה: {leg.departureDate} {leg.departureTime} · נחיתה: {leg.arrivalDate} {leg.arrivalTime}
        </p>
        <p>
          מצב הזמנה: {FLIGHT_BOOKING_STATUS_LABELS[leg.bookingStatus]}
          {leg.cost != null ? ` · ${formatCurrency(leg.cost)}` : ""}
        </p>
      </div>
    </details>
  );
}

interface TripOverviewTabProps {
  trip: TripHubTrip;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
  onOpenDay: (dayId: string) => void;
  onReadinessIssueClick: (section: ReadinessCategory["section"]) => void;
}

export function TripOverviewTab({
  trip,
  onPatchDay,
  onPatchItem,
  onOpenDay,
  onReadinessIssueClick,
}: TripOverviewTabProps) {
  const { itinerary } = trip;
  const budgetSummary = computeTripBudgetSummary(itinerary);
  const flights = itinerary.preferencesSnapshot.flights;
  const openBookings = bookings(itinerary).filter(
    (booking) => booking.status !== "booked" && booking.status !== "not_required" && booking.status !== "cancelled"
  );
  const warnings = itinerary.itineraryDays.flatMap((day) =>
    day.warnings.map((warning) => ({ dayId: day.id, dayNumber: day.dayNumber, warning }))
  );

  return (
    <div className="space-y-5">
      {itinerary.summary ? (
        <p className="section-card p-4 text-sm leading-6 text-foreground/90">{itinerary.summary}</p>
      ) : null}

      <div className="section-card space-y-2 p-4">
        <p className="text-sm text-muted-foreground">
          יעדים: {trip.routeCities.join(" · ")}
        </p>
        <TripReadinessIndicator itinerary={itinerary} onIssueClick={onReadinessIssueClick} />
      </div>

      {flights?.outbound || flights?.return ? (
        <div className="section-card space-y-1 p-4">
          <h3 className="mb-1 font-heading text-base font-semibold">טיסות</h3>
          {flights.outbound ? <FlightLegRow label="הלוך" leg={flights.outbound} /> : null}
          {flights.return ? <FlightLegRow label="חזור" leg={flights.return} /> : null}
        </div>
      ) : null}

      {openBookings.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <h3 className="font-heading text-base font-semibold">הזמנות פתוחות</h3>
          <ul className="space-y-1.5">
            {openBookings.slice(0, 5).map((booking) => (
              <li key={booking.id} className="flex items-center justify-between text-sm">
                <span>{booking.title || booking.provider || booking.type}</span>
                <span className="text-xs text-muted-foreground">{BOOKING_STATUS_LABELS[booking.status]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <h3 className="font-heading text-base font-semibold">אזהרות עיקריות</h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {warnings.slice(0, 5).map((entry, index) => (
              <li key={`${entry.dayId}-${index}`}>
                <button
                  type="button"
                  className="text-right underline-offset-4 transition-colors hover:text-primary hover:underline"
                  onClick={() => onOpenDay(entry.dayId)}
                >
                  יום {entry.dayNumber}: {entry.warning}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="section-card space-y-2 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-heading text-base font-semibold">תקציב</h3>
          <span className={cn("text-sm font-semibold", budgetSummary.isOverBudget && "text-destructive")}>
            {budgetSummary.isOverBudget
              ? `חריגה של ${formatCurrency(budgetSummary.overBudgetAmount)}`
              : budgetSummary.remaining != null
                ? `נותר ${formatCurrency(budgetSummary.remaining)}`
                : formatCurrency(itinerary.costSummary.totalEstimatedCost)}
          </span>
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-heading text-base font-semibold">תצוגת מסלול</h3>
        <ItineraryTripSummarySection
          days={itinerary.itineraryDays}
          countryName={trip.countryName}
          isoA2={trip.isoA2}
          onPatchDay={onPatchDay}
          onPatchItem={onPatchItem}
          onOpenDay={onOpenDay}
        />
      </div>
    </div>
  );
}
