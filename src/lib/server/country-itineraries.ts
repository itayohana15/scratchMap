import type { SupabaseClient } from "@supabase/supabase-js";

import type { CountryAiRecommendation } from "@/lib/ai/country-knowledge";
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
import { generateCountryItineraryPlan } from "@/lib/server/country-itinerary-generation";
import type { Database, Tables } from "@/lib/supabase/types";
import {
  applyAiPlanToWorkspace,
  createDefaultWorkspace,
  estimateTravelMinutes,
  normalizeWorkspace,
  type AiItineraryRequest,
  type CountryTripWorkspaceState,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";
import { isMissingCountryItineraryStorageError, toCountryItineraryStorageError } from "@/lib/server/country-itinerary-storage";

type DbClient = SupabaseClient<Database>;

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

export async function generateAndStoreCountryItinerary(
  supabase: DbClient,
  country: Tables<"countries">,
  payload: AiItineraryRequest,
  guide: CountryAiRecommendation | null
) {
  const generated = await generateCountryItineraryPlan(payload, guide);
  const initialWorkspace = buildInitialWorkspace(country.name, payload);
  const generatedWorkspace = applyAiPlanToWorkspace(initialWorkspace, generated);
  const costSummary = computeItineraryCostSummary(generatedWorkspace);
  const title =
    generated.title || buildSuggestedItineraryTitle(country.name, payload.preferences.startDate, payload.preferences.endDate);
  const archived = false;
  const status = deriveItineraryStatus(
    payload.preferences.startDate,
    payload.preferences.endDate,
    archived
  );

  const { data, error } = await supabase
    .from("country_itineraries")
    .insert({
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
    })
    .select("*")
    .single();
  if (error) throw toCountryItineraryStorageError(error);

  const itinerary = normalizeCountryItineraryRow(data);
  await insertVersion(supabase, itinerary, "ai", "initial generation");
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
    existing.status
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
      status: deriveItineraryStatus(existing.startDate, existing.endDate, false, existing.status),
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
  targetItemId?: string | null
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
    const nextDays = workspace.itineraryDays.map((day) => recomputeDayEstimates(day, workspace.preferences));
    return updateCountryItinerary(supabase, itineraryId, countryName, {
      itineraryDays: nextDays,
      preferencesSnapshot: workspace.preferences,
      workspaceSnapshot: { ...workspace, itineraryDays: nextDays },
      manuallyEdited: false,
      changeReason: "optimize route without replacing activities",
      versionSource: "regenerate",
    });
  }

  const generated = await generateCountryItineraryPlan(payload, guide);
  const regeneratedWorkspace = applyAiPlanToWorkspace(workspace, generated);

  if (scope === "day" && targetDayId) {
    const existingDayIndex = workspace.itineraryDays.findIndex((day) => day.id === targetDayId);
    if (existingDayIndex === -1) throw new Error("Target day not found");
    const nextDays = [...workspace.itineraryDays];
    nextDays[existingDayIndex] = {
      ...regeneratedWorkspace.itineraryDays[existingDayIndex],
      id: workspace.itineraryDays[existingDayIndex].id,
    };
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
      nextItems[targetIndex] = { ...replacementItem, id: targetItem.id, locked: targetItem.locked };
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

  return updateCountryItinerary(supabase, itineraryId, countryName, {
    title: generated.title,
    summary: generated.summary,
    itineraryDays: regeneratedWorkspace.itineraryDays,
    preferencesSnapshot: workspace.preferences,
    workspaceSnapshot: regeneratedWorkspace,
    budget: workspace.preferences.budget,
    generationMode: workspace.preferences.generationMode,
    manuallyEdited: false,
    changeReason: "regenerate full itinerary",
    versionSource: "regenerate",
  });
}
