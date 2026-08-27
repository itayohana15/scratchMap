"use client";

import Image from "next/image";
import { CheckCircle2, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCountrySuccessIllustration } from "@/lib/country-success-illustrations";
import { formatCurrency, formatElapsedDuration, formatTripDateRange, tripDurationDays } from "@/lib/format";
import type { CountryItineraryGenerationSuccessPayload } from "@/lib/itineraries";
import { cn } from "@/lib/utils";

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized;
  const value = Number.parseInt(full, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Content only — no own Dialog — extracted from the old
 * CountryItinerarySuccessDialog so the wizard's single Dialog can host this
 * phase without closing/reopening a second dialog (spec Part C/G). "המשך
 * לערוך" is dropped: there's no longer a country-page draft workspace to
 * return to — editing now happens on /trips/[id] itself.
 */
export function GenerationSuccessPhase({
  success,
  finalElapsedMs,
  onOpenItinerary,
  onClose,
}: {
  success: CountryItineraryGenerationSuccessPayload;
  finalElapsedMs: number | null;
  onOpenItinerary: (itineraryId: string) => void;
  onClose: () => void;
}) {
  const illustration = useMemo(
    () => getCountrySuccessIllustration(success.countryCode, success.countryName),
    [success]
  );
  const [artworkSrc, setArtworkSrc] = useState(illustration.illustrationPath);
  const [flagSrc, setFlagSrc] = useState(illustration.flagPath);

  useEffect(() => {
    setArtworkSrc(illustration.illustrationPath);
    setFlagSrc(illustration.flagPath);
  }, [illustration]);

  const dateRange = success.startDate && success.endDate ? formatTripDateRange(success.startDate, success.endDate) : null;
  const durationDays = tripDurationDays(success.startDate, success.endDate) ?? success.totalDays;
  const savedMessage = dateRange
    ? `המסלול ל${success.countryName} לתאריכים ${dateRange} נוצר ונשמר בהצלחה.`
    : `המסלול ל${success.countryName} נוצר ונשמר בהצלחה.`;

  return (
    <div className="grid min-h-0 md:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)]">
      <div
        className="relative border-b border-border/70 p-4 md:border-b-0 md:border-l md:p-6"
        style={{
          backgroundImage: `linear-gradient(145deg, ${hexToRgba(illustration.accentColor ?? "#5c7c67", 0.14)}, transparent 62%)`,
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <Badge
            variant="outline"
            className="border-border/60 bg-background/75 backdrop-blur-sm"
            style={{ borderColor: hexToRgba(illustration.accentColor ?? "#5c7c67", 0.32) }}
          >
            {illustration.visualStyle}
          </Badge>
          <div className="overflow-hidden rounded-full border border-border/70 bg-background/85 shadow-sm">
            <Image
              src={flagSrc}
              alt={`דגל ${success.countryName}`}
              width={38}
              height={38}
              className="size-9 object-cover"
              onError={() => setFlagSrc("/flags/xx.png")}
            />
          </div>
        </div>

        <div className="relative min-h-[220px] overflow-hidden rounded-[26px] border border-border/60 bg-background/65 p-4 shadow-[0_18px_60px_-28px_rgba(15,23,42,0.35)] backdrop-blur-sm sm:min-h-[300px] sm:p-5">
          <Image
            src={artworkSrc}
            alt={illustration.alt}
            fill
            sizes="(min-width: 768px) 42vw, 100vw"
            className="object-contain object-center p-2"
            onError={() => {
              if (artworkSrc !== "/images/country-success/generic.jpg") setArtworkSrc("/images/country-success/generic.jpg");
            }}
            unoptimized
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-col p-5 sm:p-6">
        <DialogHeader className="space-y-3">
          <div
            className={cn(
              "inline-flex w-fit items-center gap-2 rounded-full border border-border/70 bg-muted/35 px-3 py-1 text-sm font-medium text-foreground",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-reduce:animate-none"
            )}
          >
            <span
              className="inline-flex size-8 items-center justify-center rounded-full text-primary-foreground shadow-sm"
              style={{ backgroundColor: illustration.accentColor }}
            >
              <CheckCircle2 className="size-4.5" />
            </span>
            המסלול מוכן
          </div>
          <div className="space-y-2">
            <DialogTitle className="text-2xl sm:text-[1.9rem]">המסלול שלך מוכן</DialogTitle>
            <DialogDescription className="text-sm leading-7">
              <span className="block font-medium text-foreground">{success.countryName}</span>
              <span className="block">{dateRange ?? "התאריכים נשמרו במסלול החדש."}</span>
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">משך הטיול</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{durationDays} ימים</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
            <p className="text-xs text-muted-foreground">ימים שנוצרו</p>
            <p className="mt-1 text-xl font-semibold text-foreground">{success.totalDays}</p>
          </div>
          {success.estimatedTotalCost != null ? (
            <div className="rounded-2xl border border-border/70 bg-muted/20 p-4 sm:col-span-2">
              <p className="text-xs text-muted-foreground">עלות כוללת משוערת</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{formatCurrency(success.estimatedTotalCost)}</p>
            </div>
          ) : null}
        </div>

        <div className="mt-5 rounded-2xl border border-border/70 bg-card/50 p-4 text-sm leading-7 text-muted-foreground">
          {savedMessage}
          {finalElapsedMs != null ? (
            <span className="mt-1 block text-xs tabular-nums">זמן יצירה: {formatElapsedDuration(finalElapsedMs)}</span>
          ) : null}
        </div>

        <DialogFooter className="mt-auto bg-transparent px-0 pb-0 pt-5 sm:justify-stretch sm:border-0">
          <Button className="w-full gap-2 sm:flex-1" onClick={() => onOpenItinerary(success.itineraryId)}>
            <Route className="size-4" />
            פתח את הטיול
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={onClose}>
            סגור
          </Button>
        </DialogFooter>
      </div>
    </div>
  );
}
