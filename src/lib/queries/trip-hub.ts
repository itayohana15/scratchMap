"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { normalizeCountryItineraryRow, type CountryItineraryRecord } from "@/lib/itineraries";
import { countryItineraryKeys } from "@/lib/queries/country-itineraries";
import { isMissingCountryItineraryStorageError } from "@/lib/server/country-itinerary-storage";
import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/types";
import { buildTripHubTrip, type TripHubCountry } from "@/lib/trip-hub";

export const tripHubKeys = {
  all: ["trip-hub"] as const,
};

interface CountryItineraryHubRow extends Tables<"country_itineraries"> {
  countries: Pick<Tables<"countries">, "id" | "name" | "iso_a2" | "status"> | null;
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Request failed");
  }

  return (await response.json()) as T;
}

function toTripHubCountry(
  country: Pick<Tables<"countries">, "id" | "name" | "iso_a2" | "status"> | null
): TripHubCountry | null {
  if (!country) return null;

  return {
    id: country.id,
    name: country.name,
    isoA2: country.iso_a2,
    status: country.status,
  };
}

export function useTripHubTrips() {
  const supabase = createClient();

  return useQuery({
    queryKey: tripHubKeys.all,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("country_itineraries")
        .select("*, countries(id, name, iso_a2, status)")
        .is("deleted_at", null)
        .order("updated_at", { ascending: false });

      if (error) {
        if (isMissingCountryItineraryStorageError(error)) {
          return [];
        }

        throw error;
      }

      const rows = (data ?? []) as CountryItineraryHubRow[];
      const photoCountByItinerary = await fetchPhotoCountsByItinerary(
        supabase,
        rows.map((row) => row.id)
      );

      return rows.map((row) =>
        buildTripHubTrip(
          normalizeCountryItineraryRow(row),
          toTripHubCountry(row.countries),
          photoCountByItinerary.get(row.id) ?? 0
        )
      );
    },
  });
}

async function fetchPhotoCountsByItinerary(
  supabase: ReturnType<typeof createClient>,
  itineraryIds: string[]
) {
  const counts = new Map<string, number>();
  if (itineraryIds.length === 0) return counts;

  const { data, error } = await supabase
    .from("photos")
    .select("itinerary_id")
    .in("itinerary_id", itineraryIds);
  if (error) throw error;

  for (const row of data ?? []) {
    if (!row.itinerary_id) continue;
    counts.set(row.itinerary_id, (counts.get(row.itinerary_id) ?? 0) + 1);
  }
  return counts;
}

export function useDuplicateTripHubItinerary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      isoA2,
      itineraryId,
    }: {
      isoA2: string;
      itineraryId: string;
    }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${isoA2.toLowerCase()}/itineraries/${itineraryId}/duplicate`, {
          method: "POST",
        })
      );

      return data.itinerary;
    },
    onSuccess: (_itinerary, variables) => {
      queryClient.invalidateQueries({ queryKey: tripHubKeys.all });
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
      queryClient.invalidateQueries({
        queryKey: countryItineraryKeys.byIso(variables.isoA2),
      });
    },
  });
}

/** Trip-hub-scoped counterparts to the dialog's own rename/archive/delete mutations — same routes, but also invalidate tripHubKeys.all so the Trips page gallery updates immediately with no browser refresh. */
export function useRenameTripHubItinerary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ isoA2, itineraryId, title }: { isoA2: string; itineraryId: string; title: string }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${isoA2.toLowerCase()}/itineraries/${itineraryId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        })
      );
      return data.itinerary;
    },
    onSuccess: (_itinerary, variables) => {
      queryClient.invalidateQueries({ queryKey: tripHubKeys.all });
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(variables.isoA2) });
    },
  });
}

export function useArchiveTripHubItinerary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ isoA2, itineraryId }: { isoA2: string; itineraryId: string }) => {
      const data = await parseJson<{ itinerary: CountryItineraryRecord }>(
        await fetch(`/api/countries/${isoA2.toLowerCase()}/itineraries/${itineraryId}/archive`, {
          method: "POST",
        })
      );
      return data.itinerary;
    },
    onSuccess: (_itinerary, variables) => {
      queryClient.invalidateQueries({ queryKey: tripHubKeys.all });
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(variables.isoA2) });
    },
  });
}

export function useDeleteTripHubItinerary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ isoA2, itineraryId }: { isoA2: string; itineraryId: string }) => {
      await parseJson<{ ok: true }>(
        await fetch(`/api/countries/${isoA2.toLowerCase()}/itineraries/${itineraryId}`, {
          method: "DELETE",
        })
      );
      return { isoA2, itineraryId };
    },
    onSuccess: (variables) => {
      queryClient.invalidateQueries({ queryKey: tripHubKeys.all });
      queryClient.invalidateQueries({ queryKey: ["countries", "map-statuses"] });
      queryClient.invalidateQueries({ queryKey: countryItineraryKeys.byIso(variables.isoA2) });
    },
  });
}
