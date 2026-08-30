"use client";

import { MapPin } from "lucide-react";

import { HotelHero } from "@/components/trips/hotel-modal/hotel-hero";
import { ItineraryTripSummarySection } from "@/components/country/itinerary-route-map";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RankedHotel } from "@/lib/hotels";
import type { TripItineraryDay } from "@/lib/trip-workspace";

function formatMinutes(minutes: number | null): string {
  if (minutes == null) return "לא זמין";
  return `כ-${minutes} דק'`;
}

// Kept as a plain function (not imported from hotels.ts) so this
// client-only file never pulls in hotels.ts's server-only Overpass
// dependency into the client bundle — same logic, duplicated on purpose.
function explainHotelFitLazy(hotel: RankedHotel): string {
  if (hotel.averageActivityTravelMinutes == null) {
    return "אין מספיק נתוני מיקום כדי להסביר את ההתאמה של המלון הזה למסלול.";
  }
  if (hotel.averageActivityTravelMinutes <= 10) {
    return `המלון נמצא במרחק הליכה קצר (כ-${hotel.averageActivityTravelMinutes} דק') מרוב הפעילויות המתוכננות בבסיס זה.`;
  }
  if (hotel.averageActivityTravelMinutes <= 20) {
    return `המלון נמצא במרחק נסיעה קצר (כ-${hotel.averageActivityTravelMinutes} דק') מרוב הפעילויות המתוכננות בבסיס זה.`;
  }
  return `המלון מקצר במידה מסוימת את הנסיעות (כ-${hotel.averageActivityTravelMinutes} דק' בממוצע) לפעילויות המתוכננות, אך יש אפשרויות קרובות יותר.`;
}

function noopPatchItem() {}
function noopOpenDay() {}

/**
 * Real hotel details (spec item 31) — photo gallery matching the activity
 * modal's own mechanics (spec item 14), a prominent real location-fit
 * metric as the hero number since price/rating have no data source (spec
 * item 5), and an embedded map of the stay's own days reusing the existing
 * itinerary map (its own day-filter/fit-bounds logic is untouched — spec
 * item 6). Price/rating/amenities/booking-link stay honest small muted
 * "לא זמין" text, never a prominent empty metric card (spec item 4).
 */
export function HotelModal({
  hotel,
  open,
  onOpenChange,
  onSelect,
  countryName,
  isoA2,
  stayDays,
}: {
  hotel: RankedHotel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (hotel: RankedHotel) => void;
  countryName: string;
  isoA2: string;
  stayDays: TripItineraryDay[];
}) {
  if (!hotel) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[min(96vw,720px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{hotel.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <HotelHero hotelName={hotel.name} countryName={countryName} open={open} />

          <div className="rounded-xl bg-primary/5 p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{hotel.locationScore}%</p>
            <p className="text-xs text-muted-foreground">התאמה למסלול</p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">מרחק ממוצע מהפעילויות</p>
              <p className="font-medium">{formatMinutes(hotel.averageActivityTravelMinutes)}</p>
            </div>
            <div className="rounded-lg border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">מרחק משדה התעופה</p>
              <p className="font-medium">{formatMinutes(hotel.airportTravelMinutes)}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {hotel.openingHours ? `שעות: ${hotel.openingHours} · ` : ""}מחיר: לא זמין · דירוג: לא זמין · ביקורות: לא זמין
          </p>

          <div className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
            <p className="mb-1 flex items-center gap-1 font-medium text-foreground">
              <MapPin className="size-3.5" />
              למה המלון מתאים למסלול
            </p>
            <p>{explainHotelFitLazy(hotel)}</p>
          </div>

          {stayDays.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-border/60">
              <ItineraryTripSummarySection
                days={stayDays}
                countryName={countryName}
                isoA2={isoA2}
                onPatchDay={() => {}}
                onPatchItem={noopPatchItem}
                onOpenDay={noopOpenDay}
              />
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">
            מקור: OpenStreetMap (Overpass API). פרטי מחיר, דירוג וביקורות אינם זמינים ללא חיבור לשירות הזמנות בתשלום —
            אינם מוצגים כדי לא להציג נתון שגוי.
          </p>

          {onSelect ? (
            <Button type="button" className="w-full" onClick={() => onSelect(hotel)}>
              בחר מלון זה
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
