import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import type { CountryAiRecommendation } from "@/lib/ai/country-recommendations";

const MODEL = "gemini-flash-lite-latest";

const RECOMMENDATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "A two-sentence overview of the country for a traveler." },
    highlights: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "4-6 must-see cities, regions, or experiences.",
    },
    food: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3-5 dishes or food experiences to try.",
    },
    bestTimeToVisit: { type: Type.STRING, description: "One or two sentences on the best time of year to visit." },
    tips: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3-5 practical traveler tips (transport, customs, budgeting, safety, etc).",
    },
  },
  required: ["summary", "highlights", "food", "bestTimeToVisit", "tips"],
};

async function generateRecommendation(countryName: string): Promise<CountryAiRecommendation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are a knowledgeable, concise travel guide. Give travel recommendations for ${countryName}, written for a Hebrew-speaking traveler. Write every string value in Hebrew.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: RECOMMENDATION_SCHEMA,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Empty response from Gemini");
  return JSON.parse(raw) as CountryAiRecommendation;
}

export async function POST(request: Request) {
  let body: { isoA2?: string; countryName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { countryName } = body;
  const isoA2 = body.isoA2?.toUpperCase();
  if (!isoA2 || !countryName) {
    return NextResponse.json({ error: "isoA2 and countryName are required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: cached, error: cacheError } = await supabase
    .from("ai_recommendations")
    .select("*")
    .eq("iso_a2", isoA2)
    .maybeSingle();
  if (cacheError) {
    return NextResponse.json({ error: cacheError.message }, { status: 500 });
  }
  if (cached) {
    return NextResponse.json({ content: cached.content, cached: true });
  }

  let content: CountryAiRecommendation;
  try {
    content = await generateRecommendation(countryName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate recommendation";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { error: insertError } = await supabase
    .from("ai_recommendations")
    .insert({ iso_a2: isoA2, content, model: MODEL });
  if (insertError) {
    // The generated content is still good even if caching it failed — return
    // it to the user, just without persisting for next time.
    return NextResponse.json({ content, cached: false, cacheWriteFailed: true });
  }

  return NextResponse.json({ content, cached: false });
}
