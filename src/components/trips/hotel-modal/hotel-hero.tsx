"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Image as ImageIcon } from "lucide-react";

import { ImageLightbox } from "@/components/trips/activity-modal/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlaceImages } from "@/lib/photos/place-images";
import { cn } from "@/lib/utils";

interface HotelHeroProps {
  hotelName: string;
  countryName: string;
  open: boolean;
}

function isTextInputFocused(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active as HTMLElement).isContentEditable;
}

/**
 * Same hero+thumbnail-strip gallery mechanics as ActivityHero (spec item
 * 14 — both detail modals should feel like one product): one unified
 * images[] + activeImageIndex, arrow-key nav (skipped while a text input
 * is focused), hover chevrons, "n מתוך m" counter, lazy thumbnails,
 * skeletons while loading, broken-image dedup. Parameterized on a plain
 * hotel name instead of a TripItineraryItem since a hotel isn't one.
 */
export function HotelHero({ hotelName, countryName, open }: HotelHeroProps) {
  const placeImages = usePlaceImages(hotelName, countryName, open);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const images = useMemo(
    () => placeImages.images.filter((image) => !failedIds.has(image.id)),
    [placeImages.images, failedIds]
  );
  const safeIndex = images.length === 0 ? 0 : Math.min(activeImageIndex, images.length - 1);
  const activeImage = images[safeIndex] ?? null;

  function markFailed(id: string) {
    setFailedIds((current) => new Set(current).add(id));
  }

  function goTo(delta: number) {
    if (images.length === 0) return;
    setActiveImageIndex((safeIndex + delta + images.length) % images.length);
  }

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (isTextInputFocused()) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goTo(-1);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, safeIndex, images.length]);

  const showThumbnailSkeletons = placeImages.isLoading && images.length === 0;

  return (
    <div className="space-y-2">
      <div className="group/hero relative aspect-[2/1] w-full overflow-hidden rounded-2xl bg-gradient-to-br from-primary/15 to-muted">
        {activeImage ? (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block h-full w-full cursor-zoom-in"
            aria-label="הצג תמונה מוגדלת"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeImage.url}
              alt={hotelName}
              loading="eager"
              className="h-full w-full object-cover"
              onError={() => markFailed(activeImage.id)}
            />
          </button>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-10 opacity-50" />
          </div>
        )}

        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={() => goTo(-1)}
              aria-label="תמונה קודמת"
              className="absolute inset-y-0 right-1.5 flex items-center justify-center rounded-full bg-background/75 p-1.5 text-foreground opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity group-hover/hero:opacity-100"
            >
              <ChevronRight className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => goTo(1)}
              aria-label="תמונה הבאה"
              className="absolute inset-y-0 left-1.5 flex items-center justify-center rounded-full bg-background/75 p-1.5 text-foreground opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity group-hover/hero:opacity-100"
            >
              <ChevronLeft className="size-4" />
            </button>
          </>
        ) : null}

        {images.length > 0 ? (
          <div className="absolute bottom-2 left-2 rounded-full bg-background/80 px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground shadow-sm">
            {safeIndex + 1} מתוך {images.length}
          </div>
        ) : null}
      </div>

      {images.length > 1 || showThumbnailSkeletons ? (
        <div className="flex gap-1.5 overflow-x-auto overflow-y-hidden pb-1">
          {showThumbnailSkeletons
            ? Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-16 shrink-0 rounded-lg sm:h-14 sm:w-20" />
              ))
            : images.map((image, index) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setActiveImageIndex(index)}
                  className={cn(
                    "h-12 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-all sm:h-14 sm:w-20",
                    index === safeIndex
                      ? "scale-[1.02] border-primary ring-2 ring-primary/30"
                      : "border-transparent opacity-80 hover:border-border hover:opacity-100"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={() => markFailed(image.id)}
                  />
                </button>
              ))}
        </div>
      ) : null}

      <ImageLightbox
        images={images}
        activeIndex={safeIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setActiveImageIndex}
        itemName={hotelName}
      />
    </div>
  );
}
