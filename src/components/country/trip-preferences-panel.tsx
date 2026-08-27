"use client";

import Link from "next/link";
import { RotateCcw, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { computeBehaviorSignals, deriveInferredPreferences } from "@/lib/preference-learning";
import { usePreferenceProfile } from "@/lib/queries/preference-profile";
import { useAllRecommendationFeedback } from "@/lib/queries/recommendation-feedback";
import { useTripHubTrips } from "@/lib/queries/trip-hub";
import {
  buildProfileSummaryLines,
  derivePaceFromProfile,
  deriveInterestsFromProfile,
  hasActiveOverride,
  type ProfileSummaryLine,
} from "@/lib/trip-preference-overrides";
import { type CountryTripWorkspaceState, type TripPreferences } from "@/lib/trip-workspace";

const TRIP_PACE_LABELS: Record<TripPreferences["tripPace"], string> = {
  relaxed: "רגוע",
  balanced: "מאוזן",
  fast: "אינטנסיבי",
};

export function PreferenceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium tracking-[0.02em] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function OverrideHint({ from, to }: { from: string; to: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-primary">
      <Badge variant="outline" className="text-[10px]">
        התאמה לטיול הזה
      </Badge>
      <span className="text-muted-foreground">
        {from} ← {to}
      </span>
    </p>
  );
}

export function useProfileDerivedTripDefaults() {
  const { data: profile, isLoading: profileLoading } = usePreferenceProfile();
  const { data: trips = [], isLoading: tripsLoading } = useTripHubTrips();
  const { data: feedbackRows = [] } = useAllRecommendationFeedback();

  const explicit = profile?.explicit_preferences ?? {};
  const itineraries = trips.map((trip) => trip.itinerary);
  const signals = computeBehaviorSignals(itineraries, feedbackRows);
  const { inferred } = deriveInferredPreferences(signals, explicit);

  return {
    isLoading: profileLoading || tripsLoading,
    derivedPace: derivePaceFromProfile(explicit, inferred),
    derivedInterests: deriveInterestsFromProfile(explicit, inferred),
    summaryLines: buildProfileSummaryLines(explicit, inferred),
  };
}

export function ProfilePreferencesSummary({
  isLoading,
  summaryLines,
}: {
  isLoading: boolean;
  summaryLines: ProfileSummaryLine[];
}) {
  return (
    <div className="section-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 className="font-medium">העדפות מהפרופיל שלי</h3>
        </div>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/profile" />}>
          עריכת פרופיל
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : summaryLines.length > 0 ? (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {summaryLines.map((line) => (
            <p key={line.category} className="flex items-center gap-1.5 text-sm text-foreground">
              <span className="text-muted-foreground">{line.label}:</span>
              {line.levelLabel}
              {line.isInferred ? (
                <Badge variant="outline" className="text-[10px]">
                  נלמד
                </Badge>
              ) : null}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          עדיין לא הגדרת העדפות בפרופיל. אפשר להגדיר אותן ב
          <Link href="/profile" className="mx-1 underline underline-offset-2">
            פרופיל הטיולים שלך
          </Link>
          והן יחולו אוטומטית על כל טיול חדש.
        </p>
      )}
    </div>
  );
}

interface OverridesSectionProps {
  preferences: CountryTripWorkspaceState["preferences"];
  updatePreferences: (patch: Partial<TripPreferences>) => void;
  derivedPace: TripPreferences["tripPace"];
  derivedInterests: string;
}

export function TripOverridesSection({
  preferences,
  updatePreferences,
  derivedPace,
  derivedInterests,
}: OverridesSectionProps) {
  const paceOverridden = preferences.tripPace !== derivedPace;
  const interestsOverridden = hasActiveOverride(preferences.interests, derivedInterests);
  const hasAnyOverride = paceOverridden || interestsOverridden || preferences.transportationPreferences.trim() !== "";

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        התאמות אישיות לטיול הזה בלבד — לא משנות את הפרופיל הכללי שלך. {hasAnyOverride ? "יש התאמות פעילות." : "אופציונלי."}
      </p>

      <div className="space-y-4">
        <PreferenceField label="קצב לטיול הזה">
          <Select
            value={preferences.tripPace}
            onValueChange={(value) =>
              updatePreferences({ tripPace: value as TripPreferences["tripPace"] })
            }
          >
            <SelectTrigger>
              <span>{TRIP_PACE_LABELS[preferences.tripPace]}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relaxed">רגוע</SelectItem>
              <SelectItem value="balanced">מאוזן</SelectItem>
              <SelectItem value="fast">אינטנסיבי</SelectItem>
            </SelectContent>
          </Select>
          {paceOverridden ? (
            <OverrideHint from={TRIP_PACE_LABELS[derivedPace]} to={TRIP_PACE_LABELS[preferences.tripPace]} />
          ) : null}
        </PreferenceField>

        <PreferenceField label="תחומי עניין לטיול הזה">
          <Input
            value={preferences.interests}
            onChange={(event) => updatePreferences({ interests: event.target.value })}
            placeholder={derivedInterests || "היסטוריה, שווקים, חופים..."}
          />
          {interestsOverridden ? (
            <OverrideHint from={derivedInterests || "לא הוגדר בפרופיל"} to={preferences.interests || "ריק"} />
          ) : null}
        </PreferenceField>

        <PreferenceField label="תחבורה מועדפת (אופציונלי)">
          <Input
            value={preferences.transportationPreferences}
            onChange={(event) =>
              updatePreferences({ transportationPreferences: event.target.value })
            }
            placeholder="רכב, רכבת, הליכה..."
          />
        </PreferenceField>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={!hasAnyOverride}
          onClick={() =>
            updatePreferences({
              tripPace: derivedPace,
              interests: derivedInterests,
              transportationPreferences: "",
            })
          }
        >
          <RotateCcw className="size-3.5" />
          אפס התאמות לטיול הזה
        </Button>
      </div>
    </div>
  );
}

