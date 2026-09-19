"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useProfileDerivedTripDefaults } from "@/components/country/trip-preferences-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { findAirportByIata, findDefaultAirportForCountry, HOME_COUNTRY_ISO } from "@/lib/facts/airports-data";
import { useItineraryGenerationProgress } from "@/lib/hooks/use-itinerary-generation-progress";
import {
  useGenerateCountryItinerary,
  type GenerateCountryItineraryResult,
} from "@/lib/queries/country-itineraries";
import type { Tables } from "@/lib/supabase/types";
import {
  type TripFlightLeg,
  type TripPreferences,
} from "@/lib/trip-workspace";

import {
  GenerationProgressPhase,
  isMeaningfullyOverBudget,
  type BudgetWarningAction,
} from "@/components/country/trip-wizard/generation-progress-phase";
import { GenerationSuccessPhase } from "@/components/country/trip-wizard/generation-success-phase";
import { TripWizardStepper, WIZARD_STEP_LABELS } from "@/components/country/trip-wizard/trip-wizard-stepper";
import {
  createEmptyTripCreationDraft,
  isTripCreationDraftEmpty,
  validateDraftForSubmit,
  WIZARD_STEP_COUNT,
  type TripCreationDraft,
  type WizardPhase,
} from "@/components/country/trip-wizard/trip-wizard-types";
import { StepBasics, validateStepBasics } from "@/components/country/trip-wizard/steps/step-basics";
import { StepBookings } from "@/components/country/trip-wizard/steps/step-bookings";
import { StepFlights } from "@/components/country/trip-wizard/steps/step-flights";
import { StepOverrides } from "@/components/country/trip-wizard/steps/step-overrides";
import { StepPlaces } from "@/components/country/trip-wizard/steps/step-places";
import { StepProfile } from "@/components/country/trip-wizard/steps/step-profile";
import { StepRequirements } from "@/components/country/trip-wizard/steps/step-requirements";
import { StepReview } from "@/components/country/trip-wizard/steps/step-review";

interface TripCreationWizardProps {
  iso: string;
  country: Tables<"countries">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGenerated: (itineraryId: string) => void;
}

/**
 * One Dialog root hosting every phase (spec Part C) — wizard steps, then
 * generating/error/budgetWarning, then success — so nothing ever closes and
 * reopens a second dialog. Opening this dialog is purely a state flip from
 * the parent (no fetch, no mutation), which is what actually fixes the
 * multi-click bug (spec E1-E3): there is nothing async between the click
 * and the dialog appearing for a second click to race against.
 */
export function TripCreationWizard({ iso, country, open, onOpenChange, onGenerated }: TripCreationWizardProps) {
  const profileDefaults = useProfileDerivedTripDefaults();
  const [draft, setDraft] = useState<TripCreationDraft>(() =>
    createEmptyTripCreationDraft(country.name, {
      derivedPace: profileDefaults.derivedPace,
      derivedInterests: profileDefaults.derivedInterests,
    })
  );
  const [step, setStep] = useState(1);
  const [furthestStep, setFurthestStep] = useState(1);
  const [phase, setPhase] = useState<WizardPhase>("wizard");
  const [stepError, setStepError] = useState<string | null>(null);

  const submitLockRef = useRef(false);
  const clientRequestIdRef = useRef<string | null>(null);

  // The profile query is async and usually still loading on first mount, so
  // the lazy useState initializer above often seeds tripPace/interests with
  // fallback defaults rather than the real derived values. Sync once when
  // the profile finishes loading, but only if the user hasn't already
  // touched these fields on step 4 in the meantime.
  const hasAppliedProfileDefaultsRef = useRef(false);
  useEffect(() => {
    if (profileDefaults.isLoading || hasAppliedProfileDefaultsRef.current) return;
    hasAppliedProfileDefaultsRef.current = true;
    setDraft((current) =>
      current.preferences.tripPace === "balanced" && !current.preferences.interests
        ? {
            ...current,
            preferences: {
              ...current.preferences,
              tripPace: profileDefaults.derivedPace,
              interests: profileDefaults.derivedInterests,
            },
          }
        : current
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileDefaults.isLoading]);

  /**
   * Outer flight fields (the true first origin / final destination) must
   * always match their fixed hard-coded country role — outbound leaves
   * Israel and lands in the trip country, return does the reverse — no
   * matter which wizard step has actually been visited/mounted. This runs
   * at the wizard root rather than inside step-flights.tsx's FlightLegCard
   * precisely because that component only corrects data while the flights
   * step itself happens to be mounted; step-review.tsx reads leg fields
   * directly with no correction pass of its own, which is how a stale
   * airport (e.g. "יציאה ממדינת היעד: TLV") could otherwise reach the
   * review step untouched.
   */
  useEffect(() => {
    const destinationIso = country.iso_a2;
    if (!destinationIso) return;

    function correctedLeg(
      leg: TripFlightLeg | null,
      expectedOriginIso: string,
      expectedDestinationIso: string
    ): Partial<TripFlightLeg> | null {
      if (!leg) return null;
      const patch: Partial<TripFlightLeg> = {};
      const originAirport = leg.departureAirport ? findAirportByIata(leg.departureAirport) : null;
      if (originAirport && originAirport.countryIso.toUpperCase() !== expectedOriginIso.toUpperCase()) {
        patch.departureAirport = findDefaultAirportForCountry(expectedOriginIso)?.iata ?? "";
      }
      const destinationAirport = leg.arrivalAirport ? findAirportByIata(leg.arrivalAirport) : null;
      if (destinationAirport && destinationAirport.countryIso.toUpperCase() !== expectedDestinationIso.toUpperCase()) {
        patch.arrivalAirport = findDefaultAirportForCountry(expectedDestinationIso)?.iata ?? "";
      }
      return Object.keys(patch).length > 0 ? patch : null;
    }

    setDraft((current) => {
      const flights = current.preferences.flights;
      if (!flights) return current;
      const outboundPatch = correctedLeg(flights.outbound, HOME_COUNTRY_ISO, destinationIso);
      const returnPatch = correctedLeg(flights.return, destinationIso, HOME_COUNTRY_ISO);
      if (!outboundPatch && !returnPatch) return current;
      return {
        ...current,
        preferences: {
          ...current.preferences,
          flights: {
            outbound: outboundPatch && flights.outbound ? { ...flights.outbound, ...outboundPatch } : flights.outbound,
            return: returnPatch && flights.return ? { ...flights.return, ...returnPatch } : flights.return,
          },
        },
      };
    });
  }, [country.iso_a2, draft.preferences.flights]);

  const generationProgress = useItineraryGenerationProgress<GenerateCountryItineraryResult>();
  const generateItinerary = useGenerateCountryItinerary(iso);

  function updatePreferences(patch: Partial<TripPreferences>) {
    setDraft((current) => ({ ...current, preferences: { ...current.preferences, ...patch } }));
  }

  function updateDraft(patch: Partial<TripCreationDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function resetWizard() {
    setDraft(
      createEmptyTripCreationDraft(country.name, {
        derivedPace: profileDefaults.derivedPace,
        derivedInterests: profileDefaults.derivedInterests,
      })
    );
    setStep(1);
    setFurthestStep(1);
    setPhase("wizard");
    setStepError(null);
    submitLockRef.current = false;
    clientRequestIdRef.current = null;
    generationProgress.reset();
  }

  function goToStep(nextStep: number) {
    if (nextStep > furthestStep) return;
    setStepError(null);
    setStep(nextStep);
  }

  function handleNext() {
    if (step === 1) {
      const error = validateStepBasics(draft);
      if (error) {
        setStepError(error);
        return;
      }
    }
    setStepError(null);
    const next = Math.min(step + 1, WIZARD_STEP_COUNT);
    setStep(next);
    setFurthestStep((current) => Math.max(current, next));
  }

  function handlePrevious() {
    setStepError(null);
    setStep((current) => Math.max(1, current - 1));
  }

  async function runGeneration() {
    // Round 9.2 §1/§14 — the client no longer pre-fetches ~13 country-wide
    // recommendation categories before submitting. That pool was never
    // stay-scoped (it had no idea which cities the trip actually visits or
    // how many days each stay needs) and Round 9.2 makes the server's own
    // stay-scoped StayActivityPool/Portfolio discovery
    // (buildTripFrame → refillTripRecommendationPool, inside
    // generateCountryItineraryPlan) the ONLY authoritative candidate
    // source for planning. `recommendations` is submitted empty; the
    // server discovers and classifies real candidates itself, per stay.
    // (The country page's own browsing view may still call the country-wide
    // endpoint directly — that's unrelated to generation and untouched.)
    // `overpassAvailable` is likewise omitted — resolveCandidateProviderStatus
    // on the server now derives it from the server's own post-discovery
    // candidate pool, which is the honest signal for what planning actually
    // used, rather than a client-side fetch it never used.
    try {
      const result = await generationProgress.start(async (signal, onProgress) => {
        return generateItinerary.mutateAsync({
          countryId: country.id,
          countryName: country.name,
          isoA2: iso.toUpperCase(),
          tripStatus: "planning",
          preferences: draft.preferences,
          selectedPlaces: [],
          recommendations: [],
          bookings: draft.bookings,
          existingDays: [],
          clientRequestId: clientRequestIdRef.current!,
          userProvidedTitle: draft.userProvidedTitle,
          signal,
          onProgress,
        });
      });

      if (result.status === "aborted") return;
      if (result.status === "error") {
        setPhase("error");
        submitLockRef.current = false;
        return;
      }

      if (isMeaningfullyOverBudget(result.value.itinerary.costSummary.totalEstimatedCost, draft.preferences.budget)) {
        setPhase("budgetWarning");
      } else {
        setPhase("success");
      }
    } catch {
      setPhase("error");
      // Only the recoverable-failure path unlocks — a successful submission
      // must never be retriggerable by a stray extra click (spec E4).
      submitLockRef.current = false;
    }
  }

  function handleSubmit() {
    if (submitLockRef.current) return; // synchronous, before anything else (spec E4/E5)
    const error = validateDraftForSubmit(draft);
    if (error) {
      setStepError(error);
      return;
    }
    submitLockRef.current = true;
    clientRequestIdRef.current ??= crypto.randomUUID();
    setPhase("generating");
    void runGeneration();
  }

  function handleRetry() {
    submitLockRef.current = false;
    handleSubmit();
  }

  function handleBudgetAction(action: BudgetWarningAction) {
    if (action === "editAgain") {
      setPhase("wizard");
      setStep(WIZARD_STEP_COUNT);
      submitLockRef.current = false;
      return;
    }
    if (action === "increaseBudget") {
      setPhase("wizard");
      setStep(1);
      submitLockRef.current = false;
      toast.info("אפשר לעדכן את התקציב ולנסות שוב.");
      return;
    }
    if (action === "shorten") {
      setPhase("wizard");
      setStep(1);
      submitLockRef.current = false;
      toast.info("אפשר לקצר את תאריכי הטיול ולנסות שוב.");
      return;
    }
    // "cheaper" — regenerate as-is; there's no separate cheap mode to switch to pre-generation.
    handleRetry();
  }

  function handleOpenChange(next: boolean) {
    if (next) return;
    if (phase === "generating") return; // no accidental close mid-generation (spec Part L)
    if (phase === "wizard" && !isTripCreationDraftEmpty(draft)) {
      if (!window.confirm("לצאת בלי לשמור את פרטי הטיול?")) return;
    }
    onOpenChange(false);
    resetWizard();
  }

  function handleSuccessOpen(itineraryId: string) {
    onOpenChange(false);
    onGenerated(itineraryId);
    resetWizard();
  }

  const generationView =
    phase === "generating" ? "pending" : phase === "error" ? "error" : phase === "budgetWarning" ? "budgetWarning" : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={phase !== "generating"}
        className={
          phase === "success"
            ? "max-h-[92vh] max-w-[calc(100%-1rem)] overflow-hidden p-0 sm:max-w-4xl"
            : "max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        }
      >
        {phase === "success" && generationProgress.result ? (
          <GenerationSuccessPhase
            success={generationProgress.result.success}
            finalElapsedMs={generationProgress.finalElapsedMs}
            onOpenItinerary={handleSuccessOpen}
            onClose={() => handleOpenChange(false)}
          />
        ) : generationView ? (
          <GenerationProgressPhase
            view={generationView}
            isoA2={iso}
            countryName={country.name}
            progress={generationProgress.progress}
            stageLabel={generationProgress.stageLabel}
            stageChecklist={generationProgress.stageChecklist}
            error={generationProgress.error}
            errorDetails={generationProgress.errorDetails}
            budgetTarget={draft.preferences.budget}
            generationStartedAt={generationProgress.generationStartedAt}
            finalElapsedMs={generationProgress.finalElapsedMs}
            onCancel={() => {
              generationProgress.cancel();
              submitLockRef.current = false;
            }}
            onRetry={handleRetry}
            onClose={() => {
              setPhase("wizard");
              setStep(WIZARD_STEP_COUNT);
            }}
            onBudgetAction={handleBudgetAction}
          />
        ) : (
          <div className="flex flex-col gap-4 p-1">
            <DialogHeader className="space-y-1">
              <p className="text-sm text-muted-foreground">
                {country.name} · יצירת טיול חדש
              </p>
              <DialogTitle className="text-xl">{WIZARD_STEP_LABELS[step - 1]}</DialogTitle>
            </DialogHeader>

            <TripWizardStepper currentStep={step} furthestStep={furthestStep} onStepClick={goToStep} />

            <div className="min-h-[280px]">
              {step === 1 ? <StepBasics draft={draft} updatePreferences={updatePreferences} updateDraft={updateDraft} /> : null}
              {step === 2 ? (
                <StepFlights draft={draft} destinationIsoA2={country.iso_a2} updatePreferences={updatePreferences} />
              ) : null}
              {step === 3 ? (
                <StepProfile isLoading={profileDefaults.isLoading} summaryLines={profileDefaults.summaryLines} />
              ) : null}
              {step === 4 ? (
                <StepOverrides
                  draft={draft}
                  updatePreferences={updatePreferences}
                  derivedPace={profileDefaults.derivedPace}
                  derivedInterests={profileDefaults.derivedInterests}
                />
              ) : null}
              {step === 5 ? <StepRequirements draft={draft} updatePreferences={updatePreferences} /> : null}
              {step === 6 ? <StepPlaces draft={draft} updatePreferences={updatePreferences} /> : null}
              {step === 7 ? <StepBookings draft={draft} updateDraft={updateDraft} /> : null}
              {step === 8 ? (
                <StepReview
                  draft={draft}
                  countryName={country.name}
                  derivedPace={profileDefaults.derivedPace}
                  derivedInterests={profileDefaults.derivedInterests}
                />
              ) : null}
            </div>

            {stepError ? <p className="text-sm text-destructive">{stepError}</p> : null}

            <div className="sticky bottom-0 flex items-center justify-between border-t border-border/70 bg-background pt-3">
              <Button type="button" variant="outline" disabled={step === 1} onClick={handlePrevious}>
                הקודם
              </Button>
              {step === WIZARD_STEP_COUNT ? (
                <Button type="button" onClick={handleSubmit}>
                  צור את המסלול
                </Button>
              ) : (
                <Button type="button" onClick={handleNext}>
                  הבא
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
