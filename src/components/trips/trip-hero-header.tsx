"use client";

import { CountryBanner } from "@/components/shared/country-banner";
import type { CountryItineraryStatus } from "@/lib/itineraries";
import { formatTripDateRange, tripDurationDays } from "@/lib/format";
import { tripDestinationName, type TripHubTrip } from "@/lib/trip-hub";

export const ITINERARY_STATUS_LABELS: Record<CountryItineraryStatus, string> = {
  draft: "טיוטה",
  upcoming: "בקרוב",
  active: "פעיל",
  completed: "הושלם",
  archived: "בארכיון",
};

export function TripHeroHeader({ trip }: { trip: TripHubTrip }) {
  const { itinerary } = trip;
  const durationDays = tripDurationDays(itinerary.startDate, itinerary.endDate) ?? itinerary.daysCount;

  return (
    <CountryBanner
      isoA2={trip.isoA2}
      countryName={trip.countryName}
      showCaption={false}
      showFlagOverlay={false}
      className="h-56 rounded-[28px] sm:h-64"
      overlay={
        <div className="flex h-full flex-col items-start justify-end gap-1.5 p-5 sm:p-7">
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm">
            {ITINERARY_STATUS_LABELS[itinerary.status]}
          </span>
          <h1 className="font-heading text-2xl font-bold text-white drop-shadow-sm sm:text-4xl">
            {tripDestinationName(trip)}
          </h1>
          <p className="text-sm text-white/90 sm:text-base">
            <bdi dir="ltr">
              {formatTripDateRange(itinerary.startDate, itinerary.endDate, itinerary.preferencesSnapshot.partialDate)}
            </bdi>
          </p>
          <p className="text-xs text-white/75 sm:text-sm">
            {durationDays} ימים · {trip.travelers} נוסעים
          </p>
        </div>
      }
    />
  );
}
