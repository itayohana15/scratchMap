import { RECOMMENDATION_CATEGORY_LABELS, type TripItineraryDay, type TripItineraryItem, type TripPreferences } from "@/lib/trip-workspace";

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function sameArea(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normalizedA = a.trim().toLowerCase();
  const normalizedB = b.trim().toLowerCase();
  return normalizedA === normalizedB || normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
}

const SLOT_PHRASING: Partial<Record<TripItineraryItem["slot"], string>> = {
  evening: "מתאים לשעות הערב, אחרי הפעילויות המרכזיות של היום",
  night: "מתאים לשעות הלילה, לסיום רגוע של היום",
  morning: "נבחר לשעות הבוקר, לפני שהעומס והחום עולים",
};

/**
 * Deterministic, data-only "why this is in your itinerary" text — built
 * strictly from facts already present on the item/day/preferences (never an
 * AI call, never an invented specific claim). Reasons are prioritized
 * geography-first (matches how the itinerary is actually generated — see
 * itinerary-generation-constraints.ts's trip-frame logic), then pace/timing,
 * then a stated-interest match. Returns a short 1-2 sentence Hebrew string;
 * falls back to a generic-but-true sentence when nothing specific applies.
 */
export function explainItineraryPlacement(
  item: TripItineraryItem,
  day: TripItineraryDay,
  previousItem: TripItineraryItem | null,
  preferences: TripPreferences
): string {
  const reasons: string[] = [];

  if (previousItem && sameArea(previousItem.location, item.location)) {
    reasons.push(`זה נמצא ממש באזור של "${previousItem.name}", בלי להוסיף נסיעה ארוכה`);
  } else if (day.cityRegion) {
    reasons.push(`זה חלק מהאזור שבו אתם נמצאים ביום זה (${day.cityRegion})`);
  }

  if (item.travelMinutes != null && item.travelMinutes > 0 && item.travelMinutes <= 15) {
    reasons.push(`רק ${item.travelMinutes} דקות מהעצירה הקודמת`);
  }

  const slotPhrase = SLOT_PHRASING[item.slot];
  if (slotPhrase) reasons.push(slotPhrase);

  const interests = splitCommaList(preferences.interests);
  const categoryLabel = RECOMMENDATION_CATEGORY_LABELS[item.category].toLowerCase();
  const matchedInterest = interests.find((interest) => categoryLabel.includes(interest) || interest.includes(categoryLabel));
  if (matchedInterest) {
    reasons.push(`תואם את תחומי העניין שציינתם (${matchedInterest})`);
  }

  if (reasons.length === 0) {
    return "המקום הזה נבחר כדי לשמור על מסלול יום מאוזן ויעיל מבחינת המיקום והזמן.";
  }

  return `בחרנו את המקום הזה כי ${reasons.slice(0, 2).join(", ו")}.`;
}
