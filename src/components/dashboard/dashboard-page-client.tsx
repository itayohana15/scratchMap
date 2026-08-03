"use client";

import { StatGrid } from "@/components/dashboard/stat-grid";
import { TripListCard } from "@/components/dashboard/trip-list-card";
import { useDashboardStats } from "@/lib/queries/dashboard";

export function DashboardPageClient() {
  const { data: stats, isLoading } = useDashboardStats();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">לוח בקרה</h1>
        <p className="text-sm text-muted-foreground">הטיולים שלכם במבט אחד.</p>
      </div>

      <StatGrid stats={stats} isLoading={isLoading} />

      <div className="grid gap-4 lg:grid-cols-2">
        <TripListCard
          title="טיולים אחרונים"
          trips={stats?.latestTrips}
          isLoading={isLoading}
          emptyLabel="אין עדיין טיולים שהושלמו."
        />
        <TripListCard
          title="טיולים קרובים"
          trips={stats?.upcomingTrips}
          isLoading={isLoading}
          emptyLabel="אין טיולים מתוכננים."
        />
      </div>
    </div>
  );
}
