"use client";

import {
  Archive,
  CalendarRange,
  Clock3,
  Ellipsis,
  ExternalLink,
  FileDown,
  type LucideIcon,
  Luggage,
  MapPinned,
  Pencil,
  Route,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { CountryBanner } from "@/components/shared/country-banner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { openItineraryPdfExport } from "@/lib/itinerary-pdf-export";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDate, formatTripDateRange, tripDurationDays } from "@/lib/format";
import { photoPublicUrl, usePhotosForItineraries } from "@/lib/queries/photos";
import {
  useArchiveTripHubItinerary,
  useDeleteTripHubItinerary,
  useRenameTripHubItinerary,
  useTripHubTrips,
} from "@/lib/queries/trip-hub";
import {
  getTripDurationBucket,
  getTripHubYear,
  TRIP_DURATION_LABELS,
  TRIP_HUB_STATUS_LABELS,
  tripDestinationName,
  type TripDurationFilter,
  type TripHubStatus,
  type TripHubTrip,
} from "@/lib/trip-hub";
import { computeTripReadiness, isReadinessApplicable } from "@/lib/trip-readiness";
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

const RATING_FILTER_OPTIONS = [
  { value: "all", label: "כל הדירוגים", emoji: "✨" },
  { value: "9", label: "9+ כוכבים", emoji: "🏆" },
  { value: "7", label: "7+ כוכבים", emoji: "⭐" },
  { value: "5", label: "5+ כוכבים", emoji: "👍" },
] as const;

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

/**
 * Supplementary text shown ALONGSIDE the single status badge — never a
 * restatement of the status itself (that's already the badge's job). Only
 * upcoming (countdown) and active (day-of-trip) have anything new to add;
 * every other status returns null so no second badge/pill gets rendered.
 */
function headlineForTrip(trip: TripHubTrip): string | null {
  if (trip.status === "upcoming" && trip.countdownDays != null) {
    return trip.countdownDays === 0 ? "מתחילים היום" : `עוד ${trip.countdownDays} ימים`;
  }

  if (trip.status === "active" && trip.currentDayNumber) {
    return `היום: יום ${trip.currentDayNumber} מתוך ${trip.daysCount}`;
  }

  return null;
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

const UPCOMING_STATUS_LABEL: Partial<Record<TripHubStatus, string>> = {
  planning: "בשלבי תכנון",
  upcoming: "מתקרב",
};

function countdownLabel(trip: TripHubTrip): string | null {
  if (trip.countdownDays == null) return null;
  return trip.countdownDays === 0 ? "מתחילים היום" : `עוד ${trip.countdownDays} ימים`;
}

function ReadinessMiniBar({ trip, onOpenIssues }: { trip: TripHubTrip; onOpenIssues: () => void }) {
  if (!isReadinessApplicable(trip.itinerary.status)) return null;
  const readiness = computeTripReadiness(trip.itinerary);
  const issueCount = readiness.categories.filter(
    (category) => category.status === "missing" || category.status === "partial"
  ).length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">מוכנות לטיול</span>
        <span className="font-medium text-foreground">{readiness.overallPercent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${readiness.overallPercent}%` }}
        />
      </div>
      {issueCount > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenIssues();
          }}
          className="flex items-center gap-1 text-xs text-warning underline-offset-2 hover:underline"
        >
          <TriangleAlert className="size-3.5" />
          {issueCount} דברים דורשים טיפול
        </button>
      ) : null}
    </div>
  );
}

function useUpcomingTripCardActions(trip: TripHubTrip) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(trip.title);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const renameTrip = useRenameTripHubItinerary();
  const archiveTrip = useArchiveTripHubItinerary();
  const deleteTrip = useDeleteTripHubItinerary();

  async function handleRename() {
    const title = renameValue.trim();
    if (!title || title === trip.title) {
      setRenameOpen(false);
      return;
    }
    try {
      await renameTrip.mutateAsync({ isoA2: trip.isoA2, itineraryId: trip.id, title });
      toast.success("שם הטיול עודכן");
      setRenameOpen(false);
    } catch {
      toast.error("עדכון השם נכשל");
    }
  }

  async function handleArchive() {
    try {
      await archiveTrip.mutateAsync({ isoA2: trip.isoA2, itineraryId: trip.id });
      toast.success("הטיול הועבר לארכיון");
    } catch {
      toast.error("ההעברה לארכיון נכשלה");
    }
  }

  async function handleDelete() {
    try {
      await deleteTrip.mutateAsync({ isoA2: trip.isoA2, itineraryId: trip.id });
      toast.success("הטיול נמחק");
      setDeleteOpen(false);
    } catch {
      toast.error("מחיקת הטיול נכשלה");
    }
  }

  return {
    renameOpen,
    setRenameOpen,
    renameValue,
    setRenameValue,
    deleteOpen,
    setDeleteOpen,
    renameTrip,
    handleRename,
    handleArchive,
    handleDelete,
  };
}

type UpcomingTripCardActions = ReturnType<typeof useUpcomingTripCardActions>;

function UpcomingCardMenuAndDialogs({
  trip,
  actions,
  onOpen,
  onOpenCountryPage,
}: {
  trip: TripHubTrip;
  actions: UpcomingTripCardActions;
  onOpen: (trip: TripHubTrip) => void;
  onOpenCountryPage: (trip: TripHubTrip) => void;
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="פעולות נוספות" />}>
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onOpen(trip)}>
            <ExternalLink className="size-4" />
            פתח טיול
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpenCountryPage(trip)}>
            <Route className="size-4" />
            המשך תכנון
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              const opened = openItineraryPdfExport(trip.itinerary, trip.countryName, trip.workspace);
              if (!opened) toast.error("לא ניתן לפתוח את חלון הייצוא. יש לאפשר חלונות קופצים בדפדפן.");
            }}
          >
            <FileDown className="size-4" />
            ייצוא ל-PDF
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              actions.setRenameValue(trip.title);
              actions.setRenameOpen(true);
            }}
          >
            <Pencil className="size-4" />
            שנה שם
          </DropdownMenuItem>
          <DropdownMenuItem onClick={actions.handleArchive}>
            <Archive className="size-4" />
            העבר לארכיון
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => actions.setDeleteOpen(true)}>
            <Trash2 className="size-4" />
            מחק טיול
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={actions.renameOpen} onOpenChange={actions.setRenameOpen}>
        <DialogContent onClick={(event) => event.stopPropagation()} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>שינוי שם הטיול</DialogTitle>
          </DialogHeader>
          <Input value={actions.renameValue} onChange={(event) => actions.setRenameValue(event.target.value)} placeholder="שם הטיול" />
          <DialogFooter>
            <Button variant="outline" onClick={() => actions.setRenameOpen(false)}>
              ביטול
            </Button>
            <Button onClick={actions.handleRename} disabled={actions.renameTrip.isPending}>
              שמירה
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={actions.deleteOpen} onOpenChange={actions.setDeleteOpen}>
        <AlertDialogContent onClick={(event) => event.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>למחוק את הטיול?</AlertDialogTitle>
            <AlertDialogDescription>
              פעולה זו תמחק את הטיול &quot;{trip.title}&quot; לצמיתות, כולל המסלול, ההזמנות והיומן שלו.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={actions.handleDelete}
            >
              מחיקה
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function UpcomingStatsRow({ trip }: { trip: TripHubTrip }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-8">
      {trip.daysCount > 0 ? (
        <div>
          <p className="text-lg font-semibold text-foreground">{trip.daysCount}</p>
          <p className="text-xs text-muted-foreground">ימים</p>
        </div>
      ) : null}
      {trip.travelers > 0 ? (
        <div>
          <p className="text-lg font-semibold text-foreground">{trip.travelers}</p>
          <p className="text-xs text-muted-foreground">נוסעים</p>
        </div>
      ) : null}
      {trip.displayCost != null ? (
        <div>
          <p className="text-lg font-semibold text-foreground">{formatCurrency(trip.displayCost)}</p>
          <p className="text-xs text-muted-foreground">תקציב</p>
        </div>
      ) : null}
    </div>
  );
}

/** The single source of the card title everywhere in this section — never the raw stored `trip.title` (which may carry a stale machine-formatted date from an older generation path). */
function UpcomingTripHeading({ trip, className }: { trip: TripHubTrip; className?: string }) {
  return (
    <h3 className={className}>
      {tripDestinationName(trip)}:{" "}
      <bdi dir="ltr">{formatTripDateRange(trip.startDate, trip.endDate, trip.itinerary.preferencesSnapshot.partialDate)}</bdi>
    </h3>
  );
}

/**
 * Exactly one upcoming trip: a wide, horizontal featured layout that uses
 * the full content width instead of a small centered card (spec: no empty
 * side margins for a single trip). RTL-native — the info block is first in
 * DOM so it lands on the right, the image second so it lands on the left.
 */
function FeaturedUpcomingTripCard({
  trip,
  onOpen,
  onOpenCountryPage,
}: {
  trip: TripHubTrip;
  onOpen: (trip: TripHubTrip) => void;
  onOpenCountryPage: (trip: TripHubTrip) => void;
}) {
  const actions = useUpcomingTripCardActions(trip);
  const countdown = countdownLabel(trip);
  const statusLabel = UPCOMING_STATUS_LABEL[trip.status] ?? TRIP_HUB_STATUS_LABELS[trip.status];

  return (
    <article
      onClick={() => onOpen(trip)}
      className="section-card group flex w-full cursor-pointer flex-col overflow-hidden ring-1 ring-primary/25 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/35 lg:flex-row"
    >
      <div className="flex flex-col justify-center gap-4 p-6 lg:w-[42%] lg:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="w-fit border border-primary/30 bg-primary/10 text-primary">הטיול הבא</Badge>
          <Badge className={cn("w-fit border", statusBadgeClass(trip.status))}>{statusLabel}</Badge>
        </div>

        <div className="space-y-1.5">
          <UpcomingTripHeading trip={trip} className="font-heading text-2xl font-semibold text-foreground sm:text-3xl" />
          {countdown ? <p className="text-sm font-medium text-primary">{countdown}</p> : null}
        </div>

        <UpcomingStatsRow trip={trip} />

        <ReadinessMiniBar trip={trip} onOpenIssues={() => onOpenCountryPage(trip)} />

        <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button onClick={() => onOpenCountryPage(trip)}>המשך תכנון</Button>
          <Button variant="outline" onClick={() => onOpen(trip)}>
            פתח טיול
          </Button>
          <UpcomingCardMenuAndDialogs trip={trip} actions={actions} onOpen={onOpen} onOpenCountryPage={onOpenCountryPage} />
        </div>
      </div>

      <div className="lg:w-[58%]">
        <CountryBanner
          isoA2={trip.isoA2}
          countryName={trip.countryName}
          className="h-56 rounded-none sm:h-72 lg:h-full lg:min-h-[300px] lg:max-h-[360px]"
          showCaption={false}
          showFlagOverlay={false}
        />
      </div>
    </article>
  );
}

function UpcomingTripCard({
  trip,
  isNearest,
  onOpen,
  onOpenCountryPage,
}: {
  trip: TripHubTrip;
  isNearest: boolean;
  onOpen: (trip: TripHubTrip) => void;
  onOpenCountryPage: (trip: TripHubTrip) => void;
}) {
  const actions = useUpcomingTripCardActions(trip);
  const countdown = countdownLabel(trip);
  const statusLabel = UPCOMING_STATUS_LABEL[trip.status] ?? TRIP_HUB_STATUS_LABELS[trip.status];

  return (
    <article
      onClick={() => onOpen(trip)}
      className={cn(
        "section-card group w-full cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-1 hover:border-primary/35",
        isNearest && "ring-1 ring-primary/25"
      )}
    >
      <CountryBanner
        isoA2={trip.isoA2}
        countryName={trip.countryName}
        className="h-64 rounded-none sm:h-72"
        showCaption={false}
        overlay={
          <div className="flex h-full flex-col justify-between p-5 text-white">
            <div className="flex flex-wrap items-center gap-2">
              {isNearest ? (
                <Badge className="w-fit border border-white/30 bg-white/15 text-white backdrop-blur-sm">
                  הטיול הבא
                </Badge>
              ) : null}
              <Badge className={cn("w-fit border", statusBadgeClass(trip.status))}>{statusLabel}</Badge>
            </div>
            <div className="space-y-1.5">
              {countdown ? (
                <span className="inline-flex w-fit items-center rounded-full bg-primary/25 px-3 py-1 text-sm font-medium text-white backdrop-blur-sm">
                  {countdown}
                </span>
              ) : null}
              <p className="text-sm text-white/80">{trip.countryName}</p>
              <UpcomingTripHeading trip={trip} className="font-heading text-2xl font-semibold sm:text-3xl" />
            </div>
          </div>
        }
      />

      <div className="space-y-4 p-5">
        <UpcomingStatsRow trip={trip} />

        <ReadinessMiniBar trip={trip} onOpenIssues={() => onOpenCountryPage(trip)} />

        <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button onClick={() => onOpenCountryPage(trip)}>המשך תכנון</Button>
          <Button variant="outline" onClick={() => onOpen(trip)}>
            פתח טיול
          </Button>
          <UpcomingCardMenuAndDialogs trip={trip} actions={actions} onOpen={onOpen} onOpenCountryPage={onOpenCountryPage} />
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
  const supplementaryText = headlineForTrip(trip);
  const bannerOverlay = (
    <div className="flex h-full items-start justify-between gap-3 p-4 text-white">
      <Badge className={cn("border", statusBadgeClass(trip.status))}>
        {trip.status === "active" ? "בטיול עכשיו" : TRIP_HUB_STATUS_LABELS[trip.status]}
      </Badge>
      {supplementaryText ? (
        <div className="rounded-full bg-black/25 px-3 py-1 text-xs backdrop-blur-sm">{supplementaryText}</div>
      ) : null}
    </div>
  );
  const destinationName = tripDestinationName(trip);
  const durationDays = tripDurationDays(trip.startDate, trip.endDate);

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
          <h3 className="font-heading text-xl font-semibold">
            {destinationName}:{" "}
            <bdi dir="ltr">{formatTripDateRange(trip.startDate, trip.endDate, trip.itinerary.preferencesSnapshot.partialDate)}</bdi>
          </h3>
          {durationDays != null ? (
            <p className="mt-1 text-sm text-muted-foreground">{durationDays} ימים</p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
          <bdi dir="ltr">
            {formatTripDateRange(trip.startDate, trip.endDate, trip.itinerary.preferencesSnapshot.partialDate)}
          </bdi>
          {headlineForTrip(trip) ? ` · ${headlineForTrip(trip)}` : ""}
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
  const normalizedSearch = normalizeQuery(search);

  function openTrip(trip: TripHubTrip) {
    router.push(`/trips/${trip.id}`);
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
    router.push(`/trips/${trip.id}?tab=itinerary`);
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
                  {(() => {
                    const option = RATING_FILTER_OPTIONS.find((item) => item.value === ratingFilter) ?? RATING_FILTER_OPTIONS[0];
                    return (
                      <Badge variant="secondary" className="gap-1.5 border-0 px-2.5 py-1 text-xs">
                        <span aria-hidden="true">{option.emoji}</span>
                        {option.label}
                      </Badge>
                    );
                  })()}
                </span>
              </SelectTrigger>
              <SelectContent>
                {RATING_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <Badge variant="secondary" className="gap-1.5 border-0 px-2 py-1 text-xs">
                      <span aria-hidden="true">{option.emoji}</span>
                      {option.label}
                    </Badge>
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
          <section className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-2xl font-semibold">הטיולים הבאים שלי</h2>
                <p className="text-sm text-muted-foreground">
                  {featuredUpcomingTrips.length} טיולים מתוכננים
                  {featuredUpcomingTrips[0]?.countdownDays != null
                    ? ` · הקרוב ביותר בעוד ${featuredUpcomingTrips[0].countdownDays} ימים`
                    : ""}
                </p>
              </div>
            </div>

            {featuredUpcomingTrips.length === 1 ? (
              <FeaturedUpcomingTripCard trip={featuredUpcomingTrips[0]} onOpen={openTrip} onOpenCountryPage={openCountryPage} />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-6">
                {featuredUpcomingTrips.map((trip, index) => (
                  <UpcomingTripCard
                    key={trip.id}
                    trip={trip}
                    isNearest={index === 0}
                    onOpen={openTrip}
                    onOpenCountryPage={openCountryPage}
                  />
                ))}
              </div>
            )}
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
    </>
  );
}
