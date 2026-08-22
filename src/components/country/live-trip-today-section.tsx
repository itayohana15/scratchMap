"use client";

import {
  CheckCircle2,
  Circle,
  Clock,
  LoaderCircle,
  Navigation2,
  Plus,
  Sparkles,
  Ticket,
  Wallet,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LiveDelaySheet, type DelayAction } from "@/components/country/live-delay-sheet";
import { ItineraryDayRouteSection } from "@/components/country/itinerary-route-map";
import { formatCurrency } from "@/lib/format";
import { useDeviceLocation } from "@/lib/hooks/use-device-location";
import type { CountryItineraryRecord } from "@/lib/itineraries";
import { bookings, createBookingLinkedToItem, upsertBooking } from "@/lib/trip-bookings";
import { useOpenTripDocument } from "@/lib/queries/trip-documents";
import { documents } from "@/lib/trip-documents";
import {
  appendLiveEvent,
} from "@/lib/live-trip-events";
import {
  computeBufferMinutes,
  computeLeaveBy,
  computeNextActivity,
  effectiveStartTime,
  parseTimeToMinutes,
  shiftRemainingDay,
} from "@/lib/live-trip-planner";
import { getDestinationDateString, getDestinationTimeString, getTripDayForNow } from "@/lib/live-trip-time";
import { createQuickExpense, todaySpend, upsertActualExpense } from "@/lib/trip-expenses";
import { activityStateBadges, bookingStatusForItem, transportModeIcon } from "@/lib/trip-item-status";
import { useCountryWeather, WEATHER_CODE_LABELS, weatherIconKey } from "@/lib/weather/country-weather";
import {
  buildDirectionsLink,
  createEmptyItineraryItem,
  haversineKm,
  markItemCompleted,
  markItemSkipped,
  RECOMMENDATION_CATEGORY_LABELS,
  type ExpenseCategory,
  type RecommendationCategory,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { cn } from "@/lib/utils";

interface LiveTripTodaySectionProps {
  draft: CountryItineraryRecord;
  countryName: string;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
  onPatchItem: (dayId: string, itemId: string, updater: (item: TripItineraryItem) => TripItineraryItem) => void;
  onRegenerate: (
    itineraryId: string,
    scope: "live_replan" | "live_replace_item",
    targetDayId?: string | null,
    targetItemId?: string | null,
    optimizeMode?: null,
    liveInstruction?: string | null
  ) => Promise<void> | void;
  isRegenerating: boolean;
}

const SKIP_REASONS = ["אין זמן", "עייף/ה", "סגור", "מזג אוויר", "שינוי תוכניות", "לא מעניין", "אחר"];

function itemStatusGlyph(item: TripItineraryItem, isNext: boolean, nowMinutes: number) {
  if (item.completed) return { Icon: CheckCircle2, label: "בוצע", delayed: false };
  if (item.skipped) return { Icon: X, label: "דולג", delayed: false };
  const effectiveMinutes = parseTimeToMinutes(effectiveStartTime(item));
  const isDelayed = effectiveMinutes != null && effectiveMinutes < nowMinutes;
  if (isNext) return { Icon: Circle, label: isDelayed ? "מאחר" : "הבא בתור", delayed: isDelayed };
  return { Icon: Circle, label: isDelayed ? "מאחר" : "בהמשך", delayed: isDelayed };
}

export function LiveTripTodaySection({
  draft,
  countryName,
  onPatchDraft,
  onPatchDay,
  onPatchItem,
  onRegenerate,
  isRegenerating,
}: LiveTripTodaySectionProps) {
  const isoA2 = draft.isoA2;
  const today = useMemo(
    () => getTripDayForNow(draft.itineraryDays, draft.startDate, isoA2),
    [draft.itineraryDays, draft.startDate, isoA2]
  );
  const todayDateString = getDestinationDateString(isoA2);
  const nowTimeString = getDestinationTimeString(isoA2);
  const nowMinutes = parseTimeToMinutes(nowTimeString) ?? 0;

  const [delaySheetOpen, setDelaySheetOpen] = useState(false);
  const [expandedCompletionId, setExpandedCompletionId] = useState<string | null>(null);
  const [skipTargetId, setSkipTargetId] = useState<string | null>(null);
  const [replanOpen, setReplanOpen] = useState(false);
  const [replanText, setReplanText] = useState("");
  const [openingTicketId, setOpeningTicketId] = useState<string | null>(null);
  const [dayEndOpen, setDayEndOpen] = useState(false);
  const [favoriteMoment, setFavoriteMoment] = useState(today?.favoriteMoment ?? "");
  const [dayEndNote, setDayEndNote] = useState(today?.dayEndNote ?? "");
  const [dayEndRating, setDayEndRating] = useState<number | null>(today?.dayRating ?? null);
  const [spendConfirmed, setSpendConfirmed] = useState(false);

  const openDocument = useOpenTripDocument();
  const { location } = useDeviceLocation(true);

  // Weather (spec §18) — reuses the existing country-weather hook as-is,
  // anchored to accommodation coords when known, else the first item with
  // coordinates. Must stay above the early return below (Rules of Hooks).
  const firstCoordItem = today?.items.find((item) => item.lat != null && item.lon != null);
  const weatherLat = today?.accommodationLat ?? firstCoordItem?.lat ?? undefined;
  const weatherLon = today?.accommodationLon ?? firstCoordItem?.lon ?? undefined;
  const { data: weather } = useCountryWeather(weatherLat ?? undefined, weatherLon ?? undefined);

  if (!today) {
    return (
      <div className="section-card flex flex-col items-center gap-2 p-8 text-center">
        <Clock className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">לא נמצא יום מסלול שתואם להיום.</p>
      </div>
    );
  }

  const dayIndex = draft.itineraryDays.findIndex((day) => day.id === today.id);
  const dayNumber = dayIndex >= 0 ? dayIndex + 1 : today.dayNumber;
  const tripBookings = bookings(draft);
  const tripDocuments = documents(draft);

  const nextActivity = computeNextActivity(today, nowMinutes);
  const previousCompleted = [...today.items].reverse().find((item) => item.completed);
  const originLat = previousCompleted?.lat ?? today.accommodationLat ?? null;
  const originLon = previousCompleted?.lon ?? today.accommodationLon ?? null;
  const distanceKm = nextActivity ? haversineKm(originLat, originLon, nextActivity.lat, nextActivity.lon) : 0;
  const travelMinutes = nextActivity?.travelMinutes ?? 0;
  const leaveBy = nextActivity ? computeLeaveBy(nextActivity, travelMinutes, nowMinutes) : null;
  const nextBookingStatus = nextActivity ? bookingStatusForItem(nextActivity, tripBookings) : null;
  const nextLinkedBooking = nextActivity
    ? tripBookings.find((booking) => booking.itineraryItemId === nextActivity.id && booking.status !== "cancelled")
    : null;
  const nextLinkedDocument = nextLinkedBooking
    ? tripDocuments.find((document) => document.bookingId === nextLinkedBooking.id) ??
      tripDocuments.find((document) => document.itineraryItemId === nextActivity?.id)
    : tripDocuments.find((document) => document.itineraryItemId === nextActivity?.id);

  const completedCount = today.items.filter((item) => item.completed).length;
  const skippedCount = today.items.filter((item) => item.skipped).length;
  const remainingCount = today.items.filter((item) => !item.completed && !item.skipped && item.name.trim()).length;

  const spend = todaySpend(draft, today.id);
  const dayBudget = today.estimatedCost;

  function logEvent(type: Parameters<typeof appendLiveEvent>[1]["type"], itemId: string | null, detail: string) {
    appendLiveEvent(onPatchDraft, { tripId: draft.id, dayId: today!.id, itemId, type, detail });
  }

  function handleMarkCompleted(item: TripItineraryItem, patch?: Parameters<typeof markItemCompleted>[1]) {
    onPatchItem(today!.id, item.id, (current) => markItemCompleted(current, patch));
    logEvent("activity_completed", item.id, `${item.name} סומן כבוצע`);
    setExpandedCompletionId(null);
  }

  function handleMarkSkipped(item: TripItineraryItem, reason: string | null) {
    onPatchItem(today!.id, item.id, (current) => markItemSkipped(current, reason));
    logEvent("activity_skipped", item.id, `${item.name} דולג${reason ? ` (${reason})` : ""}`);
    setSkipTargetId(null);
  }

  function handleDelayAction(action: DelayAction, delayMinutes: number) {
    if (!nextActivity) return;
    logEvent("delay_reported", nextActivity.id, `איחור של ${delayMinutes} דקות דווח החל מ-${nextActivity.name}`);

    if (action === "leave_as_is") {
      setDelaySheetOpen(false);
      return;
    }

    if (action === "shift_day") {
      onPatchDay(today!.id, (current) => shiftRemainingDay(current, delayMinutes, nextActivity.id));
      logEvent("route_changed", nextActivity.id, `לוח הזמנים הוזז ב-${delayMinutes} דקות`);
      setDelaySheetOpen(false);
      return;
    }

    if (action === "remove_optional") {
      onPatchDay(today!.id, (current) => {
        const index = current.items.findIndex((item) => item.id === nextActivity.id);
        const nextOptional = current.items
          .slice(index + 1)
          .find((item) => item.priority === "optional" && !item.completed && !item.skipped);
        if (!nextOptional) return current;
        return {
          ...current,
          items: current.items.map((item) => (item.id === nextOptional.id ? markItemSkipped(item, "שינוי תוכניות") : item)),
        };
      });
      setDelaySheetOpen(false);
      return;
    }

    if (action === "shorten_flexible") {
      onPatchDay(today!.id, (current) => {
        const index = current.items.findIndex((item) => item.id === nextActivity.id);
        return {
          ...current,
          items: current.items.map((item, itemIndex) => {
            if (itemIndex <= index || item.locked || item.fixedTime || item.completed || item.skipped) return item;
            if (item.priority === "must") return item;
            return { ...item, estimatedDurationMinutes: Math.max(20, (item.estimatedDurationMinutes ?? 60) - delayMinutes) };
          }),
        };
      });
      setDelaySheetOpen(false);
      return;
    }

    if (action === "ai_replan") {
      setDelaySheetOpen(false);
      void onRegenerate(
        draft.id,
        "live_replan",
        today!.id,
        null,
        null,
        `אני מאחר ב-${delayMinutes} דקות מ-${nextActivity.name}. סדר מחדש את המשך היום.`
      );
    }
  }

  function handleReplanSubmit() {
    if (!replanText.trim()) return;
    logEvent("route_changed", null, `בקשת שינוי חיה: ${replanText.trim()}`);
    void onRegenerate(draft.id, "live_replan", today!.id, null, null, replanText.trim());
    setReplanText("");
    setReplanOpen(false);
  }

  function handleReplaceClosed(item: TripItineraryItem) {
    logEvent("activity_replaced", item.id, `${item.name} הוחלף (סגור/לא זמין)`);
    void onRegenerate(draft.id, "live_replace_item", today!.id, item.id);
  }

  async function handleOpenTicket(documentId: string) {
    setOpeningTicketId(documentId);
    try {
      const url = await openDocument.mutateAsync({ iso: isoA2, itineraryId: draft.id, documentId });
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setOpeningTicketId(null);
    }
  }

  const isRainy = weather ? ["drizzle", "rain", "storm"].includes(weatherIconKey(weather.current.weatherCode)) : false;

  // "מה יש לידי" (spec §20) — reuses the trip's already-loaded candidate
  // pool rather than a new live search API, sorted by distance from the
  // traveler's current position (device location if available, else the
  // next/last known stop).
  const nearbyOriginLat = location?.lat ?? originLat;
  const nearbyOriginLon = location?.lon ?? originLon;
  const usedRecommendationIds = new Set(
    draft.itineraryDays.flatMap((day) => day.items.map((item) => item.recommendationId)).filter(Boolean)
  );
  const nearby = (draft.workspaceSnapshot?.recommendations ?? [])
    .filter((place) => place.lat != null && place.lon != null && !usedRecommendationIds.has(place.id))
    .map((place) => ({ place, distanceKm: haversineKm(nearbyOriginLat, nearbyOriginLon, place.lat, place.lon) }))
    .filter((entry) => entry.distanceKm > 0 && entry.distanceKm <= 3)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 6);

  // Hotel return (spec §29) — only surfaced toward evening.
  const isEvening = nowMinutes >= 17 * 60;
  const lastStopLat = previousCompleted?.lat ?? nextActivity?.lat ?? originLat;
  const lastStopLon = previousCompleted?.lon ?? nextActivity?.lon ?? originLon;
  const hotelReturnDistanceKm =
    isEvening && today.accommodationLat != null && today.accommodationLon != null
      ? haversineKm(lastStopLat, lastStopLon, today.accommodationLat, today.accommodationLon)
      : 0;

  // Day-end flow (spec §30) — offered once nothing is left to do, or late.
  const allItemsResolved = today.items.filter((item) => item.name.trim()).every((item) => item.completed || item.skipped);

  function handleDayEndSave() {
    onPatchDay(today!.id, (current) => ({
      ...current,
      favoriteMoment,
      dayEndNote,
      dayRating: dayEndRating,
      dayCompletedAt: new Date().toISOString(),
    }));
    logEvent("day_completed", null, `יום ${dayNumber} הושלם`);
    setDayEndOpen(false);
  }

  function handleAddSpontaneous(name: string, category: RecommendationCategory) {
    const item = {
      ...createEmptyItineraryItem("afternoon"),
      name,
      category,
      plannedStartTime: nowTimeString,
      spontaneous: true,
    };
    onPatchDay(today!.id, (current) => ({ ...current, items: [...current.items, item] }));
    logEvent("spontaneous_activity_added", item.id, `נוסף באופן ספונטני: ${name}`);
  }

  return (
    <section className="space-y-4">
      <div className="section-card space-y-1 p-4">
        <p className="text-sm text-muted-foreground">
          {countryName} · {today.cityRegion || countryName}
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-heading text-xl font-semibold text-foreground">
            יום {dayNumber} מתוך {draft.daysCount}
          </h3>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{todayDateString}</span>
            <Badge variant="outline" className="gap-1">
              <Clock className="size-3.5" />
              {nowTimeString}
            </Badge>
            {weather ? (
              <Badge variant="outline">
                {weather.current.temperature}° · {WEATHER_CODE_LABELS[weather.current.weatherCode] ?? ""}
              </Badge>
            ) : null}
          </div>
        </div>
        {isRainy ? (
          <p className="mt-2 rounded-[14px] border border-border/60 bg-muted/20 p-2.5 text-xs text-muted-foreground">
            גשם בחוץ — שווה לשקול פעילויות בפנים היום. פעילויות נעולות בחוץ לא יוסרו אוטומטית.
          </p>
        ) : null}
      </div>

      {nextActivity ? (
        <div className="section-card space-y-3 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">הפעילות הבאה</p>
            {nextBookingStatus ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-1 text-xs text-foreground/80"
                onClick={() => {
                  if (!nextBookingStatus.bookingId) {
                    upsertBooking(onPatchDraft, createBookingLinkedToItem(draft.id, today!.id, nextActivity));
                  }
                }}
              >
                <span>{nextBookingStatus.glyph}</span>
                {nextBookingStatus.label}
              </button>
            ) : null}
          </div>

          <div>
            <h4 className="font-heading text-lg font-semibold text-foreground">{nextActivity.name}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{effectiveStartTime(nextActivity)}</p>
          </div>

          {leaveBy ? (
            <div
              className={cn(
                "rounded-[16px] border p-3 text-sm",
                leaveBy.status === "late" ? "border-destructive/50 bg-destructive/5" : "border-border/60 bg-background/70"
              )}
            >
              {leaveBy.status === "on_time" ? (
                <p className="font-medium text-foreground">לצאת עד: {leaveBy.leaveByTime}</p>
              ) : leaveBy.status === "leave_now" ? (
                <p className="font-medium text-foreground">צריך לצאת עכשיו</p>
              ) : (
                <p className="font-medium text-destructive">באיחור של {leaveBy.lateByMinutes} דקות</p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
                {travelMinutes > 0 ? <span>נסיעה: {travelMinutes} דק&apos;</span> : null}
                {distanceKm > 0 ? <span>מרחק: {distanceKm.toFixed(1)} ק&quot;מ</span> : null}
                <span>מרווח ביטחון: {computeBufferMinutes(nextActivity)} דק&apos;</span>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Button
              size="lg"
              className="col-span-2 gap-1.5 sm:col-span-1"
              onClick={() => window.open(buildDirectionsLink(nextActivity.lat, nextActivity.lon, nextActivity.name), "_blank", "noopener,noreferrer")}
            >
              <Navigation2 className="size-4" />
              נווט
            </Button>
            <Button size="lg" variant="outline" className="gap-1.5" onClick={() => setExpandedCompletionId(nextActivity.id)}>
              <CheckCircle2 className="size-4" />
              בוצע
            </Button>
            <Button size="lg" variant="outline" className="gap-1.5" onClick={() => setSkipTargetId(nextActivity.id)}>
              <X className="size-4" />
              דלג
            </Button>
            <Button size="lg" variant="outline" className="gap-1.5" onClick={() => setDelaySheetOpen(true)}>
              <Clock className="size-4" />
              אני מאחר
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setReplanOpen((current) => !current)}>
              <Sparkles className="size-4" />
              שנה תוכנית
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => handleReplaceClosed(nextActivity)} disabled={isRegenerating}>
              {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              המקום סגור / החלף
            </Button>
            {nextLinkedDocument ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => void handleOpenTicket(nextLinkedDocument.id)}
                disabled={openingTicketId === nextLinkedDocument.id}
              >
                {openingTicketId === nextLinkedDocument.id ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Ticket className="size-4" />
                )}
                פתח כרטיס
              </Button>
            ) : null}
          </div>

          {replanOpen ? (
            <div className="space-y-2 border-t border-border/60 pt-3">
              <Textarea
                value={replanText}
                onChange={(event) => setReplanText(event.target.value)}
                placeholder='למשל: "אני עייף", "יורד גשם", "אני רוצה לוותר על המוזיאון"'
                rows={2}
              />
              <p className="text-xs text-muted-foreground">
                ה-AI ישנה רק את המשך היום הנוכחי — פעילויות שבוצעו, דולגו, נעולות או בשעה קבועה לא ייגעו.
              </p>
              <Button size="sm" onClick={handleReplanSubmit} disabled={!replanText.trim() || isRegenerating}>
                {isRegenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                שלח ל-AI
              </Button>
            </div>
          ) : null}

          {expandedCompletionId === nextActivity.id ? (
            <QuickCompletionForm item={nextActivity} onSubmit={(patch) => handleMarkCompleted(nextActivity, patch)} onCancel={() => setExpandedCompletionId(null)} />
          ) : null}
          {skipTargetId === nextActivity.id ? (
            <QuickSkipForm onSubmit={(reason) => handleMarkSkipped(nextActivity, reason)} onCancel={() => setSkipTargetId(null)} />
          ) : null}
        </div>
      ) : (
        <div className="section-card p-4 text-center text-sm text-muted-foreground">
          כל הפעילויות המתוכננות היום הושלמו או דולגו.
        </div>
      )}

      <div className="section-card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{completedCount} בוצעו</Badge>
          <Badge variant="outline">{skippedCount} דולגו</Badge>
          <Badge variant="outline">{remainingCount} נותרו</Badge>
          <Badge variant={spend.hasData ? "secondary" : "outline"} className="gap-1">
            <Wallet className="size-3.5" />
            {spend.hasData ? `${formatCurrency(spend.total)} בפועל` : "אין עדיין הוצאות"}
            {dayBudget != null ? ` / ${formatCurrency(dayBudget)}` : ""}
          </Badge>
        </div>
      </div>

      <TodayTimeline
        day={today}
        nowMinutes={nowMinutes}
        nextActivityId={nextActivity?.id ?? null}
        bookingList={tripBookings}
        onSelectComplete={(item) => setExpandedCompletionId(item.id)}
        onSelectSkip={(item) => setSkipTargetId(item.id)}
        expandedCompletionId={expandedCompletionId}
        skipTargetId={skipTargetId}
        onMarkCompleted={handleMarkCompleted}
        onMarkSkipped={handleMarkSkipped}
        onCancelComplete={() => setExpandedCompletionId(null)}
        onCancelSkip={() => setSkipTargetId(null)}
      />

      <QuickExpenseCard dayId={today.id} onPatchDraft={onPatchDraft} />

      <SpontaneousAddCard onAdd={handleAddSpontaneous} />

      {nearby.length > 0 ? (
        <div className="section-card space-y-2 p-4">
          <p className="text-xs font-medium text-muted-foreground">מה יש לידי</p>
          <div className="space-y-1.5">
            {nearby.map(({ place, distanceKm: placeDistanceKm }) => (
              <div key={place.id} className="flex items-center justify-between gap-2 rounded-[14px] border border-border/60 bg-background/70 p-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{place.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {RECOMMENDATION_CATEGORY_LABELS[place.category]} · {placeDistanceKm.toFixed(1)} ק&quot;מ
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleAddSpontaneous(place.name, place.category)}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ItineraryDayRouteSection
        day={today}
        countryName={countryName}
        isoA2={isoA2}
        onPatchDay={onPatchDay}
        onPatchItem={onPatchItem}
        onActiveItemIdsChange={() => {}}
      />

      {location ? (
        <p className="text-xs text-muted-foreground">מיקום נוכחי זמין ומוצג במפה.</p>
      ) : null}

      {hotelReturnDistanceKm > 0 ? (
        <div className="section-card space-y-1 p-4">
          <p className="text-sm font-medium text-foreground">חזרה למלון</p>
          <p className="text-xs text-muted-foreground">
            {today.accommodation} · כ-{hotelReturnDistanceKm.toFixed(1)} ק&quot;מ מהמיקום האחרון
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              window.open(buildDirectionsLink(today.accommodationLat, today.accommodationLon, today.accommodation), "_blank", "noopener,noreferrer")
            }
          >
            <Navigation2 className="size-3.5" />
            נווט למלון
          </Button>
        </div>
      ) : null}

      {allItemsResolved && today.items.some((item) => item.name.trim()) ? (
        <div className="section-card space-y-3 p-4">
          {!dayEndOpen ? (
            <Button className="w-full" size="lg" onClick={() => setDayEndOpen(true)}>
              סיימת את היום?
            </Button>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">סיכום קצר ליום {dayNumber}</p>
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <span>{completedCount} פעילויות הושלמו</span>
                <span>{skippedCount} דולגו</span>
              </div>

              {spend.hasData ? (
                <label className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={spendConfirmed}
                    onChange={(event) => setSpendConfirmed(event.target.checked)}
                    className="size-4"
                  />
                  הוצאה בפועל היום: {formatCurrency(spend.total)} — לאשר?
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">אין נתוני הוצאה להיום.</p>
              )}

              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">דירוג היום</label>
                <Select
                  value={dayEndRating?.toString() ?? ""}
                  onValueChange={(value) => setDayEndRating(value ? Number(value) : null)}
                >
                  <SelectTrigger size="sm" className="w-20">
                    <span>{dayEndRating ?? "—"}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Input value={favoriteMoment} onChange={(event) => setFavoriteMoment(event.target.value)} placeholder="רגע אהוב מהיום?" />
              <Textarea value={dayEndNote} onChange={(event) => setDayEndNote(event.target.value)} placeholder="הערה חופשית (לא חובה)" rows={2} />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleDayEndSave}>
                  שמור וסיים יום
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDayEndOpen(false)}>
                  דלג כרגע
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <LiveDelaySheet
        open={delaySheetOpen}
        onOpenChange={setDelaySheetOpen}
        day={today}
        fromItemId={nextActivity?.id ?? today.items[0]?.id ?? ""}
        onChooseAction={handleDelayAction}
      />
    </section>
  );
}

function QuickCompletionForm({
  item,
  onSubmit,
  onCancel,
}: {
  item: TripItineraryItem;
  onSubmit: (patch: Parameters<typeof markItemCompleted>[1]) => void;
  onCancel: () => void;
}) {
  const [actualCost, setActualCost] = useState("");
  const [note, setNote] = useState("");
  const [rating, setRating] = useState<number | null>(null);

  return (
    <div className="space-y-2 rounded-[16px] border border-border/60 bg-background/70 p-3">
      <p className="text-sm font-medium text-foreground">{item.name} — בוצע!</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input type="number" value={actualCost} onChange={(event) => setActualCost(event.target.value)} placeholder="כמה עלה בפועל?" />
        <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="להוסיף הערה?" className="sm:col-span-2" />
      </div>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setRating(value)}
            className={cn("text-lg", rating != null && value <= rating ? "opacity-100" : "opacity-30")}
            aria-label={`דירוג ${value} מתוך 5`}
          >
            ★
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() =>
            onSubmit({
              actualCost: actualCost ? Number(actualCost) : undefined,
              journalNotes: note || undefined,
              personalRating: rating ?? undefined,
            })
          }
        >
          שמור
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          דלג על הפרטים
        </Button>
      </div>
    </div>
  );
}

function QuickSkipForm({ onSubmit, onCancel }: { onSubmit: (reason: string | null) => void; onCancel: () => void }) {
  return (
    <div className="space-y-2 rounded-[16px] border border-border/60 bg-background/70 p-3">
      <p className="text-sm font-medium text-foreground">למה מדלגים?</p>
      <div className="flex flex-wrap gap-1.5">
        {SKIP_REASONS.map((reason) => (
          <Badge key={reason} variant="outline" className="cursor-pointer" onClick={() => onSubmit(reason)}>
            {reason}
          </Badge>
        ))}
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        ביטול
      </Button>
    </div>
  );
}

function TodayTimeline({
  day,
  nowMinutes,
  nextActivityId,
  bookingList,
  expandedCompletionId,
  skipTargetId,
  onMarkCompleted,
  onMarkSkipped,
  onCancelComplete,
  onCancelSkip,
  onSelectComplete,
  onSelectSkip,
}: {
  day: TripItineraryDay;
  nowMinutes: number;
  nextActivityId: string | null;
  bookingList: ReturnType<typeof bookings>;
  expandedCompletionId: string | null;
  skipTargetId: string | null;
  onMarkCompleted: (item: TripItineraryItem, patch?: Parameters<typeof markItemCompleted>[1]) => void;
  onMarkSkipped: (item: TripItineraryItem, reason: string | null) => void;
  onCancelComplete: () => void;
  onCancelSkip: () => void;
  onSelectComplete: (item: TripItineraryItem) => void;
  onSelectSkip: (item: TripItineraryItem) => void;
}) {
  const items = day.items.filter((item) => item.name.trim());

  return (
    <div className="section-card space-y-3 p-4">
      <p className="text-xs font-medium text-muted-foreground">ציר היום</p>
      <div className="space-y-2">
        {items.map((item) => {
          const isNext = item.id === nextActivityId;
          const { Icon, label, delayed } = itemStatusGlyph(item, isNext, nowMinutes);
          const TransportIcon = transportModeIcon(item.transportation);
          const badges = activityStateBadges(item);
          const bookingStatus = bookingStatusForItem(item, bookingList);

          return (
            <div key={item.id} className="space-y-2">
              <div
                className={cn(
                  "flex items-start gap-3 rounded-[16px] border p-3",
                  delayed ? "border-destructive/50 bg-destructive/5" : isNext ? "border-primary/40 bg-primary/5" : "border-border/60 bg-background/70",
                  item.skipped ? "opacity-60" : ""
                )}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", item.completed ? "text-primary" : delayed ? "text-destructive" : "text-muted-foreground")} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-sm font-medium", item.completed || item.skipped ? "text-muted-foreground" : "text-foreground", item.skipped ? "line-through" : "")}>
                      {effectiveStartTime(item) || "—"} · {item.name}
                    </span>
                    <Badge variant={delayed ? "destructive" : "outline"} className="h-5 px-1.5 text-[10px]">
                      {label}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <TransportIcon className="size-3.5" />
                      {item.travelMinutes ? `${item.travelMinutes} דק'` : null}
                    </span>
                    {bookingStatus ? (
                      <span>
                        {bookingStatus.glyph} {bookingStatus.label}
                      </span>
                    ) : null}
                    {badges.map((badge) => (
                      <Badge key={badge.key} variant="outline" className="h-5 px-1.5 text-[10px]">
                        {badge.label}
                      </Badge>
                    ))}
                  </div>
                </div>
                {!item.completed && !item.skipped ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label="בוצע" onClick={() => onSelectComplete(item)}>
                      <CheckCircle2 className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="דלג" onClick={() => onSelectSkip(item)}>
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
              {expandedCompletionId === item.id ? (
                <QuickCompletionForm item={item} onSubmit={(patch) => onMarkCompleted(item, patch)} onCancel={onCancelComplete} />
              ) : null}
              {skipTargetId === item.id ? (
                <QuickSkipForm onSubmit={(reason) => onMarkSkipped(item, reason)} onCancel={onCancelSkip} />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuickExpenseCard({
  dayId,
  onPatchDraft,
}: {
  dayId: string;
  onPatchDraft: (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("food");
  const [label, setLabel] = useState("");

  function handleAdd() {
    if (!amount) return;
    const expense = { ...createQuickExpense(dayId), amount: Number(amount), category, label };
    upsertActualExpense(onPatchDraft, expense);
    setAmount("");
    setLabel("");
    setOpen(false);
  }

  return (
    <div className="section-card space-y-2 p-4">
      {open ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Input type="number" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="סכום" />
          <Select value={category} onValueChange={(value) => setCategory(value as ExpenseCategory)}>
            <SelectTrigger size="sm">
              <span>{category}</span>
            </SelectTrigger>
            <SelectContent>
              {(["food", "attractions", "local_transportation", "shopping", "accommodation", "other"] as ExpenseCategory[]).map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="הערה" className="sm:col-span-2" />
          <div className="flex gap-2 sm:col-span-4">
            <Button size="sm" onClick={handleAdd} disabled={!amount}>
              שמור הוצאה
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <Plus className="size-4" />+ הוצאה
        </Button>
      )}
    </div>
  );
}

function SpontaneousAddCard({ onAdd }: { onAdd: (name: string, category: RecommendationCategory) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<RecommendationCategory>("attraction");

  function handleAdd() {
    if (!name.trim()) return;
    onAdd(name.trim(), category);
    setName("");
    setOpen(false);
  }

  return (
    <div className="section-card space-y-2 p-4">
      {open ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="מה זה?" className="sm:col-span-2" />
          <Select value={category} onValueChange={(value) => setCategory(value as RecommendationCategory)}>
            <SelectTrigger size="sm">
              <span>{RECOMMENDATION_CATEGORY_LABELS[category]}</span>
            </SelectTrigger>
            <SelectContent>
              {["attraction", "restaurant", "cafe", "shopping", "nature", "hidden_gem"].map((value) => (
                <SelectItem key={value} value={value}>
                  {RECOMMENDATION_CATEGORY_LABELS[value as RecommendationCategory]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2 sm:col-span-3">
            <Button size="sm" onClick={handleAdd} disabled={!name.trim()}>
              הוסף
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <Plus className="size-4" />+ הוסף משהו עכשיו
        </Button>
      )}
    </div>
  );
}
