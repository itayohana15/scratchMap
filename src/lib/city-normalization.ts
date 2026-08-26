import { searchPlaces } from "@/lib/places/nominatim";
import type { TripItineraryDay } from "@/lib/trip-workspace";

const HEBREW_PATTERN = /[֐-׿]/;

/** ~1km grid — coarse enough that the same real city geocodes to one id even from slightly different query strings. */
export function buildCityCanonicalId(isoA2: string, lat: number, lon: number): string {
  return `${isoA2.toLowerCase()}:${lat.toFixed(2)}:${lon.toFixed(2)}`;
}

interface CityCluster {
  canonicalId: string;
  displayName: string;
}

/**
 * Geocodes every unique `cityRegion` value once (server-side, via the
 * already rate-limit-safe Nominatim client), clusters them by rounded
 * coordinates, and rewrites each day's `cityRegion` to one canonical winning
 * name per cluster — so "Tbilisi" / "טביליסי" / "Tbilisi, Georgia" merge
 * into a single city instead of being counted/displayed as separate places
 * (spec §A2/§A4). A city that can't be geocoded is left untouched (no
 * `cityCanonicalId`) rather than blocking generation on a lookup failure.
 */
export async function canonicalizeItineraryCities(
  days: TripItineraryDay[],
  isoA2: string
): Promise<TripItineraryDay[]> {
  const uniqueNames = [
    ...new Set(
      days
        .map((day) => day.cityRegion?.trim())
        .filter((name): name is string => Boolean(name))
    ),
  ];
  if (uniqueNames.length === 0) return days;

  const geocoded = await Promise.all(
    uniqueNames.map(async (name) => {
      try {
        const [match] = await searchPlaces(name, { countryCode: isoA2, limit: 1 });
        return { name, match: match ?? null };
      } catch {
        return { name, match: null };
      }
    })
  );

  const canonicalIdByName = new Map<string, string>();
  const clustersById = new Map<string, CityCluster>();

  for (const { name, match } of geocoded) {
    if (!match) continue;
    const canonicalId = buildCityCanonicalId(isoA2, match.lat, match.lon);
    canonicalIdByName.set(name, canonicalId);

    const existing = clustersById.get(canonicalId);
    if (!existing) {
      clustersById.set(canonicalId, { canonicalId, displayName: name });
      continue;
    }
    // Prefer a Hebrew-script display name once any cluster member has one —
    // this is a Hebrew-UI app (spec §A3): show one name, not "Tbilisi / טביליסי".
    if (!HEBREW_PATTERN.test(existing.displayName) && HEBREW_PATTERN.test(name)) {
      existing.displayName = name;
    }
  }

  if (canonicalIdByName.size === 0) return days;

  return days.map((day) => {
    const originalName = day.cityRegion?.trim();
    if (!originalName) return day;
    const canonicalId = canonicalIdByName.get(originalName);
    if (!canonicalId) return day;
    const cluster = clustersById.get(canonicalId);
    return {
      ...day,
      cityRegion: cluster?.displayName ?? day.cityRegion,
      cityCanonicalId: canonicalId,
    };
  });
}
