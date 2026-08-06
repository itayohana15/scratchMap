import { NextResponse } from "next/server";

import { listCountryItineraryVersions } from "@/lib/server/country-itineraries";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { itineraryId } = await params;
  const supabase = await createClient();

  try {
    const versions = await listCountryItineraryVersions(supabase, itineraryId);
    return NextResponse.json({ versions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load versions" },
      { status: 500 }
    );
  }
}
