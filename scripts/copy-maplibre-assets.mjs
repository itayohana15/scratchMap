// MapLibre GL JS v6 ships only as ES modules, split across a main bundle
// (maplibre-gl.mjs), a shared chunk it imports (maplibre-gl-shared.mjs),
// and a separate worker bundle (maplibre-gl-worker.mjs) that also imports
// the shared chunk. Two problems surface when webpack (via Next.js)
// bundles these from node_modules instead of the browser loading them
// directly:
//   1. The worker's import.meta.url-relative URL can't be resolved by
//      webpack, so maplibregl.setWorkerUrl() must point at a real URL.
//   2. Even with (1) fixed, webpack's transform of the *main*-thread
//      bundle breaks the actor/worker message protocol in some subtle
//      way: sources report `isSourceLoaded() === false` forever and
//      `queryRenderedFeatures()`/click hit-testing return nothing, even
//      though the layer paints correctly on screen.
// Verified fix: bypass webpack for all three files — copy them here as
// static assets and load them at runtime via a webpackIgnore'd dynamic
// import() (see lib/map/load-maplibre.ts), so the browser fetches and
// executes the exact same unmodified ESM an isolated (non-webpack) repro
// confirmed works correctly.
// Re-run this after any maplibre-gl version bump.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "node_modules", "maplibre-gl", "dist");
const outDir = path.join(__dirname, "..", "public", "maplibre");

await mkdir(outDir, { recursive: true });
for (const file of ["maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  await copyFile(path.join(srcDir, file), path.join(outDir, file));
}
console.log(`Copied maplibre-gl runtime bundles to ${path.relative(process.cwd(), outDir)}`);
