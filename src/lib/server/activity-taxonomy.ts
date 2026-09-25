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

/**
 * Round 9.9 — THE provider-neutral tourist-eligibility gate (spec §B/§C).
 *
 * Root cause this closes: a real production run (Round 9.8) scheduled
 * Target (shop=department_store), Forman Mills (shop=department_store),
 * Maine Midcoast Mall (shop=mall), Burns Playground (leisure=park — a
 * genuine municipal playground, OSM-tagged as a "park" the way many small
 * US municipal parks/playgrounds/athletic fields are) and Monsignor
 * Crawford Field (same "family"-category leisure=park pattern) as real
 * scheduled tourist activities. Traced live: nothing anywhere in the
 * pipeline ever asked "is this genuinely tourist-worthy" — every existing
 * check (geography legality, dedupe, meal-role, `computeSignificance`) only
 * asks "is this real/legal/non-duplicate", and `computeSignificance` itself
 * starts every ordinary Overpass candidate at the SAME neutral 40/100
 * regardless of place type. Google Places already has a hard-exclusion set
 * (`PRIMARY_TYPE_HARD_EXCLUSIONS` in google-places.ts) for exactly this
 * purpose, keyed off Google's own `primaryType` — but nothing analogous
 * ever existed for Overpass's OSM tags, and Round 9.8 was the first real
 * run where Overpass stayed healthy enough end-to-end for that gap to
 * surface (every earlier round's real traffic happened to route through
 * Google, whose narrower gate was doing the filtering by accident).
 *
 * This function is deliberately PROVIDER-NEUTRAL and STRUCTURED-METADATA-
 * FIRST (spec §C): it reads whichever real structured signal the candidate
 * actually carries — Overpass's raw OSM tags (`osmTags`, threaded through
 * by overpass.ts's own query loop) or Google's `primaryType`/`types`
 * (`providerTypes`, already populated since Round 9.6) — and only falls
 * back to a narrow, GENERIC (never a brand/name blacklist, spec §C/§Q) name
 * keyword check when the structured tag itself is genuinely ambiguous
 * (bare `shop=mall`/Google `shopping_mall`, or the "family" category's own
 * bare `leisure=park` — which Overpass's own family-category query already
 * requests broadly, so the tag alone can never distinguish a real
 * destination park from a mistagged neighborhood playground/sports field).
 * A positive structured signal (tourism=museum/attraction, historic=*,
 * heritage=*, amenity=marketplace, a real Google tourist_attraction/museum
 * type, ...) always wins over any negative one — spec §D's own rule
 * ("ordinary utility/local amenity != tourist activity", never "retail/
 * sport/university always forbidden").
 */
export type TouristEligibility =
  | "TOURIST_ANCHOR"
  | "TOURIST_STRONG"
  | "TOURIST_SUPPORTING"
  | "DESTINATION_SHOPPING"
  | "PRACTICAL_ONLY"
  | "LOW_VALUE_LOCAL_AMENITY"
  | "NOT_TOURIST_ACTIVITY";

export interface TouristEligibilityInput {
  category: RecommendationCategory;
  name: string;
  shortDescription?: string | null;
  /** Overpass's raw OSM tags, when captured (overpass.ts populates this on every candidate since Round 9.9). */
  osmTags?: Record<string, string> | null;
  /** Google's own `[primaryType, ...types]` array (already populated in provenance.types since Round 9.6), OR any other provider's equivalent flat type-string list. */
  providerTypes?: string[] | null;
}

export interface TouristEligibilityResult {
  eligibility: TouristEligibility;
  reason: string;
  /** e.g. "osm:shop=department_store", "osm:tourism=museum", "google:type=department_store", "name:playground_keyword" — machine-checkable evidence, spec §I ("why was Target rejected — without reading source code"). */
  matchedSignal: string | null;
}

/** A candidate real place actually earns a normal-day portfolio slot only at these tiers (spec §F/§G) — PRACTICAL_ONLY/LOW_VALUE_LOCAL_AMENITY/NOT_TOURIST_ACTIVITY are all real, legal, non-duplicate places that must still never occupy one. */
export function isTouristPortfolioEligible(eligibility: TouristEligibility): boolean {
  return (
    eligibility === "TOURIST_ANCHOR" ||
    eligibility === "TOURIST_STRONG" ||
    eligibility === "TOURIST_SUPPORTING" ||
    eligibility === "DESTINATION_SHOPPING"
  );
}

// Structured OSM signals that, on their own, are strong POSITIVE evidence —
// checked first, and always override any negative signal below (spec §D).
const OSM_TOURISM_ANCHOR_VALUES = new Set(["museum"]);
const OSM_TOURISM_STRONG_VALUES = new Set(["attraction", "gallery", "artwork", "zoo", "theme_park", "aquarium", "viewpoint", "alpine_hut"]);
const OSM_LEISURE_STRONG_VALUES = new Set(["nature_reserve", "water_park"]);
const OSM_CRAFT_EXPERIENCE_VALUES = new Set(["brewery", "winery", "distillery"]); // spec §D's brewery/winery exception
// Round 9.15 §C — genuine nature landmarks: a peak/waterfall/cliff is
// inherently a point-of-interest, never an ambiguous "could be anything"
// tag the way a bare highway=path is (see the separate path/footway gate
// below), so these are structured POSITIVE signals like any other.
const OSM_NATURAL_STRONG_VALUES = new Set(["peak", "waterfall", "cliff"]);

// Structured OSM signals that are NOT_TOURIST_ACTIVITY / LOW_VALUE on their
// own — only reached once every positive check above has already failed to
// match, so a museum that also happens to sell souvenirs (shop=gift) is
// never caught here.
const OSM_ORDINARY_RETAIL_SHOP_VALUES = new Set([
  "supermarket", "department_store", "discount_store", "variety_store", "convenience",
  "wholesale", "doityourself", "hardware", "trade", "car", "car_repair",
  "mobile_phone", "electronics", "furniture", "appliance",
]);
const OSM_LOW_VALUE_LEISURE_VALUES = new Set(["pitch", "playground", "track", "fitness_centre", "sports_centre"]);
const OSM_LOW_VALUE_AMENITY_VALUES = new Set([
  "parking", "hospital", "clinic", "doctors", "school", "university", "community_centre",
  "social_facility", "fuel", "bank", "post_office", "townhall", "courthouse", "police", "fire_station",
]);
const OSM_LOW_VALUE_BUILDING_VALUES = new Set(["residential", "house", "apartments", "garage", "warehouse", "industrial"]);

// Google `primaryType`/`types` equivalents of the same positive/negative
// signals — kept as its own small table (never re-deriving from Overpass's
// OSM vocabulary) because the two providers' type systems are genuinely
// different, per spec §A ("do not assume the Google exclusion table can
// simply be copied... Overpass has different structured metadata") — this
// is that same asymmetry in the other direction: Google's own type system
// has no "shop=department_store"-style key/value pairing to reuse.
const GOOGLE_TOURIST_ANCHOR_TYPES = new Set(["museum"]);
const GOOGLE_TOURIST_STRONG_TYPES = new Set(["tourist_attraction", "historical_landmark", "monument", "cultural_landmark", "art_gallery", "amusement_park", "zoo", "aquarium", "national_park", "state_park", "nature_preserve"]);
const GOOGLE_DESTINATION_SHOPPING_TYPES = new Set(["market"]);
// Google's OWN google-places.ts already hard-excludes supermarket/
// department_store/grocery_store/convenience_store at the source, so this
// row is reached only for whatever slips past that (parity safety net,
// never a duplicate of that table).
const GOOGLE_NOT_TOURIST_TYPES = new Set(["parking", "hospital", "school", "university", "supermarket", "department_store", "grocery_store", "convenience_store", "gas_station"]);
// "shopping_mall" is deliberately NOT in either set above — Google's own
// GOOGLE_CATEGORY_TYPE_FILTERS.shopping already requests it as an included
// type with no further distinction, the exact same ambiguity Overpass's
// bare shop=mall has (spec §H: provider parity) — resolved the same way
// below, via the shared ambiguous-mall name check.

// SECONDARY evidence only (spec §C/§Q — never a brand/place-name blacklist;
// these are generic English/Hebrew words describing what a place IS, never
// a specific real-world business or landmark name).
const DESTINATION_SHOPPING_NAME_KEYWORDS = ["outlet", "factory outlet", "historic", "heritage", "landmark", "אאוטלט", "היסטורי"];
const LOW_VALUE_FAMILY_NAME_KEYWORDS = [
  "playground", "ballfield", "ball field", "athletic field", "sports field", "sports complex",
  // "field" alone (word-boundary matched, so "Fieldstone"/"Sheffield" never
  // false-positive) — a generic word for an ordinary playing field, never a
  // specific place name. A genuinely famous stadium/arena is caught EARLIER
  // by the leisure=stadium/building=stadium positive check above and never
  // reaches this branch (this branch only fires for the ambiguous, bare
  // family-category leisure=park tag a real stadium is never tagged with).
  "field",
  "little league", "softball", "recreation center", "recreation centre", "community center", "community centre",
  "מגרש משחקים", "מגרש ספורט", "מרכז קהילתי",
];

function firstOsmMatch(tags: Record<string, string>, key: string, values: Set<string>): string | null {
  const value = tags[key];
  return value != null && values.has(value) ? `osm:${key}=${value}` : null;
}

/**
 * THE classifier (spec §B/§C). Structured metadata first; a narrow, generic
 * name-keyword check only for the specific tags that are genuinely
 * ambiguous on their own (bare shop=mall/shopping_mall, bare family-category
 * leisure=park). Every other category (attraction/museum/nature/nightlife/
 * hidden_gem/day_trip/seasonal_event with no negative structured signal)
 * keeps its existing category-baseline behavior — this gate only ever
 * REJECTS/DOWNGRADES on positive evidence of low value, never invents new
 * restrictions for categories the pipeline already trusted.
 */
export function classifyTouristEligibility(input: TouristEligibilityInput): TouristEligibilityResult {
  const tags = input.osmTags ?? null;
  const types = input.providerTypes ?? null;
  const haystack = `${input.name} ${input.shortDescription ?? ""}`.toLowerCase();

  // --- 1. Structured POSITIVE signals — always checked first, always win. ---
  if (tags) {
    const tourism = tags.tourism;
    if (tourism && OSM_TOURISM_ANCHOR_VALUES.has(tourism)) {
      return { eligibility: "TOURIST_ANCHOR", reason: "Overpass tourism=museum", matchedSignal: `osm:tourism=${tourism}` };
    }
    if (tags.museum != null) {
      return { eligibility: "TOURIST_ANCHOR", reason: "Overpass museum=* tag present", matchedSignal: `osm:museum=${tags.museum}` };
    }
    if (tourism && OSM_TOURISM_STRONG_VALUES.has(tourism)) {
      return { eligibility: "TOURIST_STRONG", reason: `Overpass tourism=${tourism}`, matchedSignal: `osm:tourism=${tourism}` };
    }
    if (tags.historic != null) {
      return { eligibility: "TOURIST_STRONG", reason: "Overpass historic=* tag present", matchedSignal: `osm:historic=${tags.historic}` };
    }
    if (tags.heritage != null) {
      return { eligibility: "TOURIST_STRONG", reason: "Overpass heritage=* tag present", matchedSignal: `osm:heritage=${tags.heritage}` };
    }
    if (tags.amenity === "marketplace") {
      return { eligibility: "DESTINATION_SHOPPING", reason: "Overpass amenity=marketplace — a genuine market, not ordinary retail", matchedSignal: "osm:amenity=marketplace" };
    }
    if (tags.leisure && OSM_LEISURE_STRONG_VALUES.has(tags.leisure)) {
      return { eligibility: "TOURIST_STRONG", reason: `Overpass leisure=${tags.leisure}`, matchedSignal: `osm:leisure=${tags.leisure}` };
    }
    // Round 9.15 §C — nature/hiking structured positives (Round 9.14 audit:
    // none of these were recognized at all before this round, so a
    // discovered peak/waterfall/trailhead/protected-area/named-hiking-route
    // had no path to TOURIST_SUPPORTING-or-better regardless of discovery).
    if (tags.natural && OSM_NATURAL_STRONG_VALUES.has(tags.natural)) {
      return { eligibility: "TOURIST_STRONG", reason: `Overpass natural=${tags.natural}`, matchedSignal: `osm:natural=${tags.natural}` };
    }
    if (tags.route === "hiking") {
      return { eligibility: "TOURIST_STRONG", reason: "Overpass route=hiking — a named hiking route", matchedSignal: "osm:route=hiking" };
    }
    if (tags.information === "trailhead") {
      return { eligibility: "TOURIST_SUPPORTING", reason: "Overpass information=trailhead — a genuine trail access point", matchedSignal: "osm:information=trailhead" };
    }
    if (tags.boundary === "protected_area") {
      return { eligibility: "TOURIST_SUPPORTING", reason: "Overpass boundary=protected_area", matchedSignal: "osm:boundary=protected_area" };
    }
    if (tags.craft && OSM_CRAFT_EXPERIENCE_VALUES.has(tags.craft)) {
      return { eligibility: "TOURIST_SUPPORTING", reason: `Overpass craft=${tags.craft} — a visitable brewery/winery/distillery experience`, matchedSignal: `osm:craft=${tags.craft}` };
    }
    if (tags.leisure === "stadium" || tags.building === "stadium") {
      return { eligibility: "TOURIST_SUPPORTING", reason: "a stadium/arena — visitor-significant per exception, not an ordinary sports field", matchedSignal: `osm:${tags.leisure === "stadium" ? "leisure" : "building"}=stadium` };
    }
  }
  if (types && types.length > 0) {
    const anchorMatch = types.find((t) => GOOGLE_TOURIST_ANCHOR_TYPES.has(t));
    if (anchorMatch) return { eligibility: "TOURIST_ANCHOR", reason: `Google type=${anchorMatch}`, matchedSignal: `google:type=${anchorMatch}` };
    const strongMatch = types.find((t) => GOOGLE_TOURIST_STRONG_TYPES.has(t));
    if (strongMatch) return { eligibility: "TOURIST_STRONG", reason: `Google type=${strongMatch}`, matchedSignal: `google:type=${strongMatch}` };
    const marketMatch = types.find((t) => GOOGLE_DESTINATION_SHOPPING_TYPES.has(t));
    if (marketMatch) return { eligibility: "DESTINATION_SHOPPING", reason: `Google type=${marketMatch} — a genuine market`, matchedSignal: `google:type=${marketMatch}` };
  }

  // --- 2. Structured NEGATIVE signals (only reached once every positive above missed). ---
  if (tags) {
    const shopReject = firstOsmMatch(tags, "shop", OSM_ORDINARY_RETAIL_SHOP_VALUES);
    if (shopReject) return { eligibility: "NOT_TOURIST_ACTIVITY", reason: "ordinary chain retail (shop=* matches Google's own hard-exclusion vocabulary)", matchedSignal: shopReject };
    const leisureReject = firstOsmMatch(tags, "leisure", OSM_LOW_VALUE_LEISURE_VALUES);
    if (leisureReject) return { eligibility: "LOW_VALUE_LOCAL_AMENITY", reason: "an ordinary sports pitch/playground/track/fitness facility, not a visitor destination", matchedSignal: leisureReject };
    const amenityReject = firstOsmMatch(tags, "amenity", OSM_LOW_VALUE_AMENITY_VALUES);
    if (amenityReject) return { eligibility: "NOT_TOURIST_ACTIVITY", reason: "a practical/administrative/civic amenity, not a tourist activity", matchedSignal: amenityReject };
    if (tags.office != null) {
      return { eligibility: "NOT_TOURIST_ACTIVITY", reason: "an office", matchedSignal: `osm:office=${tags.office}` };
    }
    const buildingReject = firstOsmMatch(tags, "building", OSM_LOW_VALUE_BUILDING_VALUES);
    if (buildingReject) return { eligibility: "NOT_TOURIST_ACTIVITY", reason: "a residential/utility building, not a tourist destination", matchedSignal: buildingReject };
  }
  if (types) {
    const googleReject = types.find((t) => GOOGLE_NOT_TOURIST_TYPES.has(t));
    if (googleReject) return { eligibility: "NOT_TOURIST_ACTIVITY", reason: `Google type=${googleReject}`, matchedSignal: `google:type=${googleReject}` };
  }

  // --- 3. Genuinely AMBIGUOUS structured signals — narrow, generic name check only. ---
  // Round 9.15 §C/§V — a bare highway=path/footway is structurally
  // ambiguous the same way a bare leisure=park is: it could be a genuine
  // named hiking trail, or it could be an ordinary sidewalk/service path
  // that merely happens to carry a name tag. Positive structured evidence
  // (sac_scale/trail_visibility — genuine hiking-specific OSM enrichment
  // tags — or its own route tag) is required; the mere presence of a name
  // is NOT enough on its own for this specific ambiguous shape (unlike
  // every other nature tag above, which is inherently point-like/
  // unambiguous). Never a name/keyword check — this is exactly the
  // "quality floor" spec §V asks for: FreeTime beats a fake hiking
  // experience assembled from an ordinary named path.
  if (tags?.highway === "path" || tags?.highway === "footway") {
    const hasHikingEvidence = Boolean(tags.sac_scale) || Boolean(tags.trail_visibility) || Boolean(tags.route);
    if (hasHikingEvidence) {
      return { eligibility: "TOURIST_SUPPORTING", reason: `Overpass highway=${tags.highway} with genuine hiking-trail evidence (sac_scale/trail_visibility/route)`, matchedSignal: `osm:highway=${tags.highway}+hiking_evidence` };
    }
    return { eligibility: "LOW_VALUE_LOCAL_AMENITY", reason: `an ordinary highway=${tags.highway} with no positive hiking-trail evidence (a name alone is not sufficient)`, matchedSignal: `osm:highway=${tags.highway}` };
  }
  const bareMall = tags?.shop === "mall" || (types?.includes("shopping_mall") ?? false);
  if (bareMall) {
    if (matchesAny(haystack, DESTINATION_SHOPPING_NAME_KEYWORDS)) {
      return { eligibility: "DESTINATION_SHOPPING", reason: "a mall with positive destination-shopping evidence in its own name/description", matchedSignal: "name:destination_shopping_keyword" };
    }
    return { eligibility: "PRACTICAL_ONLY", reason: "an ordinary mall/shopping centre with no destination-shopping evidence", matchedSignal: tags?.shop === "mall" ? "osm:shop=mall" : "google:type=shopping_mall" };
  }
  if (input.category === "family" && tags?.leisure === "park") {
    if (matchesAny(haystack, LOW_VALUE_FAMILY_NAME_KEYWORDS)) {
      return { eligibility: "LOW_VALUE_LOCAL_AMENITY", reason: "a neighborhood playground/sports field/rec-centre mistagged under a broad leisure=park-style family query, not a genuine family destination", matchedSignal: "name:low_value_family_keyword" };
    }
    // Round 9.13 §M/§N — a real production run found bare leisure=park
    // ordinary neighborhood parks (Round 9.12: "New Springville Park",
    // "Pumphouse Park", "Baederwood Park", "Grove Park", the Battery Park
    // City "Forecourt"s) surviving purely because they had no NEGATIVE
    // keyword — the OLD "absence of a negative keyword is the honest
    // default" fail-open was itself the bug. The absence of negative
    // evidence is no longer sufficient on its own for this specific
    // structured shape; genuine POSITIVE visitor-value evidence is now
    // required — all still structural, never a name/place blacklist.
    // `wikipedia` (a real, curated encyclopedia article) is deliberately
    // used instead of `wikidata` alone (spec §M explicitly forbids that —
    // Round 9.12's own New Springville Park had a routine wikidata tag,
    // which nearly every named OSM feature eventually gets, and is not
    // itself evidence of visitor significance). `designation`/
    // `protection_title`/`boundary=national_park`/`garden:type` are the
    // generic OSM tags real national/state parks and botanical gardens
    // (spec §N's own preserved list) actually carry.
    const hasPositiveParkEvidence =
      Boolean(tags.wikipedia) ||
      Boolean(tags.designation) ||
      Boolean(tags.protection_title) ||
      tags.boundary === "national_park" ||
      tags.boundary === "protected_area" ||
      Boolean(tags["garden:type"]);
    if (hasPositiveParkEvidence) {
      return { eligibility: "TOURIST_SUPPORTING", reason: "a family-category park with genuine structured visitor-value evidence", matchedSignal: "osm:leisure=park+positive_evidence" };
    }
    return { eligibility: "LOW_VALUE_LOCAL_AMENITY", reason: "an ordinary leisure=park with no positive structured visitor-value evidence (wikidata alone, or no evidence at all, is not sufficient)", matchedSignal: "osm:leisure=park" };
  }
  if (input.category === "family" && !tags && !types) {
    // Fail-open ONLY for candidates with NO structured data at all (manual/
    // saved places, gemini-verified places, older fixtures/tests) — the
    // established, unchanged backward-compatibility convention. This is a
    // narrower carve-out than before: it no longer covers a candidate that
    // DOES carry a bare leisure=park tag (handled, stricter, above).
    return { eligibility: "TOURIST_SUPPORTING", reason: "no structured evidence available at all — fail-open for backward compatibility", matchedSignal: null };
  }

  // --- 4. No negative/ambiguous signal matched anywhere — category-baseline default. ---
  // Deliberately fail-open (spec's own established convention elsewhere in
  // this codebase, e.g. classifyStayDestination): a candidate with no
  // structured data at all (manual/saved places, gemini-verified places,
  // older fixtures) or whose structured data carried no negative/ambiguous
  // signal keeps exactly the behavior this pipeline already had before this
  // round — never newly rejected on the mere ABSENCE of positive evidence.
  return { eligibility: "TOURIST_SUPPORTING", reason: "no negative or ambiguous structured evidence found", matchedSignal: null };
}
