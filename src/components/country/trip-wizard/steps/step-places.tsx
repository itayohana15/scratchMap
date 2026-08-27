"use client";

import { PreferenceField } from "@/components/country/trip-preferences-panel";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TripPreferences } from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

const PLACE_TYPE_CHIPS = ["טבע", "שווקים", "אוכל", "חיי לילה", "תרבות", "כפרים", "חופים", "הרים"];

function parseInterestTags(interests: string): string[] {
  return interests
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function StepPlaces({
  draft,
  updatePreferences,
}: {
  draft: TripCreationDraft;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}) {
  const { preferences } = draft;
  const activeTags = parseInterestTags(preferences.interests);

  function toggleTag(tag: string) {
    const nextTags = activeTags.includes(tag)
      ? activeTags.filter((entry) => entry !== tag)
      : [...activeTags, tag];
    updatePreferences({ interests: nextTags.join(", ") });
  }

  return (
    <div className="space-y-4">
      <PreferenceField label="חייב להיות במסלול">
        <Input
          value={preferences.mustVisitPlaces}
          onChange={(event) => updatePreferences({ mustVisitPlaces: event.target.value })}
          placeholder="לדוגמה: טביליסי, קזבגי, בטומי"
        />
      </PreferenceField>

      <PreferenceField label="לא רוצה במסלול (אופציונלי)">
        <Input
          value={preferences.placesToAvoid}
          onChange={(event) => updatePreferences({ placesToAvoid: event.target.value })}
          placeholder="אזורים או סוגי מקומות שכדאי להימנע מהם"
        />
      </PreferenceField>

      <PreferenceField label="סוגי מקומות שאני רוצה במיוחד">
        <div className="flex flex-wrap gap-2">
          {PLACE_TYPE_CHIPS.map((chip) => {
            const active = activeTags.includes(chip);
            return (
              <button
                key={chip}
                type="button"
                onClick={() => toggleTag(chip)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted"
                )}
              >
                {chip}
              </button>
            );
          })}
        </div>
      </PreferenceField>
    </div>
  );
}
