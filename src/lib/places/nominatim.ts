// Server-only helper around OpenStreetMap's free Nominatim geocoding API.
// Nominatim's usage policy asks for a real User-Agent identifying the app
// and discourages high-volume client-side use — both are why this lives
// behind our own API routes rather than being called directly from the
// browser.
export interface GeocodedPlace {
  name: string;
  lat: number;
  lon: number;
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
  return data.map((item) => ({
    name: item.name || item.display_name.split(",")[0],
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
  }));
}
