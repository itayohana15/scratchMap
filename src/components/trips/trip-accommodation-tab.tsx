"use client";

import { useEffect, useState } from "react";
import { BedDouble, Check, MapPin, RotateCcw, Scale } from "lucide-react";

import { HotelComparisonDialog } from "@/components/trips/hotel-comparison-dialog";
import { HotelModal } from "@/components/trips/hotel-modal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  buildHotelSelectionPatch,
  isHotelExplicitlySelected,
  toggleHotelComparisonSelection,
} from "@/lib/hotel-ui-helpers";
import { useHotelRecommendations } from "@/lib/hooks/use-hotel-recommendations";
import { recalculateStayRouting, resolveStayAnchorCoordinates } from "@/lib/stay-routing";
import type { TripFlights, TripItineraryDay } from "@/lib/trip-workspace";
import type { RankedHotel } from "@/lib/hotels";

interface StayBlock {
  accommodation: string;
  accommodationMapLink: string;
  accommodationLat: number | null;
  accommodationLon: number | null;
  startDate: string;
  endDate: string;
  nights: number;
  totalCost: number | null;
  notes: string;
  dayIds: string[];
  /** Centroid of every real-coordinate item across the stay's days — the trip's own planned activity area for this base (spec item 29). */
  activityCentroid: { lat: number; lon: number } | null;
}

/** Groups consecutive days sharing the same accommodation into one stay block (spec §17), now also tracking which days it spans for hotel-selection patching (spec item 34) and a real activity centroid (spec items 28-30). */
function buildStayBlocks(days: TripItineraryDay[]): StayBlock[] {
  const blocks: StayBlock[] = [];
  for (const day of days) {
    const accommodation = day.accommodation.trim();
    if (!accommodation) continue;
    const coords = day.items.filter((item) => item.lat != null && item.lon != null) as Array<
      { lat: number; lon: number }
    >;
    const last = blocks[blocks.length - 1];
    if (last && last.accommodation === accommodation) {
      last.endDate = day.date || last.endDate;
      last.nights += 1;
      last.totalCost =
        last.totalCost != null || day.accommodationCost != null
          ? (last.totalCost ?? 0) + (day.accommodationCost ?? 0)
          : null;
      last.dayIds.push(day.id);
      if (coords.length > 0) {
        const existing = last.activityCentroid;
        const allCoords = existing ? [existing, ...coords] : coords;
        last.activityCentroid = {
          lat: allCoords.reduce((sum, c) => sum + c.lat, 0) / allCoords.length,
          lon: allCoords.reduce((sum, c) => sum + c.lon, 0) / allCoords.length,
        };
      }
      continue;
    }
    blocks.push({
      accommodation,
      accommodationMapLink: day.accommodationMapLink,
      accommodationLat: day.accommodationLat,
      accommodationLon: day.accommodationLon,
      startDate: day.date,
      endDate: day.date,
      nights: 1,
      totalCost: day.accommodationCost,
      notes: day.notes,
      dayIds: [day.id],
      activityCentroid:
        coords.length > 0
          ? {
              lat: coords.reduce((sum, c) => sum + c.lat, 0) / coords.length,
              lon: coords.reduce((sum, c) => sum + c.lon, 0) / coords.length,
            }
          : null,
    });
  }
  return blocks;
}

function HotelRowSkeleton() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 p-2">
      <Skeleton className="h-10 w-14 shrink-0 rounded-md" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

function HotelPicker({
  stay,
  isoA2,
  countryName,
  stayDays,
  onSelect,
}: {
  stay: StayBlock;
  isoA2: string;
  countryName: string;
  stayDays: TripItineraryDay[];
  onSelect: (hotel: RankedHotel) => void;
}) {
  const [detailsHotel, setDetailsHotel] = useState<RankedHotel | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareNames, setCompareNames] = useState<Set<string>>(new Set());
  const [justSelectedName, setJustSelectedName] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isRefetching } = useHotelRecommendations({
    iso: isoA2,
    lat: stay.activityCentroid?.lat ?? null,
    lon: stay.activityCentroid?.lon ?? null,
    activityClusters: stay.activityCentroid ? [stay.activityCentroid] : [],
    airportCoords: null,
  });

  // Brief, real feedback the instant a selection is made (spec item 8) —
  // the underlying data update itself is already synchronous (onPatchDay,
  // no network round-trip), this just makes it visibly obvious.
  useEffect(() => {
    if (!justSelectedName) return;
    const timeout = setTimeout(() => setJustSelectedName(null), 2500);
    return () => clearTimeout(timeout);
  }, [justSelectedName]);

  function handleSelect(hotel: RankedHotel) {
    onSelect(hotel);
    setJustSelectedName(hotel.name);
  }

  if (!stay.activityCentroid) {
    return (
      <p className="text-xs text-muted-foreground">
        עדיין אין מספיק פעילויות עם מיקום ידוע בבסיס הזה כדי להציע מלונות אמיתיים.
      </p>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        <HotelRowSkeleton />
        <HotelRowSkeleton />
        <HotelRowSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm">
        <span className="text-destructive">לא הצלחנו לטעון מלונות באזור הזה</span>
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => void refetch()} disabled={isRefetching}>
          <RotateCcw className="size-3.5" />
          נסה שוב
        </Button>
      </div>
    );
  }

  if (!data || data.hotels.length === 0) {
    return <p className="text-xs text-muted-foreground">לא נמצאו מלונות אמיתיים באזור זה כרגע.</p>;
  }

  const compared = data.hotels.filter((hotel) => compareNames.has(hotel.name));

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        אזור לינה מומלץ: קרוב לרוב הפעילויות המתוכננות בבסיס זה. מקור הנתונים: OpenStreetMap — מחיר ודירוג אינם זמינים.
      </p>
      <div className="space-y-1.5">
        {data.hotels.map((hotel) => (
          <div key={hotel.name} className="flex items-center gap-2 rounded-lg border border-border/60 p-2 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0 rounded border-border/60"
              checked={compareNames.has(hotel.name)}
              onChange={(event) =>
                setCompareNames((current) => toggleHotelComparisonSelection(current, hotel.name, event.target.checked))
              }
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{hotel.name}</p>
              <p className="text-xs text-muted-foreground">התאמה למסלול {hotel.locationScore}%</p>
            </div>
            {justSelectedName === hotel.name ? (
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" />
                נבחר
              </span>
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDetailsHotel(hotel)}>
                פרטים
              </Button>
            )}
          </div>
        ))}
      </div>
      {compareNames.size >= 2 ? (
        <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => setCompareOpen(true)}>
          <Scale className="size-3.5" />
          השווה {compareNames.size} מלונות
        </Button>
      ) : null}

      <HotelModal
        hotel={detailsHotel}
        open={detailsHotel != null}
        onOpenChange={(open) => !open && setDetailsHotel(null)}
        countryName={countryName}
        isoA2={isoA2}
        stayDays={stayDays}
        onSelect={(hotel) => {
          handleSelect(hotel);
          setDetailsHotel(null);
        }}
      />
      <HotelComparisonDialog
        hotels={compared}
        open={compareOpen}
        onOpenChange={setCompareOpen}
        onSelect={(hotel) => {
          handleSelect(hotel);
          setCompareOpen(false);
        }}
      />
    </div>
  );
}

export function TripAccommodationTab({
  days,
  isoA2,
  countryName,
  flights,
  onPatchDay,
}: {
  days: TripItineraryDay[];
  isoA2: string;
  countryName: string;
  /** Optional — when absent, hotel selection still works exactly as before, just without the arrival/departure recalculation (spec §C4/§C5). */
  flights?: TripFlights;
  onPatchDay: (dayId: string, updater: (day: TripItineraryDay) => TripItineraryDay) => void;
}) {
  const stays = buildStayBlocks(days);
  const [openPickerIndex, setOpenPickerIndex] = useState<number | null>(null);

  if (stays.length === 0) {
    return (
      <p className="section-card p-4 text-sm text-muted-foreground">
        עדיין לא הוגדרה לינה למסלול הזה.
      </p>
    );
  }

  // Section C1 — the same hotel-first coordinate hierarchy used everywhere
  // else, applied to every stay once so adjacent-stay lookups below are
  // consistent regardless of whether THAT stay has its own selected hotel.
  function resolveAnchor(block: StayBlock) {
    return resolveStayAnchorCoordinates({
      hotelCoordinates: block.accommodationLat != null && block.accommodationLon != null
        ? { lat: block.accommodationLat, lon: block.accommodationLon }
        : null,
      activityCentroid: block.activityCentroid,
    });
  }

  function selectHotel(stay: StayBlock, hotel: RankedHotel) {
    const patch = buildHotelSelectionPatch(hotel, stay.activityCentroid ? [stay.activityCentroid] : []);
    const stayIndex = stays.indexOf(stay);
    const isFirstStay = stayIndex === 0;
    const isFinalStay = stayIndex === stays.length - 1;
    // Section C2/C3/C4/C5 — recalculated with the just-selected hotel as
    // the real anchor, never the stale activity centroid.
    const routing = recalculateStayRouting({
      stayAnchor: { lat: hotel.lat, lon: hotel.lon },
      previousStayAnchor: isFirstStay ? null : resolveAnchor(stays[stayIndex - 1]),
      nextStayAnchor: isFinalStay ? null : resolveAnchor(stays[stayIndex + 1]),
      isFirstStay,
      isFinalStay,
      arrivalAirportIata: isFirstStay ? flights?.outbound?.arrivalAirport || null : null,
      departureAirportIata: isFinalStay ? flights?.return?.departureAirport || null : null,
      departureTime: isFinalStay ? flights?.return?.departureTime || null : null,
    });
    for (const dayId of stay.dayIds) {
      onPatchDay(dayId, (day) => ({
        ...day,
        ...patch,
        inboundTransitionMinutes: routing.inboundTransitionMinutes,
        outboundTransitionMinutes: routing.outboundTransitionMinutes,
        arrivalTransferMinutes: routing.arrivalTransferMinutes,
        departureTransferMinutes: routing.departureTransferMinutes,
        hotelCausedTransitionConflict: routing.hotelCausedTransitionConflict,
        hotelCausedAirportConflict: routing.hotelCausedAirportConflict,
      }));
    }
  }

  return (
    <div className="space-y-3">
      {stays.map((stay, index) => {
        const hotelSelected = isHotelExplicitlySelected(stay);
        const stayDays = days.filter((day) => stay.dayIds.includes(day.id));
        return (
          <div key={`${stay.accommodation}-${index}`} className="section-card space-y-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <BedDouble className="mt-0.5 size-4 shrink-0 text-primary" />
                <div>
                  <h4 className="font-semibold text-foreground">{stay.accommodation}</h4>
                  <p className="text-xs text-muted-foreground">
                    {stay.startDate ? formatDate(stay.startDate, "d בMMM") : ""}
                    {stay.endDate && stay.endDate !== stay.startDate ? ` – ${formatDate(stay.endDate, "d בMMM")}` : ""}
                    {" · "}
                    {stay.nights} {stay.nights === 1 ? "לילה" : "לילות"}
                  </p>
                </div>
              </div>
              {stay.totalCost != null ? (
                <span className="shrink-0 text-sm font-semibold">{formatCurrency(stay.totalCost)}</span>
              ) : null}
            </div>
            {stay.notes ? <p className="text-sm text-muted-foreground">{stay.notes}</p> : null}
            <div className="flex flex-wrap items-center gap-3">
              {stay.accommodationMapLink ? (
                <a
                  href={stay.accommodationMapLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-xs text-primary underline underline-offset-2"
                >
                  פתיחה במפה
                </a>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => setOpenPickerIndex((current) => (current === index ? null : index))}
              >
                <MapPin className="size-3.5" />
                {openPickerIndex === index ? "סגור" : hotelSelected ? "החלפת מלון" : "בחירת מלון"}
              </Button>
            </div>
            {openPickerIndex === index ? (
              <HotelPicker
                stay={stay}
                isoA2={isoA2}
                countryName={countryName}
                stayDays={stayDays}
                onSelect={(hotel) => selectHotel(stay, hotel)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
