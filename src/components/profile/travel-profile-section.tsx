"use client";

import { Sparkles, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  computeBehaviorSignals,
  deriveInferredPreferences,
  PREFERENCE_CATEGORY_LABELS,
  PREFERENCE_LEVEL_LABELS,
  type PreferenceCategory,
  type PreferenceLevel,
} from "@/lib/preference-learning";
import {
  useAcceptSuggestion,
  useDismissSuggestion,
  usePatchExplicitPreference,
  usePreferenceProfile,
} from "@/lib/queries/preference-profile";
import { useAllRecommendationFeedback } from "@/lib/queries/recommendation-feedback";
import { useTripHubTrips } from "@/lib/queries/trip-hub";
import { cn } from "@/lib/utils";

const CATEGORY_GROUPS: Array<{ title: string; categories: PreferenceCategory[] }> = [
  { title: "קצב וסגנון", categories: ["pace", "adventure", "social"] },
  { title: "עניין ותרבות", categories: ["nature", "history", "culture", "museums", "famous_landmarks", "hidden_gems", "local_neighborhoods"] },
  { title: "פעילות בחוץ", categories: ["hiking", "beaches", "scenic_viewpoints", "photography", "theme_parks", "spa"] },
  { title: "אוכל", categories: ["food", "local_food", "fine_dining", "street_food"] },
  { title: "חיי לילה וקניות", categories: ["nightlife", "events", "shopping", "markets"] },
];

// One consistent control everywhere on the page (spec §15) — a full-width
// select whose own trigger IS the "no value" state ("לא הוגדר"), so there's
// never a separate redundant label + a separate "הגדר" button for the same
// fact (spec §5).
function PreferenceCard({
  category,
  explicitLevel,
  inferredEntry,
  onChange,
}: {
  category: PreferenceCategory;
  explicitLevel: PreferenceLevel | null;
  inferredEntry: { level: number; confidence: number; direction: "up" | "down" } | undefined;
  onChange: (level: PreferenceLevel | null) => void;
}) {
  return (
    <div className="section-card flex min-h-[100px] flex-col justify-center gap-2.5 p-4 sm:p-5">
      <p className="text-base font-semibold text-foreground sm:text-lg">{PREFERENCE_CATEGORY_LABELS[category]}</p>
      <Select
        value={explicitLevel?.toString() ?? ""}
        onValueChange={(value) => onChange(value ? (Number(value) as PreferenceLevel) : null)}
      >
        <SelectTrigger className="h-12 w-full rounded-xl border-border/70 px-4 text-base">
          <span>{explicitLevel ? PREFERENCE_LEVEL_LABELS[explicitLevel] : "לא הוגדר"}</span>
        </SelectTrigger>
        <SelectContent>
          {([1, 2, 3, 4, 5] as PreferenceLevel[]).map((level) => (
            <SelectItem key={level} value={level.toString()} className="text-base">
              {PREFERENCE_LEVEL_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {inferredEntry ? (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className={cn("text-base", inferredEntry.direction === "up" ? "text-primary" : "text-destructive")}>
            {inferredEntry.direction === "up" ? "↑" : "↓"}
          </span>
          נלמד: {PREFERENCE_LEVEL_LABELS[inferredEntry.level as PreferenceLevel]}
          <Badge variant="outline" className="text-[11px]">
            ביטחון {Math.round(inferredEntry.confidence * 100)}%
          </Badge>
        </div>
      ) : null}
    </div>
  );
}

export function TravelProfileSection() {
  const { data: profile, isLoading: profileLoading } = usePreferenceProfile();
  const { data: trips = [], isLoading: tripsLoading } = useTripHubTrips();
  const { data: feedbackRows = [] } = useAllRecommendationFeedback();
  const patchExplicit = usePatchExplicitPreference();
  const acceptSuggestion = useAcceptSuggestion();
  const dismissSuggestion = useDismissSuggestion();

  if (profileLoading || tripsLoading || !profile) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
    );
  }

  const itineraries = trips.map((trip) => trip.itinerary);
  const signals = computeBehaviorSignals(itineraries, feedbackRows);
  const { inferred, suggestions } = deriveInferredPreferences(signals, profile.explicit_preferences ?? {});
  const dismissed = new Set(profile.dismissed_suggestions ?? []);
  const visibleSuggestions = suggestions.filter((suggestion) => !dismissed.has(suggestion.category));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <User className="size-6" />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-bold text-foreground sm:text-3xl">פרופיל הטיולים שלי</h1>
          <p className="mt-0.5 text-sm text-muted-foreground sm:text-base">
            העדפות אלה משפיעות על תכנון המסלולים וההמלצות שלך.
          </p>
        </div>
      </div>

      {visibleSuggestions.length > 0 ? (
        <div className="section-card space-y-3 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            <h3 className="font-heading text-xl font-bold">הצעות לעדכון העדפות</h3>
          </div>
          <div className="space-y-2">
            {visibleSuggestions.map((suggestion) => (
              <div key={suggestion.category} className="space-y-2 rounded-xl border border-border/60 bg-background/60 p-3">
                <p className="text-sm text-foreground/90 sm:text-base">{suggestion.suggestionText}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => acceptSuggestion.mutate({ category: suggestion.category, level: suggestion.inferredLevel })}
                  >
                    כן
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => dismissSuggestion.mutate({ suggestionKey: suggestion.category, permanently: false })}>
                    לא
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => dismissSuggestion.mutate({ suggestionKey: suggestion.category, permanently: true })}
                  >
                    אל תשאל שוב על זה
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {CATEGORY_GROUPS.map((group) => (
        <div key={group.title} className="section-card space-y-4 p-5 sm:p-6">
          <h3 className="font-heading text-xl font-bold text-foreground sm:text-2xl">{group.title}</h3>
          <div className="grid grid-cols-1 gap-4 min-[700px]:grid-cols-2 min-[1100px]:grid-cols-3">
            {group.categories.map((category) => (
              <PreferenceCard
                key={category}
                category={category}
                explicitLevel={((profile.explicit_preferences ?? {})[category] as PreferenceLevel | undefined) ?? null}
                inferredEntry={inferred[category]}
                onChange={(level) => patchExplicit.mutate({ category, level })}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
