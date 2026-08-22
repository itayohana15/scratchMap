import { GoogleGenAI } from "@google/genai";

import { ITINERARY_MODEL } from "@/lib/server/country-itinerary-generation";
import type { AiStoryContext } from "@/lib/trip-memories";

function buildStoryPrompt(context: AiStoryContext): string {
  return [
    "אתה כותב תקציר טיול קצר וקריא בעברית, המבוסס אך ורק על העובדות המובנות שסופקו למטה.",
    "כללים מחייבים:",
    "- אסור להזכיר מקום או חוויה שלא מופיעים בנתונים.",
    "- אסור לתאר פעילות שתוכננה אך דולגה (skipped) כאילו היא קרתה בפועל.",
    "- אם המידע מועט, כתבו סיפור קצר במקום להמציא פרטים.",
    "- אל תחשבו מחדש סטטיסטיקות (ימים, עלויות, מרחקים) — אלו כבר מוצגות למשתמש בנפרד.",
    "- כתבו 2-4 פסקאות קצרות, בגוף שני או ראשון רבים, בטון חם ואישי.",
    "",
    "נתוני הטיול (JSON):",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

export async function generateTripStory(context: AiStoryContext): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: ITINERARY_MODEL,
    contents: buildStoryPrompt(context),
  });

  const text = response.text;
  if (!text) {
    throw new Error("Empty trip story response from Gemini");
  }

  return text.trim();
}
