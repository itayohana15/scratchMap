// Server-only helper around the Pexels photo search API (free tier).
export interface PexelsPhoto {
  src: { original: string };
  photographer: string;
  photographer_url: string;
}

interface PexelsSearchResponse {
  photos: PexelsPhoto[];
}

export async function searchPexelsPhoto(query: string): Promise<PexelsPhoto | undefined> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error("PEXELS_API_KEY is not configured");

  const searchUrl = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const res = await fetch(searchUrl, {
    headers: { Authorization: apiKey },
    next: { revalidate: 60 * 60 * 24 * 30 },
  });
  if (!res.ok) throw new Error(`Pexels request failed (${res.status})`);
  const data = (await res.json()) as PexelsSearchResponse;
  return data.photos?.[0];
}

// Pexels serves images through imgix — request a pre-cropped frame with
// content-aware ("entropy") cropping so the subject isn't lost to a blind
// client-side crop when the display box's aspect ratio differs from the
// source photo's.
export function pexelsCroppedUrl(photo: PexelsPhoto, width: number, height: number): string {
  return `${photo.src.original}?auto=compress&cs=tinysrgb&fit=crop&crop=entropy&w=${width}&h=${height}`;
}
