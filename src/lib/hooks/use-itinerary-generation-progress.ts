"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  computeWeightedProgress,
  createTokenGuardedReporter,
  GENERATION_STAGE_LABELS,
  GENERATION_STAGE_ORDER,
  type GenerationProgressEvent,
  type GenerationProgressReporter,
  type GenerationStage,
} from "@/lib/server/generation-progress";

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

/**
 * Round 9.3.3 §22 — REAL, server-driven generation progress. This hook no
 * longer owns any timer: it used to advance a fixed stage list once every
 * STAGE_INTERVAL_MS regardless of what the server was actually doing,
 * which is exactly the "reaches 99% in seconds, then sits there for
 * minutes" bug this round fixes. Progress now only ever moves when a real
 * GenerationProgressEvent arrives from the server (via the stream `run`
 * feeds into the reporter passed to it) — see computeWeightedProgress for
 * the pure stage-weighting logic and generation-progress.ts for the real
 * stage vocabulary this is built from.
 */
export function useItineraryGenerationProgress<T>() {
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [seenStages, setSeenStages] = useState<Set<GenerationStage>>(new Set());
  const [lastStage, setLastStage] = useState<GenerationStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const [result, setResult] = useState<T | null>(null);
  // Elapsed-time timer (independent of progress — never converted into a
  // percentage, per §H): generationStartedAt is the single source of truth
  // (Date.now() captured once, synchronously, at the top of start()).
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // §E/K8 — a fresh token per start() call. The reporter closes over the
  // token it was minted with and only ever applies an event if it's still
  // the CURRENT generation's token by the time the event arrives — this is
  // what makes a stale/cross-generation event structurally unable to
  // affect state, not just unlikely to.
  const generationTokenRef = useRef(0);
  const progressRef = useRef(0);

  const start = useCallback(async (run: (signal: AbortSignal, onProgress: GenerationProgressReporter) => Promise<T>) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const token = (generationTokenRef.current += 1);
    const startedAt = Date.now();
    progressRef.current = 0;
    setStatus("submitting");
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setProgress(0);
    setSeenStages(new Set());
    setLastStage(null);
    setGenerationStartedAt(startedAt);
    setFinalElapsedMs(null);

    const onProgress: GenerationProgressReporter = createTokenGuardedReporter(
      generationTokenRef,
      token,
      (event: GenerationProgressEvent) => {
        const next = computeWeightedProgress(event, progressRef.current);
        progressRef.current = next;
        setProgress(next);
        setLastStage(event.stage);
        setSeenStages((current) => (current.has(event.stage) ? current : new Set(current).add(event.stage)));
      }
    );

    try {
      setStatus("generating");
      const value = await run(controller.signal, onProgress);
      if (token !== generationTokenRef.current) return { status: "aborted" } satisfies GenerationRunResult<T>;
      setFinalElapsedMs(Date.now() - startedAt);
      setResult(value);
      setStatus("success");
      return { status: "success", value } satisfies GenerationRunResult<T>;
    } catch (err) {
      if (token !== generationTokenRef.current) return { status: "aborted" } satisfies GenerationRunResult<T>;
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
  }, []);

  const cancel = useCallback(() => {
    // Invalidate this generation's token FIRST — any progress event or
    // resolution that arrives after this point (including one already
    // in flight) is treated as stale and can no longer touch state.
    generationTokenRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    generationTokenRef.current += 1;
    setStatus("idle");
    setError(null);
    setErrorDetails(null);
    setResult(null);
    setProgress(0);
    setSeenStages(new Set());
    setLastStage(null);
    setGenerationStartedAt(null);
    setFinalElapsedMs(null);
  }, []);

  // §F — a stage only becomes ✓ once its own real completion event has
  // actually arrived. The "active"/spinner stage is the next one in the
  // real sequence after the last one confirmed done — genuinely in
  // progress server-side, just not confirmed complete yet — never a stage
  // further ahead than that.
  const visibleStages = GENERATION_STAGE_ORDER.filter((stage) => stage !== "COMPLETE");
  const nextPendingStage = visibleStages.find((stage) => !seenStages.has(stage)) ?? null;
  const stageChecklist: GenerationStageState[] = visibleStages.map((stage) => ({
    key: stage,
    label: GENERATION_STAGE_LABELS[stage],
    state:
      status === "success" || seenStages.has(stage) ? "done" : stage === nextPendingStage ? "active" : "pending",
  }));

  return {
    status,
    progress: status === "success" ? 100 : progress,
    stageLabel: status === "success" ? GENERATION_STAGE_LABELS.COMPLETE : GENERATION_STAGE_LABELS[nextPendingStage ?? lastStage ?? "INITIALIZING"],
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
 * Live elapsed-time display (§H — always shown, never converted into
 * percentage): always recomputed from Date.now() - generationStartedAt
 * (never an incrementing counter, so it can't drift), ticking about once a
 * second while running. Once finalElapsedMs is set (generation finished or
 * failed), that frozen value is returned regardless of ticking.
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
