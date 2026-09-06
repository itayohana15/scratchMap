import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { validateFlightAirportCountries } from "@/lib/facts/airports-data";
import { buildCountryItinerarySuccessPayload } from "@/lib/itineraries";
import { ItineraryGenerationInfeasibleError } from "@/lib/server/country-itinerary-generation";
import {
  ItineraryGenerationPipelineError,
  listCountryItineraries,
  generateAndStoreCountryItinerary,
} from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiItineraryRequest } from "@/lib/trip-workspace";
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";

// Hygiene pass — see country-itineraries.ts's identical devLog for why
// this is gated behind the QA/debug flags instead of NODE_ENV: it used to
// print on every single non-production request with no way to turn it off.
function devLog(message: string, details?: Record<string, unknown>) {
  if (!isPlannerQaTraceEnabled()) return;
  if (details) console.log(`[Itinerary] ${message}`, details);
  else console.log(`[Itinerary] ${message}`);
}

function hasTripWizardPayloadShape(value: unknown): value is AiItineraryRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "preferences" in value &&
    typeof value.preferences === "object" &&
    value.preferences !== null
  );
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
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    devLog("trip wizard payload parsing: failed");
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Request body is not valid JSON." },
      { status: 400 }
    );
  }

  if (!hasTripWizardPayloadShape(parsedBody)) {
    devLog("request validation: failed", { reason: "missing preferences" });
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Trip preferences are required." },
      { status: 400 }
    );
  }
  const payload = parsedBody;

  devLog("trip wizard payload parsing: complete", { hasPreferences: Boolean(payload.preferences) });

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
  const flightCountryError = validateFlightAirportCountries(payload.preferences?.flights, country.iso_a2);
  if (flightCountryError) {
    devLog("request validation: failed", { reason: "flight airport wrong country", message: flightCountryError });
    return NextResponse.json(
      { error: "INVALID_FLIGHT_AIRPORTS", message: flightCountryError },
      { status: 422 }
    );
  }

  devLog("request validation: complete");

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

    devLog("final response serialization: complete", { itineraryId: itinerary.id });
    return NextResponse.json({
      itinerary,
      success: buildCountryItinerarySuccessPayload(itinerary, country.name),
    });
  } catch (error) {
    if (error instanceof ItineraryGenerationInfeasibleError) {
      devLog("failed — plan not feasible", { code: error.code, message: error.message });
      return NextResponse.json({ error: error.code, message: error.message }, { status: 422 });
    }
    if (error instanceof ItineraryGenerationPipelineError) {
      const body = {
        code: "GENERATION_FAILED",
        stage: error.stage,
        message: error.message,
        details: error.details,
      };
      devLog("generation failed", body);
      return NextResponse.json(
        process.env.NODE_ENV === "production"
          ? { error: body.code, message: "Failed to generate itinerary" }
          : body,
        { status: 500 }
      );
    }
    // Unexpected — always logged server-side, never silently swallowed.
    console.error("[Itinerary] failed at generation/save stage:", error);
    const message = error instanceof Error ? error.message : "Failed to generate itinerary";
    return NextResponse.json(
      process.env.NODE_ENV === "production"
        ? { error: "GENERATION_FAILED", message: "Failed to generate itinerary" }
        : { code: "GENERATION_FAILED", stage: "final response serialization", message, details: {} },
      { status: 500 }
    );
  }
}
