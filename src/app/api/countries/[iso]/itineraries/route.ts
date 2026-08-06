import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { listCountryItineraries, generateAndStoreCountryItinerary } from "@/lib/server/country-itineraries";
import { createClient } from "@/lib/supabase/server";
import type { AiItineraryRequest } from "@/lib/trip-workspace";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string }> }
) {
  const { iso } = await params;
  const supabase = await createClient();

  try {
    const itineraries = await listCountryItineraries(supabase, iso);
    return NextResponse.json({ itineraries });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list itineraries" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ iso: string }> }
) {
  const { iso } = await params;
  let payload: AiItineraryRequest;
  try {
    payload = (await request.json()) as AiItineraryRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: country, error: countryError } = await supabase
    .from("countries")
    .select("*")
    .eq("iso_a2", iso.toUpperCase())
    .maybeSingle();
  if (countryError) {
    return NextResponse.json({ error: countryError.message }, { status: 500 });
  }
  if (!country) {
    return NextResponse.json({ error: "Country not found" }, { status: 404 });
  }

  try {
    const { data: guideRow } = await supabase
      .from("ai_recommendations")
      .select("content")
      .eq("iso_a2", iso.toUpperCase())
      .maybeSingle();
    const guide = guideRow?.content
      ? normalizeCountryAiRecommendation(guideRow.content, country.name)
      : null;

    const itinerary = await generateAndStoreCountryItinerary(
      supabase,
      country,
      {
        ...payload,
        countryId: country.id,
        countryName: country.name,
        isoA2: country.iso_a2,
      },
      guide
    );

    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate itinerary" },
      { status: 500 }
    );
  }
}
