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

interface NominatimResult {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
}

export async function searchPlaces(
  query: string,
  opts: { countryCode?: string; limit?: number } = {}
): Promise<GeocodedPlace[]> {
  const params = new URLSearchParams({
    format: "json",
    q: query,
    limit: String(opts.limit ?? 5),
  });
  if (opts.countryCode) params.set("countrycodes", opts.countryCode.toLowerCase());

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "he" },
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!res.ok) throw new Error(`Nominatim request failed (${res.status})`);

  const data = (await res.json()) as NominatimResult[];
  return data.map((item) => ({
    name: item.name || item.display_name.split(",")[0],
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
  }));
}
