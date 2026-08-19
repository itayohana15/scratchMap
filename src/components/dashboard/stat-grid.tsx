import {
  Banknote,
  CalendarRange,
  Globe2,
  Heart,
  MapPinned,
  Plane,
  Star,
} from "lucide-react";

import { StatTile } from "@/components/dashboard/stat-tile";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatRating } from "@/lib/format";
import type { DashboardStats } from "@/lib/queries/dashboard";

interface StatGridProps {
  stats: DashboardStats | undefined;
  isLoading: boolean;
  countriesTotal: number | undefined;
}

export function StatGrid({ stats, isLoading, countriesTotal }: StatGridProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
    );
  }

  const tiles = [
    {
      label: "מדינות שביקרתם בהן",
      value: countriesTotal ? `${stats.countriesVisited} / ${countriesTotal}` : stats.countriesVisited,
      icon: Globe2,
    },
    { label: "מדינות מתוכננות", value: stats.countriesPlanned, icon: Globe2 },
    { label: "ערים שביקרתם בהן", value: stats.citiesVisited, icon: MapPinned },
    { label: "ערים מתוכננות", value: stats.citiesPlanned, icon: MapPinned },
    { label: "סה״כ טיולים", value: stats.totalTrips, icon: Plane },
    { label: "ימי טיול", value: stats.totalDaysTraveled, icon: CalendarRange },
    { label: "סה״כ הוצאות", value: formatCurrency(stats.totalExpenses), icon: Banknote },
    { label: "דירוג ממוצע", value: formatRating(stats.averageRating), icon: Star },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
      {stats.favoriteCountry && (
        <div className="glass-card col-span-2 flex items-center gap-3 p-4 sm:col-span-1">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Heart className="size-5" />
          </div>
          <div>
            <p className="text-lg font-semibold">{stats.favoriteCountry.name}</p>
            <p className="text-xs text-muted-foreground">מדינה מועדפת</p>
          </div>
        </div>
      )}
    </div>
  );
}
