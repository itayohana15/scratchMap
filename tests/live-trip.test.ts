import assert from "node:assert/strict";
import test from "node:test";

import { applyDeterministicReplacement } from "../src/lib/server/country-itinerary-generation";
import { buildTripPreferenceProfile } from "../src/lib/server/itinerary-generation-constraints";
import { bookingStatusForItem } from "../src/lib/trip-item-status";
import {
  computeDelayImpact,
  computeNextActivity,
  effectiveStartTime,
  mergeLiveReplanResult,
  mergeProtectedItemsIntoRegeneratedDay,
  preserveUserSelectedHotel,
  shiftRemainingDay,
} from "../src/lib/live-trip-planner";
import { getDestinationDateString, getTripDayForNow, isTripActiveNow } from "../src/lib/live-trip-time";
import { createQuickExpense, todaySpend } from "../src/lib/trip-expenses";
import {
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  markItemCompleted,
  markItemSkipped,
  type AiItineraryRequest,
  type TripBooking,
  type TripItineraryDay,
  type TripItineraryItem,
  type TripPreferences,
  type TripRecommendation,
} from "../src/lib/trip-workspace";
import type { CountryItineraryRecord } from "../src/lib/itineraries";

function recommendation(overrides: Partial<TripRecommendation> = {}): TripRecommendation {
  return {
    id: overrides.id ?? "rec-1",
    name: overrides.name ?? "Sample Place",
    category: overrides.category ?? "attraction",
    location: overrides.location ?? "Tokyo",
    shortDescription: overrides.shortDescription ?? "Sample description",
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 90,
    approximatePrice: overrides.approximatePrice ?? 120,
    openingHours: overrides.openingHours ?? "09:00-18:00",
    recommendedTimeOfDay: overrides.recommendedTimeOfDay ?? "afternoon",
    reservationRequired: overrides.reservationRequired ?? false,
    priceOriginalAmount: overrides.priceOriginalAmount ?? null,
    priceOriginalCurrency: overrides.priceOriginalCurrency ?? null,
    priceConvertedAmount: overrides.priceConvertedAmount ?? null,
    priceExchangeRate: overrides.priceExchangeRate ?? null,
    priceRateTimestamp: overrides.priceRateTimestamp ?? null,
    convertedCurrency: overrides.convertedCurrency ?? null,
    sourceType: overrides.sourceType ?? null,
    mapLink: overrides.mapLink ?? "",
    imageUrl: overrides.imageUrl ?? "",
    imageQuery: overrides.imageQuery ?? "",
    lat: overrides.lat ?? 35.68,
    lon: overrides.lon ?? 139.76,
    source: overrides.source ?? "api",
    wikipediaUrl: overrides.wikipediaUrl ?? null,
    website: overrides.website ?? null,
    wheelchairAccessible: overrides.wheelchairAccessible ?? null,
    isFree: overrides.isFree ?? null,
  };
}

const BASE_PREFERENCES: TripPreferences = createDefaultWorkspace("Japan").preferences;

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

function day(overrides: Partial<TripItineraryDay> = {}): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides };
}

function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  return {
    id: "itin-1",
    countryId: "country-jp",
    isoA2: "JP",
    title: "Japan trip",
    startDate: "2026-10-06",
    endDate: "2026-10-08",
    daysCount: 3,
    travelers: 2,
    budget: 5000,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: BASE_PREFERENCES,
    workspaceSnapshot: createDefaultWorkspace("Japan"),
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 0,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
    status: "active",
    version: 1,
    parentItineraryId: null,
    manuallyEdited: false,
    archived: false,
    generatedAt: "2026-08-19T00:00:00.000Z",
    deletedAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function buildPayload(overrides: Partial<AiItineraryRequest> = {}): AiItineraryRequest {
  return {
    countryId: "country-jp",
    countryName: "Japan",
    isoA2: "JP",
    tripStatus: "currently_traveling",
    preferences: BASE_PREFERENCES,
    selectedPlaces: [],
    recommendations: [],
    bookings: [],
    existingDays: [],
    ...overrides,
  };
}

// 1. Active-trip detection uses the destination timezone, not a UTC-blind
// or server/browser-local comparison.
test("isTripActiveNow detects an active trip using the destination timezone", () => {
  // 2026-10-06T23:30 UTC is already 2026-10-07 08:30 in Tokyo (UTC+9) --
  // a trip ending 2026-10-06 must read as completed in Tokyo time even
  // though the bare UTC calendar date is still the 6th.
  const almostMidnightUtc = new Date("2026-10-06T23:30:00.000Z");
  assert.equal(isTripActiveNow("2026-10-01", "2026-10-06", "JP", almostMidnightUtc), false);
  assert.equal(isTripActiveNow("2026-10-01", "2026-10-07", "JP", almostMidnightUtc), true);
});

// 2. A completed trip must not read as active (no Live Mode).
test("isTripActiveNow is false once the trip has ended", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");
  assert.equal(isTripActiveNow("2026-10-01", "2026-10-08", "JP", now), false);
});

// 3 & 37. Marking an item completed never touches planned fields.
test("markItemCompleted preserves plannedStartTime and other planned fields", () => {
  const original = item({ name: "Senso-ji", plannedStartTime: "10:00", location: "Asakusa", transportation: "מטרו" });
  const completed = markItemCompleted(original, { actualCost: 500 });

  assert.equal(completed.plannedStartTime, "10:00");
  assert.equal(completed.location, "Asakusa");
  assert.equal(completed.transportation, "מטרו");
  assert.equal(completed.completed, true);
  assert.ok(completed.completedAt);
  assert.equal(completed.actualCost, 500);
});

// 4. Skipping an item never deletes it -- planned history stays intact.
test("markItemSkipped does not delete the item, only marks it", () => {
  const original = item({ id: "keep-me", name: "Museum" });
  const skipped = markItemSkipped(original, "עייף/ה");

  assert.equal(skipped.id, "keep-me");
  assert.equal(skipped.name, "Museum");
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.skipReason, "עייף/ה");
  assert.equal(skipped.completed, false);
});

// 5. A locked item is never touched by the deterministic replacement path.
test("applyDeterministicReplacement refuses to replace a locked or fixed-time item", () => {
  const lockedItem = item({ id: "locked-1", name: "Booked Concert", locked: true });
  const testDay = day({ items: [lockedItem] });
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(BASE_PREFERENCES, "Japan", 1);

  const { day: resultDay, replacementName } = applyDeterministicReplacement(testDay, lockedItem, payload, profile);
  assert.equal(resultDay.items[0].name, "Booked Concert");
  assert.equal(replacementName, "Booked Concert");
});

// 6. A fixed-time item is excluded from both delay-impact "shiftable"
// treatment and shiftRemainingDay's actual shift.
test("fixedTime items are flagged as conflicts by computeDelayImpact and never shifted", () => {
  const anchor = item({ id: "anchor", name: "Lunch", plannedStartTime: "12:00" });
  const reservation = item({ id: "res-1", name: "Dinner reservation", plannedStartTime: "19:00", fixedTime: true });
  const testDay = day({ items: [anchor, reservation] });

  const impact = computeDelayImpact(testDay, 30, "anchor");
  const effect = impact.effects.find((entry) => entry.itemId === "res-1");
  assert.equal(effect?.status, "conflict");

  const shifted = shiftRemainingDay(testDay, 30, "anchor");
  const shiftedReservation = shifted.items.find((entry) => entry.id === "res-1");
  assert.equal(shiftedReservation?.liveScheduledStartTime, null);
  assert.equal(shiftedReservation?.plannedStartTime, "19:00");
});

// 7. A 30-minute delay must correctly flag a downstream closing-time
// conflict, not a vague blanket warning.
test("computeDelayImpact flags a specific closing-time conflict for a 30-minute delay", () => {
  const anchor = item({ id: "anchor", name: "Lunch", plannedStartTime: "16:40" });
  const observatory = item({
    id: "observatory",
    name: "Observatory",
    plannedStartTime: "16:50",
    openingHours: "09:00-17:00",
  });
  const testDay = day({ items: [anchor, observatory] });

  const impact = computeDelayImpact(testDay, 30, "anchor");
  const effect = impact.effects.find((entry) => entry.itemId === "observatory");
  assert.equal(effect?.status, "conflict");
  assert.match(effect!.detail, /17:00/);
});

// 8. Replacing one item only changes that item's day -- route/segment
// identity elsewhere is untouched (same day object shape, only one item
// swapped).
test("applyDeterministicReplacement only changes the targeted item within its day", () => {
  const keepItem = item({ id: "keep", name: "Keep Me", plannedStartTime: "09:00" });
  const targetItem = item({ id: "target", name: "Closed Place", plannedStartTime: "11:00" });
  const testDay = day({ items: [keepItem, targetItem] });
  const payload = buildPayload();
  const profile = buildTripPreferenceProfile(BASE_PREFERENCES, "Japan", 1);

  const { day: resultDay } = applyDeterministicReplacement(testDay, targetItem, payload, profile);
  assert.equal(resultDay.items.length, 2);
  assert.equal(resultDay.items[0].id, "keep");
  assert.equal(resultDay.items[0].name, "Keep Me");
  assert.equal(resultDay.items[1].id, "target");
  assert.notEqual(resultDay.items[1].name, "Closed Place");
});

// Spec "תיקון גנרי, לא תיקון תשיעי" — applyDeterministicReplacement (Live
// Trip Mode's "skip/replace this" fast path) used to hand
// pickReplacementRecommendation a day view that still included the item
// being replaced, so a candidate close only to IT (never to the day's
// real anchor) could pass.
test("applyDeterministicReplacement never selects a replacement close only to the target item itself, not to the day's real anchor", () => {
  const baseAnchor = item({ id: "base", name: "Base Anchor", lat: 10, lon: 10, transportation: "רכב" });
  // ~140km — pickReplacementRecommendation here gets no maxDistanceKm
  // override, so it falls back to the fixed 80km default
  // (CANDIDATE_GEOGRAPHIC_COMPATIBILITY_KM); explicit "רכב" keeps the
  // resulting travel time schedulable rather than risking the
  // scheduling-overflow trap found earlier this round.
  const targetItem = item({ id: "target", name: "Closed Place", lat: 11.26, lon: 10, transportation: "רכב" });
  const testDay = day({ items: [baseAnchor, targetItem] });
  const payload = buildPayload({
    recommendations: [
      recommendation({
        id: "fake-near-target",
        name: "Fake Nearby To Target Only",
        category: "attraction",
        location: "Nowhere Real",
        // Close to the target item (11.26, 10) — far from the real base (10, 10).
        lat: 11.261,
        lon: 10.001,
      }),
    ],
  });
  const profile = buildTripPreferenceProfile(BASE_PREFERENCES, "Japan", 1);

  const { day: resultDay } = applyDeterministicReplacement(testDay, targetItem, payload, profile);

  assert.ok(!resultDay.items.some((entry) => entry.name === "Closed Place"), "the target item must not survive under its original name");
  assert.ok(
    !resultDay.items.some((entry) => entry.name === "Fake Nearby To Target Only"),
    "a candidate close only to the target item being replaced must never be selected"
  );
});

// 9. computeNextActivity ignores completed/skipped items even when they
// are earlier in planned order than an eligible one.
test("computeNextActivity skips completed and skipped items regardless of order", () => {
  const testDay = day({
    items: [
      item({ id: "a", name: "Breakfast", plannedStartTime: "08:00", completed: true }),
      item({ id: "b", name: "Closed stop", plannedStartTime: "09:00", skipped: true }),
      item({ id: "c", name: "Senso-ji", plannedStartTime: "10:00" }),
    ],
  });

  const next = computeNextActivity(testDay, 8 * 60 + 30);
  assert.equal(next?.id, "c");
});

// 10. Actual spend is tracked separately from the planned approximatePrice
// estimate -- no mixing.
test("todaySpend sums actual data only, never planned estimates", () => {
  const plannedOnlyItem = item({ id: "planned-only", approximatePrice: 5000, actualCost: null });
  const testDay = day({ id: "day-1", items: [plannedOnlyItem] });
  const itinerary = buildItinerary({ itineraryDays: [testDay] });

  const beforeAnyActual = todaySpend(itinerary, "day-1");
  assert.equal(beforeAnyActual.hasData, false);
  assert.equal(beforeAnyActual.total, 0, "an unset actualCost must not fall back to the planned approximatePrice");

  const quickExpense = { ...createQuickExpense("day-1"), amount: 120 };
  const withExpense = buildItinerary({
    itineraryDays: [testDay],
    workspaceSnapshot: { ...createDefaultWorkspace("Japan"), actualExpenses: [quickExpense] },
  });
  const afterExpense = todaySpend(withExpense, "day-1");
  assert.equal(afterExpense.hasData, true);
  assert.equal(afterExpense.total, 120);
});

// 11. Actual transport is stored independently of the planned transport
// mode.
test("actualTransportation stays independent of the planned transportation field", () => {
  const planned = item({ transportation: "מטרו", actualTransportation: "" });
  const afterActualChange = { ...planned, actualTransportation: "מונית" };

  assert.equal(afterActualChange.transportation, "מטרו", "planned transport must not change");
  assert.equal(afterActualChange.actualTransportation, "מונית");
});

// 12. Day rollover happens at destination-local midnight, not the
// server/browser's local date.
test("getTripDayForNow returns the correct day once destination-local time has crossed midnight", () => {
  const days = [
    day({ dayNumber: 1, date: "2026-10-06", items: [] }),
    day({ dayNumber: 2, date: "2026-10-07", items: [] }),
  ];
  // 2026-10-06T16:00 UTC is 2026-10-07T01:00 in Tokyo -- already day 2
  // locally even though a naive UTC/browser-local read would still say the 6th.
  const crossedMidnightUtc = new Date("2026-10-06T16:00:00.000Z");
  const resolvedDay = getTripDayForNow(days, "2026-10-06", "JP", crossedMidnightUtc);
  assert.equal(resolvedDay?.dayNumber, 2);
});

// 13. A booking's linked document produces a real (non-null) ticket-open
// affordance via the shared booking-status helper.
test("bookingStatusForItem reflects a booked, linked reservation", () => {
  const reservedItem = item({ id: "teamlab", reservationRequired: true });
  const linkedBooking: TripBooking = {
    id: "booking-1",
    tripId: "itin-1",
    dayId: "day-1",
    itineraryItemId: "teamlab",
    type: "attraction",
    title: "TeamLab",
    provider: "",
    confirmationNumber: "ABC123",
    bookingReference: "",
    startDateTime: "",
    endDateTime: "",
    location: "",
    status: "booked",
    paymentStatus: "paid",
    amountOriginal: null,
    amountOriginalCurrency: null,
    amountConverted: null,
    exchangeRate: null,
    rateTimestamp: null,
    documentIds: [],
    notes: "",
    createdAt: "",
    updatedAt: "",
  };

  const status = bookingStatusForItem(reservedItem, [linkedBooking]);
  assert.ok(status, "a reservation-required item with a paid linked booking must produce a status");
  assert.equal(status!.glyph, "💳");
  assert.equal(status!.bookingId, "booking-1");
});

// 14. The live_replan merge defaults to "remaining today only" -- past/
// completed/skipped/locked/fixed-time items are excluded from being
// overwritten by the AI's regenerated content.
test("mergeLiveReplanResult keeps completed/skipped/locked/fixedTime items untouched", () => {
  const original = [
    item({ id: "done-1", name: "Breakfast", completed: true }),
    item({ id: "locked-1", name: "Booked Show", locked: true }),
    item({ id: "open-1", name: "Museum", plannedStartTime: "14:00" }),
  ];
  const regenerated = [
    item({ id: "regen-museum", name: "Museum", plannedStartTime: "14:30" }),
    item({ id: "regen-cafe", name: "New Cafe Stop", plannedStartTime: "15:30" }),
  ];

  let nextId = 0;
  const { items, untouchable } = mergeLiveReplanResult(original, regenerated, () => `generated-${nextId++}`);

  assert.equal(untouchable.length, 2);
  assert.ok(items.some((entry) => entry.id === "done-1" && entry.name === "Breakfast"));
  assert.ok(items.some((entry) => entry.id === "locked-1" && entry.name === "Booked Show"));
  assert.ok(items.some((entry) => entry.name === "New Cafe Stop"), "a genuinely new regenerated item should be accepted");
  assert.equal(
    items.some((entry) => entry.name === "Museum" && entry.id === "open-1"),
    false,
    "an eligible (not-untouchable) item's regenerated replacement should take over its slot, not keep the stale one"
  );
});

// ===== Thread 1: locked/fixed-time hard requirement =====
// Test H — regenerate-day preserves a locked item (real id and state,
// not just re-created content that happens to share a name).
test("mergeProtectedItemsIntoRegeneratedDay preserves a locked item through a full day regeneration", () => {
  const original = [
    item({ id: "locked-1", name: "Booked Cooking Class", locked: true, plannedStartTime: "12:00", bookingCompleted: true }),
    item({ id: "open-1", name: "Old Town Walk", plannedStartTime: "09:00" }),
  ];
  const regenerated = [
    item({ id: "regen-1", name: "Different Museum", plannedStartTime: "09:30" }),
    item({ id: "regen-2", name: "Different Market", plannedStartTime: "15:00" }),
  ];

  const merged = mergeProtectedItemsIntoRegeneratedDay(original, regenerated);

  const survivingLocked = merged.find((entry) => entry.id === "locked-1");
  assert.ok(survivingLocked, "the locked item must survive a full day regeneration");
  assert.equal(survivingLocked!.name, "Booked Cooking Class");
  assert.equal(survivingLocked!.bookingCompleted, true, "the locked item's own state must be preserved exactly, not re-created");
  assert.ok(merged.some((entry) => entry.id === "regen-1"), "genuinely new regenerated content is still accepted");
  assert.ok(merged.some((entry) => entry.id === "regen-2"));
});

// Test I — regenerate-day preserves fixed time (the pinned clock time
// itself survives, and any regenerated item colliding with that exact
// time yields to it rather than sitting alongside it).
test("mergeProtectedItemsIntoRegeneratedDay preserves a fixed-time item's exact time through regeneration, dropping a regenerated collision", () => {
  const original = [item({ id: "fixed-1", name: "Timed Reservation", fixedTime: true, plannedStartTime: "14:30" })];
  const regenerated = [
    item({ id: "regen-1", name: "AI's Own Idea For 14:30", plannedStartTime: "14:30" }),
    item({ id: "regen-2", name: "Unrelated Morning Stop", plannedStartTime: "09:00" }),
  ];

  const merged = mergeProtectedItemsIntoRegeneratedDay(original, regenerated);

  const survivingFixed = merged.find((entry) => entry.id === "fixed-1");
  assert.ok(survivingFixed);
  assert.equal(survivingFixed!.plannedStartTime, "14:30", "the fixed-time item's own pinned time must survive exactly");
  assert.equal(
    merged.some((entry) => entry.id === "regen-1"),
    false,
    "a regenerated item colliding with the fixed item's own pinned time must yield to it, not sit alongside it"
  );
  assert.ok(merged.some((entry) => entry.id === "regen-2"), "a regenerated item at a different time is still accepted");
});

test("mergeProtectedItemsIntoRegeneratedDay returns the regenerated items unchanged when nothing is locked or fixed-time", () => {
  const original = [item({ id: "open-1", name: "Old Town Walk" })];
  const regenerated = [item({ id: "regen-1", name: "New Idea" })];
  assert.equal(mergeProtectedItemsIntoRegeneratedDay(original, regenerated), regenerated);
});

// Section D4: a user-selected hotel must never be silently replaced by
// whatever a day/trip regeneration happens to suggest instead.
test("preserveUserSelectedHotel keeps the original hotel when the day had a real, explicit selection", () => {
  const original = day({
    accommodation: "Park Hyatt Tokyo",
    accommodationLat: 35.6851,
    accommodationLon: 139.6929,
    accommodationMapLink: "https://maps.example/park-hyatt",
  });
  const regenerated = day({
    accommodation: "Generic Shinjuku Hotel",
    accommodationLat: 35.69,
    accommodationLon: 139.7,
    accommodationMapLink: "https://maps.example/generic",
    notes: "regenerated content",
  });

  const merged = preserveUserSelectedHotel(original, regenerated);
  assert.equal(merged.accommodation, "Park Hyatt Tokyo");
  assert.equal(merged.accommodationLat, 35.6851);
  assert.equal(merged.accommodationLon, 139.6929);
  assert.equal(merged.accommodationMapLink, "https://maps.example/park-hyatt");
  assert.equal(merged.notes, "regenerated content", "everything else about the regenerated day is still applied");
});

test("preserveUserSelectedHotel lets a regenerated hotel through when the original day never had a real selection", () => {
  const original = day({ accommodation: "", accommodationLat: null, accommodationLon: null });
  const regenerated = day({ accommodation: "AI-Suggested Hotel", accommodationLat: 35.69, accommodationLon: 139.7 });

  assert.equal(preserveUserSelectedHotel(original, regenerated), regenerated);
});

// 15. Next-activity/leave-by computation works fully without any location
// data -- it's pure time/schedule math, never dependent on geolocation.
test("computeNextActivity and effectiveStartTime work correctly with no location data involved", () => {
  const testDay = day({
    items: [item({ id: "a", name: "Walk", plannedStartTime: "09:00", lat: null, lon: null })],
  });
  const next = computeNextActivity(testDay, 8 * 60);
  assert.equal(next?.id, "a");
  assert.equal(effectiveStartTime(next!), "09:00");
});

test("getDestinationDateString is sane for a known timezone", () => {
  const dateString = getDestinationDateString("JP", new Date("2026-10-06T20:00:00.000Z"));
  assert.equal(dateString, "2026-10-07");
});
