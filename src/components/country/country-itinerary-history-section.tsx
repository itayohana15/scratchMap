"use client";

import {
  Copy,
  Ellipsis,
  History,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Route,
  Save,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  buildSuggestedItineraryTitle,
  createWorkspaceFromItineraryRecord,
  formatItineraryVersionLabel,
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
  createEmptyDay,
  createEmptyItineraryItem,
  createId,
  dateForDayNumber,
  DAY_PART_LABELS,
  ITINERARY_GENERATION_MODE_LABELS,
  type CountryTripWorkspaceState,
  type DayPart,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

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

function ItemActualFields({
  item,
  onPatch,
}: {
  item: TripItineraryItem;
  onPatch: (patch: Partial<TripItineraryItem>) => void;
}) {
  return (
    <div className="grid gap-2 rounded-2xl border border-border/60 bg-muted/20 p-3 md:grid-cols-2 xl:grid-cols-4">
      <Input
        type="time"
        value={item.actualStartTime}
        onChange={(event) => onPatch({ actualStartTime: event.target.value })}
        placeholder="שעת התחלה בפועל"
      />
      <Input
        type="time"
        value={item.actualEndTime}
        onChange={(event) => onPatch({ actualEndTime: event.target.value })}
        placeholder="שעת סיום בפועל"
      />
      <Input
        type="number"
        value={item.actualCost ?? ""}
        onChange={(event) =>
          onPatch({ actualCost: event.target.value ? Number(event.target.value) : null })
        }
        placeholder="עלות בפועל"
      />
      <Input
        value={item.actualTransportation}
        onChange={(event) => onPatch({ actualTransportation: event.target.value })}
        placeholder="תחבורה בפועל"
      />
      <Textarea
        value={item.journalNotes}
        onChange={(event) => onPatch({ journalNotes: event.target.value })}
        placeholder="הערות יומן"
        rows={2}
        className="md:col-span-2 xl:col-span-4"
      />
    </div>
  );
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
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);

  const { data: versions = [] } = useCountryItineraryVersions(iso, activeItinerary?.id);

  useEffect(() => {
    if (!autoOpenItineraryId || itineraries.length === 0) return;
    const match = itineraries.find((item) => item.id === autoOpenItineraryId) ?? null;
    if (!match) return;
    setActiveItinerary(match);
    setDraft(cloneItinerary(match));
    setSelectedDayId(match.itineraryDays[0]?.id ?? null);
    onAutoOpenHandled();
  }, [autoOpenItineraryId, itineraries, onAutoOpenHandled]);

  useEffect(() => {
    if (!activeItinerary) return;
    setDraft(cloneItinerary(activeItinerary));
    setSelectedDayId(activeItinerary.itineraryDays[0]?.id ?? null);
  }, [activeItinerary]);

  const isDirty = draftSignature(activeItinerary) !== draftSignature(draft);
  const filteredItineraries = useMemo(
    () => itineraries.filter((itinerary) => itineraryMatchesFilters(itinerary, filters)),
    [filters, itineraries]
  );

  const openItinerary = (itinerary: CountryItineraryRecord) => {
    setActiveItinerary(itinerary);
    setDraft(cloneItinerary(itinerary));
    setSelectedDayId(itinerary.itineraryDays[0]?.id ?? null);
  };

  const patchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const patchDay = (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => {
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
    updater: (item: TripItineraryItem) => TripItineraryItem
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "שמירת המסלול נכשלה");
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

      <Dialog open={Boolean(activeItinerary && draft)} onOpenChange={closeModal}>
        {draft && (
          <DialogContent className="h-[92vh] max-w-[calc(100%-1rem)] overflow-hidden p-0 sm:max-w-6xl">
            <div className="flex h-full flex-col">
              <DialogHeader className="border-b px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <DialogTitle>{draft.title}</DialogTitle>
                    <DialogDescription>
                      {country.name} · {formatDateRange(draft.startDate, draft.endDate) ?? "ללא תאריכים"} ·{" "}
                      {draft.daysCount} ימים · {draft.travelers} נוסעים
                    </DialogDescription>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{draft.status}</Badge>
                      <Badge variant="outline">{formatCurrency(draft.costSummary.totalEstimatedCost)}</Badge>
                      <Badge variant="outline">גרסה {draft.version}</Badge>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onLoadWorkspace(createWorkspaceFromItineraryRecord(draft, country.name))}
                    >
                      טען ל-workspace
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRegenerate(draft.id, "optimize_route")}
                      disabled={regenerateItinerary.isPending}
                    >
                      <RefreshCcw className="size-4" />
                      Optimize route
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRegenerate(draft.id, "recalculate_costs")}
                      disabled={regenerateItinerary.isPending}
                    >
                      <Wallet className="size-4" />
                      Recalculate costs
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleRegenerate(draft.id, "full")}
                      disabled={regenerateItinerary.isPending}
                    >
                      {regenerateItinerary.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="size-4" />
                      )}
                      Regenerate full
                    </Button>
                  </div>
                </div>
              </DialogHeader>

              <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="border-b p-4 lg:border-b-0 lg:border-l">
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Version history</p>
                      <div className="mt-3 space-y-2">
                        {versions.slice(0, 6).map((version) => (
                          <button
                            key={version.id}
                            type="button"
                            onClick={() => void handleRestore(version.id)}
                            className="w-full rounded-xl border border-border/70 px-3 py-2 text-right text-xs transition hover:bg-muted"
                          >
                            {formatItineraryVersionLabel(version.version, version.createdAt)}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-border/70 p-3">
                      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Days</p>
                      <ScrollArea className="mt-3 h-[42vh] lg:h-[56vh]">
                        <div className="space-y-2">
                          {draft.itineraryDays.map((day) => (
                            <Button
                              key={day.id}
                              variant={selectedDayId === day.id ? "default" : "outline"}
                              size="sm"
                              className="w-full justify-start"
                              onClick={() => setSelectedDayId(day.id)}
                            >
                              Day {day.dayNumber}
                            </Button>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  </div>
                </aside>

                <ScrollArea className="min-h-0">
                  <div className="space-y-5 p-5">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">כותרת</label>
                        <Input
                          value={draft.title}
                          onChange={(event) =>
                            patchDraft((current) => ({ ...current, title: event.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">תקציב</label>
                        <Input
                          type="number"
                          value={draft.budget ?? ""}
                          onChange={(event) =>
                            patchDraft((current) => ({
                              ...current,
                              budget: event.target.value ? Number(event.target.value) : null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">Mode</label>
                        <Select
                          value={draft.generationMode}
                          onValueChange={(value) =>
                            patchDraft((current) => ({
                              ...current,
                              generationMode:
                                value as CountryTripWorkspaceState["preferences"]["generationMode"],
                              preferencesSnapshot: {
                                ...current.preferencesSnapshot,
                                generationMode:
                                  value as CountryTripWorkspaceState["preferences"]["generationMode"],
                              },
                            }))
                          }
                        >
                          <SelectTrigger>
                            <span>{ITINERARY_GENERATION_MODE_LABELS[draft.generationMode]}</span>
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(ITINERARY_GENERATION_MODE_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">נוסעים</label>
                        <Input
                          type="number"
                          value={draft.preferencesSnapshot.travelers}
                          onChange={(event) =>
                            patchDraft((current) => ({
                              ...current,
                              travelers: Number(event.target.value) || 1,
                              preferencesSnapshot: {
                                ...current.preferencesSnapshot,
                                travelers: Number(event.target.value) || 1,
                              },
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2 lg:col-span-2">
                        <label className="text-xs font-medium text-muted-foreground">AI summary</label>
                        <Textarea
                          value={draft.summary}
                          onChange={(event) =>
                            patchDraft((current) => ({ ...current, summary: event.target.value }))
                          }
                          rows={3}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          patchDraft((current) => {
                            const nextDay = createEmptyDay(
                              current.itineraryDays.length + 1,
                              dateForDayNumber(
                                current.preferencesSnapshot.startDate,
                                current.itineraryDays.length + 1
                              )
                            );
                            return {
                              ...current,
                              daysCount: current.itineraryDays.length + 1,
                              itineraryDays: [...current.itineraryDays, nextDay],
                            };
                          })
                        }
                      >
                        <Plus className="size-4" />
                        Add new day
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (!activeItinerary) return;
                          setDraft(cloneItinerary(activeItinerary));
                          setSelectedDayId(activeItinerary.itineraryDays[0]?.id ?? null);
                        }}
                        disabled={!isDirty}
                      >
                        <X className="size-4" />
                        Cancel changes
                      </Button>
                    </div>

                    <div className="space-y-4">
                      {draft.itineraryDays.map((day) => {
                        const selected = selectedDayId === day.id;
                        return (
                          <details
                            key={day.id}
                            open={selected}
                            className="rounded-[24px] border border-border/70 bg-background/70"
                          >
                            <summary
                              className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4"
                              onClick={() => setSelectedDayId(day.id)}
                            >
                              <div>
                                <h4 className="text-base font-semibold text-foreground">
                                  Day {day.dayNumber} · {day.title || `Day ${day.dayNumber}`}
                                </h4>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {formatDate(day.date) ?? "ללא תאריך"}
                                  {day.cityRegion ? ` · ${day.cityRegion}` : ""}
                                  {day.accommodation ? ` · לינה: ${day.accommodation}` : ""}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Badge variant="outline">{formatCurrency(day.estimatedCost)}</Badge>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    void handleRegenerate(draft.id, "day", day.id);
                                  }}
                                >
                                  Regenerate day
                                </Button>
                              </div>
                            </summary>

                            <div className="space-y-4 border-t px-4 py-4">
                              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <Input
                                  value={day.title}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      title: event.target.value,
                                    }))
                                  }
                                  placeholder="כותרת יום"
                                />
                                <Input
                                  type="date"
                                  value={day.date}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      date: event.target.value,
                                    }))
                                  }
                                />
                                <Input
                                  value={day.cityRegion}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      cityRegion: event.target.value,
                                    }))
                                  }
                                  placeholder="עיר / אזור"
                                />
                                <Input
                                  value={day.accommodation}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      accommodation: event.target.value,
                                    }))
                                  }
                                  placeholder="אזור לינה"
                                />
                                <Input
                                  value={day.transportation}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      transportation: event.target.value,
                                    }))
                                  }
                                  placeholder="תחבורה עיקרית"
                                />
                                <Input
                                  type="number"
                                  value={day.estimatedCost ?? ""}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      estimatedCost: event.target.value ? Number(event.target.value) : null,
                                    }))
                                  }
                                  placeholder="עלות יומית"
                                />
                                <Input
                                  type="number"
                                  value={day.totalTravelMinutes ?? ""}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      totalTravelMinutes: event.target.value
                                        ? Number(event.target.value)
                                        : null,
                                    }))
                                  }
                                  placeholder="דקות נסיעה"
                                />
                                <Input
                                  value={day.restWindow}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      restWindow: event.target.value,
                                    }))
                                  }
                                  placeholder="חלון מנוחה"
                                />
                              </div>

                              <Textarea
                                value={day.notes}
                                onChange={(event) =>
                                  patchDay(day.id, (current) => ({
                                    ...current,
                                    notes: event.target.value,
                                  }))
                                }
                                rows={3}
                                placeholder="הערות יום"
                              />

                              <div className="grid gap-3 lg:grid-cols-2">
                                <Textarea
                                  value={day.warnings.join("\n")}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      warnings: event.target.value
                                        .split("\n")
                                        .map((item) => item.trim())
                                        .filter(Boolean),
                                    }))
                                  }
                                  rows={3}
                                  placeholder="אזהרות"
                                />
                                <Textarea
                                  value={day.alternatives.join("\n")}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      alternatives: event.target.value
                                        .split("\n")
                                        .map((item) => item.trim())
                                        .filter(Boolean),
                                    }))
                                  }
                                  rows={3}
                                  placeholder="חלופות אופציונליות"
                                />
                                <Textarea
                                  value={day.bookingRequirements.join("\n")}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      bookingRequirements: event.target.value
                                        .split("\n")
                                        .map((item) => item.trim())
                                        .filter(Boolean),
                                    }))
                                  }
                                  rows={3}
                                  placeholder="דרישות booking"
                                />
                                <Textarea
                                  value={day.safetyNotes.join("\n")}
                                  onChange={(event) =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      safetyNotes: event.target.value
                                        .split("\n")
                                        .map((item) => item.trim())
                                        .filter(Boolean),
                                    }))
                                  }
                                  rows={3}
                                  placeholder="הערות בטיחות"
                                />
                              </div>

                              <div className="flex flex-wrap gap-2">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() =>
                                    patchDay(day.id, (current) => ({
                                      ...current,
                                      items: [...current.items, createEmptyItineraryItem("morning")],
                                    }))
                                  }
                                >
                                  <Plus className="size-4" />
                                  Add activity
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    patchDraft((current) => {
                                      const duplicate = {
                                        ...day,
                                        id: createId("day"),
                                        dayNumber: current.itineraryDays.length + 1,
                                        title: `${day.title || `Day ${day.dayNumber}`} (copy)`,
                                        items: day.items.map((item) => ({
                                          ...item,
                                          id: createId("item"),
                                        })),
                                      };
                                      return {
                                        ...current,
                                        daysCount: current.itineraryDays.length + 1,
                                        itineraryDays: [...current.itineraryDays, duplicate],
                                      };
                                    })
                                  }
                                >
                                  <Copy className="size-4" />
                                  Duplicate day
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    patchDraft((current) => {
                                      const nextDays = current.itineraryDays
                                        .filter((entry) => entry.id !== day.id)
                                        .map((entry, index) => ({ ...entry, dayNumber: index + 1 }));
                                      return {
                                        ...current,
                                        daysCount: nextDays.length,
                                        itineraryDays: nextDays.length > 0 ? nextDays : [createEmptyDay(1)],
                                      };
                                    })
                                  }
                                >
                                  <Trash2 className="size-4" />
                                  Remove day
                                </Button>
                              </div>

                              <div className="space-y-3">
                                {day.items.map((item, itemIndex) => (
                                  <div key={item.id} className="rounded-[20px] border border-border/70 bg-card/70 p-4">
                                    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_repeat(4,minmax(0,160px))]">
                                      <div className="space-y-3">
                                        <Input
                                          value={item.name}
                                          onChange={(event) =>
                                            patchItem(day.id, item.id, (current) => ({
                                              ...current,
                                              name: event.target.value,
                                            }))
                                          }
                                          placeholder="שם פעילות"
                                        />
                                        <Input
                                          value={item.location}
                                          onChange={(event) =>
                                            patchItem(day.id, item.id, (current) => ({
                                              ...current,
                                              location: event.target.value,
                                            }))
                                          }
                                          placeholder="מיקום"
                                        />
                                        <Textarea
                                          value={item.shortDescription}
                                          onChange={(event) =>
                                            patchItem(day.id, item.id, (current) => ({
                                              ...current,
                                              shortDescription: event.target.value,
                                            }))
                                          }
                                          rows={2}
                                          placeholder="תיאור"
                                        />
                                      </div>

                                      <Select
                                        value={item.slot}
                                        onValueChange={(value) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            slot: value as DayPart,
                                          }))
                                        }
                                      >
                                        <SelectTrigger size="sm">
                                          <span>{DAY_PART_LABELS[item.slot]}</span>
                                        </SelectTrigger>
                                        <SelectContent>
                                          {Object.entries(DAY_PART_LABELS).map(([value, label]) => (
                                            <SelectItem key={value} value={value}>
                                              {label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>

                                      <Input
                                        type="time"
                                        value={item.plannedStartTime}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            plannedStartTime: event.target.value,
                                          }))
                                        }
                                      />
                                      <Input
                                        type="number"
                                        value={item.estimatedDurationMinutes ?? ""}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            estimatedDurationMinutes: event.target.value
                                              ? Number(event.target.value)
                                              : null,
                                          }))
                                        }
                                        placeholder="דקות"
                                      />
                                      <Input
                                        type="number"
                                        value={item.approximatePrice ?? ""}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            approximatePrice: event.target.value
                                              ? Number(event.target.value)
                                              : null,
                                          }))
                                        }
                                        placeholder="מחיר"
                                      />
                                      <Input
                                        value={item.transportation}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            transportation: event.target.value,
                                          }))
                                        }
                                        placeholder="תחבורה"
                                      />
                                    </div>

                                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                                      <Textarea
                                        value={item.plannedNotes}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            plannedNotes: event.target.value,
                                          }))
                                        }
                                        rows={2}
                                        placeholder="הערות תכנון"
                                      />
                                      <Textarea
                                        value={item.bookingWarning}
                                        onChange={(event) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            bookingWarning: event.target.value,
                                          }))
                                        }
                                        rows={2}
                                        placeholder="אזהרת booking"
                                      />
                                    </div>

                                    <div className="mt-3 flex flex-wrap gap-2">
                                      <Badge
                                        variant={item.optional ? "secondary" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            optional: !current.optional,
                                          }))
                                        }
                                      >
                                        Optional
                                      </Badge>
                                      <Badge
                                        variant={item.bookingCompleted ? "secondary" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            bookingCompleted: !current.bookingCompleted,
                                          }))
                                        }
                                      >
                                        Booking completed
                                      </Badge>
                                      <Badge
                                        variant={item.locked ? "secondary" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            locked: !current.locked,
                                          }))
                                        }
                                      >
                                        Locked
                                      </Badge>
                                      <Badge
                                        variant={item.completed ? "secondary" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            completed: !current.completed,
                                            skipped: current.completed ? current.skipped : false,
                                          }))
                                        }
                                      >
                                        Completed
                                      </Badge>
                                      <Badge
                                        variant={item.skipped ? "secondary" : "outline"}
                                        className="cursor-pointer"
                                        onClick={() =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            skipped: !current.skipped,
                                            completed: current.skipped ? current.completed : false,
                                          }))
                                        }
                                      >
                                        Skipped
                                      </Badge>
                                    </div>

                                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                      <ItemActualFields
                                        item={item}
                                        onPatch={(patch) =>
                                          patchItem(day.id, item.id, (current) => ({
                                            ...current,
                                            ...patch,
                                          }))
                                        }
                                      />
                                      <div className="space-y-3 rounded-2xl border border-border/60 p-3">
                                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                                          Activity actions
                                        </p>
                                        <Select
                                          value={day.id}
                                          onValueChange={(value) =>
                                            patchDraft((current) => {
                                              if (value === day.id) return current;
                                              const movingItem = day.items.find((entry) => entry.id === item.id);
                                              if (!movingItem) return current;
                                              return {
                                                ...current,
                                                itineraryDays: current.itineraryDays.map((entry) => {
                                                  if (entry.id === day.id) {
                                                    return {
                                                      ...entry,
                                                      items: entry.items.filter((candidate) => candidate.id !== item.id),
                                                    };
                                                  }
                                                  if (entry.id === value) {
                                                    return {
                                                      ...entry,
                                                      items: [...entry.items, movingItem],
                                                    };
                                                  }
                                                  return entry;
                                                }),
                                              };
                                            })
                                          }
                                        >
                                          <SelectTrigger size="sm">
                                            <span>Move to day</span>
                                          </SelectTrigger>
                                          <SelectContent>
                                            {draft.itineraryDays.map((targetDay) => (
                                              <SelectItem key={targetDay.id} value={targetDay.id}>
                                                Day {targetDay.dayNumber}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>

                                        <div className="flex flex-wrap gap-2">
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() =>
                                              patchDay(day.id, (current) => {
                                                if (itemIndex === 0) return current;
                                                const nextItems = [...current.items];
                                                const [moved] = nextItems.splice(itemIndex, 1);
                                                nextItems.splice(itemIndex - 1, 0, moved);
                                                return { ...current, items: nextItems };
                                              })
                                            }
                                          >
                                            למעלה
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() =>
                                              patchDay(day.id, (current) => {
                                                if (itemIndex >= current.items.length - 1) return current;
                                                const nextItems = [...current.items];
                                                const [moved] = nextItems.splice(itemIndex, 1);
                                                nextItems.splice(itemIndex + 1, 0, moved);
                                                return { ...current, items: nextItems };
                                              })
                                            }
                                          >
                                            למטה
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() =>
                                              patchDay(day.id, (current) => ({
                                                ...current,
                                                items: [
                                                  ...current.items,
                                                  { ...item, id: createId("item"), completed: false, skipped: false },
                                                ],
                                              }))
                                            }
                                          >
                                            שכפול
                                          </Button>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => void handleRegenerate(draft.id, "activity", day.id, item.id)}
                                          >
                                            Regenerate activity
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                              patchDay(day.id, (current) => ({
                                                ...current,
                                                items: current.items.filter((candidate) => candidate.id !== item.id),
                                              }))
                                            }
                                          >
                                            הסרה
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                </ScrollArea>
              </div>

              <DialogFooter className="border-t px-5 py-4">
                <div className="flex w-full flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    {isDirty ? "יש שינויים שלא נשמרו" : "כל השינויים נשמרו"}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => closeModal(false)}
                    >
                      סגירה
                    </Button>
                    <Button
                      className="gap-1.5"
                      onClick={() => void saveDraft()}
                      disabled={!isDirty || updateItinerary.isPending}
                    >
                      {updateItinerary.isPending ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Save className="size-4" />
                      )}
                      Save changes
                    </Button>
                  </div>
                </div>
              </DialogFooter>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
