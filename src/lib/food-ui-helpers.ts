// Pure, client-safe food-selection/insertion/removal helpers (browser QA
// Parts X-Y) — mirrors hotel-ui-helpers.ts's own pattern: kept in their
// own module (type-only import of RankedFoodPlace, no runtime import of
// src/lib/food.ts's server-only Overpass dependency) so client components
// never pull that in just to use this logic.
import type { FoodMealSlot, RankedFoodPlace } from "@/lib/food";
import {
  createEmptyItineraryItem,
  estimateTravelMinutes,
  slotTime,
  type DayPart,
  type TripItineraryDay,
  type TripItineraryItem,
} from "@/lib/trip-workspace";

const SLOT_TO_DAY_PART: Record<FoodMealSlot, DayPart> = {
  breakfast: "morning",
  lunch: "lunch",
  dinner: "dinner",
  cafe: "afternoon",
};

const DAY_PART_TO_SLOT: Partial<Record<DayPart, FoodMealSlot>> = {
  morning: "breakfast",
  lunch: "lunch",
  afternoon: "cafe",
  dinner: "dinner",
};

const SLOT_MEAL_LABEL: Record<FoodMealSlot, string> = {
  breakfast: "ארוחת בוקר",
  lunch: "ארוחת צהריים",
  dinner: "ארוחת ערב",
  cafe: "הפסקת קפה",
};

/**
 * A "meal opportunity" — a recommended meal TIME WINDOW, never an invented
 * business (spec Part O). Same isRealPlace signal as the server-side
 * fallback placeholder (isMealOpportunityMarker in trip-workspace.ts): no
 * recommendationId, no coordinates, no price. Used both as the initial
 * client-side building block and to restore the slot after a real
 * selection is removed (spec Part S).
 */
export function buildMealOpportunityItem(day: TripItineraryDay, slot: FoodMealSlot): TripItineraryItem {
  const dayPart = SLOT_TO_DAY_PART[slot];
  const base = createEmptyItineraryItem(dayPart);
  const area = day.cityRegion.trim();
  return {
    ...base,
    name: area ? `🍽 זמן מומלץ ל${SLOT_MEAL_LABEL[slot]} באזור ${area}` : `🍽 זמן מומלץ ל${SLOT_MEAL_LABEL[slot]}`,
    category: slot === "dinner" ? "restaurant" : "cafe",
    shortDescription: `זהו חלון זמן מומלץ ל${SLOT_MEAL_LABEL[slot]} — לא מסעדה קונקרטית. אפשר לבחור מסעדה אמיתית וקרובה בלשונית "אוכל".`,
    plannedStartTime: slotTime(dayPart),
    openingHours: "לא זמין",
    recommendationId: null,
    canonicalPlaceId: "",
    approximatePrice: null,
    // No real coordinates -> no map marker, no route participation (spec
    // Part T/22): a meal opportunity is a timeline slot, not a route stop.
    lat: null,
    lon: null,
    travelMinutes: null,
    mapLink: "",
  };
}

/**
 * A real selected place becomes a real timeline item (spec §X/§AB) — a
 * stable synthetic id from name+coordinates (Overpass has no place id of
 * its own), since nothing else uniquely identifies a real, unbooked POI.
 */
export function buildFoodItemFromPlace(place: RankedFoodPlace, slot: FoodMealSlot): TripItineraryItem {
  const dayPart = SLOT_TO_DAY_PART[slot];
  const base = createEmptyItineraryItem(dayPart);
  return {
    ...base,
    recommendationId: `osm:${place.category}:${place.lat.toFixed(5)}:${place.lon.toFixed(5)}`,
    canonicalPlaceId: `coords:${place.lat.toFixed(3)}:${place.lon.toFixed(3)}`,
    name: place.name,
    category: place.category === "dessert" ? "cafe" : place.category,
    plannedStartTime: slotTime(dayPart),
    estimatedDurationMinutes: slot === "cafe" ? 45 : 75,
    openingHours: place.openingHours ?? "",
    travelMinutes: place.travelMinutesFromRoute,
    lat: place.lat,
    lon: place.lon,
    mapLink: `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`,
  };
}

export interface FoodInsertionResult {
  day: TripItineraryDay;
  /** True when the inserted item's real interval overlaps a neighboring item — spec §Y: surfaced, never silently dropped. */
  timelineConflict: boolean;
}

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Inserts a real selected restaurant into the day, recalculating travel
 * to/from its real neighbors by actual clock order (spec §X) — replaces
 * an existing item in the SAME slot when one is already there (a generic
 * placeholder or a previous selection for that meal), never duplicates
 * the meal. Detects — but never silently resolves — a real timeline
 * collision with a neighboring item (spec §Y: "show a clear conflict").
 */
export function insertFoodItemIntoDay(day: TripItineraryDay, place: RankedFoodPlace, slot: FoodMealSlot): FoodInsertionResult {
  const dayPart = SLOT_TO_DAY_PART[slot];
  const newItem = buildFoodItemFromPlace(place, slot);

  const withoutSameSlot = day.items.filter((item) => item.slot !== dayPart || item.locked || item.fixedTime);
  const removedFromSlot = day.items.find((item) => item.slot === dayPart && !item.locked && !item.fixedTime);

  const ordered = [...withoutSameSlot, newItem].sort((left, right) => {
    const leftMinutes = parseMinutes(left.plannedStartTime) ?? 0;
    const rightMinutes = parseMinutes(right.plannedStartTime) ?? 0;
    return leftMinutes - rightMinutes;
  });

  const newIndex = ordered.indexOf(newItem);
  const previous = ordered[newIndex - 1] ?? null;
  const next = ordered[newIndex + 1] ?? null;

  if (previous?.lat != null && previous.lon != null) {
    newItem.travelMinutes = estimateTravelMinutes(previous.lat, previous.lon, newItem.lat, newItem.lon, "balanced", "");
  } else if (removedFromSlot?.travelMinutes != null) {
    newItem.travelMinutes = removedFromSlot.travelMinutes;
  }

  const startMinutes = parseMinutes(newItem.plannedStartTime) ?? 0;
  const endMinutes = startMinutes + (newItem.estimatedDurationMinutes ?? 60);
  newItem.endTime = formatMinutes(endMinutes);

  let timelineConflict = false;
  if (previous?.endTime) {
    const previousEnd = parseMinutes(previous.endTime);
    if (previousEnd != null && previousEnd > startMinutes) timelineConflict = true;
  }
  if (next?.plannedStartTime) {
    const nextStart = parseMinutes(next.plannedStartTime);
    if (nextStart != null && nextStart < endMinutes) timelineConflict = true;
  }

  return { day: { ...day, items: ordered }, timelineConflict };
}

/**
 * Removes a previously-selected real restaurant from the day and restores
 * the meal opportunity in its place (spec Part S) — no itinerary
 * regeneration needed, purely a local data patch like every other food
 * operation. If the removed item's slot isn't a recognized meal dayPart
 * (e.g. it was moved to a non-meal slot by some other edit), the slot is
 * simply left empty rather than guessing.
 */
export function removeFoodItemFromDay(day: TripItineraryDay, itemId: string): TripItineraryDay {
  const removed = day.items.find((item) => item.id === itemId);
  const withoutItem = day.items.filter((item) => item.id !== itemId);
  const slot = removed ? DAY_PART_TO_SLOT[removed.slot] : undefined;
  if (!removed || !slot) return { ...day, items: withoutItem };

  const opportunity = buildMealOpportunityItem(day, slot);
  const items = [...withoutItem, opportunity].sort(
    (left, right) => (parseMinutes(left.plannedStartTime) ?? 0) - (parseMinutes(right.plannedStartTime) ?? 0)
  );
  return { ...day, items };
}
