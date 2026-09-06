import { GoogleGenAI, Type } from "@google/genai";
import isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import {
  buildMapLink,
  type DayPart,
  type RecommendationCategory,
  type TripRecommendation,
} from "@/lib/trip-workspace";
import { searchPlaces } from "@/lib/places/nominatim";
import { categoryHasOpenDataSource, queryOverpassPlaces } from "@/lib/places/overpass";
import { startFixtureCaptureSession } from "@/lib/server/fixture-capture";
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";

isoCountries.registerLocale(enLocale);

const DEFAULT_COUNT = 10;
const MAX_COUNT = 14;
const OPEN_SOURCE_NAME = "OpenStreetMap (Overpass API)";
const OPEN_SOURCE_URL = "https://www.openstreetmap.org/copyright";
const FALLBACK_SOURCE_NAME = "Gemini + Nominatim";
const FALLBACK_SOURCE_URL = "https://nominatim.openstreetmap.org/";
const GEMINI_MODEL = "gemini-flash-lite-latest";

const CATEGORY_VALUES = new Set<RecommendationCategory>([
  "attraction",
  "restaurant",
  "cafe",
  "museum",
  "nature",
  "shopping",
  "nightlife",
  "family",
  "hidden_gem",
  "day_trip",
  "seasonal_event",
  "hotel",
  "transportation",
]);

const CATEGORY_BRIEFS: Record<RecommendationCategory, string> = {
  attraction: "landmarks, famous attractions, scenic viewpoints, and iconic districts",
  restaurant: "restaurants truly worth planning around",
  cafe: "cafes and coffee spots worth visiting",
  museum: "museums, galleries, and cultural institutions",
  nature: "parks, gardens, beaches, reserves, and natural sites",
  shopping: "shopping streets, markets, department stores, and malls",
  nightlife: "bars, nightlife streets, live-music venues, and evening hangouts",
  family: "family-friendly attractions such as parks, aquariums, zoos, and theme experiences",
  hidden_gem: "lesser-known but real places locals would still recommend",
  day_trip: "real day-trip destinations reachable from a major base in the country",
  seasonal_event: "seasonal events or seasonal places especially worth visiting in the requested period",
  hotel: "hotels, ryokans, or resorts genuinely worth staying at",
  transportation: "major traveler-relevant transport hubs such as airports, central stations, and ferry terminals",
  // Not requested via CATEGORY_VALUES below (practical/luggage tasks are
  // user- or template-generated, never AI-sourced) — kept only so the
  // Record<RecommendationCategory, ...> stays exhaustive.
  practical: "practical logistics tasks such as luggage storage or hotel transfers",
};

interface FallbackRecommendationSeed {
  name: string;
  location: string;
  shortDescription: string;
  openingHours?: string;
  approximatePrice?: number;
}

const FALLBACK_DEFAULTS: Record<
  RecommendationCategory,
  {
    estimatedDurationMinutes: number | null;
    recommendedTimeOfDay: DayPart | "any";
    reservationRequired: boolean;
  }
> = {
  attraction: { estimatedDurationMinutes: 120, recommendedTimeOfDay: "morning", reservationRequired: false },
  restaurant: { estimatedDurationMinutes: 90, recommendedTimeOfDay: "dinner", reservationRequired: true },
  cafe: { estimatedDurationMinutes: 60, recommendedTimeOfDay: "lunch", reservationRequired: false },
  museum: { estimatedDurationMinutes: 120, recommendedTimeOfDay: "morning", reservationRequired: false },
  nature: { estimatedDurationMinutes: 180, recommendedTimeOfDay: "morning", reservationRequired: false },
  shopping: { estimatedDurationMinutes: 150, recommendedTimeOfDay: "afternoon", reservationRequired: false },
  nightlife: { estimatedDurationMinutes: 180, recommendedTimeOfDay: "night", reservationRequired: true },
  family: { estimatedDurationMinutes: 180, recommendedTimeOfDay: "afternoon", reservationRequired: false },
  hidden_gem: { estimatedDurationMinutes: 120, recommendedTimeOfDay: "morning", reservationRequired: false },
  day_trip: { estimatedDurationMinutes: 420, recommendedTimeOfDay: "morning", reservationRequired: false },
  seasonal_event: { estimatedDurationMinutes: 120, recommendedTimeOfDay: "evening", reservationRequired: true },
  hotel: { estimatedDurationMinutes: null, recommendedTimeOfDay: "any", reservationRequired: false },
  transportation: { estimatedDurationMinutes: 45, recommendedTimeOfDay: "any", reservationRequired: false },
  practical: { estimatedDurationMinutes: 30, recommendedTimeOfDay: "any", reservationRequired: false },
};

function clampCount(raw: string | null) {
  const parsed = raw ? Number(raw) : DEFAULT_COUNT;
  if (!Number.isFinite(parsed)) return DEFAULT_COUNT;
  return Math.max(6, Math.min(MAX_COUNT, Math.floor(parsed)));
}

function dedupeRecommendations(input: TripRecommendation[]) {
  const seen = new Set<string>();
  return input.filter((recommendation) => {
    const key = `${recommendation.name.toLowerCase()}::${recommendation.location.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFallbackPriceGuidance(category: RecommendationCategory) {
  switch (category) {
    case "restaurant":
    case "cafe":
      return "For approximatePrice, use the usual average cost for one adult traveler in the local currency.";
    case "attraction":
    case "museum":
    case "nature":
    case "family":
    case "hidden_gem":
    case "day_trip":
    case "seasonal_event":
      return "For approximatePrice, use the usual adult ticket or entry price in the local currency. Use 0 when the place is typically free.";
    case "hotel":
      return "For approximatePrice, use a typical nightly rate in the local currency.";
    case "transportation":
      return "For approximatePrice, use a typical one-way traveler price in the local currency.";
    default:
      return "For approximatePrice, use a realistic typical traveler cost in the local currency when it is known.";
  }
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

const getFallbackSeeds = unstable_cache(
  async (
    englishCountryName: string,
    category: RecommendationCategory,
    count: number,
    startDate: string | null,
    endDate: string | null
  ): Promise<FallbackRecommendationSeed[]> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Actionable (the fix is setting the env var), not routine progress
      // noise — kept as a real warning rather than gated behind a QA flag.
      console.warn("[Recommendations] GEMINI_API_KEY is not configured — skipping fallback seeds");
      return [];
    }

    const client = new GoogleGenAI({ apiKey });
    const priceGuidance = buildFallbackPriceGuidance(category);
    const dateClause =
      startDate || endDate
        ? `The trip dates are from ${startDate ?? "unknown start"} to ${endDate ?? "unknown end"}. Adapt choices to that season when it matters.`
        : "No exact travel dates were provided, so choose broadly worthwhile options.";

    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: `You are a precise travel researcher.
Country: ${englishCountryName}.
Category: ${category} (${CATEGORY_BRIEFS[category]}).
Need: ${count} real, specific, map-searchable recommendations.
${dateClause}

Rules:
- Every recommendation must be a real named place, venue, site, route anchor, station, hotel, or event that a traveler can search on a map.
- "name" must stay in its common English or local map-searchable form.
- All other user-facing text fields must be in Hebrew.
- Avoid duplicates and generic regions unless there is no more specific destination.
- Keep the shortDescription to one concise sentence.
- openingHours should be a short Hebrew string when known, such as "09:00-18:00", "24/7", or "א'-ה' 12:00-22:00".
- ${priceGuidance}
- If price is unknown, omit approximatePrice.
- If opening hours are unknown, return an empty string.
- Return only real places, not explanations.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              location: { type: Type.STRING },
              shortDescription: { type: Type.STRING },
              openingHours: { type: Type.STRING },
              approximatePrice: { type: Type.NUMBER },
            },
            required: ["name", "location", "shortDescription"],
          },
        },
      },
    });

    const raw = response.text;
    if (!raw) {
      if (isPlannerQaTraceEnabled()) {
        console.log("[Recommendations] Gemini returned an empty response for seeds", {
          category,
          englishCountryName,
        });
      }
      return [];
    }
    const parsed = JSON.parse(raw) as Array<{
      name?: string;
      location?: string;
      shortDescription?: string;
      openingHours?: string;
      approximatePrice?: number;
    }>;

    const seeds = parsed
      .map((item) => ({
        name: item.name?.trim() ?? "",
        location: item.location?.trim() ?? "",
        shortDescription: item.shortDescription?.trim() ?? "",
        openingHours: normalizeOptionalString(item.openingHours),
        approximatePrice: normalizeOptionalNumber(item.approximatePrice) ?? undefined,
      }))
      .filter((item) => item.name.length > 0)
      // Nominatim geocoding is now rate-limit-safe (throttled in
      // nominatim.ts) rather than lossy, so this only needs a small margin
      // for genuinely un-geocodable seeds — not the 2x buffer that used to
      // compensate for 429s eating a chunk of every batch.
      .slice(0, Math.ceil(count * 1.3));

    if (isPlannerQaTraceEnabled()) {
      console.log("[Recommendations] Gemini seeds generated", {
        category,
        englishCountryName,
        rawParsedCount: parsed.length,
        keptSeedCount: seeds.length,
      });
    }

    return seeds;
  },
  ["country-category-recommendation-seeds-v2"],
  { revalidate: 60 * 60 * 24 * 30 }
);

async function buildFallbackRecommendations(
  isoA2: string,
  englishCountryName: string,
  category: RecommendationCategory,
  count: number,
  startDate: string | null,
  endDate: string | null
) {
  const defaults = FALLBACK_DEFAULTS[category];
  const seeds = await getFallbackSeeds(
    englishCountryName,
    category,
    count,
    startDate,
    endDate
  ).catch((error) => {
    // A genuine exception, not routine progress — kept visible as a real
    // error rather than gated behind a QA flag.
    console.error("[Recommendations] getFallbackSeeds threw", {
      category,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });

  let geocodeFailures = 0;
  const results = (
    await Promise.all(
      seeds.map(async (seed, index): Promise<TripRecommendation | null> => {
        try {
          // Include the seed's own city/area (required by the Gemini
          // schema above) in the geocoding query, not just the bare place
          // name — otherwise a same-named place in the wrong city within
          // the country can silently win the match. Fall back to the bare
          // name only if the city-qualified query finds nothing.
          const qualifiedQuery = seed.location ? `${seed.name}, ${seed.location}` : seed.name;
          const qualifiedResults = await searchPlaces(qualifiedQuery, { countryCode: isoA2, limit: 1 });
          const match =
            qualifiedResults[0] ??
            (qualifiedQuery !== seed.name
              ? (await searchPlaces(seed.name, { countryCode: isoA2, limit: 1 }))[0]
              : undefined);
          if (!match) {
            geocodeFailures += 1;
            return null;
          }

          return {
            id: `fallback-${category}-${index}-${seed.name}`,
            name: seed.name,
            category,
            location: seed.location || match.name,
            shortDescription: seed.shortDescription,
            estimatedDurationMinutes: defaults.estimatedDurationMinutes,
            approximatePrice: seed.approximatePrice ?? null,
            openingHours: seed.openingHours ?? "",
            recommendedTimeOfDay: defaults.recommendedTimeOfDay,
            reservationRequired: defaults.reservationRequired,
            mapLink: buildMapLink(seed.name, match.lat, match.lon),
            imageUrl: "",
            imageQuery: seed.name,
            lat: match.lat,
            lon: match.lon,
            source: "ai",
            wikipediaUrl: null,
            website: null,
            wheelchairAccessible: null,
            isFree: null,
          };
        } catch (error) {
          // A genuine exception, not routine progress — kept visible as a
          // real error rather than gated behind a QA flag.
          console.error("[Recommendations] Nominatim geocoding threw for a seed", {
            category,
            seedName: seed.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })
    )
  ).filter((item): item is TripRecommendation => item != null);

  if (isPlannerQaTraceEnabled() && seeds.length > 0) {
    console.log("[Recommendations] fallback geocoding summary", {
      category,
      seedCount: seeds.length,
      geocodeFailures,
      matchedCount: results.length,
    });
  }

  return dedupeRecommendations(results).slice(0, count);
}

export async function GET(request: Request, { params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  const isoA2 = iso.toUpperCase();
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") as RecommendationCategory | null;
  const count = clampCount(searchParams.get("count"));
  const startDate = searchParams.get("start");
  const endDate = searchParams.get("end");
  const retrievedAt = new Date().toISOString();

  if (!category) {
    return NextResponse.json(
      { error: "MISSING_CATEGORY", message: "Query parameter 'category' is required." },
      { status: 400 }
    );
  }
  if (!CATEGORY_VALUES.has(category)) {
    return NextResponse.json(
      {
        error: "UNSUPPORTED_CATEGORY",
        message: `This endpoint does not serve AI-sourced recommendations for category "${category}". Supported categories: ${[...CATEGORY_VALUES].join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const englishCountryName = isoCountries.getName(isoA2, "en") ?? isoA2;
  startFixtureCaptureSession(isoA2, { isoA2, countryName: englishCountryName, startDate, endDate });
  const openSourceAvailable = categoryHasOpenDataSource(category);

  // Section B2: the real request outcome, kept apart from "does this
  // category even have a data source" (openSourceAvailable, a static
  // per-category fact) and from "how many places came back" — a category
  // with no source at all is neither available nor unavailable as a
  // PROVIDER signal, it's simply not queried.
  const overpassOutcome = openSourceAvailable
    ? await queryOverpassPlaces(isoA2, category, count)
    : null;
  const overpassPlaces = overpassOutcome?.places ?? [];

  const openSourceRecommendations: TripRecommendation[] = overpassPlaces.map((place, index) => ({
    id: `api-${category}-${index}-${place.name}`,
    name: place.name,
    category,
    location: "",
    shortDescription: place.description ?? (place.cuisine ? `מטבח: ${place.cuisine}` : ""),
    estimatedDurationMinutes: null,
    approximatePrice: null,
    openingHours: place.openingHours ?? "",
    recommendedTimeOfDay: "any",
    reservationRequired: false,
    mapLink: buildMapLink(place.name, place.lat, place.lon),
    imageUrl: "",
    imageQuery: place.name,
    lat: place.lat,
    lon: place.lon,
    source: "api" as const,
    wikipediaUrl: place.wikipediaUrl,
    website: place.website,
    wheelchairAccessible: place.wheelchairAccessible,
    isFree: place.isFree,
  }));

  const fallbackRecommendations =
    openSourceRecommendations.length >= count
      ? []
      : await buildFallbackRecommendations(
          isoA2,
          englishCountryName,
          category,
          count - openSourceRecommendations.length,
          startDate,
          endDate
        );

  const places = dedupeRecommendations([
    ...openSourceRecommendations,
    ...fallbackRecommendations,
  ]).slice(0, count);

  const source =
    openSourceRecommendations.length > 0 && fallbackRecommendations.length > 0
      ? `${OPEN_SOURCE_NAME} + ${FALLBACK_SOURCE_NAME}`
      : openSourceRecommendations.length > 0
        ? OPEN_SOURCE_NAME
        : fallbackRecommendations.length > 0
          ? FALLBACK_SOURCE_NAME
          : openSourceAvailable
            ? OPEN_SOURCE_NAME
            : FALLBACK_SOURCE_NAME;

  const sourceUrl =
    openSourceRecommendations.length > 0 && fallbackRecommendations.length > 0
      ? OPEN_SOURCE_URL
      : openSourceRecommendations.length > 0
        ? OPEN_SOURCE_URL
        : fallbackRecommendations.length > 0
          ? FALLBACK_SOURCE_URL
          : openSourceAvailable
            ? OPEN_SOURCE_URL
            : FALLBACK_SOURCE_URL;

  return NextResponse.json({
    places,
    meta: {
      category,
      count: places.length,
      available: places.length > 0,
      reason: places.length > 0 ? null : "no-reliable-free-source",
      source,
      sourceUrl,
      retrievedAt,
      // Section B2 — the REAL Overpass request outcome for this category,
      // never inferred from places.length: null when this category has no
      // open-data source at all (nothing was ever queried), true when the
      // request itself succeeded (even with zero legitimate results),
      // false only on a genuine network/provider failure.
      overpassSucceeded: overpassOutcome?.succeeded ?? null,
    },
  });
}
