// One-time build step: converts the bundled world-atlas TopoJSON into a
// GeoJSON FeatureCollection enriched with ISO codes and a "zoom to this
// country" bbox, consumed statically by the map at runtime (no client-side
// geo libraries needed). Re-run manually if the world-atlas version changes.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as topojson from "topojson-client";
import worldTopology from "world-atlas/countries-50m.json" with { type: "json" };
import * as turfArea from "@turf/area";
import * as isoCountriesModule from "i18n-iso-countries";
import hebrewLocale from "i18n-iso-countries/langs/he.json" with { type: "json" };

const area = turfArea.default ?? turfArea.area;
const isoCountries = isoCountriesModule.default ?? isoCountriesModule;
isoCountries.registerLocale(hebrewLocale);

// Antimeridian handling, applied per-polygon-fragment (not per-country):
// naive raw longitudes break in two different ways near +/-180 —
//  1. Legitimately wide countries whose mainland crosses the antimeridian
//     (Russia's Chukotka peninsula) get a raw min/max spanning ~360deg
//     instead of their true (much narrower) east-west extent.
//  2. A few degenerate small-island fragments in this topology (observed in
//     Fiji) have raw points touching both -180 and +180 at once; interpreted
//     literally that reads as a ring covering nearly the whole globe, so
//     turf's area() scores it as bigger than any real landmass.
// Both are fixed the same way: for each individual fragment, try shifting
// negative longitudes by +360 ("unwrapping") and keep whichever version
// (raw vs. shifted) has the smaller longitude span for THAT fragment.
//  - Russia's real mainland fragment: raw span ~360 (bad) vs shifted span
//    ~160 (its true width) -> shifted wins, area/bbox computed correctly.
//  - Fiji's artifact fragment: raw span ~360 (bad) vs shifted span ~0.1
//    (its points all sit right at the boundary) -> shifted wins, collapses
//    to a tiny sliver, so it correctly loses the "largest fragment" contest
//    to Viti Levu and never renders as a world-spanning fill.
// The geometry itself stays unwrapped when that keeps a fragment locally
// coherent for rendering, but downstream focus logic still needs a separate
// antimeridian-safe bbox in the canonical -180..180 domain.
function normalizeFragment(coordinates) {
  const lons = coordinates[0].map(([lon]) => lon);
  const rawSpan = Math.max(...lons) - Math.min(...lons);
  const shiftedLons = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
  const shiftedSpan = Math.max(...shiftedLons) - Math.min(...shiftedLons);

  if (shiftedSpan >= rawSpan) return coordinates;

  return coordinates.map((ring) => ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]));
}

function normalizeGeometry(geometry) {
  const fragments = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const normalized = fragments.map(normalizeFragment);
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: normalized[0] }
    : { type: "MultiPolygon", coordinates: normalized };
}

function bboxOfPolygon(coordinates) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const ring of coordinates) {
    for (const [lon, lat] of ring) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

function normalizeLongitude(lon) {
  const normalized = ((lon + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && lon > 0 ? 180 : normalized;
}

function focusBboxOfPolygon(coordinates) {
  const longitudes = [];
  const latitudes = [];

  for (const ring of coordinates) {
    for (const [lon, lat] of ring) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90) continue;
      longitudes.push(normalizeLongitude(lon));
      latitudes.push(lat);
    }
  }

  if (longitudes.length === 0 || latitudes.length === 0) return null;

  const sorted = [...longitudes].sort((left, right) => left - right);
  let largestGap = -Infinity;
  let largestGapIndex = sorted.length - 1;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const gap = sorted[index + 1] - sorted[index];
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const wrapGap = sorted[0] + 360 - sorted[sorted.length - 1];
  if (wrapGap > largestGap) {
    largestGap = wrapGap;
    largestGapIndex = sorted.length - 1;
  }

  const nextIndex = (largestGapIndex + 1) % sorted.length;
  const start = sorted[nextIndex];
  const rawEnd = sorted[largestGapIndex];
  const end = largestGapIndex === sorted.length - 1 ? rawEnd : rawEnd + 360;

  return [
    normalizeLongitude(start),
    Math.min(...latitudes),
    normalizeLongitude(end),
    Math.max(...latitudes),
  ];
}

function assignFeatureBboxes(feature) {
  const mainlandCoordinates = largestFragment(feature.geometry);
  feature.properties.bbox = bboxOfPolygon(mainlandCoordinates);
  feature.properties.focusBbox = focusBboxOfPolygon(mainlandCoordinates) ?? feature.properties.bbox;
}

// Natural Earth includes a handful of disputed/unofficial territories with
// no ISO 3166-1 numeric code at all (their topojson `id` is undefined), so
// they can never join to our `countries.iso_a2` column. Kosovo gets the
// widely-used (if unofficial) "XK" user-assigned code since it's a real
// travel destination; the rest are dropped as out of scope for Phase 1.
const NAME_OVERRIDES = {
  Kosovo: "XK",
};

// Personal-app preference for this deployment: track Israel and the
// Palestinian territories as a single "Israel" entity rather than two
// separate map features/countries rows.
const MERGE_INTO = {
  Palestine: "Israel",
};

function mergeFeatures(features) {
  const byName = new Map(features.map((f) => [f.properties.name, f]));

  for (const [fromName, intoName] of Object.entries(MERGE_INTO)) {
    const from = byName.get(fromName);
    const into = byName.get(intoName);
    if (!from || !into) continue;

    const intoFragments =
      into.geometry.type === "Polygon" ? [into.geometry.coordinates] : into.geometry.coordinates;
    const fromFragments =
      from.geometry.type === "Polygon" ? [from.geometry.coordinates] : from.geometry.coordinates;
    into.geometry = { type: "MultiPolygon", coordinates: [...intoFragments, ...fromFragments] };
    assignFeatureBboxes(into);

    features.splice(features.indexOf(from), 1);
  }

  return features;
}

function totalArea(geometry) {
  const fragments = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return fragments.reduce(
    (sum, coordinates) =>
      sum + area({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } }),
    0
  );
}

// Natural Earth sometimes encodes a country's detached external territory
// (e.g. Australia's Ashmore and Cartier Islands) as its own separate
// top-level topojson feature that still carries the *parent* country's ISO
// numeric code — so two unrelated-looking features resolve to the same
// iso_a2 (confirmed for AU: "Australia" + "Ashmore and Cartier Is.", both
// -> numeric 036). Left alone this produces duplicate map features with the
// same id, which breaks anything keyed by iso_a2 (React list keys, the
// promoteId-based MapLibre source, feature-state lookups). Fix generically
// rather than special-casing each territory found by hand: after every
// feature has a resolved iso_a2, merge any group sharing one into a single
// feature — geometry fragments combined, bbox unioned, and the largest-area
// member's properties (name) kept as the merged feature's identity.
function mergeDuplicateIsoCodes(features) {
  const byIso = new Map();
  for (const feature of features) {
    const list = byIso.get(feature.properties.iso_a2) ?? [];
    list.push(feature);
    byIso.set(feature.properties.iso_a2, list);
  }

  const result = [];
  for (const group of byIso.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    group.sort((a, b) => totalArea(b.geometry) - totalArea(a.geometry));
    const [primary, ...rest] = group;

    const primaryFragments =
      primary.geometry.type === "Polygon" ? [primary.geometry.coordinates] : primary.geometry.coordinates;
    const restFragments = rest.flatMap((f) =>
      f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates
    );
    primary.geometry = { type: "MultiPolygon", coordinates: [...primaryFragments, ...restFragments] };
    assignFeatureBboxes(primary);

    console.log(
      `Merged duplicate iso_a2 "${primary.properties.iso_a2}": ${group.map((f) => f.properties.name).join(" + ")}`
    );
    result.push(primary);
  }

  return result;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "data", "world-countries.geojson");

function largestFragment(geometry) {
  const fragments = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (fragments.length === 1) return fragments[0];

  let best = fragments[0];
  let bestArea = -Infinity;
  for (const coordinates of fragments) {
    const candidateArea = area({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } });
    if (candidateArea > bestArea) {
      bestArea = candidateArea;
      best = coordinates;
    }
  }
  return best;
}

function resolveIso(feature) {
  const name = feature.properties.name;
  if (NAME_OVERRIDES[name]) {
    return { iso_a2: NAME_OVERRIDES[name], iso_a3: null };
  }
  if (feature.id == null) return null;

  const numeric = String(feature.id).padStart(3, "0");
  const iso_a2 = isoCountries.numericToAlpha2(numeric);
  const iso_a3 = isoCountries.numericToAlpha3(numeric) ?? null;
  return iso_a2 ? { iso_a2, iso_a3 } : null;
}

async function main() {
  const collection = topojson.feature(worldTopology, worldTopology.objects.countries);

  let features = [];
  let skipped = 0;

  for (const feature of collection.features) {
    const iso = resolveIso(feature);
    if (!iso) {
      skipped += 1;
      continue;
    }

    const normalizedGeometry = normalizeGeometry(feature.geometry);
    features.push({
      type: "Feature",
      id: iso.iso_a2,
      properties: {
        // English name from Natural Earth for now — mergeFeatures() below
        // matches on this before it gets overwritten with the Hebrew name.
        name: feature.properties.name,
        iso_a2: iso.iso_a2,
        iso_a3: iso.iso_a3,
        bbox: [0, 0, 0, 0],
        focusBbox: [0, 0, 0, 0],
      },
      geometry: normalizedGeometry,
    });
    assignFeatureBboxes(features[features.length - 1]);
  }

  mergeFeatures(features);
  features = mergeDuplicateIsoCodes(features);

  for (const feature of features) {
    feature.properties.name = isoCountries.getName(feature.properties.iso_a2, "he") ?? feature.properties.name;
  }

  const enriched = { type: "FeatureCollection", features };
  await writeFile(outPath, JSON.stringify(enriched));

  console.log(
    `Wrote ${features.length} countries to ${path.relative(process.cwd(), outPath)} (skipped ${skipped} unresolved territories).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
