"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import type { Tables } from "@/lib/supabase/types";

const BUCKET = "photos";

export const photoKeys = {
  byCountry: (countryId: string) => ["photos", "country", countryId] as const,
  byCity: (cityId: string) => ["photos", "city", cityId] as const,
};

export function usePhotosForCountry(countryId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: photoKeys.byCountry(countryId ?? ""),
    enabled: !!countryId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("photos")
        .select("*")
        .eq("country_id", countryId!)
        .order("sort_order")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function usePhotosForCity(cityId: string | undefined) {
  const supabase = createClient();

  return useQuery({
    queryKey: photoKeys.byCity(cityId ?? ""),
    enabled: !!cityId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("photos")
        .select("*")
        .eq("city_id", cityId!)
        .order("sort_order")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function photoPublicUrl(storagePath: string) {
  const supabase = createClient();
  return supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

interface UploadPhotoInput {
  file: File;
  countryId?: string;
  cityId?: string;
  tripId?: string;
  caption?: string;
  takenAt?: string;
}

export function useUploadPhoto() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ file, countryId, cityId, tripId, caption, takenAt }: UploadPhotoInput) => {
      const scopeId = cityId ?? countryId;
      const extension = file.name.split(".").pop() ?? "jpg";
      const storagePath = `${scopeId}/${crypto.randomUUID()}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file, { cacheControl: "3600", upsert: false });
      if (uploadError) throw uploadError;

      const dimensions = await readImageDimensions(file);

      const { data, error } = await supabase
        .from("photos")
        .insert({
          country_id: countryId ?? null,
          city_id: cityId ?? null,
          trip_id: tripId ?? null,
          storage_path: storagePath,
          caption: caption ?? null,
          taken_at: takenAt ?? null,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
        })
        .select()
        .single();

      if (error) {
        await supabase.storage.from(BUCKET).remove([storagePath]);
        throw error;
      }

      return data as Tables<"photos">;
    },
    onSuccess: (photo) => {
      if (photo.country_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCountry(photo.country_id) });
      }
      if (photo.city_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCity(photo.city_id) });
      }
    },
  });
}

export function useDeletePhoto() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (photo: Tables<"photos">) => {
      const { error: storageError } = await supabase.storage
        .from(BUCKET)
        .remove([photo.storage_path]);
      if (storageError) throw storageError;

      const { error } = await supabase.from("photos").delete().eq("id", photo.id);
      if (error) throw error;

      return photo;
    },
    onSuccess: (photo) => {
      if (photo.country_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCountry(photo.country_id) });
      }
      if (photo.city_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCity(photo.city_id) });
      }
    },
  });
}

export function useUpdatePhotoCaption() {
  const supabase = createClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      caption,
      takenAt,
    }: {
      id: string;
      caption: string | null;
      takenAt: string | null;
    }) => {
      const { data, error } = await supabase
        .from("photos")
        .update({ caption, taken_at: takenAt })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Tables<"photos">;
    },
    onSuccess: (photo) => {
      if (photo.country_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCountry(photo.country_id) });
      }
      if (photo.city_id) {
        queryClient.invalidateQueries({ queryKey: photoKeys.byCity(photo.city_id) });
      }
    },
  });
}

function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof window === "undefined" || !file.type.startsWith("image/")) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
