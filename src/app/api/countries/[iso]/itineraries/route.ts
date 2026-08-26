import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { buildCountryItinerarySuccessPayload } from "@/lib/itineraries";
import { ItineraryGenerationInfeasibleError } from "@/lib/server/country-itinerary-generation";
import { listCountryItineraries, generateAndStoreCountryItinerary } from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiItineraryRequest } from "@/lib/trip-workspace";

function devLog(message: string, details?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  if (details) console.log(`[Itinerary] ${message}`, details);
  else console.log(`[Itinerary] ${message}`);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string }> }
) {
  const { iso } = await params;
  const supabase = createAdminClient();

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
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Request body is not valid JSON." },
      { status: 400 }
    );
  }

  devLog("request received", {
    isoA2: iso.toUpperCase(),
    clientRequestId: payload.clientRequestId,
    startDate: payload.preferences?.startDate,
    endDate: payload.preferences?.endDate,
    travelers: payload.preferences?.travelers,
    budget: payload.preferences?.budget,
  });

  const supabase = createAdminClient();

  const { data: country, error: countryError } = await supabase
    .from("countries")
    .select("*")
    .eq("iso_a2", iso.toUpperCase())
    .maybeSingle();
  if (countryError) {
    devLog("failed at country lookup", { message: countryError.message });
    return NextResponse.json(
      { error: "DATABASE_ERROR", message: countryError.message },
      { status: 500 }
    );
  }
  if (!country) {
    return NextResponse.json(
      { error: "COUNTRY_NOT_FOUND", message: `No country found for ISO "${iso}".` },
      { status: 404 }
    );
  }
  devLog("validated");

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

    devLog("database save complete", { itineraryId: itinerary.id });

    return NextResponse.json({
      itinerary,
      success: buildCountryItinerarySuccessPayload(itinerary, country.name),
    });
  } catch (error) {
    if (error instanceof ItineraryGenerationInfeasibleError) {
      devLog("failed — plan not feasible", { code: error.code, message: error.message });
      return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    // Unexpected — always logged server-side, never silently swallowed.
    console.error("[Itinerary] failed at generation/save stage:", error);
    return NextResponse.json(
      {
        error: "GENERATION_FAILED",
        message: error instanceof Error ? error.message : "Failed to generate itinerary",
      },
      { status: 500 }
    );
  }
}
