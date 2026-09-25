/**
 * Round 9.6 — Google Places API (New) as the SECONDARY real-place
 * discovery provider (Overpass remains PRIMARY, unchanged). Server-only:
 * this file must never be imported from client code, and the API key it
 * reads is never exposed to the browser (see `resolveApiKey` below).
 *
 * Uses the current, officially-supported Nearby Search (New) endpoint —
 * verified against developers.google.com/maps/documentation/places in
 * Round 9.5.3's own investigation, NOT the legacy Places API. Every
 * discovered candidate is returned in the EXACT same shape
 * `OverpassNearbyRecommendation`/`RealPlaceCandidate` already uses (see
 * overpass.ts), with `provenance` populated — so every existing consumer
 * of that shape (fetchDiscoveryGroupRaw, acceptRawCandidatesIntoPool,
 * refillStayActivityPool's own `fetchCandidates` injection point) already
 * works with a Google-sourced candidate with ZERO changes to their own
 * logic. This is the provider-neutral design Round 9.5.3 proposed,
 * implemented via the existing injection seam rather than a new one.
 */

import { haversineKm } from "../trip-workspace";
import type { RecommendationCategory } from "../trip-workspace";
import type { OverpassNearbyRecommendation as RealPlaceCandidate } from "./overpass";

const PLACES_NEARBY_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby";
const PLACES_TEXT_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const REQUEST_TIMEOUT_MS = 8000;

// Server-only — reused from the SAME env var Round 9.5.1's Routes provider
// already established (one key, restricted in Google Cloud Console to
// exactly Routes API + Places API (New) — never a NEXT_PUBLIC_ variant,
// never logged).
export function isGooglePlacesConfigured(): boolean {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY.trim());
}

/**
 * Round 9.6 §D — a SMALL, bounded set of Google types per internal
 * category, deliberately excluding ordinary-retail/accommodation types
 * (spec §E: "must continue to reject... ordinary supermarkets, generic
 * chain retail, ordinary shopping centers without destination-shopping
 * evidence") at the SOURCE — never requested from Google in the first
 * place, not merely filtered out later. Never country-specific (spec §D).
 * "hotel"/"transportation" are deliberately absent — this provider is
 * only ever used for the tourist-activity/meal discovery groups, exactly
 * mirroring REFILLABLE_CATEGORIES' own scope in stay-activity-pool.ts.
 */
const GOOGLE_CATEGORY_TYPE_FILTERS: Partial<Record<RecommendationCategory, string[]>> = {
  attraction: ["tourist_attraction", "historical_landmark", "monument", "cultural_landmark"],
  museum: ["museum", "art_gallery"],
  nature: ["park", "national_park", "state_park", "nature_preserve", "garden", "botanical_garden"],
  family: ["amusement_park", "zoo", "aquarium"],
  shopping: ["shopping_mall", "market"],
  nightlife: ["night_club", "bar", "pub"],
  restaurant: ["restaurant"],
  // Round 9.6.5 §D — bakery accepted where suitable (a genuine casual meal/
  // snack venue, same tier as a cafe); never a grocery/convenience/retail
  // establishment that merely happens to sell food (those are hard-
  // excluded by primaryType below, checked first, never via this list).
  cafe: ["cafe", "coffee_shop", "bakery"],
};

export function categoryHasGooglePlacesSource(category: RecommendationCategory): boolean {
  return category in GOOGLE_CATEGORY_TYPE_FILTERS;
}

/**
 * Round 9.6 §E/§M — discovered via the live Boston validation: a hotel's
 * own on-site restaurant/bar is a real place whose Google `primaryType` is
 * "hotel"/"lodging" (Google's own authoritative single-type call) but
 * whose secondary `types` array ALSO legitimately includes "restaurant" —
 * real examples seen live: "InterContinental Boston by IHG",
 * "Fairmont Copley Plaza, Boston", "YOTEL Boston". Falling through to the
 * broader types check for these would accept a hotel as a normal meal/
 * activity recommendation, exactly what spec §E forbids. A primaryType
 * that is itself one of these hard-excluded practical/lodging/utility
 * types must reject outright — never consult the broader types array —
 * regardless of what else that place happens to also be tagged with.
 */
const PRIMARY_TYPE_HARD_EXCLUSIONS = new Set([
  "lodging",
  "hotel",
  "motel",
  "resort_hotel",
  "bed_and_breakfast",
  "hostel",
  "extended_stay_hotel",
  "guest_house",
  "hospital",
  "doctor",
  "parking",
  "school",
  "primary_school",
  "secondary_school",
  "university",
  "airport",
  "real_estate_agency",
  "supermarket",
  "department_store",
  // Round 9.6.5 §D — grocery/convenience/fuel retail must never qualify
  // as a meal venue merely because their secondary types include "food"/
  // "store" alongside groceries — these are hard-excluded by primaryType,
  // the same discipline as hotel/lodging above. Deliberately NOT
  // extended to every retail type (e.g. book_store): a genuine bookstore-
  // cafe combo is a real, previously-validated meal venue (Round 9.6.2's
  // own live Boston validation: "Beacon Hill Books & Cafe") and must not
  // regress.
  "grocery_store",
  "convenience_store",
  "gas_station",
]);

export function isHardExcludedPrimaryType(primaryType: string | undefined | null): boolean {
  return Boolean(primaryType && PRIMARY_TYPE_HARD_EXCLUSIONS.has(primaryType));
}

interface GooglePlaceResult {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  formattedAddress?: string;
  websiteUri?: string;
  currentOpeningHours?: { weekdayDescriptions?: string[] };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
}

/** Best-effort human-readable hours string from Google's structured weekday descriptions — this app's own opening-hours parser (opening-hours.ts) already tolerates free-text/OSM-style strings; never fabricated when Google doesn't return hours. */
function formatOpeningHours(place: GooglePlaceResult): string | null {
  const descriptions = place.currentOpeningHours?.weekdayDescriptions ?? place.regularOpeningHours?.weekdayDescriptions;
  if (!descriptions || descriptions.length === 0) return null;
  return descriptions.join("; ");
}

/** Which of OUR categories this Google result actually matches, restricted to the categories the caller actually asked for (never a category outside what was requested) — the same "classified back by which filter actually matched" discipline overpass.ts's own grouped query already uses. */
function resolveMatchedCategory(place: GooglePlaceResult, requestedCategories: RecommendationCategory[]): RecommendationCategory | null {
  // A hard-excluded primaryType (hotel, hospital, parking, school,
  // airport, ...) rejects outright — never falls through to the broader
  // types check, since that secondary array can legitimately carry an
  // on-site amenity tag (a hotel's own restaurant, a hospital's own cafe)
  // that would otherwise smuggle the practical/lodging venue itself in as
  // a normal recommendation (spec §E; found live in Round 9.6 §M).
  if (isHardExcludedPrimaryType(place.primaryType)) return null;

  // Google's own `primaryType` is its single authoritative best-fit type
  // (spec §D/§E evidence) — checked FIRST and alone, since a place's
  // secondary `types` array can legitimately include another category's
  // type too (e.g. a museum is very often ALSO tagged "tourist_attraction"
  // — real evidence found while testing this exact mapping). Only when
  // primaryType itself doesn't resolve to any requested category does the
  // broader `types` array get consulted, in the caller's own given order.
  if (place.primaryType) {
    for (const category of requestedCategories) {
      if ((GOOGLE_CATEGORY_TYPE_FILTERS[category] ?? []).includes(place.primaryType)) return category;
    }
  }
  const types = new Set([place.primaryType, ...(place.types ?? [])].filter((t): t is string => Boolean(t)));
  for (const category of requestedCategories) {
    const googleTypes = GOOGLE_CATEGORY_TYPE_FILTERS[category] ?? [];
    if (googleTypes.some((type) => types.has(type))) return category;
  }
  return null;
}

async function postPlaces(endpoint: string, body: Record<string, unknown>, fieldMask: string): Promise<{ places?: GooglePlaceResult[] } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { places?: GooglePlaceResult[] };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Round 9.6 §B — minimal field mask, exactly the 6 fields the planner
// genuinely consumes today (spec: "Only add additional fields if existing
// planner logic genuinely consumes them") plus opening hours (this app's
// entire repair pipeline is hours-driven) and websiteUri (already a real
// TripRecommendation field) — both already needed regardless, so
// requesting them costs no additional SKU tier (Round 9.5.3's own
// investigation: hours/website already force the Enterprise tier; rating/
// price level would too, so they are deliberately NOT requested here
// since nothing in this app's classification currently consumes them —
// spec "do not request expensive fields merely because they are
// available").
const NEARBY_SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.primaryType",
  "places.types",
  "places.formattedAddress",
  "places.websiteUri",
  "places.currentOpeningHours",
  "places.regularOpeningHours",
].join(",");

function toRealPlaceCandidate(place: GooglePlaceResult, category: RecommendationCategory): RealPlaceCandidate | null {
  const name = place.displayName?.text;
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  if (!place.id || !name || lat == null || lon == null) return null;
  return {
    name,
    category,
    location: place.formattedAddress ?? name,
    shortDescription: null,
    lat,
    lon,
    openingHours: formatOpeningHours(place),
    wikipediaUrl: null, // Google Places (New) does not return this — never fabricated
    website: place.websiteUri ?? null,
    provenance: {
      provider: "google_places",
      providerId: place.id,
      types: [place.primaryType, ...(place.types ?? [])].filter((t): t is string => Boolean(t)),
    },
  };
}

/**
 * Round 9.6 §D — ONE Nearby Search call covering every category in this
 * group at once (types combined into a single `includedTypes` array —
 * Google's own API permits this; never one request per type). Matches
 * the EXACT signature shape `RefillOptions["fetchCandidates"]` already
 * expects (radiusKm, categories, perCategoryLimit), so this can be passed
 * directly as the `fetchCandidates` override to `refillStayActivityPool`
 * with zero changes to that function.
 */
export async function queryGooglePlacesForCategoriesDetailed(
  anchor: { lat: number; lon: number },
  radiusKm: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number
): Promise<{ candidates: RealPlaceCandidate[]; requestFailed: boolean }> {
  const requestedCategories = categories.filter(categoryHasGooglePlacesSource);
  if (requestedCategories.length === 0) return { candidates: [], requestFailed: false };
  const includedTypes = [...new Set(requestedCategories.flatMap((category) => GOOGLE_CATEGORY_TYPE_FILTERS[category] ?? []))];
  if (includedTypes.length === 0) return { candidates: [], requestFailed: false };

  // Google's own documented max is 50,000m; this app's own stay-locality
  // radii are always far smaller, so the min() is a pure safety clamp,
  // never an active constraint in practice.
  const radiusMeters = Math.min(radiusKm * 1000, 50000);
  const maxResultCount = Math.min(Math.max(perCategoryLimit * requestedCategories.length, 5), 20);

  const data = await postPlaces(
    PLACES_NEARBY_SEARCH_ENDPOINT,
    {
      includedTypes,
      maxResultCount,
      locationRestriction: { circle: { center: { latitude: anchor.lat, longitude: anchor.lon }, radius: radiusMeters } },
    },
    NEARBY_SEARCH_FIELD_MASK
  );
  // Round 9.6 §I — a null `data` means the request itself failed
  // (unavailable/network/HTTP error); an object with no/empty `places`
  // means the request SUCCEEDED and Google genuinely has nothing here —
  // these are kept distinct all the way up to the QA counters, never
  // conflated.
  if (!data) return { candidates: [], requestFailed: true };

  const candidates: RealPlaceCandidate[] = [];
  for (const place of data.places ?? []) {
    const category = resolveMatchedCategory(place, requestedCategories);
    if (!category) continue;
    const candidate = toRealPlaceCandidate(place, category);
    if (candidate) candidates.push(candidate);
  }
  return { candidates, requestFailed: false };
}

/** Signature-compatible with RefillOptions["fetchCandidates"] — used directly as the `fetchCandidates` override for refillStayActivityPool. Failure and "genuinely zero results" both surface as an empty array here (refillStayActivityPool has no separate failure channel); queryGooglePlacesWithBudget below is the richer, counter-aware entry point production orchestration actually uses. */
export async function queryGooglePlacesForCategories(
  anchor: { lat: number; lon: number },
  radiusKm: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number
): Promise<RealPlaceCandidate[]> {
  return (await queryGooglePlacesForCategoriesDetailed(anchor, radiusKm, categories, perCategoryLimit)).candidates;
}

/**
 * Round 9.6 §G — the Gemini-verification-gate resolver: Text Search by
 * name, biased toward a real anchor, used ONLY to check whether a
 * Gemini-proposed free-text place name corresponds to a genuine real
 * place before it may enter RealPlaceInventory. Returns null (never a
 * guess) when nothing resolves, when the top result is implausibly far
 * from the anchor (a different real place that merely shares a name), or
 * when Google is unavailable/fails.
 */
export async function resolveGooglePlaceByName(
  name: string,
  anchor: { lat: number; lon: number },
  radiusKm: number
): Promise<RealPlaceCandidate | null> {
  const data = await postPlaces(
    PLACES_TEXT_SEARCH_ENDPOINT,
    {
      textQuery: name,
      locationBias: { circle: { center: { latitude: anchor.lat, longitude: anchor.lon }, radius: Math.min(radiusKm * 1000, 50000) } },
      maxResultCount: 1,
    },
    NEARBY_SEARCH_FIELD_MASK
  );
  const place = data?.places?.[0];
  if (!place) return null;
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  if (lat == null || lon == null) return null;
  // Fail closed on distance (spec §G "verify stay/locality compatibility")
  // — a same-named place in a different city must never be accepted as a
  // match merely because it was the top text-search hit.
  if (haversineKm(anchor.lat, anchor.lon, lat, lon) > radiusKm * 3) return null;

  const inferredCategory = resolveMatchedCategory(place, Object.keys(GOOGLE_CATEGORY_TYPE_FILTERS) as RecommendationCategory[]);
  if (!inferredCategory) return null; // resolved to a real place, but not one of our tourist-relevant categories — never guessed into one

  return toRealPlaceCandidate(place, inferredCategory);
}

// ------------------------------------------------------------------
// Round 9.6 §H — per-generation cache + request budget + counters.
// Created fresh per generateCountryItineraryPlan call (never a
// module-level singleton), same discipline as Round 9.5.1's RouteCache.
// ------------------------------------------------------------------

export interface GooglePlacesBudgetCounters {
  googlePlacesCalls: number;
  googlePlacesCacheHits: number;
  googlePlacesFailures: number;
  googlePlacesCandidatesRaw: number;
  googlePlacesCandidatesUsable: number;
  googlePlacesFallbackStays: number;
}

export interface GooglePlacesBudget {
  readonly maxCalls: number;
  counters: GooglePlacesBudgetCounters;
  cache: Map<string, RealPlaceCandidate[]>;
}

export function createGooglePlacesBudget(maxCalls: number): GooglePlacesBudget {
  return {
    maxCalls,
    counters: {
      googlePlacesCalls: 0,
      googlePlacesCacheHits: 0,
      googlePlacesFailures: 0,
      googlePlacesCandidatesRaw: 0,
      googlePlacesCandidatesUsable: 0,
      googlePlacesFallbackStays: 0,
    },
    cache: new Map(),
  };
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function budgetCacheKey(anchor: { lat: number; lon: number }, radiusKm: number, categories: RecommendationCategory[]): string {
  return `${roundCoordinate(anchor.lat)},${roundCoordinate(anchor.lon)}:${radiusKm}:${[...categories].sort().join("+")}`;
}

/**
 * Round 9.6 §H/§J — the budget/cache/observability-wrapped entry point
 * production code actually calls (queryGooglePlacesForCategories above
 * stays a pure, directly-testable primitive). Never issues a second
 * identical request for the same stay/coordinates/radius/category-group
 * (spec "no duplicate searches for the same stay/group"); once
 * `maxCalls` is spent, returns an empty array (spec §H "if budget is
 * exhausted: report it truthfully, continue with existing verified
 * supply, do not fabricate candidates") rather than throwing or silently
 * fabricating results.
 */
export async function queryGooglePlacesWithBudget(
  budget: GooglePlacesBudget,
  anchor: { lat: number; lon: number },
  radiusKm: number,
  categories: RecommendationCategory[],
  perCategoryLimit: number
): Promise<RealPlaceCandidate[]> {
  const key = budgetCacheKey(anchor, radiusKm, categories);
  const cached = budget.cache.get(key);
  if (cached) {
    budget.counters.googlePlacesCacheHits += 1;
    return cached;
  }
  if (budget.counters.googlePlacesCalls >= budget.maxCalls) {
    return [];
  }
  budget.counters.googlePlacesCalls += 1;
  const { candidates, requestFailed } = await queryGooglePlacesForCategoriesDetailed(anchor, radiusKm, categories, perCategoryLimit);
  if (requestFailed) budget.counters.googlePlacesFailures += 1;
  budget.counters.googlePlacesCandidatesRaw += candidates.length;
  budget.cache.set(key, candidates);
  return candidates;
}
