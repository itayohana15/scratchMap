"use client";

import { ChevronLeft, ChevronRight, Star, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { photoPublicUrl, useUpdatePhotoFavorite } from "@/lib/queries/photos";
import type { Tables } from "@/lib/supabase/types";

interface PhotoLightboxProps {
  photos: Tables<"photos">[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (photo: Tables<"photos">) => void;
}

export function PhotoLightbox({
  photos,
  index,
  onIndexChange,
  open,
  onOpenChange,
  onDelete,
}: PhotoLightboxProps) {
  const photo = photos[index];
  const updateFavorite = useUpdatePhotoFavorite();

  const goPrev = useCallback(() => {
    onIndexChange((index - 1 + photos.length) % photos.length);
  }, [index, photos.length, onIndexChange]);

  const goNext = useCallback(() => {
    onIndexChange((index + 1) % photos.length);
  }, [index, photos.length, onIndexChange]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, goPrev, goNext]);

  if (!photo) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[92vh] w-[96vw] max-w-6xl flex-col gap-0 border-0 bg-black/95 p-0 sm:max-w-6xl"
      >
        <DialogTitle className="sr-only">{photo.caption ?? "תמונה"}</DialogTitle>

        <div className="relative flex-1">
          <Image
            src={photoPublicUrl(photo.storage_path)}
            alt={photo.caption ?? ""}
            fill
            sizes="96vw"
            className="object-contain"
            priority
          />

          {photos.length > 1 && (
            <>
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-1/2 left-3 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60"
                onClick={goPrev}
                aria-label="התמונה הקודמת"
              >
                <ChevronLeft className="size-5" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-1/2 right-3 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60"
                onClick={goNext}
                aria-label="התמונה הבאה"
              >
                <ChevronRight className="size-5" />
              </Button>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3 text-white">
          <div>
            {photo.caption && <p className="text-sm font-medium">{photo.caption}</p>}
            {photo.taken_at && (
              <p className="text-xs text-white/60">{formatDate(photo.taken_at)}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className={cn(
                "gap-1.5 bg-white/10 text-white hover:bg-white/20",
                photo.favorite && "text-warning"
              )}
              onClick={() =>
                updateFavorite.mutate({ id: photo.id, favorite: !photo.favorite })
              }
            >
              <Star className={cn("size-3.5", photo.favorite && "fill-current")} />
              מועדף
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5 bg-white/10 text-white hover:bg-white/20"
              onClick={() => onDelete(photo)}
            >
              <Trash2 className="size-3.5" />
              מחיקה
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
