import { Plane } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDateRange } from "@/lib/format";
import type { Tables } from "@/lib/supabase/types";

interface TripListCardProps {
  title: string;
  trips: Tables<"trips">[] | undefined;
  isLoading: boolean;
  emptyLabel: string;
}

export function TripListCard({ title, trips, isLoading, emptyLabel }: TripListCardProps) {
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
            <li
              key={trip.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <Plane className="size-4 text-primary" />
                <div>
                  <p className="text-sm font-medium">{trip.name}</p>
                  {formatDateRange(trip.start_date, trip.end_date) && (
                    <p className="text-xs text-muted-foreground">
                      {formatDateRange(trip.start_date, trip.end_date)}
                    </p>
                  )}
                </div>
              </div>
              {trip.cost != null && (
                <span className="text-sm text-muted-foreground">{formatCurrency(trip.cost)}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </section>
  );
}
