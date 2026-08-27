import assert from "node:assert/strict";
import test from "node:test";

import {
  clockToMinutes,
  computeDayWindow,
  DEFAULT_DAY_WINDOW,
  minutesToClock,
  scheduleDayItems,
} from "../src/lib/server/itinerary-scheduler";
import type { AiGeneratedItem } from "../src/lib/trip-workspace";
import type { ArrivalDepartureWindow } from "../src/lib/flight-planning";

function buildItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
  return {
    name: overrides.name ?? "Sample Stop",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tbilisi",
    shortDescription: overrides.shortDescription ?? "",
    slot: overrides.slot ?? "morning",
    plannedStartTime: overrides.plannedStartTime ?? "",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? null,
    approximatePrice: overrides.approximatePrice ?? null,
    priceOriginalAmount: overrides.priceOriginalAmount ?? null,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? null,
    priceConvertedAmount: overrides.priceConvertedAmount ?? null,
    priceExchangeRate: overrides.priceExchangeRate ?? null,
    priceRateTimestamp: overrides.priceRateTimestamp ?? null,
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 0,
    openingHours: overrides.openingHours ?? "",
    reservationRequired: overrides.reservationRequired ?? false,
    transportation: overrides.transportation ?? "הליכה",
    mapLink: overrides.mapLink ?? "",
    lat: overrides.lat ?? null,
    lon: overrides.lon ?? null,
    bookingWarning: overrides.bookingWarning ?? "",
    alternativeSuggestion: overrides.alternativeSuggestion ?? "",
    recommendationId: overrides.recommendationId ?? null,
    locked: overrides.locked ?? false,
    priority: overrides.priority ?? "preferred",
    fixedTime: overrides.fixedTime ?? false,
  };
}

test("computeDayWindow defaults to the normal 09:00-22:00 window on a middle day", () => {
  const window = computeDayWindow(3, 7, null);
  assert.equal(minutesToClock(window.startMinutes), "09:00");
  assert.equal(minutesToClock(window.endMinutes), "22:00");
});

test("computeDayWindow narrows the start on the arrival day (day 1)", () => {
  const arrivalDepartureWindow: ArrivalDepartureWindow = {
    earliestUsableTimeOnArrivalDay: { date: "2026-06-23", time: "17:30" },
    latestUsableTimeOnDepartureDay: null,
  };
  const window = computeDayWindow(1, 7, arrivalDepartureWindow);
  assert.equal(minutesToClock(window.startMinutes), "17:30");
  assert.equal(minutesToClock(window.endMinutes), "22:00");
});

test("computeDayWindow narrows the end on the departure day (last day)", () => {
  const arrivalDepartureWindow: ArrivalDepartureWindow = {
    earliestUsableTimeOnArrivalDay: null,
    latestUsableTimeOnDepartureDay: { date: "2026-06-29", time: "11:00" },
  };
  const window = computeDayWindow(7, 7, arrivalDepartureWindow);
  assert.equal(minutesToClock(window.startMinutes), "09:00");
  assert.equal(minutesToClock(window.endMinutes), "11:00");
});

test("computeDayWindow never collapses to a degenerate window", () => {
  const arrivalDepartureWindow: ArrivalDepartureWindow = {
    earliestUsableTimeOnArrivalDay: { date: "2026-06-23", time: "21:45" },
    latestUsableTimeOnDepartureDay: null,
  };
  const window = computeDayWindow(1, 7, arrivalDepartureWindow);
  assert.ok(window.endMinutes - window.startMinutes >= 60);
});

test("scheduleDayItems assigns real, non-overlapping sequential times instead of one shared default", () => {
  const items = [buildItem({ name: "Old Town Walk" }), buildItem({ name: "Museum" }), buildItem({ name: "Viewpoint" })];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");

  assert.equal(scheduled.length, 3);
  for (let index = 1; index < scheduled.length; index += 1) {
    const previousEnd = clockToMinutes(scheduled[index - 1].endTime!);
    const currentStart = clockToMinutes(scheduled[index].plannedStartTime);
    assert.ok(previousEnd != null && currentStart != null);
    assert.ok(
      currentStart! >= previousEnd!,
      `item ${index} starts at ${scheduled[index].plannedStartTime} before the previous item ends at ${scheduled[index - 1].endTime} — this is exactly the "three activities at 12:30" bug`
    );
  }
});

test("scheduleDayItems inserts real travel time between two stops into the timeline", () => {
  const items = [buildItem({ name: "A" }), buildItem({ name: "B", travelMinutes: 25 })];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");

  const firstEnd = clockToMinutes(scheduled[0].endTime!)!;
  const secondStart = clockToMinutes(scheduled[1].plannedStartTime)!;
  assert.ok(secondStart >= firstEnd + 25);
});

test("scheduleDayItems lets a full_day-scale anchor consume essentially the rest of the window", () => {
  const items = [buildItem({ name: "Disneyland", category: "day_trip" })];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Paris");
  const duration = clockToMinutes(scheduled[0].endTime!)! - clockToMinutes(scheduled[0].plannedStartTime)!;
  assert.ok(duration >= 300, `expected a full-day duration, got ${duration} minutes`);
});

test("scheduleDayItems returns a free-time block only when the leftover window is meaningfully large", () => {
  const bigLeftover = scheduleDayItems(
    [buildItem({ name: "Short morning stop", estimatedDurationMinutes: 30 })],
    { startMinutes: 9 * 60, endMinutes: 12 * 60 },
    "Tbilisi"
  );
  assert.ok(bigLeftover.freeTimeItem != null);
  assert.equal(bigLeftover.freeTimeItem!.name, "זמן חופשי");

  const tightWindow = scheduleDayItems(
    [buildItem({ name: "Long stop", estimatedDurationMinutes: 165 })],
    { startMinutes: 9 * 60, endMinutes: 12 * 60 },
    "Tbilisi"
  );
  assert.equal(tightWindow.freeTimeItem, null);
});
