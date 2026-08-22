"use client";

import {
  CalendarRange,
  Clock3,
  type LucideIcon,
  Luggage,
  MapPinned,
  Route,
  Search,
  Sparkles,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { CountryItineraryDetailsDialog } from "@/components/country/country-itinerary-details-dialog";
import { CountryBanner } from "@/components/shared/country-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
import { useItineraryDialogController } from "@/lib/hooks/use-itinerary-dialog-controller";
import { photoPublicUrl, usePhotosForItineraries } from "@/lib/queries/photos";
import { useTripHubTrips } from "@/lib/queries/trip-hub";
import {
  getTripDurationBucket,
  getTripHubYear,
  TRIP_DURATION_LABELS,
  TRIP_HUB_STATUS_LABELS,
  type TripDurationFilter,
  type TripHubStatus,
  type TripHubTrip,
} from "@/lib/trip-hub";
import { cn } from "@/lib/utils";

type TripFilter = "all" | TripHubStatus;
type SortOption =
  | "newest_created"
  | "nearest_upcoming"
  | "most_recently_completed"
  | "longest_trip"
  | "highest_cost";
type ViewMode = "cards" | "timeline";

const FILTER_OPTIONS: Array<{ value: TripFilter; label: string }> = [
  { value: "all", label: "הכל" },
  { value: "planning", label: "בתכנון" },
  { value: "upcoming", label: "קרובים" },
  { value: "active", label: "פעילים" },
  { value: "completed", label: "הושלמו" },
  { value: "archived", label: "בארכיון" },
];

const SORT_LABELS: Record<SortOption, string> = {
  newest_created: "הכי חדשים",
  nearest_upcoming: "הטיול הקרוב ביותר",
  most_recently_completed: "הושלם לאחרונה",
  longest_trip: "הטיול הארוך ביותר",
  highest_cost: "העלות הגבוהה ביותר",
};

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function statusBadgeClass(status: TripHubStatus) {
  switch (status) {
    case "planning":
      return "border-border bg-secondary text-secondary-foreground";
    case "upcoming":
      return "border-warning/20 bg-warning/10 text-warning";
    case "active":
      return "border-primary/20 bg-primary/10 text-primary";
    case "completed":
      return "border-success/20 bg-success/10 text-success";
    case "archived":
      return "border-border bg-muted text-muted-foreground";
  }
}

function tripAccent(status: TripHubStatus) {
  switch (status) {
    case "planning":
      return "before:bg-secondary/70";
    case "upcoming":
      return "before:bg-warning/75";
    case "active":
      return "before:bg-primary/80";
    case "completed":
      return "before:bg-success/80";
    case "archived":
      return "before:bg-muted-foreground/50";
  }
}

function headlineForTrip(trip: TripHubTrip) {
  if (trip.status === "upcoming" && trip.countdownDays != null) {
    return trip.countdownDays === 0 ? "מתחילים היום" : `עוד ${trip.countdownDays} ימים`;
  }

  if (trip.status === "active" && trip.currentDayNumber) {
    return `היום: יום ${trip.currentDayNumber} מתוך ${trip.daysCount}`;
  }

  if (trip.status === "completed") return "הושלם";
  if (trip.status === "archived") return "נשמר בארכיון";
  return "טיוטה בתכנון";
}

function costLine(trip: TripHubTrip) {
  if (trip.actualCost != null) return formatCurrency(trip.actualCost);
  if (trip.displayCost != null) return formatCurrency(trip.displayCost);
  return "ללא עלות שמורה";
}

function matchesSearch(trip: TripHubTrip, query: string) {
  if (!query) return true;
  const haystack = [
    trip.title,
    trip.countryName,
    trip.routeCities.join(" "),
    trip.workspace.summary.overallTripSummary,
    trip.itinerary.summary,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function compareTrips(a: TripHubTrip, b: TripHubTrip, sortBy: SortOption) {
  if (a.status === "active" && b.status !== "active") return -1;
  if (b.status === "active" && a.status !== "active") return 1;

  switch (sortBy) {
    case "newest_created":
      return b.createdAt.localeCompare(a.createdAt);
    case "nearest_upcoming": {
      const rank = { upcoming: 0, planning: 1, completed: 2, archived: 3, active: -1 } as const;
      const rankDiff = rank[a.status] - rank[b.status];
      if (rankDiff !== 0) return rankDiff;
      return a.sortDate.localeCompare(b.sortDate);
    }
    case "most_recently_completed":
      return b.sortDate.localeCompare(a.sortDate);
    case "longest_trip":
      return b.daysCount - a.daysCount || b.updatedAt.localeCompare(a.updatedAt);
    case "highest_cost":
      return (b.displayCost ?? -1) - (a.displayCost ?? -1) || b.updatedAt.localeCompare(a.updatedAt);
  }
}

function groupTripsByYear(trips: TripHubTrip[]) {
  return trips.reduce<Record<string, TripHubTrip[]>>((groups, trip) => {
    const year = getTripHubYear(trip);
    groups[year] ??= [];
    groups[year].push(trip);
    return groups;
  }, {});
}

function SummaryCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
}) {
  return (
    <div className="glass-card flex items-center gap-3 p-4">
      <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="font-heading text-xl font-semibold">{value}</p>
      </div>
    </div>
  );
}

function UpcomingTripCard({
  trip,
  onOpen,
  onOpenCountryPage,
}: {
  trip: TripHubTrip;
  onOpen: (trip: TripHubTrip) => void;
  onOpenCountryPage: (trip: TripHubTrip) => void;
}) {
  return (
    <article
      onClick={() => onOpen(trip)}
      className="section-card group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-1 hover:border-primary/35"
    >
      <CountryBanner
        isoA2={trip.isoA2}
        countryName={trip.countryName}
        className="h-52 rounded-none"
        showCaption={false}
        overlay={
          <div className="flex h-full flex-col justify-end bg-gradient-to-t from-black/75 via-black/15 to-transparent p-5 text-white">
            <div className="space-y-2">
              <Badge className={cn("w-fit border", statusBadgeClass(trip.status))}>
                {headlineForTrip(trip)}
              </Badge>
              <div>
                <p className="text-sm text-white/80">{trip.countryName}</p>
                <h3 className="font-heading text-2xl font-semibold">{trip.title}</h3>
              </div>
              <p className="text-sm text-white/90">
                {formatDateRange(trip.startDate, trip.endDate) ?? "ללא תאריכים"}
              </p>
            </div>
          </div>
        }
      />

      <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">ימים</p>
            <p className="mt-1 text-sm font-medium">{trip.daysCount}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">נוסעים</p>
            <p className="mt-1 text-sm font-medium">{trip.travelers}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">תקציב משוער</p>
            <p className="mt-1 text-sm font-medium">{costLine(trip)}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">השלמת תכנון</p>
            <p className="mt-1 text-sm font-medium">
              {trip.planningCompletionPercentage != null ? `${trip.planningCompletionPercentage}%` : "—"}
            </p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">ימי מסלול שנוצרו</p>
            <p className="mt-1 text-sm font-medium">{trip.itineraryDaysGenerated}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
          <Button variant="outline" onClick={() => onOpen(trip)}>
            פתח טיול
          </Button>
          <Button onClick={() => onOpenCountryPage(trip)}>המשך תכנון</Button>
        </div>
      </div>
    </article>
  );
}

function HistoryTripCard({
  trip,
  favoritePhotoUrl,
  onOpen,
  onOpenCountryPage,
}: {
  trip: TripHubTrip;
  favoritePhotoUrl?: string;
  onOpen: (trip: TripHubTrip) => void;
  onOpenCountryPage: (trip: TripHubTrip) => void;
}) {
  const bannerOverlay = (
    <div className="flex h-full items-start justify-between gap-3 p-4 text-white">
      <Badge className={cn("border", statusBadgeClass(trip.status))}>
        {trip.status === "active" ? "בטיול עכשיו" : TRIP_HUB_STATUS_LABELS[trip.status]}
      </Badge>
      <div className="rounded-full bg-black/25 px-3 py-1 text-xs backdrop-blur-sm">
        {headlineForTrip(trip)}
      </div>
    </div>
  );

  return (
    <article
      onClick={() => onOpen(trip)}
      className={cn(
        "section-card group relative cursor-pointer overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:border-primary/35",
        "before:absolute before:right-0 before:top-0 before:h-full before:w-1.5",
        tripAccent(trip.status),
        trip.status === "archived" && "opacity-80"
      )}
    >
      {favoritePhotoUrl ? (
        <div className="relative h-40 w-full overflow-hidden bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={favoritePhotoUrl} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
          {bannerOverlay}
        </div>
      ) : (
        <CountryBanner
          isoA2={trip.isoA2}
          countryName={trip.countryName}
          className="h-40 rounded-none"
          showCaption={false}
          scrimClassName="bg-gradient-to-t from-black/65 via-black/10 to-transparent"
          overlay={bannerOverlay}
        />
      )}

      <div className="space-y-4 p-5">
        <div>
          <p className="text-sm text-muted-foreground">{trip.countryName}</p>
          <h3 className="font-heading text-xl font-semibold">{trip.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDateRange(trip.startDate, trip.endDate) ?? "ללא תאריכים"}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">משך</p>
            <p className="mt-1 text-sm font-medium">{trip.daysCount} ימים</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">ערים</p>
            <p className="mt-1 text-sm font-medium">{trip.cityCount}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">
              {trip.actualCost != null ? "עלות בפועל" : "עלות / תקציב"}
            </p>
            <p className="mt-1 text-sm font-medium">{costLine(trip)}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">נוסעים</p>
            <p className="mt-1 text-sm font-medium">{trip.travelers}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">עודכן לאחרונה</p>
            <p className="mt-1 text-sm font-medium">{formatDate(trip.updatedAt, "d בMMM yyyy") ?? "—"}</p>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/60 p-3">
            <p className="text-xs text-muted-foreground">תכנון מסלול</p>
            <p className="mt-1 text-sm font-medium">
              {trip.planningCompletionPercentage != null ? `${trip.planningCompletionPercentage}%` : "—"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {trip.routePreviewCities.map((city) => (
            <span
              key={`${trip.id}-${city}`}
              className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              {city}
            </span>
          ))}
        </div>

        {trip.isHistorical && trip.itineraryDaysGenerated === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border/60 bg-muted/30 p-3">
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              טיול היסטורי
            </span>
            <span className="text-xs text-muted-foreground">אפשר להוסיף ערים, תמונות ויומן מאוחר יותר</span>
          </div>
        ) : trip.status === "completed" || (trip.status === "archived" && trip.hasAnyActualData) ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-2xl border border-success/15 bg-success/8 p-3">
              <p className="text-xs text-muted-foreground">מקומות שבוצעו</p>
              <p className="mt-1 text-sm font-medium">{trip.statistics.completedActivities}</p>
            </div>
            <div className="rounded-2xl border border-success/15 bg-success/8 p-3">
              <p className="text-xs text-muted-foreground">תמונות</p>
              <p className="mt-1 text-sm font-medium">{trip.photoCount}</p>
            </div>
            <div className="rounded-2xl border border-success/15 bg-success/8 p-3">
              <p className="text-xs text-muted-foreground">יומן</p>
              <p className="mt-1 text-sm font-medium">{trip.journalCount}</p>
            </div>
            <div className="rounded-2xl border border-success/15 bg-success/8 p-3">
              <p className="text-xs text-muted-foreground">מסלול שבוצע</p>
              <p className="mt-1 text-sm font-medium">{trip.comparison.completedActivities}/{trip.comparison.plannedActivities}</p>
            </div>
            <div className="rounded-2xl border border-success/15 bg-success/8 p-3">
              <p className="text-xs text-muted-foreground">דירוג אישי</p>
              <p className="mt-1 text-sm font-medium">
                {trip.personalRating != null ? `${trip.personalRating}/10` : "—"}
              </p>
            </div>
          </div>
        ) : null}

        {trip.status === "active" && trip.currentDay ? (
          <div className="space-y-3 rounded-2xl border border-primary/30 bg-primary/8 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="secondary" className="gap-1.5">
                <Sparkles className="size-3.5" />
                בטיול עכשיו
              </Badge>
              {trip.currentDayNumber != null ? (
                <span className="text-sm font-medium text-foreground">
                  יום {trip.currentDayNumber} / {trip.daysCount}
                </span>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">העיר של היום</p>
                <p className="mt-1 text-sm font-medium">{trip.currentDay.cityRegion || trip.countryName}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">הפעילות הבאה</p>
                <p className="mt-1 text-sm font-medium">
                  {trip.nextActivity?.name || "היום עוד פתוח לגמישות"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">לינה</p>
                <p className="mt-1 text-sm font-medium">
                  {trip.currentDay.accommodation || "טרם הוגדרה"}
                </p>
              </div>
            </div>
            <div onClick={(event) => event.stopPropagation()}>
              <Button onClick={() => onOpenCountryPage(trip)}>פתח את היום</Button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function TimelineTripRow({
  trip,
  onOpen,
}: {
  trip: TripHubTrip;
  onOpen: (trip: TripHubTrip) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(trip)}
      className="group flex w-full items-start gap-4 rounded-3xl border border-border/60 bg-card/70 p-4 text-right transition-colors hover:border-primary/35 hover:bg-card"
    >
      <div className="mt-1 flex flex-col items-center">
        <span className="size-3 rounded-full bg-primary" />
        <span className="mt-2 h-full min-h-10 w-px bg-border" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-heading text-lg font-semibold">{trip.countryName}</span>
          <Badge className={cn("border", statusBadgeClass(trip.status))}>
            {trip.status === "active" ? "בטיול עכשיו" : TRIP_HUB_STATUS_LABELS[trip.status]}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{trip.title}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {formatDateRange(trip.startDate, trip.endDate) ?? "ללא תאריכים"} · {headlineForTrip(trip)}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {trip.routePreviewCities.map((city) => (
            <span
              key={`${trip.id}-${city}`}
              className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              {city}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

export function TripsPageClient() {
  const router = useRouter();
  const { data: trips = [], isLoading } = useTripHubTrips();

  const completedTripIds = useMemo(
    () => trips.filter((trip) => trip.status === "completed").map((trip) => trip.id),
    [trips]
  );
  const { data: tripPhotos = [] } = usePhotosForItineraries(completedTripIds);
  const favoritePhotoByTrip = useMemo(() => {
    const map = new Map<string, string>();
    for (const photo of tripPhotos) {
      if (!photo.favorite || !photo.itinerary_id || map.has(photo.itinerary_id)) continue;
      map.set(photo.itinerary_id, photoPublicUrl(photo.storage_path));
    }
    return map;
  }, [tripPhotos]);

  const [filter, setFilter] = useState<TripFilter>("all");
  const [search, setSearch] = useState("");
  const [yearFilter, setYearFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState<TripDurationFilter>("all");
  const [styleFilter, setStyleFilter] = useState("all");
  const [ratingFilter, setRatingFilter] = useState("all");
  const [sortBy, setSortBy] = useState<SortOption>("nearest_upcoming");
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [selectedTripMeta, setSelectedTripMeta] = useState<{ isoA2: string; countryName: string } | null>(
    null
  );

  const dialog = useItineraryDialogController(selectedTripMeta?.isoA2 ?? "");

  const normalizedSearch = normalizeQuery(search);

  function openTrip(trip: TripHubTrip) {
    setSelectedTripMeta({ isoA2: trip.isoA2, countryName: trip.countryName });
    dialog.openItinerary(trip.itinerary);
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (nextOpen) return;
    if (dialog.isDirty && !window.confirm("יש שינויים שלא נשמרו. לסגור בכל זאת?")) {
      return;
    }
    dialog.closeItinerary();
  }

  const years = useMemo(
    () => [...new Set(trips.map((trip) => getTripHubYear(trip)))].sort((a, b) => b.localeCompare(a)),
    [trips]
  );
  const countries = useMemo(
    () => [...new Set(trips.map((trip) => trip.countryName))].sort((a, b) => a.localeCompare(b)),
    [trips]
  );
  const styles = useMemo(
    () =>
      [...new Set(trips.map((trip) => trip.tripStyle).filter((value): value is string => Boolean(value)))]
        .sort((a, b) => a.localeCompare(b)),
    [trips]
  );

  const summaryCards = useMemo(() => {
    const totalTrips = trips.length;
    const planningCount = trips.filter((trip) => trip.status === "planning").length;
    const upcomingCount = trips.filter((trip) => trip.status === "upcoming").length;
    const visitedCountries = new Set(trips.filter((trip) => trip.hasStarted).map((trip) => trip.isoA2)).size;
    const daysAbroad = trips.reduce((sum, trip) => sum + trip.visitedDayCount, 0);
    const totalSpend = trips.reduce((sum, trip) => sum + (trip.actualCost ?? 0), 0);
    const visitedCities = new Set(
      trips.flatMap((trip) => trip.visitedCityNames)
    ).size;

    return [
      { label: "סה\"כ טיולים", value: `${totalTrips}`, icon: Luggage, show: totalTrips > 0 },
      { label: "בתכנון", value: `${planningCount}`, icon: Sparkles, show: totalTrips > 0 },
      { label: "טיולים קרובים", value: `${upcomingCount}`, icon: CalendarRange, show: totalTrips > 0 },
      { label: "מדינות שביקרתי בהן", value: `${visitedCountries}`, icon: MapPinned, show: visitedCountries > 0 },
      { label: "ימים בחו\"ל", value: `${daysAbroad}`, icon: Clock3, show: daysAbroad > 0 },
      { label: "הוצאה כוללת", value: formatCurrency(totalSpend), icon: Wallet, show: totalSpend > 0 },
      { label: "ערים שביקרתי בהן", value: `${visitedCities}`, icon: Route, show: visitedCities > 0 },
    ].filter((card) => card.show);
  }, [trips]);

  const filteredTrips = useMemo(
    () =>
      trips
        .filter((trip) => (filter === "all" ? true : trip.status === filter))
        .filter((trip) => matchesSearch(trip, normalizedSearch))
        .filter((trip) => (yearFilter === "all" ? true : trip.year === yearFilter))
        .filter((trip) => (countryFilter === "all" ? true : trip.countryName === countryFilter))
        .filter((trip) =>
          durationFilter === "all" ? true : getTripDurationBucket(trip.daysCount) === durationFilter
        )
        .filter((trip) => (styleFilter === "all" ? true : trip.tripStyle === styleFilter))
        .filter((trip) => (ratingFilter === "all" ? true : (trip.personalRating ?? 0) >= Number(ratingFilter)))
        .sort((a, b) => compareTrips(a, b, sortBy)),
    [countryFilter, durationFilter, filter, normalizedSearch, ratingFilter, sortBy, styleFilter, trips, yearFilter]
  );

  const featuredUpcomingTrips = useMemo(
    () => filteredTrips.filter((trip) => trip.status === "upcoming").slice(0, 3),
    [filteredTrips]
  );
  const showUpcomingSection =
    featuredUpcomingTrips.length > 0 && (filter === "all" || filter === "upcoming");
  const featuredUpcomingIds = useMemo(
    () => new Set(featuredUpcomingTrips.map((trip) => trip.id)),
    [featuredUpcomingTrips]
  );

  const historyTrips = useMemo(
    () => filteredTrips.filter((trip) => !(showUpcomingSection && featuredUpcomingIds.has(trip.id))),
    [featuredUpcomingIds, filteredTrips, showUpcomingSection]
  );

  const groupedHistory = useMemo(() => groupTripsByYear(historyTrips), [historyTrips]);
  const groupedYears = useMemo(
    () => Object.keys(groupedHistory).sort((a, b) => b.localeCompare(a)),
    [groupedHistory]
  );

  function openCountryPage(trip: TripHubTrip) {
    router.push(`/countries/${trip.isoA2.toLowerCase()}?itinerary=${trip.id}`);
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-10 w-48 rounded-full" />
          <Skeleton className="h-5 w-96 max-w-full rounded-full" />
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-3xl" />
          ))}
        </div>
        <Skeleton className="h-44 rounded-3xl" />
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-[28rem] rounded-3xl" />
          ))}
        </div>
      </div>
    );
  }

  if (trips.length === 0) {
    return (
      <section
        className="section-card relative overflow-hidden p-8 text-center sm:p-12"
        style={{ backgroundImage: "var(--theme-background-image)" }}
      >
        <div className="absolute inset-0 bg-background/82 backdrop-blur-sm" />
        <div className="relative mx-auto max-w-2xl space-y-4">
          <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Luggage className="size-8" />
          </div>
          <h2 className="font-heading text-3xl font-semibold">עוד אין כאן טיולים.</h2>
          <p className="text-sm text-muted-foreground sm:text-base">
            מתחילים לתכנן את ההרפתקה הראשונה?
          </p>
          <Button size="lg" nativeButton={false} render={<Link href="/map" />}>
            תכנון טיול חדש
          </Button>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <h1 className="font-heading text-3xl font-semibold">הטיולים שלי</h1>
            <p className="text-sm text-muted-foreground sm:text-base">
              כל הטיולים שתכננתם, הטיולים הקרובים והזיכרונות מהטיולים שכבר הסתיימו.
            </p>
          </div>

          <Button size="lg" nativeButton={false} render={<Link href="/map" />}>
            + תכנון טיול חדש
          </Button>
        </header>

        {summaryCards.length > 0 ? (
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
            {summaryCards.map((card) => (
              <SummaryCard key={card.label} label={card.label} value={card.value} icon={card.icon} />
            ))}
          </section>
        ) : null}

        <section className="section-card space-y-4 p-4">
          <div className="flex flex-wrap gap-2">
            {FILTER_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={filter === option.value ? "secondary" : "outline"}
                size="sm"
                onClick={() => setFilter(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,0.55fr))]">
            <div className="relative">
              <Search className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="חיפוש טיול, מדינה או עיר..."
                className="pr-10"
              />
            </div>

            <Select value={yearFilter} onValueChange={(value) => setYearFilter(value ?? "all")}>
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">
                  {yearFilter === "all" ? "כל השנים" : yearFilter}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל השנים</SelectItem>
                {years.map((year) => (
                  <SelectItem key={year} value={year}>
                    {year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={countryFilter}
              onValueChange={(value) => setCountryFilter(value ?? "all")}
            >
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">
                  {countryFilter === "all" ? "כל המדינות" : countryFilter}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל המדינות</SelectItem>
                {countries.map((country) => (
                  <SelectItem key={country} value={country}>
                    {country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={durationFilter}
              onValueChange={(value) => setDurationFilter(value as TripDurationFilter)}
            >
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">
                  {durationFilter === "all" ? "כל המשכים" : TRIP_DURATION_LABELS[durationFilter]}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל המשכים</SelectItem>
                {Object.entries(TRIP_DURATION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={styleFilter} onValueChange={(value) => setStyleFilter(value ?? "all")}>
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">
                  {styleFilter === "all" ? "כל הסגנונות" : styleFilter}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הסגנונות</SelectItem>
                {styles.map((style) => (
                  <SelectItem key={style} value={style}>
                    {style}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={ratingFilter} onValueChange={(value) => setRatingFilter(value ?? "all")}>
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">
                  {ratingFilter === "all" ? "כל הדירוגים" : `${ratingFilter}+ כוכבים`}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">כל הדירוגים</SelectItem>
                {[9, 7, 5].map((value) => (
                  <SelectItem key={value} value={value.toString()}>
                    {value}+ כוכבים
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
              <SelectTrigger className="w-full">
                <span className="flex flex-1 text-right">{SORT_LABELS[sortBy]}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        {showUpcomingSection ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-2xl font-semibold">הטיולים הבאים שלי</h2>
                <p className="text-sm text-muted-foreground">1–3 הטיולים הקרובים שדורשים את רוב תשומת הלב.</p>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              {featuredUpcomingTrips.map((trip) => (
                <UpcomingTripCard
                  key={trip.id}
                  trip={trip}
                  onOpen={openTrip}
                  onOpenCountryPage={openCountryPage}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-heading text-2xl font-semibold">היסטוריית טיולים</h2>
              <p className="text-sm text-muted-foreground">מרכז אחד לכל התכנון, הסיכומים והזיכרונות.</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant={viewMode === "cards" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setViewMode("cards")}
              >
                כרטיסים
              </Button>
              <Button
                variant={viewMode === "timeline" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setViewMode("timeline")}
              >
                ציר זמן
              </Button>
            </div>
          </div>

          {historyTrips.length === 0 ? (
            <div className="section-card p-8 text-center text-sm text-muted-foreground">
              אין טיולים שתואמים לפילטרים שבחרתם.
            </div>
          ) : viewMode === "cards" ? (
            <div className="space-y-6">
              {groupedYears.map((year) => (
                <section key={year} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <h3 className="font-heading text-xl font-semibold">{year}</h3>
                    <span className="text-sm text-muted-foreground">{groupedHistory[year].length} טיולים</span>
                  </div>
                  <div className="grid gap-4 xl:grid-cols-2">
                    {groupedHistory[year].map((trip) => (
                      <HistoryTripCard
                        key={trip.id}
                        trip={trip}
                        favoritePhotoUrl={favoritePhotoByTrip.get(trip.id)}
                        onOpen={openTrip}
                        onOpenCountryPage={openCountryPage}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="section-card space-y-6 p-5">
              {groupedYears.map((year) => (
                <section key={year} className="space-y-4">
                  <h3 className="font-heading text-xl font-semibold">{year}</h3>
                  <div className="space-y-3">
                    {groupedHistory[year].map((trip) => (
                      <TimelineTripRow key={trip.id} trip={trip} onOpen={openTrip} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>

      <CountryItineraryDetailsDialog
        open={Boolean(dialog.activeItinerary && dialog.draft)}
        draft={dialog.draft}
        activeItinerary={dialog.activeItinerary}
        country={{ name: selectedTripMeta?.countryName ?? "" }}
        versions={dialog.versions}
        isDirty={dialog.isDirty}
        isSaving={dialog.isSaving}
        isRegenerating={dialog.isRegenerating}
        onOpenChange={handleDialogOpenChange}
        onSave={dialog.saveDraft}
        onReset={dialog.resetDraft}
        onLoadWorkspace={() => {
          if (!dialog.activeItinerary) return;
          router.push(
            `/countries/${dialog.activeItinerary.isoA2.toLowerCase()}?itinerary=${dialog.activeItinerary.id}`
          );
        }}
        onPatchDraft={dialog.patchDraft}
        onPatchDay={dialog.patchDay}
        onPatchItem={dialog.patchItem}
        onRegenerate={dialog.handleRegenerate}
        onRestore={dialog.handleRestore}
        onDuplicate={dialog.handleDuplicate}
        onArchive={dialog.handleArchive}
        onDelete={dialog.handleDelete}
        onExport={dialog.exportItinerary}
      />
    </>
  );
}
