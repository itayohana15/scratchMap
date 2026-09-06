import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { QA_ARTIFACTS_DIR_NAME } from "@/lib/server/fixture-capture";

/**
 * Spec "מכני, לא קריאה ידנית" — serves the geo-resolution.json a real
 * generation run wrote to disk under CAPTURE_FIXTURES=1
 * (fixture-capture.ts's captureGeoResolutionFixture), so the render-time
 * debug overlay (day screen / PDF export) can show the FULL 4-value
 * geoSource taxonomy instead of its own degraded provider/unresolved
 * guess. Never a production default — the debug overlay itself is opt-in
 * via ?debugGeo=1, and this route additionally refuses to serve anything
 * outside development, since it's reading arbitrary local files off disk.
 *
 * "The current trip" has no persisted link to a specific fixture session
 * (by design — no schema change), so this serves the MOST RECENT capture
 * for the trip's own isoA2 as the closest honest approximation. A trip
 * regenerated more than once for the same country could show geoSource
 * data from a later run than the one that actually produced this trip —
 * a known, disclosed limitation of not touching the schema, not a bug.
 *
 * Returns `null` (not `{}`) when no capture file exists at all — the
 * overlay must tell "no file" apart from "a file exists but has nothing
 * for this specific item" (the latter renders as geoSource: "unmatched",
 * a real finding; the former means nothing to report at all). Never
 * collapse these into the same response shape.
 */
export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const iso = searchParams.get("iso")?.trim().toUpperCase();
  if (!iso) {
    return NextResponse.json({ error: "MISSING_ISO" }, { status: 400 });
  }

  const fixturesDir = path.join(process.cwd(), QA_ARTIFACTS_DIR_NAME);
  let sessionDirs: string[] = [];
  try {
    sessionDirs = readdirSync(fixturesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${iso}-`))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return NextResponse.json(null);
  }

  for (const dirName of sessionDirs) {
    try {
      const raw = readFileSync(path.join(fixturesDir, dirName, "geo-resolution.json"), "utf8");
      return NextResponse.json(JSON.parse(raw));
    } catch {
      // This session never wrote a geo-resolution.json (e.g. no real
      // place items existed to capture) — fall back to an older session.
      continue;
    }
  }

  return NextResponse.json(null);
}
