// Rasterizes the 4x3 SVG flags from the flag-icons package into PNG static
// assets under public/flags/, keyed by lowercase ISO 3166-1 alpha-2 code
// (matching flag-icons' own naming). Used as MapLibre fill-pattern textures
// for countries the user has marked visited/planned (see
// use-maplibre-map.ts). PNG rather than SVG: confirmed via a direct browser
// test that MapLibre's map.loadImage() fails to decode SVG sources in this
// app ("The source image could not be decoded") even though the browser can
// render SVGs everywhere else — createImageBitmap() support for SVG is
// inconsistent enough that pre-rasterizing is the reliable path.
// Re-run after any flag-icons version bump.
import { mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "node_modules", "flag-icons", "flags", "4x3");
const outDir = path.join(__dirname, "..", "public", "flags");

// Small enough to tile cheaply across many small countries, sharp enough to
// read clearly when a large country (e.g. Russia, Canada) tiles it larger.
const WIDTH = 160;
const HEIGHT = 120;

await mkdir(outDir, { recursive: true });
const files = (await readdir(srcDir)).filter((f) => f.endsWith(".svg"));

await Promise.all(
  files.map((file) => {
    const iso = path.basename(file, ".svg");
    return sharp(path.join(srcDir, file))
      .resize(WIDTH, HEIGHT)
      .png()
      .toFile(path.join(outDir, `${iso}.png`));
  })
);

console.log(`Rasterized ${files.length} flag icons to ${path.relative(process.cwd(), outDir)}`);
