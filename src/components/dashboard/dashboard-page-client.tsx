"use client";

import { useRouter } from "next/navigation";

import { StatGrid } from "@/components/dashboard/stat-grid";
import { TripListCard } from "@/components/dashboard/trip-list-card";
import { useWorldCountriesGeoJson } from "@/lib/map/geo";
import { useDashboardStats } from "@/lib/queries/dashboard";
import type { TripHubTrip } from "@/lib/trip-hub";

export function DashboardPageClient() {
  const router = useRouter();
  const { data: stats, isLoading } = useDashboardStats();
  const { data: worldCountries } = useWorldCountriesGeoJson();

  function openTrip(trip: TripHubTrip) {
    router.push(`/countries/${trip.isoA2.toLowerCase()}?itinerary=${trip.id}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">דף הבית</h1>
        <p className="text-sm text-muted-foreground">הטיולים שלכם במבט אחד.</p>
      </div>

      <StatGrid
        stats={stats}
        isLoading={isLoading}
        countriesTotal={worldCountries?.features.length}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <TripListCard
          title="טיולים אחרונים"
          trips={stats?.latestTrips}
          isLoading={isLoading}
          emptyLabel="אין עדיין טיולים שהושלמו."
          onOpen={openTrip}
        />
        <TripListCard
          title="טיולים קרובים"
          trips={stats?.upcomingTrips}
          isLoading={isLoading}
          emptyLabel="אין טיולים מתוכננים."
          onOpen={openTrip}
        />
      </div>
    </div>
  );
}
