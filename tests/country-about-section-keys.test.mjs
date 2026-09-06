import assert from "node:assert/strict";
import test from "node:test";

// country-about-section.tsx (BulletList/PillList/TimelineList/monthCards)
// has no component-rendering test infrastructure in this repo — every
// existing test under tests/ is node:test against a pure function, none
// render JSX/DOM (no jsdom, no @testing-library anywhere in package.json).
// Rather than invent a new rendering pipeline for one component, this
// tests the exact invariant React's reconciler actually warns about — key
// uniqueness within one list — using the SAME `${item}-${index}` formula
// now used in the component, against the real production data that
// triggered the original warning (found via a live Supabase query against
// ai_recommendations, iso_a2=US, itineraryIdeas[4].route). Verified
// separately via `tsc --noEmit` (compiles clean) and (documented in the
// conversation) the actual browser console.

function buildKeys(items) {
  return items.map((item, index) => `${item}-${index}`);
}

test("BulletList/PillList key formula: a real route with a repeated city stays unique per key AND keeps both occurrences visible", () => {
  // Real data: itineraryIdeas[4].route for iso_a2=US — a genuine round
  // trip (Vegas -> Grand Canyon -> Zion -> back to Vegas), not a data bug.
  const route = ["לאס וגאס", "הגרנד קניון", "הפארק הלאומי ציון", "לאס וגאס"];

  const keys = buildKeys(route);

  assert.equal(new Set(keys).size, keys.length, "every generated key must be unique, even with a repeated display value");
  assert.equal(route.filter((item) => item === "לאס וגאס").length, 2, "sanity: the source data really does repeat");
  assert.equal(keys.filter((key) => key.startsWith("לאס וגאס-")).length, 2, "both occurrences must still be represented — never silently deduped");
});

test("BulletList/PillList key formula: works for any repeated display value, not only the reported one", () => {
  const items = ["Tokyo", "Kyoto", "Osaka", "Tokyo", "Tokyo"];
  const keys = buildKeys(items);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.filter((key) => key.startsWith("Tokyo-")).length, 3);
});

test("BulletList/PillList key formula: an empty or fully-unique list still works (no regression on the common case)", () => {
  assert.deepEqual(buildKeys([]), []);
  const unique = ["A", "B", "C"];
  const keys = buildKeys(unique);
  assert.equal(new Set(keys).size, 3);
});
