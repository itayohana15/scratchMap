"use client";

import { CalendarRange, MapPinned, Route as RouteIcon, Star } from "lucide-react";
import { useState } from "react";

import { CountryItineraryDetailsDialog } from "@/components/country/country-itinerary-details-dialog";
import { ItineraryTripSummarySection } from "@/components/country/itinerary-route-map";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DeleteTripDialog } from "@/components/trips/delete-trip-dialog";
import { formatCurrency, formatDate, formatTripDateRangeExpanded } from "@/lib/format";
import { itineraryDisplayTitle } from "@/lib/itinerary-pdf-export";
import { useItineraryDialogController } from "@/lib/hooks/use-itinerary-dialog-controller";
import { useCountryTripSummary } from "@/lib/hooks/use-country-trip-summary";
import { createWorkspaceFromItineraryRecord, type CountryItineraryRecord } from "@/lib/itineraries";
import { photoPublicUrl } from "@/lib/queries/photos";
import type { Tables } from "@/lib/supabase/types";
import { effectiveSortDate, hasExactDate } from "@/lib/trip-hub";
import { buildTripComparison, buildTripStatistics } from "@/lib/trip-workspace";

interface CountryTripSummarySectionProps {
  iso: string;
  country: Tables<"countries">;
}

const ALL_TRIPS_VALUE = "__all__";

function formatVisitDate(date: string | null, exact: boolean) {
  if (!date) return "—";
  return formatDate(date, exact ? "d בMMM yyyy" : "MMMM yyyy") ?? "—";
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        {value != null ? (
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${(value / 10) * 100}%` }}
          />
        ) : null}
      </div>
      <span className="w-10 shrink-0 text-right text-sm font-medium text-foreground">
        {value != null ? value.toFixed(1) : "—"}
      </span>
    </div>
  );
}

export function CountryTripSummarySection({ iso, country }: CountryTripSummarySectionProps) {
  const summary = useCountryTripSummary(iso, country.name);
  const dialog = useItineraryDialogController(iso);
  const [mapTripId, setMapTripId] = useState<string>(ALL_TRIPS_VALUE);

  if (summary.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    );
  }

  const dialogElement = (
    <CountryItineraryDetailsDialog
      open={Boolean(dialog.activeItinerary && dialog.draft)}
      draft={dialog.draft}
      activeItinerary={dialog.activeItinerary}
      country={country}
      versions={dialog.versions}
      isDirty={dialog.isDirty}
      isSaving={dialog.isSaving}
      isRegenerating={dialog.isRegenerating}
      onOpenChange={dialog.closeModal}
      onSave={dialog.saveDraft}
      onReset={dialog.resetDraft}
      onLoadWorkspace={() => {}}
      onPatchDraft={dialog.patchDraft}
      onPatchDay={dialog.patchDay}
      onPatchItem={dialog.patchItem}
      onRegenerate={dialog.handleRegenerate}
      onRestore={dialog.handleRestore}
      onArchive={dialog.handleArchive}
      onDelete={dialog.requestDelete}
      onExport={dialog.exportItinerary}
    />
  );

  const deleteDialogElement = dialog.deleteTarget ? (
    <DeleteTripDialog
      open
      onOpenChange={(open) => {
        if (!open) dialog.cancelDelete();
      }}
      tripName={itineraryDisplayTitle(dialog.deleteTarget, country.name)}
      tripDates={formatTripDateRangeExpanded(
        dialog.deleteTarget.startDate,
        dialog.deleteTarget.endDate,
        dialog.deleteTarget.preferencesSnapshot.partialDate
      )}
      tripDuration={`${dialog.deleteTarget.daysCount} ימים`}
      onConfirm={dialog.confirmDelete}
    />
  ) : null;

  if (summary.completed.length === 0) {
    return (
      <div className="space-y-4">
        <div className="section-card space-y-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            עדיין אין טיולים שהושלמו למדינה הזו. ברגע שתסמנו טיול כ&quot;הושלם&quot;, סיכום המדינה יופיע כאן.
          </p>
        </div>
        {summary.upcoming.length > 0 ? (
          <UpcomingTripsList
            trips={summary.upcoming}
            onOpen={(itinerary) => dialog.openItinerary(itinerary)}
          />
        ) : null}
        {dialogElement}
        {deleteDialogElement}
      </div>
    );
  }

  const mapDays =
    mapTripId === ALL_TRIPS_VALUE
      ? summary.completed.flatMap((itinerary) => itinerary.itineraryDays)
      : (summary.completed.find((itinerary) => itinerary.id === mapTripId)?.itineraryDays ?? []);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="section-card flex items-center gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Star className="size-5" />
          </div>
          <div>
            <p className="text-xl font-semibold">
              {summary.overallRating != null ? summary.overallRating.toFixed(1) : "—"} / 10
            </p>
            <p className="text-xs text-muted-foreground">ציון המדינה</p>
          </div>
        </div>
        <div className="section-card flex items-center gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <RouteIcon className="size-5" />
          </div>
          <div>
            <p className="text-xl font-semibold">{summary.stats.tripCount}</p>
            <p className="text-xs text-muted-foreground">ביקורים</p>
          </div>
        </div>
        <div className="section-card flex items-center gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CalendarRange className="size-5" />
          </div>
          <div>
            <p className="text-xl font-semibold">{summary.stats.totalDays}</p>
            <p className="text-xs text-muted-foreground">ימים</p>
          </div>
        </div>
        <div className="section-card flex items-center gap-3 p-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MapPinned className="size-5" />
          </div>
          <div>
            <p className="text-xl font-semibold">{summary.stats.uniqueCities.length}</p>
            <p className="text-xs text-muted-foreground">ערים</p>
          </div>
        </div>
      </div>

      {summary.stats.firstVisit ? (
        <p className="text-sm text-muted-foreground">
          ביקור ראשון: {formatVisitDate(summary.stats.firstVisit, summary.stats.firstVisitExact)}
          {" · "}
          ביקור אחרון: {formatVisitDate(summary.stats.mostRecentVisit, summary.stats.mostRecentVisitExact)}
        </p>
      ) : null}

      <div className="section-card space-y-3 p-4">
        <h3 className="font-heading text-lg font-semibold">דירוג ממוצע</h3>
        <div className="grid gap-2.5 md:grid-cols-2">
          {summary.categoryAverages
            .filter((category) => category.average != null)
            .map((category) => (
              <ScoreBar key={category.key} label={category.label} value={category.average} />
            ))}
        </div>
        {summary.categoryAverages.every((category) => category.average == null) ? (
          <p className="text-sm text-muted-foreground">אין עדיין דירוגים שמורים לטיולים האלה.</p>
        ) : null}
      </div>

      <div className="section-card space-y-3 p-4">
        <h3 className="font-heading text-lg font-semibold">הביקורים שלי</h3>
        <div className="space-y-2">
          {summary.completed
            .slice()
            .sort((a, b) => effectiveSortDate(b).localeCompare(effectiveSortDate(a)))
            .map((itinerary) => (
              <button
                key={itinerary.id}
                type="button"
                onClick={() => dialog.openItinerary(itinerary)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 p-3 text-right transition-colors hover:border-primary/40"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{itinerary.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatVisitDate(effectiveSortDate(itinerary), hasExactDate(itinerary))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {(summary.newVsRepeatedPlaces.get(itinerary.id)?.repeatedPlaces.length ?? 0) > 0 ? (
                    <Badge variant="outline" className="text-[11px]">
                      {summary.newVsRepeatedPlaces.get(itinerary.id)?.newPlaces.length} חדשים ·{" "}
                      {summary.newVsRepeatedPlaces.get(itinerary.id)?.repeatedPlaces.length} חוזרים
                    </Badge>
                  ) : null}
                  {summary.ratingsByItinerary.get(itinerary.id)?.overall != null ? (
                    <Badge variant="secondary">
                      {summary.ratingsByItinerary.get(itinerary.id)?.overall}/10
                    </Badge>
                  ) : null}
                </div>
              </button>
            ))}
        </div>
      </div>

      {summary.completed.length >= 2 ? (
        <TripComparisonTable
          itineraries={summary.completed}
          country={country}
          ratingsByItinerary={summary.ratingsByItinerary}
          newVsRepeatedPlaces={summary.newVsRepeatedPlaces}
        />
      ) : null}

      <div className="section-card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-heading text-lg font-semibold">מפת ביקורים</h3>
          <Select value={mapTripId} onValueChange={(value) => value && setMapTripId(value)}>
            <SelectTrigger size="sm" className="w-56">
              <span className="flex flex-1 truncate text-right">
                {mapTripId === ALL_TRIPS_VALUE
                  ? "כל הטיולים"
                  : (summary.completed.find((itinerary) => itinerary.id === mapTripId)?.title ??
                    "כל הטיולים")}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TRIPS_VALUE}>כל הטיולים</SelectItem>
              {summary.completed.map((itinerary) => (
                <SelectItem key={itinerary.id} value={itinerary.id}>
                  {itinerary.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {mapDays.length > 0 ? (
          <ItineraryTripSummarySection
            days={mapDays}
            countryName={country.name}
            isoA2={iso}
            onPatchDay={() => {}}
            onPatchItem={() => {}}
            onOpenDay={() => {}}
          />
        ) : (
          <p className="text-sm text-muted-foreground">אין עדיין מיקומים שמורים לטיול זה.</p>
        )}
      </div>

      {summary.favoritePhotos.length > 0 || summary.favoriteJournalEntries.length > 0 || summary.favoritePlaces.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <h3 className="font-heading text-lg font-semibold">מועדפים</h3>
          {summary.favoritePlaces.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {summary.favoritePlaces.map((place, index) => (
                <Badge key={`${place.name}-${index}`} variant="outline" className="gap-1">
                  ❤️ {place.name}
                  {place.count > 1 ? <span className="text-muted-foreground">· ביקרתם {place.count} פעמים</span> : null}
                </Badge>
              ))}
            </div>
          ) : null}
          {summary.favoritePhotos.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {summary.favoritePhotos.slice(0, 12).map((photo) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={photo.id}
                  src={photoPublicUrl(photo.storage_path)}
                  alt={photo.caption ?? ""}
                  className="aspect-square w-full rounded-lg object-cover"
                />
              ))}
            </div>
          ) : null}
          {summary.favoriteJournalEntries.length > 0 ? (
            <div className="space-y-2">
              {summary.favoriteJournalEntries.slice(0, 5).map(({ itinerary, entry }) => (
                <div key={entry.id} className="rounded-xl border border-border/60 bg-background/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-foreground">{entry.title || itinerary.title}</p>
                    <Badge variant="secondary">{entry.rating}/10</Badge>
                  </div>
                  {entry.text ? (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.text}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {summary.upcoming.length > 0 ? (
        <UpcomingTripsList
          trips={summary.upcoming}
          onOpen={(itinerary) => dialog.openItinerary(itinerary)}
        />
      ) : null}

      {dialogElement}
      {deleteDialogElement}
    </div>
  );
}

function UpcomingTripsList({
  trips,
  onOpen,
}: {
  trips: CountryItineraryRecord[];
  onOpen: (itinerary: CountryItineraryRecord) => void;
}) {
  return (
    <div className="section-card space-y-3 p-4 text-right">
      <h3 className="font-heading text-lg font-semibold">טיולים עתידיים</h3>
      <div className="space-y-2">
        {trips.map((itinerary) => (
          <button
            key={itinerary.id}
            type="button"
            onClick={() => onOpen(itinerary)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/60 p-3 text-right transition-colors hover:border-primary/40"
          >
            <p className="truncate font-medium text-foreground">{itinerary.title}</p>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatVisitDate(effectiveSortDate(itinerary), hasExactDate(itinerary))}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TripComparisonTable({
  itineraries,
  country,
  ratingsByItinerary,
  newVsRepeatedPlaces,
}: {
  itineraries: CountryItineraryRecord[];
  country: Tables<"countries">;
  ratingsByItinerary: Map<string, Tables<"trip_ratings">>;
  newVsRepeatedPlaces: Map<string, { newPlaces: string[]; repeatedPlaces: string[] }>;
}) {
  const sorted = itineraries.slice().sort((a, b) => effectiveSortDate(a).localeCompare(effectiveSortDate(b)));
  const rows: Array<{ label: string; values: (itinerary: CountryItineraryRecord) => string }> = [
    {
      label: "דירוג כללי",
      values: (itinerary) => {
        const overall = ratingsByItinerary.get(itinerary.id)?.overall;
        return overall != null ? `${overall}/10` : "—";
      },
    },
    { label: "משך", values: (itinerary) => `${itinerary.daysCount} ימים` },
    {
      label: "ערים",
      values: (itinerary) =>
        `${new Set(itinerary.itineraryDays.map((day) => day.cityRegion).filter(Boolean)).size}`,
    },
    {
      label: "הוצאה בפועל",
      values: (itinerary) => {
        const workspace = createWorkspaceFromItineraryRecord(itinerary, country.name);
        return formatCurrency(buildTripComparison(workspace).actualCost);
      },
    },
    {
      label: "פעילויות שבוצעו",
      values: (itinerary) => {
        const workspace = createWorkspaceFromItineraryRecord(itinerary, country.name);
        return `${buildTripStatistics(workspace).placesVisited}`;
      },
    },
    {
      label: "מקומות חדשים / חוזרים",
      values: (itinerary) => {
        const diff = newVsRepeatedPlaces.get(itinerary.id);
        if (!diff) return "—";
        return `${diff.newPlaces.length} / ${diff.repeatedPlaces.length}`;
      },
    },
  ];

  return (
    <div className="section-card space-y-3 overflow-x-auto p-4">
      <h3 className="font-heading text-lg font-semibold">השוואת טיולים</h3>
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr>
            <th className="p-2 text-right text-xs font-medium text-muted-foreground" />
            {sorted.map((itinerary) => (
              <th key={itinerary.id} className="p-2 text-right text-sm font-semibold text-foreground">
                {itinerary.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-border/60">
              <td className="p-2 text-xs font-medium text-muted-foreground">{row.label}</td>
              {sorted.map((itinerary) => (
                <td key={itinerary.id} className="p-2 text-sm text-foreground">
                  {row.values(itinerary)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
