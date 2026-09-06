"use client";

import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Sparkles,
  Utensils,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ActivityDetailsModal } from "@/components/trips/activity-modal";
import { ItineraryDayRouteSection } from "@/components/country/itinerary-route-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency, formatDate } from "@/lib/format";
import { useGeoResolutionDebugMap } from "@/lib/hooks/use-geo-resolution-debug";
import {
  computeDayGeographyDebugRow,
  computeDaySummary,
  computeGeoResolutionMatchSummary,
  deriveDayTypeLabel,
  formatMinutes,
  getAdjacentDayId,
  isRealPlaceItem,
  shouldShowTravelConnector,
  type GeoResolutionOverrideMap,
} from "@/lib/itinerary-day-view-helpers";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import {
  DAY_PART_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  isMealOpportunityMarker,
  type DayPart,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

/** Spec B3 — a clear day header with a compact chip row, replacing the old title that competed visually with the navigation. */
function ItineraryDayHeader({
  day,
  isRegenerating,
  onImproveDay,
}: {
  day: TripItineraryDay;
  isRegenerating: boolean;
  onImproveDay: () => void;
}) {
  const dayTypeLabel = deriveDayTypeLabel(day);
  const summary = computeDaySummary(day);
  const chips: Array<{ icon: string; label: string }> = [];
  if (day.accommodation) chips.push({ icon: "🏨", label: day.accommodation });
  if (summary.totalTravelMinutes > 0) chips.push({ icon: "🚗", label: `${summary.totalTravelMinutes} דק׳ נסיעות` });
  if (summary.placeCount > 0) chips.push({ icon: "📍", label: `${summary.placeCount} מקומות` });
  if (summary.foodWindowCount > 0) chips.push({ icon: "🍽", label: `${summary.foodWindowCount}` });

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="font-heading text-xl font-semibold text-foreground">יום {day.dayNumber}</h3>
          {day.date ? <span className="text-sm text-muted-foreground">{formatDate(day.date, "d בMMMM")}</span> : null}
          {day.cityRegion ? (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="size-3.5" />
              {day.cityRegion}
            </span>
          ) : null}
        </div>
        {dayTypeLabel ? <p className="mt-0.5 text-xs font-medium text-primary">{dayTypeLabel}</p> : null}
        {chips.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-foreground"
              >
                <span aria-hidden="true">{chip.icon}</span>
                {chip.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={isRegenerating} />}>
          <Sparkles className="size-4" />
          פעולות AI
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onImproveDay}>שפר את היום</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Spec B4/B5 — a compact horizontal day rail on desktop, a prev/current/next + dropdown control on mobile. Never 10+ equally-heavy full-width boxes. */
function ItineraryDayRail({
  days,
  selectedDay,
  onSelectDay,
}: {
  days: TripItineraryDay[];
  selectedDay: TripItineraryDay;
  onSelectDay: (dayId: string) => void;
}) {
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const selectedIndex = days.findIndex((day) => day.id === selectedDay.id);

  // scrollIntoView (not a manual scrollBy/scrollLeft delta) so the rail
  // stays correct regardless of the browser's own RTL scroll-direction
  // convention (spec B19 — notoriously inconsistent to hand-compute).
  useEffect(() => {
    selectedButtonRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedDay.id]);

  return (
    <>
      {/* Desktop/tablet: compact scrollable rail (spec B4). */}
      <div className="hidden items-center gap-1 sm:flex" role="tablist" aria-label="ימי המסלול">
        <button
          type="button"
          disabled={selectedIndex <= 0}
          onClick={() => {
            const previousId = getAdjacentDayId(days, selectedDay.id, -1);
            if (previousId) onSelectDay(previousId);
          }}
          className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="היום הקודם"
        >
          <ChevronRight className="size-4" />
        </button>
        <div className="flex gap-1.5 overflow-x-auto scroll-smooth">
          {days.map((day) => {
            const isSelected = day.id === selectedDay.id;
            return (
              <button
                key={day.id}
                ref={isSelected ? selectedButtonRef : undefined}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => onSelectDay(day.id)}
                className={cn(
                  "flex shrink-0 flex-col items-center gap-0.5 rounded-xl border px-3 py-1.5 text-center text-xs transition-colors",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card text-foreground hover:bg-muted"
                )}
              >
                <span className="font-semibold">יום {day.dayNumber}</span>
                <span className={cn("text-[10px]", isSelected ? "opacity-90" : "text-muted-foreground")}>
                  {day.date ? formatDate(day.date, "d/M") : ""}
                  {day.cityRegion ? ` · ${day.cityRegion}` : ""}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={selectedIndex === -1 || selectedIndex >= days.length - 1}
          onClick={() => {
            const nextId = getAdjacentDayId(days, selectedDay.id, 1);
            if (nextId) onSelectDay(nextId);
          }}
          className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="היום הבא"
        >
          <ChevronLeft className="size-4" />
        </button>
      </div>

      {/* Mobile: prev/next + a compact day dropdown (spec B5) — never all cards at once. */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button
          variant="outline"
          size="sm"
          disabled={selectedIndex <= 0}
          onClick={() => {
            const previousId = getAdjacentDayId(days, selectedDay.id, -1);
            if (previousId) onSelectDay(previousId);
          }}
          aria-label="היום הקודם"
        >
          <ChevronRight className="size-4" />
        </Button>
        <label className="sr-only" htmlFor="itinerary-day-select">
          בחירת יום
        </label>
        <select
          id="itinerary-day-select"
          value={selectedDay.id}
          onChange={(event) => onSelectDay(event.target.value)}
          className="flex-1 rounded-xl border border-border/60 bg-card px-3 py-2 text-sm text-foreground"
        >
          {days.map((day) => (
            <option key={day.id} value={day.id}>
              יום {day.dayNumber} מתוך {days.length} · {day.date ? formatDate(day.date, "d בMMM") : ""}
              {day.cityRegion ? ` · ${day.cityRegion}` : ""}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedIndex === -1 || selectedIndex >= days.length - 1}
          onClick={() => {
            const nextId = getAdjacentDayId(days, selectedDay.id, 1);
            if (nextId) onSelectDay(nextId);
          }}
          aria-label="היום הבא"
        >
          <ChevronLeft className="size-4" />
        </Button>
      </div>
    </>
  );
}

/** Spec B9 — a compact route connector between timeline nodes, never competing visually with the activity cards around it. */
function TimelineTravelConnector({ item }: { item: TripItineraryItem }) {
  if (!shouldShowTravelConnector(item)) return null;
  return (
    <div className="flex items-center gap-2 py-1 pr-[1.15rem] text-xs text-muted-foreground">
      <span aria-hidden="true" className="w-px flex-1 self-stretch border-r border-dashed border-border/60" />
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true">🚶</span>
        {item.travelMinutes ? `${formatMinutes(item.travelMinutes)}` : item.transportation || "הליכה"}
      </span>
    </div>
  );
}

/** Spec B6/B7/B8/B25 — a compact timeline node + activity card: a time node on the vertical line, name as the primary line, everything else secondary. */
function TimelineActivityCard({
  item,
  onOpenDetails,
}: {
  item: TripItineraryItem;
  onOpenDetails: (itemId: string) => void;
}) {
  const bookingLabel = item.reservationRequired ? (item.bookingCompleted ? "הוזמן" : "דרושה הזמנה") : null;
  const timeLabel = item.plannedStartTime
    ? item.endTime
      ? `${item.plannedStartTime}–${item.endTime}`
      : item.plannedStartTime
    : DAY_PART_LABELS[item.slot];

  return (
    <div className="relative flex gap-3 pr-1">
      <div className="flex w-14 shrink-0 flex-col items-center pt-1">
        <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
        <span className="mt-1 text-[11px] tabular-nums text-muted-foreground">{item.plannedStartTime || ""}</span>
      </div>
      <button
        type="button"
        onClick={() => onOpenDetails(item.id)}
        className="section-card group min-w-0 flex-1 space-y-1 border border-transparent p-3 text-right transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="truncate text-sm font-semibold text-foreground">{item.name}</h4>
          <ArrowLeft className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {item.location || RECOMMENDATION_CATEGORY_LABELS[item.category]}
          {item.location ? ` · ${RECOMMENDATION_CATEGORY_LABELS[item.category]}` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{timeLabel}</span>
          {item.estimatedDurationMinutes ? <span>{formatMinutes(item.estimatedDurationMinutes)}</span> : null}
          <span>{item.approximatePrice ? formatCurrency(item.approximatePrice) : "חינם"}</span>
          {bookingLabel ? (
            <Badge variant={item.bookingCompleted ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
              {bookingLabel}
            </Badge>
          ) : null}
        </div>
      </button>
    </div>
  );
}

/**
 * A meal opportunity (spec B11) — a recommended meal time window, styled
 * as a lightweight dashed timeline row rather than a real activity card.
 * Clicking it opens the Food tab focused on this exact day/slot.
 */
function MealOpportunityRow({ item, onOpenFoodTab }: { item: TripItineraryItem; onOpenFoodTab: () => void }) {
  return (
    <div className="relative flex gap-3 pr-1">
      <div className="flex w-14 shrink-0 flex-col items-center pt-1">
        <Utensils className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="mt-1 text-[11px] tabular-nums text-muted-foreground">{item.plannedStartTime || ""}</span>
      </div>
      <button
        type="button"
        onClick={onOpenFoodTab}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-dashed border-border/60 bg-transparent px-3 py-2.5 text-right text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs">{item.name}</p>
          <p className="text-[11px]">הצג המלצות אוכל</p>
        </div>
        <ArrowLeft className="size-3.5 shrink-0" />
      </button>
    </div>
  );
}

/** Spec B13 — a compact day-health summary, meaningful signals only, never generic warning spam. */
function DaySummaryStats({ day }: { day: TripItineraryDay }) {
  const summary = computeDaySummary(day);
  const activeMinutes = day.items.filter(isRealPlaceItem).reduce((sum, item) => sum + (item.estimatedDurationMinutes ?? 0), 0);
  const relevantWarnings = day.warnings.slice(0, 3);

  return (
    <div className="rounded-[18px] border border-border/60 bg-background/70 p-3.5">
      <p className="text-sm font-semibold text-foreground">מסלול היום</p>
      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {relevantWarnings.length === 0 ? (
          <p className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">✓ אין התראות פעילות ליום הזה</p>
        ) : (
          <div>
            <p className="mb-1 font-medium text-foreground">התראות</p>
            {relevantWarnings.map((warning, index) => (
              <p key={index} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                {warning}
              </p>
            ))}
          </div>
        )}
        <p>{summary.totalTravelMinutes > 0 ? `${summary.totalTravelMinutes} דק׳ נסיעה כוללת` : "אין נסיעות רשומות היום"}</p>
        {activeMinutes > 0 ? <p>{formatMinutes(activeMinutes)} פעילות</p> : null}
      </div>
    </div>
  );
}

/**
 * Spec "אני רואה את זה בשנייה במקום להסיק לאורך 44 ימים" — one line,
 * shown once for the whole trip (not per day), so a long trip's overall
 * match rate is visible immediately instead of implied by scrolling
 * through every day's own unresolved count. Renders nothing when there's
 * no override file at all (computeGeoResolutionMatchSummary returns null
 * — genuinely nothing to report, not a 0/0 that would misleadingly read
 * as "totally unresolved").
 */
function GeoResolutionMatchBanner({
  days,
  geoResolutionOverride,
}: {
  days: TripItineraryDay[];
  geoResolutionOverride: GeoResolutionOverrideMap | null;
}) {
  const summary = useMemo(
    () => computeGeoResolutionMatchSummary(days, geoResolutionOverride),
    [days, geoResolutionOverride]
  );
  if (!summary) return null;

  return (
    <div className="rounded-[14px] border border-dashed border-amber-500/60 bg-amber-500/5 px-3.5 py-2 font-mono text-xs" dir="ltr">
      🔧 geo-resolution: {summary.matched}/{summary.total} items matched
    </div>
  );
}

/**
 * Mechanical geography QA overlay (?debugGeo=1) — never a production
 * default, off by default in every other case. See
 * computeDayGeographyDebugRow's own module-level note in
 * itinerary-day-view-helpers.ts for exactly why this is a DEGRADED
 * version of the generation-time diagnostic on its own (geoSource without
 * an override is only ever provider/unresolved — never
 * recommendationId/fuzzyName — and derivedDayType is a JIT approximation,
 * not the real deriveDayType). `geoResolutionOverride`, when a real
 * CAPTURE_FIXTURES=1 run left a geo-resolution.json behind for this
 * country, restores the full 4-value taxonomy for whichever items it has
 * an entry for.
 */
function GeographyDebugPanel({
  day,
  previousDay,
  isFirstDay,
  isLastDay,
  geoResolutionOverride,
}: {
  day: TripItineraryDay;
  previousDay: TripItineraryDay | null;
  isFirstDay: boolean;
  isLastDay: boolean;
  geoResolutionOverride: GeoResolutionOverrideMap | null;
}) {
  const row = useMemo(
    () => computeDayGeographyDebugRow(day, previousDay, isFirstDay, isLastDay, "balanced", geoResolutionOverride),
    [day, previousDay, isFirstDay, isLastDay, geoResolutionOverride]
  );

  return (
    <div className="rounded-[18px] border border-dashed border-amber-500/60 bg-amber-500/5 p-3.5 font-mono text-[11px] leading-relaxed" dir="ltr">
      <p className="mb-1.5 font-sans text-xs font-semibold text-amber-700 dark:text-amber-400">
        🔧 QA_DEBUG_GEOGRAPHY — day {row.dayNumber} ({row.ownerStay || "—"})
      </p>
      <p>
        derivedDayType=<b>{row.derivedDayType}</b> textualDayType=<b>{row.textualDayType}</b>{" "}
        {row.dayTypeMismatch ? <span className="font-bold text-red-600 dark:text-red-400">dayTypeMismatch=TRUE</span> : "dayTypeMismatch=false"}
      </p>
      <p>
        totalLegMinutes={row.totalLegMinutes} maxLegMinutes={row.maxLegMinutes} unresolvedItemCount={row.unresolvedItemCount}
      </p>
      <table className="mt-1.5 w-full border-collapse text-left">
        <thead>
          <tr className="text-amber-700/80 dark:text-amber-400/80">
            <th className="pe-2 font-normal">item</th>
            <th className="pe-2 font-normal">category</th>
            <th className="pe-2 font-normal">geoSource</th>
            <th className="pe-2 font-normal">precision</th>
            <th className="pe-2 font-normal">legMinutes</th>
          </tr>
        </thead>
        <tbody>
          {row.items.map((it) => (
            <tr
              key={it.itemId}
              className={
                it.geoSource === "unresolved"
                  ? "text-red-600 dark:text-red-400"
                  : it.geoSource === "unmatched"
                    ? "font-bold text-orange-600 dark:text-orange-400"
                    : undefined
              }
            >
              <td className="pe-2">{it.itemName}</td>
              <td className="pe-2">{it.category}</td>
              <td className="pe-2">{it.geoSource}</td>
              <td className="pe-2">{it.precision}</td>
              <td className="pe-2">{it.legMinutes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TripItineraryTabProps {
  itinerary: CountryItineraryRecord;
  countryName: string;
  selectedDayId: string;
  onSelectDay: (dayId: string) => void;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
  onRemoveItem: (dayId: string, itemId: string) => void;
  onMoveItemToDay: (fromDayId: string, toDayId: string, itemId: string) => void;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  onRegenerateDay: (dayId: string) => void;
  isRegenerating: boolean;
  /** Opens the Food tab focused on a specific day/meal slot (spec "FOOD TAB FILTERING") — optional so this tab keeps working even where the food feature isn't wired in. */
  onOpenFoodOpportunity?: (dayId: string, slot: DayPart) => void;
}

export function TripItineraryTab({
  itinerary,
  countryName,
  selectedDayId,
  onSelectDay,
  onPatchDay,
  onPatchItem,
  onRemoveItem,
  onMoveItemToDay,
  onPatchDraft,
  onRegenerateDay,
  isRegenerating,
  onOpenFoodOpportunity,
}: TripItineraryTabProps) {
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const debugGeoEnabled = searchParams?.get("debugGeo") === "1";
  const { data: geoResolutionOverride } = useGeoResolutionDebugMap(itinerary.isoA2, debugGeoEnabled);
  const days = itinerary.itineraryDays;
  const selectedDay = days.find((day) => day.id === selectedDayId) ?? days[0] ?? null;
  const selectedDayIndex = selectedDay ? days.findIndex((day) => day.id === selectedDay.id) : -1;

  const sortedItems = useMemo(() => {
    if (!selectedDay) return [];
    return [...selectedDay.items].sort((a, b) => a.plannedStartTime.localeCompare(b.plannedStartTime));
  }, [selectedDay]);

  // Re-derived from `days` on every render (not cached in state) so it
  // always reflects the latest edit/move/remove immediately, and so
  // "העבר ליום אחר" naturally keeps the modal in sync if it stays open.
  const selectedItemContext = useMemo(() => {
    if (!selectedItemId) return null;
    for (const day of days) {
      const sorted = [...day.items].sort((a, b) => a.plannedStartTime.localeCompare(b.plannedStartTime));
      const index = sorted.findIndex((candidate) => candidate.id === selectedItemId);
      if (index !== -1) {
        return { day, item: sorted[index], previousItem: index > 0 ? sorted[index - 1] : null };
      }
    }
    return null;
  }, [days, selectedItemId]);

  if (!selectedDay) {
    return <p className="section-card p-4 text-sm text-muted-foreground">עדיין אין ימים במסלול הזה.</p>;
  }

  return (
    <div className="space-y-4">
      {debugGeoEnabled ? <GeoResolutionMatchBanner days={days} geoResolutionOverride={geoResolutionOverride ?? null} /> : null}
      <ItineraryDayRail days={days} selectedDay={selectedDay} onSelectDay={onSelectDay} />

      <div className="section-card space-y-4 p-4">
        <ItineraryDayHeader
          day={selectedDay}
          isRegenerating={isRegenerating}
          onImproveDay={() => onRegenerateDay(selectedDay.id)}
        />
      </div>

      {/* Spec B1: main content (~65-70%) + sticky side panel (~30-35%) on desktop; timeline first, map above/collapsible on tablet; single column on mobile (spec B20/B21). */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,66%)_minmax(0,34%)]">
        <div className="order-2 space-y-0.5 lg:order-1">
          {sortedItems.length === 0 ? (
            <p className="section-card p-4 text-sm text-muted-foreground">אין עדיין פעילויות מתוכננות ליום הזה.</p>
          ) : (
            sortedItems.map((item, index) => (
              <div key={item.id}>
                {index > 0 ? <TimelineTravelConnector item={item} /> : null}
                {isMealOpportunityMarker(item) ? (
                  <MealOpportunityRow item={item} onOpenFoodTab={() => onOpenFoodOpportunity?.(selectedDay.id, item.slot)} />
                ) : (
                  <TimelineActivityCard item={item} onOpenDetails={setSelectedItemId} />
                )}
              </div>
            ))
          )}
        </div>

        <div className="order-1 space-y-3 lg:order-2 lg:sticky lg:top-[64px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto">
          <ItineraryDayRouteSection
            day={selectedDay}
            countryName={countryName}
            isoA2={itinerary.isoA2}
            onPatchDay={onPatchDay}
            onPatchItem={onPatchItem}
            onActiveItemIdsChange={() => {}}
            focusItemId={focusItemId}
            compact
          />
          <DaySummaryStats day={selectedDay} />
          {debugGeoEnabled ? (
            <GeographyDebugPanel
              day={selectedDay}
              previousDay={selectedDayIndex > 0 ? days[selectedDayIndex - 1] : null}
              isFirstDay={selectedDayIndex === 0}
              isLastDay={selectedDayIndex === days.length - 1}
              geoResolutionOverride={geoResolutionOverride ?? null}
            />
          ) : null}
        </div>
      </div>

      <ActivityDetailsModal
        open={selectedItemId != null}
        onOpenChange={(open) => {
          if (!open) setSelectedItemId(null);
        }}
        item={selectedItemContext?.item ?? null}
        day={selectedItemContext?.day ?? null}
        days={days}
        previousItem={selectedItemContext?.previousItem ?? null}
        countryName={countryName}
        itineraryId={itinerary.id}
        preferences={itinerary.preferencesSnapshot}
        memories={itinerary.workspaceSnapshot?.memories ?? []}
        onPatchItem={onPatchItem}
        onRemoveItem={onRemoveItem}
        onMoveItemToDay={onMoveItemToDay}
        onPatchDraft={onPatchDraft}
        onShowOnDailyMap={setFocusItemId}
      />
    </div>
  );
}
