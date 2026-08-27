"use client";

import { Lightbulb } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import type { RecommendationCategory, TripItineraryItem } from "@/lib/trip-workspace";

const OUTDOOR_CATEGORIES: RecommendationCategory[] = ["nature", "day_trip", "attraction"];

/**
 * Kept intentionally small and conservative (spec item 17) — every tip here
 * is derived from a real field the item already carries (reservationRequired,
 * category), not invented specifics like exact crowd levels or photography
 * spots we have no source for.
 */
export function TipsSection({ item }: { item: TripItineraryItem }) {
  const tips: string[] = [];

  if (item.reservationRequired) {
    tips.push("מומלץ להזמין מקום מראש — יש דרישת הזמנה למקום הזה.");
  }

  if (OUTDOOR_CATEGORIES.includes(item.category)) {
    tips.push("פעילות בחוץ — אם צפוי גשם ביום זה, כדאי לשקול להחליף לפעילות מקורה.");
  }

  if (tips.length === 0) return null;

  return (
    <ModalSection title="טיפים" icon={Lightbulb}>
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {tips.map((tip) => (
          <li key={tip}>• {tip}</li>
        ))}
      </ul>
    </ModalSection>
  );
}
