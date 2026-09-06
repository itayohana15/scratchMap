import type { SupabaseClient } from "@supabase/supabase-js";

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
import { canonicalizeItineraryCities } from "@/lib/city-normalization";
import {
  buildSuggestedItineraryTitle,
  computeItineraryCostSummary,
  createWorkspaceFromItineraryRecord,
  deriveItineraryStatus,
  normalizeCountryItineraryRow,
  normalizeCountryItineraryVersionRow,
  type CountryItineraryRecord,
  type CountryItineraryVersionSource,
} from "@/lib/itineraries";
import {
  applyDeterministicReplacement,
  generateCountryItineraryPlan,
  ItineraryGenerationInfeasibleError,
} from "@/lib/server/country-itinerary-generation";
import { buildTripPreferenceProfile } from "@/lib/server/itinerary-generation-constraints";
import {
  mergeLiveReplanResult,
  mergeProtectedItemsIntoRegeneratedDay as mergeProtectedItems,
  preserveUserSelectedHotel,
} from "@/lib/live-trip-planner";
import { buildPersonalizationSummary, computeBehaviorSignals, deriveInferredPreferences } from "@/lib/preference-learning";
import type { Database, Tables } from "@/lib/supabase/types";
import {
  applyAiPlanToWorkspace,
  createDefaultWorkspace,
  createId,
  estimateTravelMinutes,
  normalizeWorkspace,
  optimizeDayItemOrder,
  type AiItineraryRequest,
  type CountryTripWorkspaceState,
  type DayOptimizeMode,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { isMissingCountryItineraryStorageError, toCountryItineraryStorageError } from "@/lib/server/country-itinerary-storage";
import { isPlannerQaTraceEnabled } from "@/lib/planner-qa-trace";

type DbClient = SupabaseClient<Database>;

export type ItineraryGenerationFailureStage =
  | "request validation"
  | "trip wizard payload parsing"
  | "flight data"
  | "airport data"
  | "dietary preferences"
  | "itinerary AI request"
  | "AI response parsing"
  | "schema validation"
  | "DB save"
  | "recommendation/place resolution"
  | "final response serialization";

export class ItineraryGenerationPipelineError extends Error {
  constructor(
    public stage: ItineraryGenerationFailureStage,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ItineraryGenerationPipelineError";
  }
}

interface UpdateCountryItineraryInput {
  title?: string;
  summary?: string;
  itineraryDays?: TripItineraryDay[];
  preferencesSnapshot?: CountryTripWorkspaceState["preferences"];
  workspaceSnapshot?: Partial<CountryTripWorkspaceState> | null;
  budget?: number | null;
  generationMode?: CountryTripWorkspaceState["preferences"]["generationMode"];
  archived?: boolean;
  manuallyEdited?: boolean;
  changeReason?: string;
  versionSource?: CountryItineraryVersionSource;
  restoredFromVersionId?: string | null;
}

function serializeSnapshot(record: CountryItineraryRecord) {
  return JSON.parse(JSON.stringify(record));
}

function buildInitialWorkspace(countryName: string, payload: AiItineraryRequest): CountryTripWorkspaceState {
  return normalizeWorkspace(
    {
      ...createDefaultWorkspace(countryName),
      tripStatus: payload.tripStatus,
      preferences: payload.preferences,
      recommendations: payload.recommendations,
      itineraryDays: payload.existingDays,
      bookings: payload.bookings,
    },
    countryName
  );
}

async function insertVersion(
  supabase: DbClient,
  itinerary: CountryItineraryRecord,
  source: CountryItineraryVersionSource,
  changeReason: string | null,
  restoredFromVersionId?: string | null
) {
  const { error } = await supabase.from("country_itinerary_versions").insert({
    itinerary_id: itinerary.id,
    version: itinerary.version,
    change_reason: changeReason,
    source,
    model: itinerary.model,
    snapshot: serializeSnapshot(itinerary),
    restored_from_version_id: restoredFromVersionId ?? null,
  });
  if (error) throw toCountryItineraryStorageError(error);
}

function recomputeDayEstimates(
  day: TripItineraryDay,
  preferences: CountryTripWorkspaceState["preferences"]
): TripItineraryDay {
  const nextItems: TripItineraryItem[] = day.items.map((item, index, items) => {
    const previous = index > 0 ? items[index - 1] : null;
    const travelMinutes =
      item.travelMinutes != null && item.travelMinutes > 0
        ? item.travelMinutes
        : previous
          ? estimateTravelMinutes(
              previous.lat,
              previous.lon,
              item.lat,
              item.lon,
              preferences.tripPace,
              item.transportation || preferences.transportationPreferences
            )
          : 0;

    return {
      ...item,
      travelMinutes,
    };
  });

  const estimatedCost = nextItems.reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const activityCost = nextItems
    .filter(
      (item) =>
        item.category !== "restaurant" &&
        item.category !== "cafe" &&
        item.category !== "transportation" &&
        item.category !== "hotel"
    )
    .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const foodCost = nextItems
    .filter((item) => item.category === "restaurant" || item.category === "cafe")
    .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const transportCost = nextItems
    .filter((item) => item.category === "transportation")
    .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const accommodationCost = nextItems
    .filter((item) => item.category === "hotel")
    .reduce((sum, item) => sum + (item.approximatePrice ?? 0), 0);
  const totalTravelMinutes = nextItems.reduce((sum, item) => sum + (item.travelMinutes ?? 0), 0);
  const transportSegments = nextItems
    .map((item) =>
      item.travelMinutes != null && item.travelMinutes > 0
        ? `${item.transportation || preferences.transportationPreferences || "תחבורה מקומית"} · ${item.travelMinutes} דק'`
        : ""
    )
    .filter(Boolean);

  return {
    ...day,
    items: nextItems,
    estimatedCost: estimatedCost > 0 ? estimatedCost : null,
    activityCost: activityCost > 0 ? activityCost : null,
    foodCost: foodCost > 0 ? foodCost : null,
    transportCost: transportCost > 0 ? transportCost : null,
    accommodationCost: accommodationCost > 0 ? accommodationCost : null,
    totalTravelMinutes: totalTravelMinutes > 0 ? totalTravelMinutes : null,
    transportSegments,
  };
}

/**
 * Thread 1 (locked/fixed-time hard requirement), item 10: "regenerate day"
 * must preserve locked activities and fixed-time activities, generating
 * the rest of the day around them. Before this fix, "regenerate day"
 * (regenerationScope "day") replaced the target day's items wholesale
 * with whatever the AI returned — the prompt asked Gemini to leave
 * locked/fixed-time items alone (see the "untouchableNames" guidance
 * built in generateCountryItineraryPlan), but nothing in code actually
 * guaranteed it; a locked or fixed-time activity could simply be dropped
 * if the AI didn't comply. The actual merge logic
 * (mergeProtectedItemsIntoRegeneratedDay) lives in live-trip-planner.ts,
 * right next to the near-identical mergeLiveReplanResult — a pure
 * function, unit-tested directly there, since this file's Supabase
 * dependency keeps it out of the standalone test build. This wrapper just
 * folds the result back through the existing recomputeDayEstimates.
 */
function mergeProtectedItemsIntoRegeneratedDay(
  originalDay: TripItineraryDay,
  regeneratedDay: TripItineraryDay,
  preferences: CountryTripWorkspaceState["preferences"]
): TripItineraryDay {
  const dayWithHotelPreserved = preserveUserSelectedHotel(originalDay, regeneratedDay);
  const mergedItems = mergeProtectedItems(originalDay.items, dayWithHotelPreserved.items);
  if (mergedItems === dayWithHotelPreserved.items && dayWithHotelPreserved === regeneratedDay) return regeneratedDay;
  return recomputeDayEstimates({ ...dayWithHotelPreserved, items: mergedItems }, preferences);
}

async function fetchItineraryRow(supabase: DbClient, itineraryId: string) {
  const { data, error } = await supabase
    .from("country_itineraries")
    .select("*")
    .eq("id", itineraryId)
    .maybeSingle();
  if (error) throw toCountryItineraryStorageError(error);
  if (!data) throw new Error("Itinerary not found");
  return data;
}

export async function listCountryItineraries(supabase: DbClient, isoA2: string) {
  const { data, error } = await supabase
    .from("country_itineraries")
    .select("*")
    .eq("iso_a2", isoA2.toUpperCase())
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (error) {
    if (isMissingCountryItineraryStorageError(error)) {
      return [];
    }
    throw toCountryItineraryStorageError(error);
  }
  return (data ?? []).map(normalizeCountryItineraryRow);
}

export async function getCountryItinerary(supabase: DbClient, itineraryId: string) {
  const row = await fetchItineraryRow(supabase, itineraryId);
  return normalizeCountryItineraryRow(row);
}

/**
 * Duplicate-generation protection (spec E7/E8): looks up a previously
 * generated itinerary by the wizard's client-generated request id, so a
 * second request carrying the same id — a double-click race, a network
 * retry, or two requests that both raced past this same lookup — resolves
 * to the existing row instead of generating (and billing) a second trip.
 * `maybeSingle` returns null cleanly when nothing matches yet.
 */
export async function findCountryItineraryByClientRequestId(
  supabase: DbClient,
  clientRequestId: string
): Promise<CountryItineraryRecord | null> {
  const { data, error } = await supabase
    .from("country_itineraries")
    .select("*")
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error) {
    if (isMissingCountryItineraryStorageError(error)) return null;
    throw toCountryItineraryStorageError(error);
  }
  return data ? normalizeCountryItineraryRow(data) : null;
}

export async function listCountryItineraryVersions(supabase: DbClient, itineraryId: string) {
  const { data, error } = await supabase
    .from("country_itinerary_versions")
    .select("*")
    .eq("itinerary_id", itineraryId)
    .order("version", { ascending: false });
  if (error) {
    if (isMissingCountryItineraryStorageError(error)) {
      return [];
    }
    throw toCountryItineraryStorageError(error);
  }
  return (data ?? []).map(normalizeCountryItineraryVersionRow);
}

/**
 * Global (all-countries) personalization summary for the generator prompt
 * (Stage 7). Wrapped so any failure — missing tables, empty data, a slow
 * query — degrades to `null` and generation proceeds exactly as before
 * (spec §52: personalization must never block planning).
 */
async function loadPersonalizationSummary(supabase: DbClient): Promise<string | null> {
  try {
    const [{ data: profileRow }, { data: itineraryRows }, { data: feedbackRows }] = await Promise.all([
      supabase.from("preference_profile").select("*").limit(1).maybeSingle(),
      supabase.from("country_itineraries").select("*").is("deleted_at", null),
      supabase
        .from("recommendation_feedback")
        .select("place_key,category,feedback,reason")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (!profileRow || profileRow.learning_enabled === false) return null;

    const itineraries = (itineraryRows ?? []).map(normalizeCountryItineraryRow);
    const signals = computeBehaviorSignals(itineraries, feedbackRows ?? []);
    const { inferred } = deriveInferredPreferences(signals, profileRow.explicit_preferences ?? {});
    const recentNegative = (feedbackRows ?? [])
      .filter((row) => row.feedback === "down")
      .slice(0, 5)
      .map((row) => ({ category: row.category, reason: row.reason }));

    return buildPersonalizationSummary(profileRow.explicit_preferences ?? {}, inferred, recentNegative);
  } catch {
    return null;
  }
}

// Hygiene pass — this used to fire on every non-production request
// (NODE_ENV !== "production"), flooding the server terminal on every
// `npm run dev` trip generation with no way to turn it off short of
// building for production. Gated behind the same QA/debug flags every
// other generation-time diagnostic already uses (QA_DEBUG_GEOGRAPHY,
// CAPTURE_FIXTURES, PLANNER_QA_TRACE) — silent by default, and a
// deliberate QA run still gets these stage markers.
function devLog(message: string, details?: Record<string, unknown>) {
  if (!isPlannerQaTraceEnabled()) return;
  if (details) console.log(`[Itinerary] ${message}`, details);
  else console.log(`[Itinerary] ${message}`);
}

async function runGenerationStage<T>(
  stage: ItineraryGenerationFailureStage,
  work: () => Promise<T>,
  details?: Record<string, unknown>
): Promise<T> {
  devLog(`${stage}: started`, details);
  try {
    const value = await work();
    devLog(`${stage}: complete`, details);
    return value;
  } catch (error) {
    if (error instanceof ItineraryGenerationInfeasibleError || error instanceof ItineraryGenerationPipelineError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown generation failure";
    devLog(`${stage}: failed`, { ...details, message });
    throw new ItineraryGenerationPipelineError(stage, message, details);
  }
}

export async function generateAndStoreCountryItinerary(
  supabase: DbClient,
  country: Tables<"countries">,
  payload: AiItineraryRequest,
  guide: CountryAiRecommendation | null
) {
  // Duplicate-generation protection (E7): checked before doing any AI work
  // at all, so a repeat request with the same wizard-minted id never
  // re-generates or re-bills a second trip — it just returns the first one.
  if (payload.clientRequestId) {
    const existing = await runGenerationStage("DB save", () =>
      findCountryItineraryByClientRequestId(supabase, payload.clientRequestId!)
    );
    if (existing) {
      devLog("duplicate request — returning existing itinerary", {
        clientRequestId: payload.clientRequestId,
        itineraryId: existing.id,
      });
      return existing;
    }
  }

  const personalizationSummary = await loadPersonalizationSummary(supabase);
  devLog("profile loaded", { hasPersonalizationSummary: personalizationSummary != null });
  const generated = await runGenerationStage("itinerary AI request", () =>
    generateCountryItineraryPlan({ ...payload, personalizationSummary }, guide),
    { isoA2: country.iso_a2 }
  );
  devLog("AI generation complete", { days: generated.days.length, usedFallback: generated.usedFallback });
  const initialWorkspace = buildInitialWorkspace(country.name, payload);
  const generatedWorkspaceRaw = applyAiPlanToWorkspace(initialWorkspace, generated);
  // Normalize before aggregation (spec §A2): merge "Tbilisi"/"טביליסי"-style
  // duplicates into one canonical city BEFORE cost summary / city counts /
  // route grouping ever see the days, not just in the UI.
  const canonicalizedDays = await runGenerationStage(
    "recommendation/place resolution",
    () => canonicalizeItineraryCities(generatedWorkspaceRaw.itineraryDays, country.iso_a2),
    { days: generatedWorkspaceRaw.itineraryDays.length }
  ).catch((error) => {
    devLog("recommendation/place resolution: using uncanonicalized places", {
      message: error instanceof Error ? error.message : String(error),
    });
    return generatedWorkspaceRaw.itineraryDays;
  });
  const generatedWorkspace = { ...generatedWorkspaceRaw, itineraryDays: canonicalizedDays };
  const costSummary = computeItineraryCostSummary(generatedWorkspace);
  const title =
    payload.userProvidedTitle?.trim() ||
    generated.title ||
    buildSuggestedItineraryTitle(country.name, payload.preferences.startDate, payload.preferences.endDate);
  const archived = false;
  const status = deriveItineraryStatus(
    payload.preferences.startDate,
    payload.preferences.endDate,
    archived,
    "draft",
    country.iso_a2
  );

  devLog("database save started");
  const { data, error } = await runGenerationStage("DB save", async () =>
    await supabase.from("country_itineraries").insert({
      country_id: country.id,
      iso_a2: country.iso_a2,
      title,
      start_date: payload.preferences.startDate || null,
      end_date: payload.preferences.endDate || null,
      days_count: generated.days.length,
      travelers: payload.preferences.travelers,
      budget: payload.preferences.budget,
      generation_mode: payload.preferences.generationMode,
      source: "ai",
      model: generated.model,
      summary: generated.summary,
      preferences_snapshot: payload.preferences,
      workspace_snapshot: generatedWorkspace,
      itinerary_days: generatedWorkspace.itineraryDays,
      cost_summary: costSummary,
      status,
      version: 1,
      manually_edited: false,
      archived,
      client_request_id: payload.clientRequestId ?? null,
    }).select("*").single(),
    { clientRequestId: payload.clientRequestId ?? null }
  );
  if (error) {
    // E8's real backstop: two requests raced past the lookup above and both
    // reached the insert — the unique index lets exactly one through. The
    // loser doesn't fail the user's request; it just returns the winner.
    if (error.code === "23505" && payload.clientRequestId) {
      const winner = await findCountryItineraryByClientRequestId(supabase, payload.clientRequestId);
      if (winner) {
        devLog("duplicate insert race — returning the winning itinerary", { itineraryId: winner.id });
        return winner;
      }
    }
    devLog("failed at database insert", { message: error.message, code: error.code });
    const storageError = toCountryItineraryStorageError(error);
    throw new ItineraryGenerationPipelineError("DB save", storageError.message, { code: error.code });
  }

  const itinerary = normalizeCountryItineraryRow(data);
  await runGenerationStage("DB save", () => insertVersion(supabase, itinerary, "ai", "initial generation"), {
    itineraryId: itinerary.id,
  });
  return itinerary;
}

export async function updateCountryItinerary(
  supabase: DbClient,
  itineraryId: string,
  countryName: string,
  input: UpdateCountryItineraryInput
) {
  const existing = await getCountryItinerary(supabase, itineraryId);
  const preferencesSnapshot = input.preferencesSnapshot ?? existing.preferencesSnapshot;

  const nextWorkspace =
    input.workspaceSnapshot != null
      ? normalizeWorkspace(
          {
            ...createDefaultWorkspace(countryName),
            ...(input.workspaceSnapshot as Partial<CountryTripWorkspaceState>),
            preferences: preferencesSnapshot,
            itineraryDays: input.itineraryDays ?? existing.itineraryDays,
            lastAiPlanSummary: input.summary ?? existing.summary,
          },
          countryName
        )
      : createWorkspaceFromItineraryRecord(existing, countryName);

  const itineraryDays = (input.itineraryDays ?? nextWorkspace.itineraryDays).map((day, index) => ({
    ...day,
    dayNumber: index + 1,
  }));

  const normalizedWorkspace = normalizeWorkspace(
    {
      ...nextWorkspace,
      preferences: preferencesSnapshot,
      itineraryDays,
      lastAiPlanSummary: input.summary ?? existing.summary,
    },
    countryName
  );

  const costSummary = computeItineraryCostSummary(normalizedWorkspace);
  const archived = input.archived ?? existing.archived;
  const status = deriveItineraryStatus(
    preferencesSnapshot.startDate || existing.startDate,
    preferencesSnapshot.endDate || existing.endDate,
    archived,
    existing.status,
    existing.isoA2
  );

  const { data, error } = await supabase
    .from("country_itineraries")
    .update({
      title:
        input.title ??
        existing.title ??
        buildSuggestedItineraryTitle(countryName, preferencesSnapshot.startDate, preferencesSnapshot.endDate),
      start_date: preferencesSnapshot.startDate || existing.startDate,
      end_date: preferencesSnapshot.endDate || existing.endDate,
      days_count: itineraryDays.length,
      travelers: preferencesSnapshot.travelers,
      budget: input.budget ?? preferencesSnapshot.budget ?? existing.budget,
      generation_mode: input.generationMode ?? preferencesSnapshot.generationMode ?? existing.generationMode,
      summary: input.summary ?? existing.summary,
      preferences_snapshot: preferencesSnapshot,
      workspace_snapshot: normalizedWorkspace,
      itinerary_days: itineraryDays,
      cost_summary: costSummary,
      status,
      version: existing.version + 1,
      manually_edited: input.manuallyEdited ?? true,
      archived,
    })
    .eq("id", itineraryId)
    .select("*")
    .single();
  if (error) throw toCountryItineraryStorageError(error);

  const itinerary = normalizeCountryItineraryRow(data);
  await insertVersion(
    supabase,
    itinerary,
    input.versionSource ?? (input.manuallyEdited === false ? "regenerate" : "manual"),
    input.changeReason ?? null,
    input.restoredFromVersionId
  );
  return itinerary;
}

export async function duplicateCountryItinerary(
  supabase: DbClient,
  itineraryId: string,
  countryName: string
) {
  const existing = await getCountryItinerary(supabase, itineraryId);
  const workspace = createWorkspaceFromItineraryRecord(existing, countryName);
  const costSummary = computeItineraryCostSummary(workspace);

  const { data, error } = await supabase
    .from("country_itineraries")
    .insert({
      country_id: existing.countryId,
      iso_a2: existing.isoA2,
      title: `${existing.title} (עותק)`,
      start_date: existing.startDate,
      end_date: existing.endDate,
      days_count: existing.daysCount,
      travelers: existing.travelers,
      budget: existing.budget,
      generation_mode: existing.generationMode,
      source: existing.source,
      model: existing.model,
      summary: existing.summary,
      preferences_snapshot: existing.preferencesSnapshot,
      workspace_snapshot: workspace,
      itinerary_days: existing.itineraryDays,
      cost_summary: costSummary,
      status: deriveItineraryStatus(existing.startDate, existing.endDate, false, existing.status, existing.isoA2),
      version: 1,
      parent_itinerary_id: existing.id,
      manually_edited: existing.manuallyEdited,
      archived: false,
    })
    .select("*")
    .single();
  if (error) throw toCountryItineraryStorageError(error);

  const duplicate = normalizeCountryItineraryRow(data);
  await insertVersion(supabase, duplicate, "duplicate", "duplicate itinerary");
  return duplicate;
}

export async function archiveCountryItinerary(
  supabase: DbClient,
  itineraryId: string,
  countryName: string
) {
  return updateCountryItinerary(supabase, itineraryId, countryName, {
    archived: true,
    manuallyEdited: true,
    changeReason: "archive itinerary",
    versionSource: "manual",
  });
}

export async function deleteCountryItinerary(supabase: DbClient, itineraryId: string) {
  const { error } = await supabase
    .from("country_itineraries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", itineraryId);
  if (error) throw toCountryItineraryStorageError(error);
}

export async function restoreCountryItineraryVersion(
  supabase: DbClient,
  itineraryId: string,
  versionId: string,
  countryName: string
) {
  const { data, error } = await supabase
    .from("country_itinerary_versions")
    .select("*")
    .eq("id", versionId)
    .eq("itinerary_id", itineraryId)
    .maybeSingle();
  if (error) throw toCountryItineraryStorageError(error);
  if (!data) throw new Error("Version not found");

  const version = normalizeCountryItineraryVersionRow(data);
  if (!version.snapshot) {
    throw new Error("Version snapshot is unavailable");
  }

  return updateCountryItinerary(supabase, itineraryId, countryName, {
    title: version.snapshot.title,
    summary: version.snapshot.summary,
    itineraryDays: version.snapshot.itineraryDays,
    preferencesSnapshot: version.snapshot.preferencesSnapshot,
    workspaceSnapshot: version.snapshot.workspaceSnapshot,
    budget: version.snapshot.budget,
    generationMode: version.snapshot.generationMode,
    archived: version.snapshot.archived,
    manuallyEdited: true,
    changeReason: `restore version ${version.version}`,
    versionSource: "restore",
    restoredFromVersionId: version.id,
  });
}

export async function regenerateCountryItinerary(
  supabase: DbClient,
  itineraryId: string,
  countryName: string,
  guide: CountryAiRecommendation | null,
  scope: NonNullable<AiItineraryRequest["regenerationScope"]>,
  targetDayId?: string | null,
  targetItemId?: string | null,
  optimizeMode?: DayOptimizeMode | null,
  liveInstruction?: string | null
) {
  const existing = await getCountryItinerary(supabase, itineraryId);
  const workspace = createWorkspaceFromItineraryRecord(existing, countryName);
  const payload: AiItineraryRequest = {
    countryId: existing.countryId,
    countryName,
    isoA2: existing.isoA2,
    tripStatus: workspace.tripStatus,
    preferences: {
      ...workspace.preferences,
      generationMode: existing.generationMode,
    },
    selectedPlaces: workspace.recommendations,
    recommendations: workspace.recommendations,
    bookings: workspace.bookings,
    existingDays: workspace.itineraryDays,
    regenerationScope: scope,
    targetDayId: targetDayId ?? null,
    targetItemId: targetItemId ?? null,
    liveInstruction: liveInstruction ?? null,
  };

  if (scope === "recalculate_costs") {
    const nextDays = workspace.itineraryDays.map((day) => recomputeDayEstimates(day, workspace.preferences));
    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays },
      manuallyEdited: false,
      changeReason: "recalculate costs and times",
      versionSource: "regenerate",
    });
  }

  if (scope === "optimize_route") {
    const mode: DayOptimizeMode = optimizeMode ?? "less_walking";
    const nextDays = workspace.itineraryDays.map((day) => {
      if (targetDayId && day.id !== targetDayId) return day;
      const reordered = { ...day, items: optimizeDayItemOrder(day.items, mode) };
      return recomputeDayEstimates(reordered, workspace.preferences);
    });
    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays },
      manuallyEdited: false,
      changeReason:
        mode === "fewer_transfers" ? "optimize day: fewer transfers" : "optimize day: less walking",
      versionSource: "regenerate",
    });
  }

  // Live Trip Mode "this place is closed / skip this" fast path — fully
  // deterministic, no AI call (spec §17's example: replace with something
  // nearby, open, in-budget, geographically compatible).
  if (scope === "live_replace_item" && targetDayId && targetItemId) {
    const dayIndex = workspace.itineraryDays.findIndex((day) => day.id === targetDayId);
    if (dayIndex === -1) throw new Error("Target day not found");
    const targetItem = workspace.itineraryDays[dayIndex].items.find((item) => item.id === targetItemId);
    if (!targetItem) throw new Error("Target item not found");
    if (targetItem.locked || targetItem.fixedTime) {
      throw new Error("Locked or fixed-time items cannot be replaced automatically");
    }

    const profile = buildTripPreferenceProfile(workspace.preferences, countryName, workspace.itineraryDays.length);
    const { day: nextDay, replacementName } = applyDeterministicReplacement(
      workspace.itineraryDays[dayIndex],
      targetItem,
      payload,
      profile
    );
    const nextDays = [...workspace.itineraryDays];
    nextDays[dayIndex] = recomputeDayEstimates(nextDay, workspace.preferences);

    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays },
      manuallyEdited: false,
      changeReason: `live replace: ${targetItem.name} -> ${replacementName}`,
      versionSource: "regenerate",
    });
  }

  const personalizationSummary = await loadPersonalizationSummary(supabase);
  const generated = await generateCountryItineraryPlan({ ...payload, personalizationSummary }, guide);
  const regeneratedWorkspace = applyAiPlanToWorkspace(workspace, generated);

  if (scope === "live_replan" && targetDayId) {
    const dayIndex = workspace.itineraryDays.findIndex((day) => day.id === targetDayId);
    if (dayIndex === -1) throw new Error("Target day not found");

    const originalDay = workspace.itineraryDays[dayIndex];
    const regeneratedDay = regeneratedWorkspace.itineraryDays[dayIndex];

    const { items: nextItems } = mergeLiveReplanResult(originalDay.items, regeneratedDay.items, () => createId("item"));
    const dayWithHotelPreserved = preserveUserSelectedHotel(originalDay, regeneratedDay);
    const mergedDays = [...workspace.itineraryDays];
    mergedDays[dayIndex] = recomputeDayEstimates(
      { ...dayWithHotelPreserved, id: originalDay.id, items: nextItems },
      workspace.preferences
    );
    // Re-canonicalize the whole trip, not just the changed day — a single
    // regenerated day can otherwise cluster its city under a different
    // canonical id than the rest of the (already-canonicalized) trip.
    const nextDays = await canonicalizeItineraryCities(mergedDays, existing.isoA2).catch(() => mergedDays);

    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays },
      manuallyEdited: false,
      changeReason: `live re-plan: ${liveInstruction ?? ""}`.trim(),
      versionSource: "regenerate",
    });
  }

  if (scope === "day" && targetDayId) {
    const existingDayIndex = workspace.itineraryDays.findIndex((day) => day.id === targetDayId);
    if (existingDayIndex === -1) throw new Error("Target day not found");
    const originalDay = workspace.itineraryDays[existingDayIndex];
    const mergedDays = [...workspace.itineraryDays];
    mergedDays[existingDayIndex] = mergeProtectedItemsIntoRegeneratedDay(
      originalDay,
      { ...regeneratedWorkspace.itineraryDays[existingDayIndex], id: originalDay.id },
      workspace.preferences
    );
    const nextDays = await canonicalizeItineraryCities(mergedDays, existing.isoA2).catch(() => mergedDays);
    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays, lastAiPlanSummary: generated.summary },
      summary: generated.summary,
      manuallyEdited: false,
      changeReason: "regenerate selected day",
      versionSource: "regenerate",
    });
  }

  if (scope === "activity" && targetItemId) {
    const nextDays = workspace.itineraryDays.map((day, dayIndex) => {
      const targetIndex = day.items.findIndex((item) => item.id === targetItemId);
      if (targetIndex === -1) return day;
      const replacementDay = regeneratedWorkspace.itineraryDays[dayIndex];
      const targetItem = day.items[targetIndex];
      const replacementItem =
        replacementDay.items.find((item) => item.slot === targetItem.slot) ??
        replacementDay.items[targetIndex] ??
        null;
      if (!replacementItem) return day;
      const nextItems = [...day.items];
      nextItems[targetIndex] = {
        ...replacementItem,
        id: targetItem.id,
        locked: targetItem.locked,
        priority: targetItem.priority,
        fixedTime: targetItem.fixedTime,
      };
      return { ...day, items: nextItems };
    });
    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays, lastAiPlanSummary: generated.summary },
      summary: generated.summary,
      manuallyEdited: false,
      changeReason: "regenerate selected activity",
      versionSource: "regenerate",
    });
  }

  // Same guarantee as the "day" scope above, applied per day — a full-trip
  // regenerate must not be the one path where a locked/fixed-time item
  // can still quietly vanish.
  const regeneratedWithProtectedItems = regeneratedWorkspace.itineraryDays.map((regeneratedDay, index) => {
    const originalDay = workspace.itineraryDays[index];
    if (!originalDay || originalDay.dayNumber !== regeneratedDay.dayNumber) return regeneratedDay;
    return mergeProtectedItemsIntoRegeneratedDay(originalDay, regeneratedDay, workspace.preferences);
  });

  const fullyRegeneratedDays = await canonicalizeItineraryCities(
    regeneratedWithProtectedItems,
    existing.isoA2
  ).catch(() => regeneratedWithProtectedItems);

  return updateCountryItinerary(supabase, itineraryId, countryName, {
    title: generated.title,
    summary: generated.summary,
    itineraryDays: fullyRegeneratedDays,
    preferencesSnapshot: workspace.preferences,
    workspaceSnapshot: { ...regeneratedWorkspace, itineraryDays: fullyRegeneratedDays },
    budget: workspace.preferences.budget,
    generationMode: workspace.preferences.generationMode,
    manuallyEdited: false,
    changeReason: "regenerate full itinerary",
    versionSource: "regenerate",
  });
}
