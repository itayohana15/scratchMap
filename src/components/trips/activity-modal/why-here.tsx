"use client";

import { Sparkles } from "lucide-react";

import { ModalSection } from "@/components/country/attraction-modal/shared";
import { explainItineraryPlacement } from "@/lib/itinerary-explain-placement";
import type { TripItineraryDay, TripItineraryItem, TripPreferences } from "@/lib/trip-workspace";

interface WhyInItineraryProps {
  item: TripItineraryItem;
  day: TripItineraryDay;
  previousItem: TripItineraryItem | null;
  preferences: TripPreferences;
}

export function WhyInItinerarySection({ item, day, previousItem, preferences }: WhyInItineraryProps) {
  const explanation = explainItineraryPlacement(item, day, previousItem, preferences);

  return (
    <ModalSection title="למה זה במסלול שלך?" icon={Sparkles}>
      <p className="text-sm leading-6 text-muted-foreground">{explanation}</p>
    </ModalSection>
  );
}
