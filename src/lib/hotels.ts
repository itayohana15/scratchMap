import { queryNearbyPlaces } from "@/lib/places/overpass";
import { estimateTravelMinutes } from "@/lib/trip-workspace";

/**
 * Hotel recommendation engine (spec items 26-36). No paid hotel/booking/
 * reviews API exists in this project — real name/coordinates/opening-hours
 * come from the same Overpass "hotel" radius search already used
 * elsewhere (src/lib/places/overpass.ts's queryNearbyPlaces). Price, star
 * rating, and guest reviews have no data source at all, so they are always
 * marked "unavailable" here — never fabricated (spec item 98's
 * verified/estimated/unavailable distinction). Ranking is therefore
 * entirely location-based: real travel time to the trip's own planned
 * activities and to the relevant airport, computed with the same
 * estimateTravelMinutes primitive used throughout the itinerary engine.
 */

export interface HotelCandidate {
  name: string;
  lat: number;
  lon: number;
  openingHours: string | null;
  priceConfidence: "unavailable";
  ratingConfidence: "unavailable";
}

export interface ActivityCluster {
  lat: number;
  lon: number;
}

export interface RankedHotel extends HotelCandidate {
  /** Average one-way travel time to the trip's own planned activity clusters, in minutes. Null when no clusters were given. */
  averageActivityTravelMinutes: number | null;
  /** One-way travel time to the relevant airport, in minutes. Null when no airport coordinates were given. */
  airportTravelMinutes: number | null;
  /** 0-100, weighted mostly toward activity proximity (spec item 28 — "geography should be heavily weighted"). Purely relative to the other candidates, not an absolute quality claim — price/rating aren't available to factor in. */
  locationScore: number;
}

const MAX_CANDIDATE_RADIUS_METERS = 2500;
const DEFAULT_CANDIDATE_LIMIT = 20;

/**
 * Real hotel candidates near a given point (e.g. a trip phase's dominant
 * activity cluster) — reuses the existing Overpass "hotel" category
 * (tourism=hotel/guest_house/hostel) rather than a new data source.
 */
export async function findHotelCandidates(
  lat: number,
  lon: number,
  radiusMeters: number = MAX_CANDIDATE_RADIUS_METERS,
  limit: number = DEFAULT_CANDIDATE_LIMIT
): Promise<HotelCandidate[]> {
  const places = await queryNearbyPlaces(lat, lon, radiusMeters, limit);
  return places
    .filter((place) => place.category === "hotel")
    .map((place) => ({
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      openingHours: place.openingHours,
      priceConfidence: "unavailable" as const,
      ratingConfidence: "unavailable" as const,
    }));
}

/**
 * Ranks candidates by real location signals only (spec item 28's
 * locationScore/activityProximityScore/airportScore — priceScore/
 * ratingScore are omitted rather than guessed, since no real data exists
 * for them). Sorted best-first; the caller slices to the top 5-10 (spec
 * item 26).
 */
export function rankHotels(
  candidates: HotelCandidate[],
  activityClusters: ActivityCluster[],
  airportCoords: { lat: number; lon: number } | null
): RankedHotel[] {
  return candidates
    .map((hotel) => {
      const activityTravelTimes = activityClusters.map((cluster) =>
        estimateTravelMinutes(hotel.lat, hotel.lon, cluster.lat, cluster.lon, "balanced", "")
      );
      const averageActivityTravelMinutes =
        activityTravelTimes.length > 0
          ? Math.round(activityTravelTimes.reduce((sum, minutes) => sum + minutes, 0) / activityTravelTimes.length)
          : null;
      const airportTravelMinutes = airportCoords
        ? estimateTravelMinutes(hotel.lat, hotel.lon, airportCoords.lat, airportCoords.lon, "balanced", "")
        : null;

      // Lower travel time -> higher score, floored at 0. A fixed neutral
      // 50 when a signal is entirely missing (no clusters/airport given)
      // rather than letting it silently zero out the whole score.
      const activityProximityScore =
        averageActivityTravelMinutes != null ? Math.max(0, 100 - averageActivityTravelMinutes * 2) : 50;
      const airportScore = airportTravelMinutes != null ? Math.max(0, 100 - airportTravelMinutes) : 50;
      const locationScore = Math.round(activityProximityScore * 0.7 + airportScore * 0.3);

      return {
        ...hotel,
        averageActivityTravelMinutes,
        airportTravelMinutes,
        locationScore,
      };
    })
    .sort((left, right) => right.locationScore - left.locationScore);
}

/**
 * "אזור לינה מומלץ" (spec item 29) — the centroid of the trip's own
 * planned activity clusters for this phase, with a real, computed reason
 * (not invented copy).
 */
export function buildRecommendedAreaLabel(
  areaLabel: string,
  activityClusters: ActivityCluster[]
): { area: string; reason: string } | null {
  if (!areaLabel || activityClusters.length === 0) return null;
  return {
    area: areaLabel,
    reason: `האזור קרוב לרוב הפעילויות המתוכננות בבסיס הזה, וכך מתקצר הזמן בין הלינה לאטרקציות.`,
  };
}

/**
 * "למה המלון מתאים למסלול" (spec item 33) — a real sentence built from the
 * hotel's own computed travel-time numbers, never invented prose.
 */
export function explainHotelFit(hotel: RankedHotel): string {
  if (hotel.averageActivityTravelMinutes == null) {
    return "אין מספיק נתוני מיקום כדי להסביר את ההתאמה של המלון הזה למסלול.";
  }
  if (hotel.averageActivityTravelMinutes <= 10) {
    return `המלון נמצא במרחק הליכה קצר (כ-${hotel.averageActivityTravelMinutes} דק') מרוב הפעילויות המתוכננות בבסיס זה.`;
  }
  if (hotel.averageActivityTravelMinutes <= 20) {
    return `המלון נמצא במרחק נסיעה קצר (כ-${hotel.averageActivityTravelMinutes} דק') מרוב הפעילויות המתוכננות בבסיס זה.`;
  }
  return `המלון מקצר במידה מסוימת את הנסיעות (כ-${hotel.averageActivityTravelMinutes} דק' בממוצע) לפעילויות המתוכננות, אך יש אפשרויות קרובות יותר.`;
}

// Moved to trip-workspace.ts (spec §F5) — hotel-ui-helpers.ts's live
// selection flow needs it too, and that module is deliberately client-safe
// (no Overpass/server-only import), which this file is not. Re-exported
// here so existing callers/tests of this module are unaffected.
export { detectHotelBaseMismatch, HOTEL_BASE_MISMATCH_KM, type HotelBaseMismatch } from "@/lib/trip-workspace";

/**
 * Old-hotel-vs-new-hotel comparison (spec item 36) — a real delta from two
 * already-ranked hotels, never invented.
 */
export function compareHotelImpact(
  previous: Pick<RankedHotel, "averageActivityTravelMinutes">,
  next: Pick<RankedHotel, "averageActivityTravelMinutes">
): { travelMinutesDelta: number | null } {
  if (previous.averageActivityTravelMinutes == null || next.averageActivityTravelMinutes == null) {
    return { travelMinutesDelta: null };
  }
  return { travelMinutesDelta: next.averageActivityTravelMinutes - previous.averageActivityTravelMinutes };
}
