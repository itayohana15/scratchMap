"use client";

import {
  Ellipsis,
  History,
  LoaderCircle,
  Route,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  buildSuggestedItineraryTitle,
  type CountryItineraryRecord,
} from "@/lib/itineraries";
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
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
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

type HistoryFilter =
  | "upcoming"
  | "active"
  | "completed"
  | "archived"
  | "ai_generated"
  | "manually_edited";

const HISTORY_FILTER_LABELS: Record<HistoryFilter, string> = {
  upcoming: "Upcoming",
  active: "Active",
  completed: "Completed",
  archived: "Archived",
  ai_generated: "AI-generated",
  manually_edited: "Edited",
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

function itineraryMatchesFilters(itinerary: CountryItineraryRecord, filters: Set<HistoryFilter>) {
  if (filters.size === 0) return true;
  for (const filter of filters) {
    if (filter === "ai_generated" && itinerary.source !== "ai") return false;
    if (filter === "manually_edited" && !itinerary.manuallyEdited) return false;
    if (
      (filter === "upcoming" || filter === "active" || filter === "completed" || filter === "archived") &&
      itinerary.status !== filter
    ) {
      return false;
    }
  }
  return true;
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

  const [filters, setFilters] = useState<Set<HistoryFilter>>(new Set());
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
    () => itineraries.filter((itinerary) => itineraryMatchesFilters(itinerary, filters)),
    [filters, itineraries]
  );

  const openItinerary = (itinerary: CountryItineraryRecord) => {
    setActiveItinerary(itinerary);
    setDraft(cloneItinerary(itinerary));
  };

  const patchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const patchDay = (dayId: string, updater: (day: CountryTripWorkspaceState["itineraryDays"][number]) => CountryTripWorkspaceState["itineraryDays"][number]) => {
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
      ? `תאריכים: ${formatDateRange(workspace.preferences.startDate, workspace.preferences.endDate)}`
      : "תאריכים: עדיין לא הוגדרו",
    `נוסעים: ${workspace.preferences.travelers}`,
    workspace.preferences.tripStyle ? `סגנון: ${workspace.preferences.tripStyle}` : "",
    workspace.preferences.generationMode
      ? `Mode: ${ITINERARY_GENERATION_MODE_LABELS[workspace.preferences.generationMode]}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-xl font-semibold text-foreground">היסטוריית מסלולים</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            כל generation נשמר למסד עם snapshot, גרסאות ויכולת פתיחה/עריכה מחדש.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(HISTORY_FILTER_LABELS) as HistoryFilter[]).map((filter) => {
            const active = filters.has(filter);
            return (
              <Button
                key={filter}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() =>
                  setFilters((current) => {
                    const next = new Set(current);
                    if (next.has(filter)) next.delete(filter);
                    else next.add(filter);
                    return next;
                  })
                }
              >
                {HISTORY_FILTER_LABELS[filter]}
              </Button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-[24px]" />
          ))}
        </div>
      ) : filteredItineraries.length === 0 ? (
        <div className="section-card rounded-[28px] p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary">
              <History className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-lg font-semibold text-foreground">עדיין אין מסלול שמור למדינה הזו</h4>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                אחרי generation מוצלח, המסלול יישמר אוטומטית למסד ויופיע כאן עם היסטוריית גרסאות.
              </p>
              <p className="mt-3 text-sm text-muted-foreground">{emptySummary}</p>
              {generationStage && (
                <p className="mt-3 text-sm font-medium text-primary">כרגע: {generationStage}</p>
              )}
              <div className="mt-4">
                <Button className="gap-1.5" onClick={() => void onGenerate()} disabled={isGenerating}>
                  {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Route className="size-4" />}
                  Create itinerary with AI
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filteredItineraries.map((itinerary) => (
            <article key={itinerary.id} className="section-card rounded-[26px] p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openItinerary(itinerary)}
                    className="text-right"
                  >
                    <h4 className="line-clamp-2 text-lg font-semibold text-foreground hover:text-primary">
                      {itinerary.title || buildSuggestedItineraryTitle(country.name, itinerary.startDate, itinerary.endDate)}
                    </h4>
                  </button>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {formatDateRange(itinerary.startDate, itinerary.endDate) ?? "ללא תאריכים"}
                  </p>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" />} aria-label="פעולות">
                    <Ellipsis className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => openItinerary(itinerary)}>Open</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleDuplicate(itinerary.id)}>Duplicate</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleRename(itinerary)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleArchive(itinerary.id)}>Archive</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleRegenerate(itinerary.id, "full")}>
                      Regenerate
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => exportItinerary(itinerary)}>Export</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => void handleDelete(itinerary.id)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Badge variant="secondary">{itinerary.daysCount} ימים</Badge>
                <Badge variant="outline">{itinerary.travelers} נוסעים</Badge>
                <Badge variant="outline">
                  {itinerary.source === "ai" ? "AI-generated" : "Manual"}
                </Badge>
                {itinerary.manuallyEdited && <Badge variant="outline">Edited</Badge>}
                <Badge variant="outline">{itinerary.status}</Badge>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">עלות כוללת משוערת</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatCurrency(itinerary.costSummary.totalEstimatedCost)}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 p-3">
                  <p className="text-xs text-muted-foreground">עודכן לאחרונה</p>
                  <p className="mt-1 text-base font-semibold">
                    {formatDate(itinerary.updatedAt, "d בMMM yyyy")}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => openItinerary(itinerary)}>
                  Open
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void handleDuplicate(itinerary.id)}>
                  Duplicate
                </Button>
                <Button size="sm" variant="outline" onClick={() => exportItinerary(itinerary)}>
                  Export
                </Button>
              </div>
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
