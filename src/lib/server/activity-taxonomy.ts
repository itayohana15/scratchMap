/**
 * Round 9 — THE centralized semantic activity taxonomy (spec §5-7). The
 * existing raw RecommendationCategory ("attraction", "nature", "shopping",
 * ...) is too coarse for portfolio diversity: an "attraction" can be a
 * monument, a viewpoint, or an interactive experience; a "nature" item can
 * be a beach, a hike, or a national park — treating them as interchangeable
 * is exactly what let four generic "attraction" days feel identical.
 *
 * Classification is deterministic and provider/category-backed — no
 * network call, no Gemini call, nothing fabricated. A candidate's raw
 * `category` gives a baseline family/subtype (the CATEGORY_BASELINE table
 * below); a keyword scan over its own name/description then refines that
 * baseline when the text clearly indicates a more specific subtype (a
 * "market" refines a `shopping`-category item toward LOCAL_EXPERIENCE with
 * SHOPPING/FOOD as secondary families, matching spec §6's own example).
 * Nothing here ever needs a live provider call — it works purely from
 * fields the pipeline already has (category + name + shortDescription).
 *
 * Unknown stays unknown: a candidate that matches no refining keyword keeps
 * its category-baseline classification with `confidence: "category_fallback"`
 * rather than being guessed into a more specific subtype; a candidate whose
 * raw category itself has no taxonomy mapping gets `OTHER`/`generic`
 * (never silently coerced into some other family).
 */

import { classifyItemEnergy, classifyWeatherSensitivity, type EnergyLevel, type WeatherSensitivity } from "@/lib/server/itinerary-planning-principles";
import type { DayPart, RecommendationCategory } from "@/lib/trip-workspace";

export type ActivityFamily =
  | "CULTURE"
  | "LANDMARK"
  | "ENTERTAINMENT"
  | "NATURE"
  | "LOCAL_EXPERIENCE"
  | "SHOPPING"
  | "FOOD"
  | "OTHER";

// Extensible by design (spec §5's own instruction) — a new subtype is a new
// string literal in this union plus one row in SUBTYPE_KEYWORDS/SUBTYPE_FAMILY;
// nothing else needs to change.
export type ActivitySubtype =
  | "art_museum"
  | "history_museum"
  | "science_museum"
  | "architecture"
  | "historic_site"
  | "religious_cultural_site"
  | "performing_arts"
  | "iconic_landmark"
  | "monument"
  | "famous_building"
  | "viewpoint"
  | "theme_park"
  | "amusement_park"
  | "zoo"
  | "aquarium"
  | "interactive_experience"
  | "studio_tour"
  | "sports"
  | "nightlife"
  | "live_entertainment"
  | "urban_park"
  | "botanical_garden"
  | "beach"
  | "mountain"
  | "hiking"
  | "waterfall"
  | "lake"
  | "river"
  | "national_state_park"
  | "wildlife"
  | "scenic_drive"
  | "scenic_viewpoint"
  | "neighborhood"
  | "market"
  | "food_market"
  | "street_art"
  | "cultural_district"
  | "local_workshop"
  | "local_experience"
  | "shopping_district"
  | "mall"
  | "outlet"
  | "specialty_market"
  | "restaurant"
  | "cafe"
  | "bakery"
  | "bar"
  | "food_experience"
  | "generic"; // OTHER's only subtype — spec §5 "only when genuinely unclassifiable"

export interface ActivityClassificationInput {
  category: RecommendationCategory;
  name: string;
  shortDescription: string;
  /** Present only when the caller genuinely knows it (never guessed). */
  reservationRequired?: boolean | null;
  approximatePrice?: number | null;
  /** TripRecommendation's own field, when the caller has one. */
  recommendedTimeOfDay?: DayPart | "any" | null;
}

export interface ActivityClassificationMetadata {
  indoorOutdoor: WeatherSensitivity; // "indoor" | "outdoor" | "mixed" — never actually unknown, classifyWeatherSensitivity always resolves to one of the three (its own "mixed" IS its honest default)
  energyLevel: EnergyLevel;
  /** null when the caller supplied no recommendedTimeOfDay signal, or it was "any". */
  suitableTimeOfDay: DayPart[] | null;
  /** null unless approximatePrice is a known, non-negative number. */
  paidFree: "paid" | "free" | null;
  /** null unless a subtype/category heuristic or explicit signal makes this knowable. */
  familyRelevant: boolean | null;
  eveningNightlifeSuitable: boolean | null;
  /** null unless the caller supplied an explicit reservationRequired (true OR false — both are "known", only omission is unknown). */
  bookingSensitive: boolean | null;
}

export interface ActivityClassification {
  primaryFamily: ActivityFamily;
  subtype: ActivitySubtype;
  secondaryFamilies: ActivityFamily[];
  /** Whether a refining keyword actually matched, or the classification is only the raw-category baseline. */
  confidence: "keyword" | "category_fallback";
  metadata: ActivityClassificationMetadata;
}

/** Deterministic baseline before any keyword refinement — every RecommendationCategory maps to exactly one row. Categories that are never scheduled as a real "activity" (hotel/transportation/practical) still get a harmless OTHER/generic row so this table stays total. */
const CATEGORY_BASELINE: Record<RecommendationCategory, { family: ActivityFamily; subtype: ActivitySubtype }> = {
  attraction: { family: "LANDMARK", subtype: "iconic_landmark" },
  restaurant: { family: "FOOD", subtype: "restaurant" },
  cafe: { family: "FOOD", subtype: "cafe" },
  museum: { family: "CULTURE", subtype: "history_museum" },
  nature: { family: "NATURE", subtype: "urban_park" },
  shopping: { family: "SHOPPING", subtype: "shopping_district" },
  nightlife: { family: "ENTERTAINMENT", subtype: "nightlife" },
  family: { family: "ENTERTAINMENT", subtype: "interactive_experience" },
  hidden_gem: { family: "LOCAL_EXPERIENCE", subtype: "local_experience" },
  day_trip: { family: "NATURE", subtype: "scenic_drive" },
  seasonal_event: { family: "ENTERTAINMENT", subtype: "live_entertainment" },
  hotel: { family: "OTHER", subtype: "generic" },
  transportation: { family: "OTHER", subtype: "generic" },
  practical: { family: "OTHER", subtype: "generic" },
};

/** Every ActivitySubtype's own primary family — the authoritative source SUBTYPE_KEYWORDS/CATEGORY_BASELINE both draw from, so a subtype can never end up paired with the wrong family. */
const SUBTYPE_FAMILY: Record<ActivitySubtype, ActivityFamily> = {
  art_museum: "CULTURE", history_museum: "CULTURE", science_museum: "CULTURE", architecture: "CULTURE",
  historic_site: "CULTURE", religious_cultural_site: "CULTURE", performing_arts: "CULTURE",
  iconic_landmark: "LANDMARK", monument: "LANDMARK", famous_building: "LANDMARK", viewpoint: "LANDMARK",
  theme_park: "ENTERTAINMENT", amusement_park: "ENTERTAINMENT", zoo: "ENTERTAINMENT", aquarium: "ENTERTAINMENT",
  interactive_experience: "ENTERTAINMENT", studio_tour: "ENTERTAINMENT", sports: "ENTERTAINMENT",
  nightlife: "ENTERTAINMENT", live_entertainment: "ENTERTAINMENT",
  urban_park: "NATURE", botanical_garden: "NATURE", beach: "NATURE", mountain: "NATURE", hiking: "NATURE",
  waterfall: "NATURE", lake: "NATURE", river: "NATURE", national_state_park: "NATURE", wildlife: "NATURE",
  scenic_drive: "NATURE", scenic_viewpoint: "NATURE",
  neighborhood: "LOCAL_EXPERIENCE", market: "LOCAL_EXPERIENCE", food_market: "LOCAL_EXPERIENCE",
  street_art: "LOCAL_EXPERIENCE", cultural_district: "LOCAL_EXPERIENCE", local_workshop: "LOCAL_EXPERIENCE",
  local_experience: "LOCAL_EXPERIENCE",
  shopping_district: "SHOPPING", mall: "SHOPPING", outlet: "SHOPPING", specialty_market: "SHOPPING",
  restaurant: "FOOD", cafe: "FOOD", bakery: "FOOD", bar: "FOOD", food_experience: "FOOD",
  generic: "OTHER",
};

/**
 * Refining keyword sets, checked in table order (first match wins) against
 * `${name} ${shortDescription}` — bilingual (English + Hebrew) since this
 * app's own content is Hebrew-first, matching the existing keyword-scan
 * convention in classifyVisitScale/classifyItemEnergy/classifyWeatherSensitivity.
 * `secondary` lists the taxonomy's own documented multi-family examples
 * (spec §6: "market: primaryFamily = LOCAL_EXPERIENCE, secondary = SHOPPING/FOOD").
 * Order matters: a more specific subtype (e.g. "food_market") is listed
 * before its more general sibling ("market") so it wins the first-match scan.
 */
const SUBTYPE_KEYWORDS: Array<{ subtype: ActivitySubtype; secondary?: ActivityFamily[]; keywords: string[] }> = [
  // CULTURE
  { subtype: "art_museum", keywords: ["art museum", "gallery", "מוזיאון אמנות", "גלריה"] },
  { subtype: "science_museum", keywords: ["science museum", "planetarium", "aquarium of science", "מוזיאון מדע"] },
  { subtype: "history_museum", keywords: ["history museum", "national museum", "מוזיאון היסטוריה", "מוזיאון לאומי"] },
  { subtype: "architecture", keywords: ["architecture", "cathedral", "basilica", "אדריכלות", "קתדרלה"] },
  { subtype: "religious_cultural_site", keywords: ["temple", "shrine", "synagogue", "mosque", "church", "מקדש", "בית כנסת", "מסגד", "כנסייה"] },
  { subtype: "performing_arts", keywords: ["opera", "theater", "theatre", "concert hall", "אופרה", "תיאטרון"] },
  // "old town" deliberately excluded — too ambiguous as a standalone
  // keyword ("Old Town Market", "Old Town Square" name a market/plaza, not
  // a historic SITE per se); "historic"/"heritage" are unambiguous.
  { subtype: "historic_site", keywords: ["historic", "heritage", "היסטורי", "עיר עתיקה"] },
  // LANDMARK
  { subtype: "viewpoint", keywords: ["viewpoint", "observation deck", "lookout", "תצפית"] },
  { subtype: "monument", keywords: ["monument", "memorial", "אנדרטה", "מונומנט"] },
  { subtype: "famous_building", keywords: ["tower", "skyscraper", "bridge", "מגדל", "גשר"] },
  // ENTERTAINMENT
  { subtype: "theme_park", keywords: ["theme park", "disneyland", "universal studios", "פארק שעשועים"] },
  { subtype: "amusement_park", keywords: ["amusement park", "fairground", "לונה פארק"] },
  { subtype: "aquarium", keywords: ["aquarium", "אקווריום"] },
  { subtype: "zoo", keywords: ["zoo", "safari park", "גן חיות", "ספארי"] },
  { subtype: "studio_tour", keywords: ["studio tour", "film studio", "סיור אולפן"] },
  { subtype: "sports", keywords: ["stadium", "arena", "sports game", "אצטדיון"] },
  { subtype: "nightlife", keywords: ["bar", "nightclub", "pub", "בר", "מועדון לילה", "פאב"] },
  { subtype: "live_entertainment", keywords: ["live music", "comedy club", "festival", "פסטיבל"] },
  { subtype: "interactive_experience", keywords: ["interactive", "escape room", "workshop experience", "אינטראקטיבי", "חדר בריחה"] },
  // NATURE
  { subtype: "national_state_park", keywords: ["national park", "state park", "פארק לאומי"] },
  { subtype: "beach", keywords: ["beach", "coast", "seaside", "חוף ים", "חוף"] },
  { subtype: "waterfall", keywords: ["waterfall", "מפל"] },
  { subtype: "hiking", keywords: ["hiking", "trail", "trek", "שביל הליכה", "טיול רגלי"] },
  { subtype: "mountain", keywords: ["mountain", "peak", "summit", "הר"] },
  { subtype: "lake", keywords: ["lake", "אגם"] },
  { subtype: "river", keywords: ["river", "canal", "נהר", "תעלה"] },
  { subtype: "wildlife", keywords: ["wildlife", "safari", "nature reserve", "חיות בר", "שמורת טבע"] },
  { subtype: "scenic_drive", keywords: ["scenic drive", "scenic route", "כביש נופי"] },
  { subtype: "scenic_viewpoint", keywords: ["scenic viewpoint", "panorama", "פנורמה"] },
  { subtype: "botanical_garden", keywords: ["botanical garden", "גן בוטני"] },
  { subtype: "urban_park", keywords: ["park", "garden", "פארק", "גן ציבורי"] },
  // LOCAL_EXPERIENCE (multi-family examples per spec §6)
  { subtype: "food_market", secondary: ["FOOD", "SHOPPING"], keywords: ["food market", "night market", "שוק אוכל", "שוק לילה"] },
  { subtype: "market", secondary: ["SHOPPING", "FOOD"], keywords: ["market", "bazaar", "שוק", "בזאר"] },
  { subtype: "local_workshop", keywords: ["workshop", "class", "cooking class", "סדנה"] },
  { subtype: "street_art", keywords: ["street art", "mural", "graffiti", "אמנות רחוב"] },
  { subtype: "cultural_district", secondary: ["CULTURE"], keywords: ["cultural district", "arts district", "רובע תרבות"] },
  { subtype: "neighborhood", keywords: ["neighborhood", "neighbourhood", "district", "quarter", "שכונה", "רובע"] },
  // SHOPPING
  { subtype: "outlet", keywords: ["outlet", "אאוטלט"] },
  { subtype: "mall", keywords: ["mall", "shopping center", "shopping centre", "קניון"] },
  { subtype: "specialty_market", keywords: ["boutique", "specialty shop", "concept store", "בוטיק"] },
  // FOOD
  { subtype: "bakery", keywords: ["bakery", "patisserie", "מאפייה"] },
  { subtype: "food_experience", keywords: ["food tour", "culinary experience", "tasting", "סיור קולינרי", "טעימות"] },
];

const HEBREW_CHAR_PATTERN = /[֐-׿]/;

/**
 * A single-word ASCII keyword ("river", "bar", "market") is matched at word
 * boundaries — plain substring matching let "river" false-positive inside
 * "Riverside", found while writing this module's own tests. A multi-word
 * phrase ("art museum", "old town") or a Hebrew keyword (no reliable `\b`
 * word-boundary support for Hebrew in a non-Unicode-aware regex) still uses
 * substring matching, which is safe for those longer, more specific strings.
 */
function matchesKeyword(haystack: string, keyword: string): boolean {
  if (keyword.includes(" ") || HEBREW_CHAR_PATTERN.test(keyword)) return haystack.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

function matchesAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => matchesKeyword(haystack, keyword));
}

/**
 * THE authoritative classifier (spec §5-7). Deterministic, provider/category
 * backed, never a network or Gemini call. See the module docstring for the
 * exact precedence (category baseline → keyword refinement → metadata).
 */
export function classifyActivity(input: ActivityClassificationInput): ActivityClassification {
  const baseline = CATEGORY_BASELINE[input.category];
  const haystack = `${input.name} ${input.shortDescription}`.toLowerCase();

  let primaryFamily: ActivityFamily = baseline.family;
  let subtype: ActivitySubtype = baseline.subtype;
  let secondaryFamilies: ActivityFamily[] = [];
  let confidence: ActivityClassification["confidence"] = "category_fallback";

  for (const entry of SUBTYPE_KEYWORDS) {
    if (!matchesAny(haystack, entry.keywords)) continue;
    subtype = entry.subtype;
    primaryFamily = SUBTYPE_FAMILY[entry.subtype];
    secondaryFamilies = (entry.secondary ?? []).filter((family) => family !== primaryFamily);
    confidence = "keyword";
    break;
  }

  const indoorOutdoor = classifyWeatherSensitivity({
    category: input.category,
    name: input.name,
    shortDescription: input.shortDescription,
  });
  const energyLevel = classifyItemEnergy({
    category: input.category,
    name: input.name,
    shortDescription: input.shortDescription,
  });

  const familyRelevantSubtypes = new Set<ActivitySubtype>(["zoo", "aquarium", "theme_park", "amusement_park", "urban_park", "interactive_experience"]);
  const eveningSubtypes = new Set<ActivitySubtype>(["nightlife", "bar", "live_entertainment"]);

  const metadata: ActivityClassificationMetadata = {
    indoorOutdoor,
    energyLevel,
    suitableTimeOfDay:
      input.recommendedTimeOfDay && input.recommendedTimeOfDay !== "any" ? [input.recommendedTimeOfDay] : null,
    paidFree:
      input.approximatePrice == null ? null : input.approximatePrice <= 0 ? "free" : "paid",
    familyRelevant: input.category === "family" || familyRelevantSubtypes.has(subtype) ? true : null,
    eveningNightlifeSuitable:
      input.category === "nightlife" || eveningSubtypes.has(subtype) ? true : null,
    bookingSensitive: input.reservationRequired == null ? null : input.reservationRequired,
  };

  return { primaryFamily, subtype, secondaryFamilies, confidence, metadata };
}

/** All families this taxonomy defines — for building distribution reports without hardcoding the list at every call site. */
export const ACTIVITY_FAMILIES: ActivityFamily[] = [
  "CULTURE",
  "LANDMARK",
  "ENTERTAINMENT",
  "NATURE",
  "LOCAL_EXPERIENCE",
  "SHOPPING",
  "FOOD",
  "OTHER",
];

/**
 * Round 9 §9 — maps the trip's OWN preference keywords (strongPreferences/
 * softPreferences/mustVisitKeywords, already free-text strings the profile
 * builder derived from the traveler's real answers) onto taxonomy families,
 * generically — no destination-specific rule, just interest-word → family.
 * Returns a weight multiplier per family (1 = neutral, >1 = boosted); a
 * family with no matching keyword anywhere gets the neutral weight, never
 * zero (spec §9: "do NOT completely eliminate... unless explicitly excluded").
 */
const PREFERENCE_KEYWORD_TO_FAMILY: Array<{ family: ActivityFamily; keywords: string[] }> = [
  { family: "CULTURE", keywords: ["art", "museum", "history", "culture", "architecture", "אמנות", "מוזיאון", "היסטוריה", "תרבות", "אדריכלות"] },
  { family: "NATURE", keywords: ["nature", "hik", "outdoor", "beach", "mountain", "park", "טבע", "הליכ", "חוף", "הר"] },
  { family: "ENTERTAINMENT", keywords: ["nightlife", "entertainment", "theme park", "adventure", "sport", "בילוי", "לילה", "הרפתקה", "ספורט"] },
  { family: "SHOPPING", keywords: ["shopping", "market", "קניות", "שוק"] },
  { family: "FOOD", keywords: ["food", "culinary", "restaurant", "אוכל", "קולינר", "מסעד"] },
  { family: "LOCAL_EXPERIENCE", keywords: ["local", "neighborhood", "authentic", "hidden gem", "מקומי", "שכונה", "אותנטי"] },
  { family: "LANDMARK", keywords: ["landmark", "iconic", "must-see", "אייקוני", "מפורסם"] },
];

/**
 * Round 9.2.1 §19 — structural role semantics, kept deliberately separate
 * from the cuisine/meal-type taxonomy (meal-cuisine-taxonomy.ts): this
 * answers ONE question — does a real place belong to the sightseeing
 * ACTIVITY system, or the MEAL_VENUE system? — and nothing else. An
 * ordinary restaurant/cafe is a MEAL_VENUE (never satisfies activity
 * coverage, spec §1); a food_experience (food tour, cooking class, tasting,
 * market tour — matched via classifyActivity's own keyword table, never a
 * new one here) is a genuine ACTIVITY, spec §18. Raw category is checked
 * FIRST and takes priority over the classified family: a candidate whose
 * provider category is literally "restaurant"/"cafe" is a meal venue even
 * when a keyword elsewhere in its own text (e.g. "bar", "pub") happens to
 * refine its ActivityClassification toward ENTERTAINMENT/nightlife — an
 * "ordinary bar used for food/drink" (spec §2) is a meal venue, not a
 * nightlife outing; a candidate whose raw category IS "nightlife" (a real,
 * dedicated nightclub/venue recommendation) is untouched and stays an
 * ACTIVITY, exactly as before this round.
 */
export type PlanningRole = "ACTIVITY" | "MEAL_VENUE";

export function determinePlanningRole(
  category: RecommendationCategory,
  classification: Pick<ActivityClassification, "primaryFamily" | "subtype">
): PlanningRole {
  if (category === "restaurant" || category === "cafe") {
    return classification.subtype === "food_experience" ? "ACTIVITY" : "MEAL_VENUE";
  }
  if (classification.primaryFamily === "FOOD" && classification.subtype !== "food_experience") {
    return "MEAL_VENUE";
  }
  return "ACTIVITY";
}

export function buildPreferenceFamilyWeights(preferenceTexts: string[]): Record<ActivityFamily, number> {
  const weights = Object.fromEntries(ACTIVITY_FAMILIES.map((family) => [family, 1])) as Record<ActivityFamily, number>;
  const combined = preferenceTexts.join(" ").toLowerCase();
  if (!combined.trim()) return weights;

  for (const { family, keywords } of PREFERENCE_KEYWORD_TO_FAMILY) {
    if (matchesAny(combined, keywords)) weights[family] += 0.5;
  }
  return weights;
}
