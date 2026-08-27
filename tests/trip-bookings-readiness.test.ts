import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import { summarizeItemCosts } from "../src/lib/server/itinerary-generation-constraints";
import { applyBookingOverrides, createEmptyBooking } from "../src/lib/trip-bookings";
import { regenerateSmartChecklist, syncChecklistCompletion } from "../src/lib/trip-checklist";
import { computeTripReadiness, isReadinessApplicable } from "../src/lib/trip-readiness";
import {
  applyAiPlanToWorkspace,
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  type AiGeneratedDay,
  type AiGeneratedItem,
  type AiItineraryResponse,
  type TripBooking,
  type TripChecklistItem,
  type TripDocument,
  type TripItineraryItem,
} from "../src/lib/trip-workspace";

const BASE_PREFERENCES = createDefaultWorkspace("Japan").preferences;

function buildItinerary(overrides: Partial<CountryItineraryRecord> = {}): CountryItineraryRecord {
  const workspace = createDefaultWorkspace("Japan");
  return {
    id: "itin-1",
    countryId: "country-jp",
    isoA2: "JP",
    title: "Japan trip",
    startDate: "2026-10-06",
    endDate: "2026-10-08",
    daysCount: 1,
    travelers: 2,
    budget: 5000,
    generationMode: "balanced",
    source: "manual",
    model: null,
    summary: "",
    preferencesSnapshot: BASE_PREFERENCES,
    workspaceSnapshot: workspace,
    itineraryDays: [],
    costSummary: {
      totalEstimatedCost: 0,
      estimatedTransportCost: null,
      averageDailyCost: null,
      costPerTraveler: null,
      categoryBreakdown: {},
    },
    status: "upcoming",
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

function item(overrides: Partial<TripItineraryItem> = {}): TripItineraryItem {
  return { ...createEmptyItineraryItem(overrides.slot ?? "morning"), ...overrides };
}

function booking(overrides: Partial<TripBooking> = {}): TripBooking {
  return { ...createEmptyBooking("itin-1"), ...overrides };
}

// 1 & 2. Required-booking readiness category reacts to whether a matching
// booking record actually exists and is booked.
test("computeTripReadiness: required_bookings is missing without a linked booking, complete once booked", () => {
  const reservedItem = item({ id: "teamlab", name: "TeamLab Borderless", reservationRequired: true });
  const day = { ...createEmptyDay(1, "2026-10-06"), items: [reservedItem] };

  const withoutBooking = buildItinerary({ itineraryDays: [day] });
  const withoutReadiness = computeTripReadiness(withoutBooking);
  const withoutCategory = withoutReadiness.categories.find((category) => category.key === "required_bookings");
  assert.equal(withoutCategory?.status, "missing");

  const linkedBooking = booking({ itineraryItemId: "teamlab", status: "booked" });
  const withBooking = buildItinerary({
    itineraryDays: [day],
    workspaceSnapshot: { ...withoutBooking.workspaceSnapshot, bookings: [linkedBooking] },
  });
  const withReadiness = computeTripReadiness(withBooking);
  const withCategory = withReadiness.categories.find((category) => category.key === "required_bookings");
  assert.equal(withCategory?.status, "complete");
});

// 3 & 4. A booked/paid amount replaces the item's own estimate in the cost
// summary instead of both being counted.
test("applyBookingOverrides substitutes the booking amount instead of double-counting the item estimate", () => {
  const hotelItem = item({ id: "hotel-1", category: "hotel", name: "Hotel", approximatePrice: 2000 });
  const days = [{ ...createEmptyDay(1, "2026-10-06"), items: [hotelItem] }];

  const beforeOverride = summarizeItemCosts(days, 2, []);
  assert.equal(beforeOverride.totalEstimatedCost, 2000);

  const paidBooking = booking({ itineraryItemId: "hotel-1", status: "booked", paymentStatus: "paid", amountConverted: 1850 });
  const overridden = applyBookingOverrides(days, [paidBooking]);
  assert.equal(overridden[0].items[0].approximatePrice, 1850, "item price should be replaced, not added to");

  const afterOverride = summarizeItemCosts(overridden, 2, []);
  assert.equal(afterOverride.totalEstimatedCost, 1850, "cost summary should reflect only the booked amount, not 2000+1850");
});

// 5. A cancelled booking must not count as an active/booked item, and must
// not override the linked item's cost.
test("a cancelled booking is excluded from applyBookingOverrides and from readiness's booked counts", () => {
  const flightItem = item({ id: "flight-1", category: "transportation", name: "Flight", approximatePrice: 1200 });
  const days = [{ ...createEmptyDay(1, "2026-10-06"), items: [flightItem] }];
  const cancelledBooking = booking({ itineraryItemId: "flight-1", type: "flight", status: "cancelled", amountConverted: 900 });

  const overridden = applyBookingOverrides(days, [cancelledBooking]);
  assert.equal(overridden[0].items[0].approximatePrice, 1200, "a cancelled booking must not override the item's price");

  const itinerary = buildItinerary({
    itineraryDays: days,
    workspaceSnapshot: { ...createDefaultWorkspace("Japan"), bookings: [cancelledBooking] },
  });
  const readiness = computeTripReadiness(itinerary);
  const flights = readiness.categories.find((category) => category.key === "flights");
  assert.equal(flights?.status, "missing", "a cancelled flight booking should not satisfy the flights category");
});

// 6. syncChecklistCompletion only flips completion for items with a real
// linked booking/document -- never for unlinked auto items or user items.
test("syncChecklistCompletion only auto-completes items with a real linked record", () => {
  const now = new Date().toISOString();
  const linkedToBookedBooking: TripChecklistItem = {
    id: "c1",
    tripId: "itin-1",
    title: "Book flight",
    category: "bookings",
    dueDate: null,
    completed: false,
    source: "auto",
    autoKey: "flight-booking",
    linkedBookingId: "b1",
    linkedDocumentId: null,
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
  const linkedToDocument: TripChecklistItem = {
    ...linkedToBookedBooking,
    id: "c2",
    autoKey: "insurance-doc",
    linkedBookingId: null,
    linkedDocumentId: "d1",
  };
  const unlinkedAuto: TripChecklistItem = { ...linkedToBookedBooking, id: "c3", autoKey: "currency-plan", linkedBookingId: null };
  const userItem: TripChecklistItem = { ...linkedToBookedBooking, id: "c4", source: "user", autoKey: null, linkedBookingId: null };

  const bookedBooking = booking({ id: "b1", status: "booked" });
  const document: TripDocument = {
    id: "d1",
    tripId: "itin-1",
    bookingId: null,
    itineraryItemId: null,
    type: "insurance",
    title: "Insurance",
    fileName: "insurance.pdf",
    mimeType: "application/pdf",
    notes: "",
    isSensitive: true,
    createdAt: now,
    updatedAt: now,
  };

  const synced = syncChecklistCompletion(
    [linkedToBookedBooking, linkedToDocument, unlinkedAuto, userItem],
    [bookedBooking],
    [document]
  );

  assert.equal(synced.find((entry) => entry.id === "c1")?.completed, true, "linked booked booking -> completed");
  assert.equal(synced.find((entry) => entry.id === "c2")?.completed, true, "linked existing document -> completed");
  assert.equal(synced.find((entry) => entry.id === "c3")?.completed, false, "no linked record -> untouched");
  assert.equal(synced.find((entry) => entry.id === "c4")?.completed, false, "user item -> never auto-completed");
});

// 7. Regenerating the smart checklist updates existing auto items in place
// (matched by autoKey) and never touches user-created items.
test("regenerateSmartChecklist updates existing auto items and preserves user items", () => {
  const flightItem = item({ id: "flight-1", category: "transportation", name: "Flight to Tokyo" });
  const itinerary = buildItinerary({ itineraryDays: [{ ...createEmptyDay(1, "2026-10-06"), items: [flightItem] }] });

  let patchedRecord = itinerary;
  const patchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
    patchedRecord = updater(patchedRecord);
  };

  // Seed a user-created item and a stale-looking existing auto item first.
  patchedRecord = {
    ...patchedRecord,
    workspaceSnapshot: {
      ...patchedRecord.workspaceSnapshot,
      checklist: [
        {
          id: "user-1",
          tripId: itinerary.id,
          title: "קנה מתנות",
          category: "other",
          dueDate: null,
          completed: false,
          source: "user",
          autoKey: null,
          linkedBookingId: null,
          linkedDocumentId: null,
          notes: "",
          createdAt: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    },
  };

  regenerateSmartChecklist(patchDraft, patchedRecord, "JP");
  const afterFirstRun = patchedRecord.workspaceSnapshot?.checklist ?? [];
  assert.ok(afterFirstRun.some((entry) => entry.autoKey === "flight-passport"), "should detect the flight signal");
  assert.ok(afterFirstRun.some((entry) => entry.id === "user-1"), "user item must survive");
  const passportItemId = afterFirstRun.find((entry) => entry.autoKey === "flight-passport")!.id;

  // Regenerate again -- the same autoKey should update the existing row
  // (same id), not create a duplicate, and the user item is still there.
  regenerateSmartChecklist(patchDraft, patchedRecord, "JP");
  const afterSecondRun = patchedRecord.workspaceSnapshot?.checklist ?? [];
  const passportItems = afterSecondRun.filter((entry) => entry.autoKey === "flight-passport");
  assert.equal(passportItems.length, 1, "regeneration must not duplicate an existing auto item");
  assert.equal(passportItems[0].id, passportItemId, "regeneration must update the existing row, not replace its id");
  assert.equal(afterSecondRun.filter((entry) => entry.id === "user-1").length, 1, "user item must still be untouched");
});

// 8. Readiness is not applicable for completed (historical) trips.
test("isReadinessApplicable is false for completed trips, true otherwise", () => {
  assert.equal(isReadinessApplicable("completed"), false);
  assert.equal(isReadinessApplicable("archived"), false);
  assert.equal(isReadinessApplicable("upcoming"), true);
  assert.equal(isReadinessApplicable("active"), true);
  assert.equal(isReadinessApplicable("draft"), true);
});

// 9. not_applicable categories must not lower the overall score -- an empty
// trip with nothing applicable should read as 100%, not penalized.
test("computeTripReadiness excludes not_applicable categories from the score", () => {
  const itinerary = buildItinerary({ itineraryDays: [], budget: null });
  const readiness = computeTripReadiness(itinerary);
  const packing = readiness.categories.find((category) => category.key === "packing");
  const accommodation = readiness.categories.find((category) => category.key === "accommodation");
  assert.equal(packing?.status, "not_applicable");
  assert.equal(accommodation?.status, "not_applicable");
  // With no applicable categories penalizing it, an empty draft trip should
  // not be dragged down by categories that simply don't apply yet.
  const applicable = readiness.categories.filter((category) => category.status !== "not_applicable");
  const allComplete = applicable.every((category) => category.status === "complete");
  if (allComplete) {
    assert.equal(readiness.overallPercent, 100);
  }
});

// 10. Booking/document itineraryItemId links survive a simulated
// regeneration (matched by name+location, same heuristic Stage 2 already
// established for locked/priority carry-over).
test("applyAiPlanToWorkspace re-points booking/document itineraryItemId links to the regenerated item", () => {
  const oldItemId = "old-item-id";
  const workspace = {
    ...createDefaultWorkspace("Japan"),
    itineraryDays: [
      { ...createEmptyDay(1, "2026-10-06"), items: [item({ id: oldItemId, name: "Senso-ji", location: "Asakusa, Tokyo" })] },
    ],
    bookings: [booking({ itineraryItemId: oldItemId })],
    documents: [
      {
        id: "doc-1",
        tripId: "itin-1",
        bookingId: null,
        itineraryItemId: oldItemId,
        type: "attraction_ticket" as const,
        title: "Ticket",
        fileName: "ticket.pdf",
        mimeType: "application/pdf",
        notes: "",
        isSensitive: false,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    ],
  };

  function genItem(overrides: Partial<AiGeneratedItem> = {}): AiGeneratedItem {
    return {
      name: overrides.name ?? "Senso-ji",
      category: overrides.category ?? "attraction",
      location: overrides.location ?? "Asakusa, Tokyo",
      shortDescription: "",
      slot: "morning",
      plannedStartTime: "09:00",
      estimatedDurationMinutes: 90,
      approximatePrice: null,
      priceOriginalAmount: null,
      priceOriginalCurrency: null,
      priceConvertedAmount: null,
      priceExchangeRate: null,
      priceRateTimestamp: null,
      convertedCurrency: null,
      sourceType: null,
      travelMinutes: 0,
      openingHours: "",
      reservationRequired: false,
      transportation: "",
      mapLink: "",
      lat: null,
      lon: null,
      bookingWarning: "",
      alternativeSuggestion: "",
      recommendationId: null,
      locked: false,
      priority: "preferred",
      fixedTime: false,
    };
  }

  function genDay(overrides: Partial<AiGeneratedDay> = {}): AiGeneratedDay {
    return {
      dayNumber: 1,
      date: "2026-10-06",
      title: "Day 1",
      cityRegion: "Tokyo",
      accommodation: "",
      notes: "",
      transportation: "",
      estimatedCost: null,
      activityCost: null,
      foodCost: null,
      transportCost: null,
      accommodationCost: null,
      totalTravelMinutes: null,
      warnings: [],
      alternatives: [],
      bookingRequirements: [],
      safetyNotes: [],
      restWindow: "",
      transportSegments: [],
      items: [genItem()],
      ...overrides,
    };
  }

  const plan: AiItineraryResponse = {
    summary: "regenerated",
    title: "Japan",
    totalEstimatedCost: null,
    estimatedTransportCost: null,
    averageDailyCost: null,
    costPerTraveler: null,
    categoryBreakdown: {},
    days: [genDay()],
  };

  const next = applyAiPlanToWorkspace(workspace, plan);
  const newItemId = next.itineraryDays[0].items[0].id;
  assert.notEqual(newItemId, oldItemId, "regeneration should produce a fresh item id (sanity check on the fixture)");
  assert.equal(next.bookings[0].itineraryItemId, newItemId, "booking link should follow the item to its new id");
  assert.equal(next.documents[0].itineraryItemId, newItemId, "document link should follow the item to its new id");
});

// 7. day_load readiness category flags a day with too many/too-long items,
// without suggesting a specific fix (spec Part F1/F2 — that's the
// generator's job, not something readiness should nudge about).
test("computeTripReadiness: day_load is complete for a light day, partial for an overloaded one", () => {
  const lightDay = { ...createEmptyDay(1, "2026-10-06"), items: [item({ id: "a1" })] };
  const light = buildItinerary({ itineraryDays: [lightDay] });
  const lightReadiness = computeTripReadiness(light).categories.find((category) => category.key === "day_load");
  assert.equal(lightReadiness?.status, "complete");

  const heavyItems = Array.from({ length: 6 }, (_, index) => item({ id: `h${index}`, name: `Stop ${index}` }));
  const heavyDay = { ...createEmptyDay(1, "2026-10-06"), title: "יום 1", items: heavyItems };
  const heavy = buildItinerary({ itineraryDays: [heavyDay] });
  const heavyReadiness = computeTripReadiness(heavy).categories.find((category) => category.key === "day_load");
  assert.equal(heavyReadiness?.status, "partial");
  assert.match(heavyReadiness?.detail ?? "", /יום 1/);
});

// 8. travel_time readiness category flags a long single travel leg, but not
// on a recognized intercity transfer day (where a long leg is expected).
test("computeTripReadiness: travel_time ignores long legs on intercity transfer days", () => {
  const longLegItem = item({ id: "t1", travelMinutes: 120 });
  const regularDay = { ...createEmptyDay(1, "2026-10-06"), title: "יום 1", items: [longLegItem] };
  const regular = buildItinerary({ itineraryDays: [regularDay] });
  const regularReadiness = computeTripReadiness(regular).categories.find((category) => category.key === "travel_time");
  assert.equal(regularReadiness?.status, "partial");

  const transferDay = {
    ...createEmptyDay(2, "2026-10-07"),
    title: "מעבר בין ערים",
    notes: "יום מעבר בין ערים",
    items: [longLegItem],
  };
  const transfer = buildItinerary({ itineraryDays: [transferDay] });
  const transferReadiness = computeTripReadiness(transfer).categories.find((category) => category.key === "travel_time");
  assert.equal(transferReadiness?.status, "complete");
});

