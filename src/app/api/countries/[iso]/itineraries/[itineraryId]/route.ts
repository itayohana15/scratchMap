import { NextResponse } from "next/server";

import { getCountryItinerary, updateCountryItinerary, deleteCountryItinerary } from "@/lib/server/country-itineraries";
import { createClient } from "@/lib/supabase/server";
import type { CountryTripWorkspaceState } from "@/lib/trip-workspace";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { itineraryId } = await params;
  const supabase = await createClient();

  try {
    const itinerary = await getCountryItinerary(supabase, itineraryId);
    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load itinerary" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { iso, itineraryId } = await params;
  let body: {
    title?: string;
    summary?: string;
    itineraryDays?: CountryTripWorkspaceState["itineraryDays"];
    preferencesSnapshot?: CountryTripWorkspaceState["preferences"];
    workspaceSnapshot?: Partial<CountryTripWorkspaceState> | null;
    budget?: number | null;
    generationMode?: CountryTripWorkspaceState["preferences"]["generationMode"];
    archived?: boolean;
    manuallyEdited?: boolean;
    changeReason?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: country } = await supabase
    .from("countries")
    .select("name")
    .eq("iso_a2", iso.toUpperCase())
    .maybeSingle();

  try {
    const itinerary = await updateCountryItinerary(
      supabase,
      itineraryId,
      country?.name ?? iso.toUpperCase(),
      {
        ...body,
        manuallyEdited: body.manuallyEdited ?? true,
        versionSource: body.manuallyEdited === false ? "regenerate" : "manual",
      }
    );
    return NextResponse.json({ itinerary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update itinerary" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ iso: string; itineraryId: string }> }
) {
  const { itineraryId } = await params;
  const supabase = await createClient();

  try {
    await deleteCountryItinerary(supabase, itineraryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete itinerary" },
      { status: 500 }
    );
  }
}
