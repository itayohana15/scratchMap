"use client";

import { CalendarDays } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDateRange } from "@/lib/format";
import { useTripsForCountry } from "@/lib/queries/trips";

interface CountryTimelineSectionProps {
  countryId: string;
}

export function CountryTimelineSection({ countryId }: CountryTimelineSectionProps) {
  const { data: entries, isLoading } = useTripsForCountry(countryId);

  if (isLoading) return <Skeleton className="h-40 rounded-xl" />;

  if (!entries || entries.length === 0) {
    return (
      <div className="glass-card px-4 py-8 text-center text-sm text-muted-foreground">
        לא נרשמו טיולים למדינה הזו עדיין.
      </div>
    );
  }

  return (
    <ol className="space-y-3">
      {entries.map((entry) => (
        <li key={entry.id} className="glass-card flex items-start gap-3 p-4">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">{entry.trips.name}</p>
            <p className="text-xs text-muted-foreground">
              {entry.cities.name}
              {formatDateRange(entry.arrival_date, entry.departure_date) &&
                ` · ${formatDateRange(entry.arrival_date, entry.departure_date)}`}
            </p>
          </div>
          {entry.trips.cost != null && (
            <span className="text-sm text-muted-foreground">{formatCurrency(entry.trips.cost)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
