"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export const WIZARD_STEP_LABELS = [
  "פרטים",
  "טיסות",
  "העדפות",
  "התאמות",
  "דרישות",
  "מקומות",
  "הזמנות",
  "סיכום",
] as const;

interface TripWizardStepperProps {
  currentStep: number;
  furthestStep: number;
  onStepClick: (step: number) => void;
}

/** Compact progress bar/stepper (Part J) — not 8 separate tabs. */
export function TripWizardStepper({ currentStep, furthestStep, onStepClick }: TripWizardStepperProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        {WIZARD_STEP_LABELS.map((_, index) => {
          const step = index + 1;
          const isDone = step < currentStep;
          const isCurrent = step === currentStep;
          return (
            <div
              key={step}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                isDone || isCurrent ? "bg-primary" : "bg-muted"
              )}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          שלב {currentStep} מתוך {WIZARD_STEP_LABELS.length}
        </span>
        <span className="flex items-center gap-1 font-medium text-foreground">
          {currentStep < furthestStep ? (
            <Check className="size-3.5 text-primary" />
          ) : null}
          {WIZARD_STEP_LABELS[currentStep - 1]}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {WIZARD_STEP_LABELS.map((label, index) => {
          const step = index + 1;
          const isReachable = step <= furthestStep;
          return (
            <button
              key={label}
              type="button"
              disabled={!isReachable}
              onClick={() => onStepClick(step)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                step === currentStep
                  ? "bg-primary text-primary-foreground"
                  : isReachable
                    ? "bg-muted text-foreground hover:bg-muted/70"
                    : "cursor-not-allowed bg-muted/40 text-muted-foreground/60"
              )}
            >
              {step}. {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
