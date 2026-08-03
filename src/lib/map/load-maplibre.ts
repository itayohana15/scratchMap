"use client";

import type * as MapLibreGL from "maplibre-gl";

// See scripts/copy-maplibre-assets.mjs for why this loads the raw static
// bundle via a webpack-ignored dynamic import instead of `import "maplibre-gl"`
// directly: webpack's transform of the main-thread bundle breaks the
// worker message protocol (isSourceLoaded()/queryRenderedFeatures() never
// resolve, even though rendering looks fine), verified against a static,
// non-webpack repro of the same version.
let modulePromise: Promise<typeof MapLibreGL> | null = null;

// A non-literal specifier keeps TypeScript from trying (and failing) to
// resolve this as a normal module — it falls back to `Promise<any>`, which
// we then cast to the real types below.
const MAPLIBRE_BUNDLE_URL = "/maplibre/maplibre-gl.mjs";

export function loadMaplibreGl(): Promise<typeof MapLibreGL> {
  if (!modulePromise) {
    modulePromise = import(/* webpackIgnore: true */ MAPLIBRE_BUNDLE_URL).then((mod) => {
      const maplibregl = mod as typeof MapLibreGL;
      maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      return maplibregl;
    });
  }
  return modulePromise;
}
