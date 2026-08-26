"use client";

import { BedDouble } from "lucide-react";

import { formatCurrency, formatDate } from "@/lib/format";
import type { TripItineraryDay } from "@/lib/trip-workspace";

interface StayBlock {
  accommodation: string;
  accommodationMapLink: string;
  startDate: string;
  endDate: string;
  nights: number;
  totalCost: number | null;
  notes: string;
}

/** Groups consecutive days sharing the same accommodation into one stay block (spec §17). */
function buildStayBlocks(days: TripItineraryDay[]): StayBlock[] {
  const blocks: StayBlock[] = [];
  for (const day of days) {
    const accommodation = day.accommodation.trim();
    if (!accommodation) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.accommodation === accommodation) {
      last.endDate = day.date || last.endDate;
      last.nights += 1;
      last.totalCost =
        last.totalCost != null || day.accommodationCost != null
          ? (last.totalCost ?? 0) + (day.accommodationCost ?? 0)
          : null;
      continue;
    }
    blocks.push({
      accommodation,
      accommodationMapLink: day.accommodationMapLink,
      startDate: day.date,
      endDate: day.date,
      nights: 1,
      totalCost: day.accommodationCost,
      notes: day.notes,
    });
  }
  return blocks;
}

export function TripAccommodationTab({ days }: { days: TripItineraryDay[] }) {
  const stays = buildStayBlocks(days);

  if (stays.length === 0) {
    return (
      <p className="section-card p-4 text-sm text-muted-foreground">
        עדיין לא הוגדרה לינה למסלול הזה.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {stays.map((stay, index) => (
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
        </div>
      ))}
    </div>
  );
}
