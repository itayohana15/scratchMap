import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleNatureExperiences,
  classifyNatureExperienceType,
  classifyNatureTypesFromTags,
  computeNatureSubPreferenceFit,
  extractSelectedNatureSubPreferences,
  type NatureExperienceComponentInput,
} from "../src/lib/server/nature-experience";
import { classifyTouristEligibility, isTouristPortfolioEligible } from "../src/lib/server/activity-taxonomy";
import { classifyVisitScale } from "../src/lib/server/itinerary-planning-principles";

// A — a hiking route relation is discovered/classified as a strong nature signal.
test("Round 9.15 test A: route=hiking is classified TOURIST_STRONG (discoverable, not lost at eligibility)", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Franconia Ridge Trail", shortDescription: null, osmTags: { route: "hiking", name: "Franconia Ridge Trail" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_STRONG");
  assert.ok(isTouristPortfolioEligible(result.eligibility));
});

// B — a named path WITH genuine hiking evidence (sac_scale) is accepted.
test("Round 9.15 test B: a named highway=path WITH sac_scale evidence is accepted", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Old Bridle Path", shortDescription: null, osmTags: { highway: "path", name: "Old Bridle Path", sac_scale: "mountain_hiking" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});

// C — an ordinary named footway with NO hiking evidence is rejected — a name alone is not sufficient.
test("Round 9.15 test C: a named highway=footway with NO hiking evidence is rejected (LOW_VALUE_LOCAL_AMENITY)", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Elm Street Footway", shortDescription: null, osmTags: { highway: "footway", name: "Elm Street Footway" }, providerTypes: null });
  assert.equal(result.eligibility, "LOW_VALUE_LOCAL_AMENITY");
  assert.equal(isTouristPortfolioEligible(result.eligibility), false);
});

// D — trailhead preserved.
test("Round 9.15 test D: information=trailhead is TOURIST_SUPPORTING", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Falling Waters Trailhead", shortDescription: null, osmTags: { information: "trailhead" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});

// E — waterfall preserved.
test("Round 9.15 test E: natural=waterfall is TOURIST_STRONG", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Arethusa Falls", shortDescription: null, osmTags: { natural: "waterfall" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_STRONG");
});

// F — peak preserved.
test("Round 9.15 test F: natural=peak is TOURIST_STRONG", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Mount Washington", shortDescription: null, osmTags: { natural: "peak" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_STRONG");
});

// G — viewpoint already preserved (pre-existing, re-asserted here for completeness).
test("Round 9.15 test G: tourism=viewpoint remains TOURIST_STRONG", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Sugar Hill Overlook", shortDescription: null, osmTags: { tourism: "viewpoint" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_STRONG");
});

// H — protected area preserved.
test("Round 9.15 test H: boundary=protected_area is TOURIST_SUPPORTING", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "White Mountain National Forest", shortDescription: null, osmTags: { boundary: "protected_area" }, providerTypes: null });
  assert.equal(result.eligibility, "TOURIST_SUPPORTING");
});

function component(id: string, name: string, lat: number, lon: number, osmTags: Record<string, string>): NatureExperienceComponentInput {
  return { recommendationId: id, name, lat, lon, osmTags };
}

// I — genuinely coherent components (trailhead + trail + waterfall + viewpoint, all within range) form ONE experience.
test("Round 9.15 test I: trailhead + hiking route + waterfall + viewpoint assemble into ONE coherent experience", () => {
  const components = [
    component("th-1", "Falling Waters Trailhead", 44.15, -71.45, { information: "trailhead" }),
    component("route-1", "Falling Waters Trail", 44.152, -71.452, { route: "hiking" }),
    component("wf-1", "Arethusa Falls", 44.155, -71.455, { natural: "waterfall" }),
    component("vp-1", "Frankenstein Cliff Overlook", 44.153, -71.448, { tourism: "viewpoint" }),
  ];
  const { experiences, unassembled } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 1, "all 4 components are within the cluster radius and one carries trail evidence -> exactly one experience");
  assert.equal(unassembled.length, 0);
  assert.equal(experiences[0].provenance.natureExperience?.componentRecommendationIds.length, 4);
});

// Round 9.15.1 §E — a trailhead NODE is explicitly NOT mandatory: a named
// hiking route (route=hiking) + a peak/waterfall connection is sufficient
// alternative strong evidence on its own, with no information=trailhead
// component anywhere in the cluster (Round 9.15's own real North Conway
// validation found zero trailhead nodes at all in a genuine hiking area).
test("Round 9.15.1 test: assembly succeeds via route=hiking + peak alone, with NO trailhead component at all", () => {
  const components = [
    component("route-2", "Ridge Trail", 44.20, -71.50, { route: "hiking" }),
    component("peak-2", "Ridge Summit", 44.202, -71.502, { natural: "peak" }),
  ];
  const { experiences, unassembled } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 1, "a named hiking route + a peak connection must assemble without any trailhead node");
  assert.equal(unassembled.length, 0);
});

// J — unrelated POIs (no trail evidence anywhere, or too far apart) do NOT form one experience.
test("Round 9.15 test J: two unrelated viewpoints with no trail evidence do NOT assemble into one experience", () => {
  const components = [
    component("vp-a", "Overlook A", 44.10, -71.10, { tourism: "viewpoint" }),
    component("vp-b", "Overlook B", 44.101, -71.101, { tourism: "viewpoint" }),
  ];
  const { experiences, unassembled } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 0, "no trail/route evidence anywhere in the cluster -> never assembled, regardless of proximity");
  assert.equal(unassembled.length, 2);
});

test("Round 9.15 test J2: geographically distant components (beach far from a hiking trail) do NOT assemble", () => {
  const components = [
    component("route-2", "Coastal Trail", 40.0, -74.0, { route: "hiking" }),
    component("beach-2", "Faraway Beach", 41.0, -73.0, { natural: "beach" }), // >100km away
  ];
  const { experiences, unassembled } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 0);
  assert.equal(unassembled.length, 2);
});

// K — half-day hike duration classification, WITH sufficient strong evidence.
test("Round 9.15 test K: a 3-component trail cluster totaling >=150 minutes classifies as NATURE_HALF_DAY_HIKE (with sufficient evidence)", () => {
  assert.equal(classifyNatureExperienceType(180, true, 3, 1), "NATURE_HALF_DAY_HIKE");
});

// L — full-day hike duration classification, WITH sufficient strong evidence.
test("Round 9.15 test L: a trail cluster totaling >=300 minutes classifies as NATURE_FULL_DAY_HIKE (with sufficient evidence)", () => {
  assert.equal(classifyNatureExperienceType(360, true, 4, 2), "NATURE_FULL_DAY_HIKE");
});

// Round 9.15.1 §G — the evidence-gating itself: a cluster whose summed
// minutes cross the full-day threshold but whose components carry weak/no
// evidence must NOT be allowed to claim NATURE_FULL_DAY_HIKE — that would
// be exactly the "pretend it is a 6-hour hike" fabrication Part G forbids.
test("Round 9.15.1 test: insufficient strong evidence caps duration classification below what raw minutes alone would suggest", () => {
  assert.equal(classifyNatureExperienceType(360, true, 4, 0), "NATURE_SHORT_WALK", "0 strong-evidence components must never reach FULL_DAY or even HALF_DAY regardless of summed minutes");
  assert.equal(classifyNatureExperienceType(360, true, 4, 1), "NATURE_HALF_DAY_HIKE", "1 strong-evidence component is enough for HALF_DAY but not FULL_DAY");
});

// M — the assembled experience's own description carries the half/full-day
// keyword needed for classifyVisitScale's existing keyword match (Round
// 9.15 §J's actual wiring mechanism — verified end-to-end, not just the
// pure duration classifier above).
test("Round 9.15 test M: a full-day-shaped assembled experience's description triggers the existing FULL_DAY_KEYWORDS match", () => {
  const components = [
    component("th-3", "Base Camp Trailhead", 44.0, -71.0, { information: "trailhead" }),
    component("route-3", "Long Ridge Trail", 44.002, -71.002, { route: "hiking" }),
    component("peak-3", "High Peak", 44.004, -71.004, { natural: "peak" }),
    component("wf-3", "Remote Falls", 44.006, -71.006, { natural: "waterfall" }),
    component("vp-3", "Summit Viewpoint", 44.008, -71.008, { tourism: "viewpoint" }),
  ];
  const { experiences } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 1);
  assert.ok(experiences[0].estimatedDurationMinutes >= 300, `expected a full-day-scale total duration, got ${experiences[0].estimatedDurationMinutes}`);
  assert.match(experiences[0].shortDescription, /יום שלם/, "the description must carry the existing FULL_DAY_KEYWORDS phrase so classifyVisitScale resolves it to full_day");
  // Close the loop end-to-end: feed the ASSEMBLED item's real fields
  // straight into the unmodified, shared classifyVisitScale and confirm it
  // actually resolves to "full_day" — not just that the keyword is present.
  const scale = classifyVisitScale({
    category: experiences[0].category,
    name: experiences[0].name,
    shortDescription: experiences[0].shortDescription,
    estimatedDurationMinutes: experiences[0].estimatedDurationMinutes,
  });
  assert.equal(scale, "full_day", "Round 9.14 found every nature item defaulted to medium/90min regardless of real duration — this must no longer be true for an assembled full-day experience");
});

// M2 — the half-day analogue of M, confirming the boundary works both ways.
test("Round 9.15 test M2: a half-day-shaped assembled experience resolves to VisitScale half_day, not medium", () => {
  const components = [
    component("th-4", "Ridge Trailhead", 45.0, -72.0, { information: "trailhead" }),
    component("route-4", "Ridge Loop Trail", 45.001, -72.001, { route: "hiking" }),
    component("vp-4", "Ridge Viewpoint", 45.002, -72.002, { tourism: "viewpoint" }),
  ];
  const { experiences } = assembleNatureExperiences(components);
  assert.equal(experiences.length, 1);
  assert.ok(experiences[0].estimatedDurationMinutes >= 150 && experiences[0].estimatedDurationMinutes < 300, `expected a half-day-scale duration, got ${experiences[0].estimatedDurationMinutes}`);
  const scale = classifyVisitScale({
    category: experiences[0].category,
    name: experiences[0].name,
    shortDescription: experiences[0].shortDescription,
    estimatedDurationMinutes: experiences[0].estimatedDurationMinutes,
  });
  assert.equal(scale, "half_day");
});

// N — sub-preference extraction only recognizes what the user actually selected.
test("Round 9.15 test N: extractSelectedNatureSubPreferences only returns sub-preferences genuinely present in the text", () => {
  const result = extractSelectedNatureSubPreferences("טבע, הרים, אוכל, תרבות");
  assert.deepEqual(result.sort(), ["MOUNTAINS"]);
  assert.equal(extractSelectedNatureSubPreferences("אוכל, תרבות, חיי לילה").length, 0, "a trip with no nature-adjacent interest at all gets zero sub-preferences");
});

// O — a strong hike gets a material fit bonus when it matches a selected sub-preference; a candidate with no overlap gets zero.
test("Round 9.15 test O: computeNatureSubPreferenceFit rewards overlap and gives zero for no overlap or no selection", () => {
  const hikingFit = computeNatureSubPreferenceFit(["HIKING", "MOUNTAINS"], ["HIKING"]);
  assert.ok(hikingFit > 0, "an overlapping sub-preference must produce a positive fit bonus");
  assert.equal(computeNatureSubPreferenceFit(["HIKING"], ["BEACHES"]), 0, "no overlap -> zero bonus, never a generic nature multiplier");
  assert.equal(computeNatureSubPreferenceFit([], ["HIKING"]), 0, "no selected sub-preference at all -> zero bonus (the flat family weight is the only boost such a traveler gets)");
});

// P — classifyNatureTypesFromTags derives structured types from real tags only.
test("Round 9.15 test P: classifyNatureTypesFromTags derives types purely from structured tags, never from the name", () => {
  assert.deepEqual(classifyNatureTypesFromTags({ natural: "peak" }), ["MOUNTAINS"]);
  assert.deepEqual(classifyNatureTypesFromTags({ natural: "waterfall" }), ["WATERFALLS"]);
  assert.deepEqual(classifyNatureTypesFromTags(null), []);
  assert.deepEqual(classifyNatureTypesFromTags({ shop: "mall" }), [], "an unrelated tag set yields no nature types");
});

// Q — a weak, evidence-less path still loses eligibility even under a strong nature preference — a preference bonus can never rescue a candidate that never reaches scoring (eligibility gates BEFORE scoring, always).
test("Round 9.15 test Q: a weak unnamed-evidence path is rejected regardless of how strong the nature preference is", () => {
  const result = classifyTouristEligibility({ category: "nature", name: "Service Path 12", shortDescription: null, osmTags: { highway: "path" }, providerTypes: null });
  assert.equal(isTouristPortfolioEligible(result.eligibility), false, "eligibility is decided purely from structured evidence — no preference signal ever reaches this gate");
});
