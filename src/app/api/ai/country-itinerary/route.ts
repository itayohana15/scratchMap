import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { generateCountryItineraryPlan } from "@/lib/server/country-itinerary-generation";
import { createClient } from "@/lib/supabase/server";
import type { AiItineraryRequest } from "@/lib/trip-workspace";

export async function POST(request: Request) {
  let payload: AiItineraryRequest;
  try {
    payload = (await request.json()) as AiItineraryRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!payload.countryId || !payload.countryName || !payload.isoA2) {
    return NextResponse.json(
      { error: "countryId, countryName and isoA2 are required" },
      { status: 400 }
    );
  }

  try {
    const supabase = await createClient();
    const { data: guideRow } = await supabase
      .from("ai_recommendations")
      .select("content")
      .eq("iso_a2", payload.isoA2.toUpperCase())
      .maybeSingle();

    const guide = guideRow?.content
      ? normalizeCountryAiRecommendation(guideRow.content, payload.countryName)
      : null;

    const generated = await generateCountryItineraryPlan(payload, guide);
    return NextResponse.json(generated);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create itinerary" },
      { status: 500 }
    );
  }
}
