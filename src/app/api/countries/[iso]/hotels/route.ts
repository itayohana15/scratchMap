import { NextResponse } from "next/server";

import { findHotelCandidates, rankHotels } from "@/lib/hotels";

const RADIUS_METERS = 2500;
const CANDIDATE_LIMIT = 20;
const RANKED_LIMIT = 10;

function parseCoordPairs(value: string | null): Array<{ lat: number; lon: number }> {
  if (!value) return [];
  return value
    .split(";")
    .map((pair) => {
      const [latText, lonText] = pair.split(",");
      const lat = Number(latText);
      const lon = Number(lonText);
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    })
    .filter((entry): entry is { lat: number; lon: number } => entry != null);
}

/**
 * Real hotel candidates near a trip phase's own activity area, ranked by
 * real travel time to the trip's planned activities and (optionally) the
 * relevant airport — spec items 26/28. Same "no paid API, honest
 * unavailable labels for price/rating" pattern as every other place-data
 * route in this app (see src/lib/hotels.ts).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const activityClusters = parseCoordPairs(searchParams.get("activityClusters"));
  const transferAnchors = parseCoordPairs(searchParams.get("transferAnchors"));
  const airportLat = Number(searchParams.get("airportLat"));
  const airportLon = Number(searchParams.get("airportLon"));
  const airportCoords =
    Number.isFinite(airportLat) && Number.isFinite(airportLon) ? { lat: airportLat, lon: airportLon } : null;

  const candidates = await findHotelCandidates(lat, lon, RADIUS_METERS, CANDIDATE_LIMIT);
  const ranked = rankHotels(candidates, activityClusters, airportCoords, transferAnchors).slice(0, RANKED_LIMIT);

  return NextResponse.json({
    hotels: ranked,
    meta: {
      source: "OpenStreetMap (Overpass API)",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      radiusMeters: RADIUS_METERS,
      retrievedAt: new Date().toISOString(),
      priceDataAvailable: false,
      ratingDataAvailable: false,
    },
  });
}
