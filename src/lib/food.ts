import { queryNearbyPlaces } from "@/lib/places/overpass";
import { estimateTravelMinutes } from "@/lib/trip-workspace";
import { violatesOpeningHours } from "@/lib/server/opening-hours";

/**
 * Day-aware food recommendation engine (browser QA Parts T-W) — mirrors
 * hotels.ts's own real-location-only, no-fabricated-price/rating pattern:
 * real name/coordinates/opening-hours from the same Overpass "nearby"
 * search already used elsewhere (places/overpass.ts's queryNearbyPlaces),
 * price/rating always marked unavailable (no real data source for either
 * in this project). Relevance is route-aware: real travel time from the
 * day's own activity cluster (never "same city" alone — spec §W).
 */

export type FoodMealSlot = "breakfast" | "lunch" | "dinner" | "cafe";

export interface FoodCandidate {
  name: string;
  category: "restaurant" | "cafe" | "dessert";
  lat: number;
  lon: number;
  openingHours: string | null;
  priceConfidence: "unavailable";
  ratingConfidence: "unavailable";
}

export interface RankedFoodPlace extends FoodCandidate {
  /** Real one-way travel time from the day's own route anchor, in minutes. */
  travelMinutesFromRoute: number | null;
  /** Which meal slot this candidate is being ranked for (drives the caller's grouping, not a property of the place itself). */
  recommendedSlot: FoodMealSlot;
}

const MAX_CANDIDATE_RADIUS_METERS = 1500;
const DEFAULT_CANDIDATE_LIMIT = 20;

// A representative planned time for each slot — real opening-hours
// rejection needs SOME clock time to check against; these match the
// day timeline's own default meal times (spec Part Q #2: "opening hours
// for target meal slot").
const SLOT_DEFAULT_TIME: Record<FoodMealSlot, string> = {
  breakfast: "08:30",
  lunch: "13:00",
  cafe: "16:00",
  dinner: "19:30",
};

const FOOD_NEARBY_CATEGORIES = new Set(["restaurant", "cafe", "dessert"]);

/**
 * Real food candidates near a single point (typically a day's own route
 * anchor/centroid — spec §W: never "same country/city", always minimal
 * detour from the day's actual plan).
 */
export async function findFoodCandidates(
  lat: number,
  lon: number,
  radiusMeters: number = MAX_CANDIDATE_RADIUS_METERS,
  limit: number = DEFAULT_CANDIDATE_LIMIT
): Promise<FoodCandidate[]> {
  const places = await queryNearbyPlaces(lat, lon, radiusMeters, limit);
  return places
    .filter((place): place is typeof place & { category: "restaurant" | "cafe" | "dessert" } =>
      FOOD_NEARBY_CATEGORIES.has(place.category)
    )
    .map((place) => ({
      name: place.name,
      category: place.category,
      lat: place.lat,
      lon: place.lon,
      openingHours: place.openingHours,
      priceConfidence: "unavailable" as const,
      ratingConfidence: "unavailable" as const,
    }));
}

/**
 * Ranks candidates primarily by real travel time from the day's own route
 * anchor (spec Part Q #1 — "a slightly lower-rated restaurant 5 minutes
 * away should beat a top restaurant 45 minutes away"; no popularity/rating
 * signal exists to blend in, so distance is the entire ranking, same as
 * hotels.ts's own honest scope). A candidate confidently known to be
 * closed at the target meal's usual time is rejected outright first (spec
 * Part Q #2) — same real, conservative opening-hours parser used
 * everywhere else in this app (violatesOpeningHours: any ambiguous/
 * unparseable text is never treated as "closed"). Sorted closest-first;
 * the caller slices to however many it wants to show.
 */
export function rankFoodPlaces(
  candidates: FoodCandidate[],
  routeAnchor: { lat: number; lon: number } | null,
  slot: FoodMealSlot
): RankedFoodPlace[] {
  return candidates
    .filter(
      (candidate) =>
        !violatesOpeningHours({
          openingHours: candidate.openingHours ?? "",
          lastEntryTime: "",
          plannedStartTime: SLOT_DEFAULT_TIME[slot],
        })
    )
    .map((candidate) => {
      const travelMinutesFromRoute = routeAnchor
        ? estimateTravelMinutes(routeAnchor.lat, routeAnchor.lon, candidate.lat, candidate.lon, "balanced", "")
        : null;
      return { ...candidate, travelMinutesFromRoute, recommendedSlot: slot };
    })
    .sort((left, right) => (left.travelMinutesFromRoute ?? Infinity) - (right.travelMinutesFromRoute ?? Infinity));
}
