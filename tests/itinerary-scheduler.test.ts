import assert from "node:assert/strict";
import test from "node:test";

import {
  clockToMinutes,
  computeDayWindow,
  DEFAULT_DAY_WINDOW,
  findFixedTimeConflicts,
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
    pricePerPerson: overrides.pricePerPerson ?? null,
    priceOriginalAmount: overrides.priceOriginalAmount ?? null,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? null,
    priceConvertedAmount: overrides.priceConvertedAmount ?? null,
    priceExchangeRate: overrides.priceExchangeRate ?? null,
    priceRateTimestamp: overrides.priceRateTimestamp ?? null,
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    travelMinutes: overrides.travelMinutes ?? 0,
    openingHours: overrides.openingHours ?? "",
    lastEntryTime: overrides.lastEntryTime ?? "",
    canonicalPlaceId: overrides.canonicalPlaceId ?? "",
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

// ===== Thread 1: locked/fixed-time hard requirement =====
// Test C — fixed-time activity keeps exact time.
test("scheduleDayItems preserves a fixed-time item's exact plannedStartTime, never recomputing it from the cursor", () => {
  const items = [buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 })];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  assert.equal(scheduled[0].plannedStartTime, "10:00");
});

// Test D — fixed-time activity survives reorder (its real time wins
// regardless of where flexible items around it sit in the input list).
test("scheduleDayItems keeps a fixed-time item's exact time regardless of its position among flexible items", () => {
  const items = [
    buildItem({ name: "Morning Walk", slot: "morning", estimatedDurationMinutes: 60 }),
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "14:30", estimatedDurationMinutes: 90 }),
    buildItem({ name: "Evening Stroll", slot: "evening", estimatedDurationMinutes: 60 }),
  ];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  assert.equal(scheduled.find((item) => item.name === "Museum")!.plannedStartTime, "14:30");
});

// Test E — a non-fixed activity fills in around a fixed anchor, strictly
// between it and the day's boundaries, never overlapping it.
test("scheduleDayItems fits a flexible item strictly between the previous anchor and a fixed-time item, never overlapping it", () => {
  const items = [
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 }), // ends 11:30
    buildItem({ name: "Lunch", category: "cafe", estimatedDurationMinutes: 45 }),
  ];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  const museum = scheduled.find((item) => item.name === "Museum")!;
  const lunch = scheduled.find((item) => item.name === "Lunch")!;
  assert.equal(museum.plannedStartTime, "10:00");
  assert.ok(clockToMinutes(lunch.plannedStartTime)! >= clockToMinutes(museum.endTime!)!, "lunch must start at or after the fixed anchor ends");
});

// Test F — two fixed anchors: everything else fills in around both,
// neither anchor ever moves.
test("scheduleDayItems schedules surrounding items correctly around two fixed-time anchors", () => {
  const items = [
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 }), // 10:00-11:30
    buildItem({ name: "Lunch", category: "cafe", estimatedDurationMinutes: 45 }),
    buildItem({ name: "Tour", fixedTime: true, plannedStartTime: "14:30", estimatedDurationMinutes: 120 }), // 14:30-16:30
  ];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  const museum = scheduled.find((item) => item.name === "Museum")!;
  const lunch = scheduled.find((item) => item.name === "Lunch")!;
  const tour = scheduled.find((item) => item.name === "Tour")!;

  assert.equal(museum.plannedStartTime, "10:00");
  assert.equal(tour.plannedStartTime, "14:30");
  assert.ok(clockToMinutes(lunch.plannedStartTime)! >= clockToMinutes(museum.endTime!)!, "lunch must not start before the first fixed anchor ends");
  assert.ok(clockToMinutes(lunch.endTime!)! <= clockToMinutes(tour.plannedStartTime)!, "lunch must not run into the second fixed anchor");
});

// A non-fixed item that structurally cannot fit before the next fixed
// anchor is reported as overflow — never silently overlapped, never
// allowed to push the anchor later.
test("scheduleDayItems reports a non-fixed item as overflow rather than overlapping a fixed-time anchor it cannot fit before", () => {
  const items = [
    buildItem({ name: "Long Museum Visit", category: "museum", estimatedDurationMinutes: 150 }), // clamps to 150min, 09:00-11:30
    buildItem({ name: "Timed Tour", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 60 }),
  ];
  const { items: scheduled, overflowItems } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  const tour = scheduled.find((item) => item.name === "Timed Tour")!;
  assert.equal(tour.plannedStartTime, "10:00", "the fixed anchor itself must never move to make room");
  assert.ok(
    overflowItems.some((item) => item.name === "Long Museum Visit"),
    "an item that cannot fit before a fixed anchor must be reported, never silently dropped or overlapped"
  );
  assert.ok(!scheduled.some((item) => item.name === "Long Museum Visit"));
});

// Test G — impossible fixed-time conflict returns a structured failure.
test("findFixedTimeConflicts reports two fixed-time items that genuinely cannot both be honored", () => {
  const items = [
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 }), // ends 11:30
    buildItem({ name: "Tour", fixedTime: true, plannedStartTime: "11:00", estimatedDurationMinutes: 60, travelMinutes: 20 }), // starts before Museum even ends
  ];
  const conflicts = findFixedTimeConflicts(items);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].activityA, "Museum");
  assert.equal(conflicts[0].activityB, "Tour");
  assert.equal(conflicts[0].startA, "10:00");
  assert.equal(conflicts[0].endA, "11:30");
  assert.equal(conflicts[0].startB, "11:00");
  assert.equal(conflicts[0].travelMinutesRequired, 20);
});

test("findFixedTimeConflicts reports nothing when fixed-time items have real room between them", () => {
  const items = [
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 }),
    buildItem({ name: "Tour", fixedTime: true, plannedStartTime: "14:00", estimatedDurationMinutes: 60 }),
  ];
  assert.deepEqual(findFixedTimeConflicts(items), []);
});

test("scheduleDayItems does not silently resolve a fixed-time-vs-fixed-time conflict — both keep their own declared time, and the conflict is surfaced", () => {
  const items = [
    buildItem({ name: "Museum", fixedTime: true, plannedStartTime: "10:00", estimatedDurationMinutes: 90 }),
    buildItem({ name: "Tour", fixedTime: true, plannedStartTime: "11:00", estimatedDurationMinutes: 60 }),
  ];
  const { items: scheduled, fixedTimeConflicts } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  assert.equal(scheduled.find((item) => item.name === "Museum")!.plannedStartTime, "10:00");
  assert.equal(scheduled.find((item) => item.name === "Tour")!.plannedStartTime, "11:00");
  assert.equal(fixedTimeConflicts.length, 1);
});

// A fixedTime item with an unparseable/missing plannedStartTime must never
// crash the scheduler or silently "anchor" to garbage — it degrades to
// normal flexible scheduling.
test("scheduleDayItems treats a fixedTime item with no parseable time as a normal flexible item instead of crashing", () => {
  const items = [buildItem({ name: "Broken Fixed Item", fixedTime: true, plannedStartTime: "" })];
  const { items: scheduled } = scheduleDayItems(items, DEFAULT_DAY_WINDOW, "Tbilisi");
  assert.equal(scheduled.length, 1);
  assert.ok(clockToMinutes(scheduled[0].plannedStartTime) != null);
});
