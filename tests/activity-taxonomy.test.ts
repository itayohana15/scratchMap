import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyActivity,
  classifyTouristEligibility,
  isTouristPortfolioEligible,
  buildPreferenceFamilyWeights,
  ACTIVITY_FAMILIES,
  type ActivityClassificationInput,
  type TouristEligibilityInput,
} from "../src/lib/server/activity-taxonomy";

function item(overrides: Partial<ActivityClassificationInput> = {}): ActivityClassificationInput {
  return {
    category: "attraction",
    name: "Sample Place",
    shortDescription: "",
    ...overrides,
  };
}

// E. art museum -> CULTURE/art_museum
test("Round 9 E: an art museum classifies as CULTURE/art_museum", () => {
  const result = classifyActivity(item({ category: "museum", name: "City Art Museum", shortDescription: "A large art museum and gallery" }));
  assert.equal(result.primaryFamily, "CULTURE");
  assert.equal(result.subtype, "art_museum");
  assert.equal(result.confidence, "keyword");
});

// F. history museum -> CULTURE/history_museum
test("Round 9 F: a history museum classifies as CULTURE/history_museum", () => {
  const result = classifyActivity(item({ category: "museum", name: "National History Museum", shortDescription: "" }));
  assert.equal(result.primaryFamily, "CULTURE");
  assert.equal(result.subtype, "history_museum");
});

// G. theme park -> ENTERTAINMENT/theme_park
test("Round 9 G: a theme park classifies as ENTERTAINMENT/theme_park", () => {
  const result = classifyActivity(item({ category: "family", name: "Universal Studios Theme Park", shortDescription: "" }));
  assert.equal(result.primaryFamily, "ENTERTAINMENT");
  assert.equal(result.subtype, "theme_park");
});

// H. zoo -> ENTERTAINMENT/zoo
test("Round 9 H: a zoo classifies as ENTERTAINMENT/zoo", () => {
  const result = classifyActivity(item({ category: "family", name: "City Zoo", shortDescription: "Home to over 200 species" }));
  assert.equal(result.primaryFamily, "ENTERTAINMENT");
  assert.equal(result.subtype, "zoo");
});

// I. beach -> NATURE/beach
test("Round 9 I: a beach classifies as NATURE/beach", () => {
  const result = classifyActivity(item({ category: "nature", name: "Sunset Beach", shortDescription: "A popular sandy beach" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.subtype, "beach");
  assert.equal(result.metadata.indoorOutdoor, "outdoor");
});

// J. hiking trail -> NATURE/hiking
test("Round 9 J: a hiking trail classifies as NATURE/hiking", () => {
  const result = classifyActivity(item({ category: "nature", name: "Ridge Hiking Trail", shortDescription: "A scenic hiking trail" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.subtype, "hiking");
});

// K. market -> LOCAL_EXPERIENCE primary + SHOPPING/FOOD secondary
test("Round 9 K: a market carries LOCAL_EXPERIENCE primary with SHOPPING + FOOD secondary families", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Riverside Market", shortDescription: "A bustling local market" }));
  assert.equal(result.primaryFamily, "LOCAL_EXPERIENCE");
  assert.equal(result.subtype, "market");
  assert.deepEqual(new Set(result.secondaryFamilies), new Set(["SHOPPING", "FOOD"]));
});

test("Round 9 K2: a food market carries the more specific food_market subtype (SHOPPING + FOOD secondary)", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Downtown Food Market", shortDescription: "A covered food market" }));
  assert.equal(result.subtype, "food_market");
  assert.equal(result.primaryFamily, "LOCAL_EXPERIENCE");
  assert.deepEqual(new Set(result.secondaryFamilies), new Set(["SHOPPING", "FOOD"]));
});

// L. unknown provider tags remain explicitly unknown/OTHER, never fabricated
test("Round 9 L: an unclassifiable candidate stays OTHER/generic, never invented", () => {
  const result = classifyActivity(item({ category: "practical", name: "Luggage Storage", shortDescription: "" }));
  assert.equal(result.primaryFamily, "OTHER");
  assert.equal(result.subtype, "generic");
  assert.equal(result.confidence, "category_fallback");
});

test("Round 9 L2: metadata fields the input doesn't support stay null, never fabricated", () => {
  const result = classifyActivity(item({ category: "attraction", name: "Mystery Spot", shortDescription: "" }));
  assert.equal(result.metadata.paidFree, null, "no approximatePrice supplied -> unknown, not guessed");
  assert.equal(result.metadata.bookingSensitive, null, "no reservationRequired supplied -> unknown, not guessed");
  assert.equal(result.metadata.suitableTimeOfDay, null, "no recommendedTimeOfDay supplied -> unknown, not guessed");
});

test("Round 9: a candidate with a category baseline but no matching keyword keeps the baseline at category_fallback confidence", () => {
  const result = classifyActivity(item({ category: "nature", name: "Green Space", shortDescription: "A pleasant green space" }));
  assert.equal(result.primaryFamily, "NATURE");
  assert.equal(result.confidence, "category_fallback");
});

test("Round 9: known price/reservation signals populate metadata, never fabricated beyond what's given", () => {
  const free = classifyActivity(item({ approximatePrice: 0 }));
  assert.equal(free.metadata.paidFree, "free");
  const paid = classifyActivity(item({ approximatePrice: 45 }));
  assert.equal(paid.metadata.paidFree, "paid");
  const bookingKnownFalse = classifyActivity(item({ reservationRequired: false }));
  assert.equal(bookingKnownFalse.metadata.bookingSensitive, false, "an explicit false is a KNOWN fact, not unknown");
  const bookingKnownTrue = classifyActivity(item({ reservationRequired: true }));
  assert.equal(bookingKnownTrue.metadata.bookingSensitive, true);
});

test("Round 9: nightlife category and nightlife-subtype candidates are eveningNightlifeSuitable", () => {
  const byCategory = classifyActivity(item({ category: "nightlife", name: "The Alley Bar", shortDescription: "" }));
  assert.equal(byCategory.metadata.eveningNightlifeSuitable, true);
  const byKeyword = classifyActivity(item({ category: "attraction", name: "Late Night Comedy Club", shortDescription: "" }));
  assert.equal(byKeyword.metadata.eveningNightlifeSuitable, true);
});

test("Round 9: single-word keyword matching respects word boundaries (a real bug found writing this suite: 'river' must not match inside 'Riverside')", () => {
  const result = classifyActivity(item({ category: "shopping", name: "Riverside Boutique", shortDescription: "A small boutique shop" }));
  assert.notEqual(result.subtype, "river", "'Riverside' must not be misclassified as a NATURE river just because it contains the substring 'river'");
});

test("Round 9: classification is stable — the same input always returns the same classification", () => {
  const input = item({ category: "museum", name: "Downtown Art Museum", shortDescription: "Modern and contemporary art" });
  const first = classifyActivity(input);
  const second = classifyActivity(input);
  assert.deepEqual(first, second);
});

test("Round 9: buildPreferenceFamilyWeights boosts matching families without zeroing any other family", () => {
  const weights = buildPreferenceFamilyWeights(["I love art and museums"]);
  assert.ok(weights.CULTURE > 1, "art/museum preference boosts CULTURE");
  for (const family of ACTIVITY_FAMILIES) {
    assert.ok(weights[family] >= 1, `${family} is never eliminated by a preference — spec §9`);
  }
});

test("Round 9: buildPreferenceFamilyWeights with no preference text leaves every family neutral", () => {
  const weights = buildPreferenceFamilyWeights([]);
  for (const family of ACTIVITY_FAMILIES) {
    assert.equal(weights[family], 1);
  }
});

/* ==================================================================== *
 * ROUND 9.9 — PROVIDER-NEUTRAL TOURIST ELIGIBILITY                      *
 *                                                                        *
 * Root cause: a real production run (Round 9.8) scheduled Target        *
 * (shop=department_store), Forman Mills (shop=department_store), Maine  *
 * Midcoast Mall (shop=mall), Burns Playground (leisure=park — a real    *
 * municipal playground) and Monsignor Crawford Field (same pattern) as  *
 * genuine tourist activities — nothing anywhere in the pipeline ever    *
 * asked "is this genuinely tourist-worthy" for Overpass-sourced places. *
 * ==================================================================== */

function eligibilityInput(overrides: Partial<TouristEligibilityInput> = {}): TouristEligibilityInput {
  return {
    category: "shopping",
    name: "Sample Place",
    shortDescription: "",
    osmTags: null,
    providerTypes: null,
    ...overrides,
  };
}

// Test A — generic supermarket rejected.
test("Round 9.9 test A: a generic supermarket (shop=supermarket) is rejected, not tourist-eligible", () => {
  const result = classifyTouristEligibility(eligibilityInput({ name: "Stop & Shop", osmTags: { shop: "supermarket", name: "Stop & Shop" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
  assert.equal(result.eligibility, "NOT_TOURIST_ACTIVITY");
  assert.equal(result.matchedSignal, "osm:shop=supermarket");
});

// Test B — generic department/discount store rejected (the exact real Round 9.8 shape: Target / Forman Mills, both shop=department_store).
test("Round 9.9 test B: a generic department/discount store (shop=department_store) is rejected — the exact Target/Forman Mills shape", () => {
  const target = classifyTouristEligibility(eligibilityInput({ name: "Target", osmTags: { shop: "department_store", brand: "Target", name: "Target" } }));
  const formanMills = classifyTouristEligibility(eligibilityInput({ name: "Forman Mills", osmTags: { shop: "department_store", brand: "Forman Mills", name: "Forman Mills" } }));
  assert.equal(isTouristPortfolioEligible(target.eligibility), false, "Target must not be tourist-eligible");
  assert.equal(isTouristPortfolioEligible(formanMills.eligibility), false, "Forman Mills must not be tourist-eligible");
  assert.equal(target.matchedSignal, "osm:shop=department_store");
});

// Test C — ordinary shopping centre rejected (Maine Midcoast Mall's exact shape: bare shop=mall, no positive evidence).
test("Round 9.9 test C: an ordinary shopping centre (bare shop=mall) is rejected as PRACTICAL_ONLY — the exact Maine Midcoast Mall shape", () => {
  const result = classifyTouristEligibility(eligibilityInput({ name: "Maine Midcoast Mall", osmTags: { shop: "mall", name: "Maine Midcoast Mall" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
  assert.equal(result.eligibility, "PRACTICAL_ONLY");
});

// Test D — destination market preserved (amenity=marketplace is real, dedicated OSM structured evidence for a genuine market).
test("Round 9.9 test D: a destination market (amenity=marketplace) is preserved as DESTINATION_SHOPPING", () => {
  const result = classifyTouristEligibility(eligibilityInput({ name: "Reading Terminal Market", osmTags: { amenity: "marketplace", name: "Reading Terminal Market" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true);
  assert.equal(result.eligibility, "DESTINATION_SHOPPING");
  assert.equal(result.matchedSignal, "osm:amenity=marketplace");
});

// Test E — neighborhood playground rejected (the exact Burns Playground shape: category "family", bare leisure=park, name reveals it's a playground).
test("Round 9.9 test E: a neighborhood playground (family category, bare leisure=park, name says 'Playground') is rejected — the exact Burns Playground shape", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Burns Playground", osmTags: { leisure: "park", name: "Burns Playground" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY");
});

// Test F — ordinary sports field rejected (the exact Monsignor Crawford Field shape).
test("Round 9.9 test F: an ordinary sports field (family category, bare leisure=park, name says 'Field') is rejected — the exact Monsignor Crawford Field shape", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Monsignor Crawford Field", osmTags: { leisure: "park", name: "Monsignor Crawford Field" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY");
});

// Test F2 — a genuine leisure=pitch/leisure=playground tag (when a provider does supply it directly) is rejected regardless of name.
test("Round 9.9 test F2: an explicit leisure=pitch tag is rejected as LOW_VALUE_LOCAL_AMENITY even with a generic name", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Community Field", osmTags: { leisure: "pitch", name: "Community Field" } }));
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY");
  assert.equal(result.matchedSignal, "osm:leisure=pitch");
});

// Test G — community recreation center rejected.
test("Round 9.9 test G: a community recreation center (amenity=community_centre) is rejected", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Lonnie Young Recreation Center", osmTags: { amenity: "community_centre", name: "Lonnie Young Recreation Center" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
  assert.equal(result.eligibility, "NOT_TOURIST_ACTIVITY");
});

// Test H — museum preserved (structured tourism=museum always wins).
test("Round 9.9 test H: a museum (tourism=museum) is preserved as TOURIST_ANCHOR", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "museum", name: "Harvard Museum of Natural History", osmTags: { tourism: "museum", name: "Harvard Museum of Natural History" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true);
  assert.equal(result.eligibility, "TOURIST_ANCHOR");
});

// Test I — historic site preserved.
test("Round 9.9 test I: a historic site (historic=* tag present) is preserved as TOURIST_STRONG", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "attraction", name: "Old City Hall", osmTags: { historic: "yes", name: "Old City Hall" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true);
  assert.equal(result.eligibility, "TOURIST_STRONG");
});

// Test J — a major destination park is preserved (family category, bare leisure=park, no low-value name evidence).
test("Round 9.9 test J: a major destination park (family category, bare leisure=park, genuine positive structured evidence) is preserved", () => {
  // Round 9.13 §M — "no low-value name evidence" is no longer sufficient on
  // its own (that was the exact Round 9.12 bug: ordinary neighborhood parks
  // survived purely on the ABSENCE of a negative keyword). A real national
  // historical park carries genuine structured evidence (here: a real
  // `wikipedia` tag, never wikidata alone per spec §M) — this is the
  // updated, stricter fixture for the same "major park must survive" intent.
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Boston National Historical Park", osmTags: { leisure: "park", name: "Boston National Historical Park", wikipedia: "en:Boston National Historical Park" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true);
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});

// A positive structured signal always overrides a negative one, even when
// both are present on the same candidate (spec §D's own explicit rule).
test("Round 9.9: a positive structured signal (tourism=attraction) overrides an ambiguous shop=mall on the same candidate", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "shopping", name: "Grand Bazaar", osmTags: { shop: "mall", tourism: "attraction", name: "Grand Bazaar" } }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true);
  assert.equal(result.eligibility, "TOURIST_STRONG");
});

// Test K — shopping preference (category alone) does not admit ordinary retail; only structured/name evidence can upgrade a bare mall.
test("Round 9.9 test K: shopping category alone is not sufficient evidence — only positive destination-shopping evidence upgrades a bare mall", () => {
  const plain = classifyTouristEligibility(eligibilityInput({ category: "shopping", name: "Westfield Plaza", osmTags: { shop: "mall", name: "Westfield Plaza" } }));
  assert.equal(isTouristPortfolioEligible(plain.eligibility), false, "category=shopping alone must never be sufficient tourist evidence");
  const outlet = classifyTouristEligibility(eligibilityInput({ category: "shopping", name: "Historic Outlet Arcade", osmTags: { shop: "mall", name: "Historic Outlet Arcade" } }));
  assert.equal(isTouristPortfolioEligible(outlet.eligibility), true, "genuine destination-shopping evidence in the name must still upgrade it");
  assert.equal(outlet.eligibility, "DESTINATION_SHOPPING");
});

// Test L — provider parity: Overpass and Google structured evidence for the SAME real-world semantic must reach the same eligibility.
test("Round 9.9 test L: Overpass and Google structured evidence reach the same tourist eligibility for equivalent real-world places", () => {
  const cases: Array<{ label: string; osm: Record<string, string>; google: string[]; expectEligible: boolean }> = [
    { label: "ordinary supermarket", osm: { shop: "supermarket" }, google: ["supermarket"], expectEligible: false },
    { label: "ordinary mall", osm: { shop: "mall" }, google: ["shopping_mall"], expectEligible: false },
    { label: "museum", osm: { tourism: "museum" }, google: ["museum"], expectEligible: true },
    { label: "destination market", osm: { amenity: "marketplace" }, google: ["market"], expectEligible: true },
  ];
  for (const c of cases) {
    const fromOverpass = classifyTouristEligibility(eligibilityInput({ category: "shopping", name: `${c.label} (overpass)`, osmTags: c.osm }));
    const fromGoogle = classifyTouristEligibility(eligibilityInput({ category: "shopping", name: `${c.label} (google)`, providerTypes: c.google }));
    assert.equal(isTouristPortfolioEligible(fromOverpass.eligibility), c.expectEligible, `Overpass ${c.label} eligibility mismatch`);
    assert.equal(isTouristPortfolioEligible(fromGoogle.eligibility), c.expectEligible, `Google ${c.label} eligibility mismatch`);
    assert.equal(isTouristPortfolioEligible(fromOverpass.eligibility), isTouristPortfolioEligible(fromGoogle.eligibility), `provider parity broken for ${c.label}`);
  }
});

// A playground/sports field is rejected regardless of provider (documented provider-specific uncertainty: Google's own type vocabulary has no direct "playground"/"pitch" equivalent exposed by GOOGLE_CATEGORY_TYPE_FILTERS, so this is verified Overpass-side only — never fabricated as a Google-side guarantee).
test("Round 9.9: Overpass playground/pitch rejection documented as Overpass-specific (Google's own category filters never request a directly equivalent type)", () => {
  const playground = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Neighborhood Playground", osmTags: { leisure: "playground" } }));
  assert.equal(playground.eligibility, "LOW_VALUE_LOCAL_AMENITY");
});

// Test Q — no country/name blacklist required: the SAME generic structured
// tag rejects an ordinary chain store in the US AND a differently-named
// equivalent elsewhere, with no country-specific or brand-name rule at all.
test("Round 9.9 test Q: rejection is purely structural — no country/brand-name blacklist required", () => {
  const us = classifyTouristEligibility(eligibilityInput({ name: "Any US Big-Box Store", osmTags: { shop: "department_store", "addr:country": "US" } }));
  const other = classifyTouristEligibility(eligibilityInput({ name: "מרכול השכונה", osmTags: { shop: "supermarket", "addr:country": "IL" } }));
  assert.equal(isTouristPortfolioEligible(us.eligibility), false);
  assert.equal(isTouristPortfolioEligible(other.eligibility), false);
  // Neither eligibility.reason string references a specific brand or country.
  assert.doesNotMatch(us.reason.toLowerCase(), /target|forman|united states/);
  assert.doesNotMatch(other.reason.toLowerCase(), /israel/);
});

// Backward-compatibility / fail-open: a candidate with no structured data at
// all (manual/saved places, gemini-verified places, every pre-9.9 fixture)
// keeps its prior behavior — never newly rejected on the mere ABSENCE of
// evidence.
test("Round 9.9: a candidate with no osmTags/providerTypes at all fails open (backward compatibility)", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "attraction", name: "Some Saved Place", osmTags: null, providerTypes: null }));
  assert.equal(isTouristPortfolioEligible(result.eligibility), true, "absence of structured data must never itself cause rejection");
});

/* ==================================================================== *
 * ROUND 9.13 §M/§N — ambiguous-park positive-evidence gate: the         *
 * negative-case tests missing until now (only the POSITIVE/fixture     *
 * side was exercised via other test files' fixture updates).           *
 * ==================================================================== */

// A bare leisure=park with genuinely NO structured visitor-value evidence
// (Round 9.12's real "New Springville Park"/"Pumphouse Park" shape) must
// be rejected, not fail open merely for lacking a NEGATIVE keyword.
test("Round 9.13: a bare leisure=park with no positive structured evidence is LOW_VALUE_LOCAL_AMENITY, not TOURIST_SUPPORTING", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Pumphouse Park", osmTags: { leisure: "park" } }));
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY");
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
});

// Round 9.12's own real regression: `wikidata` alone (which nearly every
// named OSM feature eventually carries) is explicitly NOT sufficient —
// only `wikipedia`/`designation`/`protection_title`/national-park-style
// `boundary`/`garden:type` count as genuine positive evidence.
test("Round 9.13: a bare leisure=park with ONLY a wikidata tag is still LOW_VALUE_LOCAL_AMENITY (wikidata alone is not positive evidence)", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "New Springville Park", osmTags: { leisure: "park", wikidata: "Q12345678" } }));
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY", "wikidata is a routine catalog tag, not evidence of visitor significance");
});

// The genuine positive-evidence path, exercised directly (not just via
// another test file's fixture) — a real wikipedia article is sufficient.
test("Round 9.13: a bare leisure=park WITH a wikipedia tag is TOURIST_SUPPORTING", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "Riverside National Park", osmTags: { leisure: "park", wikipedia: "en:Riverside National Park" } }));
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});

// A protected/designated park is recognized even without a wikipedia
// article of its own (spec §N's preserved list: designation/protection_title/boundary/garden:type).
test("Round 9.13: a bare leisure=park with a designation tag (no wikipedia) is still TOURIST_SUPPORTING", () => {
  const result = classifyTouristEligibility(eligibilityInput({ category: "family", name: "State Nature Reserve", osmTags: { leisure: "park", designation: "state_park" } }));
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});
