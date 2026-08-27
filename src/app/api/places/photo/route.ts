import { NextResponse } from "next/server";

import { pexelsCroppedUrl, searchPexelsPhoto, searchPexelsPhotos } from "@/lib/photos/pexels";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ photoUrl: null });
  }

  const countParam = Number(searchParams.get("count"));
  const count = Number.isFinite(countParam) && countParam > 1 ? countParam : 1;

  try {
    if (count > 1) {
      const photos = await searchPexelsPhotos(q, count);
      return NextResponse.json({
        photos: photos.map((photo) => ({
          url: pexelsCroppedUrl(photo, 800, 450),
          photographer: photo.photographer,
          photographerUrl: photo.photographer_url,
        })),
      });
    }

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
