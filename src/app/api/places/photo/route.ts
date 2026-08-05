import { NextResponse } from "next/server";

import { pexelsCroppedUrl, searchPexelsPhoto } from "@/lib/photos/pexels";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ photoUrl: null });
  }

  try {
    const photo = await searchPexelsPhoto(q);
    return NextResponse.json({
      photoUrl: photo ? pexelsCroppedUrl(photo, 400, 260) : null,
      photographer: photo?.photographer ?? null,
      photographerUrl: photo?.photographer_url ?? null,
    });
  } catch {
    return NextResponse.json({ error: "Failed to reach Pexels" }, { status: 502 });
  }
}
