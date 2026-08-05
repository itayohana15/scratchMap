"use client";

import { useQuery } from "@tanstack/react-query";

export interface WikipediaSummary {
  title: string;
  extract: string;
  thumbnailUrl: string | null;
  contentUrl: string | null;
}

interface WikipediaSummaryResponse {
  title: string;
  extract: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}

function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  try {
    const parsed = new URL(url);
    const lang = parsed.hostname.split(".")[0];
    const title = decodeURIComponent(parsed.pathname.replace(/^\/wiki\//, ""));
    if (!lang || !title) return null;
    return { lang, title };
  } catch {
    return null;
  }
}

async function fetchWikipediaSummary(url: string): Promise<WikipediaSummary | null> {
  const parsed = parseWikipediaUrl(url);
  if (!parsed) return null;

  const res = await fetch(
    `https://${parsed.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(parsed.title)}`
  );
  if (!res.ok) return null;
  const data = (await res.json()) as WikipediaSummaryResponse;
  if (!data.extract) return null;

  return {
    title: data.title,
    extract: data.extract,
    thumbnailUrl: data.thumbnail?.source ?? null,
    contentUrl: data.content_urls?.desktop?.page ?? null,
  };
}

// Real, sourced "about" text for a place — used to populate the description
// section instead of writing (or inventing) copy ourselves. Silently
// returns null when there's no wikipedia tag or the lookup fails.
export function useWikipediaSummary(wikipediaUrl: string | null | undefined) {
  return useQuery({
    queryKey: ["wikipedia-summary", wikipediaUrl ?? ""],
    enabled: !!wikipediaUrl,
    queryFn: () => fetchWikipediaSummary(wikipediaUrl!),
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24 * 7,
    retry: false,
  });
}
