// Spec "אני עומד להריץ טיול אמיתי של 44 יום" — dev-only, disk-only capture
// of every raw provider response during a real generation run, so the
// same run doesn't have to be paid for twice to build a replay-harness
// fixture set. NEVER active unless CAPTURE_FIXTURES=1 is set explicitly
// (never a production default), and a write failure here must never break
// real generation — every write is best-effort and silently swallowed.
//
// Cleanup pass — this used to write under `fixtures/`, the SAME directory
// canonical, hand-curated test fixtures would live in, which is exactly
// what turned a handful of real QA runs into 1600+ untracked files
// cluttering Source Control. Runtime captures now live under
// QA_ARTIFACTS_DIR_NAME (.gitignore'd, never committed) instead — a
// canonical fixture is only ever created by deliberately copying/promoting
// a specific capture INTO fixtures/ by hand, never by this module writing
// there directly.
//
// Session state is a module-level global, which is fine for THIS tool's
// actual use (a single-process CLI QA-harness run) and NOT safe for
// concurrent server requests — disclosed, not solved, since the real use
// case here is a one-shot local run, not production traffic.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Ignored (see .gitignore), never the same directory as committed test fixtures. */
export const QA_ARTIFACTS_DIR_NAME = ".qa-artifacts";

let activeSessionDir: string | null = null;
let activeSessionSlug: string | null = null;
let geminiCallIndex = 0;

export function isFixtureCaptureEnabled(): boolean {
  return process.env.CAPTURE_FIXTURES === "1";
}

/**
 * Same check, clearer name for new call sites (hygiene pass) — every
 * runtime file-writing path in this module already goes through this
 * (directly or via isFixtureCaptureEnabled, kept for the existing call
 * sites rather than a blanket rename). Never true by default; only an
 * explicit `CAPTURE_FIXTURES=1` QA run enables it.
 */
export const isQaCaptureEnabled = isFixtureCaptureEnabled;

function currentCommitHash(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 60) || "trip";
}

/**
 * Starts a capture session — creates
 * `.qa-artifacts/<tripSlug>-<timestamp>/meta.json` immediately. A no-op
 * when capture is disabled. Idempotent per `tripSlug` within a process: a
 * real trip run touches this from two separate call sites (the
 * recommendations route, fired once per category, and the generation
 * route) that don't share a request — keying both by the same `tripSlug`
 * (isoA2 is the natural shared key) lets a second/third call for an
 * already-active slug reuse the same folder instead of fragmenting into
 * one folder per category. Only a genuinely new tripSlug starts a fresh
 * folder. Not distributed-safe (module-level state) — fine for the actual
 * use case, a single-process local/dev run.
 */
export function startFixtureCaptureSession(tripSlug: string, meta: Record<string, unknown>): void {
  if (!isFixtureCaptureEnabled()) return;
  if (activeSessionDir && activeSessionSlug === tripSlug) return;
  geminiCallIndex = 0;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), QA_ARTIFACTS_DIR_NAME, `${safeSlug(tripSlug)}-${timestamp}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ ...meta, tripSlug, timestamp, commitHash: currentCommitHash() }, null, 2)
    );
    activeSessionDir = dir;
    activeSessionSlug = tripSlug;
  } catch {
    activeSessionDir = null;
    activeSessionSlug = null;
  }
}

export function hashFixtureKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

/** overpass/geocode: keyed by a hash of the query itself (deterministic — the same query always lands in the same file). */
export function captureProviderFixture(category: "overpass" | "geocode", queryKey: string, data: unknown): void {
  writeFixture(category, hashFixtureKey(queryKey), data);
}

/** gemini: keyed by call order within the session (request + raw response together, since a replay harness needs both). */
export function captureGeminiFixture(request: unknown, rawResponseText: string | null | undefined): void {
  if (!isFixtureCaptureEnabled()) return;
  const index = geminiCallIndex;
  geminiCallIndex += 1;
  writeFixture("gemini", String(index), { request, rawResponseText: rawResponseText ?? null });
}

function writeFixture(category: "overpass" | "geocode" | "gemini", key: string, data: unknown): void {
  if (!isFixtureCaptureEnabled() || !activeSessionDir) return;
  try {
    const dir = path.join(activeSessionDir, category);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(data, null, 2));
  } catch {
    // Fixture capture is best-effort dev tooling — never allowed to break a real generation run.
  }
}

export interface GeoResolutionFixtureEntry {
  geoSource: string;
  dayIndex: number;
  itemName: string;
  stayId: string | null;
}

/**
 * Spec "סוגר את הפער בלי לגעת בסכימה" — the one place the FULL 4-value
 * geoSource taxonomy (provider/recommendationId/fuzzyName/unresolved)
 * still exists once generation finishes and nothing keeps it, since it's
 * never persisted onto the saved trip. Written flat (one file, not a
 * per-query subfolder like overpass/geocode/gemini) directly under the
 * session dir. Keyed by the same join-key formula the render-time overlay
 * uses on the other side of the save boundary (see
 * geoResolutionJoinKey's docstring in itinerary-day-view-helpers.ts for
 * why it can't just be the generation-time item's own identity).
 */
export function captureGeoResolutionFixture(map: Record<string, GeoResolutionFixtureEntry>): void {
  if (!isFixtureCaptureEnabled() || !activeSessionDir || Object.keys(map).length === 0) return;
  try {
    writeFileSync(path.join(activeSessionDir, "geo-resolution.json"), JSON.stringify(map, null, 2));
  } catch {
    // Fixture capture is best-effort dev tooling — never allowed to break a real generation run.
  }
}

/**
 * Process-lifetime Overpass call/failure counts (getOverpassCallStats in
 * places/overpass.ts), written once per session next to geo-resolution.json
 * — so a captured session's replay data is never mistaken for a real
 * production run when every one of its Overpass calls actually failed.
 */
export function captureOverpassStatsFixture(stats: { totalCalls: number; failedCalls: number }): void {
  if (!isFixtureCaptureEnabled() || !activeSessionDir) return;
  try {
    writeFileSync(path.join(activeSessionDir, "overpass-stats.json"), JSON.stringify(stats, null, 2));
  } catch {
    // Fixture capture is best-effort dev tooling — never allowed to break a real generation run.
  }
}
