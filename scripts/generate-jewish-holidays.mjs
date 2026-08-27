// Precomputes Jewish/Israeli holiday dates into a static JSON data file.
//
// Why precomputed instead of calling @hebcal/core at runtime: @hebcal/core
// is an ESM-only package (no "require" export condition), but this
// project's test suite compiles a subset of src/lib to CommonJS via
// tsconfig.itinerary-tests.json for headless `node --test` execution.
// require()-ing an ESM-only package there throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// Rather than complicate the test build, we run the real computation once,
// here, in a plain ESM Node script (dynamic import works fine), and check in
// the result — the same "precomputed static facts data" pattern this project
// already uses for src/lib/facts/country-facts-data.json.
//
// Re-run after installing/upgrading @hebcal/core, or to extend the year range:
//   node scripts/generate-jewish-holidays.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { HebrewCalendar } = await import("@hebcal/core");

const START_YEAR = 2023;
const END_YEAR = 2036;

const HOLIDAY_RULES = [
  { prefix: "Rosh Hashana", nameHe: "ראש השנה", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Yom Kippur", nameHe: "יום כיפור", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Sukkot", nameHe: "סוכות", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Shmini Atzeret", nameHe: "שמחת תורה", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Chanukah", nameHe: "חנוכה", categories: ["jewish_holiday"] },
  { prefix: "Purim", nameHe: "פורים", categories: ["jewish_holiday"] },
  { prefix: "Pesach", nameHe: "פסח", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Shavuot", nameHe: "שבועות", categories: ["jewish_holiday", "israeli_public_holiday"] },
  { prefix: "Yom HaAtzma", nameHe: "יום העצמאות", categories: ["israeli_public_holiday"] },
  { prefix: "Yom HaZikaron", nameHe: "יום הזיכרון", categories: ["israeli_public_holiday"] },
];

// Exact descriptions that share a prefix with a real holiday above but are
// actually distinct, minor/regional observances — verified by dumping every
// unique description hebcal returns across 2023-2036 for each prefix and
// checking each one individually (see git history of this script):
// "Rosh Hashana LaBehemot" (new year for animal tithes, Elul 1, not the real
// Rosh Hashana), "Pesach Sheni" ("second Passover", a minor day a month
// after Pesach), "Purim Katan"/"Purim Meshulash" (minor Adar-I/walled-city
// variants, not the main Purim).
const EXCLUDED_DESCRIPTIONS = new Set([
  "Rosh Hashana LaBehemot",
  "Pesach Sheni",
  "Purim Katan",
  "Purim Meshulash",
]);

function matchRule(description) {
  if (EXCLUDED_DESCRIPTIONS.has(description)) return undefined;
  return HOLIDAY_RULES.find((rule) => description.startsWith(rule.prefix));
}

const byDate = new Map();

for (let year = START_YEAR; year <= END_YEAR; year += 1) {
  const events = HebrewCalendar.calendar({
    year,
    isHebrewYear: false,
    il: true,
    noMinorFast: true,
    noRoshChodesh: true,
    noSpecialShabbat: true,
    noModern: false,
  });

  for (const event of events) {
    const description = event.getDesc();
    if (description.startsWith("Erev ") || description.includes("CH''M") || description.includes("Sof Zman")) continue;
    const rule = matchRule(description);
    if (!rule) continue;

    const isoDate = event.getDate().greg().toISOString().slice(0, 10);
    const existing = byDate.get(isoDate);
    if (existing) {
      existing.categories = [...new Set([...existing.categories, ...rule.categories])];
    } else {
      byDate.set(isoDate, { date: isoDate, nameHe: rule.nameHe, categories: rule.categories });
    }
  }
}

const result = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "..", "src", "lib", "facts", "jewish-holidays-data.json");
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

console.log(`Wrote ${result.length} holiday entries (${START_YEAR}-${END_YEAR}) to ${outPath}`);
