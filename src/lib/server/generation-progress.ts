/**
 * Round 9.3.3 §22 — real, server-driven generation progress. This module
 * owns exactly two things: the stage vocabulary and the pure mapping from
 * "a real stage/sub-progress event just happened" to a UI percentage.
 * Nothing here executes any planner work or duplicates planner state — the
 * planner calls a reporter at points where it has ALREADY done real work;
 * this module only decides what percentage that real work is worth.
 */

export type GenerationStage =
  | "INITIALIZING"
  | "TRIP_FRAME"
  | "STAY_RESOLUTION"
  | "PLACE_DISCOVERY"
  | "POOL_CONSTRUCTION"
  | "PORTFOLIO_CONSTRUCTION"
  | "NIGHT_ALLOCATION"
  | "RESERVE_EVALUATION"
  | "DAY_COMPOSITION"
  | "AI_REFINEMENT"
  | "REPAIR_VALIDATION"
  | "ROUTING"
  | "FINALIZATION"
  | "COMPLETE";

export interface GenerationProgressEvent {
  stage: GenerationStage;
  /** Only ever set when the planner genuinely knows a real completed/total unit count (e.g. stays discovered) — never fabricated from elapsed time. */
  completedUnits?: number;
  totalUnits?: number;
  message: string;
}

export type GenerationProgressReporter = (event: GenerationProgressEvent) => void;

/**
 * §C — one centralized weighted mapping from planner stage to UI
 * percentage. These specific boundaries are a reasonable first cut, not
 * measured from production timing instrumentation (that stage-by-stage
 * timing audit was disclosed as a remaining gap in this same round's
 * generation-pipeline report) — PLACE_DISCOVERY gets the largest single
 * share since it's the one stage confirmed this round to take anywhere
 * from ~1s to 60s+ depending on live Overpass conditions.
 */
export const GENERATION_STAGE_RANGES: Record<GenerationStage, readonly [number, number]> = {
  INITIALIZING: [0, 3],
  TRIP_FRAME: [3, 10],
  STAY_RESOLUTION: [10, 15],
  PLACE_DISCOVERY: [15, 45],
  POOL_CONSTRUCTION: [45, 52],
  PORTFOLIO_CONSTRUCTION: [52, 58],
  NIGHT_ALLOCATION: [58, 63],
  RESERVE_EVALUATION: [63, 67],
  DAY_COMPOSITION: [67, 78],
  AI_REFINEMENT: [78, 86],
  REPAIR_VALIDATION: [86, 92],
  ROUTING: [92, 97],
  FINALIZATION: [97, 99],
  COMPLETE: [100, 100],
};

/**
 * Round 9.3.3 §22 K8/L4 — the one function responsible for making a stale
 * or cross-generation progress event structurally unable to affect state.
 * `currentTokenRef` is a mutable box the caller bumps on every new
 * start()/cancel()/reset(); a reporter built here closes over the token
 * value that was current AT THE MOMENT it was created, so once a newer
 * generation bumps the ref, this reporter permanently stops applying
 * events — it can never "reactivate" for a later, unrelated generation.
 */
export function createTokenGuardedReporter(
  currentTokenRef: { current: number },
  token: number,
  apply: GenerationProgressReporter
): GenerationProgressReporter {
  return (event) => {
    if (token !== currentTokenRef.current) return;
    apply(event);
  };
}

/** The order stages are expected to complete in — used only to assert "99% requires FINALIZATION", never to fabricate intermediate stages that didn't actually report. */
export const GENERATION_STAGE_ORDER: GenerationStage[] = [
  "INITIALIZING",
  "TRIP_FRAME",
  "STAY_RESOLUTION",
  "PLACE_DISCOVERY",
  "POOL_CONSTRUCTION",
  "PORTFOLIO_CONSTRUCTION",
  "NIGHT_ALLOCATION",
  "RESERVE_EVALUATION",
  "DAY_COMPOSITION",
  "AI_REFINEMENT",
  "REPAIR_VALIDATION",
  "ROUTING",
  "FINALIZATION",
  "COMPLETE",
];

/**
 * §C/§E — pure function: given a real progress event and the highest
 * percentage already shown, returns the next percentage to show. Every
 * event the planner emits reports stage-level work that ALREADY finished
 * (never "stage started"), so an event with no unit counts maps to the END
 * of that stage's own range (that stage is now fully done); an event that
 * DOES carry real completedUnits/totalUnits (currently only
 * PLACE_DISCOVERY) is interpolated within the stage's range by that real
 * fraction. §E — never regresses: the result is always
 * max(previousProgress, thisEvent'sRawProgress), so out-of-order or
 * re-delivered events can't move the bar backwards.
 */
export function computeWeightedProgress(event: GenerationProgressEvent, previousProgress: number): number {
  const [start, end] = GENERATION_STAGE_RANGES[event.stage];
  let raw: number;
  if (event.stage === "COMPLETE") {
    raw = 100;
  } else if (event.totalUnits != null && event.totalUnits > 0 && event.completedUnits != null) {
    const fraction = Math.min(1, Math.max(0, event.completedUnits / event.totalUnits));
    raw = start + (end - start) * fraction;
  } else {
    // No real sub-progress known for this tick — the event itself means
    // this stage's work just finished, so it's worth the top of its range.
    raw = end;
  }
  return Math.max(previousProgress, Math.round(raw));
}

/** §F — the real Hebrew label shown per server-reported stage. */
export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  INITIALIZING: "אוספים את נתוני הטיול",
  TRIP_FRAME: "בונים את מבנה המסלול",
  STAY_RESOLUTION: "מאתרים יעדים ואזורי לינה",
  PLACE_DISCOVERY: "מחפשים מקומות ואטרקציות אמיתיים",
  POOL_CONSTRUCTION: "אוספים את המקומות שנמצאו",
  PORTFOLIO_CONSTRUCTION: "בוחרים את המקומות המתאימים ביותר",
  NIGHT_ALLOCATION: "מחלקים את הימים בין היעדים",
  RESERVE_EVALUATION: "בודקים יעדים נוספים אפשריים",
  DAY_COMPOSITION: "בונים את תוכנית הימים",
  AI_REFINEMENT: "מתאימים מסעדות וארוחות",
  REPAIR_VALIDATION: "בודקים את המסלול ומתקנים התנגשויות",
  ROUTING: "מחשבים זמני נסיעה ומעברים",
  FINALIZATION: "עושים בדיקות אחרונות",
  COMPLETE: "המסלול מוכן",
};
