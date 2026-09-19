import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMealVenue,
  buildCuisinePreferenceWeights,
  CUISINE_FAMILIES,
  type MealVenueClassificationInput,
} from "../src/lib/server/meal-cuisine-taxonomy";

function venue(overrides: Partial<MealVenueClassificationInput> = {}): MealVenueClassificationInput {
  return {
    category: "restaurant",
    name: overrides.name ?? "Sample Place",
    shortDescription: overrides.shortDescription ?? "",
    openingHours: overrides.openingHours ?? null,
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? null,
    approximatePrice: overrides.approximatePrice ?? null,
    reservationRequired: overrides.reservationRequired ?? null,
    ...overrides,
  };
}

/* -------------------- baseline category evidence -------------------- */

test("classifyMealVenue: a generic restaurant is suitable for lunch and dinner by category baseline", () => {
  const result = classifyMealVenue(venue({ category: "restaurant" }));
  assert.ok(result.suitableMealTypes.includes("LUNCH"));
  assert.ok(result.suitableMealTypes.includes("DINNER"));
  assert.equal(result.venueType, "restaurant");
});

// I. breakfast-focused cafe -> not automatically valid LUNCH
test("classifyMealVenue I: a generic cafe is breakfast/brunch/coffee by default, never lunch", () => {
  const result = classifyMealVenue(venue({ category: "cafe" }));
  assert.ok(result.suitableMealTypes.includes("BREAKFAST"));
  assert.ok(result.suitableMealTypes.includes("BRUNCH"));
  assert.ok(result.suitableMealTypes.includes("COFFEE_SNACK"));
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false, "a plain cafe must not be fabricated into a lunch venue");
});

test("classifyMealVenue I: an explicitly breakfast-focused cafe stays breakfast/brunch only, never lunch or dinner", () => {
  const result = classifyMealVenue(venue({ category: "cafe", shortDescription: "cozy spot for breakfast, pancakes and eggs benedict" }));
  assert.ok(result.suitableMealTypes.includes("BREAKFAST"));
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false);
  assert.equal(result.suitableMealTypes.includes("DINNER"), false);
});

// J. cafe with structured lunch evidence -> may be selected for LUNCH
test("classifyMealVenue J: a cafe with explicit lunch-service evidence becomes lunch-eligible", () => {
  const result = classifyMealVenue(venue({ category: "cafe", shortDescription: "cafe serving sandwiches and a full lunch menu" }));
  assert.ok(result.suitableMealTypes.includes("LUNCH"), "explicit lunch-menu/sandwiches evidence must make this cafe lunch-eligible");
});

// K. dinner-only restaurant -> not selected for lunch
test("classifyMealVenue K: a fine-dining/tasting-menu restaurant is dinner-only, not a generic lunch stop", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", shortDescription: "fine dining tasting menu experience" }));
  assert.ok(result.suitableMealTypes.includes("DINNER"));
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false);
  assert.equal(result.suitableMealTypes.includes("BREAKFAST"), false);
});

// L. brunch venue -> breakfast/brunch, lunch only if evidence supports it
test("classifyMealVenue L: a brunch venue is breakfast+brunch suitable, lunch only with additional evidence", () => {
  const plainBrunch = classifyMealVenue(venue({ category: "restaurant", shortDescription: "popular brunch spot" }));
  assert.ok(plainBrunch.suitableMealTypes.includes("BREAKFAST"));
  assert.ok(plainBrunch.suitableMealTypes.includes("BRUNCH"));

  const allDayBrunch = classifyMealVenue(venue({ category: "restaurant", shortDescription: "all-day brunch and lunch spot" }));
  assert.ok(allDayBrunch.suitableMealTypes.includes("LUNCH"), "explicit all-day-brunch/lunch evidence must add LUNCH");
});

// M. cocktail/nightlife bar -> not selected as breakfast/lunch
test("classifyMealVenue M: a bar used for food/drink is dinner/late-night only, never breakfast or lunch", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", name: "Corner Cocktail Bar", shortDescription: "gastropub and cocktail bar serving food" }));
  assert.ok(result.suitableMealTypes.includes("DINNER"));
  assert.ok(result.suitableMealTypes.includes("LATE_NIGHT"));
  assert.equal(result.suitableMealTypes.includes("BREAKFAST"), false);
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false);
  assert.equal(result.venueType, "bar");
});

// N. unknown meal suitability -> not fabricated into a perfect match
test("classifyMealVenue N: a venue with a raw category the taxonomy has no meal baseline for gets no fabricated suitability", () => {
  const result = classifyMealVenue(venue({ category: "attraction", shortDescription: "just a landmark, no food evidence at all" }));
  assert.deepEqual(result.suitableMealTypes, [], "no category baseline and no keyword evidence must leave suitableMealTypes empty, never guessed");
});

/* -------------------- bakery / role-adjacent evidence -------------------- */

test("classifyMealVenue: a bakery is breakfast/coffee/dessert suitable, never lunch or dinner", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", name: "City Bakery", shortDescription: "neighborhood bakery and patisserie" }));
  assert.equal(result.venueType, "bakery");
  assert.ok(result.suitableMealTypes.includes("BREAKFAST"));
  assert.ok(result.suitableMealTypes.includes("DESSERT"));
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false);
  assert.equal(result.suitableMealTypes.includes("DINNER"), false);
});

/* -------------------- opening-hours evidence -------------------- */

test("classifyMealVenue: opening-hours evidence removes dinner suitability for an early-closing venue", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", openingHours: "08:00-14:30" }));
  assert.equal(result.suitableMealTypes.includes("DINNER"), false, "a venue closing at 14:30 cannot genuinely serve dinner");
  assert.ok(result.suitableMealTypes.includes("LUNCH"));
});

test("classifyMealVenue: opening-hours evidence removes breakfast/lunch suitability for a late-opening venue", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", openingHours: "17:00-23:00" }));
  assert.equal(result.suitableMealTypes.includes("BREAKFAST"), false);
  assert.equal(result.suitableMealTypes.includes("LUNCH"), false);
  assert.ok(result.suitableMealTypes.includes("DINNER"));
});

test("classifyMealVenue: an unparseable opening-hours string leaves category-baseline suitability untouched", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", openingHours: "call for hours" }));
  assert.ok(result.suitableMealTypes.includes("LUNCH"));
  assert.ok(result.suitableMealTypes.includes("DINNER"));
});

/* -------------------- cuisine: multi-label -------------------- */

test("classifyMealVenue: cuisine is multi-label — a sushi restaurant gets both the subtype and its family", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", name: "Sakura Sushi & Ramen" }));
  assert.ok(result.cuisineSubtypes.includes("sushi"));
  assert.ok(result.cuisineSubtypes.includes("ramen"));
  assert.deepEqual(result.cuisineFamilies, ["EAST_ASIAN"]);
});

test("classifyMealVenue: a venue matching no cuisine keyword gets empty cuisine arrays, never guessed", () => {
  const result = classifyMealVenue(venue({ category: "restaurant", name: "The Corner Spot", shortDescription: "a nice place to eat" }));
  assert.deepEqual(result.cuisineFamilies, []);
  assert.deepEqual(result.cuisineSubtypes, []);
});

/* -------------------- price level -------------------- */

test("classifyMealVenue: priceLevel is null when approximatePrice is unknown, never fabricated", () => {
  const result = classifyMealVenue(venue({ approximatePrice: null }));
  assert.equal(result.priceLevel, null);
});

test("classifyMealVenue: priceLevel buckets a known approximatePrice", () => {
  assert.equal(classifyMealVenue(venue({ approximatePrice: 15 })).priceLevel, "budget");
  assert.equal(classifyMealVenue(venue({ approximatePrice: 50 })).priceLevel, "moderate");
  assert.equal(classifyMealVenue(venue({ approximatePrice: 150 })).priceLevel, "premium");
});

/* -------------------- cuisine preference weights -------------------- */

test("buildCuisinePreferenceWeights: neutral (all 1) when no preference text matches anything", () => {
  const weights = buildCuisinePreferenceWeights(["I like museums and parks"]);
  for (const family of CUISINE_FAMILIES) assert.equal(weights[family], 1);
});

test("buildCuisinePreferenceWeights: boosts a matched cuisine family without eliminating any other", () => {
  const weights = buildCuisinePreferenceWeights(["I love japanese food and sushi"]);
  assert.ok(weights.EAST_ASIAN > 1);
  for (const family of CUISINE_FAMILIES) assert.ok(weights[family] >= 1, `${family} must never drop below the neutral weight`);
});

test("buildCuisinePreferenceWeights: empty preference text stays fully neutral", () => {
  const weights = buildCuisinePreferenceWeights([""]);
  for (const family of CUISINE_FAMILIES) assert.equal(weights[family], 1);
});
