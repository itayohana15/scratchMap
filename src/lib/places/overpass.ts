// Server-only helper around OpenStreetMap's free Overpass API. Used instead
// of asking an LLM to invent place names/prices/hours — every field here
// comes straight from real OSM tags, or is left null/empty when the tag
// doesn't exist (the UI already renders "not available" copy for that case).
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RecommendationCategory } from "@/lib/trip-workspace";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
// Country-wide area queries against the public Overpass instance can take
// 10-20s; we lean on the 24h cache below so only the first load per
// country+category ever pays that cost.
const REQUEST_TIMEOUT_MS = 25_000;

export interface OverpassPlace {
  name: string;
  lat: number;
  lon: number;
  openingHours: string | null;
  description: string | null;
  website: string | null;
  wikipediaUrl: string | null;
  cuisine: string | null;
  wheelchairAccessible: boolean | null;
  isFree: boolean | null;
}

/**
 * Real provider-availability probe (spec §H) — a minimal, cheap query
 * whose only purpose is "did Overpass actually respond", never "does it
 * have data for X" (that's still queryOverpassPlaces/queryNearbyPlaces,
 * unchanged). Distinguishes a genuine outage from "the query legitimately
 * returned zero results" — the two currently look identical to every
 * existing caller, since both silently resolve to []. Callers that already
 * know the real result (having just run their own category queries) don't
 * need this at all; it exists for a caller that wants the answer up front,
 * without inferring it from candidate counts (spec §H's explicit "do not
 * infer network/provider success from candidate count").
 */
export async function checkOverpassAvailability(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ data: "[out:json][timeout:5];out count;" }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

type CountryBBox = [number, number, number, number];

// Categories with no equivalent structured/open data source (they require
// editorial judgment or event calendars) intentionally have no tag filter —
// callers should treat them as unavailable rather than inventing content.
const CATEGORY_TAG_FILTERS: Partial<Record<RecommendationCategory, string[]>> = {
  attraction: ['tourism=attraction', 'tourism=viewpoint', 'tourism=gallery'],
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  museum: ["tourism=museum"],
  nature: ["leisure=nature_reserve", "natural=beach", "tourism=alpine_hut"],
  shopping: ["shop=mall", "shop=department_store"],
  nightlife: ["amenity=bar", "amenity=nightclub", "amenity=pub"],
  family: ["leisure=park", "tourism=zoo", "leisure=water_park"],
  hotel: ["tourism=hotel", "tourism=resort"],
  transportation: ["aeroway=aerodrome", "railway=station", "amenity=bus_station"],
};

export function categoryHasOpenDataSource(category: RecommendationCategory): boolean {
  return category in CATEGORY_TAG_FILTERS;
}

function toOverpassSelector(filter: string) {
  const [key, ...valueParts] = filter.split("=");
  const value = valueParts.join("=");
  if (!key || !value) return "";
  return `[${key}="${value}"]`;
}

function buildClauses(category: RecommendationCategory): string | null {
  const filters = CATEGORY_TAG_FILTERS[category];
  if (!filters) return null;

  return filters
    .map((filter) => `nwr${toOverpassSelector(filter)}(area.searchArea);`)
    .join("\n      ");
}

function buildAreaQuery(isoA2: string, category: RecommendationCategory, limit: number): string | null {
  const clauses = buildClauses(category);
  if (!clauses) return null;

  return `
    [out:json][timeout:22];
    (
      area["ISO3166-1"="${isoA2}"][admin_level=2];
      area["ISO3166-1:alpha2"="${isoA2}"][admin_level=2];
      area["ISO3166-1:alpha2"="${isoA2}"];
    )->.searchArea;
    (
      ${clauses}
    );
    out center ${Math.max(limit * 4, 40)};
  `;
}

function buildBboxQuery(
  bbox: CountryBBox,
  category: RecommendationCategory,
  limit: number
): string | null {
  const clauses = buildClauses(category);
  if (!clauses) return null;

  const [west, south, east, north] = bbox;
  const filters = CATEGORY_TAG_FILTERS[category] ?? [];
  const bboxClauses = filters
    .map(
      (filter) =>
        `nwr${toOverpassSelector(filter)}(${south},${west},${north},${east});`
    )
    .join("\n      ");

  return `
    [out:json][timeout:22];
    (
      ${bboxClauses}
    );
    out center ${Math.max(limit * 4, 40)};
  `;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string | undefined>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

interface CountryFeatureCollectionFile {
  features?: Array<{
    properties?: {
      iso_a2?: string;
      bbox?: CountryBBox;
    };
  }>;
}

let countryBboxesPromise: Promise<Map<string, CountryBBox>> | null = null;

function score(tags: Record<string, string | undefined>): number {
  // Prefer entries that carry enough real-world signal to be worth
  // recommending — a name is mandatory; everything else just nudges rank.
  let value = 0;
  if (tags.wikidata) value += 3;
  if (tags.wikipedia) value += 2;
  if (tags.opening_hours) value += 1;
  if (tags.website) value += 1;
  if (tags.description || tags["description:en"]) value += 1;
  return value;
}

async function loadCountryBboxes() {
  if (!countryBboxesPromise) {
    countryBboxesPromise = readFile(
      path.join(process.cwd(), "public", "data", "world-countries.geojson"),
      "utf8"
    )
      .then((content) => JSON.parse(content) as CountryFeatureCollectionFile)
      .then((data) => {
        const map = new Map<string, CountryBBox>();
        for (const feature of data.features ?? []) {
          const iso = feature.properties?.iso_a2?.toUpperCase();
          const bbox = feature.properties?.bbox;
          if (iso && bbox?.length === 4) {
            map.set(iso, bbox);
          }
        }
        return map;
      })
      .catch(() => new Map<string, CountryBBox>());
  }

  return countryBboxesPromise;
}

async function getCountryBbox(isoA2: string) {
  const bboxes = await loadCountryBboxes();
  return bboxes.get(isoA2.toUpperCase()) ?? null;
}

function normalizeOverpassElements(data: OverpassResponse, limit: number): OverpassPlace[] {
  const withNames = data.elements
    .map((el) => {
      const tags = el.tags ?? {};
      const name = tags.name || tags["name:en"];
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!name || lat == null || lon == null) return null;

      const wikipediaTag = tags.wikipedia;
      const wikipediaUrl = wikipediaTag
        ? (() => {
            const [lang, ...rest] = wikipediaTag.split(":");
            const title = rest.join(":") || lang;
            const wikiLang = rest.length > 0 ? lang : "en";
            return `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
          })()
        : null;

      const wheelchairAccessible =
        tags.wheelchair === "yes" || tags.wheelchair === "designated"
          ? true
          : tags.wheelchair === "no"
            ? false
            : null;
      const isFree = tags.fee === "no" ? true : tags.fee === "yes" ? false : null;

      return {
        place: {
          name,
          lat,
          lon,
          openingHours: tags.opening_hours ?? null,
          description: tags.description ?? tags["description:en"] ?? null,
          website: tags.website ?? tags["contact:website"] ?? null,
          wikipediaUrl,
          cuisine: tags.cuisine ?? null,
          wheelchairAccessible,
          isFree,
        } satisfies OverpassPlace,
        score: score(tags),
      };
    })
    .filter((entry): entry is { place: OverpassPlace; score: number } => entry != null);

  const seen = new Set<string>();
  const deduped = withNames.filter((entry) => {
    const key = entry.place.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.place);
}

/**
 * Section B — the request's own real outcome, kept distinct from "how many
 * places came back": a request that genuinely reached Overpass and got a
 * valid response is `succeeded: true` even with zero results (spec §B2 —
 * "zero results != provider failure"); a network error or non-OK status is
 * `succeeded: false` regardless of how many places a LATER fallback query
 * might still turn up.
 */
export interface OverpassQueryOutcome {
  places: OverpassPlace[];
  succeeded: boolean;
}

async function executeOverpassQuery(query: string, limit: number): Promise<OverpassQueryOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!res.ok) {
      // Degrading to [] is intentional (categories with no data just come
      // back empty) — but a non-OK status (rate limit, 5xx) is a real
      // provider failure, not "no results", so succeeded is false here even
      // though the shape (empty array) looks identical to a legitimate
      // zero-result query.
      if (process.env.NODE_ENV !== "production") {
        console.log("[Recommendations] Overpass request returned non-OK status", { status: res.status });
      }
      return { places: [], succeeded: false };
    }

    const data = (await res.json()) as OverpassResponse;
    return { places: normalizeOverpassElements(data, limit), succeeded: true };
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[Recommendations] Overpass request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { places: [], succeeded: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryOverpassPlaces(
  isoA2: string,
  category: RecommendationCategory,
  limit: number
): Promise<OverpassQueryOutcome> {
  const normalizedIso = isoA2.toUpperCase();
  const areaQuery = buildAreaQuery(normalizedIso, category, limit);
  if (!areaQuery) return { places: [], succeeded: true };

  const areaOutcome = await executeOverpassQuery(areaQuery, limit);
  if (areaOutcome.places.length > 0) {
    return areaOutcome;
  }

  const bbox = await getCountryBbox(normalizedIso);
  if (!bbox) return areaOutcome;

  const bboxQuery = buildBboxQuery(bbox, category, limit);
  if (!bboxQuery) return areaOutcome;

  const bboxOutcome = await executeOverpassQuery(bboxQuery, limit);
  // The area query already told us the truth about provider reachability;
  // a bbox fallback that also comes back empty must not silently overwrite
  // a real area-query success with its own (still legitimate) succeeded
  // value — both are ANDed so a genuine failure anywhere is never hidden.
  return { places: bboxOutcome.places, succeeded: areaOutcome.succeeded && bboxOutcome.succeeded };
}

// --- Nearby places (radius search around a single point) -----------------

export type NearbyCategory =
  | "restaurant"
  | "cafe"
  | "dessert"
  | "hotel"
  | "fuel"
  | "supermarket"
  | "parking"
  | "restroom"
  | "attraction";

export interface NearbyPlace {
  name: string;
  category: NearbyCategory;
  lat: number;
  lon: number;
  distanceMeters: number;
  openingHours: string | null;
}

const NEARBY_CATEGORY_TAG_FILTERS: Record<NearbyCategory, string[]> = {
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  dessert: ["shop=pastry", "shop=confectionery", "amenity=ice_cream"],
  hotel: ["tourism=hotel", "tourism=guest_house", "tourism=hostel"],
  fuel: ["amenity=fuel"],
  supermarket: ["shop=supermarket"],
  parking: ["amenity=parking"],
  restroom: ["amenity=toilets"],
  attraction: ["tourism=attraction", "tourism=viewpoint", "tourism=museum", "tourism=gallery"],
};

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Reverse lookup: given an element's own tags, which nearby category (if
// any) does it match? Built once from NEARBY_CATEGORY_TAG_FILTERS so a
// single combined query can be classified after the fact instead of firing
// one request per category (kinder to the shared public Overpass instance).
const TAG_TO_NEARBY_CATEGORY = new Map<string, NearbyCategory>();
for (const [nearbyCategory, filters] of Object.entries(NEARBY_CATEGORY_TAG_FILTERS) as [
  NearbyCategory,
  string[],
][]) {
  for (const filter of filters) {
    TAG_TO_NEARBY_CATEGORY.set(filter, nearbyCategory);
  }
}

function classifyNearbyElement(tags: Record<string, string | undefined>): NearbyCategory | null {
  for (const [filter, nearbyCategory] of TAG_TO_NEARBY_CATEGORY) {
    const [key, value] = filter.split("=");
    if (tags[key] === value) return nearbyCategory;
  }
  return null;
}

export async function queryNearbyPlaces(
  lat: number,
  lon: number,
  radiusMeters: number,
  perCategoryLimit: number
): Promise<NearbyPlace[]> {
  const allFilters = Object.values(NEARBY_CATEGORY_TAG_FILTERS).flat();
  const query = `
    [out:json][timeout:20];
    (
      ${allFilters.map((filter) => `nwr${toOverpassSelector(filter)}(around:${radiusMeters},${lat},${lon});`).join("\n      ")}
    );
    out center 200;
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: controller.signal,
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as OverpassResponse;
    const byCategory = new Map<NearbyCategory, NearbyPlace[]>();

    for (const el of data.elements) {
      const tags = el.tags ?? {};
      const name = tags.name || tags["name:en"];
      const placeLat = el.lat ?? el.center?.lat;
      const placeLon = el.lon ?? el.center?.lon;
      const category = classifyNearbyElement(tags);
      if (!name || placeLat == null || placeLon == null || !category) continue;

      const place: NearbyPlace = {
        name,
        category,
        lat: placeLat,
        lon: placeLon,
        distanceMeters: Math.round(haversineMeters(lat, lon, placeLat, placeLon)),
        openingHours: tags.opening_hours ?? null,
      };
      const bucket = byCategory.get(category) ?? [];
      bucket.push(place);
      byCategory.set(category, bucket);
    }

    return [...byCategory.values()].flatMap((places) =>
      places.sort((left, right) => left.distanceMeters - right.distanceMeters).slice(0, perCategoryLimit)
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
