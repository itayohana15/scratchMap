"use client";

import type { AiItineraryRequest, AiItineraryResponse } from "@/lib/trip-workspace";

async function fetchCountryAiItinerary(payload: AiItineraryRequest): Promise<AiItineraryResponse> {
  const response = await fetch("/api/ai/country-itinerary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to create itinerary");
  }

  return (await response.json()) as AiItineraryResponse;
}

export async function generateCountryAiItinerary(payload: AiItineraryRequest) {
  return fetchCountryAiItinerary(payload);
}
