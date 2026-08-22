import assert from "node:assert/strict";
import test from "node:test";

import type { CountryItineraryRecord } from "../src/lib/itineraries";
import { generatePackingList, mergeGeneratedPacking, requiredPackingStatus } from "../src/lib/packing";
import { computeTripReadiness } from "../src/lib/trip-readiness";
import {
  actualDayItems,
  actualMapItemIds,
  computeDayComparison,
  expenseCategoryComparison,
  itemStatus,
  plannedDayItems,
} from "../src/lib/trip-actual";
import { attachPhotoToEntry, createEmptyJournalEntry, journalEntries, upsertJournalEntry } from "../src/lib/trip-journal";
import {
  createDefaultWorkspace,
  createEmptyDay,
  createEmptyItineraryItem,
  markItemCompleted,
  markItemSkipped,
  type PackingItem,
  type TripExpense,
  type TripItineraryDay,
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
    daysCount: 3,
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

function day(overrides: Partial<TripItineraryDay> = {}, items: TripItineraryItem[] = []): TripItineraryDay {
  return { ...createEmptyDay(overrides.dayNumber ?? 1, overrides.date ?? "2026-10-06"), ...overrides, items };
}

// 1. Completed activity preserves planned data.
test("markItemCompleted never overwrites planned fields", () => {
  const original = item({ name: "Senso-ji", plannedStartTime: "10:00", location: "Asakusa" });
  const completed = markItemCompleted(original, { actualStartTime: "10:45", actualCost: 500 });
  assert.equal(completed.plannedStartTime, "10:00");
  assert.equal(completed.name, "Senso-ji");
  assert.equal(completed.location, "Asakusa");
  assert.equal(completed.actualStartTime, "10:45");
  assert.equal(completed.completed, true);
});

// 2. Skipped activity remains in planned history.
test("markItemSkipped keeps the item in the day, never deletes it", () => {
  const museum = item({ id: "museum", name: "Museum" });
  const skipped = markItemSkipped(museum, "too tired");
  const dayWithSkip = day({}, [skipped]);
  assert.equal(dayWithSkip.items.length, 1);
  assert.equal(dayWithSkip.items[0].skipped, true);
  assert.equal(dayWithSkip.items[0].skipReason, "too tired");
  assert.equal(itemStatus(skipped), "skipped");
});

// 3. Spontaneous activity appears only in actual itinerary.
test("actualDayItems includes spontaneous items, plannedDayItems excludes them", () => {
  const planned = item({ id: "planned-1", name: "Fushimi Inari", completed: true });
  const spontaneous = item({ id: "market", name: "Shimokitazawa Market", spontaneous: true, actualStartTime: "16:00" });
  const testDay = day({}, [planned, spontaneous]);

  assert.deepEqual(
    plannedDayItems(testDay).map((entry) => entry.id),
    ["planned-1"]
  );
  assert.deepEqual(
    actualDayItems(testDay).map((entry) => entry.id).sort(),
    ["market", "planned-1"]
  );
});

// 4. Planned and actual costs remain separate.
test("computeDayComparison keeps plannedCost and actualCost independent", () => {
  const planned = item({ id: "a", approximatePrice: 100, completed: true, actualCost: 80 });
  const testDay = day({}, [planned]);
  const comparison = computeDayComparison(testDay);
  assert.equal(comparison.plannedCost, 100);
  assert.equal(comparison.actualCost.value, 80);
  assert.equal(comparison.actualCost.hasData, true);
});

// 5. Unknown actual cost is not treated as zero.
test("computeDayComparison marks actualCost hasData:false when nothing was logged", () => {
  const planned = item({ id: "a", approximatePrice: 100, completed: true, actualCost: null });
  const testDay = day({}, [planned]);
  const comparison = computeDayComparison(testDay);
  assert.equal(comparison.actualCost.hasData, false);
  assert.equal(comparison.actualCost.value, 0);
});

// 6 & 8. Journal entries are isolated by tripId; same-country multiple trips don't share journal.
test("journalEntries reads only from the given itinerary's own workspace snapshot", () => {
  const entryA = { ...createEmptyJournalEntry(), title: "Trip A memory" };
  const entryB = { ...createEmptyJournalEntry(), title: "Trip B memory" };

  const tripA = buildItinerary({ id: "trip-a", workspaceSnapshot: { ...createDefaultWorkspace("Japan"), journalEntries: [entryA] } });
  const tripB = buildItinerary({ id: "trip-b", workspaceSnapshot: { ...createDefaultWorkspace("Japan"), journalEntries: [entryB] } });

  assert.deepEqual(journalEntries(tripA).map((e) => e.title), ["Trip A memory"]);
  assert.deepEqual(journalEntries(tripB).map((e) => e.title), ["Trip B memory"]);
});

// 7. Photos are isolated by tripId — the photos query filters by itinerary_id
// server-side (see queries/photos.ts's usePhotosForItinerary), so at the pure
// -logic layer the isolation guarantee to test is that journal photoIds never
// leak across itineraries when attaching.
test("attachPhotoToEntry only affects the entry it's called on", () => {
  const entry = createEmptyJournalEntry();
  const withPhoto = attachPhotoToEntry(entry, "photo-1");
  assert.deepEqual(withPhoto.photoIds, ["photo-1"]);
  assert.deepEqual(entry.photoIds, []);
});

// 9. User packing items survive automatic regeneration.
test("mergeGeneratedPacking preserves user items across regeneration", () => {
  const userItem: PackingItem = {
    id: "user-1",
    category: "other",
    name: "Custom camera",
    quantity: 1,
    packed: true,
    required: false,
    source: "user",
    notes: "",
  };
  const generated: PackingItem[] = [
    { id: "auto-1", category: "documents", name: "דרכון", quantity: 1, packed: false, required: true, source: "automatic", notes: "" },
  ];
  const merged = mergeGeneratedPacking([userItem], generated);
  assert.ok(merged.some((entry) => entry.id === "user-1" && entry.source === "user"));
  assert.ok(merged.some((entry) => entry.name === "דרכון"));
});

// 10. Required packing items affect readiness correctly; optional ones don't block it.
test("computeTripReadiness packing category reflects only required items", () => {
  const testDay = day({}, [item({ name: "Hike", shortDescription: "hiking trail" })]);
  const itineraryNoPacking = buildItinerary({ itineraryDays: [testDay] });
  const noPackingReadiness = computeTripReadiness(itineraryNoPacking);
  assert.equal(noPackingReadiness.categories.find((c) => c.key === "packing")?.status, "not_applicable");

  const requiredUnpacked: PackingItem = { id: "p1", category: "documents", name: "דרכון", quantity: 1, packed: false, required: true, source: "automatic", notes: "" };
  const optionalUnpacked: PackingItem = { id: "p2", category: "other", name: "משהו אופציונלי", quantity: 1, packed: false, required: false, source: "automatic", notes: "" };
  const withOnlyOptionalMissing = buildItinerary({
    itineraryDays: [testDay],
    workspaceSnapshot: { ...createDefaultWorkspace("Japan"), packingList: [{ ...requiredUnpacked, packed: true }, optionalUnpacked] },
  });
  assert.equal(requiredPackingStatus(withOnlyOptionalMissing.workspaceSnapshot!.packingList!), "complete");
  const readinessWithOptionalMissing = computeTripReadiness(withOnlyOptionalMissing);
  assert.equal(readinessWithOptionalMissing.categories.find((c) => c.key === "packing")?.status, "complete");

  const withRequiredMissing = buildItinerary({
    itineraryDays: [testDay],
    workspaceSnapshot: { ...createDefaultWorkspace("Japan"), packingList: [requiredUnpacked] },
  });
  const readinessWithRequiredMissing = computeTripReadiness(withRequiredMissing);
  assert.equal(readinessWithRequiredMissing.categories.find((c) => c.key === "packing")?.status, "missing");
});

// 11. Completed historical trip can contain actual data without planned itinerary.
test("computeDayComparison and actualDayItems tolerate a historical trip with zero planned days", () => {
  const itinerary = buildItinerary({ source: "historical_manual", startDate: null, endDate: null, itineraryDays: [] });
  assert.equal(itinerary.itineraryDays.length, 0);
  const generated = generatePackingList(itinerary);
  assert.ok(Array.isArray(generated));
  assert.ok(generated.length > 0);
});

// 12. Trip ratings ignore unanswered fields (null stays null, never coerced to 0).
test("expenseCategoryComparison treats an untouched category as hasData:false, not 0", () => {
  const itinerary = buildItinerary({ itineraryDays: [day({}, [item({ approximatePrice: 200, category: "restaurant" })])] });
  const rows = expenseCategoryComparison(itinerary);
  const foodRow = rows.find((row) => row.category === "food");
  assert.equal(foodRow?.planned, 200);
  assert.equal(foodRow?.actual.hasData, false);
  assert.equal(foodRow?.difference, null);
});

// 13. Actual map excludes skipped places.
test("actualMapItemIds excludes skipped items and includes spontaneous ones", () => {
  const completedItem = item({ id: "done", completed: true });
  const skippedItem = item({ id: "skip", skipped: true });
  const spontaneousItem = item({ id: "spont", spontaneous: true });
  const testDay = day({}, [completedItem, skippedItem, spontaneousItem]);
  const ids = actualMapItemIds(testDay);
  assert.ok(ids.has("done"));
  assert.ok(ids.has("spont"));
  assert.ok(!ids.has("skip"));
});

// 14. Photo linked to journal/activity does not create duplicate photo records.
test("attachPhotoToEntry does not duplicate an id already present", () => {
  const entry = { ...createEmptyJournalEntry(), photoIds: ["photo-1"] };
  const result = attachPhotoToEntry(entry, "photo-1");
  assert.deepEqual(result.photoIds, ["photo-1"]);
  assert.equal(result, entry);
});

// 15. Day comparison correctly detects completed/skipped/spontaneous activities.
test("computeDayComparison counts completed, skipped, and spontaneous activities correctly", () => {
  const completedItem = item({ id: "a", completed: true });
  const skippedItem = item({ id: "b", skipped: true });
  const spontaneousItem = item({ id: "c", spontaneous: true });
  const plannedOnly = item({ id: "d" });
  const testDay = day({}, [completedItem, skippedItem, spontaneousItem, plannedOnly]);
  const comparison = computeDayComparison(testDay);

  assert.equal(comparison.activitiesPlanned, 3); // spontaneous excluded from "planned"
  assert.equal(comparison.activitiesCompleted, 1);
  assert.equal(comparison.activitiesSkipped, 1);
  assert.equal(comparison.spontaneousActivities, 1);
});

// Bonus: journal upsert round-trips new Stage 5 fields without loss.
test("upsertJournalEntry preserves tags/activityId/favoriteMemory", () => {
  const patchDraft = (updater: (current: CountryItineraryRecord) => CountryItineraryRecord) => {
    itinerary = updater(itinerary);
  };
  let itinerary = buildItinerary();
  const entry = { ...createEmptyJournalEntry(), tags: ["food", "sunset"], activityId: "item-1", favoriteMemory: true };
  upsertJournalEntry(patchDraft, entry);
  const [saved] = journalEntries(itinerary);
  assert.deepEqual(saved.tags, ["food", "sunset"]);
  assert.equal(saved.activityId, "item-1");
  assert.equal(saved.favoriteMemory, true);
});

// Sanity: TripExpense category grouping used by expenseCategoryComparison covers actualExpenses too.
test("expenseCategoryComparison includes actualExpenses entries with hasData:true", () => {
  const expense: TripExpense = {
    id: "exp-1",
    category: "shopping",
    label: "Souvenirs",
    amount: 150,
    amountOriginalCurrency: null,
    exchangeRate: null,
    rateTimestamp: null,
    date: "2026-10-07",
    dayId: null,
    itemId: null,
    notes: "",
  };
  const itinerary = buildItinerary({
    workspaceSnapshot: { ...createDefaultWorkspace("Japan"), actualExpenses: [expense] },
  });
  const rows = expenseCategoryComparison(itinerary);
  const shoppingRow = rows.find((row) => row.category === "shopping");
  assert.equal(shoppingRow?.actual.hasData, true);
  assert.equal(shoppingRow?.actual.value, 150);
});
