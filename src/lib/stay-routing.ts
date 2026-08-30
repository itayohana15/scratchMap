// Section C/E/F/G — hotel-coordinate-driven route recalculation for an
// already-generated, persisted itinerary. This is the POST-generation
// counterpart to itinerary-planning-principles.ts's StayTransition model
// (which only exists at generation time, over AiGeneratedDay/TripFrame):
// once a real trip exists, a user selecting/changing a hotel must be able
// to update the same kind of real, computed travel numbers without
// regenerating anything. Pure, client-safe (no Overpass/Supabase import),
// reusing the exact same primitives (haversineKm, selectTransportMode,
// estimateMinutesForMode, detectAirportBaseMismatch,
// evaluateFinalBaseDepartureFeasibility) rather than a second routing
// system.
import { findAirportByIata } from "@/lib/facts/airports-data";
import {
  detectAirportBaseMismatch,
  evaluateFinalBaseDepartureFeasibility,
} from "@/lib/flight-planning";
import { estimateMinutesForMode, selectTransportMode } from "@/lib/transport-mode";
import { haversineKm } from "@/lib/trip-workspace";

export interface StayCoordinates {
  lat: number;
  lon: number;
}

/**
 * Section C1 — one consistent coordinate hierarchy for "where is this stay,
 * really": a real selected hotel always wins when present; otherwise the
 * trip's own planned activity centroid for that stay; otherwise a generic
 * area centroid (e.g. from generation-time TripFrame data). Reused
 * everywhere a stay's anchor point is needed so hotel selection and
 * generation-time planning never silently disagree on which point is
 * authoritative.
 */
export function resolveStayAnchorCoordinates(candidates: {
  hotelCoordinates?: StayCoordinates | null;
  activityCentroid?: StayCoordinates | null;
  areaCentroid?: StayCoordinates | null;
}): StayCoordinates | null {
  return candidates.hotelCoordinates ?? candidates.activityCentroid ?? candidates.areaCentroid ?? null;
}

// A same-day base-to-base transfer beyond this is a genuine structural
// problem, not a quality nuance — a real time budget (matching how every
// other hard-feasibility check in this app works), never an arbitrary
// distance rule (spec §D: "distance alone is not physical impossibility").
const MAX_REASONABLE_TRANSITION_MINUTES = 600;

function estimateTransitionMinutes(from: StayCoordinates | null, to: StayCoordinates | null): number | null {
  if (!from || !to) return null;
  const distanceKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
  const mode = selectTransportMode(distanceKm, { hasLuggage: true, isIntercity: true });
  return estimateMinutesForMode(distanceKm, mode);
}

/** Always returns the real ground-transfer estimate, regardless of whether it's large enough to count as a mismatch — detectAirportBaseMismatch/evaluateFinalBaseDepartureFeasibility only return non-null when there IS a conflict, but the caller needs the real number either way. */
function computeGroundMinutesToAirport(airportIata: string, coords: StayCoordinates): number | null {
  const airport = findAirportByIata(airportIata);
  if (!airport) return null;
  const distanceKm = haversineKm(airport.lat, airport.lon, coords.lat, coords.lon);
  return estimateMinutesForMode(distanceKm, selectTransportMode(distanceKm, { hasLuggage: true, isIntercity: true }));
}

/** Section H — a hotel choice creating (or clearing) a transfer that's too long to be a normal base-to-base transition, distinct from the generation-time impossibleStayTransitions diagnostic (this one is caused specifically by a post-generation hotel change). */
export interface HotelCausedTransitionConflict {
  direction: "inbound" | "outbound";
  estimatedMinutes: number;
}

/** Section H — a hard feasibility conflict (spec §D), never a mere distance quality note: the selected hotel makes a real arrival/departure genuinely difficult given the real ground time and (for departure) the real flight time. */
export interface HotelCausedAirportConflict {
  direction: "arrival" | "departure";
  estimatedGroundMinutes: number;
  assumedGroundMinutes: number;
}

export interface StayRoutingResult {
  inboundTransitionMinutes: number | null;
  outboundTransitionMinutes: number | null;
  arrivalTransferMinutes: number | null;
  departureTransferMinutes: number | null;
  hotelCausedTransitionConflict: HotelCausedTransitionConflict | null;
  hotelCausedAirportConflict: HotelCausedAirportConflict | null;
}

/**
 * Section C2-C7/E/F — recomputes exactly the numbers a hotel choice can
 * change for ONE stay: its inbound/outbound transitions (only when it's
 * not the first/last stay respectively) and its airport transfer (only
 * when it IS the first/last stay). Never touches anything about stays
 * that aren't adjacent to this one (spec §C6) — the caller decides what to
 * do with the result (store it, patch affected days, etc.), this function
 * has no side effects and no knowledge of the day/itinerary shape.
 */
export function recalculateStayRouting(args: {
  stayAnchor: StayCoordinates | null;
  previousStayAnchor?: StayCoordinates | null;
  nextStayAnchor?: StayCoordinates | null;
  isFirstStay: boolean;
  isFinalStay: boolean;
  arrivalAirportIata?: string | null;
  departureAirportIata?: string | null;
  /** Local time at the departure airport, "HH:MM" — enables the real time-budget feasibility check (spec §D); when absent, falls back to the distance-only detectAirportBaseMismatch check for departure too. */
  departureTime?: string | null;
}): StayRoutingResult {
  const inboundTransitionMinutes = args.isFirstStay
    ? null
    : estimateTransitionMinutes(args.previousStayAnchor ?? null, args.stayAnchor);
  const outboundTransitionMinutes = args.isFinalStay
    ? null
    : estimateTransitionMinutes(args.stayAnchor, args.nextStayAnchor ?? null);

  let hotelCausedTransitionConflict: HotelCausedTransitionConflict | null = null;
  if (inboundTransitionMinutes != null && inboundTransitionMinutes > MAX_REASONABLE_TRANSITION_MINUTES) {
    hotelCausedTransitionConflict = { direction: "inbound", estimatedMinutes: inboundTransitionMinutes };
  } else if (outboundTransitionMinutes != null && outboundTransitionMinutes > MAX_REASONABLE_TRANSITION_MINUTES) {
    hotelCausedTransitionConflict = { direction: "outbound", estimatedMinutes: outboundTransitionMinutes };
  }

  let arrivalTransferMinutes: number | null = null;
  let departureTransferMinutes: number | null = null;
  let hotelCausedAirportConflict: HotelCausedAirportConflict | null = null;

  if (args.isFirstStay && args.arrivalAirportIata && args.stayAnchor) {
    arrivalTransferMinutes = computeGroundMinutesToAirport(args.arrivalAirportIata, args.stayAnchor);
    const mismatch = detectAirportBaseMismatch("arrival", args.arrivalAirportIata, [args.stayAnchor]);
    if (mismatch) {
      hotelCausedAirportConflict = {
        direction: "arrival",
        estimatedGroundMinutes: mismatch.estimatedGroundMinutes,
        assumedGroundMinutes: mismatch.assumedGroundMinutes,
      };
    }
  }

  if (args.isFinalStay && args.departureAirportIata && args.stayAnchor) {
    departureTransferMinutes = computeGroundMinutesToAirport(args.departureAirportIata, args.stayAnchor);
    if (args.departureTime) {
      const feasibility = evaluateFinalBaseDepartureFeasibility(args.departureAirportIata, args.departureTime, args.stayAnchor);
      if (feasibility && !feasibility.feasible) {
        hotelCausedAirportConflict = {
          direction: "departure",
          estimatedGroundMinutes: feasibility.estimatedGroundMinutes,
          assumedGroundMinutes: 45,
        };
      }
    } else {
      const mismatch = detectAirportBaseMismatch("departure", args.departureAirportIata, [args.stayAnchor]);
      if (mismatch) {
        hotelCausedAirportConflict = {
          direction: "departure",
          estimatedGroundMinutes: mismatch.estimatedGroundMinutes,
          assumedGroundMinutes: mismatch.assumedGroundMinutes,
        };
      }
    }
  }

  return {
    inboundTransitionMinutes,
    outboundTransitionMinutes,
    arrivalTransferMinutes,
    departureTransferMinutes,
    hotelCausedTransitionConflict,
    hotelCausedAirportConflict,
  };
}
