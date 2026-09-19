/**
 * Round 9.2.1 — THE centralized meal/cuisine taxonomy (spec §5-9).
 *
 * A sibling to activity-taxonomy.ts, deliberately kept SEPARATE (spec §19
 * "do not collapse these into one category field") — a real place's
 * ACTIVITY classification (family/subtype from activity-taxonomy.ts) and
 * its MEAL classification (cuisine + meal-type suitability, here) answer
 * two different questions and must stay independently readable.
 *
 * Two axes, scored independently (spec §7 "classify venues separately by
 * CUISINE and MEAL-TYPE SUITABILITY"):
 *   - cuisine: what kind of food (multi-label, spec §6 — a place can be
 *     both LOCAL_TRADITIONAL and SEAFOOD, or EAST_ASIAN with subtypes
 *     [japanese, ramen)).
 *   - suitableMealTypes: WHEN this venue is a genuinely good choice
 *     (BREAKFAST/BRUNCH/LUNCH/DINNER/COFFEE_SNACK/DESSERT/LATE_NIGHT) —
 *     never inferred from "it's open" alone (spec §7/§9's whole point).
 *
 * Deterministic and provider/category-backed, exactly like
 * classifyActivity: category baseline -> keyword refinement (multi-label
 * for cuisine, additive for meal types) -> opening-hours-window evidence.
 * No network call, no Gemini call, nothing fabricated — unknown meal
 * suitability stays unknown (spec §8 "If evidence only supports cafe /
 * breakfast / coffee then do NOT claim it serves a full lunch").
 */

import type { RecommendationCategory } from "@/lib/trip-workspace";
import { parseOpeningHoursWindow } from "@/lib/server/opening-hours";

export type CuisineFamily =
  | "LOCAL_TRADITIONAL"
  | "MEDITERRANEAN"
  | "MIDDLE_EASTERN"
  | "EAST_ASIAN"
  | "SOUTH_ASIAN"
  | "SOUTHEAST_ASIAN"
  | "EUROPEAN"
  | "LATIN_AMERICAN"
  | "NORTH_AMERICAN"
  | "AFRICAN"
  | "SEAFOOD"
  | "STEAK_GRILL"
  | "VEGETARIAN_VEGAN"
  | "BAKERY_DESSERT"
  | "CAFE_COFFEE"
  | "FAST_CASUAL"
  | "STREET_FOOD"
  | "FINE_DINING"
  | "OTHER";

export const CUISINE_FAMILIES: CuisineFamily[] = [
  "LOCAL_TRADITIONAL",
  "MEDITERRANEAN",
  "MIDDLE_EASTERN",
  "EAST_ASIAN",
  "SOUTH_ASIAN",
  "SOUTHEAST_ASIAN",
  "EUROPEAN",
  "LATIN_AMERICAN",
  "NORTH_AMERICAN",
  "AFRICAN",
  "SEAFOOD",
  "STEAK_GRILL",
  "VEGETARIAN_VEGAN",
  "BAKERY_DESSERT",
  "CAFE_COFFEE",
  "FAST_CASUAL",
  "STREET_FOOD",
  "FINE_DINING",
  "OTHER",
];

// Extensible by design (spec §5) — a new subtype is a new string literal
// here plus one row in CUISINE_SUBTYPE_KEYWORDS; nothing else changes.
export type CuisineSubtype =
  | "japanese"
  | "sushi"
  | "ramen"
  | "izakaya"
  | "italian"
  | "pizza"
  | "pasta"
  | "mexican"
  | "tacos"
  | "american"
  | "burger"
  | "bbq"
  | "french"
  | "bistro"
  | "chinese"
  | "thai"
  | "vietnamese"
  | "korean"
  | "indian"
  | "greek"
  | "spanish"
  | "turkish"
  | "lebanese"
  | "israeli"
  | "seafood"
  | "steakhouse"
  | "vegan"
  | "vegetarian"
  | "street_food"
  | "generic";

/** Every CuisineSubtype's own family — a subtype can never end up paired with the wrong family (same pattern as activity-taxonomy's SUBTYPE_FAMILY). */
const CUISINE_SUBTYPE_FAMILY: Record<CuisineSubtype, CuisineFamily> = {
  japanese: "EAST_ASIAN", sushi: "EAST_ASIAN", ramen: "EAST_ASIAN", izakaya: "EAST_ASIAN",
  chinese: "EAST_ASIAN", korean: "EAST_ASIAN",
  thai: "SOUTHEAST_ASIAN", vietnamese: "SOUTHEAST_ASIAN",
  indian: "SOUTH_ASIAN",
  italian: "EUROPEAN", pizza: "EUROPEAN", pasta: "EUROPEAN", french: "EUROPEAN", bistro: "EUROPEAN", greek: "MEDITERRANEAN", spanish: "EUROPEAN",
  turkish: "MIDDLE_EASTERN", lebanese: "MIDDLE_EASTERN", israeli: "MIDDLE_EASTERN",
  mexican: "LATIN_AMERICAN", tacos: "LATIN_AMERICAN",
  american: "NORTH_AMERICAN", burger: "NORTH_AMERICAN", bbq: "NORTH_AMERICAN", steakhouse: "STEAK_GRILL",
  seafood: "SEAFOOD",
  vegan: "VEGETARIAN_VEGAN", vegetarian: "VEGETARIAN_VEGAN",
  street_food: "STREET_FOOD",
  generic: "OTHER",
};

/** Multi-label by design (spec §6) — every matching row's family/subtype is collected, never first-match-wins like activity-taxonomy's subtype scan. */
const CUISINE_SUBTYPE_KEYWORDS: Array<{ subtype: CuisineSubtype; keywords: string[] }> = [
  { subtype: "sushi", keywords: ["sushi", "סושי"] },
  { subtype: "ramen", keywords: ["ramen", "ראמן"] },
  { subtype: "izakaya", keywords: ["izakaya"] },
  { subtype: "japanese", keywords: ["japanese", "יפני"] },
  { subtype: "chinese", keywords: ["chinese", "סיני"] },
  { subtype: "korean", keywords: ["korean", "קוריאני"] },
  { subtype: "thai", keywords: ["thai", "תאילנדי"] },
  { subtype: "vietnamese", keywords: ["vietnamese", "pho", "וייטנאמי"] },
  { subtype: "indian", keywords: ["indian", "curry", "הודי"] },
  { subtype: "pizza", keywords: ["pizza", "פיצה"] },
  { subtype: "pasta", keywords: ["pasta", "פסטה"] },
  { subtype: "italian", keywords: ["italian", "trattoria", "איטלקי"] },
  { subtype: "bistro", keywords: ["bistro", "ביסטרו"] },
  { subtype: "french", keywords: ["french", "צרפתי"] },
  { subtype: "greek", keywords: ["greek", "יווני"] },
  { subtype: "spanish", keywords: ["spanish", "tapas", "ספרדי"] },
  { subtype: "turkish", keywords: ["turkish", "טורקי"] },
  { subtype: "lebanese", keywords: ["lebanese", "לבנוני"] },
  { subtype: "israeli", keywords: ["israeli", "ישראלי"] },
  { subtype: "tacos", keywords: ["taco", "tacos", "טאקו"] },
  { subtype: "mexican", keywords: ["mexican", "מקסיקני"] },
  { subtype: "burger", keywords: ["burger", "המבורגר"] },
  { subtype: "bbq", keywords: ["bbq", "barbecue", "smokehouse"] },
  { subtype: "steakhouse", keywords: ["steakhouse", "steak house", "מסעדת סטייקים"] },
  { subtype: "american", keywords: ["american diner", "אמריקאי"] },
  { subtype: "seafood", keywords: ["seafood", "fish restaurant", "פירות ים", "דגים"] },
  { subtype: "vegan", keywords: ["vegan", "טבעוני"] },
  { subtype: "vegetarian", keywords: ["vegetarian", "צמחוני"] },
  { subtype: "street_food", keywords: ["street food", "food stall", "אוכל רחוב"] },
];

export type MealType = "BREAKFAST" | "BRUNCH" | "LUNCH" | "DINNER" | "COFFEE_SNACK" | "DESSERT" | "LATE_NIGHT";

export const MEAL_TYPES: MealType[] = ["BREAKFAST", "BRUNCH", "LUNCH", "DINNER", "COFFEE_SNACK", "DESSERT", "LATE_NIGHT"];

export type MealVenueType = "restaurant" | "cafe" | "bakery" | "bar" | "generic";

export interface MealVenueClassificationInput {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  openingHours?: string | null;
  recommendedTimeOfDay?: import("@/lib/trip-workspace").DayPart | "any" | null;
  approximatePrice?: number | null;
  reservationRequired?: boolean | null;
}

export interface MealVenueClassification {
  venueType: MealVenueType;
  cuisineFamilies: CuisineFamily[];
  cuisineSubtypes: CuisineSubtype[];
  suitableMealTypes: MealType[];
  /** Whether any refining keyword/opening-hours evidence actually narrowed the category baseline, or this is only the generic category default. */
  confidence: "keyword" | "category_fallback";
  /** null unless approximatePrice is a known, non-negative number — never fabricated from name/fame. */
  priceLevel: "budget" | "moderate" | "premium" | null;
}

const HEBREW_CHAR_PATTERN = /[֐-׿]/;

function matchesKeyword(haystack: string, keyword: string): boolean {
  if (keyword.includes(" ") || HEBREW_CHAR_PATTERN.test(keyword)) return haystack.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

function matchesAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => matchesKeyword(haystack, keyword));
}

/** Baseline venue-type + suitableMealTypes purely from the raw provider category (spec §8 "venue type" evidence) — before any keyword/hours refinement. A generic restaurant is plausibly both a lunch and dinner venue absent contrary evidence; a generic cafe is a breakfast/brunch/coffee venue, NEVER lunch by default (spec §2/§9's whole point). */
const CATEGORY_MEAL_BASELINE: Record<string, { venueType: MealVenueType; mealTypes: MealType[] }> = {
  restaurant: { venueType: "restaurant", mealTypes: ["LUNCH", "DINNER"] },
  cafe: { venueType: "cafe", mealTypes: ["BREAKFAST", "BRUNCH", "COFFEE_SNACK"] },
};

/** Keyword-driven meal-type ADJUSTMENTS — additive (`add`) and subtractive (`remove`), applied on top of the category baseline, in table order. Every entry's evidence is explicit text in the name/description, never inferred from fame or price alone (spec §8/§9). */
const MEAL_TYPE_KEYWORD_RULES: Array<{ keywords: string[]; add?: MealType[]; remove?: MealType[]; venueType?: MealVenueType }> = [
  // Bakery/dessert evidence — breakfast/snack/dessert only, never a lunch or dinner venue by default.
  { keywords: ["bakery", "patisserie", "פטיסרי", "מאפייה"], venueType: "bakery", add: ["BREAKFAST", "COFFEE_SNACK", "DESSERT"], remove: ["LUNCH", "DINNER"] },
  { keywords: ["dessert", "ice cream", "gelato", "קינוח", "גלידה"], add: ["DESSERT", "COFFEE_SNACK"] },
  // Brunch evidence (spec §25 test L) — breakfast+brunch baseline; lunch ONLY when the text also explicitly signals an all-day/lunch offering.
  { keywords: ["brunch", "ברנץ'"], add: ["BREAKFAST", "BRUNCH"] },
  { keywords: ["brunch and lunch", "all-day brunch", "brunch & lunch", "ברנץ' וצהריים"], add: ["LUNCH"] },
  // Breakfast-focused evidence (spec §25 test I) — explicitly NOT lunch unless a separate rule below adds it back with real evidence.
  { keywords: ["breakfast", "pancakes", "eggs benedict", "ארוחת בוקר"], add: ["BREAKFAST", "BRUNCH"], remove: ["LUNCH", "DINNER"] },
  // Explicit lunch-service evidence (spec §25 test J) — a cafe/bistro that explicitly advertises lunch/sandwiches/light-lunch service.
  { keywords: ["lunch menu", "sandwiches", "light lunch", "lunch special", "תפריט צהריים", "ארוחת צהריים קלה"], add: ["LUNCH"] },
  // Fine dining / dinner-only evidence (spec §25 test K) — a tasting menu / fine-dining venue is not a casual lunch stop.
  { keywords: ["fine dining", "tasting menu", "dinner only", "reservations for dinner", "מסעדת שף", "ארוחת ערב בלבד"], venueType: "restaurant", add: ["DINNER"], remove: ["LUNCH", "BREAKFAST", "BRUNCH"] },
  // Bar/nightlife-flavored food service (spec §2 "bar used for food/drink", §25 test M) — dinner/late-night only, never breakfast/lunch, regardless of the venue's raw category.
  { keywords: ["bar", "pub", "cocktail", "gastropub", "izakaya bar", "בר", "פאב", "קוקטייל"], venueType: "bar", add: ["DINNER", "LATE_NIGHT"], remove: ["BREAKFAST", "LUNCH", "BRUNCH"] },
  { keywords: ["late night", "after hours", "פתוח עד מאוחר"], add: ["LATE_NIGHT"] },
  { keywords: ["food tour", "culinary experience", "tasting", "סיור קולינרי", "טעימות"], remove: [] }, // food_experience-classified venues are excluded from the meal pool entirely upstream; kept here only as a documentation anchor, not a real rule.
];

function classifyCuisine(haystack: string): { families: CuisineFamily[]; subtypes: CuisineSubtype[] } {
  const subtypes: CuisineSubtype[] = [];
  const families = new Set<CuisineFamily>();
  for (const entry of CUISINE_SUBTYPE_KEYWORDS) {
    if (!matchesAny(haystack, entry.keywords)) continue;
    subtypes.push(entry.subtype);
    families.add(CUISINE_SUBTYPE_FAMILY[entry.subtype]);
  }
  return { families: [...families], subtypes };
}

/**
 * THE authoritative meal-venue classifier (spec §5-9). Deterministic,
 * category/keyword/opening-hours backed — no network or Gemini call.
 * Unknown stays unknown: a venue matching no cuisine keyword gets an empty
 * cuisineFamilies/cuisineSubtypes (never guessed into OTHER); a venue whose
 * meal-type evidence never mentions breakfast/lunch/dinner keeps only its
 * category baseline suitability.
 */
export function classifyMealVenue(input: MealVenueClassificationInput): MealVenueClassification {
  const haystack = `${input.name} ${input.shortDescription}`.toLowerCase();
  const baseline = CATEGORY_MEAL_BASELINE[input.category] ?? { venueType: "generic" as MealVenueType, mealTypes: [] as MealType[] };

  let venueType: MealVenueType = baseline.venueType;
  const mealTypes = new Set<MealType>(baseline.mealTypes);
  let confidence: MealVenueClassification["confidence"] = "category_fallback";

  for (const rule of MEAL_TYPE_KEYWORD_RULES) {
    if (!matchesAny(haystack, rule.keywords)) continue;
    confidence = "keyword";
    if (rule.venueType) venueType = rule.venueType;
    for (const mealType of rule.remove ?? []) mealTypes.delete(mealType);
    for (const mealType of rule.add ?? []) mealTypes.add(mealType);
  }

  // Opening-hours-window evidence (spec §8 "opening-hour pattern") — a real,
  // parseable window can rule a meal type OUT (never fabricate one IN just
  // because the venue happens to be open at that hour, spec §9's own
  // explicit warning). Only applied when a window actually parses.
  const window = input.openingHours ? parseOpeningHoursWindow(input.openingHours) : null;
  if (window) {
    const opensAfternoon = window.opensMinutes >= 15 * 60;
    const opensLate = window.opensMinutes >= 11 * 60;
    const closesEarly = window.closesMinutes <= 15 * 60;
    const closesBeforeEvening = window.closesMinutes <= 17 * 60;
    if (opensLate) mealTypes.delete("BREAKFAST");
    if (opensAfternoon) {
      mealTypes.delete("BREAKFAST");
      mealTypes.delete("BRUNCH");
      mealTypes.delete("LUNCH");
    }
    if (closesEarly) {
      mealTypes.delete("DINNER");
      mealTypes.delete("LATE_NIGHT");
    } else if (closesBeforeEvening) {
      mealTypes.delete("LATE_NIGHT");
    }
  }

  // recommendedTimeOfDay, when the caller genuinely has one (never "any") —
  // an explicit provider/curator signal, treated as real evidence exactly
  // like activity-taxonomy's own suitableTimeOfDay handling.
  if (input.recommendedTimeOfDay === "lunch") mealTypes.add("LUNCH");
  if (input.recommendedTimeOfDay === "dinner") mealTypes.add("DINNER");

  const { families: cuisineFamilies, subtypes: cuisineSubtypes } = classifyCuisine(haystack);

  return {
    venueType,
    cuisineFamilies,
    cuisineSubtypes,
    suitableMealTypes: [...mealTypes],
    confidence,
    priceLevel: input.approximatePrice == null ? null : input.approximatePrice <= 25 ? "budget" : input.approximatePrice <= 70 ? "moderate" : "premium",
  };
}

/**
 * Round 9.2.1 §12/§13 — maps the trip's OWN preference keywords onto
 * cuisine families, exactly like activity-taxonomy's
 * buildPreferenceFamilyWeights (same generic keyword->family pattern, same
 * "never eliminate, only boost" rule — spec §14 "do not reintroduce
 * removed/unsupported preference concepts").
 */
const CUISINE_PREFERENCE_KEYWORDS: Array<{ family: CuisineFamily; keywords: string[] }> = [
  { family: "EAST_ASIAN", keywords: ["japanese", "sushi", "chinese", "korean", "asian food", "יפני", "סושי", "סיני"] },
  { family: "SOUTHEAST_ASIAN", keywords: ["thai", "vietnamese", "תאילנדי"] },
  { family: "SOUTH_ASIAN", keywords: ["indian", "curry", "הודי"] },
  { family: "MEDITERRANEAN", keywords: ["mediterranean", "greek", "ים תיכוני", "יווני"] },
  { family: "MIDDLE_EASTERN", keywords: ["middle eastern", "lebanese", "israeli food", "מזרח תיכוני", "לבנוני"] },
  { family: "EUROPEAN", keywords: ["italian", "french", "pasta", "pizza", "איטלקי", "צרפתי"] },
  { family: "LATIN_AMERICAN", keywords: ["mexican", "tacos", "latin", "מקסיקני"] },
  { family: "NORTH_AMERICAN", keywords: ["american", "burger", "bbq", "אמריקאי", "המבורגר"] },
  { family: "SEAFOOD", keywords: ["seafood", "fish", "פירות ים", "דגים"] },
  { family: "STEAK_GRILL", keywords: ["steak", "grill", "סטייק"] },
  { family: "VEGETARIAN_VEGAN", keywords: ["vegan", "vegetarian", "plant-based", "טבעוני", "צמחוני"] },
  { family: "LOCAL_TRADITIONAL", keywords: ["local food", "local cuisine", "traditional food", "אוכל מקומי", "מסורתי"] },
  { family: "STREET_FOOD", keywords: ["street food", "אוכל רחוב"] },
  { family: "FINE_DINING", keywords: ["fine dining", "gourmet", "מסעדת שף"] },
];

export function buildCuisinePreferenceWeights(preferenceTexts: string[]): Record<CuisineFamily, number> {
  const weights = Object.fromEntries(CUISINE_FAMILIES.map((family) => [family, 1])) as Record<CuisineFamily, number>;
  const combined = preferenceTexts.join(" ").toLowerCase();
  if (!combined.trim()) return weights;

  for (const { family, keywords } of CUISINE_PREFERENCE_KEYWORDS) {
    if (matchesAny(combined, keywords)) weights[family] += 0.5;
  }
  return weights;
}
