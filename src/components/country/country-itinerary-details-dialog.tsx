"use client";

import {
  Archive,
  BedDouble,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Ellipsis,
  LoaderCircle,
  MapPin,
  NotebookPen,
  Plus,
  RefreshCcw,
  Route,
  Save,
  Trash2,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildSuggestedItineraryTitle,
  createWorkspaceFromItineraryRecord,
  type CountryItineraryRecord,
  type CountryItineraryStatus,
  type CountryItineraryVersionRecord,
  type CountryItineraryVersionSource,
} from "@/lib/itineraries";
import { formatCurrency, formatDate, formatDateRange } from "@/lib/format";
import type { Tables } from "@/lib/supabase/types";
import {
  createEmptyDay,
  createEmptyItineraryItem,
  createId,
  dateForDayNumber,
  DAY_PART_LABELS,
  ITINERARY_GENERATION_MODE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  type CountryTripWorkspaceState,
  type DayPart,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";

type RegenerateScope = "full" | "day" | "activity" | "optimize_route" | "recalculate_costs";

const ITINERARY_STATUS_LABELS: Record<CountryItineraryStatus, string> = {
  draft: "טיוטה",
  upcoming: "בקרוב",
  active: "בתהליך",
  completed: "הושלם",
  archived: "בארכיון",
};

const VERSION_SOURCE_LABELS: Record<CountryItineraryVersionSource, string> = {
  ai: "AI",
  manual: "ידני",
  duplicate: "עותק",
  restore: "שחזור",
  regenerate: "Regenerate",
};

function ItemActualFields({
  item,
  onPatch,
}: {
  item: TripItineraryItem;
  onPatch: (patch: Partial<TripItineraryItem>) => void;
}) {
  return (
    <div className="grid gap-2 rounded-[20px] border border-border/60 bg-muted/25 p-3 md:grid-cols-2 xl:grid-cols-4">
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

function SummaryField({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-[20px] border border-border/60 bg-background/65 p-4", className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 text-sm text-foreground">{value}</div>
    </div>
  );
}

function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-heading text-lg font-semibold text-foreground">{title}</h3>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function activityStateBadges(item: TripItineraryItem) {
  const badges: Array<{ key: string; label: string }> = [];
  if (item.reservationRequired && item.bookingCompleted) {
    badges.push({ key: "booked", label: "הוזמן" });
  } else if (item.reservationRequired) {
    badges.push({ key: "reservation", label: "דורש הזמנה" });
  }
  if (item.optional) badges.push({ key: "optional", label: "אופציונלי" });
  if (item.locked) badges.push({ key: "locked", label: "נעול" });
  if (item.completed) badges.push({ key: "completed", label: "בוצע" });
  if (item.skipped) badges.push({ key: "skipped", label: "דולג" });
  return badges;
}

function dayMealHighlights(day: TripItineraryDay) {
  return day.items.filter(
    (item) =>
      item.slot === "lunch" ||
      item.slot === "dinner" ||
      item.category === "restaurant" ||
      item.category === "cafe"
  );
}

function dayCompletionCount(day: TripItineraryDay) {
  return day.items.filter((item) => item.completed).length;
}

function versionLabel(version: CountryItineraryVersionRecord) {
  return `${formatDate(version.createdAt, "d בMMM yyyy")} · ${formatDate(version.createdAt, "HH:mm")}`;
}

function compactDate(date: string | null) {
  return formatDate(date, "d MMM");
}

function activityPrice(value: number | null | undefined) {
  return value != null ? formatCurrency(value) : "ללא עלות";
}

interface CountryItineraryDetailsDialogProps {
  open: boolean;
  draft: CountryItineraryRecord | null;
  activeItinerary: CountryItineraryRecord | null;
  country: Tables<"countries">;
  versions: CountryItineraryVersionRecord[];
  isDirty: boolean;
  isSaving: boolean;
  isRegenerating: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => Promise<unknown>;
  onReset: () => void;
  onLoadWorkspace: (workspace: CountryTripWorkspaceState) => void;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (
    dayId: string,
    itemId: string,
    updater: (item: TripItineraryItem) => TripItineraryItem
  ) => void;
  onRegenerate: (
    itineraryId: string,
    scope: RegenerateScope,
    targetDayId?: string | null,
    targetItemId?: string | null
  ) => Promise<void> | void;
  onRestore: (versionId: string) => Promise<void> | void;
  onDuplicate: (itineraryId: string) => Promise<void> | void;
  onArchive: (itineraryId: string) => Promise<void> | void;
  onDelete: (itineraryId: string) => Promise<void> | void;
  onExport: (itinerary: CountryItineraryRecord) => void;
}

export function CountryItineraryDetailsDialog({
  open,
  draft,
  activeItinerary,
  country,
  versions,
  isDirty,
  isSaving,
  isRegenerating,
  onOpenChange,
  onSave,
  onReset,
  onLoadWorkspace,
  onPatchDraft,
  onPatchDay,
  onPatchItem,
  onRegenerate,
  onRestore,
  onDuplicate,
  onArchive,
  onDelete,
  onExport,
}: CountryItineraryDetailsDialogProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [expandedDayIds, setExpandedDayIds] = useState<Set<string>>(new Set());
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const daySectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const draftId = draft?.id ?? null;
  const draftVersion = draft?.version ?? 0;
  const draftDayIds = draft?.itineraryDays.map((day) => day.id) ?? [];
  const draftDayIdsKey = draftDayIds.join("|");
  const firstDayId = draftDayIds[0] ?? null;
  const draftDayIdSet = useMemo(
    () => new Set(draftDayIdsKey ? draftDayIdsKey.split("|") : []),
    [draftDayIdsKey]
  );

  useEffect(() => {
    if (!draftId) return;
    setSelectedDayId((current) =>
      current && draftDayIdSet.has(current) ? current : firstDayId
    );
    setExpandedDayIds((current) => {
      const next = new Set([...current].filter((dayId) => draftDayIdSet.has(dayId)));
      if (firstDayId) next.add(firstDayId);
      return next;
    });
    setIsEditMode(false);
    setEditingItemId(null);
  }, [draftDayIdSet, draftDayIdsKey, draftId, draftVersion, firstDayId]);

  useEffect(() => {
    if (!selectedDayId) return;
    const frame = window.requestAnimationFrame(() => {
      daySectionRefs.current[selectedDayId]?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedDayId]);

  const selectedDay = useMemo(
    () => draft?.itineraryDays.find((day) => day.id === selectedDayId) ?? draft?.itineraryDays[0] ?? null,
    [draft, selectedDayId]
  );

  if (!draft) {
    return null;
  }

  const itineraryTitle =
    draft.title || buildSuggestedItineraryTitle(country.name, draft.startDate, draft.endDate);

  const itineraryMeta = [
    country.name,
    formatDateRange(draft.startDate, draft.endDate) ?? "ללא תאריכים",
    `${draft.daysCount} ימים`,
    `${draft.travelers} נוסעים`,
    formatCurrency(draft.costSummary.totalEstimatedCost),
  ].filter(Boolean);

  const lastSavedLabel =
    formatDate(activeItinerary?.updatedAt ?? draft.updatedAt, "d בMMM yyyy HH:mm") ?? "עדיין לא נשמר";

  function handleSelectDay(dayId: string) {
    setSelectedDayId(dayId);
    setExpandedDayIds((current) => new Set(current).add(dayId));
  }

  function handleToggleExtraDay(dayId: string) {
    if (selectedDayId === dayId) return;
    setExpandedDayIds((current) => {
      const next = new Set(current);
      if (next.has(dayId)) next.delete(dayId);
      else next.add(dayId);
      return next;
    });
  }

  function resetEditMode() {
    onReset();
    setIsEditMode(false);
    setEditingItemId(null);
  }

  async function handleSave() {
    await onSave();
    setIsEditMode(false);
    setEditingItemId(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col overflow-hidden rounded-none border-0 bg-background/95 p-0 shadow-none sm:h-auto sm:max-h-[90dvh] sm:w-[min(92vw,1500px)] sm:max-w-[1500px] sm:rounded-[2rem] sm:border sm:border-border/70 sm:shadow-xl"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 shrink-0 border-b border-border/70 bg-background/95 px-4 py-4 backdrop-blur-sm sm:px-6">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <DialogTitle className="text-xl font-semibold sm:text-2xl">{itineraryTitle}</DialogTitle>
                  <DialogDescription className="text-sm leading-6">
                    {itineraryMeta.join(" · ")}
                  </DialogDescription>
                </div>
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="outline" size="icon-sm" />}
                      aria-label="פעולות נוספות"
                    >
                      <Ellipsis className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => void onDuplicate(draft.id)}>
                        <Copy className="size-4" />
                        שכפול מסלול
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onExport(draft)}>
                        <Download className="size-4" />
                        ייצוא JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void onArchive(draft.id)}>
                        <Archive className="size-4" />
                        ארכוב
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => void onDelete(draft.id)}>
                        <Trash2 className="size-4" />
                        מחיקת מסלול
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenChange(false)}
                    aria-label="סגירת החלון"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{ITINERARY_STATUS_LABELS[draft.status]}</Badge>
                <Badge variant="outline">{formatCurrency(draft.costSummary.totalEstimatedCost)}</Badge>
                <Badge variant="outline">גרסה {draft.version}</Badge>
                <Badge variant="outline">{draft.travelers} נוסעים</Badge>
                <Badge variant="outline">{draft.daysCount} ימים</Badge>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => void onRegenerate(draft.id, "optimize_route")}
                  disabled={isRegenerating || isSaving}
                >
                  {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Route className="size-4" />}
                  Optimize route
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onLoadWorkspace(createWorkspaceFromItineraryRecord(draft, country.name))}
                  disabled={isSaving}
                >
                  פתח ב-workspace
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRegenerate(draft.id, "recalculate_costs")}
                  disabled={isRegenerating || isSaving}
                >
                  <Wallet className="size-4" />
                  חשב עלויות מחדש
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRegenerate(draft.id, "full")}
                  disabled={isRegenerating || isSaving}
                >
                  <RefreshCcw className="size-4" />
                  Regenerate
                </Button>
              </div>
            </div>
          </header>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="hidden min-h-0 border-l border-border/70 bg-muted/20 lg:flex lg:flex-col">
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-4 p-4">
                  <section className="rounded-[24px] border border-border/60 bg-card/70 p-4">
                    <SectionTitle
                      title="ימים"
                      description="ניווט מהיר בין ימי המסלול"
                      action={<Badge variant="outline">{draft.itineraryDays.length}</Badge>}
                    />
                    <div className="mt-4 space-y-2">
                      {draft.itineraryDays.map((day) => {
                        const selected = selectedDay?.id === day.id;
                        const completedCount = dayCompletionCount(day);
                        return (
                          <button
                            key={day.id}
                            type="button"
                            onClick={() => handleSelectDay(day.id)}
                            aria-current={selected ? "page" : undefined}
                            className={cn(
                              "w-full rounded-[20px] border px-3 py-3 text-right transition-colors",
                              selected
                                ? "border-primary/40 bg-primary/10 ring-1 ring-primary/20"
                                : "border-border/60 bg-background/70 hover:bg-muted/60"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-foreground">Day {day.dayNumber}</span>
                                  {selected ? <Badge variant="secondary">נבחר</Badge> : null}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {[compactDate(day.date), day.cityRegion || null].filter(Boolean).join(" · ") || "ללא תאריך"}
                                </p>
                              </div>
                              {day.warnings.length > 0 ? (
                                <Badge variant="outline" className="gap-1">
                                  <TriangleAlert className="size-3.5" />
                                  {day.warnings.length}
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                              <span>{day.items.length} פעילויות</span>
                              {completedCount > 0 ? <span>{completedCount} הושלמו</span> : null}
                              {day.estimatedCost != null ? <span>{formatCurrency(day.estimatedCost)}</span> : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  <section className="rounded-[24px] border border-border/60 bg-card/70 p-4">
                    <SectionTitle
                      title="היסטוריית גרסאות"
                      description="שחזור נקודות שמירה קודמות"
                      action={<Badge variant="outline">{versions.length}</Badge>}
                    />
                    <div className="mt-4 space-y-3">
                      {versions.slice(0, 8).map((version) => {
                        const isCurrent = version.version === draft.version;
                        return (
                          <div key={version.id} className="rounded-[20px] border border-border/60 bg-background/65 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium text-foreground">גרסה {version.version}</p>
                                <p className="mt-1 text-xs text-muted-foreground">{versionLabel(version)}</p>
                              </div>
                              <Badge variant={isCurrent ? "secondary" : "outline"}>
                                {VERSION_SOURCE_LABELS[version.source]}
                              </Badge>
                            </div>
                            {version.changeReason ? (
                              <p className="mt-3 text-xs leading-6 text-muted-foreground">{version.changeReason}</p>
                            ) : null}
                            <div className="mt-3 flex items-center justify-between gap-2">
                              <span className="text-xs text-muted-foreground">
                                {isCurrent ? "הגרסה הפעילה כרגע" : "ניתן לשחזר את הגרסה"}
                              </span>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => void onRestore(version.id)}
                                disabled={isCurrent}
                              >
                                שחזור
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </ScrollArea>
            </aside>

            <ScrollArea className="min-h-0">
              <div className="space-y-6 px-4 py-4 pb-28 sm:px-6 sm:py-6 sm:pb-32">
                <div className="space-y-4 lg:hidden">
                  <section className="rounded-[24px] border border-border/60 bg-card/70 p-4">
                    <SectionTitle
                      title="בחירת יום"
                      description="מעבר מהיר בין הימים"
                      action={<Badge variant="outline">{draft.itineraryDays.length}</Badge>}
                    />
                    <ScrollArea className="mt-3 w-full whitespace-nowrap">
                      <div className="flex gap-2 pb-1">
                        {draft.itineraryDays.map((day) => {
                          const selected = selectedDay?.id === day.id;
                          return (
                            <button
                              key={day.id}
                              type="button"
                              onClick={() => handleSelectDay(day.id)}
                              aria-current={selected ? "page" : undefined}
                              className={cn(
                                "flex shrink-0 items-center gap-2 rounded-[16px] border px-3 py-2 text-sm",
                                selected
                                  ? "border-primary/40 bg-primary/10 text-foreground"
                                  : "border-border/60 bg-background/70 text-muted-foreground"
                              )}
                            >
                              <CalendarDays className="size-4" />
                              Day {day.dayNumber}
                            </button>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </section>

                  <section className="rounded-[24px] border border-border/60 bg-card/70 p-4">
                    <SectionTitle
                      title="גרסאות"
                      description="שחזור מסלולים קודמים"
                      action={<Badge variant="outline">{versions.length}</Badge>}
                    />
                    <div className="mt-3 space-y-2">
                      {versions.slice(0, 4).map((version) => {
                        const isCurrent = version.version === draft.version;
                        return (
                          <div key={version.id} className="rounded-[18px] border border-border/60 bg-background/65 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium text-foreground">גרסה {version.version}</p>
                                <p className="text-xs text-muted-foreground">{versionLabel(version)}</p>
                              </div>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => void onRestore(version.id)}
                                disabled={isCurrent}
                              >
                                שחזור
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>

                <section className="rounded-[28px] border border-border/60 bg-card/70 p-5 shadow-sm sm:p-6">
                  <SectionTitle
                    title="סיכום הטיול"
                    description="הגדרות כלליות ותקציר AI של המסלול"
                    action={
                      isEditMode ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            const nextDay = createEmptyDay(
                              draft.itineraryDays.length + 1,
                              dateForDayNumber(
                                draft.preferencesSnapshot.startDate,
                                draft.itineraryDays.length + 1
                              )
                            );
                            onPatchDraft((current) => ({
                              ...current,
                              daysCount: current.itineraryDays.length + 1,
                              itineraryDays: [...current.itineraryDays, nextDay],
                            }));
                            handleSelectDay(nextDay.id);
                          }}
                        >
                          <Plus className="size-4" />
                          הוסף יום
                        </Button>
                      ) : null
                    }
                  />

                  {isEditMode ? (
                    <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <div className="space-y-2 xl:col-span-2">
                        <label className="text-xs font-medium text-muted-foreground">כותרת המסלול</label>
                        <Input
                          value={draft.title}
                          onChange={(event) =>
                            onPatchDraft((current) => ({ ...current, title: event.target.value }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">תקציב</label>
                        <Input
                          type="number"
                          value={draft.budget ?? ""}
                          onChange={(event) =>
                            onPatchDraft((current) => ({
                              ...current,
                              budget: event.target.value ? Number(event.target.value) : null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">נוסעים</label>
                        <Input
                          type="number"
                          value={draft.preferencesSnapshot.travelers}
                          onChange={(event) =>
                            onPatchDraft((current) => ({
                              ...current,
                              travelers: Math.max(1, Number(event.target.value) || 1),
                              preferencesSnapshot: {
                                ...current.preferencesSnapshot,
                                travelers: Math.max(1, Number(event.target.value) || 1),
                              },
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">מצב יצירה</label>
                        <Select
                          value={draft.generationMode}
                          onValueChange={(value) =>
                            onPatchDraft((current) => ({
                              ...current,
                              generationMode: value as CountryTripWorkspaceState["preferences"]["generationMode"],
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
                      <div className="space-y-2 md:col-span-2 xl:col-span-4">
                        <label className="text-xs font-medium text-muted-foreground">תקציר AI</label>
                        <Textarea
                          value={draft.summary}
                          onChange={(event) =>
                            onPatchDraft((current) => ({ ...current, summary: event.target.value }))
                          }
                          rows={4}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                      <SummaryField label="כותרת" value={<p className="font-medium">{itineraryTitle}</p>} className="xl:col-span-2" />
                      <SummaryField label="תקציב" value={formatCurrency(draft.budget)} />
                      <SummaryField label="נוסעים" value={`${draft.travelers} נוסעים`} />
                      <SummaryField
                        label="מצב יצירה"
                        value={ITINERARY_GENERATION_MODE_LABELS[draft.generationMode]}
                      />
                      <SummaryField
                        label="תקציר AI"
                        className="md:col-span-2 xl:col-span-4"
                        value={
                          draft.summary ? (
                            <p className="leading-7 text-foreground/90">{draft.summary}</p>
                          ) : (
                            <span className="text-muted-foreground">אין עדיין תקציר למסלול הזה.</span>
                          )
                        }
                      />
                    </div>
                  )}
                </section>

                <section className="space-y-4">
                  <SectionTitle
                    title="ימי המסלול"
                    description="תצוגה קריאה של הימים עם מעבר מהיר לעריכה לפי צורך"
                  />

                  {draft.itineraryDays.map((day) => {
                    const isSelected = selectedDay?.id === day.id;
                    const isExpanded = expandedDayIds.has(day.id) || isSelected;
                    const completedCount = dayCompletionCount(day);
                    const mealHighlights = dayMealHighlights(day);
                    const activityCost = day.items.reduce(
                      (sum, item) => sum + (item.approximatePrice ?? 0),
                      0
                    );

                    return (
                      <article
                        key={day.id}
                        ref={(element) => {
                          daySectionRefs.current[day.id] = element;
                        }}
                        className="overflow-hidden rounded-[28px] border border-border/60 bg-card/70 shadow-sm"
                      >
                        <div className="px-4 py-4 sm:px-5">
                          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                            <button
                              type="button"
                              onClick={() => handleSelectDay(day.id)}
                              aria-expanded={isExpanded}
                              className="flex min-w-0 flex-1 items-start gap-3 text-right"
                            >
                              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[18px] border border-border/60 bg-background/70 text-sm font-semibold text-foreground">
                                {day.dayNumber}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h4 className="font-heading text-lg font-semibold text-foreground">
                                    Day {day.dayNumber} · {day.title || `יום ${day.dayNumber}`}
                                  </h4>
                                  {isSelected ? <Badge variant="secondary">נבחר</Badge> : null}
                                  {day.warnings.length > 0 ? (
                                    <Badge variant="outline" className="gap-1">
                                      <TriangleAlert className="size-3.5" />
                                      {day.warnings.length} אזהרות
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {[formatDate(day.date), day.cityRegion || null, day.accommodation ? `לינה: ${day.accommodation}` : null]
                                    .filter(Boolean)
                                    .join(" · ") || "ללא תאריך"}
                                </p>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <Badge variant="outline">{formatCurrency(day.estimatedCost)}</Badge>
                                  <Badge variant="outline">{day.items.length} פעילויות</Badge>
                                  {completedCount > 0 ? (
                                    <Badge variant="outline" className="gap-1">
                                      <CheckCircle2 className="size-3.5" />
                                      {completedCount} בוצעו
                                    </Badge>
                                  ) : null}
                                </div>
                              </div>
                            </button>

                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void onRegenerate(draft.id, "day", day.id)}
                                disabled={isRegenerating || isSaving}
                              >
                                <RefreshCcw className="size-4" />
                                Regenerate day
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => handleToggleExtraDay(day.id)}
                                aria-label={isExpanded ? "סגירת היום" : "פתיחת היום"}
                              >
                                {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                              </Button>
                            </div>
                          </div>
                        </div>

                        {isExpanded ? (
                          <div className="border-t border-border/60 px-4 py-5 sm:px-5">
                            <div className="space-y-5">
                              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                <SummaryField
                                  label="סיכום היום"
                                  value={
                                    day.notes ? (
                                      <p className="leading-7 text-foreground/90">{day.notes}</p>
                                    ) : (
                                      <span className="text-muted-foreground">אין עדיין סיכום ליום הזה.</span>
                                    )
                                  }
                                  className="xl:col-span-2"
                                />
                                <SummaryField
                                  label="לינה"
                                  value={
                                    <div className="flex items-center gap-2">
                                      <BedDouble className="size-4 text-primary" />
                                      <span>{day.accommodation || "לא צוין בסיס לינה"}</span>
                                    </div>
                                  }
                                />
                                <SummaryField
                                  label="זמן מעברים"
                                  value={
                                    <div className="flex items-center gap-2">
                                      <Clock className="size-4 text-primary" />
                                      <span>{day.totalTravelMinutes ? `${day.totalTravelMinutes} דק׳` : "לא חושב"}</span>
                                    </div>
                                  }
                                />
                                <SummaryField
                                  label="עלות פעילויות"
                                  value={activityCost > 0 ? formatCurrency(activityCost) : "לא חושב"}
                                />
                                <SummaryField
                                  label="ארוחות"
                                  value={
                                    mealHighlights.length > 0 ? (
                                      <div className="flex flex-wrap gap-2">
                                        {mealHighlights.slice(0, 4).map((meal) => (
                                          <Badge key={meal.id} variant="outline">
                                            {meal.name || DAY_PART_LABELS[meal.slot]}
                                          </Badge>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground">אין תחנות אוכל מסומנות.</span>
                                    )
                                  }
                                  className="md:col-span-2 xl:col-span-4"
                                />
                              </div>

                              {isEditMode ? (
                                <section className="rounded-[24px] border border-border/60 bg-background/55 p-4">
                                  <SectionTitle title="עריכת היום" description="שדות העריכה מוצגים רק בזמן edit mode." />
                                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">כותרת</label>
                                      <Input
                                        value={day.title}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            title: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">תאריך</label>
                                      <Input
                                        type="date"
                                        value={day.date}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            date: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">עיר / אזור</label>
                                      <Input
                                        value={day.cityRegion}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            cityRegion: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">לינה</label>
                                      <Input
                                        value={day.accommodation}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            accommodation: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">תחבורה עיקרית</label>
                                      <Input
                                        value={day.transportation}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            transportation: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">עלות יומית</label>
                                      <Input
                                        type="number"
                                        value={day.estimatedCost ?? ""}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            estimatedCost: event.target.value ? Number(event.target.value) : null,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">דקות נסיעה</label>
                                      <Input
                                        type="number"
                                        value={day.totalTravelMinutes ?? ""}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            totalTravelMinutes: event.target.value
                                              ? Number(event.target.value)
                                              : null,
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-xs font-medium text-muted-foreground">חלון מנוחה</label>
                                      <Input
                                        value={day.restWindow}
                                        onChange={(event) =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            restWindow: event.target.value,
                                          }))
                                        }
                                      />
                                    </div>
                                  </div>
                                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                    <Textarea
                                      value={day.notes}
                                      onChange={(event) =>
                                        onPatchDay(day.id, (current) => ({
                                          ...current,
                                          notes: event.target.value,
                                        }))
                                      }
                                      rows={3}
                                      placeholder="הערות יום"
                                    />
                                    <Textarea
                                      value={day.transportSegments.join("\n")}
                                      onChange={(event) =>
                                        onPatchDay(day.id, (current) => ({
                                          ...current,
                                          transportSegments: event.target.value
                                            .split("\n")
                                            .map((item) => item.trim())
                                            .filter(Boolean),
                                        }))
                                      }
                                      rows={3}
                                      placeholder="מקטעי תחבורה"
                                    />
                                    <Textarea
                                      value={day.warnings.join("\n")}
                                      onChange={(event) =>
                                        onPatchDay(day.id, (current) => ({
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
                                        onPatchDay(day.id, (current) => ({
                                          ...current,
                                          alternatives: event.target.value
                                            .split("\n")
                                            .map((item) => item.trim())
                                            .filter(Boolean),
                                        }))
                                      }
                                      rows={3}
                                      placeholder="חלופות"
                                    />
                                  </div>
                                </section>
                              ) : null}

                              <section className="space-y-4">
                                <SectionTitle
                                  title="ציר פעילויות"
                                  description="תצוגה קריאה של התחנות, המעברים והסטטוסים של היום."
                                  action={
                                    isEditMode ? (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() =>
                                          onPatchDay(day.id, (current) => ({
                                            ...current,
                                            items: [...current.items, createEmptyItineraryItem("morning")],
                                          }))
                                        }
                                      >
                                        <Plus className="size-4" />
                                        הוסף פעילות
                                      </Button>
                                    ) : null
                                  }
                                />

                                <div className="space-y-3">
                                  {day.items.map((item, itemIndex) => {
                                    const showEditor = isEditMode && editingItemId === item.id;
                                    const badges = activityStateBadges(item);

                                    return (
                                      <div key={item.id} className="space-y-3">
                                        {itemIndex > 0 && (item.transportation || item.travelMinutes) ? (
                                          <div className="flex items-center gap-2 rounded-[18px] border border-dashed border-border/60 bg-background/55 px-4 py-2 text-xs text-muted-foreground">
                                            <Route className="size-3.5" />
                                            <span>{item.transportation || "מעבר מקומי"}</span>
                                            {item.travelMinutes ? <span>· {item.travelMinutes} דק׳</span> : null}
                                          </div>
                                        ) : null}

                                        <div className="rounded-[24px] border border-border/60 bg-background/70 p-4">
                                          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                                            <div className="flex items-start gap-3 xl:w-[170px] xl:shrink-0">
                                              <div className="flex h-11 w-11 items-center justify-center rounded-[18px] border border-border/60 bg-muted/25 text-sm font-semibold text-foreground">
                                                {item.plannedStartTime || "—"}
                                              </div>
                                              <div className="min-w-0">
                                                <p className="text-xs text-muted-foreground">{DAY_PART_LABELS[item.slot]}</p>
                                                <p className="mt-1 text-sm font-medium text-foreground">
                                                  {item.estimatedDurationMinutes
                                                    ? `${item.estimatedDurationMinutes} דק׳`
                                                    : "משך לא צוין"}
                                                </p>
                                              </div>
                                            </div>

                                            <div className="min-w-0 flex-1">
                                              <div className="flex flex-wrap items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                  <div className="flex flex-wrap items-center gap-2">
                                                    <h5 className="font-semibold text-foreground">
                                                      {item.name || `פעילות ${itemIndex + 1}`}
                                                    </h5>
                                                    <Badge variant="secondary">
                                                      {RECOMMENDATION_CATEGORY_LABELS[item.category]}
                                                    </Badge>
                                                  </div>
                                                  <div className="mt-2 flex flex-wrap gap-3 text-sm text-muted-foreground">
                                                    <span className="inline-flex items-center gap-1.5">
                                                      <MapPin className="size-3.5" />
                                                      {item.location || "מיקום לא צוין"}
                                                    </span>
                                                    <span>{activityPrice(item.approximatePrice)}</span>
                                                    {item.openingHours ? <span>{item.openingHours}</span> : null}
                                                  </div>
                                                  {item.shortDescription ? (
                                                    <p className="mt-3 text-sm leading-7 text-foreground/90">
                                                      {item.shortDescription}
                                                    </p>
                                                  ) : null}
                                                  {item.plannedNotes ? (
                                                    <p className="mt-3 inline-flex items-start gap-2 text-sm leading-7 text-muted-foreground">
                                                      <NotebookPen className="mt-0.5 size-4 shrink-0 text-primary" />
                                                      <span>{item.plannedNotes}</span>
                                                    </p>
                                                  ) : null}
                                                </div>

                                                <div className="flex flex-wrap items-center gap-2">
                                                  {badges.map((badge) => (
                                                    <Badge key={badge.key} variant="outline">
                                                      {badge.label}
                                                    </Badge>
                                                  ))}
                                                  {isEditMode ? (
                                                    <Button
                                                      variant={showEditor ? "secondary" : "outline"}
                                                      size="sm"
                                                      onClick={() =>
                                                        setEditingItemId((current) =>
                                                          current === item.id ? null : item.id
                                                        )
                                                      }
                                                    >
                                                      עריכת פעילות
                                                    </Button>
                                                  ) : null}
                                                </div>
                                              </div>

                                              {showEditor ? (
                                                <div className="mt-4 space-y-4 rounded-[20px] border border-border/60 bg-card/70 p-4">
                                                  <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_repeat(5,minmax(0,140px))]">
                                                    <div className="space-y-3">
                                                      <Input
                                                        value={item.name}
                                                        onChange={(event) =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            name: event.target.value,
                                                          }))
                                                        }
                                                        placeholder="שם פעילות"
                                                      />
                                                      <Input
                                                        value={item.location}
                                                        onChange={(event) =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            location: event.target.value,
                                                          }))
                                                        }
                                                        placeholder="מיקום"
                                                      />
                                                      <Textarea
                                                        value={item.shortDescription}
                                                        onChange={(event) =>
                                                          onPatchItem(day.id, item.id, (current) => ({
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
                                                        onPatchItem(day.id, item.id, (current) => ({
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
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          plannedStartTime: event.target.value,
                                                        }))
                                                      }
                                                    />
                                                    <Input
                                                      type="number"
                                                      value={item.estimatedDurationMinutes ?? ""}
                                                      onChange={(event) =>
                                                        onPatchItem(day.id, item.id, (current) => ({
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
                                                        onPatchItem(day.id, item.id, (current) => ({
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
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          transportation: event.target.value,
                                                        }))
                                                      }
                                                      placeholder="תחבורה"
                                                    />
                                                    <Input
                                                      type="number"
                                                      value={item.travelMinutes ?? ""}
                                                      onChange={(event) =>
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          travelMinutes: event.target.value
                                                            ? Number(event.target.value)
                                                            : null,
                                                        }))
                                                      }
                                                      placeholder="דקות מעבר"
                                                    />
                                                  </div>

                                                  <div className="grid gap-3 lg:grid-cols-2">
                                                    <Textarea
                                                      value={item.plannedNotes}
                                                      onChange={(event) =>
                                                        onPatchItem(day.id, item.id, (current) => ({
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
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          bookingWarning: event.target.value,
                                                        }))
                                                      }
                                                      rows={2}
                                                      placeholder="אזהרת booking"
                                                    />
                                                    <Input
                                                      value={item.openingHours}
                                                      onChange={(event) =>
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          openingHours: event.target.value,
                                                        }))
                                                      }
                                                      placeholder="שעות פתיחה"
                                                    />
                                                    <Input
                                                      value={item.alternativeSuggestion}
                                                      onChange={(event) =>
                                                        onPatchItem(day.id, item.id, (current) => ({
                                                          ...current,
                                                          alternativeSuggestion: event.target.value,
                                                        }))
                                                      }
                                                      placeholder="חלופה מוצעת"
                                                    />
                                                  </div>

                                                  <div className="flex flex-wrap gap-2">
                                                    {[
                                                      {
                                                        label: "אופציונלי",
                                                        active: item.optional,
                                                        onToggle: () =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            optional: !current.optional,
                                                          })),
                                                      },
                                                      {
                                                        label: "הזמנה בוצעה",
                                                        active: item.bookingCompleted,
                                                        onToggle: () =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            bookingCompleted: !current.bookingCompleted,
                                                          })),
                                                      },
                                                      {
                                                        label: "נעול",
                                                        active: item.locked,
                                                        onToggle: () =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            locked: !current.locked,
                                                          })),
                                                      },
                                                      {
                                                        label: "בוצע",
                                                        active: item.completed,
                                                        onToggle: () =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            completed: !current.completed,
                                                            skipped: current.completed ? current.skipped : false,
                                                          })),
                                                      },
                                                      {
                                                        label: "דולג",
                                                        active: item.skipped,
                                                        onToggle: () =>
                                                          onPatchItem(day.id, item.id, (current) => ({
                                                            ...current,
                                                            skipped: !current.skipped,
                                                            completed: current.skipped ? current.completed : false,
                                                          })),
                                                      },
                                                    ].map((toggle) => (
                                                      <Badge
                                                        key={toggle.label}
                                                        variant={toggle.active ? "secondary" : "outline"}
                                                        className="cursor-pointer"
                                                        onClick={toggle.onToggle}
                                                      >
                                                        {toggle.label}
                                                      </Badge>
                                                    ))}
                                                  </div>

                                                  <ItemActualFields
                                                    item={item}
                                                    onPatch={(patch) =>
                                                      onPatchItem(day.id, item.id, (current) => ({
                                                        ...current,
                                                        ...patch,
                                                      }))
                                                    }
                                                  />

                                                  <div className="flex flex-wrap items-center gap-2">
                                                    <Select
                                                      value={day.id}
                                                      onValueChange={(value) =>
                                                        onPatchDraft((current) => {
                                                          if (value === day.id) return current;
                                                          const movingItem = day.items.find((entry) => entry.id === item.id);
                                                          if (!movingItem) return current;
                                                          return {
                                                            ...current,
                                                            itineraryDays: current.itineraryDays.map((entry) => {
                                                              if (entry.id === day.id) {
                                                                return {
                                                                  ...entry,
                                                                  items: entry.items.filter(
                                                                    (candidate) => candidate.id !== item.id
                                                                  ),
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
                                                      <SelectTrigger size="sm" className="min-w-44">
                                                        <span>העבר ליום אחר</span>
                                                      </SelectTrigger>
                                                      <SelectContent>
                                                        {draft.itineraryDays.map((targetDay) => (
                                                          <SelectItem key={targetDay.id} value={targetDay.id}>
                                                            Day {targetDay.dayNumber}
                                                          </SelectItem>
                                                        ))}
                                                      </SelectContent>
                                                    </Select>

                                                    <Button
                                                      variant="outline"
                                                      size="sm"
                                                      onClick={() =>
                                                        onPatchDay(day.id, (current) => {
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
                                                        onPatchDay(day.id, (current) => {
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
                                                        onPatchDay(day.id, (current) => ({
                                                          ...current,
                                                          items: [
                                                            ...current.items,
                                                            {
                                                              ...item,
                                                              id: createId("item"),
                                                              completed: false,
                                                              skipped: false,
                                                            },
                                                          ],
                                                        }))
                                                      }
                                                    >
                                                      שכפול פעילות
                                                    </Button>
                                                    <Button
                                                      variant="outline"
                                                      size="sm"
                                                      onClick={() => void onRegenerate(draft.id, "activity", day.id, item.id)}
                                                      disabled={isRegenerating || isSaving}
                                                    >
                                                      Regenerate activity
                                                    </Button>
                                                    <Button
                                                      variant="ghost"
                                                      size="sm"
                                                      onClick={() =>
                                                        onPatchDay(day.id, (current) => ({
                                                          ...current,
                                                          items: current.items.filter(
                                                            (candidate) => candidate.id !== item.id
                                                          ),
                                                        }))
                                                      }
                                                    >
                                                      הסרה
                                                    </Button>
                                                  </div>
                                                </div>
                                              ) : null}
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </section>

                              <div className="grid gap-4 lg:grid-cols-2">
                                <SummaryField
                                  label="מקטעי תחבורה"
                                  value={
                                    day.transportSegments.length > 0 ? (
                                      <div className="space-y-2">
                                        {day.transportSegments.map((segment, index) => (
                                          <div key={`${day.id}-segment-${index}`} className="flex items-center gap-2 text-sm">
                                            <Route className="size-4 text-primary" />
                                            <span>{segment}</span>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground">אין פירוט מקטעי תחבורה.</span>
                                    )
                                  }
                                />
                                <SummaryField
                                  label="דרישות הזמנה"
                                  value={
                                    day.bookingRequirements.length > 0 ? (
                                      <ul className="space-y-2 text-sm leading-6">
                                        {day.bookingRequirements.map((requirement, index) => (
                                          <li key={`${day.id}-booking-${index}`}>{requirement}</li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <span className="text-muted-foreground">אין דרישות מיוחדות ל-booking.</span>
                                    )
                                  }
                                />
                                <SummaryField
                                  label="הערות בטיחות"
                                  value={
                                    day.safetyNotes.length > 0 ? (
                                      <ul className="space-y-2 text-sm leading-6">
                                        {day.safetyNotes.map((note, index) => (
                                          <li key={`${day.id}-safety-${index}`}>{note}</li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <span className="text-muted-foreground">אין הערות בטיחות מיוחדות.</span>
                                    )
                                  }
                                />
                                <SummaryField
                                  label="חלופות"
                                  value={
                                    day.alternatives.length > 0 ? (
                                      <ul className="space-y-2 text-sm leading-6">
                                        {day.alternatives.map((alternative, index) => (
                                          <li key={`${day.id}-alt-${index}`}>{alternative}</li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <span className="text-muted-foreground">אין חלופות שמורות ליום הזה.</span>
                                    )
                                  }
                                />
                              </div>

                              {isEditMode ? (
                                <div className="flex flex-wrap gap-2 border-t border-border/60 pt-1">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                      const duplicate = {
                                        ...day,
                                        id: createId("day"),
                                        dayNumber: draft.itineraryDays.length + 1,
                                        title: `${day.title || `Day ${day.dayNumber}`} (copy)`,
                                        items: day.items.map((item) => ({
                                          ...item,
                                          id: createId("item"),
                                        })),
                                      };
                                      onPatchDraft((current) => ({
                                        ...current,
                                        daysCount: current.itineraryDays.length + 1,
                                        itineraryDays: [...current.itineraryDays, duplicate],
                                      }));
                                      handleSelectDay(duplicate.id);
                                    }}
                                  >
                                    <Copy className="size-4" />
                                    שכפול יום
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      const nextDays = draft.itineraryDays
                                        .filter((entry) => entry.id !== day.id)
                                        .map((entry, index) => ({ ...entry, dayNumber: index + 1 }));
                                      onPatchDraft((current) => ({
                                        ...current,
                                        daysCount: nextDays.length,
                                        itineraryDays: nextDays.length > 0 ? nextDays : [createEmptyDay(1)],
                                      }));
                                      const fallbackDayId =
                                        nextDays.find((entry) => entry.id !== day.id)?.id ??
                                        nextDays[0]?.id ??
                                        null;
                                      setSelectedDayId(fallbackDayId);
                                      setExpandedDayIds((current) => {
                                        const next = new Set(current);
                                        next.delete(day.id);
                                        if (fallbackDayId) next.add(fallbackDayId);
                                        return next;
                                      });
                                    }}
                                  >
                                    <Trash2 className="size-4" />
                                    מחיקת יום
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </section>
              </div>
            </ScrollArea>
          </div>

          <footer className="sticky bottom-0 z-20 shrink-0 border-t border-border/70 bg-background/95 px-4 py-4 backdrop-blur-sm sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={isDirty ? "secondary" : "outline"}>
                    {isDirty ? "יש שינויים שלא נשמרו" : "ללא שינויים"}
                  </Badge>
                  <span className="text-sm text-muted-foreground">נשמר לאחרונה: {lastSavedLabel}</span>
                </div>
              </div>

              {isEditMode ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={resetEditMode} disabled={isSaving}>
                    ביטול
                  </Button>
                  <Button className="gap-1.5" onClick={() => void handleSave()} disabled={!isDirty || isSaving}>
                    {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                    שמירת שינויים
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    סגירה
                  </Button>
                  <Button onClick={() => setIsEditMode(true)}>
                    עריכת המסלול
                  </Button>
                </div>
              )}
            </div>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
