import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyActivity,
  buildPreferenceFamilyWeights,
  ACTIVITY_FAMILIES,
  type ActivityClassificationInput,
} from "../src/lib/server/activity-taxonomy";

function item(overrides: Partial<ActivityClassificationInput> = {}): ActivityClassificationInput {
  return {
    category: "attraction",
    name: "Sample Place",
    shortDescription: "",
    ...overrides,
  };
}

// E. art museum -> CULTURE/art_museum
test("Round 9 E: an art museum classifies as CULTURE/art_museum", () => {
  const result = classifyActivity(item({ category: "museum", name: "City Art Museum", shortDescription: "A large art museum and gallery" }));
  assert.equal(result.primaryFamily, "CULTURE");
  assert.equal(result.subtype, "art_museum");
  assert.equal(result.confidence, "keyword");
});

// F. history museum -> CULTURE/history_museum
test("Round 9 F: a history museum classifies as CULTURE/history_museum", () => {
  const result = classifyActivity(item({ category: "museum", name: "National History Museum", shortDescription: "" }));
  assert.equal(result.primaryFamily, "CULTURE");
  assert.equal(result.subtype, "history_museum");
});

// G. theme park -> ENTERTAINMENT/theme_park
test("Round 9 G: a theme park classifies as ENTERTAINMENT/theme_park", () => {
  const result = classifyActivity(item({ category: "family", name: "Universal Studios Theme Park", shortDescription: "" }));
  assert.equal(result.primaryFamily, "ENTERTAINMENT");
  assert.equal(result.subtype, "theme_park");
});

// H. zoo -> ENTERTAINMENT/zoo
test("Round 9 H: a zoo classifies as ENTERTAINMENT/zoo", () => {
  const result = classifyActivity(item({ category: "family", name: "City Zoo", shortDescription: "Home to over 200 species" }));
  assert.equal(result.primaryFamily, "ENTERTAINMENT");
  assert.equal(result.subtype, "zoo");
});

// I. beach -> NATURE/beach
test("Round 9 I: a beach classifies as NATURE/beach", () => {
  const result = classifyActivity(item({ category: "nature", name: "Sunset Beach", shortDescription: "A popular sandy beach" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.subtype, "beach");
  assert.equal(result.metadata.indoorOutdoor, "outdoor");
});

// J. hiking trail -> NATURE/hiking
test("Round 9 J: a hiking trail classifies as NATURE/hiking", () => {
  const result = classifyActivity(item({ category: "nature", name: "Ridge Hiking Trail", shortDescription: "A scenic hiking trail" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.subtype, "hiking");
});

// K. market -> LOCAL_EXPERIENCE primary + SHOPPING/FOOD secondary
test("Round 9 K: a market carries LOCAL_EXPERIENCE primary with SHOPPING + FOOD secondary families", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Riverside Market", shortDescription: "A bustling local market" }));
  assert.equal(result.primaryFamily, "LOCAL_EXPERIENCE");
  assert.equal(result.subtype, "market");
  assert.deepEqual(new Set(result.secondaryFamilies), new Set(["SHOPPING", "FOOD"]));
});

test("Round 9 K2: a food market carries the more specific food_market subtype (SHOPPING + FOOD secondary)", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Downtown Food Market", shortDescription: "A covered food market" }));
  assert.equal(result.subtype, "food_market");
  assert.equal(result.primaryFamily, "LOCAL_EXPERIENCE");
  assert.deepEqual(new Set(result.secondaryFamilies), new Set(["SHOPPING", "FOOD"]));
});

// L. unknown provider tags remain explicitly unknown/OTHER, never fabricated
test("Round 9 L: an unclassifiable candidate stays OTHER/generic, never invented", () => {
  const result = classifyActivity(item({ category: "practical", name: "Luggage Storage", shortDescription: "" }));
  assert.equal(result.primaryFamily, "OTHER");
  assert.equal(result.subtype, "generic");
  assert.equal(result.confidence, "category_fallback");
});

test("Round 9 L2: metadata fields the input doesn't support stay null, never fabricated", () => {
  const result = classifyActivity(item({ category: "attraction", name: "Mystery Spot", shortDescription: "" }));
  assert.equal(result.metadata.paidFree, null, "no approximatePrice supplied -> unknown, not guessed");
  assert.equal(result.metadata.bookingSensitive, null, "no reservationRequired supplied -> unknown, not guessed");
  assert.equal(result.metadata.suitableTimeOfDay, null, "no recommendedTimeOfDay supplied -> unknown, not guessed");
});

test("Round 9: a candidate with a category baseline but no matching keyword keeps the baseline at category_fallback confidence", () => {
  const result = classifyActivity(item({ category: "nature", name: "Green Space", shortDescription: "A pleasant green space" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.confidence, "category_fallback");
});

test("Round 9: known price/reservation signals populate metadata, never fabricated beyond what's given", () => {
  const free = classifyActivity(item({ approximatePrice: 0 }));
  assert.equal(free.metadata.paidFree, "free");
  const paid = classifyActivity(item({ approximatePrice: 45 }));
  assert.equal(paid.metadata.paidFree, "paid");
  const bookingKnownFalse = classifyActivity(item({ reservationRequired: false }));
  assert.equal(bookingKnownFalse.metadata.bookingSensitive, false, "an explicit false is a KNOWN fact, not unknown");
  const bookingKnownTrue = classifyActivity(item({ reservationRequired: true }));
  assert.equal(bookingKnownTrue.metadata.bookingSensitive, true);
});

test("Round 9: nightlife category and nightlife-subtype candidates are eveningNightlifeSuitable", () => {
  const byCategory = classifyActivity(item({ category: "nightlife", name: "The Alley Bar", shortDescription: "" }));
  assert.equal(byCategory.metadata.eveningNightlifeSuitable, true);
  const byKeyword = classifyActivity(item({ category: "attraction", name: "Late Night Comedy Club", shortDescription: "" }));
  assert.equal(byKeyword.metadata.eveningNightlifeSuitable, true);
});

test("Round 9: single-word keyword matching respects word boundaries (a real bug found writing this suite: 'river' must not match inside 'Riverside')", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Riverside Boutique", shortDescription: "A small boutique shop" }));
  assert.notEqual(result.subtype, "river", "'Riverside' must not be misclassified as a NATURE river just because it contains the substring 'river'");
});

test("Round 9: classification is stable — the same input always returns the same classification", () => {
  const input = item({ category: "museum", name: "Downtown Art Museum", shortDescription: "Modern and contemporary art" });
  const first = classifyActivity(input);
  const second = classifyActivity(input);
  assert.deepEqual(first, second);
});

test("Round 9: buildPreferenceFamilyWeights boosts matching families without zeroing any other family", () => {
  const weights = buildPreferenceFamilyWeights(["I love art and museums"]);
  assert.ok(weights.CULTURE > 1, "art/museum preference boosts CULTURE");
  for (const family of ACTIVITY_FAMILIES) {
    assert.ok(weights[family] >= 1, `${family} is never eliminated by a preference — spec §9`);
  }
});

test("Round 9: buildPreferenceFamilyWeights with no preference text leaves every family neutral", () => {
  const weights = buildPreferenceFamilyWeights([]);
  for (const family of ACTIVITY_FAMILIES) {
    assert.equal(weights[family], 1);
  }
});
