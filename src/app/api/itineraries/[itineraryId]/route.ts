import { NextResponse } from "next/server";

import { getCountryItinerary } from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";

// Country-agnostic lookup for the dedicated trip page (`/trips/[tripId]`),
// which only knows the itinerary id up front — `CountryItineraryRecord`
// already carries its own `isoA2`, so no country join is needed here; the
// page fetches country details separately via the existing `useCountryByIso`.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ itineraryId: string }> }
) {
  const { itineraryId } = await params;
  const supabase = createAdminClient();

  try {
    const itinerary = await getCountryItinerary(supabase, itineraryId);
    return NextResponse.json({ itinerary });
  } catch (error) {
    if (error instanceof Error && error.message === "Itinerary not found") {
      return NextResponse.json(
        { error: "TRIP_NOT_FOUND", message: "No itinerary found for this id." },
        { status: 404 }
      );
    }
    return NextResponse.json(
      {
        error: "LOOKUP_FAILED",
        message: error instanceof Error ? error.message : "Failed to load itinerary",
      },
      { status: 500 }
    );
  }
}
