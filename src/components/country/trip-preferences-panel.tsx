"use client";

import Link from "next/link";
import { RotateCcw, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import {
  createEmptyFlightLeg,
  ITINERARY_GENERATION_MODE_LABELS,
  type CountryTripWorkspaceState,
  type FlightBookingStatus,
  type TripFlightLeg,
  type TripPreferences,
} from "@/lib/trip-workspace";

const FLIGHT_BOOKING_STATUS_LABELS: Record<FlightBookingStatus, string> = {
  not_booked: "לא הוזמן",
  booked: "הוזמן",
  paid: "שולם",
};

const TRIP_PACE_LABELS: Record<TripPreferences["tripPace"], string> = {
  relaxed: "רגוע",
  balanced: "מאוזן",
  fast: "אינטנסיבי",
};

function PreferenceField({ label, children }: { label: string; children: React.ReactNode }) {
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
    <details className="section-card group space-y-0 p-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <span className="font-medium">התאמות לטיול הזה</span>
        <span className="text-xs text-muted-foreground group-open:hidden">
          {hasAnyOverride ? "יש התאמות פעילות" : "אופציונלי"}
        </span>
      </summary>

      <div className="mt-4 space-y-4">
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
    </details>
  );
}

interface SpecialRequirementsSectionProps {
  preferences: CountryTripWorkspaceState["preferences"];
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}

export function TripSpecialRequirementsSection({
  preferences,
  updatePreferences,
}: SpecialRequirementsSectionProps) {
  return (
    <details className="section-card group space-y-0 p-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <span className="font-medium">דרישות מיוחדות</span>
        <span className="text-xs text-muted-foreground">אופציונלי</span>
      </summary>

      <div className="mt-4 space-y-4">
        <PreferenceField label="סגנון טיול">
          <Input
            value={preferences.tripStyle}
            onChange={(event) => updatePreferences({ tripStyle: event.target.value })}
            placeholder="רומנטי, עירוני, קולינרי..."
          />
        </PreferenceField>

        <PreferenceField label="Mode ליצירת מסלול">
          <Select
            value={preferences.generationMode}
            onValueChange={(value) =>
              updatePreferences({
                generationMode: value as TripPreferences["generationMode"],
              })
            }
          >
            <SelectTrigger>
              <span>{ITINERARY_GENERATION_MODE_LABELS[preferences.generationMode]}</span>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ITINERARY_GENERATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PreferenceField>

        <PreferenceField label="אזור לינה">
          <Input
            value={preferences.accommodationArea}
            onChange={(event) => updatePreferences({ accommodationArea: event.target.value })}
            placeholder="מרכז, ליד חוף, ליד תחנה..."
          />
        </PreferenceField>

        <PreferenceField label="אזורים / ערים מועדפים">
          <Input
            value={preferences.preferredRegions}
            onChange={(event) => updatePreferences({ preferredRegions: event.target.value })}
            placeholder="טוקיו וקיוטו, צפון המדינה, חופים..."
          />
        </PreferenceField>

        <PreferenceField label="Must-visit ו-avoid">
          <div className="grid gap-3">
            <Input
              value={preferences.mustVisitPlaces}
              onChange={(event) => updatePreferences({ mustVisitPlaces: event.target.value })}
              placeholder="מקומות שחייבים להיכנס למסלול"
            />
            <Input
              value={preferences.placesToAvoid}
              onChange={(event) => updatePreferences({ placesToAvoid: event.target.value })}
              placeholder="אזורים או סוגי מקומות שכדאי להימנע מהם"
            />
          </div>
        </PreferenceField>

        <PreferenceField label="העדפות תזונה ונגישות">
          <div className="grid gap-3">
            <Input
              value={preferences.dietaryPreferences}
              onChange={(event) => updatePreferences({ dietaryPreferences: event.target.value })}
              placeholder="צמחוני, ללא גלוטן..."
            />
            <Input
              value={preferences.accessibilityNeeds}
              onChange={(event) => updatePreferences({ accessibilityNeeds: event.target.value })}
              placeholder="מעליות, הליכה קצרה..."
            />
          </div>
        </PreferenceField>

        <PreferenceField label="מגבלות בטיחות / הערות חשובות">
          <Textarea
            value={preferences.safetyConstraints}
            onChange={(event) => updatePreferences({ safetyConstraints: event.target.value })}
            rows={3}
            placeholder="למשל הימנעות מהעברות לילה, הליכה קצרה בלבד, אזורים בטוחים יותר..."
          />
        </PreferenceField>
      </div>
    </details>
  );
}

interface FlightsSectionProps {
  preferences: CountryTripWorkspaceState["preferences"];
  updatePreferences: (patch: Partial<TripPreferences>) => void;
}

function FlightLegFields({
  label,
  leg,
  onChange,
}: {
  label: string;
  leg: TripFlightLeg;
  onChange: (patch: Partial<TripFlightLeg>) => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-3">
      <p className="text-sm font-medium">{label}</p>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label="שדה תעופה יציאה">
          <Input
            value={leg.departureAirport}
            onChange={(event) => onChange({ departureAirport: event.target.value })}
            placeholder="TLV"
          />
        </PreferenceField>
        <PreferenceField label="שדה תעופה נחיתה">
          <Input
            value={leg.arrivalAirport}
            onChange={(event) => onChange({ arrivalAirport: event.target.value })}
            placeholder="TBS"
          />
        </PreferenceField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label="תאריך ושעת המראה">
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={leg.departureDate} onChange={(event) => onChange({ departureDate: event.target.value })} />
            <Input type="time" value={leg.departureTime} onChange={(event) => onChange({ departureTime: event.target.value })} />
          </div>
        </PreferenceField>
        <PreferenceField label="תאריך ושעת נחיתה">
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={leg.arrivalDate} onChange={(event) => onChange({ arrivalDate: event.target.value })} />
            <Input type="time" value={leg.arrivalTime} onChange={(event) => onChange({ arrivalTime: event.target.value })} />
          </div>
        </PreferenceField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <PreferenceField label="חברת תעופה ומספר טיסה (אופציונלי)">
          <div className="grid grid-cols-2 gap-2">
            <Input value={leg.airline} onChange={(event) => onChange({ airline: event.target.value })} placeholder="El Al" />
            <Input
              value={leg.flightNumber}
              onChange={(event) => onChange({ flightNumber: event.target.value })}
              placeholder="LY123"
            />
          </div>
        </PreferenceField>
        <PreferenceField label="עלות ומצב הזמנה">
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              value={leg.cost ?? ""}
              onChange={(event) =>
                onChange({ cost: event.target.value === "" ? null : Number(event.target.value) })
              }
              placeholder="₪"
            />
            <Select
              value={leg.bookingStatus}
              onValueChange={(value) => onChange({ bookingStatus: value as FlightBookingStatus })}
            >
              <SelectTrigger>
                <span>{FLIGHT_BOOKING_STATUS_LABELS[leg.bookingStatus]}</span>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FLIGHT_BOOKING_STATUS_LABELS).map(([value, statusLabel]) => (
                  <SelectItem key={value} value={value}>
                    {statusLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PreferenceField>
      </div>
    </div>
  );
}

/**
 * Israel is the fixed home base for every trip (never per-trip configurable
 * here) — see HOME_COUNTRY_ISO_A2/HOME_TIMEZONE in flight-planning.ts. All
 * datetimes entered are local to their own airport.
 */
export function TripFlightsSection({ preferences, updatePreferences }: FlightsSectionProps) {
  const flights = preferences.flights;
  const hasAnyLeg = flights?.outbound != null || flights?.return != null;

  function patchOutbound(patch: Partial<TripFlightLeg>) {
    const current = flights?.outbound ?? createEmptyFlightLeg();
    updatePreferences({ flights: { outbound: { ...current, ...patch }, return: flights?.return ?? null } });
  }

  function patchReturn(patch: Partial<TripFlightLeg>) {
    const current = flights?.return ?? createEmptyFlightLeg();
    updatePreferences({ flights: { outbound: flights?.outbound ?? null, return: { ...current, ...patch } } });
  }

  return (
    <details className="section-card group space-y-0 p-4 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <span className="font-medium">טיסות</span>
        <span className="text-xs text-muted-foreground">{hasAnyLeg ? "הוזנו פרטי טיסה" : "אופציונלי"}</span>
      </summary>

      <div className="mt-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          הזנת פרטי הטיסה עוזרת ל-AI לתכנן את היום הראשון והאחרון בצורה ריאלית — בלי פעילויות לפני שהגעתם בפועל
          וללא פעילויות אחרי שצריך לצאת לשדה.
        </p>
        <FlightLegFields label="טיסת הלוך" leg={flights?.outbound ?? createEmptyFlightLeg()} onChange={patchOutbound} />
        <FlightLegFields label="טיסת חזור" leg={flights?.return ?? createEmptyFlightLeg()} onChange={patchReturn} />
      </div>
    </details>
  );
}
