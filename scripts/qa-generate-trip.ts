/**
 * Standalone QA harness — generates a real itinerary through the actual
 * production pipeline (real Overpass recommendations, real Gemini calls,
 * the real repairPlan loop) without needing a running Next.js dev server.
 * Not part of the app itself; not wired into any build step. Run via:
 *   npx tsc -p tsconfig.itinerary-tests.json && \
 *   node --require ./tests/register-path-alias.cjs .test-dist/scripts/qa-generate-trip.js <scenario>
 */
import { categoryHasOpenDataSource, queryOverpassPlaces } from "@/lib/places/overpass";
import { aggregateOverpassStatus } from "@/lib/provider-status";
import {
  findAirportsForCountry,
  findDefaultAirportForCountry,
} from "@/lib/facts/airports-data";
import { generateCountryItineraryPlan } from "@/lib/server/country-itinerary-generation";
import {
  createEmptyFlightLeg,
  type AiItineraryRequest,
  type RecommendationCategory,
  type TripFlightLeg,
  type TripPreferences,
  type TripRecommendation,
} from "@/lib/trip-workspace";

const OPEN_DATA_CATEGORIES: RecommendationCategory[] = [
  "attraction",
  "restaurant",
  "cafe",
  "museum",
  "nature",
  "shopping",
  "nightlife",
  "family",
  "hotel",
];

interface RealRecommendationsResult {
  recommendations: TripRecommendation[];
  // Section B: aggregated from each category's REAL request outcome, never
  // from candidate count — mirrors what the production wizard now does in
  // fetchLiveRecommendations.
  overpassAvailable: "available" | "unavailable" | "partial" | null;
}

async function fetchRealRecommendations(iso: string, perCategory = 14): Promise<RealRecommendationsResult> {
  const results: TripRecommendation[] = [];
  const outcomes: boolean[] = [];
  for (const category of OPEN_DATA_CATEGORIES) {
    if (!categoryHasOpenDataSource(category)) continue;
    try {
      const { places, succeeded } = await queryOverpassPlaces(iso, category, perCategory);
      outcomes.push(succeeded);
      for (const place of places) {
        results.push({
          id: `osm:${category}:${place.name}`,
          name: place.name,
          category,
          location: place.name,
          shortDescription: place.description ?? "",
          estimatedDurationMinutes: null,
          approximatePrice: null,
          openingHours: place.openingHours ?? "",
          recommendedTimeOfDay: "any",
          reservationRequired: false,
          mapLink: "",
          imageUrl: "",
          imageQuery: "",
          lat: place.lat,
          lon: place.lon,
          source: "api",
          wikipediaUrl: place.wikipediaUrl,
          website: place.website,
          wheelchairAccessible: place.wheelchairAccessible,
          isFree: place.isFree,
        });
      }
    } catch (error) {
      outcomes.push(false);
      console.error(`  [warn] failed to fetch ${category} for ${iso}:`, (error as Error).message);
    }
  }
  return { recommendations: results, overpassAvailable: aggregateOverpassStatus(outcomes) };
}

function buildFlightLeg(args: {
  departureAirport: string;
  arrivalAirport: string;
  departureDate: string;
  departureTime: string;
}): TripFlightLeg {
  return {
    ...createEmptyFlightLeg(),
    departureAirport: args.departureAirport,
    arrivalAirport: args.arrivalAirport,
    departureDate: args.departureDate,
    departureTime: args.departureTime,
  };
}

const BASE_PREFERENCES: TripPreferences = {
  startDate: "",
  endDate: "",
  partialDate: "",
  travelers: 2,
  budget: null,
  tripStyle: "sightseeing, culture, food",
  tripPace: "balanced",
  generationMode: "balanced",
  interests: "history, local neighborhoods, nature, food",
  transportationPreferences: "",
  accommodationArea: "",
  dietaryPreferences: "",
  foodNotes: "",
  accessibilityNeeds: "",
  preferredRegions: "",
  mustVisitPlaces: "",
  placesToAvoid: "",
  safetyConstraints: "",
};

interface Scenario {
  key: string;
  iso: string;
  countryName: string;
  startDate: string;
  endDate: string;
  budget: number;
  travelers: number;
  outboundArrivalTime?: string;
  returnDepartureTime?: string;
  extraRecommendations?: TripRecommendation[];
}

function buildScenarios(): Record<string, Scenario> {
  return {
    israel: {
      key: "israel",
      iso: "IL",
      countryName: "Israel",
      startDate: "2026-11-02",
      endDate: "2026-11-11",
      budget: 12000,
      travelers: 2,
    },
    georgia: {
      key: "georgia",
      iso: "GE",
      countryName: "Georgia",
      startDate: "2026-10-05",
      endDate: "2026-10-14",
      budget: 16000,
      travelers: 2,
    },
    japan: {
      key: "japan",
      iso: "JP",
      countryName: "Japan",
      startDate: "2026-10-01",
      endDate: "2026-10-21",
      budget: 60000,
      travelers: 2,
    },
    france: {
      key: "france",
      iso: "FR",
      countryName: "France",
      startDate: "2026-09-10",
      endDate: "2026-09-16",
      budget: 20000,
      travelers: 2,
      extraRecommendations: [
        {
          id: "manual:disneyland-paris",
          name: "Disneyland Paris",
          category: "attraction",
          location: "Marne-la-Vallée",
          shortDescription: "Full-day theme park with two parks (Disneyland Park and Walt Disney Studios).",
          estimatedDurationMinutes: null,
          approximatePrice: 90,
          openingHours: "09:30-21:00",
          recommendedTimeOfDay: "any",
          reservationRequired: false,
          mapLink: "",
          imageUrl: "",
          imageQuery: "",
          lat: 48.8672,
          lon: 2.7808,
          source: "manual",
          wikipediaUrl: null,
          website: null,
          wheelchairAccessible: null,
          isFree: false,
        },
      ],
    },
    citybreak: {
      key: "citybreak",
      iso: "PT",
      countryName: "Portugal",
      startDate: "2026-09-24",
      endDate: "2026-09-27",
      budget: 6000,
      travelers: 2,
    },
    arrivalDeparture: {
      key: "arrivalDeparture",
      iso: "GR",
      countryName: "Greece",
      startDate: "2026-10-08",
      endDate: "2026-10-12",
      budget: 8500,
      travelers: 2,
      outboundArrivalTime: "19:35",
      returnDepartureTime: "10:40",
    },
  };
}

async function runScenario(scenario: Scenario) {
  console.log(`\n=== ${scenario.key} (${scenario.countryName}, ${scenario.iso}) ===`);
  console.log(`Dates: ${scenario.startDate} -> ${scenario.endDate}, budget ${scenario.budget}, travelers ${scenario.travelers}`);

  console.log("Fetching real OSM recommendations...");
  // Section B4: the REAL provider signal, aggregated from each category's
  // own actual request outcome — never a separate probe, never inferred
  // from recommendations.length (which the France scenario's manually-
  // injected Disneyland Paris entry would otherwise make look like a
  // successful Overpass fetch).
  const { recommendations, overpassAvailable } = await fetchRealRecommendations(scenario.iso);
  if (scenario.extraRecommendations) recommendations.push(...scenario.extraRecommendations);
  console.log(`Got ${recommendations.length} real candidates. Overpass available: ${overpassAvailable}.`);

  const homeAirport = findDefaultAirportForCountry("IL")?.iata ?? "TLV";
  const destinationAirport = findDefaultAirportForCountry(scenario.iso)?.iata ?? findAirportsForCountry(scenario.iso)[0]?.iata ?? "";

  // A trip whose destination IS the home country (the "israel" scenario —
  // this app's home country is always IL) is a domestic trip, not an
  // international flight — the traveler is already there. Synthesizing an
  // outbound/return leg with home===destination airport used to fabricate
  // a same-airport "flight" that isn't real, which detectInvalidFlightLegs
  // (correctly) now flags. No flights is the realistic representation.
  const isDomesticTrip = scenario.iso.toUpperCase() === "IL";

  const outbound = isDomesticTrip
    ? null
    : buildFlightLeg({
        departureAirport: homeAirport,
        arrivalAirport: destinationAirport,
        departureDate: scenario.startDate,
        departureTime: scenario.outboundArrivalTime ? "16:30" : "09:00",
      });
  // Arrival time is DERIVED by the app from duration, not settable directly
  // here — for the late-arrival scenario we instead just set a departure
  // time late enough that even a short flight lands after 18:00.
  const inbound = isDomesticTrip
    ? null
    : buildFlightLeg({
        departureAirport: destinationAirport,
        arrivalAirport: homeAirport,
        departureDate: scenario.endDate,
        departureTime: scenario.returnDepartureTime ?? "17:00",
      });

  const preferences: TripPreferences = {
    ...BASE_PREFERENCES,
    startDate: scenario.startDate,
    endDate: scenario.endDate,
    budget: scenario.budget,
    travelers: scenario.travelers,
    flights: { outbound, return: inbound },
  };

  const payload: AiItineraryRequest = {
    countryId: `qa-${scenario.iso.toLowerCase()}`,
    countryName: scenario.countryName,
    isoA2: scenario.iso,
    tripStatus: "planning",
    preferences,
    selectedPlaces: [],
    recommendations,
    bookings: [],
    existingDays: [],
    overpassAvailable,
  };

  console.log("Generating itinerary (real Gemini calls, may take a while)...");
  const start = Date.now();
  const result = await generateCountryItineraryPlan(payload);
  const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${elapsedSeconds}s.`);
  return result;
}

async function main() {
  const scenarios = buildScenarios();
  const requestedKeys = process.argv.slice(2);
  const keys = requestedKeys.length > 0 ? requestedKeys : Object.keys(scenarios);

  for (const key of keys) {
    const scenario = scenarios[key];
    if (!scenario) {
      console.error(`Unknown scenario: ${key}`);
      continue;
    }
    try {
      const result = await runScenario(scenario);
      const fs = await import("node:fs/promises");
      const outPath = `/tmp/claude-1000/-home-hilma-Desktop-scratchMap/5cbfe97d-b2b2-4556-b735-9f91521c79f0/scratchpad/qa-${scenario.key}.json`;
      await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
      console.log(`Written to ${outPath}`);
    } catch (error) {
      console.error(`Scenario ${key} FAILED:`, error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
