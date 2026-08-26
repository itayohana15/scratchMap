"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface GenerationStageDefinition {
  key: string;
  label: string;
  checkpoint: number;
}

export type GenerationStatus = "idle" | "pending" | "success" | "error";

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
  const [result, setResult] = useState<T | null>(null);
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
      setStatus("pending");
      setError(null);
      setResult(null);
      setStageIndex(0);

      intervalRef.current = window.setInterval(() => {
        setStageIndex((current) => (current < stages.length - 1 ? current + 1 : current));
      }, STAGE_INTERVAL_MS);

      try {
        const value = await run(controller.signal);
        clearTimer();
        // Never claim 100% before the real request actually resolves (§B4) —
        // hold briefly on the final stage so the transition feels intentional (§B12).
        setStageIndex(stages.length - 1);
        await new Promise((resolve) => window.setTimeout(resolve, FINAL_HOLD_MS));
        setResult(value);
        setStatus("success");
        return value;
      } catch (err) {
        clearTimer();
        if (err instanceof DOMException && err.name === "AbortError") {
          setStatus("idle");
          return null;
        }
        setError(err instanceof Error ? err.message : "בניית המסלול נכשלה");
        setStatus("error");
        return null;
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
    setResult(null);
    setStageIndex(0);
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
    result,
    start,
    cancel,
    reset,
  };
}
