import { NextResponse } from "next/server";

import { searchPlaces } from "@/lib/places/nominatim";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const iso = searchParams.get("iso")?.trim();

  if (!q || q.length < 2) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await searchPlaces(q, { countryCode: iso ?? undefined, limit: 6 });
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json({ error: "החיפוש נכשל" }, { status: 502 });
  }
}
