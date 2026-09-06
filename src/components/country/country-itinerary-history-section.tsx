"use client";

import { Ellipsis, FileDown, FolderOpen, History, Pencil, Route, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { DeleteTripDialog } from "@/components/trips/delete-trip-dialog";
import type { CountryItineraryRecord, CountryItineraryStatus } from "@/lib/itineraries";
import { itineraryDisplayTitle, openItineraryPdfExport } from "@/lib/itinerary-pdf-export";
import { formatCurrency, formatTripDateRangeExpanded } from "@/lib/format";
import { useDebugGeoFlag, useGeoResolutionDebugMap } from "@/lib/hooks/use-geo-resolution-debug";
import { useItineraryDialogController } from "@/lib/hooks/use-itinerary-dialog-controller";
import { useCountryItineraries, useUpdateCountryItinerary } from "@/lib/queries/country-itineraries";
import type { Tables } from "@/lib/supabase/types";
import { ITINERARY_GENERATION_MODE_LABELS } from "@/lib/trip-workspace";

type HistoryFilter =
  | "upcoming"
  | "active"
  | "completed"
  | "archived"
  | "ai_generated"
  | "manually_edited";

const HISTORY_FILTER_ORDER: Array<HistoryFilter | "all"> = [
  "all",
  "upcoming",
  "active",
  "completed",
  "archived",
  "ai_generated",
  "manually_edited",
];

const HISTORY_FILTER_LABELS: Record<HistoryFilter | "all", string> = {
  all: "הכל",
  upcoming: "בקרוב",
  active: "פעיל",
  completed: "הושלם",
  archived: "בארכיון",
  ai_generated: "AI-generated",
  manually_edited: "נערך",
};

const ITINERARY_STATUS_LABELS: Record<CountryItineraryStatus, string> = {
  draft: "טיוטה",
  upcoming: "בקרוב",
  active: "פעיל",
  completed: "הושלם",
  archived: "בארכיון",
};

function itineraryMatchesFilter(
  itinerary: CountryItineraryRecord,
  filter: HistoryFilter | "all"
) {
  if (filter === "all") return true;
  if (filter === "ai_generated") return itinerary.source === "ai";
  if (filter === "manually_edited") return itinerary.manuallyEdited;
  return itinerary.status === filter;
}

interface CountryItineraryHistorySectionProps {
  iso: string;
  country: Tables<"countries">;
  onOpenWizard: () => void;
}

export function CountryItineraryHistorySection({
  iso,
  country,
  onOpenWizard,
}: CountryItineraryHistorySectionProps) {
  const router = useRouter();
  const { data: itineraries = [], isLoading } = useCountryItineraries(iso);
  const updateItinerary = useUpdateCountryItinerary(iso);

  const [activeFilter, setActiveFilter] = useState<HistoryFilter | "all">("all");

  const { deleteTarget, requestDelete, cancelDelete, confirmDelete } = useItineraryDialogController(iso);
  const debugGeoEnabled = useDebugGeoFlag();
  const { data: geoResolutionOverride } = useGeoResolutionDebugMap(iso, debugGeoEnabled);

  function openTrip(itinerary: CountryItineraryRecord) {
    router.push(`/trips/${itinerary.id}`);
  }

  const filteredItineraries = useMemo(
    () => itineraries.filter((itinerary) => itineraryMatchesFilter(itinerary, activeFilter)),
    [activeFilter, itineraries]
  );

  const hasAnyItineraries = itineraries.length > 0;

  async function handleRename(itinerary: CountryItineraryRecord) {
    const nextTitle = window.prompt("שם חדש למסלול", itinerary.title)?.trim();
    if (!nextTitle || nextTitle === itinerary.title) return;
    try {
      await updateItinerary.mutateAsync({
        itineraryId: itinerary.id,
        title: nextTitle,
        manuallyEdited: true,
        changeReason: "rename itinerary",
      });
      toast.success("השם עודכן");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "עדכון השם נכשל");
    }
  }

  function exportItineraryPdf(itinerary: CountryItineraryRecord) {
    const opened = openItineraryPdfExport(itinerary, country.name, undefined, geoResolutionOverride ?? null);
    if (!opened) {
      toast.error("לא ניתן לפתוח את חלון הייצוא. יש לאפשר חלונות קופצים בדפדפן.");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <h3 className="font-heading text-2xl font-semibold text-foreground">
            היסטוריית מסלולים
          </h3>
          <p className="text-sm text-muted-foreground">
            כל המסלולים השמורים למדינה הזו מרוכזים כאן. לחיצה על כרטיס פותחת את חלון
            המסלול המלא, עם כל ימי הטיול, המפה והעריכה.
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <Button className="gap-1.5" onClick={onOpenWizard}>
            <Route className="size-4" />
            צור מסלול עם AI
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {HISTORY_FILTER_ORDER.map((filter) => (
          <Button
            key={filter}
            variant={activeFilter === filter ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveFilter(filter)}
          >
            {HISTORY_FILTER_LABELS[filter]}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-52 rounded-[24px]" />
          ))}
        </div>
      ) : filteredItineraries.length === 0 ? (
        <div className="section-card rounded-[28px] p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary">
              <History className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-lg font-semibold text-foreground">
                {hasAnyItineraries
                  ? "אין מסלולים שתואמים לפילטר שנבחר"
                  : "עדיין אין מסלול שמור למדינה הזו"}
              </h4>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                {hasAnyItineraries
                  ? "אפשר לבחור פילטר אחר או לפתוח מחדש את כל ההיסטוריה."
                  : "אחרי generation מוצלח, המסלול יישמר אוטומטית ויופיע כאן כהיסטוריה מסודרת של מסלולים, גרסאות ושינויים."}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button className="gap-1.5" onClick={onOpenWizard}>
                  <Route className="size-4" />
                  צור מסלול עם AI
                </Button>
                {hasAnyItineraries ? (
                  <Button variant="outline" onClick={() => setActiveFilter("all")}>
                    הצג הכל
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {filteredItineraries.map((itinerary) => (
            <article
              key={itinerary.id}
              role="button"
              tabIndex={0}
              className="section-card rounded-[26px] p-5 text-right transition-colors hover:border-primary/40"
              onClick={() => openTrip(itinerary)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openTrip(itinerary);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="line-clamp-2 text-lg font-semibold text-foreground">
                    {itineraryDisplayTitle(itinerary, country.name)}
                  </h4>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatTripDateRangeExpanded(
                      itinerary.startDate,
                      itinerary.endDate,
                      itinerary.preferencesSnapshot.partialDate
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={(event) => {
                      event.stopPropagation();
                      openTrip(itinerary);
                    }}
                  >
                    <FolderOpen className="size-4" />
                    פתח
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="icon-sm"
                          onClick={(event) => event.stopPropagation()}
                        />
                      }
                      aria-label="פעולות"
                    >
                      <Ellipsis className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRename(itinerary);
                        }}
                      >
                        <Pencil className="size-4" />
                        שנה שם
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          exportItineraryPdf(itinerary);
                        }}
                      >
                        <FileDown className="size-4" />
                        ייצוא ל-PDF
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestDelete(itinerary);
                        }}
                      >
                        <Trash2 className="size-4" />
                        מחק
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Badge variant="secondary">{ITINERARY_STATUS_LABELS[itinerary.status]}</Badge>
                <Badge variant="outline">
                  {itinerary.source === "ai" ? "AI-generated" : "Manual"}
                </Badge>
                {itinerary.manuallyEdited ? (
                  <Badge variant="outline">Edited</Badge>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">משך הטיול</p>
                  <p className="mt-1 text-base font-semibold">{itinerary.daysCount} ימים</p>
                </div>
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">נוסעים</p>
                  <p className="mt-1 text-base font-semibold">{itinerary.travelers}</p>
                </div>
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">עלות כוללת משוערת</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatCurrency(itinerary.costSummary.totalEstimatedCost)}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">עלות ממוצעת ליום</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatCurrency(itinerary.costSummary.averageDailyCost)}
                  </p>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">סגנון המסלול</p>
                  <p className="mt-1 text-base font-semibold">
                    {ITINERARY_GENERATION_MODE_LABELS[itinerary.generationMode]}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">תקציב יעד</p>
                  <p className="mt-1 text-base font-semibold">
                    {itinerary.budget != null ? formatCurrency(itinerary.budget) : "לא הוגדר"}
                  </p>
                </div>
              </div>

              {itinerary.summary ? (
                <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted-foreground">
                  {itinerary.summary}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {deleteTarget ? (
        <DeleteTripDialog
          open
          onOpenChange={(open) => {
            if (!open) cancelDelete();
          }}
          tripName={itineraryDisplayTitle(deleteTarget, country.name)}
          tripDates={formatTripDateRangeExpanded(
            deleteTarget.startDate,
            deleteTarget.endDate,
            deleteTarget.preferencesSnapshot.partialDate
          )}
          tripDuration={`${deleteTarget.daysCount} ימים`}
          onConfirm={confirmDelete}
        />
      ) : null}
    </div>
  );
}
