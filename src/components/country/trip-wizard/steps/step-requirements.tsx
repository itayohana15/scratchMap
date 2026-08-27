"use client";

import { PreferenceField } from "@/components/country/trip-preferences-panel";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TripPreferences } from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

export type FoodChipCategory = "restriction" | "interest";

export interface FoodChipDef {
  label: string;
  category: FoodChipCategory;
}

// Category matters (spec item 15): restrictions are hard constraints
// (dietaryPreferences, already enumerated as mandatory in the AI prompt);
// interests only affect ranking (folded into the existing `interests`
// field, same bucket step-places.tsx's place-type chips already use).
export const FOOD_CHIPS: FoodChipDef[] = [
  { label: "אוכל מקומי", category: "interest" },
  { label: "אוכל רחוב", category: "interest" },
  { label: "צמחוני", category: "restriction" },
  { label: "טבעוני", category: "restriction" },
  { label: "כשר", category: "restriction" },
  { label: "ללא גלוטן", category: "restriction" },
  { label: "דגים ופירות ים", category: "interest" },
  { label: "בשר", category: "interest" },
  { label: "אסייתי", category: "interest" },
  { label: "ים תיכוני", category: "interest" },
  { label: "בתי קפה", category: "interest" },
  { label: "אוכל זול", category: "interest" },
  { label: "Fine dining", category: "interest" },
  { label: "שווקים", category: "interest" },
  { label: "מאפיות", category: "interest" },
  { label: "קינוחים", category: "interest" },
];

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function FoodPreferencesChips({
  preferences,
  updatePreferences,
}: {
  preferences: TripPreferences;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}) {
  const restrictionTags = parseTags(preferences.dietaryPreferences);
  const interestTags = parseTags(preferences.interests);

  function toggleChip(chip: FoodChipDef) {
    if (chip.category === "restriction") {
      const next = restrictionTags.includes(chip.label)
        ? restrictionTags.filter((tag) => tag !== chip.label)
        : [...restrictionTags, chip.label];
      updatePreferences({ dietaryPreferences: next.join(", ") });
    } else {
      const next = interestTags.includes(chip.label)
        ? interestTags.filter((tag) => tag !== chip.label)
        : [...interestTags, chip.label];
      updatePreferences({ interests: next.join(", ") });
    }
  }

  function isSelected(chip: FoodChipDef) {
    return chip.category === "restriction" ? restrictionTags.includes(chip.label) : interestTags.includes(chip.label);
  }

  return (
    <PreferenceField label="העדפות אוכל">
      <div className="flex flex-wrap gap-2">
        {FOOD_CHIPS.map((chip) => {
          const selected = isSelected(chip);
          return (
            <button
              key={chip.label}
              type="button"
              onClick={() => toggleChip(chip)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                selected
                  ? chip.category === "restriction"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-primary/70 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              )}
            >
              {chip.label}
              {selected ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        אפשר לבחור כמה שרוצים — כל הבחירות מצטרפות יחד (זה לא &quot;בחר אחד&quot;). בהיר = תחום עניין, מלא = מגבלה קשיחה.
      </p>
    </PreferenceField>
  );
}

/** דיאטה/נגישות/מגבלות תנועה/בטיחות — existing TripPreferences fields (spec Step 5). */
export function StepRequirements({
  draft,
  updatePreferences,
}: {
  draft: TripCreationDraft;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}) {
  const { preferences } = draft;

  return (
    <div className="space-y-4">
      <FoodPreferencesChips preferences={preferences} updatePreferences={updatePreferences} />

      <PreferenceField label="הערות אוכל נוספות">
        <Textarea
          value={preferences.foodNotes}
          onChange={(event) => updatePreferences({ foodNotes: event.target.value })}
          rows={2}
          placeholder="למשל: להעדיף מקומות מקומיים ולא רשתות, ארוחה יקרה אחת בלבד במהלך הטיול..."
        />
      </PreferenceField>

      <PreferenceField label="נגישות ומגבלות תנועה">
        <Input
          value={preferences.accessibilityNeeds}
          onChange={(event) => updatePreferences({ accessibilityNeeds: event.target.value })}
          placeholder="מעליות, הליכה קצרה, ללא טיולי הליכה ארוכים..."
        />
      </PreferenceField>

      <PreferenceField label="דברים שחשוב לי שהמסלול יתחשב בהם">
        <Textarea
          value={preferences.safetyConstraints}
          onChange={(event) => updatePreferences({ safetyConstraints: event.target.value })}
          rows={4}
          placeholder="למשל: ללא נסיעות לילה, לחזור למלון עד שעה מסוימת, מגבלות דתיות/חג, העדפות בטיחות..."
        />
      </PreferenceField>
    </div>
  );
}
