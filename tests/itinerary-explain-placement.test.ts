import assert from "node:assert/strict";
import test from "node:test";

import { explainItineraryPlacement } from "../src/lib/itinerary-explain-placement";
import { createDefaultWorkspace, createEmptyDay, createEmptyItineraryItem } from "../src/lib/trip-workspace";

const PREFERENCES = createDefaultWorkspace("Georgia").preferences;

test("explainItineraryPlacement cites shared area with the previous stop when locations match", () => {
  const previous = createEmptyItineraryItem("afternoon");
  previous.name = "Freedom Square";
  previous.location = "Old Tbilisi";

  const current = createEmptyItineraryItem("evening");
  current.name = "Rike Park";
  current.location = "Old Tbilisi";

  const day = { ...createEmptyDay(1, "2026-06-23"), cityRegion: "Tbilisi" };

  const text = explainItineraryPlacement(current, day, previous, PREFERENCES);
  assert.match(text, /Freedom Square/);
});

test("explainItineraryPlacement falls back to the day's own city region without a matching previous item", () => {
  const current = createEmptyItineraryItem("morning");
  current.name = "Narikala Fortress";
  current.location = "";

  const day = { ...createEmptyDay(1, "2026-06-23"), cityRegion: "Tbilisi" };

  const text = explainItineraryPlacement(current, day, null, PREFERENCES);
  assert.match(text, /Tbilisi/);
});

test("explainItineraryPlacement mentions a short travel time from the previous stop", () => {
  const previous = createEmptyItineraryItem("afternoon");
  previous.location = "Somewhere else entirely";

  const current = createEmptyItineraryItem("afternoon");
  current.location = "A different place";
  current.travelMinutes = 8;

  const day = createEmptyDay(1, "2026-06-23");

  const text = explainItineraryPlacement(current, day, previous, PREFERENCES);
  assert.match(text, /8 דקות/);
});

test("explainItineraryPlacement never fabricates a reason when nothing applies", () => {
  const current = createEmptyItineraryItem("lunch");
  current.location = "";
  const day = { ...createEmptyDay(1, "2026-06-23"), cityRegion: "" };

  const text = explainItineraryPlacement(current, day, null, PREFERENCES);
  assert.equal(text, "המקום הזה נבחר כדי לשמור על מסלול יום מאוזן ויעיל מבחינת המיקום והזמן.");
});
