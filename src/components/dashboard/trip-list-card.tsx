import { Skeleton } from "@/components/ui/skeleton";
import { formatTripDateRange } from "@/lib/format";
import type { TripHubTrip } from "@/lib/trip-hub";

interface TripListCardProps {
  title: string;
  trips: TripHubTrip[] | undefined;
  isLoading: boolean;
  emptyLabel: string;
  onOpen: (trip: TripHubTrip) => void;
}

export function TripListCard({ title, trips, isLoading, emptyLabel, onOpen }: TripListCardProps) {
  return (
    <section className="glass-card space-y-3 p-4">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : trips && trips.length > 0 ? (
        <ul className="space-y-2">
          {trips.map((trip) => (
            <li key={trip.id}>
              <button
                type="button"
                onClick={() => onOpen(trip)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-right transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <div className="flex items-center gap-2.5">
                  <Image
                    src={`/flags/${trip.isoA2.toLowerCase()}.png`}
                    alt={`דגל ${trip.countryName}`}
                    width={28}
                    height={20}
                    className="h-5 w-7 rounded-sm border border-border/50 object-cover shadow-sm"
                  />
                  <div>
                    <p className="text-sm font-medium">{trip.countryName}</p>
                    <p className="text-xs text-muted-foreground">
                      <bdi dir="ltr">
                        {formatTripDateRange(trip.startDate, trip.endDate, trip.itinerary.preferencesSnapshot.partialDate)}
                      </bdi>
                    </p>
                  </div>
                </div>
                {trip.displayCost != null && (
                  <span className="text-sm text-muted-foreground">₪{Math.round(trip.displayCost).toLocaleString("he-IL")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </section>
  );
}
import Image from "next/image";
