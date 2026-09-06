import assert from "node:assert/strict";
import test from "node:test";

import { buildFoodItemFromPlace, buildMealOpportunityItem, insertFoodItemIntoDay, removeFoodItemFromDay } from "../src/lib/food-ui-helpers";
import { isMealOpportunityMarker } from "../src/lib/trip-workspace";
import type { RankedFoodPlace } from "../src/lib/food";
import { createEmptyDay, createEmptyItineraryItem, type TripItineraryDay, type TripItineraryItem } from "../src/lib/trip-workspace";

function buildPlace(overrides: Partial<RankedFoodPlace> = {}): RankedFoodPlace {
  return {
    name: overrides.name ?? "Sample Restaurant",
    category: overrides.category ?? "restaurant",
    lat: overrides.lat ?? 35.6895,
    lon: overrides.lon ?? 139.6917,
    openingHours: overrides.openingHours ?? null,
    priceConfidence: "unavailable",
    ratingConfidence: "unavailable",
    travelMinutesFromRoute: overrides.travelMinutesFromRoute ?? 8,
    recommendedSlot: overrides.recommendedSlot ?? "lunch",
  };
}

function day(overrides: Partial<TripItineraryDay> = {}): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides };
}

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

test("buildFoodItemFromPlace never fabricates price/rating and carries real coordinates", () => {
  const place = buildPlace();
  const built = buildFoodItemFromPlace(place, "lunch");
  assert.equal(built.name, "Sample Restaurant");
  assert.equal(built.lat, place.lat);
  assert.equal(built.lon, place.lon);
  assert.equal(built.approximatePrice, null);
});

test("insertFoodItemIntoDay inserts the selected restaurant into the correct meal slot", () => {
  const testDay = day({ items: [item({ id: "morning-1", name: "Morning Walk", slot: "morning", plannedStartTime: "09:00" })] });
  const { day: updated } = insertFoodItemIntoDay(testDay, buildPlace({ name: "New Lunch Spot" }), "lunch");

  assert.ok(updated.items.some((entry) => entry.name === "New Lunch Spot" && entry.slot === "lunch"));
  assert.ok(updated.items.some((entry) => entry.id === "morning-1"), "unrelated items must remain untouched");
});

test("insertFoodItemIntoDay replaces a previous (non-locked) selection in the same slot rather than duplicating the meal", () => {
  const testDay = day({ items: [item({ id: "old-lunch", name: "Old Lunch Pick", slot: "lunch", plannedStartTime: "12:30" })] });
  const { day: updated } = insertFoodItemIntoDay(testDay, buildPlace({ name: "New Lunch Spot" }), "lunch");

  assert.equal(updated.items.filter((entry) => entry.slot === "lunch").length, 1);
  assert.ok(updated.items.some((entry) => entry.name === "New Lunch Spot"));
});

test("insertFoodItemIntoDay never overwrites a locked/fixed-time item in the same slot", () => {
  const lockedLunch = item({ id: "locked-lunch", name: "Locked Reservation", slot: "lunch", plannedStartTime: "12:30", locked: true });
  const testDay = day({ items: [lockedLunch] });
  const { day: updated } = insertFoodItemIntoDay(testDay, buildPlace({ name: "New Lunch Spot" }), "lunch");

  assert.ok(updated.items.some((entry) => entry.id === "locked-lunch"), "a locked meal must survive");
});

test("insertFoodItemIntoDay recalculates travel from the previous real neighbor", () => {
  const previous = item({ id: "prev", name: "Museum", slot: "morning", plannedStartTime: "09:00", endTime: "11:00", lat: 35.68, lon: 139.76 });
  const testDay = day({ items: [previous] });
  const place = buildPlace({ lat: 35.681, lon: 139.761, travelMinutesFromRoute: 999 });

  const { day: updated } = insertFoodItemIntoDay(testDay, place, "lunch");
  const inserted = updated.items.find((entry) => entry.name === place.name);
  assert.ok(inserted && inserted.travelMinutes != null && inserted.travelMinutes < 999, "travel must be recalculated from the real previous neighbor, not the route-level estimate");
});

test("insertFoodItemIntoDay detects a real timeline conflict rather than silently resolving it", () => {
  // A "morning" activity that runs long past lunch's own default start time.
  const previous = item({ id: "prev", name: "Long Tour", slot: "morning", plannedStartTime: "09:00", endTime: "14:00" });
  const testDay = day({ items: [previous] });

  const { timelineConflict } = insertFoodItemIntoDay(testDay, buildPlace(), "lunch");
  assert.equal(timelineConflict, true);
});

test("insertFoodItemIntoDay reports no conflict when the slot genuinely has room", () => {
  const previous = item({ id: "prev", name: "Morning Walk", slot: "morning", plannedStartTime: "09:00", endTime: "10:30" });
  const testDay = day({ items: [previous] });

  const { timelineConflict } = insertFoodItemIntoDay(testDay, buildPlace(), "lunch");
  assert.equal(timelineConflict, false);
});

// Part S: removing a real selection restores the meal opportunity, never just an empty gap.
test("removeFoodItemFromDay removes the real restaurant, leaves unrelated items untouched, and restores the meal opportunity", () => {
  const testDay = day({
    cityRegion: "City A",
    items: [
      item({ id: "keep-me", name: "Keep Me", slot: "morning" }),
      item({ id: "remove-me", name: "Remove Me", slot: "lunch", recommendationId: "osm:restaurant:1:1", lat: 1, lon: 1 }),
    ],
  });
  const updated = removeFoodItemFromDay(testDay, "remove-me");

  assert.ok(updated.items.some((entry) => entry.id === "keep-me"), "unrelated items must remain untouched");
  assert.ok(!updated.items.some((entry) => entry.id === "remove-me"), "the real restaurant itself must be gone");
  const restored = updated.items.find((entry) => entry.slot === "lunch");
  assert.ok(restored, "the lunch slot must not simply stay empty");
  assert.ok(isMealOpportunityMarker(restored!), "the restored lunch item must be a meal opportunity, not a real place");
});

test("buildMealOpportunityItem never fabricates a place — no coordinates, no id, no price", () => {
  const testDay = day({ cityRegion: "City A" });
  const opportunity = buildMealOpportunityItem(testDay, "dinner");
  assert.equal(opportunity.lat, null);
  assert.equal(opportunity.lon, null);
  assert.equal(opportunity.recommendationId, null);
  assert.equal(opportunity.approximatePrice, null);
  assert.ok(isMealOpportunityMarker(opportunity));
});
