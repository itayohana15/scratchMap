import { NextResponse } from "next/server";

import { normalizeCountryItineraryRow } from "@/lib/itineraries";
import { generateTripStory } from "@/lib/server/trip-story-generation";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildAiStoryContext } from "@/lib/trip-memories";
import { journalEntries } from "@/lib/trip-journal";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { iso, itineraryId } = await params;
  const supabase = createAdminClient();

  const [{ data: itineraryRow, error: itineraryError }, { data: country }, { data: photos }, { data: ratingRow }] =
    await Promise.all([
      supabase.from("country_itineraries").select("*").eq("id", itineraryId).maybeSingle(),
      supabase.from("countries").select("name").eq("iso_a2", iso.toUpperCase()).maybeSingle(),
      supabase.from("photos").select("*").eq("itinerary_id", itineraryId),
      supabase.from("trip_ratings").select("overall").eq("itinerary_id", itineraryId).maybeSingle(),
    ]);

  if (itineraryError || !itineraryRow) {
    return NextResponse.json({ error: "Itinerary not found" }, { status: 404 });
  }

  try {
    const itinerary = normalizeCountryItineraryRow(itineraryRow);
    const countryName = country?.name ?? iso.toUpperCase();
    const context = buildAiStoryContext(
      itinerary,
      countryName,
      photos ?? [],
      journalEntries(itinerary).map((entry) => ({ date: entry.date, title: entry.title, text: entry.text })),
      ratingRow?.overall ?? null
    );
    const story = await generateTripStory(context);
    return NextResponse.json({ story });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate trip story" },
      { status: 500 }
    );
  }
}
