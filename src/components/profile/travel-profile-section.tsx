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

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 truncate text-sm text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        {value != null ? (
          <div className="h-full rounded-full bg-primary" style={{ width: `${(value / 5) * 100}%` }} />
        ) : null}
      </div>
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
        {value != null ? PREFERENCE_LEVEL_LABELS[value as PreferenceLevel] : "לא הוגדר"}
      </span>
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
          <h1 className="font-heading text-2xl font-semibold text-foreground">פרופיל הטיולים שלי</h1>
          <p className="text-sm text-muted-foreground">ההעדפות שהגדרת, והדפוסים שהמערכת זיהתה בפועל.</p>
        </div>
      </div>

      {visibleSuggestions.length > 0 ? (
        <div className="section-card space-y-3 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="font-heading text-lg font-semibold">הצעות לעדכון העדפות</h3>
          </div>
          <div className="space-y-2">
            {visibleSuggestions.map((suggestion) => (
              <div key={suggestion.category} className="space-y-2 rounded-xl border border-border/60 bg-background/60 p-3">
                <p className="text-sm text-foreground/90">{suggestion.suggestionText}</p>
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
        <div key={group.title} className="section-card space-y-3 p-4">
          <h3 className="font-heading text-lg font-semibold">{group.title}</h3>
          <div className="space-y-3">
            {group.categories.map((category) => {
              const explicitLevel = (profile.explicit_preferences ?? {})[category] ?? null;
              const inferredEntry = inferred[category];
              return (
                <div key={category} className="space-y-1">
                  <div className="flex items-center gap-3">
                    <ScoreBar label={PREFERENCE_CATEGORY_LABELS[category]} value={explicitLevel} />
                    <Select
                      value={explicitLevel?.toString() ?? ""}
                      onValueChange={(value) =>
                        patchExplicit.mutate({ category, level: value ? Number(value) : null })
                      }
                    >
                      <SelectTrigger size="sm" className="w-28 shrink-0">
                        <span className="text-xs">{explicitLevel ? PREFERENCE_LEVEL_LABELS[explicitLevel as PreferenceLevel] : "הגדר"}</span>
                      </SelectTrigger>
                      <SelectContent>
                        {([1, 2, 3, 4, 5] as PreferenceLevel[]).map((level) => (
                          <SelectItem key={level} value={level.toString()}>
                            {PREFERENCE_LEVEL_LABELS[level]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {inferredEntry ? (
                    <div className="mr-[8.75rem] flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn(inferredEntry.direction === "up" ? "text-primary" : "text-destructive")}>
                        {inferredEntry.direction === "up" ? "↑" : "↓"}
                      </span>
                      נלמד: {PREFERENCE_LEVEL_LABELS[inferredEntry.level as PreferenceLevel]}
                      <Badge variant="outline" className="text-[10px]">
                        ביטחון {Math.round(inferredEntry.confidence * 100)}%
                      </Badge>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
