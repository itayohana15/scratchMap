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

async function fetchWikipediaSummaryByTitle(lang: string, title: string): Promise<WikipediaSummary | null> {
  const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
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

async function fetchWikipediaSummary(url: string): Promise<WikipediaSummary | null> {
  const parsed = parseWikipediaUrl(url);
  if (!parsed) return null;
  return fetchWikipediaSummaryByTitle(parsed.lang, parsed.title);
}

async function runWikipediaOpenSearch(query: string): Promise<string | null> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json&origin=*`;
  const res = await fetch(searchUrl);
  if (!res.ok) return null;
  const data = (await res.json()) as [string, string[]];
  return data[1]?.[0] ?? null;
}

const TITLE_MATCH_STOPWORDS = new Set(["the", "of", "and", "de", "la", "el", "a", "an", "der", "den"]);

// OpenSearch does prefix/title matching, not relevance search — it can
// return a confidently-wrong result for a short or unusual name (e.g.
// "Rike Park" resolves to "Rosa Parks", a pure spelling-distance
// coincidence with nothing to do with the actual place). Requires at least
// one real word shared between the query name and the resolved title before
// trusting the match; otherwise treats it the same as "no match found."
function sharesAMeaningfulWord(name: string, resolvedTitle: string): boolean {
  const nameWords = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !TITLE_MATCH_STOPWORDS.has(word));
  if (nameWords.length === 0) return true; // nothing meaningful to check against — trust it
  const titleLower = resolvedTitle.toLowerCase();
  return nameWords.some((word) => titleLower.includes(word));
}

// Resolves a free-text place name (no known wikipedia URL) to its closest
// matching English Wikipedia article via the OpenSearch API. Used for
// itinerary items, which — unlike saved recommendations — never carry a
// wikipediaUrl. Tries the name+hint query first (helps disambiguate a
// generic name like "Freedom Square"), but OpenSearch's prefix matching
// means appending a hint after an already-complete, specific title (e.g.
// "Narikala Fortress" + "Tbilisi") can turn a perfectly good match into no
// match at all — so a hinted miss falls back to the plain name on its own.
// A wrong or missing match either way is expected and handled the same way
// as "no data": the caller simply shows no Wikipedia content, never a
// mismatched one. Exported/cached separately from the summary fetch so the
// gallery-images lookup (commons-images.ts) can reuse the same resolved
// title without a second, redundant name-matching heuristic.
async function resolveWikipediaTitle(name: string, hint: string): Promise<string | null> {
  const hintedMatch = hint ? await runWikipediaOpenSearch(`${name} ${hint}`) : null;
  const resolved = hintedMatch ?? (await runWikipediaOpenSearch(name));
  if (!resolved || !sharesAMeaningfulWord(name, resolved)) return null;
  return resolved;
}

async function fetchWikipediaSummaryByName(name: string, hint: string): Promise<WikipediaSummary | null> {
  const title = await resolveWikipediaTitle(name, hint);
  if (!title) return null;
  return fetchWikipediaSummaryByTitle("en", title);
}

// Same shape/caching contract as useWikipediaSummary, but for places that
// only have a display name (e.g. itinerary items) instead of a stored
// wikipedia URL. `hint` (typically the city/region) narrows ambiguous names.
export function useWikipediaSummaryByName(name: string | null | undefined, hint: string) {
  return useQuery({
    queryKey: ["wikipedia-summary-by-name", name ?? "", hint],
    enabled: !!name,
    queryFn: () => fetchWikipediaSummaryByName(name!, hint),
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24 * 7,
    retry: false,
  });
}

// The resolved article title alone (no summary fetch) — used by
// commons-images.ts to pull that article's own photo gallery. Same
// queryKey shape as a plain title-match cache entry, independent of
// useWikipediaSummaryByName's own (slightly redundant, cheap) resolution.
export function useWikipediaTitleMatch(name: string | null | undefined, hint: string) {
  return useQuery({
    queryKey: ["wikipedia-title-match", name ?? "", hint],
    enabled: !!name,
    queryFn: () => resolveWikipediaTitle(name!, hint),
    staleTime: 1000 * 60 * 60 * 24,
    gcTime: 1000 * 60 * 60 * 24 * 7,
    retry: false,
  });
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
