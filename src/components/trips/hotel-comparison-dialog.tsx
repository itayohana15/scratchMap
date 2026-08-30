"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { pickHotelComparisonWinners } from "@/lib/hotel-ui-helpers";
import type { RankedHotel } from "@/lib/hotels";
import { cn } from "@/lib/utils";

function formatMinutes(minutes: number | null): string {
  return minutes == null ? "לא זמין" : `כ-${minutes} דק'`;
}

/**
 * Up to 3 hotels side by side (spec item 7). Location-fit metrics come
 * first and get the real winner highlighted — price/rating/facilities/room
 * stay explicitly "לא זמין" and are never highlighted (no data source
 * exists for them, spec item 98; a winner label on a made-up number would
 * be worse than showing nothing).
 */
export function HotelComparisonDialog({
  hotels,
  open,
  onOpenChange,
  onSelect,
}: {
  hotels: RankedHotel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (hotel: RankedHotel) => void;
}) {
  const compared = hotels.slice(0, 3);
  const winners = pickHotelComparisonWinners(compared);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(96vw,900px)] max-w-none overflow-x-auto">
        <DialogHeader>
          <DialogTitle>השוואת מלונות</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${compared.length}, minmax(190px, 1fr))` }}>
          {compared.map((hotel, index) => (
            <div key={hotel.name} className="space-y-2.5 rounded-xl border border-border/60 p-3 text-sm">
              <h4 className="font-semibold">{hotel.name}</h4>

              <div
                className={cn(
                  "rounded-lg p-2 text-center",
                  winners.locationScoreWinner === index ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : "bg-muted/40"
                )}
              >
                <p className="text-lg font-bold text-foreground">{hotel.locationScore}%</p>
                <p className="text-[11px] text-muted-foreground">התאמה למסלול</p>
              </div>

              <div className="space-y-1 text-muted-foreground">
                <p className={winners.activityTravelWinner === index ? "font-semibold text-emerald-600 dark:text-emerald-400" : undefined}>
                  זמן ממוצע לפעילויות: {formatMinutes(hotel.averageActivityTravelMinutes)}
                </p>
                <p className={winners.airportTravelWinner === index ? "font-semibold text-emerald-600 dark:text-emerald-400" : undefined}>
                  זמן לשדה תעופה: {formatMinutes(hotel.airportTravelMinutes)}
                </p>
                <p className="text-xs">מחיר: לא זמין</p>
                <p className="text-xs">שירותים: לא זמין</p>
                <p className="text-xs">אזור: לא זמין</p>
              </div>

              {onSelect ? (
                <Button type="button" size="sm" className="w-full" onClick={() => onSelect(hotel)}>
                  בחר
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
