"use client";

import { Ellipsis, History, LoaderCircle, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CountryItineraryDetailsDialog } from "@/components/country/country-itinerary-details-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildSuggestedItineraryTitle,
  type CountryItineraryRecord,
  type CountryItineraryStatus,
} from "@/lib/itineraries";
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
import {
  useArchiveCountryItinerary,
  useCountryItineraries,
  useCountryItineraryVersions,
  useDeleteCountryItinerary,
  useDuplicateCountryItinerary,
  useRegenerateCountryItinerary,
  useRestoreCountryItineraryVersion,
  useUpdateCountryItinerary,
} from "@/lib/queries/country-itineraries";
import type { Tables } from "@/lib/supabase/types";
import {
  ITINERARY_GENERATION_MODE_LABELS,
  type CountryTripWorkspaceState,
} from "@/lib/trip-workspace";

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

function cloneItinerary(itinerary: CountryItineraryRecord) {
  return JSON.parse(JSON.stringify(itinerary)) as CountryItineraryRecord;
}

function draftSignature(itinerary: CountryItineraryRecord | null) {
  if (!itinerary) return "";
  return JSON.stringify({
    title: itinerary.title,
    summary: itinerary.summary,
    preferencesSnapshot: itinerary.preferencesSnapshot,
    itineraryDays: itinerary.itineraryDays,
    budget: itinerary.budget,
    generationMode: itinerary.generationMode,
  });
}

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
  workspace: CountryTripWorkspaceState;
  isGenerating: boolean;
  generationStage: string | null;
  autoOpenItineraryId: string | null;
  onAutoOpenHandled: () => void;
  onGenerate: () => Promise<void>;
  onLoadWorkspace: (workspace: CountryTripWorkspaceState) => void;
}

export function CountryItineraryHistorySection({
  iso,
  country,
  workspace,
  isGenerating,
  generationStage,
  autoOpenItineraryId,
  onAutoOpenHandled,
  onGenerate,
  onLoadWorkspace,
}: CountryItineraryHistorySectionProps) {
  const { data: itineraries = [], isLoading } = useCountryItineraries(iso);
  const updateItinerary = useUpdateCountryItinerary(iso);
  const duplicateItinerary = useDuplicateCountryItinerary(iso);
  const archiveItinerary = useArchiveCountryItinerary(iso);
  const deleteItinerary = useDeleteCountryItinerary(iso);
  const regenerateItinerary = useRegenerateCountryItinerary(iso);
  const restoreVersion = useRestoreCountryItineraryVersion(iso);

  const [activeFilter, setActiveFilter] = useState<HistoryFilter | "all">("all");
  const [activeItinerary, setActiveItinerary] = useState<CountryItineraryRecord | null>(null);
  const [draft, setDraft] = useState<CountryItineraryRecord | null>(null);

  const { data: versions = [] } = useCountryItineraryVersions(iso, activeItinerary?.id);

  useEffect(() => {
    if (!autoOpenItineraryId || itineraries.length === 0) return;
    const match = itineraries.find((item) => item.id === autoOpenItineraryId) ?? null;
    if (!match) return;
    setActiveItinerary(match);
    setDraft(cloneItinerary(match));
    onAutoOpenHandled();
  }, [autoOpenItineraryId, itineraries, onAutoOpenHandled]);

  useEffect(() => {
    if (!activeItinerary) return;
    setDraft(cloneItinerary(activeItinerary));
  }, [activeItinerary]);

  const isDirty = draftSignature(activeItinerary) !== draftSignature(draft);
  const filteredItineraries = useMemo(
    () => itineraries.filter((itinerary) => itineraryMatchesFilter(itinerary, activeFilter)),
    [activeFilter, itineraries]
  );

  const hasAnyItineraries = itineraries.length > 0;

  const openItinerary = (itinerary: CountryItineraryRecord) => {
    setActiveItinerary(itinerary);
    setDraft(cloneItinerary(itinerary));
  };

  const patchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const patchDay = (
    dayId: string,
    updater: (
      day: CountryTripWorkspaceState["itineraryDays"][number]
    ) => CountryTripWorkspaceState["itineraryDays"][number]
  ) => {
    patchDraft((current) => ({
      ...current,
      itineraryDays: current.itineraryDays.map((day) =>
        day.id === dayId ? updater(day) : day
      ),
    }));
  };

  const patchItem = (
    dayId: string,
    itemId: string,
    updater: (
      item: CountryTripWorkspaceState["itineraryDays"][number]["items"][number]
    ) => CountryTripWorkspaceState["itineraryDays"][number]["items"][number]
  ) => {
    patchDay(dayId, (day) => ({
      ...day,
      items: day.items.map((item) => (item.id === itemId ? updater(item) : item)),
    }));
  };

  async function saveDraft() {
    if (!draft) return;
    try {
      const itinerary = await updateItinerary.mutateAsync({
        itineraryId: draft.id,
        title: draft.title,
        summary: draft.summary,
        itineraryDays: draft.itineraryDays,
        preferencesSnapshot: draft.preferencesSnapshot,
        workspaceSnapshot: {
          ...(draft.workspaceSnapshot ?? {}),
          preferences: draft.preferencesSnapshot,
          itineraryDays: draft.itineraryDays,
          lastAiPlanSummary: draft.summary,
        },
        budget: draft.budget,
        generationMode: draft.generationMode,
        manuallyEdited: true,
        changeReason: "manual edit from modal",
      });
      setActiveItinerary(itinerary);
      setDraft(cloneItinerary(itinerary));
      toast.success("המסלול נשמר");
      return itinerary;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שמירת המסלול נכשלה");
      throw error;
    }
  }

  function closeModal(nextOpen: boolean) {
    if (nextOpen) return;
    if (isDirty && !window.confirm("יש שינויים שלא נשמרו. לסגור בכל זאת?")) {
      return;
    }
    setActiveItinerary(null);
    setDraft(null);
  }

  function resetDraft() {
    if (!activeItinerary) return;
    setDraft(cloneItinerary(activeItinerary));
  }

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

  async function handleArchive(itineraryId: string) {
    try {
      await archiveItinerary.mutateAsync(itineraryId);
      toast.success("המסלול הועבר לארכיון");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "הארכוב נכשל");
    }
  }

  async function handleDelete(itineraryId: string) {
    if (!window.confirm("למחוק את המסלול מההיסטוריה?")) return;
    try {
      await deleteItinerary.mutateAsync(itineraryId);
      if (activeItinerary?.id === itineraryId) {
        setActiveItinerary(null);
        setDraft(null);
      }
      toast.success("המסלול נמחק");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "המחיקה נכשלה");
    }
  }

  async function handleDuplicate(itineraryId: string) {
    try {
      const duplicate = await duplicateItinerary.mutateAsync(itineraryId);
      toast.success("נוצר עותק חדש");
      openItinerary(duplicate);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "השכפול נכשל");
    }
  }

  async function handleRegenerate(
    itineraryId: string,
    scope: "full" | "day" | "activity" | "optimize_route" | "recalculate_costs",
    targetDayId?: string | null,
    targetItemId?: string | null
  ) {
    try {
      const itinerary = await regenerateItinerary.mutateAsync({
        itineraryId,
        scope,
        targetDayId,
        targetItemId,
      });
      toast.success("המסלול עודכן מחדש");
      if (activeItinerary?.id === itineraryId) {
        setActiveItinerary(itinerary);
        setDraft(cloneItinerary(itinerary));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ה-regeneration נכשל");
    }
  }

  async function handleRestore(versionId: string) {
    if (!activeItinerary) return;
    try {
      const itinerary = await restoreVersion.mutateAsync({
        itineraryId: activeItinerary.id,
        versionId,
      });
      setActiveItinerary(itinerary);
      setDraft(cloneItinerary(itinerary));
      toast.success("הגרסה שוחזרה");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שחזור הגרסה נכשל");
    }
  }

  function exportItinerary(itinerary: CountryItineraryRecord) {
    const blob = new Blob([JSON.stringify(itinerary, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${itinerary.title}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const emptySummary = [
    workspace.preferences.startDate && workspace.preferences.endDate
      ? `תאריכים: ${formatDateRange(
          workspace.preferences.startDate,
          workspace.preferences.endDate
        )}`
      : "תאריכים: עדיין לא הוגדרו",
    `נוסעים: ${workspace.preferences.travelers}`,
    workspace.preferences.budget
      ? `תקציב יעד: ${formatCurrency(workspace.preferences.budget)}`
      : "",
    workspace.preferences.tripStyle ? `סגנון: ${workspace.preferences.tripStyle}` : "",
    workspace.preferences.interests ? `תחומי עניין: ${workspace.preferences.interests}` : "",
    workspace.preferences.generationMode
      ? `Mode: ${ITINERARY_GENERATION_MODE_LABELS[workspace.preferences.generationMode]}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

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
          <Button className="gap-1.5" onClick={() => void onGenerate()} disabled={isGenerating}>
            {isGenerating ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Route className="size-4" />
            )}
            צור מסלול עם AI
          </Button>
          {generationStage ? (
            <p className="text-sm font-medium text-primary">כרגע: {generationStage}</p>
          ) : null}
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
              <p className="mt-3 text-sm text-muted-foreground">{emptySummary}</p>
              {generationStage ? (
                <p className="mt-3 text-sm font-medium text-primary">כרגע: {generationStage}</p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button className="gap-1.5" onClick={() => void onGenerate()} disabled={isGenerating}>
                  {isGenerating ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Route className="size-4" />
                  )}
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
              onClick={() => openItinerary(itinerary)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openItinerary(itinerary);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="line-clamp-2 text-lg font-semibold text-foreground">
                    {itinerary.title ||
                      buildSuggestedItineraryTitle(
                        country.name,
                        itinerary.startDate,
                        itinerary.endDate
                      )}
                  </h4>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {formatDateRange(itinerary.startDate, itinerary.endDate) ?? "ללא תאריכים"}
                  </p>
                </div>

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
                        openItinerary(itinerary);
                      }}
                    >
                      פתח
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRename(itinerary);
                      }}
                    >
                      שנה שם
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDuplicate(itinerary.id);
                      }}
                    >
                      שכפל
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleRegenerate(itinerary.id, "full");
                      }}
                    >
                      צור מחדש
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleArchive(itinerary.id);
                      }}
                    >
                      העבר לארכיון
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(itinerary.id);
                      }}
                    >
                      מחק
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                  <p className="text-xs text-muted-foreground">נוצר בתאריך</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatDate(itinerary.createdAt, "d בMMM yyyy")}
                  </p>
                </div>
              </div>

              <div className="mt-3 rounded-2xl border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">עודכן לאחרונה</p>
                <p className="mt-1 text-base font-semibold">
                  {formatDate(itinerary.updatedAt, "d בMMM yyyy")}
                </p>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    openItinerary(itinerary);
                  }}
                >
                  פתח את המסלול
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleRename(itinerary);
                  }}
                >
                  שנה שם
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDuplicate(itinerary.id);
                  }}
                >
                  שכפל
                </Button>
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

      <CountryItineraryDetailsDialog
        open={Boolean(activeItinerary && draft)}
        draft={draft}
        activeItinerary={activeItinerary}
        country={country}
        versions={versions}
        isDirty={isDirty}
        isSaving={updateItinerary.isPending}
        isRegenerating={regenerateItinerary.isPending}
        onOpenChange={closeModal}
        onSave={saveDraft}
        onReset={resetDraft}
        onLoadWorkspace={onLoadWorkspace}
        onPatchDraft={patchDraft}
        onPatchDay={patchDay}
        onPatchItem={patchItem}
        onRegenerate={handleRegenerate}
        onRestore={handleRestore}
        onDuplicate={handleDuplicate}
        onArchive={handleArchive}
        onDelete={handleDelete}
        onExport={exportItinerary}
      />
    </div>
  );
}
