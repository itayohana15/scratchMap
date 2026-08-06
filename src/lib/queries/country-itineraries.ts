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
} from "@/lib/trip-workspace";

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

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Request failed");
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
    mutationFn: async (payload: AiItineraryRequest) => {
      const data = await parseJson<GenerateCountryItineraryResult>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
      return data;
    },
    onSuccess: ({ itinerary }) => {
      queryClient.setQueryData<CountryItineraryRecord[]>(
        countryItineraryKeys.byIso(iso),
        (current) => upsertItineraryList(current, itinerary)
      );
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(iso) });
      queryClient.setQueryData(countryItineraryKeys.detail(iso, itinerary.id), itinerary);
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
    }: {
      itineraryId: string;
      scope: NonNullable<AiItineraryRequest["regenerationScope"]>;
      targetDayId?: string | null;
      targetItemId?: string | null;
    }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${iso.toLowerCase()}/itineraries/${itineraryId}/regenerate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, targetDayId, targetItemId }),
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
