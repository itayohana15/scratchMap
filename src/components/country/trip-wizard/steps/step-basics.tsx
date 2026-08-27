"use client";

import { useMemo } from "react";

import { PreferenceField } from "@/components/country/trip-preferences-panel";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Input } from "@/components/ui/input";
import { tripDurationDays } from "@/lib/format";
import { getHolidayTravelWarning } from "@/lib/facts/jewish-holidays";
import type { TripPreferences } from "@/lib/trip-workspace";
import type { TripCreationDraft } from "@/components/country/trip-wizard/trip-wizard-types";

export function validateStepBasics(draft: TripCreationDraft): string | null {
  const { startDate, endDate, travelers, budget } = draft.preferences;
  if (!startDate) return "יש לבחור תאריך התחלה.";
  if (!endDate) return "יש לבחור תאריך סיום.";
  if (endDate < startDate) return "תאריך הסיום לא יכול להיות לפני תאריך ההתחלה.";
  if (!Number.isFinite(travelers) || travelers < 1) return "מספר הנוסעים חייב להיות לפחות 1.";
  if (budget == null || !Number.isFinite(budget) || budget <= 0) return "יש להזין תקציב כולל תקין.";
  return null;
}

interface StepBasicsProps {
  draft: TripCreationDraft;
  updatePreferences: (patch: Partial<TripPreferences>) => void;
  updateDraft: (patch: Partial<TripCreationDraft>) => void;
}

export function StepBasics({ draft, updatePreferences, updateDraft }: StepBasicsProps) {
  const { preferences } = draft;
  const durationDays = tripDurationDays(preferences.startDate, preferences.endDate);
  // Heads-up only — never a hard block on booking around a holiday (spec item 34).
  const holidayWarning = useMemo(
    () => getHolidayTravelWarning(preferences.startDate),
    [preferences.startDate]
  );

  return (
    <div className="space-y-4">
      <PreferenceField label="תאריכי הטיול">
        <DateRangePicker
          startDate={preferences.startDate}
          endDate={preferences.endDate}
          onChange={(patch) => updatePreferences(patch)}
        />
        {durationDays ? <p className="mt-1 text-xs text-muted-foreground">{durationDays} ימים</p> : null}
        {holidayWarning ? (
          <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
            {holidayWarning}
          </p>
        ) : null}
      </PreferenceField>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label="מספר נוסעים">
          <Input
            type="number"
            min={1}
            value={preferences.travelers}
            onChange={(event) => updatePreferences({ travelers: Number(event.target.value) || 0 })}
          />
        </PreferenceField>
        <PreferenceField label="תקציב כולל (₪)">
          <Input
            type="number"
            min={0}
            value={preferences.budget ?? ""}
            onChange={(event) =>
              updatePreferences({ budget: event.target.value === "" ? null : Number(event.target.value) })
            }
            placeholder="25000"
          />
        </PreferenceField>
      </div>

      <PreferenceField label="שם לטיול (אופציונלי)">
        <Input
          value={draft.userProvidedTitle}
          onChange={(event) => updateDraft({ userProvidedTitle: event.target.value })}
          placeholder="לדוגמה: טיול הקיץ שלנו"
        />
      </PreferenceField>
    </div>
  );
}
