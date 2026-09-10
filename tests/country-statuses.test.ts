import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadEffectiveCountryStatuses } from "../src/lib/server/country-statuses";

// Noon UTC — every timezone we test with is on 2026-09-10 at this instant.
const NOW = new Date("2026-09-10T12:00:00Z");

interface FakeItineraryRow {
  iso_a2: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  archived?: boolean;
}
interface FakeCountryRow {
  id: string;
  name: string;
  iso_a2: string;
  iso_a3: string | null;
  status: "visited" | "planned" | "not_visited";
}

// Minimal stand-in for the two query chains loadEffectiveCountryStatuses
// issues: `.from("countries").select(...).order(...)` and
// `.from("country_itineraries").select(...).is(...)` — both awaited.
function fakeSupabase(countries: FakeCountryRow[], itineraries: FakeItineraryRow[]) {
  return {
    from(table: string) {
      const result = table === "countries" ? { data: countries, error: null } : { data: itineraries, error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => Promise.resolve(result),
        is: () => Promise.resolve(result),
      };
      return chain;
    },
  } as never;
}

const JP: FakeCountryRow = { id: "c-jp", name: "יפן", iso_a2: "JP", iso_a3: "JPN", status: "not_visited" };

// A. no trips -> NOT_VISITED (falls back to the stored column, which is not_visited)
test("loadEffectiveCountryStatuses: a country with no trips is not_visited", async () => {
  const [row] = await loadEffectiveCountryStatuses(fakeSupabase([JP], []), NOW);
  assert.equal(row.effectiveStatus, "not_visited");
  assert.equal(row.hasTrips, false);
});

// A'. no trips but manual status set -> the manual fallback is used
test("loadEffectiveCountryStatuses: a trip-less country keeps its manual status as the fallback", async () => {
  const [row] = await loadEffectiveCountryStatuses(fakeSupabase([{ ...JP, status: "visited" }], []), NOW);
  assert.equal(row.effectiveStatus, "visited");
  assert.equal(row.hasTrips, false);
});

// B. future trip -> PLANNED
test("loadEffectiveCountryStatuses: a future trip makes the country planned", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2027-01-01", end_date: "2027-01-10", status: "upcoming" }]),
    NOW
  );
  assert.equal(row.effectiveStatus, "planned");
  assert.equal(row.hasTrips, true);
});

// C. trip starts today -> VISITED
test("loadEffectiveCountryStatuses: a trip starting today is visited, not planned", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2026-09-10", end_date: "2026-09-20", status: "upcoming" }]),
    NOW
  );
  assert.equal(row.effectiveStatus, "visited");
});

// D. currently active -> VISITED
test("loadEffectiveCountryStatuses: an active (in-progress) trip is visited", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2026-09-01", end_date: "2026-09-15", status: "active" }]),
    NOW
  );
  assert.equal(row.effectiveStatus, "visited");
});

// E. completed -> VISITED
test("loadEffectiveCountryStatuses: a completed past trip is visited", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2025-01-01", end_date: "2025-01-10", status: "completed" }]),
    NOW
  );
  assert.equal(row.effectiveStatus, "visited");
});

// F. past + future -> VISITED (precedence: a future trip never downgrades)
test("loadEffectiveCountryStatuses: past + future trips resolve to visited", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [
      { iso_a2: "JP", start_date: "2025-01-01", end_date: "2025-01-10", status: "completed" },
      { iso_a2: "JP", start_date: "2027-06-01", end_date: "2027-06-10", status: "upcoming" },
    ]),
    NOW
  );
  assert.equal(row.effectiveStatus, "visited");
});

// G. two future trips -> PLANNED
test("loadEffectiveCountryStatuses: two future trips resolve to planned", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [
      { iso_a2: "JP", start_date: "2027-01-01", end_date: "2027-01-10", status: "upcoming" },
      { iso_a2: "JP", start_date: "2028-01-01", end_date: "2028-01-10", status: "upcoming" },
    ]),
    NOW
  );
  assert.equal(row.effectiveStatus, "planned");
});

// H. "delete the only future trip" — modeled by passing the post-deletion set
test("loadEffectiveCountryStatuses: with the future trip removed, a trip-less country reverts to not_visited", async () => {
  const [row] = await loadEffectiveCountryStatuses(fakeSupabase([JP], []), NOW);
  assert.equal(row.effectiveStatus, "not_visited");
});

// I. destination change A -> B: A loses its only trip, B gains a future one
test("loadEffectiveCountryStatuses: moving a future trip's destination recomputes BOTH countries", async () => {
  const FR: FakeCountryRow = { id: "c-fr", name: "צרפת", iso_a2: "FR", iso_a3: "FRA", status: "not_visited" };
  const rows = await loadEffectiveCountryStatuses(
    fakeSupabase([JP, FR], [{ iso_a2: "FR", start_date: "2027-01-01", end_date: "2027-01-10", status: "upcoming" }]),
    NOW
  );
  const jp = rows.find((r) => r.iso_a2 === "JP")!;
  const fr = rows.find((r) => r.iso_a2 === "FR")!;
  assert.equal(jp.effectiveStatus, "not_visited", "old destination no longer has the trip");
  assert.equal(fr.effectiveStatus, "planned", "new destination gains the future trip");
});

// K. local-date boundary — a trip starting "today" is visited regardless of
// the raw UTC instant (server uses destination-local calendar dates).
test("loadEffectiveCountryStatuses: today's boundary uses the destination-local calendar date", async () => {
  // 23:00 UTC on the 9th is already the 10th in Japan (UTC+9).
  const lateUtc = new Date("2026-09-09T23:00:00Z");
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2026-09-10", end_date: "2026-09-20", status: "upcoming" }]),
    lateUtc
  );
  assert.equal(row.effectiveStatus, "visited", "startDate 2026-09-10 <= Japan-local today (already the 10th) -> visited");
});

// J/L. canonical country identity — trips are grouped by ISO A2 (uppercased),
// never by the Hebrew display name.
test("loadEffectiveCountryStatuses: trips group by canonical ISO A2, not by display name", async () => {
  const [row] = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [
      { iso_a2: "jp", start_date: "2025-01-01", end_date: "2025-01-10", status: "completed" }, // lowercase iso
      { iso_a2: "JP", start_date: "2027-01-01", end_date: "2027-01-10", status: "upcoming" },
    ]),
    NOW
  );
  assert.equal(row.effectiveStatus, "visited", "one country identity, VISITED wins precedence");
});

// 11. the returned shape carries effectiveStatus + hasTrips
test("loadEffectiveCountryStatuses: every returned row carries effectiveStatus and hasTrips", async () => {
  const rows = await loadEffectiveCountryStatuses(
    fakeSupabase([JP], [{ iso_a2: "JP", start_date: "2027-01-01", end_date: "2027-01-10", status: "upcoming" }]),
    NOW
  );
  assert.ok(rows.every((r) => typeof r.effectiveStatus === "string" && typeof r.hasTrips === "boolean"));
});

// 12. Client must NOT re-derive authoritative status. world-map.tsx (the
// map fill + sidebar + filters) and dashboard.ts (the "planned" counter)
// must consume the SERVER effectiveStatus only — never call
// deriveCountryMapStatuses / deriveCountryTravelStatus to make the
// business decision. This static guard fails the moment client-side
// re-derivation creeps back in.
test("client honors the server effectiveStatus — world-map.tsx does not re-derive country status from trips", () => {
  const src = readFileSync(path.join(process.cwd(), "src/components/map/world-map.tsx"), "utf8");
  assert.ok(!src.includes("deriveCountryMapStatuses"), "world-map.tsx must not call deriveCountryMapStatuses");
  assert.ok(!src.includes("deriveCountryTravelStatus"), "world-map.tsx must not call deriveCountryTravelStatus");
  assert.ok(src.includes("useMapCountryStatuses"), "world-map.tsx must read the server-computed status hook");
  assert.ok(src.includes(".effectiveStatus"), "world-map.tsx must render the server-provided effectiveStatus field");
});

test("client honors the server effectiveStatus — dashboard.ts counts planned countries from the server field", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/queries/dashboard.ts"), "utf8");
  assert.ok(!src.includes("deriveCountryMapStatuses"), "dashboard.ts must not re-derive country status");
  assert.ok(src.includes("effectiveStatus === \"planned\""), "dashboard.ts counts planned from the server field");
});

test("client honors the server effectiveStatus — country-detail-panel.tsx badge uses the server field and the auto-status sentence is gone", () => {
  const src = readFileSync(path.join(process.cwd(), "src/components/map/country-detail-panel.tsx"), "utf8");
  assert.ok(!src.includes("הסטטוס נקבע אוטומטית"), "the explanatory automatic-status sentence must be removed");
  assert.ok(src.includes("useMapCountryStatuses"), "the panel reads the server-computed status hook");
  assert.ok(src.includes("serverCountryStatus?.effectiveStatus"), "the badge derives from the server effectiveStatus");
});
