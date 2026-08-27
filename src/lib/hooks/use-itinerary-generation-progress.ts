"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface GenerationStageDefinition {
  key: string;
  label: string;
  checkpoint: number;
}

export type GenerationStatus = "idle" | "submitting" | "generating" | "success" | "error";

export type GenerationRunResult<T> =
  | { status: "success"; value: T }
  | { status: "error" }
  | { status: "aborted" };

export interface GenerationStageState {
  key: string;
  label: string;
  state: "done" | "active" | "pending";
}

const STAGE_INTERVAL_MS = 1300;
const FINAL_HOLD_MS = 500;
const MAX_PENDING_PROGRESS = 99;

/**
 * No real backend progress events exist for itinerary generation (a single
 * POST/response) — this is honest stage-based simulated progress (never a
 * fabricated exact backend percentage), country-name-templated for §B19.
 */
export function buildGenerationStages(countryName: string): GenerationStageDefinition[] {
  return [
    { key: "collecting", label: "אוספים את נתוני הטיול", checkpoint: 5 },
    { key: "preferences", label: "טוענים את ההעדפות שלך", checkpoint: 15 },
    { key: "attractions", label: `מחפשים אטרקציות ומקומות מתאימים ב${countryName}`, checkpoint: 30 },
    { key: "geography", label: "מקבצים מקומות לפי אזורים ומרחקים", checkpoint: 45 },
    { key: "days", label: "בונים סדר ימים יעיל", checkpoint: 60 },
    { key: "restaurants", label: "מוסיפים מסעדות ואוכל קרוב למסלול", checkpoint: 70 },
    { key: "routing", label: "מחשבים זמני נסיעה", checkpoint: 78 },
    { key: "budget", label: "בודקים התאמה לתקציב", checkpoint: 86 },
    { key: "optimize", label: "מייעלים את המסלול", checkpoint: 94 },
    { key: "final", label: "עושים בדיקות אחרונות", checkpoint: 99 },
  ];
}

/**
 * Owns all generation-progress state in one hook, called once from a stable
 * parent (§B15 — progress must never reset on unrelated re-renders).
 */
export function useItineraryGenerationProgress<T>(stages: GenerationStageDefinition[]) {
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [stageIndex, setStageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const [result, setResult] = useState<T | null>(null);
  // Elapsed-time timer (spec items 19-25): generationStartedAt is the single
  // source of truth (Date.now() captured once, synchronously, at the top of
  // start() — never an incrementing counter, so re-renders/stage changes
  // can't drift it). finalElapsedMs freezes the exact duration the instant
  // status leaves "pending", independent of when the UI happens to re-render.
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const start = useCallback(
    async (run: (signal: AbortSignal) => Promise<T>) => {
      clearTimer();
      const controller = new AbortController();
      controllerRef.current = controller;
      const startedAt = Date.now();
      setStatus("submitting");
      setError(null);
      setErrorDetails(null);
      setResult(null);
      setStageIndex(0);
      setGenerationStartedAt(startedAt);
      setFinalElapsedMs(null);

      intervalRef.current = window.setInterval(() => {
        setStageIndex((current) => (current < stages.length - 1 ? current + 1 : current));
      }, STAGE_INTERVAL_MS);

      try {
        setStatus("generating");
        const value = await run(controller.signal);
        clearTimer();
        // Never claim 100% before the real request actually resolves (§B4) —
        // hold briefly on the final stage so the transition feels intentional (§B12).
        setStageIndex(stages.length - 1);
        await new Promise((resolve) => window.setTimeout(resolve, FINAL_HOLD_MS));
        setFinalElapsedMs(Date.now() - startedAt);
        setResult(value);
        setStatus("success");
        return { status: "success", value } satisfies GenerationRunResult<T>;
      } catch (err) {
        clearTimer();
        if (err instanceof DOMException && err.name === "AbortError") {
          setStatus("idle");
          setGenerationStartedAt(null);
          return { status: "aborted" } satisfies GenerationRunResult<T>;
        }
        setFinalElapsedMs(Date.now() - startedAt);
        setError(err instanceof Error ? err.message : "בניית המסלול נכשלה");
        setErrorDetails(
          typeof err === "object" && err !== null && "body" in err
            ? (err as { body: unknown }).body
            : { message: err instanceof Error ? err.message : String(err) }
        );
        setStatus("error");
        return { status: "error" } satisfies GenerationRunResult<T>;
      }
    },
    [clearTimer, stages.length]
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    setStatus("idle");
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setStageIndex(0);
    setGenerationStartedAt(null);
    setFinalElapsedMs(null);
  }, [clearTimer]);

  const currentStage = stages[stageIndex] ?? stages[0];
  const progress =
    status === "success" ? 100 : Math.min(currentStage?.checkpoint ?? 0, MAX_PENDING_PROGRESS);

  const stageChecklist: GenerationStageState[] = stages.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    state:
      status === "success" || index < stageIndex ? "done" : index === stageIndex ? "active" : "pending",
  }));

  return {
    status,
    progress,
    stageLabel: currentStage?.label ?? "",
    stageChecklist,
    error,
    errorDetails,
    result,
    generationStartedAt,
    finalElapsedMs,
    start,
    cancel,
    reset,
  };
}

/**
 * Live elapsed-time display (spec items 19-25): always recomputed from
 * Date.now() - generationStartedAt (never an incrementing counter, so it
 * can't drift), ticking about once a second while running. Once
 * finalElapsedMs is set (generation finished or failed), that frozen value
 * is returned regardless of ticking — the displayed duration stops moving.
 */
export function useElapsedDisplayMs(
  generationStartedAt: number | null,
  finalElapsedMs: number | null,
  isRunning: boolean
): number {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!isRunning || generationStartedAt == null || finalElapsedMs != null) return;
    const intervalId = window.setInterval(() => forceTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRunning, generationStartedAt, finalElapsedMs]);

  if (finalElapsedMs != null) return finalElapsedMs;
  if (generationStartedAt == null) return 0;
  return Date.now() - generationStartedAt;
}
