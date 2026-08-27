"use client";

import { useQuery } from "@tanstack/react-query";

import { useWikimediaGalleryImages } from "@/lib/wikipedia/commons-images";
import { useWikipediaSummaryByName, useWikipediaTitleMatch } from "@/lib/wikipedia/summary";

export const MAX_GALLERY_IMAGES = 10;

export interface PlaceGalleryImage {
  id: string;
  url: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
  attribution: string | null;
  source: "wikimedia" | "pexels";
}

interface PexelsGalleryPhoto {
  url: string;
  photographer: string | null;
  photographerUrl: string | null;
}

async function fetchPexelsGallery(query: string, count: number): Promise<PexelsGalleryPhoto[]> {
  if (count <= 0) return [];
  const res = await fetch(`/api/places/photo?q=${encodeURIComponent(query)}&count=${count}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { photos?: PexelsGalleryPhoto[] };
  return data.photos ?? [];
}

// A handful of supplementary photos topping up the gallery to MAX_GALLERY_IMAGES.
function usePexelsGallery(query: string | null | undefined, count: number) {
  return useQuery({
    queryKey: ["pexels-gallery", query ?? "", count],
    enabled: !!query && count > 0,
    queryFn: () => fetchPexelsGallery(query!, count),
    staleTime: 1000 * 60 * 60 * 24 * 30,
    gcTime: 1000 * 60 * 60 * 24 * 30,
    retry: false,
  });
}

export interface PlaceImages {
  images: PlaceGalleryImage[];
  description: string | null;
  descriptionSource: "wikipedia" | null;
  descriptionUrl: string | null;
  isLoading: boolean;
}

/**
 * On-demand image + description lookup for one itinerary activity, fetched
 * only while its details modal is open (never preloaded for a whole trip —
 * spec's performance rule). One unified `images[]` array (never separate
 * hero/gallery datasets — the hero is just images[activeImageIndex] in the
 * consuming component).
 *
 * Sourcing order: a matched Wikipedia article's own Commons photo set comes
 * first — these are real, specific photos of the actual place, often with
 * genuine variety (exterior/detail/angle/season) for well-documented
 * landmarks. Pexels tops up the remaining slots up to MAX_GALLERY_IMAGES
 * when the Wikimedia set is thin or missing — a generic stock search, not
 * guaranteed to be the exact spot. Deduplicated by URL; capped at 10.
 */
export function usePlaceImages(name: string | null | undefined, hint: string, enabled: boolean): PlaceImages {
  const titleMatch = useWikipediaTitleMatch(enabled ? name : null, hint);
  const wikipedia = useWikipediaSummaryByName(enabled ? name : null, hint);
  const wikimediaGallery = useWikimediaGalleryImages(enabled ? titleMatch.data : null, MAX_GALLERY_IMAGES);

  const wikimediaImages: PlaceGalleryImage[] = (wikimediaGallery.data ?? []).map((image) => ({
    id: image.id,
    url: image.url,
    thumbnailUrl: image.url,
    width: image.width,
    height: image.height,
    attribution: image.attribution,
    source: "wikimedia" as const,
  }));

  const remainingSlots = Math.max(MAX_GALLERY_IMAGES - wikimediaImages.length, 0);
  // Only fire the Pexels request once we actually know how many slots are
  // left to fill (i.e. the Wikimedia lookup settled) — avoids an initial
  // over-fetch that would just get discarded once Wikimedia results land.
  const pexelsQueryReady = !titleMatch.isLoading && !wikimediaGallery.isLoading;
  const pexels = usePexelsGallery(
    enabled && pexelsQueryReady ? [name, hint].filter(Boolean).join(" ") : null,
    remainingSlots
  );

  const seenUrls = new Set(wikimediaImages.map((image) => image.url));
  const pexelsImages: PlaceGalleryImage[] = (pexels.data ?? [])
    .filter((photo) => !seenUrls.has(photo.url))
    .map((photo) => ({
      id: photo.url,
      url: photo.url,
      thumbnailUrl: photo.url,
      width: 800,
      height: 450,
      attribution: photo.photographer,
      source: "pexels" as const,
    }));

  const images = [...wikimediaImages, ...pexelsImages].slice(0, MAX_GALLERY_IMAGES);

  return {
    images,
    description: wikipedia.data?.extract ?? null,
    descriptionSource: wikipedia.data ? "wikipedia" : null,
    descriptionUrl: wikipedia.data?.contentUrl ?? null,
    isLoading: titleMatch.isLoading || wikipedia.isLoading || wikimediaGallery.isLoading || pexels.isLoading,
  };
}
