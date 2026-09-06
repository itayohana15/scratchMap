import assert from "node:assert/strict";
import test from "node:test";
import type { Feature, Polygon } from "geojson";

import {
  computeCountryFeatureMapFocus,
  computeMapFocusFromBbox,
  computeMapFocusFromCoordinates,
  normalizeLongitude,
  sanitizeGeoJsonCoordinate,
  toUnwrappedMapBbox,
  type CountryFocusFeatureProperties,
} from "../src/lib/map/focus";

function buildFeature(
  iso: string,
  coordinates: Array<[number, number]>
): Feature<Polygon, CountryFocusFeatureProperties> {
  const ring = [...coordinates, coordinates[0]];

  return {
    type: "Feature",
    properties: {
      iso_a2: iso,
      bbox: [
        Math.min(...coordinates.map(([lon]) => lon)),
        Math.min(...coordinates.map(([, lat]) => lat)),
        Math.max(...coordinates.map(([lon]) => lon)),
        Math.max(...coordinates.map(([, lat]) => lat)),
      ],
    },
    geometry: {
      type: "Polygon",
      coordinates: [ring],
    },
  };
}

test("1. negative longitude is preserved exactly", () => {
  assert.equal(normalizeLongitude(-66), -66);
});

test("2. 0..360 longitude normalizes back into -180..180", () => {
  assert.equal(normalizeLongitude(294), -66);
});

test("3. obviously swapped lat/lon pairs are rejected when latitude falls outside its valid range", () => {
  assert.equal(sanitizeGeoJsonCoordinate([45, 120]), null);
  assert.deepEqual(sanitizeGeoJsonCoordinate([120, 45]), [120, 45]);
});

test("4. an ordinary Europe bbox keeps its local west/east span", () => {
  const focus = computeMapFocusFromBbox([-5, 42, 8, 51]);
  assert.ok(focus != null);
  assert.deepEqual(focus.bbox, [-5, 42, 8, 51]);
  assert.equal(focus.crossesAntimeridian, false);
  assert.equal(focus.center[0], 1.5);
});

test("5. a Caribbean-style bbox stored in 0..360 is normalized back to negative longitudes", () => {
  const focus = computeMapFocusFromBbox([294, 17, 297, 19]);
  assert.ok(focus != null);
  assert.deepEqual(focus.bbox, [-66, 17, -63, 19]);
  assert.equal(focus.center[0], -64.5);
});

test("6. antimeridian points use the short longitude span instead of a world-sized box", () => {
  const focus = computeMapFocusFromCoordinates([
    [179, 10],
    [-179, 12],
    [178, 11],
  ]);
  assert.ok(focus != null);
  assert.ok(focus.longitudeSpan <= 3, `expected a local span, got ${focus.longitudeSpan}`);
  assert.equal(focus.crossesAntimeridian, true);
});

test("7. antimeridian centers stay near 180 degrees rather than collapsing toward Greenwich", () => {
  const focus = computeMapFocusFromCoordinates([
    [179, 10],
    [-179, 12],
    [178, 11],
  ]);
  assert.ok(focus != null);
  assert.ok(Math.abs(Math.abs(focus.center[0]) - 180) <= 1.5, `expected center near 180, got ${focus.center[0]}`);
});

test("8. fitBounds input stays local after unwrapping an antimeridian bbox", () => {
  const focus = computeMapFocusFromCoordinates([
    [179, 10],
    [-179, 12],
    [178, 11],
  ]);
  assert.ok(focus != null);
  const [west, , east] = toUnwrappedMapBbox(focus.bbox);
  assert.ok(east - west <= 3, `expected local fitBounds span, got ${east - west}`);
  assert.deepEqual(toUnwrappedMapBbox([-66, 17, -63, 19]), [-66, 17, -63, 19]);
});

test("9. a previously computed destination cannot leak stale focus state into the next destination", () => {
  const caribbean = buildFeature("CB", [
    [294, 17],
    [297, 17],
    [297, 19],
    [294, 19],
  ]);
  const europe = buildFeature("EU", [
    [2, 44],
    [5, 44],
    [5, 47],
    [2, 47],
  ]);

  const first = computeCountryFeatureMapFocus(caribbean);
  const second = computeCountryFeatureMapFocus(europe);
  const third = computeCountryFeatureMapFocus(caribbean);

  assert.ok(first != null && second != null && third != null);
  assert.notDeepEqual(second.center, first.center);
  assert.deepEqual(third, first);
});

test("10. repeated destination clicks resolve to the same focus every time", () => {
  const feature = buildFeature("AM", [
    [179, -18],
    [-179, -18],
    [-179, -16],
    [179, -16],
  ]);

  const first = computeCountryFeatureMapFocus(feature);
  const second = computeCountryFeatureMapFocus(feature);

  assert.ok(first != null && second != null);
  assert.deepEqual(second, first);
});
