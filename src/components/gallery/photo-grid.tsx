"use client";

import { PhotoCard } from "@/components/gallery/photo-card";
import type { Tables } from "@/lib/supabase/types";

interface PhotoGridProps {
  photos: Tables<"photos">[];
  onView: (index: number) => void;
  onDelete: (photo: Tables<"photos">) => void;
  deletingId?: string;
}

export function PhotoGrid({ photos, onView, onDelete, deletingId }: PhotoGridProps) {
  if (photos.length === 0) {
    return (
      <div className="glass-card flex h-32 items-center justify-center text-sm text-muted-foreground">
        אין עדיין תמונות.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {photos.map((photo, index) => (
        <PhotoCard
          key={photo.id}
          photo={photo}
          onView={() => onView(index)}
          onDelete={() => onDelete(photo)}
          deleting={deletingId === photo.id}
        />
      ))}
    </div>
  );
}
