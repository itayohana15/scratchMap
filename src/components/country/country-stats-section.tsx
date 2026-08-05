"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { useCountryStats } from "@/lib/queries/stats";

interface CountryStatsSectionProps {
  countryId: string;
}

export function CountryStatsSection({ countryId }: CountryStatsSectionProps) {
  const { data: stats, isLoading } = useCountryStats(countryId);

  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  }

  const tiles = [
    { label: "ערים שביקרתם בהן", value: stats.citiesVisited },
    { label: "ערים מתוכננות", value: stats.citiesPlanned },
    { label: "טיולים", value: stats.tripCount },
    { label: "ימי טיול", value: stats.totalDays },
    { label: "עלות כוללת", value: formatCurrency(stats.totalCost) },
    { label: "תמונות", value: stats.photoCount },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="section-card p-4">
          <p className="text-2xl font-semibold">{tile.value}</p>
          <p className="text-xs text-muted-foreground">{tile.label}</p>
        </div>
      ))}
    </div>
  );
}
