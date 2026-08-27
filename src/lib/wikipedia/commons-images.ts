"use client";

import { useQuery } from "@tanstack/react-query";

export interface WikimediaGalleryImage {
  id: string;
  url: string;
  width: number;
  height: number;
  attribution: string | null;
  source: "wikimedia";
}

interface CommonsImageInfo {
  url: string;
  width: number;
  height: number;
  mime: string;
  extmetadata?: {
    Artist?: { value: string };
    LicenseShortName?: { value: string };
  };
}

interface CommonsQueryResponse {
  query?: {
    pages?: Record<string, { title: string; imageinfo?: CommonsImageInfo[] }>;
  };
}

// Boilerplate Commons/Wikipedia UI furniture that shows up as "images used
// on this page" alongside real photos — logos, icons, map pins, edit
// buttons — never something a traveler would want to see in a photo
// gallery (spec item 10's "not logos / not tiny thumbnails / not maps").
const BOILERPLATE_FILENAME_PATTERN =
  /commons-logo|wiktionary|wikidata|wikisource|wikiquote|wikinews|wikivoyage|wikibooks|question[_ ]?book|edit-|ambox|padlock|folder|nuvola|oojs|symbol|sound[-_]?icon|broom[_ ]?icon|red[_ ]?pog|blue[_ ]?pog|location[_ ]?map|locator[_ ]?map|flag[_ ]?of|coat[_ ]?of[_ ]?arms|crystal[_ ]?clear|gnome-|p[_ ]?vip|information[_ ]?icon|disambig|stub|wiki[_ ]?letter/i;

const MIN_IMAGE_DIMENSION = 400;

function isUsablePhoto(title: string, info: CommonsImageInfo): boolean {
  if (!info.mime.startsWith("image/jpeg") && !info.mime.startsWith("image/png") && !info.mime.startsWith("image/webp")) {
    return false; // excludes SVG maps/logos/icons entirely
  }
  if (info.width < MIN_IMAGE_DIMENSION || info.height < MIN_IMAGE_DIMENSION) return false;
  if (BOILERPLATE_FILENAME_PATTERN.test(title)) return false;
  return true;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

async function fetchWikimediaGalleryImages(title: string, limit: number): Promise<WikimediaGalleryImage[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=images&titles=${encodeURIComponent(title)}&gimlimit=40&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&origin=*`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as CommonsQueryResponse;
  const pages = Object.values(data.query?.pages ?? {});

  const images: WikimediaGalleryImage[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info || !isUsablePhoto(page.title, info)) continue;
    const artist = info.extmetadata?.Artist?.value ? stripHtml(info.extmetadata.Artist.value) : null;
    images.push({
      id: info.url,
      url: info.url,
      width: info.width,
      height: info.height,
      attribution: artist,
      source: "wikimedia",
    });
  }

  // Wider (landscape-friendly, spec item 10) and larger images first — a
  // reasonable proxy for "the real establishing shots" over incidental crops.
  images.sort((a, b) => b.width * b.height - a.width * a.height);
  return images.slice(0, limit);
}

/**
 * Real photos from the Wikipedia article's own Commons image set — far more
 * likely to actually depict the specific place than a generic Pexels
 * keyword search (spec item 12's diversity examples — exterior, details,
 * different angles — are exactly what a well-documented landmark's own
 * Commons gallery already contains). Only fetched once a title match exists
 * and only while the modal is open.
 */
export function useWikimediaGalleryImages(title: string | null | undefined, limit: number) {
  return useQuery({
    queryKey: ["wikimedia-gallery-images", title ?? "", limit],
    enabled: !!title,
    queryFn: () => fetchWikimediaGalleryImages(title!, limit),
    staleTime: 1000 * 60 * 60 * 24 * 7,
    gcTime: 1000 * 60 * 60 * 24 * 7,
    retry: false,
  });
}
