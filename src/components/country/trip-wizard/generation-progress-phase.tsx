"use client";

import Image from "next/image";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useElapsedDisplayMs, type GenerationStageState } from "@/lib/hooks/use-itinerary-generation-progress";
import { getCountrySuccessIllustration } from "@/lib/country-success-illustrations";
import { formatCurrency, formatElapsedDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized;
  const value = Number.parseInt(full, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export type BudgetWarningAction = "cheaper" | "increaseBudget" | "shorten" | "editAgain";

/** A generated itinerary counts as "over budget" only with a meaningful margin — never a hair over. */
export function isMeaningfullyOverBudget(actualCost: number | null, budget: number | null): boolean {
  if (!budget || budget <= 0 || actualCost == null) return false;
  return actualCost > budget * 1.1;
}

interface GenerationProgressPhaseProps {
  view: "pending" | "success" | "budgetWarning" | "error";
  isoA2: string;
  countryName: string;
  progress: number;
  stageLabel: string;
  stageChecklist: GenerationStageState[];
  error: string | null;
  errorDetails: unknown;
  budgetTarget: number | null;
  generationStartedAt: number | null;
  finalElapsedMs: number | null;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
  onBudgetAction: (action: BudgetWarningAction) => void;
}

/**
 * Content only — no own Dialog — extracted from the old
 * AiGenerationProgressModal so the wizard's single Dialog can host the
 * generating/error/budgetWarning phases without closing/reopening a second
 * dialog (spec Part C/D). The "success" view is intentionally not handled
 * here — GenerationSuccessPhase owns that richer layout.
 */
export function GenerationProgressPhase({
  view,
  isoA2,
  countryName,
  progress,
  stageLabel,
  stageChecklist,
  error,
  errorDetails,
  budgetTarget,
  generationStartedAt,
  finalElapsedMs,
  onCancel,
  onRetry,
  onClose,
  onBudgetAction,
}: GenerationProgressPhaseProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const illustration = useMemo(() => getCountrySuccessIllustration(isoA2, countryName), [isoA2, countryName]);
  const isPending = view === "pending";
  const elapsedMs = useElapsedDisplayMs(generationStartedAt, finalElapsedMs, isPending);

  useEffect(() => {
    if (!isPending) setConfirmingCancel(false);
  }, [isPending]);

  return (
    <div
      className="relative p-5 sm:p-6"
      style={{
        backgroundImage: `linear-gradient(160deg, ${hexToRgba(illustration.accentColor ?? "#5c7c67", 0.16)}, transparent 55%)`,
      }}
    >
      <Image
        src={illustration.flagPath}
        alt=""
        width={44}
        height={44}
        className="pointer-events-none absolute top-5 left-5 size-11 rounded-full border border-border/60 object-cover opacity-80 sm:top-6 sm:left-6"
        unoptimized
      />

      <DialogHeader className="max-w-[85%] space-y-1.5">
        <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">{countryName}</p>
        <DialogTitle className="text-xl sm:text-2xl">
          {view === "error"
            ? "לא הצלחנו ליצור את המסלול"
            : view === "budgetWarning"
              ? "המסלול חורג מהתקציב"
              : "יוצרים את המסלול שלך"}
        </DialogTitle>
        <DialogDescription className="whitespace-pre-line text-sm leading-6">
          {view === "error"
            ? "אירעה שגיאה בזמן יצירת המסלול.\nהמידע שמילאת נשמר ואפשר לנסות שוב."
            : view === "budgetWarning"
              ? `לא הצלחנו לבנות מסלול מלא במסגרת התקציב${budgetTarget ? ` של ${formatCurrency(budgetTarget)}` : ""}.`
              : "אנחנו בונים מסלול שמתאים להעדפות, לתקציב, למיקום ולתאריכים שלך."}
        </DialogDescription>
      </DialogHeader>

      {isPending ? (
        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <div className="flex items-end justify-between">
              <span className="text-4xl font-bold tabular-nums text-foreground sm:text-5xl">{progress}%</span>
              <span className="max-w-[55%] text-right text-sm text-muted-foreground">{stageLabel}</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={stageLabel}
              className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            {/* Elapsed time only — never framed as an ETA/remaining estimate (spec items 20-21). */}
            <div className="text-right tabular-nums text-muted-foreground">
              <p className="text-[11px]">זמן שעבר</p>
              <p className="text-sm font-semibold text-foreground">{formatElapsedDuration(elapsedMs)}</p>
            </div>
          </div>

          <div aria-live="polite" className="sr-only">
            {stageLabel}
          </div>

          <ul className="space-y-1.5">
            {stageChecklist.map((stage) => (
              <li
                key={stage.key}
                className={cn(
                  "flex items-center gap-2 text-xs",
                  stage.state === "active" ? "text-foreground font-medium" : "text-muted-foreground"
                )}
              >
                {stage.state === "done" ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
                ) : stage.state === "active" ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <CircleDashed className="size-3.5 shrink-0 opacity-50" />
                )}
                <span className="truncate">{stage.label}</span>
              </li>
            ))}
          </ul>

          {confirmingCancel ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/30 p-3">
              <p className="text-sm text-foreground">המסלול עדיין נוצר. לבטל את היצירה?</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={onCancel}>
                  כן, בטל
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmingCancel(false)}>
                  לא, המשך
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => setConfirmingCancel(true)}
            >
              <X className="size-3.5" />
              ביטול יצירה
            </Button>
          )}
        </div>
      ) : null}

      {view === "error" ? (
        <div className="mt-6 space-y-3">
          {finalElapsedMs != null ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              היצירה נכשלה לאחר: {formatElapsedDuration(finalElapsedMs)}
            </p>
          ) : null}
          {process.env.NODE_ENV !== "production" && errorDetails ? (
            <details className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium [&::-webkit-details-marker]:hidden">פרטי שגיאה</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-left text-xs text-muted-foreground" dir="ltr">
                {JSON.stringify(errorDetails, null, 2)}
              </pre>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRetry}>נסה שוב</Button>
            <Button variant="outline" onClick={onClose}>
              חזרה לעריכה
            </Button>
          </div>
        </div>
      ) : null}

      {view === "budgetWarning" ? (
        <div className="mt-6 space-y-3">
          <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3.5" />
            חריגה מהתקציב
          </Badge>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" onClick={() => onBudgetAction("cheaper")}>
              נסה מסלול חסכוני יותר
            </Button>
            <Button variant="outline" onClick={() => onBudgetAction("increaseBudget")}>
              הגדל תקציב
            </Button>
            <Button variant="outline" onClick={() => onBudgetAction("shorten")}>
              קצר את הטיול
            </Button>
            <Button variant="outline" onClick={() => onBudgetAction("editAgain")}>
              חזור לעריכה
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
