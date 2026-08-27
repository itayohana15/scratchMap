"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { PlaceGalleryImage } from "@/lib/photos/place-images";

interface ImageLightboxProps {
  images: PlaceGalleryImage[];
  activeIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
  itemName: string;
}

/**
 * Full-viewport image viewer (spec item 9) — reuses the project's own
 * Dialog primitive, which already closes on Escape/backdrop click and traps
 * focus, so none of that needs reimplementing. Never navigates away from
 * the activity modal underneath; this is just a layer on top of it.
 */
export function ImageLightbox({ images, activeIndex, open, onOpenChange, onIndexChange, itemName }: ImageLightboxProps) {
  const image = images[activeIndex];

  function goTo(delta: number) {
    if (images.length === 0) return;
    onIndexChange((activeIndex + delta + images.length) % images.length);
  }

  if (!image) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] w-[min(96vw,1400px)] max-w-none flex-col items-center gap-2 bg-background/95 p-3 sm:max-w-none">
        <DialogTitle className="sr-only">
          {itemName} — תמונה {activeIndex + 1} מתוך {images.length}
        </DialogTitle>

        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.url} alt={itemName} className="max-h-full max-w-full rounded-lg object-contain" />

          {images.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => goTo(-1)}
                aria-label="תמונה קודמת"
                className="absolute inset-y-0 right-1 flex items-center justify-center rounded-full bg-background/80 p-2.5 text-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:bg-background sm:right-3"
              >
                <ChevronRight className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => goTo(1)}
                aria-label="תמונה הבאה"
                className="absolute inset-y-0 left-1 flex items-center justify-center rounded-full bg-background/80 p-2.5 text-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:bg-background sm:left-3"
              >
                <ChevronLeft className="size-5" />
              </button>
            </>
          ) : null}

          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/85 px-3 py-1 text-xs font-medium tabular-nums text-foreground shadow-sm ring-1 ring-border/60">
            {activeIndex + 1} מתוך {images.length}
          </div>
        </div>

        {image.attribution ? (
          <p className="shrink-0 text-xs text-muted-foreground" dir="ltr">
            Photo: {image.attribution}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
