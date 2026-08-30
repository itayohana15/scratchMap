/**
 * Distance-based transport-mode selection (spec items 9-10) — a hop's
 * transport mode should follow from how far it actually is, not be
 * inherited unquestioned from whatever string an AI response happened to
 * set. Kept as a plain shared module (no server-only dependency) so it's
 * usable from both generation-time repair logic and, later, client-side
 * UI. Speeds are the same distance-based-estimate philosophy already used
 * everywhere else in this app (no paid routing API) — see
 * flight-planning.ts's estimateFlightDurationMinutesByDistance and
 * airports-data.ts's curated dataset for the same pattern.
 */
export type TransportMode = "walking" | "transit" | "car" | "taxi" | "train" | "bus";

const WALKING_MAX_KM = 1.5;
const TRANSIT_MAX_KM = 5;
const INTERCITY_CAR_MAX_KM = 50;

/** Realistic average speed for each mode, km/h — used both to pick a mode's travel time and to sanity-check an already-stated one. */
export const TRANSPORT_MODE_SPEED_KMH: Record<TransportMode, number> = {
  walking: 4,
  transit: 22,
  taxi: 30,
  bus: 45,
  car: 60,
  train: 90,
};

/**
 * Picks the mode a sensible traveler would actually use for a given
 * distance (spec thresholds: <1.5km walk; 1.5–5km compare transit/taxi;
 * beyond that, an appropriate intercity mode). `hasLuggage` nudges toward
 * a taxi/car over transit/bus at the same distance (spec item 10 — carrying
 * bags changes the realistic choice); `isIntercity` skips straight to the
 * intercity tier even for a short distance (e.g. a short hop between two
 * towns with no local transit network).
 */
export function selectTransportMode(
  distanceKm: number,
  context: { hasLuggage?: boolean; isIntercity?: boolean } = {}
): TransportMode {
  if (distanceKm <= 0) return "walking";

  if (!context.isIntercity) {
    if (distanceKm < WALKING_MAX_KM) return "walking";
    if (distanceKm <= TRANSIT_MAX_KM) return context.hasLuggage ? "taxi" : "transit";
  }

  return distanceKm <= INTERCITY_CAR_MAX_KM ? (context.hasLuggage ? "car" : "bus") : "train";
}

export function estimateMinutesForMode(distanceKm: number, mode: TransportMode): number {
  if (distanceKm <= 0) return 0;
  return Math.round((distanceKm / TRANSPORT_MODE_SPEED_KMH[mode]) * 60);
}

/**
 * Resolves a mode the same way trip-workspace.ts's estimateTravelMinutes
 * keyword-matches an item's own transportation label (הליכה/רכב), falling
 * back to selectTransportMode by real distance only when the label says
 * neither — used solely to sanity-check an already-stated travel time
 * below, never to change estimateTravelMinutes's own established numeric
 * behavior (that function's default bucket is left untouched).
 */
export function resolveTransportModeFromLabel(transportation: string, distanceKm: number): TransportMode {
  if (transportation.includes("הליכה")) return "walking";
  if (transportation.includes("רכב")) return "car";
  return selectTransportMode(distanceKm);
}

/**
 * True when the mode actually assigned to this hop couldn't realistically
 * cover the real distance in the stated time (spec test 83 — "do not
 * display ~20 minutes if [the] selected mode cannot achieve it"). A
 * generous 60% floor (not the full estimate) avoids flagging ordinary
 * estimation noise — this is an implausibility check, not a precise
 * re-estimate.
 */
export function isImplausiblyFastTravelTime(distanceKm: number, statedMinutes: number, mode: TransportMode): boolean {
  if (distanceKm <= 0 || statedMinutes < 0) return false;
  const plausibleMinimum = estimateMinutesForMode(distanceKm, mode) * 0.6;
  return statedMinutes < plausibleMinimum;
}
