import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import {
  isFixtureCaptureEnabled,
  isQaCaptureEnabled,
  startFixtureCaptureSession,
  captureProviderFixture,
  captureGeminiFixture,
  captureGeoResolutionFixture,
  captureOverpassStatsFixture,
  QA_ARTIFACTS_DIR_NAME,
} from "../src/lib/server/fixture-capture";

// Cleanup pass — runtime captures now live under the ignored
// QA_ARTIFACTS_DIR_NAME, never under fixtures/ (the canonical,
// git-tracked home for hand-promoted regression fixtures only).
const FIXTURES_DIR = path.join(process.cwd(), QA_ARTIFACTS_DIR_NAME);

function listFixtureDirs(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function withCaptureFixturesEnv(value: string | undefined, fn: () => void) {
  const original = process.env.CAPTURE_FIXTURES;
  if (value === undefined) delete process.env.CAPTURE_FIXTURES;
  else process.env.CAPTURE_FIXTURES = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.CAPTURE_FIXTURES;
    else process.env.CAPTURE_FIXTURES = original;
  }
}

test("isFixtureCaptureEnabled/isQaCaptureEnabled are false by default (no env var set)", () => {
  withCaptureFixturesEnv(undefined, () => {
    assert.equal(isFixtureCaptureEnabled(), false);
    assert.equal(isQaCaptureEnabled(), false);
  });
});

test("isFixtureCaptureEnabled/isQaCaptureEnabled are true only when CAPTURE_FIXTURES=1 exactly", () => {
  withCaptureFixturesEnv("1", () => {
    assert.equal(isFixtureCaptureEnabled(), true);
    assert.equal(isQaCaptureEnabled(), true);
  });
  withCaptureFixturesEnv("true", () => {
    assert.equal(isFixtureCaptureEnabled(), false, "only the literal string \"1\" enables capture, never a truthy-looking alternative");
  });
});

// GOAL A, acceptance criterion 1 — ordinary usage (capture disabled) must
// never create a single file on disk, regardless of how many capture call
// sites fire during a real generation run.
test("QA file writing disabled by default: no fixture directory is created when CAPTURE_FIXTURES is unset", () => {
  withCaptureFixturesEnv(undefined, () => {
    const before = listFixtureDirs();
    const testSlug = `hygiene-test-disabled-${Date.now()}`;

    startFixtureCaptureSession(testSlug, { isoA2: testSlug });
    captureProviderFixture("overpass", "some query", { query: "some query", response: {} });
    captureProviderFixture("geocode", "some place", { query: "some place", response: {} });
    captureGeminiFixture({ model: "test", prompt: "test" }, "raw response");
    captureGeoResolutionFixture({ "id:1": { geoSource: "provider", dayIndex: 0, itemName: "Test", stayId: null } });
    captureOverpassStatsFixture({ totalCalls: 1, failedCalls: 0 });

    const after = listFixtureDirs();
    assert.deepEqual(after, before, "no new fixture directory may appear when capture is disabled");
    assert.equal(after.some((name) => name.includes(testSlug)), false);
  });
});

// GOAL A, acceptance criterion 2 — an explicit CAPTURE_FIXTURES=1 QA run
// must still write real, inspectable files, byte-for-byte matching what
// was captured.
test("QA file writing enabled with explicit flag: CAPTURE_FIXTURES=1 writes a real, inspectable session", () => {
  const testSlug = `hygiene-test-enabled-${Date.now()}`;
  let createdDir: string | null = null;

  try {
    withCaptureFixturesEnv("1", () => {
      const before = new Set(listFixtureDirs());

      startFixtureCaptureSession(testSlug, { isoA2: testSlug, note: "hygiene pass test session" });
      captureProviderFixture("overpass", "query-a", { query: "query-a", response: { elements: [] } });
      captureGeminiFixture({ model: "test-model", prompt: "test prompt" }, "raw-gemini-text");
      captureGeoResolutionFixture({ "id:test-place": { geoSource: "provider", dayIndex: 0, itemName: "Test Place", stayId: null } });
      captureOverpassStatsFixture({ totalCalls: 5, failedCalls: 1 });

      const after = listFixtureDirs();
      const newDirs = after.filter((name) => !before.has(name));
      assert.equal(newDirs.length, 1, `expected exactly one new session directory, found: ${newDirs.join(", ")}`);
      createdDir = newDirs[0];

      const sessionPath = path.join(FIXTURES_DIR, createdDir);
      const meta = JSON.parse(readFileSync(path.join(sessionPath, "meta.json"), "utf8"));
      assert.equal(meta.isoA2, testSlug);

      const overpassFiles = readdirSync(path.join(sessionPath, "overpass"));
      assert.equal(overpassFiles.length, 1, "expected exactly one captured overpass query fixture");
      const overpassContent = JSON.parse(readFileSync(path.join(sessionPath, "overpass", overpassFiles[0]), "utf8"));
      assert.equal(overpassContent.query, "query-a");

      const geminiContent = JSON.parse(readFileSync(path.join(sessionPath, "gemini", "0.json"), "utf8"));
      assert.equal(geminiContent.rawResponseText, "raw-gemini-text");

      const geoResolution = JSON.parse(readFileSync(path.join(sessionPath, "geo-resolution.json"), "utf8"));
      assert.equal(geoResolution["id:test-place"].itemName, "Test Place");

      const overpassStats = JSON.parse(readFileSync(path.join(sessionPath, "overpass-stats.json"), "utf8"));
      assert.equal(overpassStats.totalCalls, 5);
    });
  } finally {
    // Never leaves this test-only session behind — real historical
    // fixtures (anything not created by this test) are untouched.
    if (createdDir) {
      rmSync(path.join(FIXTURES_DIR, createdDir), { recursive: true, force: true });
    }
  }
});
