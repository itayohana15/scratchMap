import { NextResponse } from "next/server";

import { normalizeCountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { validateFlightAirportCountries } from "@/lib/facts/airports-data";
import { buildCountryItinerarySuccessPayload } from "@/lib/itineraries";
import {
  ItineraryGenerationInfeasibleError,
  InsufficientRealActivitySupplyError,
  RealPlaceDiscoveryUnavailableError,
  InsufficientRealActivityCoverageError,
  RealPlaceDuplicatesRemainError,
  OpeningHoursViolationsRemainError,
  TimeOfDaySemanticViolationsRemainError,
  InsufficientStayRegionCoverageError,
} from "@/lib/server/country-itinerary-generation";
import {
  ItineraryGenerationPipelineError,
  listCountryItineraries,
  generateAndStoreCountryItinerary,
} from "@/lib/server/country-itineraries";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AiItineraryRequest } from "@/lib/trip-workspace";
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";
import type { GenerationProgressEvent } from "@/lib/server/generation-progress";

/** Round 9.3.3 §22 — the one shape every line of the streamed generation response can be; the client discriminates on `type`. */
type GenerationStreamFrame =
  | { type: "progress"; event: GenerationProgressEvent }
  | { type: "result"; data: { itinerary: unknown; success: unknown } }
  | { type: "error"; status: number; code?: string; message: string; details?: unknown };

/** Same classification this route always used, just returning a frame instead of directly writing a Response — the HTTP status has already been committed to 200 by the time generation can fail, since progress needs to stream before the outcome is known. The real status/code/message are carried inside this frame instead. */
function buildGenerationErrorFrame(error: unknown): GenerationStreamFrame {
  if (error instanceof RealPlaceDiscoveryUnavailableError) {
    // Round 9.3.3 continuation §7 — kept distinct from
    // INSUFFICIENT_REAL_ACTIVITY_SUPPLY/PLAN_NOT_FEASIBLE: a genuine
    // provider-infrastructure catastrophe, not a quiet destination or a
    // planner/quality problem. Never disguised as a normal 200 success.
    return { type: "error", status: 422, code: error.code, message: error.message, details: { stayFailures: error.stayFailures } };
  }
  if (error instanceof InsufficientRealActivitySupplyError) {
    // Round 9.1 §16/§17 — a DISTINCT code from generic PLAN_NOT_FEASIBLE:
    // this is a genuine provider/supply shortfall (a stay's own legal
    // candidate pool never reached its minimum-viable floor), never a
    // planner/quality problem against a healthy supply.
    return { type: "error", status: 422, code: error.code, message: error.message, details: { stayFailures: error.stayFailures } };
  }
  if (error instanceof InsufficientRealActivityCoverageError) {
    // Round 9.3.5 §17 — real candidates existed but didn't reach enough
    // days: a planner/composition-quality problem, distinct from a genuine
    // provider/supply shortfall. `diagnostics.stays` (when present) names
    // exactly which stays own the uncovered days, never only a trip-wide count.
    return { type: "error", status: 422, code: error.code, message: error.message, details: error.diagnostics };
  }
  if (error instanceof ItineraryGenerationInfeasibleError) {
    // Round 9.15.6.1 §K — this used to be the only error branch here with
    // no `details` at all, so a real PLAN_NOT_FEASIBLE failure always
    // reached the client with `ApiRequestError.body === undefined`, even
    // though a safe, structured diagnostic object now exists on the error
    // itself (see ItineraryGenerationInfeasibleError's own docstring).
    return { type: "error", status: 422, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof RealPlaceDuplicatesRemainError) {
    // Round 9.6.4 §8 — the deterministic final cleanup pass (§7) should
    // make this genuinely unreachable in practice; kept as its own
    // precise, structured 422 (never an uncaught crash, never a generic
    // 500) so a residual duplicate is still diagnosable by its exact
    // identity if the invariant is ever somehow violated again.
    return { type: "error", status: 422, code: error.code, message: error.message, details: error.diagnostics };
  }
  if (error instanceof OpeningHoursViolationsRemainError || error instanceof TimeOfDaySemanticViolationsRemainError) {
    // Round 9.15.8 §M — the two new non-mutating final-legality assertions
    // added to applyFinalPlanCleanup. Same shape as RealPlaceDuplicatesRemainError
    // just above: the mutating repair immediately before each of these
    // should make it genuinely unreachable in practice — kept as its own
    // precise, structured 422 so a residual violation is still diagnosable
    // by its exact identity if the invariant is ever somehow violated again.
    return { type: "error", status: 422, code: error.code, message: error.message, details: error.diagnostics };
  }
  if (error instanceof InsufficientStayRegionCoverageError) {
    // Round 9.16.2 §3/§4 — the stay-composition analogue of
    // RealPlaceDuplicatesRemainError/OpeningHoursViolationsRemainError:
    // 9.16.1's real trace proved an invalid stay composition (a stay over
    // MAX_STAY_NIGHTS, or too few stays for the trip length) could reach
    // persistence anyway. A failed, honest generation with this precise,
    // structured 422 is preferable to that — never a silently-persisted
    // invalid itinerary, never a generic 500.
    return { type: "error", status: 422, code: error.code, message: error.message, details: error.diagnostics };
  }
  if (error instanceof ItineraryGenerationPipelineError) {
    const body = { code: "GENERATION_FAILED", stage: error.stage, message: error.message, details: error.details };
    return {
      type: "error",
      status: 500,
      code: body.code,
      message: process.env.NODE_ENV === "production" ? "Failed to generate itinerary" : body.message,
      details: process.env.NODE_ENV === "production" ? undefined : body,
    };
  }
  // Unexpected — always logged server-side, never silently swallowed.
  console.error("[Itinerary] failed at generation/save stage:", error);
  const message = error instanceof Error ? error.message : "Failed to generate itinerary";
  return {
    type: "error",
    status: 500,
    code: "GENERATION_FAILED",
    message: process.env.NODE_ENV === "production" ? "Failed to generate itinerary" : message,
    details: process.env.NODE_ENV === "production" ? undefined : { stage: "final response serialization" },
  };
}

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

  // Round 9.3.3 §22 — the SAME single request/endpoint as before, now
  // streamed: real progress events are written as they genuinely happen,
  // followed by exactly one final "result" or "error" frame. No second
  // endpoint, no separate planner run, no polling — the client reads this
  // one response body incrementally instead of awaiting it whole. Every
  // frame is scoped to this one request's own stream; there is no
  // module-level/shared state a different generation could ever write into
  // or read from, which is what makes cross-generation leakage structurally
  // impossible rather than merely guarded against.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      function send(frame: GenerationStreamFrame) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The client already disconnected (abort/navigation) — nothing
          // useful to do; the generation work itself keeps running to
          // completion server-side exactly as it already did before this
          // round (real mid-flight cancellation of the planner itself is a
          // pre-existing limitation, not something this progress round
          // redesigns).
          closed = true;
        }
      }
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
          guide,
          (event) => send({ type: "progress", event })
        );

        devLog("database save complete", { itineraryId: itinerary.id });
        devLog("final response serialization: complete", { itineraryId: itinerary.id });
        // §D — 100% is only ever sent here, after generateAndStoreCountryItinerary has ALREADY returned successfully.
        send({ type: "progress", event: { stage: "COMPLETE", message: "המסלול מוכן" } });
        send({
          type: "result",
          data: { itinerary, success: buildCountryItinerarySuccessPayload(itinerary, country.name) },
        });
      } catch (error) {
        if (error instanceof RealPlaceDiscoveryUnavailableError) {
          devLog("failed — real place discovery unavailable (catastrophic provider failure)", { code: error.code, stayFailures: error.stayFailures });
        } else if (error instanceof InsufficientRealActivityCoverageError) {
          devLog("failed — insufficient real-activity coverage", { code: error.code, ...error.diagnostics });
        } else if (error instanceof InsufficientRealActivitySupplyError) {
          devLog("failed — insufficient real activity supply", { code: error.code, stayFailures: error.stayFailures });
        } else if (error instanceof ItineraryGenerationInfeasibleError) {
          devLog("failed — plan not feasible", { code: error.code, message: error.message });
        } else if (error instanceof RealPlaceDuplicatesRemainError) {
          devLog("failed — real-place duplicate(s) survived the final cleanup pass", { code: error.code, ...error.diagnostics });
        } else if (error instanceof OpeningHoursViolationsRemainError) {
          devLog("failed — opening-hours violation(s) survived the final legalization pass", { code: error.code, ...error.diagnostics });
        } else if (error instanceof TimeOfDaySemanticViolationsRemainError) {
          devLog("failed — time-of-day semantic violation(s) survived the final legalization pass", { code: error.code, ...error.diagnostics });
        } else if (error instanceof InsufficientStayRegionCoverageError) {
          devLog("failed — final stay composition insufficient (overlong stay, too few stays, or coverage gap)", { code: error.code, ...error.diagnostics });
        } else if (error instanceof ItineraryGenerationPipelineError) {
          devLog("generation failed", { code: "GENERATION_FAILED", stage: error.stage, message: error.message });
        } else {
          console.error("[Itinerary] failed at generation/save stage:", error);
        }
        // §J — never emits COMPLETE/100%/a result frame on this path.
        send(buildGenerationErrorFrame(error));
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
