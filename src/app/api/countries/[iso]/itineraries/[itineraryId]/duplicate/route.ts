import { NextResponse } from "next/server";

import { duplicateCountryItinerary } from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { iso, itineraryId } = await params;
  const supabase = createAdminClient();

  const { data: country } = await supabase
    .from("countries")
    .select("name")
    .eq("iso_a2", iso.toUpperCase())
    .maybeSingle();

  try {
    const itinerary = await duplicateCountryItinerary(
      supabase,
      itineraryId,
      country?.name ?? iso.toUpperCase()
    );
    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to duplicate itinerary" },
      { status: 500 }
    );
  }
}
