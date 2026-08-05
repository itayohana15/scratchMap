import { GoogleGenAI } from "@google/genai";
import isoCountries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";
import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";

import { pexelsCroppedUrl, searchPexelsPhoto, type PexelsPhoto } from "@/lib/photos/pexels";

isoCountries.registerLocale(enLocale);

// Ask Gemini (free tier) to name the single most famous place in a country
// (a specific landmark, monument, or natural site — not a generic category)
// so the banner photo search below can target something instantly
// recognizable instead of a generic query. Cached for 30 days per country
// since the answer is effectively static.
const getIconicSubject = unstable_cache(
  async (englishName: string): Promise<string | null> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    try {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model: "gemini-flash-lite-latest",
        contents: `What is the single most famous place in ${englishName} — the specific landmark, monument, or natural site most visited by tourists and most associated with this country? Reply with ONLY its common English name (2-5 words) — no punctuation, no explanation, no extra text.`,
      });
      const text = response.text?.trim();
      return text && text.length > 0 && text.length < 60 ? text : null;
    } catch {
      return null;
    }
  },
  ["country-iconic-subject-famous-place"],
  { revalidate: 60 * 60 * 24 * 30 }
);

export async function GET(_request: Request, { params }: { params: Promise<{ iso: string }> }) {
  const { iso } = await params;
  const isoA2 = iso.toUpperCase();

  const englishName = isoCountries.getName(isoA2, "en");
  if (!englishName) {
    return NextResponse.json({ error: `Unknown country code: ${isoA2}` }, { status: 400 });
  }

  let photo: PexelsPhoto | undefined;
  try {
    const iconicSubject = await getIconicSubject(englishName);

    photo = iconicSubject
      ? ((await searchPexelsPhoto(iconicSubject)) ?? (await searchPexelsPhoto(`${iconicSubject} ${englishName}`)))
      : undefined;

    // Fall back to generic queries if Gemini was unavailable/unhelpful, or
    // its suggested subject didn't turn up a usable photo on Pexels.
    photo ??=
      (await searchPexelsPhoto(`${englishName} nature landscape`)) ??
      (await searchPexelsPhoto(`${englishName} landmark`));
  } catch {
    return NextResponse.json({ error: "Failed to reach Pexels" }, { status: 502 });
  }

  return NextResponse.json({
    photoUrl: photo ? pexelsCroppedUrl(photo, 1600, 550) : null,
    photographer: photo?.photographer ?? null,
    photographerUrl: photo?.photographer_url ?? null,
  });
}
