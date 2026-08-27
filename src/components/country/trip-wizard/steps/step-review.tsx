"use client";

import { formatDate, formatCurrency, formatTripDateRange, tripDurationDays } from "@/lib/format";
import { hasActiveOverride } from "@/lib/trip-preference-overrides";
import { BOOKING_TYPE_LABELS, type TripFlightLeg, type TripPreferences } from "@/lib/trip-workspace";
import { FOOD_CHIPS } from "@/components/country/trip-wizard/steps/step-requirements";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

const TRIP_PACE_LABELS: Record<TripPreferences["tripPace"], string> = {
  relaxed: "רגוע",
  balanced: "מאוזן",
  fast: "אינטנסיבי",
};

const FOOD_INTEREST_LABELS = new Set(
  FOOD_CHIPS.filter((chip) => chip.category === "interest").map((chip) => chip.label)
);

// Item 29's compact "26.8 / TLV 20:25 → TBS 00:00 (+1)" layout.
function FlightSummaryRow({ leg }: { leg: TripFlightLeg }) {
  const arrivesNextDay = Boolean(leg.arrivalDate && leg.departureDate && leg.arrivalDate > leg.departureDate);
  return (
    <div className="text-sm">
      <p className="text-xs text-muted-foreground">{formatDate(leg.departureDate, "d.M") ?? "—"}</p>
      <bdi dir="ltr" className="flex items-center gap-2 font-medium text-foreground">
        <span>
          {leg.departureAirport || "?"} {leg.departureTime || "—"}
        </span>
        <span className="text-muted-foreground">→</span>
        <span>
          {leg.arrivalAirport || "?"} {leg.arrivalTime || "—"}
          {arrivesNextDay ? " (+1)" : ""}
        </span>
      </bdi>
    </div>
  );
}

export function StepReview({
  draft,
  countryName,
  derivedPace,
  derivedInterests,
}: {
  draft: TripCreationDraft;
  countryName: string;
  derivedPace: TripPreferences["tripPace"];
  derivedInterests: string;
}) {
  const { preferences, bookings, userProvidedTitle } = draft;
  const dateRange =
    preferences.startDate && preferences.endDate
      ? formatTripDateRange(preferences.startDate, preferences.endDate)
      : null;
  const durationDays = tripDurationDays(preferences.startDate, preferences.endDate);

  const foodInterestTags = preferences.interests
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => FOOD_INTEREST_LABELS.has(tag));
  const restrictionTags = preferences.dietaryPreferences
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const foodTags = [...restrictionTags, ...foodInterestTags];

  const overrides: string[] = [];
  if (preferences.tripPace !== derivedPace) overrides.push(`קצב: ${TRIP_PACE_LABELS[preferences.tripPace]}`);
  if (hasActiveOverride(preferences.interests, derivedInterests)) {
    overrides.push(`תחומי עניין: ${preferences.interests}`);
  }
  if (preferences.transportationPreferences.trim()) {
    overrides.push(`תחבורה: ${preferences.transportationPreferences}`);
  }

  return (
    <div className="space-y-4">
      <div className="section-card space-y-1 p-4">
        <p className="font-heading text-lg font-semibold">{userProvidedTitle || countryName}</p>
        <p className="text-sm text-muted-foreground">
          {dateRange ?? "תאריכים לא הוגדרו"}
          {durationDays ? ` · ${durationDays} ימים` : ""} · {preferences.travelers} נוסעים
          {preferences.budget != null ? ` · ${formatCurrency(preferences.budget)}` : ""}
        </p>
      </div>

      {preferences.flights?.outbound || preferences.flights?.return ? (
        <div className="section-card space-y-3 p-4">
          <p className="text-sm font-semibold">טיסות</p>
          {preferences.flights.outbound ? <FlightSummaryRow leg={preferences.flights.outbound} /> : null}
          {preferences.flights.return ? <FlightSummaryRow leg={preferences.flights.return} /> : null}
        </div>
      ) : null}

      {overrides.length > 0 ? (
        <div className="section-card space-y-1 p-4">
          <p className="mb-1 text-sm font-semibold">התאמות לטיול הזה</p>
          {overrides.map((line) => (
            <p key={line} className="text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {foodTags.length > 0 || preferences.foodNotes ? (
        <div className="section-card space-y-1 p-4">
          <p className="mb-1 text-sm font-semibold">אוכל</p>
          {foodTags.length > 0 ? <p className="text-sm text-muted-foreground">{foodTags.join(" · ")}</p> : null}
          {preferences.foodNotes ? <p className="text-sm text-muted-foreground">{preferences.foodNotes}</p> : null}
        </div>
      ) : null}

      {preferences.mustVisitPlaces || preferences.placesToAvoid ? (
        <div className="section-card space-y-1 p-4">
          <p className="mb-1 text-sm font-semibold">מקומות</p>
          {preferences.mustVisitPlaces ? (
            <p className="text-sm text-muted-foreground">חייב: {preferences.mustVisitPlaces}</p>
          ) : null}
          {preferences.placesToAvoid ? (
            <p className="text-sm text-muted-foreground">להימנע: {preferences.placesToAvoid}</p>
          ) : null}
        </div>
      ) : null}

      {(preferences.accessibilityNeeds || preferences.safetyConstraints) ? (
        <div className="section-card space-y-1 p-4">
          <p className="mb-1 text-sm font-semibold">דרישות מיוחדות</p>
          {preferences.accessibilityNeeds ? (
            <p className="text-sm text-muted-foreground">נגישות: {preferences.accessibilityNeeds}</p>
          ) : null}
          {preferences.safetyConstraints ? (
            <p className="text-sm text-muted-foreground">{preferences.safetyConstraints}</p>
          ) : null}
        </div>
      ) : null}

      {bookings.length > 0 ? (
        <div className="section-card space-y-1 p-4">
          <p className="mb-1 text-sm font-semibold">הזמנות</p>
          {bookings.map((booking) => (
            <p key={booking.id} className="text-sm text-muted-foreground">
              {BOOKING_TYPE_LABELS[booking.type]}
              {booking.title ? ` — ${booking.title}` : ""}
              {booking.startDateTime ? ` · ${booking.startDateTime}` : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
