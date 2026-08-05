import { NextResponse } from "next/server";

import { queryNearbyPlaces } from "@/lib/places/overpass";

const RADIUS_METERS = 1200;
const PER_CATEGORY_LIMIT = 4;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const places = await queryNearbyPlaces(lat, lon, RADIUS_METERS, PER_CATEGORY_LIMIT);

  return NextResponse.json({
    places,
    meta: {
      source: "OpenStreetMap (Overpass API)",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      radiusMeters: RADIUS_METERS,
      retrievedAt: new Date().toISOString(),
    },
  });
}
