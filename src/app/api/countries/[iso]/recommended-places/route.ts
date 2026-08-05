import { GoogleGenAI, Type } from "@google/genai";
import isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import { searchPlaces } from "@/lib/places/nominatim";

isoCountries.registerLocale(enLocale);

interface RecommendedPlaceSeed {
  name: string;
  label: string;
}

// Ask Gemini (free tier) for a short list of specific, real, geocodable
// places worth visiting in a country, then resolve each to coordinates via
// Nominatim. Cached for 30 days per country — both the AI pick and the
// geocoding are effectively static.
const getRecommendedPlaceSeeds = unstable_cache(
  async (englishName: string): Promise<RecommendedPlaceSeed[]> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return [];
    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model: "gemini-flash-lite-latest",
        contents: `List the 6 most worthwhile specific places to visit in ${englishName} for a tourist — real, named, geocodable locations (cities, landmarks, natural sites), not generic categories or regions. For each, give its common English or local name (accurate enough to find on a map) and a short Hebrew label (2-4 words) for display to a Hebrew-speaking traveler.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: "Map-searchable English/local name" },
                label: { type: Type.STRING, description: "Short Hebrew display label" },
              },
              required: ["name", "label"],
            },
          },
        },
      });
      const text = response.text;
      if (!text) return [];
      return JSON.parse(text) as RecommendedPlaceSeed[];
    } catch {
      return [];
    }
  },
  ["country-recommended-place-seeds"],
  { revalidate: 60 * 60 * 24 * 30 }
);

export async function GET(_request: Request, { params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  const isoA2 = iso.toUpperCase();

  const englishName = isoCountries.getName(isoA2, "en");
  if (!englishName) {
    return NextResponse.json({ places: [] });
  }

  const seeds = await getRecommendedPlaceSeeds(englishName);

  const places = (
    await Promise.all(
      seeds.map(async (seed) => {
        try {
          const [match] = await searchPlaces(seed.name, { countryCode: isoA2, limit: 1 });
          if (!match) return null;
          return { label: seed.label, name: seed.name, lat: match.lat, lon: match.lon };
        } catch {
          return null;
        }
      })
    )
  ).filter(
    (place): place is { label: string; name: string; lat: number; lon: number } => place != null
  );

  return NextResponse.json({ places });
}
