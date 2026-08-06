import { NextResponse } from "next/server";

import { restoreCountryItineraryVersion } from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { iso, itineraryId } = await params;
  let body: { versionId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.versionId) {
    return NextResponse.json({ error: "versionId is required" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: country } = await supabase
    .from("countries")
    .select("name")
    .eq("iso_a2", iso.toUpperCase())
    .maybeSingle();

  try {
    const itinerary = await restoreCountryItineraryVersion(
      supabase,
      itineraryId,
      body.versionId,
      country?.name ?? iso.toUpperCase()
    );
    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to restore version" },
      { status: 500 }
    );
  }
}
