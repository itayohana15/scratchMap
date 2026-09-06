"use client";

import {
  Archive,
  BedDouble,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Ellipsis,
  Footprints,
  Gauge,
  History,
  ImagePlus,
  LoaderCircle,
  LuggageIcon,
  MapPin,
  NotebookPen,
  Plus,
  RefreshCcw,
  Route,
  Save,
  Sparkles,
  Star,
  Ticket,
  Trash2,
  TriangleAlert,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";

import { BookingCenterSection } from "@/components/country/booking-center-section";
import {
  ItineraryDayRouteSection,
  ItineraryTripSummarySection,
} from "@/components/country/itinerary-route-map";
import { TripChecklistSection } from "@/components/country/trip-checklist-section";
import { TripJournalSection } from "@/components/country/trip-journal-section";
import { TripSummarySection } from "@/components/country/trip-summary-section";
import { TravelWalletSection } from "@/components/country/travel-wallet-section";
import { PhotoGallery } from "@/components/gallery/photo-gallery";
import {
  buildSuggestedItineraryTitle,
  createWorkspaceFromItineraryRecord,
  type CountryItineraryRecord,
  type CountryItineraryStatus,
  type CountryItineraryVersionRecord,
  type CountryItineraryVersionSource,
} from "@/lib/itineraries";
import { formatCurrency, formatDate, formatHoursMinutes, formatTripDateRange } from "@/lib/format";
import type { Tables } from "@/lib/supabase/types";
import {
  analyzeDayGeography,
  buildDayExplanation,
  buildRouteHealthIndicators,
  buildTripPreferenceProfile,
  computeDayIntensity,
  countDayTimeOverlaps,
} from "@/lib/server/itinerary-generation-constraints";
import { bookings, createBookingLinkedToItem, upsertBooking } from "@/lib/trip-bookings";
import { activityStateBadges, bookingStatusForItem, transportModeIcon } from "@/lib/trip-item-status";
import { appendDocument } from "@/lib/trip-documents";
import { computeTripReadiness, isReadinessApplicable, type ReadinessCategory } from "@/lib/trip-readiness";
import { isTripActiveNow } from "@/lib/live-trip-time";
import { LiveTripTodaySection } from "@/components/country/live-trip-today-section";
import { TripActualSection } from "@/components/country/trip-actual-section";
import { TripPackingSection } from "@/components/country/trip-packing-section";
import {
  buildMapLink,
  createEmptyDay,
  createEmptyItineraryItem,
  createId,
  dateForDayNumber,
  DAY_PART_LABELS,
  ITEM_PRIORITY_LABELS,
  ITINERARY_GENERATION_MODE_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  type CountryTripWorkspaceState,
  type DayOptimizeMode,
  type DayPart,
  type ItemPriority,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

type RegenerateScope =
  | "full"
  | "day"
  | "activity"
  | "optimize_route"
  | "recalculate_costs"
  | "live_replan"
  | "live_replace_item";

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
      <Input
        value={item.actualPlaceName}
        onChange={(event) => onPatch({ actualPlaceName: event.target.value })}
        placeholder="מקום בפועל (אם היה שונה מהמתוכנן)"
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

// Standard checkout -> travel -> check-in sequence for a hotel-change day,
// inserted as explicit practical-type timeline items so the day doesn't
// silently "teleport" the traveler between bases.
const HOTEL_CHANGE_DAY_TEMPLATE: Array<{ slot: DayPart; fields: Partial<TripItineraryItem> }> = [
  { slot: "morning", fields: { name: "צ'ק-אאוט", category: "practical", plannedStartTime: "08:00", estimatedDurationMinutes: 30 } },
  { slot: "morning", fields: { name: "נסיעה לתחנה/שדה תעופה", category: "practical", plannedStartTime: "08:30", estimatedDurationMinutes: 40 } },
  { slot: "morning", fields: { name: "רכבת/טיסה", category: "transportation", plannedStartTime: "09:10", estimatedDurationMinutes: 170 } },
  { slot: "afternoon", fields: { name: "הגעה ליעד", category: "practical", plannedStartTime: "12:00", estimatedDurationMinutes: 20 } },
  { slot: "afternoon", fields: { name: "הפקדת מזוודות", category: "practical", plannedStartTime: "12:20", estimatedDurationMinutes: 20 } },
  { slot: "evening", fields: { name: "צ'ק-אין", category: "practical", plannedStartTime: "18:00", estimatedDurationMinutes: 30 } },
];

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

const SUMMARY_TAB_VALUE = "__trip-summary__";

type TripSectionValue =
  | "today"
  | "route"
  | "actual"
  | "packing"
  | "map"
  | "bookings"
  | "wallet"
  | "checklist"
  | "journal"
  | "photos"
  | "trip_summary";

const BASE_TRIP_SECTIONS: Array<{ value: TripSectionValue; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: "route", label: "מסלול", icon: Route },
  { value: "map", label: "מפה", icon: MapPin },
  { value: "bookings", label: "הזמנות", icon: Ticket },
  { value: "wallet", label: "ארנק נסיעות", icon: Wallet },
  { value: "checklist", label: "צ'קליסט", icon: CheckCircle2 },
  { value: "packing", label: "אריזה", icon: LuggageIcon },
  { value: "actual", label: "בפועל", icon: History },
  { value: "journal", label: "יומן", icon: NotebookPen },
  { value: "photos", label: "תמונות", icon: ImagePlus },
  { value: "trip_summary", label: "סיכום הטיול", icon: Star },
];

// Each trip stage emphasizes what's actually relevant right now (spec §40):
// upcoming = plan/prep first; active = today/route/map first, logistics
// secondary; completed = memories/history first, prep stuff secondary.
// Nothing is ever fully hidden — "secondary" means it moves into the "עוד"
// menu, not that the data becomes unreachable.
const UPCOMING_SECTION_ORDER: TripSectionValue[] = [
  "route", "map", "bookings", "wallet", "checklist", "packing", "actual", "journal", "photos", "trip_summary",
];
const UPCOMING_PRIMARY_COUNT = 4;

const ACTIVE_SECTION_ORDER: TripSectionValue[] = [
  "route", "map", "bookings", "wallet", "journal", "photos", "actual", "checklist", "packing", "trip_summary",
];
const ACTIVE_PRIMARY_COUNT = 2; // "today" is prepended separately and always counts as primary too.

const COMPLETED_SECTION_ORDER: TripSectionValue[] = [
  "actual", "route", "journal", "photos", "trip_summary", "bookings", "wallet", "checklist", "packing",
];
const COMPLETED_PRIMARY_COUNT = 5;

function orderSections(order: TripSectionValue[]) {
  return order.map((value) => BASE_TRIP_SECTIONS.find((section) => section.value === value)!).filter(Boolean);
}

function sectionOrderForStatus(status: CountryItineraryStatus, isActive: boolean) {
  if (status === "completed") return { order: COMPLETED_SECTION_ORDER, primaryCount: COMPLETED_PRIMARY_COUNT };
  if (isActive) return { order: ACTIVE_SECTION_ORDER, primaryCount: ACTIVE_PRIMARY_COUNT };
  return { order: UPCOMING_SECTION_ORDER, primaryCount: UPCOMING_PRIMARY_COUNT };
}

// "היום" only exists for a trip that's actually active right now (spec:
// don't show Live Mode for upcoming/completed/historical trips) — prepended
// so it reads as the prominent, first option when present.
function buildTripSections(isActive: boolean, status: CountryItineraryStatus) {
  const { order } = sectionOrderForStatus(status, isActive);
  const base = orderSections(order);
  if (!isActive) return base;
  return [{ value: "today" as const, label: "היום", icon: Sparkles }, ...base];
}

function tabValueForDay(dayId: string) {
  return `day:${dayId}`;
}

function dayIdFromTabValue(value: string | null) {
  if (!value?.startsWith("day:")) return null;
  return value.slice(4);
}

function getScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function isRtlLayout(node: HTMLElement | null) {
  if (typeof window === "undefined") return true;
  const direction = node
    ? window.getComputedStyle(node).direction
    : document.documentElement.dir || "rtl";
  return direction === "rtl";
}

interface CountryItineraryDetailsDialogProps {
  open: boolean;
  draft: CountryItineraryRecord | null;
  activeItinerary: CountryItineraryRecord | null;
  country: Pick<Tables<"countries">, "name">;
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
    targetItemId?: string | null,
    optimizeMode?: DayOptimizeMode | null,
    liveInstruction?: string | null
  ) => Promise<void> | void;
  onRestore: (versionId: string) => Promise<void> | void;
  onArchive: (itineraryId: string) => Promise<void> | void;
  onDelete: (itinerary: CountryItineraryRecord) => void;
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
  onArchive,
  onDelete,
  onExport,
}: CountryItineraryDetailsDialogProps) {
  const [isEditMode, setIsEditMode] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<TripSectionValue>("route");
  const [selectedTab, setSelectedTab] = useState<string>("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [activeMapItemIdsByDay, setActiveMapItemIdsByDay] = useState<Record<string, string[]>>({});
  const [timelineFocusItemId, setTimelineFocusItemId] = useState<string | null>(null);
  const [bookingFocusItemId, setBookingFocusItemId] = useState<string | null>(null);
  const itemCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [shouldLoadSummaryMap, setShouldLoadSummaryMap] = useState(false);
  const bodyViewportRef = useRef<HTMLDivElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const draftId = draft?.id ?? null;
  const draftVersion = draft?.version ?? 0;
  const draftDayIds = draft?.itineraryDays.map((day) => day.id) ?? [];
  const draftDayIdsKey = draftDayIds.join("|");
  const firstDayId = draftDayIds[0] ?? null;
  const effectiveSelectedTab = selectedTab || (firstDayId ? tabValueForDay(firstDayId) : SUMMARY_TAB_VALUE);
  const draftDayIdSet = useMemo(
    () => new Set(draftDayIdsKey ? draftDayIdsKey.split("|") : []),
    [draftDayIdsKey]
  );

  useEffect(() => {
    if (!draftId) return;
    setSelectedTab((current) => {
      if (current === SUMMARY_TAB_VALUE) return current;
      const currentDayId = dayIdFromTabValue(current);
      if (currentDayId && draftDayIdSet.has(currentDayId)) {
        return current;
      }
      return firstDayId ? tabValueForDay(firstDayId) : SUMMARY_TAB_VALUE;
    });
    setIsEditMode(false);
    setEditingItemId(null);
    setActiveMapItemIdsByDay({});
    setTimelineFocusItemId(null);
    setBookingFocusItemId(null);
  }, [draftDayIdSet, draftDayIdsKey, draftId, draftVersion, firstDayId]);

  useEffect(() => {
    setTimelineFocusItemId(null);
  }, [effectiveSelectedTab]);

  useEffect(() => {
    setShouldLoadSummaryMap(false);
  }, [draftId]);

  useEffect(() => {
    if (effectiveSelectedTab === SUMMARY_TAB_VALUE) {
      setShouldLoadSummaryMap(true);
    }
  }, [effectiveSelectedTab]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      tabButtonRefs.current[effectiveSelectedTab]?.scrollIntoView({
        inline: "center",
        block: "nearest",
        behavior: getScrollBehavior(),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draftDayIdsKey, effectiveSelectedTab]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      bodyViewportRef.current?.scrollTo({
        top: 0,
        behavior: getScrollBehavior(),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [effectiveSelectedTab]);

  const selectedDayId =
    effectiveSelectedTab === SUMMARY_TAB_VALUE ? null : dayIdFromTabValue(effectiveSelectedTab);
  const selectedDay = useMemo(() => {
    if (!selectedDayId) return null;
    return draft?.itineraryDays.find((day) => day.id === selectedDayId) ?? null;
  }, [draft, selectedDayId]);

  // Map marker click -> scroll the matching timeline card into view (the
  // reverse of clicking a timeline card, which sets timelineFocusItemId and
  // pans the map via ItineraryDayRouteSection's focusItemId prop below).
  const activeMapItemIds = selectedDayId ? activeMapItemIdsByDay[selectedDayId] : undefined;
  useEffect(() => {
    if (!activeMapItemIds || activeMapItemIds.length !== 1) return;
    const frame = window.requestAnimationFrame(() => {
      itemCardRefs.current[activeMapItemIds[0]]?.scrollIntoView({
        block: "center",
        behavior: getScrollBehavior(),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMapItemIds]);

  if (!draft) {
    return null;
  }

  const tabValues = [...draft.itineraryDays.map((day) => tabValueForDay(day.id)), SUMMARY_TAB_VALUE];
  const isSummarySelected = effectiveSelectedTab === SUMMARY_TAB_VALUE;
  const isRtl = isRtlLayout(tabListRef.current);

  const itineraryTitle =
    draft.title || buildSuggestedItineraryTitle(country.name, draft.startDate, draft.endDate);

  const itineraryMeta = [
    country.name,
    formatTripDateRange(draft.startDate, draft.endDate, draft.preferencesSnapshot.partialDate),
    `${draft.daysCount} ימים`,
    `${draft.travelers} נוסעים`,
    formatCurrency(draft.costSummary.totalEstimatedCost),
  ].filter(Boolean);

  const lastSavedLabel =
    formatDate(activeItinerary?.updatedAt ?? draft.updatedAt, "d בMMM yyyy HH:mm") ?? "עדיין לא נשמר";
  const selectedPanelId = isSummarySelected
    ? "itinerary-panel-summary"
    : selectedDay
      ? `itinerary-panel-${selectedDay.id}`
      : undefined;
  const selectedPanelTabId = isSummarySelected
    ? "itinerary-tab-summary"
    : selectedDay
      ? `itinerary-tab-${selectedDay.id}`
      : undefined;
  const selectedDayCompletedCount = selectedDay ? dayCompletionCount(selectedDay) : 0;
  const selectedDayMealHighlights = selectedDay ? dayMealHighlights(selectedDay) : [];
  const selectedDayActivityCost = selectedDay
    ? selectedDay.items.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0)
    : 0;
  const selectedDayIntensity = selectedDay ? computeDayIntensity(selectedDay.items) : null;
  // Route-health badges (spec item 97) — only the signals cheaply knowable
  // right here (no TripPreferenceProfile in this dialog, so the fuller
  // geography-based indicators aren't computed) — real geography-clustering
  // health is already reflected in day.warnings, so an empty warnings list
  // is a real, honest proxy for "no known route problems this day."
  const selectedDayRouteHealth = selectedDay
    ? buildRouteHealthIndicators({
        longTravelSegments: selectedDay.warnings.length,
        crossCityItems: 0,
        timeOverlaps: countDayTimeOverlaps(selectedDay),
      })
    : [];
  // One trip-level profile (spec item 2) — the exact same function
  // generation itself uses (buildTripPreferenceProfile), derived from the
  // canonical preferencesSnapshot already flowing into this dialog. Never
  // duplicated per day, never a separate preference store. Not a useMemo:
  // this line sits after the early `if (!draft) return null` below like
  // selectedDayIntensity/selectedDayRouteHealth right above it, so a hook
  // here would violate rules-of-hooks the same way theirs would.
  const tripPreferenceProfile = buildTripPreferenceProfile(
    draft.preferencesSnapshot,
    country.name,
    draft.itineraryDays.length
  );
  const selectedDayExplanation = selectedDay
    ? buildDayExplanation(selectedDay, analyzeDayGeography(selectedDay, tripPreferenceProfile))
    : "";
  const tripBookings = bookings(draft);
  const readiness = isReadinessApplicable(draft.status) ? computeTripReadiness(draft) : null;
  const readinessIssues: ReadinessCategory[] =
    readiness?.categories.filter((category) => category.status === "missing" || category.status === "partial") ?? [];
  const isTripLiveActive = isTripActiveNow(draft.startDate, draft.endDate, draft.isoA2);
  const tripSections = buildTripSections(isTripLiveActive, draft.status);
  // Every trip stage emphasizes what's actually relevant right now (spec
  // §40) — the rest stays reachable in a secondary "עוד" menu rather than
  // disappearing. "today" (when present) always counts as primary.
  const { primaryCount } = sectionOrderForStatus(draft.status, isTripLiveActive);
  const effectivePrimaryCount = primaryCount + (isTripLiveActive ? 1 : 0);
  const primaryTripSections = tripSections.slice(0, effectivePrimaryCount);
  const moreTripSections = tripSections.slice(effectivePrimaryCount);

  function handleAddDay() {
    if (!draft) {
      return;
    }

    const nextDay = createEmptyDay(
      draft.itineraryDays.length + 1,
      dateForDayNumber(draft.preferencesSnapshot.startDate, draft.itineraryDays.length + 1)
    );
    onPatchDraft((current) => ({
      ...current,
      daysCount: current.itineraryDays.length + 1,
      itineraryDays: [...current.itineraryDays, nextDay],
    }));
    setSelectedTab(tabValueForDay(nextDay.id));
    setIsEditMode(true);
  }

  function handleCreateAllDays() {
    if (!draft) {
      return;
    }

    const targetCount = Math.max(draft.daysCount, draft.itineraryDays.length, 1);
    const startDate = draft.startDate || draft.preferencesSnapshot.startDate;
    const newDays = Array.from({ length: targetCount }, (_, index) =>
      createEmptyDay(index + 1, startDate ? dateForDayNumber(startDate, index + 1) : "")
    );
    onPatchDraft((current) => ({
      ...current,
      daysCount: targetCount,
      itineraryDays: newDays,
    }));
    setSelectedTab(tabValueForDay(newDays[0].id));
    setIsEditMode(true);
  }

  function handleSelectDay(dayId: string) {
    setSelectedTab(tabValueForDay(dayId));
  }

  function handleSelectSummary() {
    setShouldLoadSummaryMap(true);
    setSelectedTab(SUMMARY_TAB_VALUE);
  }

  function focusTab(value: string) {
    const frame = window.requestAnimationFrame(() => {
      tabButtonRefs.current[value]?.focus();
    });
    window.setTimeout(() => window.cancelAnimationFrame(frame), 600);
  }

  function handleSelectTabValue(value: string) {
    if (value === SUMMARY_TAB_VALUE) {
      handleSelectSummary();
      return;
    }

    const dayId = dayIdFromTabValue(value);
    if (dayId) {
      handleSelectDay(dayId);
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentValue: string) {
    const currentIndex = tabValues.indexOf(currentValue);
    if (currentIndex < 0) return;

    const rtl = isRtlLayout(tabListRef.current);
    let nextIndex: number | null = null;

    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabValues.length - 1;
    if (event.key === "ArrowLeft") {
      nextIndex = rtl
        ? Math.min(currentIndex + 1, tabValues.length - 1)
        : Math.max(currentIndex - 1, 0);
    }
    if (event.key === "ArrowRight") {
      nextIndex = rtl
        ? Math.max(currentIndex - 1, 0)
        : Math.min(currentIndex + 1, tabValues.length - 1);
    }

    if (nextIndex == null) return;
    event.preventDefault();
    const nextValue = tabValues[nextIndex];
    handleSelectTabValue(nextValue);
    focusTab(nextValue);
  }

  function scrollTabs(direction: "previous" | "next") {
    const node = tabListRef.current;
    if (!node) return;

    const delta = direction === "next" ? 280 : -280;
    const signedDelta = isRtlLayout(node) ? -delta : delta;
    node.scrollBy({
      left: signedDelta,
      behavior: getScrollBehavior(),
    });
  }

  function handleTabListWheel(event: React.WheelEvent<HTMLDivElement>) {
    const node = tabListRef.current;
    if (!node) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (node.scrollWidth <= node.clientWidth) return;

    event.preventDefault();
    const signedDelta = isRtlLayout(node) ? -event.deltaY : event.deltaY;
    node.scrollBy({ left: signedDelta });
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
                      <DropdownMenuItem onClick={() => onExport(draft)}>
                        <Download className="size-4" />
                        ייצוא JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void onArchive(draft.id)}>
                        <Archive className="size-4" />
                        ארכוב
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => onDelete(draft)}>
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
                {readiness ? (
                  <Badge variant={readiness.overallPercent >= 80 ? "secondary" : "outline"}>
                    טיול מוכן ב-{readiness.overallPercent}%
                  </Badge>
                ) : null}
              </div>

              {readiness && readinessIssues.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15"
                      />
                    }
                  >
                    <TriangleAlert className="size-3.5" />
                    {readinessIssues.length} דברים דורשים טיפול
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    {readinessIssues.map((category) => (
                      <DropdownMenuItem
                        key={category.key}
                        onClick={() => setActiveSection(category.section)}
                        title={category.detail || undefined}
                      >
                        <TriangleAlert className="size-3.5" />
                        {category.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}

              <div
                role="tablist"
                aria-label="חלקי הטיול"
                className="flex flex-wrap gap-1.5 rounded-2xl border border-border/60 bg-background/60 p-1.5"
              >
                {primaryTripSections.map((section) => {
                  const selected = activeSection === section.value;
                  return (
                    <button
                      key={section.value}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setActiveSection(section.value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                        selected
                          ? "bg-primary/10 text-primary shadow-sm"
                          : section.value === "today"
                            ? "text-primary hover:bg-primary/10"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      )}
                    >
                      <section.icon className="size-4" />
                      {section.label}
                    </button>
                  );
                })}
                {moreTripSections.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                            moreTripSections.some((section) => section.value === activeSection)
                              ? "bg-primary/10 text-primary shadow-sm"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          )}
                        />
                      }
                    >
                      <Ellipsis className="size-4" />
                      עוד
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {moreTripSections.map((section) => (
                        <DropdownMenuItem key={section.value} onClick={() => setActiveSection(section.value)}>
                          <section.icon className="size-4" />
                          {section.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {activeSection === "route" ? (
              <>
              <div className="flex flex-wrap gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="sm" disabled={isRegenerating || isSaving} />}>
                    {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Route className="size-4" />}
                    אופטימיזציה למסלול
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onClick={() =>
                        void onRegenerate(draft.id, "optimize_route", selectedDayId ?? null, null, "fewer_transfers")
                      }
                    >
                      פחות מעברים{selectedDayId ? " (היום הנוכחי)" : " (כל הימים)"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        void onRegenerate(draft.id, "optimize_route", selectedDayId ?? null, null, "less_walking")
                      }
                    >
                      פחות הליכה{selectedDayId ? " (היום הנוכחי)" : " (כל הימים)"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {isEditMode ? (
                  <Button variant="outline" size="sm" onClick={handleAddDay} disabled={isSaving}>
                    <Plus className="size-4" />
                    הוסף יום
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                    <Ellipsis className="size-4" />
                    עוד פעולות
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onClick={() => onLoadWorkspace(createWorkspaceFromItineraryRecord(draft, country.name))}
                      disabled={isSaving}
                    >
                      פתח ב-workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void onRegenerate(draft.id, "recalculate_costs")}
                      disabled={isRegenerating || isSaving}
                    >
                      <Wallet className="size-4" />
                      חשב עלויות מחדש
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void onRegenerate(draft.id, "full")}
                      disabled={isRegenerating || isSaving}
                    >
                      <RefreshCcw className="size-4" />
                      Regenerate
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setVersionsOpen(true)}>
                      <History className="size-4" />
                      גרסאות ({versions.length})
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Sheet open={versionsOpen} onOpenChange={setVersionsOpen}>
                  <SheetContent side="left" className="w-full sm:max-w-md">
                    <SheetHeader>
                      <SheetTitle>היסטוריית גרסאות</SheetTitle>
                      <SheetDescription>
                        שחזור נקודות שמירה קודמות בלי לבזבז מקום קבוע בתוך המסלול.
                      </SheetDescription>
                    </SheetHeader>
                    <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
                      <div className="space-y-3">
                        {versions.map((version) => {
                          const isCurrent = version.version === draft.version;
                          return (
                            <div
                              key={version.id}
                              className="rounded-[20px] border border-border/60 bg-background/65 p-3"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-medium text-foreground">גרסה {version.version}</p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {versionLabel(version)}
                                  </p>
                                </div>
                                <Badge variant={isCurrent ? "secondary" : "outline"}>
                                  {VERSION_SOURCE_LABELS[version.source]}
                                </Badge>
                              </div>
                              {version.changeReason ? (
                                <p className="mt-3 text-xs leading-6 text-muted-foreground">
                                  {version.changeReason}
                                </p>
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
                    </ScrollArea>
                  </SheetContent>
                </Sheet>
              </div>

              <div className="space-y-3 border-t border-border/60 pt-4">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => scrollTabs("previous")}
                    aria-label="גלילה ללשוניות קודמות"
                  >
                    {isRtl ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
                  </Button>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <div
                      ref={tabListRef}
                      role="tablist"
                      aria-label="ימי המסלול"
                      onWheel={handleTabListWheel}
                      className="flex flex-nowrap gap-2 overflow-x-auto pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                    >
                      {draft.itineraryDays.map((day) => {
                        const value = tabValueForDay(day.id);
                        const selected = effectiveSelectedTab === value;
                        return (
                          <button
                            key={value}
                            ref={(element) => {
                              tabButtonRefs.current[value] = element;
                            }}
                            id={`itinerary-tab-${day.id}`}
                            type="button"
                            role="tab"
                            aria-controls={`itinerary-panel-${day.id}`}
                            aria-selected={selected}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => handleSelectDay(day.id)}
                            onKeyDown={(event) => handleTabKeyDown(event, value)}
                            className={cn(
                              "min-w-[8.75rem] shrink-0 rounded-[18px] border px-3 py-2 text-right transition-all",
                              selected
                                ? "border-primary/40 bg-primary/10 font-semibold text-foreground ring-1 ring-primary/20 shadow-sm"
                                : "border-border/60 bg-background/70 text-foreground/80 hover:bg-muted/60"
                            )}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold">יום {day.dayNumber}</span>
                              {day.warnings.length > 0 ? (
                                <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]">
                                  {day.warnings.length}
                                </Badge>
                              ) : null}
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                              {[compactDate(day.date), day.cityRegion || null].filter(Boolean).join(" · ") ||
                                "ללא תאריך"}
                            </span>
                          </button>
                        );
                      })}

                      <button
                        ref={(element) => {
                          tabButtonRefs.current[SUMMARY_TAB_VALUE] = element;
                        }}
                        id="itinerary-tab-summary"
                        type="button"
                        role="tab"
                        aria-controls="itinerary-panel-summary"
                        aria-selected={isSummarySelected}
                        tabIndex={isSummarySelected ? 0 : -1}
                        onClick={handleSelectSummary}
                        onKeyDown={(event) => handleTabKeyDown(event, SUMMARY_TAB_VALUE)}
                        className={cn(
                          "min-w-[9.5rem] shrink-0 rounded-[18px] border px-3 py-2 text-right transition-all",
                          isSummarySelected
                            ? "border-primary/40 bg-primary/10 font-semibold text-foreground ring-1 ring-primary/20 shadow-sm"
                            : "border-border/60 bg-background/70 text-foreground/80 hover:bg-muted/60"
                        )}
                      >
                        <span className="block text-sm font-semibold">סיכום מסלול</span>
                        <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                          מפה מלאה, תקציב ותובנות מסלול
                        </span>
                      </button>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => scrollTabs("next")}
                    aria-label="גלילה ללשוניות הבאות"
                  >
                    {isRtl ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
                  </Button>
                </div>
              </div>
              </>
              ) : null}
            </div>
          </header>

          <div ref={bodyViewportRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-6 px-4 py-4 pb-28 sm:px-6 sm:py-6 sm:pb-32">
              {activeSection === "today" && isTripLiveActive ? (
                <LiveTripTodaySection
                  draft={draft}
                  countryName={country.name}
                  onPatchDraft={onPatchDraft}
                  onPatchDay={onPatchDay}
                  onPatchItem={onPatchItem}
                  onRegenerate={onRegenerate}
                  isRegenerating={isRegenerating}
                />
              ) : activeSection === "map" ? (
                <ItineraryTripSummarySection
                  days={draft.itineraryDays}
                  countryName={country.name}
                  isoA2={draft.isoA2}
                  onPatchDay={onPatchDay}
                  onPatchItem={onPatchItem}
                  onOpenDay={(dayId) => {
                    setActiveSection("route");
                    handleSelectDay(dayId);
                  }}
                />
              ) : activeSection === "bookings" ? (
                <BookingCenterSection draft={draft} onPatchDraft={onPatchDraft} focusItemId={bookingFocusItemId} />
              ) : activeSection === "wallet" ? (
                <TravelWalletSection
                  draft={draft}
                  onPatchDraft={onPatchDraft}
                  isoA2={draft.isoA2}
                  onDocumentUploaded={(document) => appendDocument(onPatchDraft, document)}
                />
              ) : activeSection === "checklist" ? (
                <TripChecklistSection draft={draft} onPatchDraft={onPatchDraft} isoA2={draft.isoA2} />
              ) : activeSection === "packing" ? (
                <TripPackingSection draft={draft} onPatchDraft={onPatchDraft} />
              ) : activeSection === "actual" ? (
                <TripActualSection draft={draft} onPatchDay={onPatchDay} onPatchItem={onPatchItem} />
              ) : activeSection === "journal" ? (
                <TripJournalSection draft={draft} onPatchDraft={onPatchDraft} />
              ) : activeSection === "photos" ? (
                <PhotoGallery
                  itineraryId={draft.id}
                  countryId={draft.countryId}
                  title="תמונות הטיול"
                />
              ) : activeSection === "trip_summary" ? (
                <TripSummarySection draft={draft} country={country} onPatchDraft={onPatchDraft} />
              ) : isSummarySelected ? (
                <div
                  id={selectedPanelId}
                  role="tabpanel"
                  aria-labelledby={selectedPanelTabId}
                  tabIndex={0}
                  className="space-y-6 outline-none"
                >
                  {draft.itineraryDays.length === 0 ? (
                    <section className="rounded-[28px] border border-dashed border-border/70 bg-background/70 p-6 text-center sm:p-8">
                      <div className="mx-auto flex max-w-xl flex-col items-center gap-3">
                        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                          <History className="size-5" />
                        </div>
                        <h4 className="font-heading text-lg font-semibold text-foreground">
                          עדיין לא נוסף פירוט לטיול הזה
                        </h4>
                        <p className="text-sm leading-6 text-muted-foreground">
                          זה טיול שכבר קרה, אבל עדיין לא שמור לו מסלול יום־יומי. אפשר להוסיף פרטים
                          בהדרגה, יום אחרי יום, או ליצור בבת אחת את כל ימי הטיול ולמלא אותם לאט
                          לאט.
                        </p>
                        <div className="mt-2 flex flex-wrap justify-center gap-2">
                          <Button size="sm" onClick={() => setIsEditMode(true)}>
                            <NotebookPen className="size-4" />
                            הוסף פרטי מסלול
                          </Button>
                          <Button size="sm" variant="outline" onClick={handleAddDay}>
                            <Plus className="size-4" />
                            הוסף יום
                          </Button>
                          {draft.daysCount > 1 ? (
                            <Button size="sm" variant="outline" onClick={handleCreateAllDays}>
                              <CalendarRange className="size-4" />
                              צור את כל ימי הטיול ({draft.daysCount})
                            </Button>
                          ) : null}
                          {draft.source === "historical_manual" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void onRegenerate(draft.id, "full")}
                              disabled={isRegenerating || isSaving}
                            >
                              {isRegenerating ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <Sparkles className="size-4" />
                              )}
                              עזור לי לשחזר את הטיול
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </section>
                  ) : null}

                  <section className="rounded-[28px] border border-border/60 bg-card/70 p-5 shadow-sm sm:p-6">
                    <SectionTitle
                      title="פרטי המסלול"
                      description="הגדרות כלליות, תקציר AI ופרטי בסיס של הטיול."
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
                        <SummaryField
                          label="כותרת"
                          value={<p className="font-medium">{itineraryTitle}</p>}
                          className="xl:col-span-2"
                        />
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

                  <section className="rounded-[28px] border border-border/60 bg-card/70 p-5 shadow-sm sm:p-6">
                    <SectionTitle
                      title="סיכום מסלול"
                      description="מפה מלאה של כל הימים, הלינות, המעברים וההתפלגות הכללית של המסלול."
                      action={<Badge variant="outline">{draft.itineraryDays.length} ימים</Badge>}
                    />

                    <div className="mt-5">
                      {shouldLoadSummaryMap ? (
                        <ItineraryTripSummarySection
                          days={draft.itineraryDays}
                          countryName={country.name}
                          isoA2={draft.isoA2}
                          onPatchDay={onPatchDay}
                          onPatchItem={onPatchItem}
                          onOpenDay={handleSelectDay}
                        />
                      ) : (
                        <div className="rounded-[24px] border border-dashed border-border/70 bg-background/70 p-6 text-sm text-muted-foreground">
                          מפת הסיכום המלאה תיטען כשתעברו ללשונית הזו.
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              ) : selectedDay ? (
                <div
                  id={selectedPanelId}
                  role="tabpanel"
                  aria-labelledby={selectedPanelTabId}
                  tabIndex={0}
                  className="space-y-6 outline-none"
                >
                  <article className="overflow-hidden rounded-[28px] border border-border/60 bg-card/70 shadow-sm">
                    <div className="px-4 py-4 sm:px-5">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="flex min-w-0 flex-1 items-start gap-3 text-right">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[18px] border border-border/60 bg-background/70 text-sm font-semibold text-foreground">
                            {selectedDay.dayNumber}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="font-heading text-lg font-semibold text-foreground">
                                Day {selectedDay.dayNumber} · {selectedDay.title || `יום ${selectedDay.dayNumber}`}
                              </h4>
                              <Badge variant="secondary">נבחר</Badge>
                              {selectedDay.theme ? <Badge variant="outline">{selectedDay.theme}</Badge> : null}
                              {selectedDay.warnings.length > 0 ? (
                                <Badge variant="outline" className="gap-1">
                                  <TriangleAlert className="size-3.5" />
                                  {selectedDay.warnings.length} אזהרות
                                </Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {[
                                formatDate(selectedDay.date),
                                selectedDay.cityRegion || null,
                                selectedDay.accommodation ? `לינה: ${selectedDay.accommodation}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "ללא תאריך"}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Badge variant="outline">{formatCurrency(selectedDay.estimatedCost)}</Badge>
                              <Badge variant="outline">{selectedDay.items.length} פעילויות</Badge>
                              {selectedDayCompletedCount > 0 ? (
                                <Badge variant="outline" className="gap-1">
                                  <CheckCircle2 className="size-3.5" />
                                  {selectedDayCompletedCount} בוצעו
                                </Badge>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void onRegenerate(draft.id, "day", selectedDay.id)}
                            disabled={isRegenerating || isSaving}
                          >
                            <RefreshCcw className="size-4" />
                            Regenerate day
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-border/60 px-4 py-5 sm:px-5">
                      <div className="space-y-5">
                        {selectedDayIntensity ? (
                          <div className="flex flex-wrap items-center gap-2 rounded-[18px] border border-border/60 bg-muted/20 p-3 text-xs">
                            <Badge variant="outline">{selectedDayIntensity.activityCount} פעילויות</Badge>
                            <Badge variant="outline" className="gap-1">
                              <Clock className="size-3.5" />
                              {formatHoursMinutes(selectedDayIntensity.activeMinutes)} ש&apos; פעילות
                            </Badge>
                            <Badge variant="outline" className="gap-1">
                              <Route className="size-3.5" />
                              {formatHoursMinutes(selectedDayIntensity.travelMinutes)} ש&apos; נסיעות
                            </Badge>
                            {selectedDayIntensity.freeMinutes > 0 ? (
                              <Badge variant="outline">
                                {formatHoursMinutes(selectedDayIntensity.freeMinutes)} ש&apos; זמן חופשי
                              </Badge>
                            ) : null}
                            <Badge variant="outline">{formatCurrency(selectedDay.estimatedCost)}</Badge>
                            <Badge variant="outline" className="gap-1">
                              <Footprints className="size-3.5" />
                              {selectedDayIntensity.walkingKm.toFixed(1)} ק&quot;מ הליכה
                            </Badge>
                            <Badge
                              variant={selectedDayIntensity.level === "עמוס" ? "secondary" : "outline"}
                              className="gap-1"
                            >
                              <Gauge className="size-3.5" />
                              עומס: {selectedDayIntensity.level}
                            </Badge>
                          </div>
                        ) : null}
                        {selectedDayRouteHealth.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            {selectedDayRouteHealth.map((indicator) => (
                              <Badge key={indicator.label} variant="outline" className="gap-1 border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="size-3" />
                                {indicator.label}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                        {selectedDayExplanation ? (
                          <p className="text-sm leading-6 text-muted-foreground">
                            <span className="font-medium text-foreground">למה היום מסודר כך: </span>
                            {selectedDayExplanation}
                          </p>
                        ) : null}
                        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                          <SummaryField
                            label="סיכום היום"
                            value={
                              selectedDay.notes ? (
                                <p className="leading-7 text-foreground/90">{selectedDay.notes}</p>
                              ) : (
                                <span className="text-muted-foreground">אין עדיין סיכום ליום הזה.</span>
                              )
                            }
                            className="xl:col-span-2"
                          />
                          <SummaryField
                            label="לינה"
                            value={
                              selectedDay.accommodation ? (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2">
                                    <BedDouble className="size-4 text-primary" />
                                    <span className="font-medium">{selectedDay.accommodation}</span>
                                  </div>
                                  {selectedDay.accommodationCost != null ? (
                                    <p className="text-xs text-muted-foreground">
                                      {formatCurrency(selectedDay.accommodationCost)} / לילה
                                    </p>
                                  ) : null}
                                  {selectedDay.accommodationMapLink ||
                                  (selectedDay.accommodationLat != null && selectedDay.accommodationLon != null) ? (
                                    <a
                                      href={
                                        selectedDay.accommodationMapLink ||
                                        buildMapLink(
                                          selectedDay.accommodation,
                                          selectedDay.accommodationLat,
                                          selectedDay.accommodationLon
                                        )
                                      }
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                    >
                                      <MapPin className="size-3.5" />
                                      פתח במפה
                                    </a>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">לא צוין בסיס לינה</span>
                              )
                            }
                          />
                          <SummaryField
                            label="זמן מעברים"
                            value={
                              <div className="flex items-center gap-2">
                                <Clock className="size-4 text-primary" />
                                <span>
                                  {selectedDay.totalTravelMinutes
                                    ? `${selectedDay.totalTravelMinutes} דק׳`
                                    : "לא חושב"}
                                </span>
                              </div>
                            }
                          />
                          <SummaryField
                            label="עלות פעילויות"
                            value={selectedDayActivityCost > 0 ? formatCurrency(selectedDayActivityCost) : "לא חושב"}
                          />
                          <SummaryField
                            label="ארוחות"
                            value={
                              selectedDayMealHighlights.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                  {selectedDayMealHighlights.slice(0, 4).map((meal) => (
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
                            <SectionTitle
                              title="עריכת היום"
                              description="שדות העריכה מוצגים רק בזמן edit mode."
                              action={
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    onPatchDay(selectedDay.id, (current) => ({
                                      ...current,
                                      items: [...HOTEL_CHANGE_DAY_TEMPLATE.map((template) => ({
                                        ...createEmptyItineraryItem(template.slot),
                                        ...template.fields,
                                      })), ...current.items],
                                    }))
                                  }
                                >
                                  <LuggageIcon className="size-4" />
                                  הוסף לוגיסטיקת מעבר מלונות
                                </Button>
                              }
                            />
                            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                              <div className="space-y-2">
                                <label className="text-xs font-medium text-muted-foreground">כותרת</label>
                                <Input
                                  value={selectedDay.title}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
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
                                  value={selectedDay.date}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
                                      ...current,
                                      date: event.target.value,
                                    }))
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-medium text-muted-foreground">עיר / אזור</label>
                                <Input
                                  value={selectedDay.cityRegion}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
                                      ...current,
                                      cityRegion: event.target.value,
                                    }))
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-medium text-muted-foreground">לינה</label>
                                <Input
                                  value={selectedDay.accommodation}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
                                      ...current,
                                      accommodation: event.target.value,
                                      accommodationLat: null,
                                      accommodationLon: null,
                                      accommodationMapLink: "",
                                    }))
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-medium text-muted-foreground">תחבורה עיקרית</label>
                                <Input
                                  value={selectedDay.transportation}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
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
                                  value={selectedDay.estimatedCost ?? ""}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
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
                                  value={selectedDay.totalTravelMinutes ?? ""}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
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
                                  value={selectedDay.restWindow}
                                  onChange={(event) =>
                                    onPatchDay(selectedDay.id, (current) => ({
                                      ...current,
                                      restWindow: event.target.value,
                                    }))
                                  }
                                />
                              </div>
                            </div>
                            <div className="mt-4 grid gap-3 lg:grid-cols-2">
                              <Textarea
                                value={selectedDay.notes}
                                onChange={(event) =>
                                  onPatchDay(selectedDay.id, (current) => ({
                                    ...current,
                                    notes: event.target.value,
                                  }))
                                }
                                rows={3}
                                placeholder="הערות יום"
                              />
                              <Textarea
                                value={selectedDay.transportSegments.join("\n")}
                                onChange={(event) =>
                                  onPatchDay(selectedDay.id, (current) => ({
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
                                value={selectedDay.warnings.join("\n")}
                                onChange={(event) =>
                                  onPatchDay(selectedDay.id, (current) => ({
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
                                value={selectedDay.alternatives.join("\n")}
                                onChange={(event) =>
                                  onPatchDay(selectedDay.id, (current) => ({
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
                                    onPatchDay(selectedDay.id, (current) => ({
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
                            {selectedDay.items.map((item, itemIndex) => {
                              const showEditor = isEditMode && editingItemId === item.id;
                              const badges = activityStateBadges(item);
                              const isMapActive = (activeMapItemIdsByDay[selectedDay.id] ?? []).includes(item.id);
                              const ConnectorIcon = transportModeIcon(item.transportation);
                              const bookingStatus = bookingStatusForItem(item, tripBookings);

                              return (
                                <div key={item.id} className="space-y-3">
                                  {itemIndex > 0 && (item.transportation || item.travelMinutes) ? (
                                    <button
                                      type="button"
                                      onClick={() => setTimelineFocusItemId(item.id)}
                                      className="flex w-full items-center gap-2 rounded-[18px] border border-dashed border-border/60 bg-background/55 px-4 py-2 text-right text-xs text-muted-foreground transition-colors hover:bg-muted/40"
                                    >
                                      <ConnectorIcon className="size-3.5 shrink-0" />
                                      <span>{item.transportation || "מעבר מקומי"}</span>
                                      {item.travelMinutes ? <span>· {item.travelMinutes} דק׳</span> : null}
                                    </button>
                                  ) : null}

                                  <div
                                    ref={(element) => {
                                      itemCardRefs.current[item.id] = element;
                                    }}
                                    onClick={() => {
                                      if (!showEditor) setTimelineFocusItemId(item.id);
                                    }}
                                    className={cn(
                                      "rounded-[24px] border bg-background/70 p-4",
                                      !showEditor ? "cursor-pointer" : "",
                                      isMapActive || timelineFocusItemId === item.id
                                        ? "border-primary/40 ring-1 ring-primary/20"
                                        : "border-border/60"
                                    )}
                                  >
                                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
                                      <div className="flex items-start gap-3 xl:w-[170px] xl:shrink-0">
                                        <div className="flex h-11 w-11 items-center justify-center rounded-[18px] border border-border/60 bg-muted/25 text-sm font-semibold text-foreground">
                                          {item.plannedStartTime || "—"}
                                        </div>
                                        <div className="min-w-0">
                                          <p className="text-xs text-muted-foreground">
                                            {DAY_PART_LABELS[item.slot]}
                                          </p>
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
                                            {bookingStatus ? (
                                              <button
                                                type="button"
                                                onClick={(event) => {
                                                  event.stopPropagation();
                                                  if (!bookingStatus.bookingId) {
                                                    upsertBooking(
                                                      onPatchDraft,
                                                      createBookingLinkedToItem(draft.id, selectedDay.id, item)
                                                    );
                                                  }
                                                  setBookingFocusItemId(item.id);
                                                  setActiveSection("bookings");
                                                }}
                                                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted/50"
                                              >
                                                <span>{bookingStatus.glyph}</span>
                                                {bookingStatus.label}
                                              </button>
                                            ) : null}
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
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      name: event.target.value,
                                                      lat: null,
                                                      lon: null,
                                                      mapLink: "",
                                                    }))
                                                  }
                                                  placeholder="שם פעילות"
                                                />
                                                <Input
                                                  value={item.location}
                                                  onChange={(event) =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      location: event.target.value,
                                                      lat: null,
                                                      lon: null,
                                                      mapLink: "",
                                                    }))
                                                  }
                                                  placeholder="מיקום"
                                                />
                                                <Textarea
                                                  value={item.shortDescription}
                                                  onChange={(event) =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
                                                    ...current,
                                                    plannedStartTime: event.target.value,
                                                  }))
                                                }
                                              />
                                              <Input
                                                type="number"
                                                value={item.estimatedDurationMinutes ?? ""}
                                                onChange={(event) =>
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
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
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
                                                    ...current,
                                                    openingHours: event.target.value,
                                                  }))
                                                }
                                                placeholder="שעות פתיחה"
                                              />
                                              <Input
                                                value={item.alternativeSuggestion}
                                                onChange={(event) =>
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
                                                    ...current,
                                                    alternativeSuggestion: event.target.value,
                                                  }))
                                                }
                                                placeholder="חלופה מוצעת"
                                              />
                                            </div>

                                            <div className="flex flex-wrap items-center gap-2">
                                              <Select
                                                value={item.priority}
                                                onValueChange={(value) =>
                                                  onPatchItem(selectedDay.id, item.id, (current) => ({
                                                    ...current,
                                                    priority: value as ItemPriority,
                                                    optional: value === "optional",
                                                  }))
                                                }
                                              >
                                                <SelectTrigger size="sm" className="min-w-32">
                                                  <span>{ITEM_PRIORITY_LABELS[item.priority]}</span>
                                                </SelectTrigger>
                                                <SelectContent>
                                                  {Object.entries(ITEM_PRIORITY_LABELS).map(([value, label]) => (
                                                    <SelectItem key={value} value={value}>
                                                      {label}
                                                    </SelectItem>
                                                  ))}
                                                </SelectContent>
                                              </Select>
                                            </div>

                                            <div className="flex flex-wrap gap-2">
                                              {[
                                                {
                                                  label: "שעה קבועה",
                                                  active: item.fixedTime,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      fixedTime: !current.fixedTime,
                                                    })),
                                                },
                                                {
                                                  label: "הזמנה בוצעה",
                                                  active: item.bookingCompleted,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      bookingCompleted: !current.bookingCompleted,
                                                    })),
                                                },
                                                {
                                                  label: item.locked ? "נעול 🔒" : "פתוח 🔓",
                                                  active: item.locked,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      locked: !current.locked,
                                                    })),
                                                },
                                                {
                                                  label: "בוצע",
                                                  active: item.completed,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      completed: !current.completed,
                                                      skipped: current.completed ? current.skipped : false,
                                                    })),
                                                },
                                                {
                                                  label: "דולג",
                                                  active: item.skipped,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      skipped: !current.skipped,
                                                      completed: current.skipped ? current.completed : false,
                                                    })),
                                                },
                                                {
                                                  label: item.favorite ? "מועדף ❤️" : "הוסף למועדפים",
                                                  active: item.favorite,
                                                  onToggle: () =>
                                                    onPatchItem(selectedDay.id, item.id, (current) => ({
                                                      ...current,
                                                      favorite: !current.favorite,
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
                                                onPatchItem(selectedDay.id, item.id, (current) => ({
                                                  ...current,
                                                  ...patch,
                                                }))
                                              }
                                            />

                                            <div className="flex flex-wrap items-center gap-2">
                                              <Select
                                                value={selectedDay.id}
                                                onValueChange={(value) =>
                                                  onPatchDraft((current) => {
                                                    if (value === selectedDay.id) return current;
                                                    const movingItem = selectedDay.items.find(
                                                      (entry) => entry.id === item.id
                                                    );
                                                    if (!movingItem) return current;
                                                    return {
                                                      ...current,
                                                      itineraryDays: current.itineraryDays.map((entry) => {
                                                        if (entry.id === selectedDay.id) {
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
                                                  onPatchDay(selectedDay.id, (current) => {
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
                                                  onPatchDay(selectedDay.id, (current) => {
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
                                                  onPatchDay(selectedDay.id, (current) => ({
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
                                                onClick={() =>
                                                  void onRegenerate(draft.id, "activity", selectedDay.id, item.id)
                                                }
                                                disabled={isRegenerating || isSaving}
                                              >
                                                Regenerate activity
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() =>
                                                  onPatchDay(selectedDay.id, (current) => ({
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

                        <ItineraryDayRouteSection
                          day={selectedDay}
                          countryName={country.name}
                          isoA2={draft.isoA2}
                          onPatchDay={onPatchDay}
                          onPatchItem={onPatchItem}
                          focusItemId={timelineFocusItemId}
                          onActiveItemIdsChange={(itemIds) =>
                            setActiveMapItemIdsByDay((current) => ({
                              ...current,
                              [selectedDay.id]: itemIds,
                            }))
                          }
                        />

                        <div className="grid gap-4 lg:grid-cols-2">
                          <SummaryField
                            label="מקטעי תחבורה"
                            value={
                              selectedDay.transportSegments.length > 0 ? (
                                <div className="space-y-2">
                                  {selectedDay.transportSegments.map((segment, index) => (
                                    <div
                                      key={`${selectedDay.id}-segment-${index}`}
                                      className="flex items-center gap-2 text-sm"
                                    >
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
                              selectedDay.bookingRequirements.length > 0 ? (
                                <ul className="space-y-2 text-sm leading-6">
                                  {selectedDay.bookingRequirements.map((requirement, index) => (
                                    <li key={`${selectedDay.id}-booking-${index}`}>{requirement}</li>
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
                              selectedDay.safetyNotes.length > 0 ? (
                                <ul className="space-y-2 text-sm leading-6">
                                  {selectedDay.safetyNotes.map((note, index) => (
                                    <li key={`${selectedDay.id}-safety-${index}`}>{note}</li>
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
                              selectedDay.alternatives.length > 0 ? (
                                <ul className="space-y-2 text-sm leading-6">
                                  {selectedDay.alternatives.map((alternative, index) => (
                                    <li key={`${selectedDay.id}-alt-${index}`}>{alternative}</li>
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
                                  ...selectedDay,
                                  id: createId("day"),
                                  dayNumber: draft.itineraryDays.length + 1,
                                  title: `${selectedDay.title || `Day ${selectedDay.dayNumber}`} (copy)`,
                                  items: selectedDay.items.map((item) => ({
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
                                const replacementDay = createEmptyDay(1);
                                const nextDays = draft.itineraryDays
                                  .filter((entry) => entry.id !== selectedDay.id)
                                  .map((entry, index) => ({ ...entry, dayNumber: index + 1 }));
                                onPatchDraft((current) => ({
                                  ...current,
                                  daysCount: nextDays.length,
                                  itineraryDays: nextDays.length > 0 ? nextDays : [replacementDay],
                                }));
                                setEditingItemId(null);
                                const fallbackDayId = nextDays[0]?.id ?? replacementDay.id;
                                setSelectedTab(
                                  fallbackDayId ? tabValueForDay(fallbackDayId) : SUMMARY_TAB_VALUE
                                );
                              }}
                            >
                              <Trash2 className="size-4" />
                              מחיקת יום
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </article>
                </div>
              ) : null}
            </div>
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
