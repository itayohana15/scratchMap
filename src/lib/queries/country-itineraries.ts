"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CountryItineraryGenerationSuccessPayload,
  CountryItineraryRecord,
  CountryItineraryVersionRecord,
} from "@/lib/itineraries";
import type {
  AiItineraryRequest,
  CountryTripWorkspaceState,
  DayOptimizeMode,
} from "@/lib/trip-workspace";

// Matches `tripHubKeys.all` from "@/lib/queries/trip-hub" — inlined as a
// literal (rather than imported) since that module already imports
// `countryItineraryKeys` from this one; importing it back would create a
// circular module dependency between the two query files.
const TRIP_HUB_QUERY_KEY = ["trip-hub"] as const;

export const countryItineraryKeys = {
  all: ["country-itineraries"] as const,
  byIso: (iso: string) => ["country-itineraries", iso.toUpperCase()] as const,
  detail: (iso: string, itineraryId: string) =>
    ["country-itineraries", iso.toUpperCase(), itineraryId] as const,
  versions: (iso: string, itineraryId: string) =>
    ["country-itineraries", iso.toUpperCase(), itineraryId, "versions"] as const,
};

export interface GenerateCountryItineraryResult {
  itinerary: CountryItineraryRecord;
  success: CountryItineraryGenerationSuccessPayload;
}

function upsertItineraryList(
  current: CountryItineraryRecord[] | undefined,
  itinerary: CountryItineraryRecord
) {
  return [itinerary, ...(current ?? []).filter((item) => item.id !== itinerary.id)].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/** Carries the full parsed error body (status/code/message/any extra fields) so callers can log or branch on it, not just the human-readable message. */
export class ApiRequestError extends Error {
  status: number;
  code?: string;
  body: unknown;

  constructor(message: string, status: number, code: string | undefined, body: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    // `message` is the human-readable text; `error` is a machine code
    // (e.g. "PLAN_NOT_FEASIBLE") that would otherwise leak straight into the UI.
    throw new ApiRequestError(
      body?.message ?? body?.error ?? "Request failed",
      response.status,
      body?.error,
      body
    );
  }
  return (await response.json()) as T;
}

export function useCountryItineraries(iso: string | undefined) {
  return useQuery({
    queryKey: countryItineraryKeys.byIso(iso ?? ""),
    enabled: !!iso,
    queryFn: async () => {
      const data = await parseJson<{ itineraries: CountryItineraryRecord[] }>(
        await fetch(`/api/countries/${iso!.toLowerCase()}/itineraries`)
      );
      return data.itineraries;
    },
  });
}

export function useCountryItinerary(iso: string | undefined, itineraryId: string | undefined) {
  return useQuery({
    queryKey: countryItineraryKeys.detail(iso ?? "", itineraryId ?? ""),
    enabled: !!iso && !!itineraryId,
    queryFn: async () => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso!.toLowerCase()}/itineraries/${itineraryId!}`)
      );
      return data.itinerary;
    },
  });
}

export function useCountryItineraryVersions(
  iso: string | undefined,
  itineraryId: string | undefined
) {
  return useQuery({
    queryKey: countryItineraryKeys.versions(iso ?? "", itineraryId ?? ""),
    enabled: !!iso && !!itineraryId,
    queryFn: async () => {
      const data = await parseJson<{ versions: CountryItineraryVersionRecord[] }>(
        await fetch(`/api/countries/${iso!.toLowerCase()}/itineraries/${itineraryId!}/versions`)
      );
      return data.versions;
    },
  });
}

export function useGenerateCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ signal, ...payload }: AiItineraryRequest & { signal?: AbortSignal }) => {
      if (process.env.NODE_ENV !== "production") {
        console.log("[Itinerary] request payload", {
          isoA2: iso.toUpperCase(),
          clientRequestId: payload.clientRequestId,
          startDate: payload.preferences.startDate,
          endDate: payload.preferences.endDate,
          travelers: payload.preferences.travelers,
          budget: payload.preferences.budget,
          tripStyle: payload.preferences.tripStyle,
          tripPace: payload.preferences.tripPace,
          generationMode: payload.preferences.generationMode,
          interests: payload.preferences.interests,
          transportationPreferences: payload.preferences.transportationPreferences,
          recommendationsCount: payload.recommendations.length,
          selectedPlacesCount: payload.selectedPlaces.length,
        });
      }
      const data = await parseJson<GenerateCountryItineraryResult>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        })
      );
      return data;
    },
    // A 422 (or any 4xx) is a client/business-validation rejection, not a
    // transient failure — retrying the identical payload would just fail
    // identically again (and, per spec, must never fire automatically).
    retry: false,
    onError: (error) => {
      if (process.env.NODE_ENV === "production") return;
      if (error instanceof ApiRequestError) {
        console.error(`[Itinerary ${error.status}]`, { code: error.code, body: error.body });
      } else {
        console.error("[Itinerary] request failed", error);
      }
    },
    onSuccess: ({ itinerary }) => {
      queryClient.setQueryData<CountryItineraryRecord[]>(
        countryItineraryKeys.byIso(iso),
        (current) => upsertItineraryList(current, itinerary)
      );
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
      // Trips/Dashboard/Passport all read from `useTripHubTrips()` — invalidate
      // it too so a freshly generated itinerary shows up without a manual
      // refresh (spec §B24).
      queryClient.invalidateQueries({ queryKey: TRIP_HUB_QUERY_KEY });
    },
  });
}

export function useUpdateCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      itineraryId,
      ...body
    }: {
      itineraryId: string;
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
    }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      return data.itinerary;
    },
    onSuccess: (itinerary) => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.versions(iso, itinerary.id),
      });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
    },
  });
}

export function useDuplicateCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itineraryId: string) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/duplicate`, {
          method: "POST",
        })
      );
      return data.itinerary;
    },
    onSuccess: (itinerary) => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
    },
  });
}

export function useArchiveCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itineraryId: string) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/archive`, {
          method: "POST",
        })
      );
      return data.itinerary;
    },
    onSuccess: (itinerary) => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.versions(iso, itinerary.id),
      });
    },
  });
}

export function useDeleteCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (itineraryId: string) => {
      await parseJson<{ ok: true }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}`, {
          method: "DELETE",
        })
      );
      return itineraryId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
    },
  });
}

export function useRegenerateCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      itineraryId,
      scope,
      targetDayId,
      targetItemId,
      optimizeMode,
      liveInstruction,
    }: {
      itineraryId: string;
      scope: NonNullable<AiItineraryRequest["regenerationScope"]>;
      targetDayId?: string | null;
      targetItemId?: string | null;
      optimizeMode?: DayOptimizeMode | null;
      liveInstruction?: string | null;
    }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/regenerate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, targetDayId, targetItemId, optimizeMode, liveInstruction }),
        })
      );
      return data.itinerary;
    },
    onSuccess: (itinerary) => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.versions(iso, itinerary.id),
      });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
    },
  });
}

export function useRestoreCountryItineraryVersion(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      itineraryId,
      versionId,
    }: {
      itineraryId: string;
      versionId: string;
    }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId }),
        })
      );
      return data.itinerary;
    },
    onSuccess: (itinerary) => {
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.versions(iso, itinerary.id),
      });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
    },
  });
}
