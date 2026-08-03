"use client";

import { useState } from "react";
import { toast } from "sonner";

import { PhotoGrid } from "@/components/gallery/photo-grid";
import { PhotoLightbox } from "@/components/gallery/photo-lightbox";
import { PhotoUploadDialog } from "@/components/gallery/photo-upload-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeletePhoto, usePhotosForCity, usePhotosForCountry } from "@/lib/queries/photos";
import type { Tables } from "@/lib/supabase/types";

interface PhotoGalleryProps {
  countryId?: string;
  cityId?: string;
  title?: string;
}

export function PhotoGallery({ countryId, cityId, title = "גלריה" }: PhotoGalleryProps) {
  const countryPhotos = usePhotosForCountry(cityId ? undefined : countryId);
  const cityPhotos = usePhotosForCity(cityId);
  const { data: photos, isLoading } = cityId ? cityPhotos : countryPhotos;

  const deletePhoto = useDeletePhoto();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function handleDelete(photo: Tables<"photos">) {
    try {
      await deletePhoto.mutateAsync(photo);
      toast.success("התמונה נמחקה");
      setLightboxIndex(null);
    } catch {
      toast.error("מחיקת התמונה נכשלה");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">{title}</h2>
        <PhotoUploadDialog countryId={countryId} cityId={cityId} />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : (
        <PhotoGrid
          photos={photos ?? []}
          onView={setLightboxIndex}
          onDelete={handleDelete}
          deletingId={deletePhoto.isPending ? deletePhoto.variables?.id : undefined}
        />
      )}

      {photos && photos.length > 0 && lightboxIndex != null && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          open={lightboxIndex != null}
          onOpenChange={(open) => !open && setLightboxIndex(null)}
          onDelete={handleDelete}
        />
      )}
    </section>
  );
}
