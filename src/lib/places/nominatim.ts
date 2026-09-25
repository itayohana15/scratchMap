// Server-only helper around OpenStreetMap's free Nominatim geocoding API.
// Nominatim's usage policy asks for a real User-Agent identifying the app
// and discourages high-volume client-side use — both are why this lives
// behind our own API routes rather than being called directly from the
// browser.
import { captureProviderFixture } from "@/lib/server/fixture-capture";

export interface GeocodedPlace {
  name: string;
  lat: number;
  lon: number;
  // Round 9.4 §B — Nominatim's own response already carries these
  // (osm_type/class/type/address) but this wrapper used to discard them
  // entirely, keeping only name/lat/lon. That is the exact reason a case
  // like "White Mountains Community College" being resolved as a STAY
  // could never be diagnosed before: nothing recorded WHY the top search
  // result was an amenity=college rather than a genuine place=town/city.
  // Purely additive/optional — no existing caller reads these, so nothing
  // about current behavior changes; observability only (spec "do not fix
  // yet").
  osmType?: string;
  placeClass?: string;
  placeType?: string;
  adminPath?: string;
  // Round 9.6.2 — the raw address component keys (city/town/state/...),
  // additive alongside adminPath (which only ever joins the VALUES into one
  // display string and loses which key each one came from). Needed to
  // tell a genuine settlement match (its own address carries a city/town/
  // village key) apart from a broad administrative-region-only match
  // (state/country keys only) — see trip-stay-skeleton.ts's
  // isPracticalStayLocality.
  addressComponents?: Record<string, string>;
}

const USER_AGENT = "ScratchMap/1.0 (personal travel-tracking app, single user, low volume)";

// Nominatim's usage policy caps clients at ~1 request/second, but callers
// like the recommendations fallback geocode many seed places via
// `Promise.all` — a guaranteed 429 storm without this. A process-wide queue
// (rather than a per-call delay) serializes every `searchPlaces` call from
// every route that uses it, so no caller needs to know about the limit.
const MIN_REQUEST_INTERVAL_MS = 1100;
let requestQueue: Promise<unknown> = Promise.resolve();

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const value = await task();
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS));
    return value;
  });
  // Keep the chain alive even when one queued call rejects.
  requestQueue = result.catch(() => undefined);
  return result;
}

interface NominatimResult {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  osm_type?: string;
  class?: string;
  type?: string;
  address?: Record<string, string>;
}

export interface SearchPlacesOptions {
  countryCode?: string;
  limit?: number;
  /**
   * [minLon, minLat, maxLon, maxLat] — biases results toward this area (e.g.
   * a known base-city's surroundings) so a same-named place elsewhere in
   * the country is much less likely to be returned. Combine with `bounded`
   * to make it a hard restriction rather than just a preference.
   */
  viewbox?: [number, number, number, number];
  bounded?: boolean;
}

export async function searchPlaces(
  query: string,
  opts: SearchPlacesOptions = {}
): Promise<GeocodedPlace[]> {
  const params = new URLSearchParams({
    format: "json",
    q: query,
    limit: String(opts.limit ?? 5),
    // Round 9.4 §B — addressdetails=1 makes Nominatim include the admin
    // hierarchy (address.state/county/...) in its response; class/type/
    // osm_type are already present in the default response but were
    // previously discarded by the mapping below. Additive only — never
    // changes which results are returned or their order/ranking.
    addressdetails: "1",
  });
  if (opts.countryCode) params.set("countrycodes", opts.countryCode.toLowerCase());
  if (opts.viewbox) {
    params.set("viewbox", opts.viewbox.join(","));
    if (opts.bounded) params.set("bounded", "1");
  }

  const res = await throttled(() =>
    fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "he" },
      next: { revalidate: 60 * 60 * 24 },
    })
  );
  if (!res.ok) throw new Error(`Nominatim request failed (${res.status})`);

  const data = (await res.json()) as NominatimResult[];
  captureProviderFixture("geocode", `${query}|${params.toString()}`, { query, params: params.toString(), response: data });
  return data.map((item) => ({
    name: item.name || item.display_name.split(",")[0],
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    osmType: item.osm_type,
    placeClass: item.class,
    placeType: item.type,
    adminPath: item.address
      ? Object.entries(item.address)
          .filter(([key]) => key !== "country_code")
          .map(([, value]) => value)
          .join(" > ")
      : undefined,
    addressComponents: item.address,
  }));
}

/**
 * Round 9.6.5 §A — reverse geocoding, used ONLY to derive a practical
 * settlement/lodging base near a real destination CONCEPT that isn't
 * itself a settlement (a peninsula, an island's coastline point, a
 * mountain range, ...). zoom=10 asks Nominatim for the city/town-level
 * containing feature for that exact point (Nominatim's own documented
 * address-detail granularity), not the raw point itself — the same
 * "existing geocoding stack, no new provider" discipline searchPlaces
 * already follows. Same rate-limited queue, same house style; never
 * throws (mirrors searchPlaces' own callers' "never throw" expectation
 * via a null return, since every caller of this treats "nothing found"
 * as a normal, structurally-representable outcome, not an exception).
 */
export async function reverseGeocode(lat: number, lon: number, opts: { zoom?: number } = {}): Promise<GeocodedPlace | null> {
  const params = new URLSearchParams({
    format: "json",
    lat: String(lat),
    lon: String(lon),
    zoom: String(opts.zoom ?? 10),
    addressdetails: "1",
  });
  try {
    const res = await throttled(() =>
      fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "he" },
        next: { revalidate: 60 * 60 * 24 },
      })
    );
    if (!res.ok) return null;
    const item = (await res.json()) as (NominatimResult & { error?: string }) | null;
    if (!item || item.error || !item.lat || !item.lon) return null;
    captureProviderFixture("geocode", `reverse:${lat},${lon}|${params.toString()}`, { lat, lon, params: params.toString(), response: item });
    return {
      name: item.name || item.display_name?.split(",")[0] || "",
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
      osmType: item.osm_type,
      placeClass: item.class,
      placeType: item.type,
      adminPath: item.address
        ? Object.entries(item.address)
            .filter(([key]) => key !== "country_code")
            .map(([, value]) => value)
            .join(" > ")
        : undefined,
      addressComponents: item.address,
    };
  } catch {
    return null;
  }
}
