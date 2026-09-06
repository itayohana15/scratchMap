import { NextResponse } from "next/server";

import { findFoodCandidates, rankFoodPlaces, type FoodMealSlot } from "@/lib/food";

const RADIUS_METERS = 1500;
const CANDIDATE_LIMIT = 20;
const RANKED_LIMIT = 10;

const VALID_SLOTS = new Set<FoodMealSlot>(["breakfast", "lunch", "dinner", "cafe"]);

/**
 * Real, route-aware food candidates near a specific day's own activity
 * anchor (browser QA Parts U-W) — same "no paid API, honest unavailable
 * price/rating labels" pattern as /api/countries/[iso]/hotels.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const slotParam = searchParams.get("slot");
  const slot: FoodMealSlot = slotParam && VALID_SLOTS.has(slotParam as FoodMealSlot) ? (slotParam as FoodMealSlot) : "lunch";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const candidates = await findFoodCandidates(lat, lon, RADIUS_METERS, CANDIDATE_LIMIT);
  const ranked = rankFoodPlaces(candidates, { lat, lon }, slot).slice(0, RANKED_LIMIT);

  return NextResponse.json({
    places: ranked,
    meta: {
      source: "OpenStreetMap (Overpass API)",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      radiusMeters: RADIUS_METERS,
      slot,
      retrievedAt: new Date().toISOString(),
      priceDataAvailable: false,
      ratingDataAvailable: false,
    },
  });
}
