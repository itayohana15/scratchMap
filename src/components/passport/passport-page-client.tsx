"use client";

import { CalendarRange, Globe2, MapPinned, Sparkles, Stamp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { CountryStampCard } from "@/components/passport/country-stamp-card";
import { PassportWorldMap } from "@/components/passport/passport-world-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { useTripHubTrips } from "@/lib/queries/trip-hub";
import { useTripRatingsForItineraries } from "@/lib/queries/trip-ratings";
import {
  buildGlobalTimeline,
  computePassportStats,
  continentForIso,
  deriveCountryMapStatuses,
  favoriteCountries,
  firstRecordedTrip,
  groupTripsByCountry,
  longestKnownTrip,
  mostActiveYear,
  mostRecentTrip,
  mostVisitedCity,
  mostVisitedCountry,
} from "@/lib/travel-passport";

type PassportFilter = "all" | "visited" | "upcoming" | "favorites";

export function PassportPageClient() {
  const { data: trips = [], isLoading } = useTripHubTrips();
  const [filter, setFilter] = useState<PassportFilter>("all");
  const [continentFilter, setContinentFilter] = useState("all");
  const [selectedIso, setSelectedIso] = useState<string | null>(null);

  const completedIds = useMemo(() => trips.filter((trip) => trip.status === "completed").map((trip) => trip.id), [trips]);
  const { data: ratingRows = [] } = useTripRatingsForItineraries(completedIds);
  const overallRatingByItineraryId = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const row of ratingRows) map.set(row.itinerary_id, row.overall);
    return map;
  }, [ratingRows]);

  const groups = useMemo(() => groupTripsByCountry(trips), [trips]);
  const stats = useMemo(() => computePassportStats(trips), [trips]);
  const mapStatuses = useMemo(() => deriveCountryMapStatuses(trips), [trips]);
  const timeline = useMemo(() => buildGlobalTimeline(trips), [trips]);
  const favorites = useMemo(() => favoriteCountries(trips, overallRatingByItineraryId), [trips, overallRatingByItineraryId]);
  const activeTrip = trips.find((trip) => trip.status === "active");

  const streaks = useMemo(
    () => ({
      mostVisitedCountry: mostVisitedCountry(trips),
      mostVisitedCity: mostVisitedCity(trips),
      longestTrip: longestKnownTrip(trips),
      mostActiveYear: mostActiveYear(trips),
      firstTrip: firstRecordedTrip(trips),
      lastTrip: mostRecentTrip(trips),
    }),
    [trips]
  );

  const favoriteIsoSet = useMemo(() => new Set(favorites.slice(0, 5).map((entry) => entry.isoA2)), [favorites]);

  const continents = useMemo(() => {
    const set = new Set<string>();
    for (const group of groups.values()) {
      const continent = continentForIso(group.isoA2);
      if (continent) set.add(continent);
    }
    return [...set].sort();
  }, [groups]);

  const visibleGroups = useMemo(() => {
    return [...groups.values()].filter((group) => {
      if (filter === "visited" && group.completedTrips.length === 0) return false;
      if (filter === "upcoming" && !group.isUpcoming) return false;
      if (filter === "favorites" && !favoriteIsoSet.has(group.isoA2)) return false;
      if (continentFilter !== "all" && continentForIso(group.isoA2) !== continentFilter) return false;
      return true;
    });
  }, [groups, filter, favoriteIsoSet, continentFilter]);

  const selectedGroup = selectedIso ? groups.get(selectedIso) : null;

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (trips.length === 0) {
    return (
      <div className="section-card p-8 text-center text-sm text-muted-foreground">
        עדיין אין טיולים שמורים. ברגע שתתחילו לתעד טיולים, הדרכון שלכם יופיע כאן.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Stamp className="size-6" />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">דרכון הטיולים שלי</h1>
          <p className="text-sm text-muted-foreground">כל היעדים, כל הביקורים — במקום אחד.</p>
        </div>
      </div>

      {activeTrip ? (
        <div className="section-card flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/8 p-4">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1.5">
              <Sparkles className="size-3.5" />
              בטיול עכשיו
            </Badge>
            <span className="text-sm font-medium text-foreground">{activeTrip.countryName}</span>
          </div>
          <Button size="sm" render={<Link href={`/countries/${activeTrip.isoA2.toLowerCase()}?itinerary=${activeTrip.id}`} />}>
            פתח את מצב הטיול
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="מדינות" value={`${stats.countriesVisited}`} icon={MapPinned} />
        <StatTile label="טיולים" value={`${stats.tripsCompleted}`} icon={Stamp} />
        <StatTile label="יבשות" value={`${stats.continents}`} icon={Globe2} />
        <StatTile label="ערים" value={`${stats.citiesVisited}`} icon={MapPinned} />
        <StatTile
          label="ימי טיול ידועים"
          value={`${stats.knownTravelDays.value}${stats.knownTravelDays.isPartial ? "+" : ""}`}
          icon={CalendarRange}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([
          { value: "all", label: "הכל" },
          { value: "visited", label: "מדינות שביקרתי" },
          { value: "upcoming", label: "קרובות" },
          { value: "favorites", label: "מועדפות" },
        ] as const).map((option) => (
          <Button
            key={option.value}
            variant={filter === option.value ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <Select value={continentFilter} onValueChange={(value) => setContinentFilter(value ?? "all")}>
          <SelectTrigger size="sm" className="w-40">
            <span>{continentFilter === "all" ? "כל היבשות" : continentFilter}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">כל היבשות</SelectItem>
            {continents.map((continent) => (
              <SelectItem key={continent} value={continent}>
                {continent}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <PassportWorldMap statuses={mapStatuses} onCountryClick={setSelectedIso} />

      {selectedGroup ? (
        <div className="section-card space-y-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-heading text-lg font-semibold">{selectedGroup.countryName}</h3>
            <Button size="sm" render={<Link href={`/countries/${selectedGroup.isoA2.toLowerCase()}`} />}>
              פתח את המדינה
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {selectedGroup.completedTrips.length} טיולים
            {selectedGroup.visitYears.length > 0 ? ` · ${selectedGroup.visitYears.join(", ")}` : ""}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {visibleGroups.map((group) => (
          <CountryStampCard key={group.isoA2} group={group} />
        ))}
      </div>

      {timeline.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <h3 className="font-heading text-lg font-semibold">ציר הזמן שלי</h3>
          <div className="space-y-2">
            {timeline.map((entry) => (
              <Link
                key={entry.trip.id}
                href={`/countries/${entry.trip.isoA2.toLowerCase()}?itinerary=${entry.trip.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 p-3 text-sm transition-colors hover:border-primary/40"
              >
                <span className="font-medium text-foreground">{entry.year} — {entry.trip.countryName}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(entry.trip.startDate, "d בMMM yyyy") ?? entry.trip.title}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="section-card space-y-3 p-4">
        <h3 className="font-heading text-lg font-semibold">סטטיסטיקות</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <StreakTile label="המדינה המבוקרת ביותר" value={streaks.mostVisitedCountry ? `${streaks.mostVisitedCountry.countryName} (${streaks.mostVisitedCountry.tripCount})` : null} />
          <StreakTile label="העיר המבוקרת ביותר" value={streaks.mostVisitedCity ? `${streaks.mostVisitedCity.city} (${streaks.mostVisitedCity.tripCount})` : null} />
          <StreakTile label="הטיול הארוך ביותר" value={streaks.longestTrip ? `${streaks.longestTrip.countryName} (${streaks.longestTrip.daysCount} ימים)` : null} />
          <StreakTile label="שנת הטיולים הפעילה ביותר" value={streaks.mostActiveYear ? `${streaks.mostActiveYear.year} (${streaks.mostActiveYear.tripCount})` : null} />
          <StreakTile label="הטיול הראשון" value={streaks.firstTrip ? streaks.firstTrip.countryName : null} />
          <StreakTile label="הטיול האחרון" value={streaks.lastTrip ? streaks.lastTrip.countryName : null} />
        </div>
      </div>

      {favorites.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <h3 className="font-heading text-lg font-semibold">המדינות המדורגות הכי גבוה</h3>
          <div className="flex flex-wrap gap-2">
            {favorites.slice(0, 5).map((entry) => (
              <Badge key={entry.isoA2} variant="secondary">
                {entry.countryName} · {entry.averageRating.toFixed(1)}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatTile({ label, value, icon: Icon }: { label: string; value: string; icon: typeof MapPinned }) {
  return (
    <div className="section-card flex items-center gap-3 p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-xl font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function StreakTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background/60 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value ?? "—"}</p>
    </div>
  );
}
