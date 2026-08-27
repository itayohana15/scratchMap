"use client";

import { TripOverridesSection } from "@/components/country/trip-preferences-panel";
import type { TripPreferences } from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

export function StepOverrides({
  draft,
  updatePreferences,
  derivedPace,
  derivedInterests,
}: {
  draft: TripCreationDraft;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
  derivedPace: TripPreferences["tripPace"];
  derivedInterests: string;
}) {
  return (
    <TripOverridesSection
      preferences={draft.preferences}
      updatePreferences={updatePreferences}
      derivedPace={derivedPace}
      derivedInterests={derivedInterests}
    />
  );
}
