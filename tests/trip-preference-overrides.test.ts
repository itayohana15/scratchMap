import assert from "node:assert/strict";
import test from "node:test";

import type { InferredPreferenceEntry, PreferenceCategory } from "../src/lib/preference-learning";
import {
  buildProfileSummaryLines,
  derivePaceFromProfile,
  deriveInterestsFromProfile,
  hasActiveOverride,
} from "../src/lib/trip-preference-overrides";

const NO_INFERRED: Partial<Record<PreferenceCategory, InferredPreferenceEntry>> = {};

test("derivePaceFromProfile maps explicit pace levels to the trip form's 3-way pace", () => {
  assert.equal(derivePaceFromProfile({ pace: 1 }, NO_INFERRED), "relaxed");
  assert.equal(derivePaceFromProfile({ pace: 2 }, NO_INFERRED), "relaxed");
  assert.equal(derivePaceFromProfile({ pace: 3 }, NO_INFERRED), "balanced");
  assert.equal(derivePaceFromProfile({ pace: 4 }, NO_INFERRED), "fast");
  assert.equal(derivePaceFromProfile({ pace: 5 }, NO_INFERRED), "fast");
});

test("derivePaceFromProfile falls back to balanced when no explicit or confident inferred pace exists", () => {
  assert.equal(derivePaceFromProfile({}, NO_INFERRED), "balanced");
});

test("derivePaceFromProfile uses accepted-learned pace only when confidence is high enough", () => {
  const lowConfidence: Partial<Record<PreferenceCategory, InferredPreferenceEntry>> = {
    pace: { level: 5, confidence: 0.3, direction: "up", sampleSize: 2, updatedAt: "" },
  };
  assert.equal(derivePaceFromProfile({}, lowConfidence), "balanced");

  const highConfidence: Partial<Record<PreferenceCategory, InferredPreferenceEntry>> = {
    pace: { level: 5, confidence: 0.8, direction: "up", sampleSize: 8, updatedAt: "" },
  };
  assert.equal(derivePaceFromProfile({}, highConfidence), "fast");
});

test("derivePaceFromProfile prefers explicit over inferred", () => {
  const inferred: Partial<Record<PreferenceCategory, InferredPreferenceEntry>> = {
    pace: { level: 5, confidence: 0.9, direction: "up", sampleSize: 10, updatedAt: "" },
  };
  assert.equal(derivePaceFromProfile({ pace: 1 }, inferred), "relaxed");
});

test("deriveInterestsFromProfile lists only strong (>=4) categories, excluding pace", () => {
  const result = deriveInterestsFromProfile(
    { pace: 5, nature: 4, food: 2, museums: 5 },
    NO_INFERRED
  );
  assert.ok(result.includes("טבע"));
  assert.ok(result.includes("מוזיאונים"));
  assert.ok(!result.includes("אוכל"));
  assert.ok(!result.includes("קצב"));
});

test("deriveInterestsFromProfile returns an empty string when nothing is strongly rated", () => {
  assert.equal(deriveInterestsFromProfile({}, NO_INFERRED), "");
});

test("buildProfileSummaryLines puts pace first and sorts the rest by level", () => {
  const lines = buildProfileSummaryLines({ pace: 3, nature: 5, food: 4 }, NO_INFERRED);
  assert.equal(lines[0]?.category, "pace");
  assert.equal(lines[1]?.category, "nature");
  assert.equal(lines[2]?.category, "food");
});

test("hasActiveOverride ignores surrounding whitespace", () => {
  assert.equal(hasActiveOverride("  טבע, אוכל  ", "טבע, אוכל"), false);
  assert.equal(hasActiveOverride("טבע", "אוכל"), true);
});
