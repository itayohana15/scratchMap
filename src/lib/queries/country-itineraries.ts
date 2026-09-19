"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isClientDebugEnabled } from "@/lib/client-debug";
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
import type { GenerationProgressEvent, GenerationProgressReporter } from "@/lib/server/generation-progress";

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
  /** The APPLICATION-level status this error represents (e.g. 422/500 from a streamed generation error frame) — NOT necessarily the real HTTP transport status; see `httpStatus`. */
  status: number;
  code?: string;
  body: unknown;
  /**
   * Round 9.3.5 §18 — the REAL wire-level HTTP status of the response.
   * For a plain (non-streamed) request this always equals `status`. For a
   * streamed generation response, headers commit to 200 before the
   * application-level outcome is known (see readGenerationStream), so a
   * failed generation can carry `httpStatus: 200` alongside a real
   * `status`/`code` describing the APPLICATION failure — these are never
   * the same thing and must never be logged as if they were.
   */
  httpStatus: number;

  constructor(message: string, status: number, code: string | undefined, body: unknown, httpStatus?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.httpStatus = httpStatus ?? status;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string; code?: string; message?: string }
      | null;
    // `message` is the human-readable text; `error` is a machine code
    // (e.g. "PLAN_NOT_FEASIBLE") that would otherwise leak straight into the UI.
    throw new ApiRequestError(
      body?.message ?? body?.error ?? body?.code ?? "Request failed",
      response.status,
      body?.error ?? body?.code,
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

/**
 * Round 9.3.3 §22 — the generation endpoint's response body is NDJSON: zero
 * or more `{"type":"progress",...}` lines (real server stage completions,
 * as they genuinely happen), followed by exactly one final
 * `{"type":"result",...}` or `{"type":"error",...}` line. This reads that
 * stream incrementally (no polling — the browser delivers chunks as they
 * arrive) and never buffers/replays a stream for any OTHER call to this
 * function, so one generation's events can't reach another's caller.
 */
export async function readGenerationStream(
  response: Response,
  onProgress?: GenerationProgressReporter
): Promise<GenerateCountryItineraryResult> {
  // A non-200 response is one of the route's EARLY, pre-generation
  // validation failures (bad payload/country not found/flight mismatch) —
  // those are still a single plain JSON error body, never the NDJSON
  // stream, since generation itself never started. Only a 200 response
  // means generateAndStoreCountryItinerary actually ran and streamed.
  if (!response.ok || !response.body) {
    return parseJson<GenerateCountryItineraryResult>(response);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: GenerateCountryItineraryResult | null = null;
  let errorFrame: { status: number; code?: string; message: string; details?: unknown } | null = null;

  function handleLine(line: string) {
    if (!line.trim()) return;
    const frame = JSON.parse(line) as
      | { type: "progress"; event: GenerationProgressEvent }
      | { type: "result"; data: GenerateCountryItineraryResult }
      | { type: "error"; status: number; code?: string; message: string; details?: unknown };
    if (frame.type === "progress") {
      onProgress?.(frame.event);
    } else if (frame.type === "result") {
      result = frame.data;
    } else {
      errorFrame = { status: frame.status, code: frame.code, message: frame.message, details: frame.details };
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);

  if (errorFrame) {
    const frame: { status: number; code?: string; message: string; details?: unknown } = errorFrame;
    // Round 9.3.5 §18 — `response.status` (the real wire-level HTTP status,
    // 200 here — headers were already committed before this application-
    // level error was even known) is deliberately passed as `httpStatus`,
    // kept distinct from `frame.status` (the APPLICATION status the server
    // decided this generation failure represents, e.g. 422/500). Callers
    // must never conflate the two.
    throw new ApiRequestError(frame.message, frame.status, frame.code, frame.details, response.status);
  }
  if (!result) {
    throw new ApiRequestError("Generation stream ended without a result", 500, "GENERATION_FAILED", null);
  }
  return result;
}

export function useGenerateCountryItinerary(iso: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      signal,
      onProgress,
      ...payload
    }: AiItineraryRequest & { signal?: AbortSignal; onProgress?: GenerationProgressReporter }) => {
      if (isClientDebugEnabled()) {
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
      const response = await fetch(`/api/countries/${iso.toLowerCase()}/itineraries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      return readGenerationStream(response, onProgress);
    },
    // A 422 (or any 4xx) is a client/business-validation rejection, not a
    // transient failure — retrying the identical payload would just fail
    // identically again (and, per spec, must never fire automatically).
    retry: false,
    onError: (error) => {
      if (process.env.NODE_ENV === "production") return;
      if (error instanceof ApiRequestError) {
        // Round 9.3.5 §18 — never label this with a fabricated HTTP status:
        // a streamed generation failure genuinely has httpStatus 200 (the
        // transport succeeded) alongside an application-level status/code
        // describing what actually went wrong. Both are logged, distinctly.
        console.error("[Itinerary generation error]", { httpStatus: error.httpStatus, status: error.status, code: error.code, body: error.body });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
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
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.versions(iso, itinerary.id),
      });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
    },
  });
}
