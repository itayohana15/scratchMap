import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { regenerateCountryItinerary } from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiItineraryRequest, DayOptimizeMode } from "@/lib/trip-workspace";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { iso, itineraryId } = await params;
  let body: {
    scope?: NonNullable<AiItineraryRequest["regenerationScope"]>;
    targetDayId?: string | null;
    targetItemId?: string | null;
    optimizeMode?: DayOptimizeMode | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const scope = body.scope ?? "full";
  const supabase = createAdminClient();

  const [{ data: country }, { data: guideRow }] = await Promise.all([
    supabase.from("countries").select("name").eq("iso_a2", iso.toUpperCase()).maybeSingle(),
    supabase
      .from("ai_recommendations")
      .select("content")
      .eq("iso_a2", iso.toUpperCase())
      .maybeSingle(),
  ]);

  try {
    const guide = guideRow?.content
      ? normalizeCountryAiRecommendation(guideRow.content, country?.name ?? iso.toUpperCase())
      : null;
    const itinerary = await regenerateCountryItinerary(
      supabase,
      itineraryId,
      country?.name ?? iso.toUpperCase(),
      guide,
      scope,
      body.targetDayId,
      body.targetItemId,
      body.optimizeMode
    );
    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to regenerate itinerary" },
      { status: 500 }
    );
  }
}
