import type { CountryItineraryRecord } from "@/lib/itineraries";
import { bookings } from "@/lib/trip-bookings";
import { createId, getTripDayCount, type PackingCategory, type PackingItem } from "@/lib/trip-workspace";

export function packingList(itinerary: CountryItineraryRecord | null): PackingItem[] {
  return itinerary?.workspaceSnapshot?.packingList ?? [];
}

export function createUserPackingItem(): PackingItem {
  return {
    id: createId("packing"),
    category: "other",
    name: "",
    quantity: 1,
    packed: false,
    required: false,
    source: "user",
    notes: "",
  };
}

// A handful of countries whose main season is inverted relative to the
// northern-hemisphere default — same class of simplification the app
// already accepts elsewhere (one timezone/currency per country).
const SOUTHERN_HEMISPHERE_ISO2 = new Set([
  "AU", "NZ", "AR", "CL", "UY", "PY", "BO", "PE", "ZA", "NA", "BW", "ZW", "MZ", "MG", "FJ", "PG",
]);

type Season = "winter" | "spring" | "summer" | "autumn";

function seasonForMonth(month: number, southern: boolean): Season {
  // month: 1-12, northern-hemisphere mapping, flipped by 6 months for southern.
  const effectiveMonth = southern ? ((month + 5) % 12) + 1 : month;
  if ([12, 1, 2].includes(effectiveMonth)) return "winter";
  if ([3, 4, 5].includes(effectiveMonth)) return "spring";
  if ([6, 7, 8].includes(effectiveMonth)) return "summer";
  return "autumn";
}

function textHasAny(text: string, needles: string[]) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

export interface PackingContext {
  durationDays: number;
  season: Season;
  cold: boolean;
  hot: boolean;
  rainy: boolean;
  hiking: boolean;
  beach: boolean;
  nightlife: boolean;
  formal: boolean;
  spa: boolean;
  hasFlight: boolean;
}

/**
 * Reads real signals off the itinerary — items' names/descriptions/
 * categories, the trip's date range, and any flight booking — rather than
 * guessing. `avgLowC`/`avgHighC`/`rainProbable` are optional real weather
 * data (e.g. from useCountryWeather); when absent, climate is inferred from
 * season alone.
 */
export function buildPackingContext(
  itinerary: CountryItineraryRecord,
  options?: { avgLowC?: number | null; avgHighC?: number | null; rainProbable?: boolean }
): PackingContext {
  const durationDays = getTripDayCount(
    itinerary.startDate ?? "",
    itinerary.endDate ?? "",
    itinerary.itineraryDays.length || 3
  );
  const startMonth = itinerary.startDate ? Number(itinerary.startDate.slice(5, 7)) || 1 : new Date().getMonth() + 1;
  const southern = SOUTHERN_HEMISPHERE_ISO2.has(itinerary.isoA2.toUpperCase());
  const season = seasonForMonth(startMonth, southern);

  const allText = itinerary.itineraryDays
    .flatMap((day) => day.items.map((item) => `${item.name} ${item.shortDescription} ${item.category}`))
    .join(" ");

  const hiking = textHasAny(allText, ["hiking", "hike", "טרק", "מסלול הליכה", "trail", "nature", "טבע"]);
  const beach = textHasAny(allText, ["beach", "חוף", "snorkel", "צלילה", "swim", "שחייה"]);
  const nightlife = textHasAny(allText, ["nightlife", "חיי לילה", "club", "bar", "מועדון"]);
  const formal = textHasAny(allText, ["formal", "אירוע רשמי", "wedding", "חתונה", "gala", "opera", "אופרה", "theater", "תיאטרון"]);
  const spa = textHasAny(allText, ["onsen", "spa", "ספא", "אונסן", "hot spring", "מעיינות חמים"]);

  const tripBookings = bookings(itinerary);
  const hasFlight = tripBookings.some((booking) => booking.type === "flight");

  const cold = options?.avgLowC != null ? options.avgLowC < 10 : season === "winter";
  const hot = options?.avgHighC != null ? options.avgHighC > 26 : season === "summer";
  const rainy = options?.rainProbable ?? (season === "autumn" || season === "spring");

  return { durationDays, season, cold, hot, rainy, hiking, beach, nightlife, formal, spa, hasFlight };
}

interface PackingTemplate {
  key: string;
  category: PackingCategory;
  name: string;
  required: boolean;
  quantity: (context: PackingContext) => number;
  applies: (context: PackingContext) => boolean;
  notes?: string;
}

function laundryAware(days: number, dailyCap: number, minimum = 2) {
  return Math.max(minimum, Math.min(days, dailyCap));
}

const TEMPLATES: PackingTemplate[] = [
  // Documents — always relevant.
  { key: "passport", category: "documents", name: "דרכון", required: true, quantity: () => 1, applies: () => true },
  { key: "tickets", category: "documents", name: "כרטיסי טיסה/הזמנות", required: true, quantity: () => 1, applies: (c) => c.hasFlight },
  { key: "insurance-card", category: "documents", name: "אישור ביטוח נסיעות", required: true, quantity: () => 1, applies: () => true },
  { key: "id-copy", category: "documents", name: "עותק/צילום מסמכים חשובים", required: false, quantity: () => 1, applies: () => true },

  // Clothing — laundry-aware, never "N days = N shirts".
  { key: "underwear", category: "clothing", name: "תחתונים", required: true, quantity: (c) => laundryAware(c.durationDays, 10), applies: () => true },
  { key: "socks", category: "clothing", name: "גרביים", required: true, quantity: (c) => laundryAware(c.durationDays, 10), applies: () => true },
  { key: "tshirts", category: "clothing", name: "חולצות", required: true, quantity: (c) => laundryAware(Math.ceil(c.durationDays / 1.5), 8), applies: () => true },
  { key: "bottoms", category: "clothing", name: "מכנסיים/חצאיות", required: true, quantity: (c) => laundryAware(Math.ceil(c.durationDays / 3), 5), applies: () => true },
  { key: "sleepwear", category: "clothing", name: "בגדי שינה", required: false, quantity: (c) => laundryAware(Math.ceil(c.durationDays / 4), 3, 1), applies: () => true },

  // Weather.
  { key: "warm-layer", category: "weather", name: "שכבת חום (סוודר/מעיל)", required: true, quantity: () => 1, applies: (c) => c.cold },
  { key: "gloves-hat", category: "weather", name: "כפפות וכובע חורף", required: false, quantity: () => 1, applies: (c) => c.cold },
  { key: "rain-protection", category: "weather", name: "מעיל גשם/מטרייה", required: false, quantity: () => 1, applies: (c) => c.rainy },
  { key: "sun-hat", category: "weather", name: "כובע שמש", required: false, quantity: () => 1, applies: (c) => c.hot },
  { key: "sunscreen", category: "weather", name: "קרם הגנה", required: true, quantity: () => 1, applies: (c) => c.hot || c.beach },

  // Outdoor / hiking.
  { key: "hiking-shoes", category: "outdoor", name: "נעלי הליכה/טיולים", required: true, quantity: () => 1, applies: (c) => c.hiking },
  { key: "water-bottle", category: "outdoor", name: "בקבוק מים", required: true, quantity: () => 1, applies: (c) => c.hiking },
  { key: "hiking-layer", category: "outdoor", name: "שכבת ביניים לטיולי הליכה", required: false, quantity: () => 1, applies: (c) => c.hiking },

  // Beach.
  { key: "swimsuit", category: "beach", name: "בגד ים", required: true, quantity: () => 1, applies: (c) => c.beach },
  { key: "sandals", category: "beach", name: "כפכפים/סנדלים", required: false, quantity: () => 1, applies: (c) => c.beach },
  { key: "beach-towel", category: "beach", name: "מגבת חוף", required: false, quantity: () => 1, applies: (c) => c.beach },

  // Formal / nightlife.
  { key: "formal-outfit", category: "formal_nightlife", name: "לבוש מתאים לאירוע רשמי", required: true, quantity: () => 1, applies: (c) => c.formal },
  { key: "nightlife-outfit", category: "formal_nightlife", name: "לבוש לצאת בערב", required: false, quantity: () => 1, applies: (c) => c.nightlife },

  // Special activities — practical reminders only, never a cultural
  // requirement invented from nothing (spec §13).
  {
    key: "onsen-reminder",
    category: "special_activities",
    name: "בדקו מראש כללי התנהגות מקומיים (אונסן/ספא)",
    required: false,
    quantity: () => 1,
    applies: (c) => c.spa,
    notes: "מקומות שונים; כדאי לבדוק את הכללים הספציפיים של המקום מראש.",
  },

  // Shoes / electronics / health / toiletries / travel accessories — base set.
  { key: "everyday-shoes", category: "shoes", name: "נעליים יומיומיות", required: true, quantity: () => 1, applies: () => true },
  { key: "charger", category: "electronics", name: "מטענים", required: true, quantity: () => 1, applies: () => true },
  { key: "adapter", category: "electronics", name: "מתאם שקע", required: true, quantity: () => 1, applies: (c) => c.hasFlight },
  { key: "power-bank", category: "electronics", name: "סוללה ניידת", required: false, quantity: () => 1, applies: () => true },
  { key: "medication", category: "medication", name: "תרופות קבועות", required: false, quantity: () => 1, applies: () => true },
  { key: "first-aid", category: "health", name: "ערכת עזרה ראשונה קטנה", required: false, quantity: () => 1, applies: () => true },
  { key: "toiletries-basic", category: "toiletries", name: "מוצרי טואלטיקה בסיסיים", required: true, quantity: () => 1, applies: () => true },
  { key: "daypack", category: "travel_accessories", name: "תיק יומי", required: false, quantity: () => 1, applies: () => true },
];

/**
 * Deterministic, no AI — reads real trip signals (destination, dates,
 * itinerary content, bookings) into a categorized, duration-scaled list.
 */
export function generatePackingList(
  itinerary: CountryItineraryRecord,
  options?: { avgLowC?: number | null; avgHighC?: number | null; rainProbable?: boolean }
): PackingItem[] {
  const context = buildPackingContext(itinerary, options);
  return TEMPLATES.filter((template) => template.applies(context)).map((template) => ({
    id: createId(`packing-${template.key}`),
    category: template.category,
    name: template.name,
    quantity: Math.max(1, template.quantity(context)),
    packed: false,
    required: template.required,
    source: "automatic",
    notes: template.notes ?? "",
  }));
}

/**
 * User items (source: "user") always survive regeneration untouched.
 * Automatic items are matched by name+category and updated in place
 * (preserving `packed` state); stale automatic items whose trigger no
 * longer applies are simply dropped, mirroring regenerateSmartChecklist's
 * exact merge behavior in trip-checklist.ts.
 */
export function mergeGeneratedPacking(existing: PackingItem[], generated: PackingItem[]): PackingItem[] {
  const userItems = existing.filter((item) => item.source === "user");
  const existingAutoByKey = new Map(
    existing.filter((item) => item.source === "automatic").map((item) => [`${item.category}::${item.name}`, item])
  );

  const mergedAuto = generated.map((item) => {
    const match = existingAutoByKey.get(`${item.category}::${item.name}`);
    return match ? { ...item, id: match.id, packed: match.packed } : item;
  });

  return [...mergedAuto, ...userItems];
}

export interface PackingProgress {
  packed: number;
  total: number;
  percent: number;
}

export function packingProgress(items: PackingItem[]): PackingProgress {
  const total = items.length;
  const packed = items.filter((item) => item.packed).length;
  return { packed, total, percent: total > 0 ? Math.round((packed / total) * 100) : 0 };
}

/**
 * Readiness only cares about required items — optional suggestions never
 * block 100% (spec §16).
 */
export function requiredPackingStatus(items: PackingItem[]): "complete" | "partial" | "missing" | "not_applicable" {
  const required = items.filter((item) => item.required);
  if (required.length === 0) return "not_applicable";
  const packedCount = required.filter((item) => item.packed).length;
  if (packedCount === required.length) return "complete";
  if (packedCount > 0) return "partial";
  return "missing";
}
