// Small, pure UI-decision helpers for the hotel selection flow — kept in
// their own client-safe module (type-only import of RankedHotel, no
// runtime import) so client components never pull in src/lib/hotels.ts's
// server-only Overpass dependency just to use this logic.
import type { RankedHotel } from "@/lib/hotels";
import { buildMapLink, detectHotelBaseMismatch, type TripItineraryDay } from "@/lib/trip-workspace";

/**
 * Whether a real hotel was explicitly chosen for this day, vs. still
 * holding a generic AI-written placeholder — the existing
 * accommodationLat/Lon fields already double as this signal (a real
 * selection always sets real coordinates), so no new field is needed.
 * Drives the "בחירת מלון" vs. "החלפת מלון" primary-action label.
 */
export function isHotelExplicitlySelected(
  day: Pick<TripItineraryDay, "accommodationLat" | "accommodationLon">
): boolean {
  return day.accommodationLat != null && day.accommodationLon != null;
}

/**
 * Toggling a hotel in/out of the comparison selection, capped at 3 (spec
 * item 7 — "compare up to 3 options"). Unchecking always works; checking
 * past the cap is simply a no-op rather than an error, so a fast double-
 * click can never leave the set in a bad state.
 */
export function toggleHotelComparisonSelection(
  current: Set<string>,
  name: string,
  checked: boolean,
  maxCount = 3
): Set<string> {
  const next = new Set(current);
  if (checked && next.size < maxCount) next.add(name);
  else if (!checked) next.delete(name);
  return next;
}

export interface HotelComparisonWinners {
  locationScoreWinner: number | null;
  activityTravelWinner: number | null;
  airportTravelWinner: number | null;
}

function winnerIndex(values: Array<number | null>, higherIsBetter: boolean): number | null {
  let bestIndex: number | null = null;
  let bestValue: number | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value == null) continue;
    if (bestValue == null || (higherIsBetter ? value > bestValue : value < bestValue)) {
      bestValue = value;
      bestIndex = index;
    }
  }
  // A "winner" only means something when at least two real values are
  // actually being compared — never highlight a lone known value against
  // nothing, and never highlight when every candidate is unavailable.
  const knownCount = values.filter((value) => value != null).length;
  return knownCount >= 2 ? bestIndex : null;
}

/**
 * Which of up to 3 compared hotels wins each real numeric column (spec:
 * highlight the best value in each real metric, never in an unavailable
 * one — price/rating/facilities/room aren't included here at all, since
 * they have no real data to compare).
 */
export function pickHotelComparisonWinners(hotels: RankedHotel[]): HotelComparisonWinners {
  return {
    locationScoreWinner: winnerIndex(hotels.map((hotel) => hotel.locationScore), true),
    activityTravelWinner: winnerIndex(hotels.map((hotel) => hotel.averageActivityTravelMinutes), false),
    airportTravelWinner: winnerIndex(hotels.map((hotel) => hotel.airportTravelMinutes), false),
  };
}

/**
 * The real patch applied to every day in a stay once a hotel is selected
 * (spec item 34 — a pure data patch, never a regeneration call). Extracted
 * as its own pure function specifically so the selection behavior itself
 * is unit-testable without rendering TripAccommodationTab.
 *
 * Section F2/F3/G: the selection is always honored as-is (never silently
 * replaced or blocked) — `activityClusters` (the same centroid(s) already
 * used to rank candidates for this stay) is only used to compute a real,
 * visible mismatch warning when the chosen hotel is geographically
 * incompatible with its own stay, never to reject the choice.
 */
export function buildHotelSelectionPatch(
  hotel: Pick<RankedHotel, "name" | "lat" | "lon">,
  activityClusters: Array<{ lat: number; lon: number }> = []
): Pick<
  TripItineraryDay,
  "accommodation" | "accommodationMapLink" | "accommodationLat" | "accommodationLon" | "accommodationBaseMismatch"
> {
  return {
    accommodation: hotel.name,
    accommodationMapLink: buildMapLink(hotel.name, hotel.lat, hotel.lon),
    accommodationLat: hotel.lat,
    accommodationLon: hotel.lon,
    accommodationBaseMismatch: detectHotelBaseMismatch({ lat: hotel.lat, lon: hotel.lon }, activityClusters),
  };
}
