import assert from "node:assert/strict";
import test from "node:test";

import { buildCityCanonicalId } from "../src/lib/city-normalization";

test("buildCityCanonicalId rounds coordinates to a ~1km grid", () => {
  assert.equal(buildCityCanonicalId("GE", 41.693, 44.8015), "ge:41.69:44.80");
  // A slightly different geocode result for the same real city should still
  // land in the same bucket.
  assert.equal(buildCityCanonicalId("GE", 41.6889, 44.8015), "ge:41.69:44.80");
});

test("buildCityCanonicalId distinguishes genuinely different places", () => {
  assert.notEqual(
    buildCityCanonicalId("GE", 41.693, 44.8015),
    buildCityCanonicalId("GE", 41.6168, 41.6367) // Batumi, ~real distance away
  );
});

test("buildCityCanonicalId includes the country so identical coordinates in different countries never collide", () => {
  assert.notEqual(buildCityCanonicalId("GE", 41.69, 44.8), buildCityCanonicalId("IL", 41.69, 44.8));
});
