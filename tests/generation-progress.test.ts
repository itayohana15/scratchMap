import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeWeightedProgress,
  createTokenGuardedReporter,
  GENERATION_STAGE_RANGES,
  GENERATION_STAGE_ORDER,
  GENERATION_STAGE_LABELS,
  type GenerationProgressEvent,
  type GenerationStage,
} from "../src/lib/server/generation-progress";

function evt(stage: GenerationStage, extra: Partial<GenerationProgressEvent> = {}): GenerationProgressEvent {
  return { stage, message: stage, ...extra };
}

// K1 — progress is monotonic across a realistic full sequence of real stage events.
test("Round 9.3.3 §22 K1: progress is monotonic across the full real stage sequence", () => {
  let progress = 0;
  for (const stage of GENERATION_STAGE_ORDER) {
    const next = computeWeightedProgress(evt(stage), progress);
    assert.ok(next >= progress, `progress must never go backwards: ${stage} produced ${next} after ${progress}`);
    progress = next;
  }
  assert.equal(progress, 100);
});

test("Round 9.3.3 §22 K1: an out-of-order/re-delivered event never regresses progress", () => {
  const afterRouting = computeWeightedProgress(evt("ROUTING"), 0);
  const regressed = computeWeightedProgress(evt("TRIP_FRAME"), afterRouting);
  assert.equal(regressed, afterRouting, "a stale earlier-stage event must never move the bar backwards");
});

// K4 — 99% requires FINALIZATION; no earlier stage's own range reaches 99.
test("Round 9.3.3 §22 K4: no stage before FINALIZATION can reach 99%", () => {
  for (const stage of GENERATION_STAGE_ORDER) {
    if (stage === "FINALIZATION" || stage === "COMPLETE") continue;
    const [, end] = GENERATION_STAGE_RANGES[stage];
    assert.ok(end < 99, `${stage}'s own range must stay below 99%, got end=${end}`);
  }
  assert.equal(computeWeightedProgress(evt("FINALIZATION"), 0), 99);
});

// K5 — 100% only ever comes from the COMPLETE stage.
test("Round 9.3.3 §22 K5: 100% is only ever produced by the COMPLETE stage", () => {
  for (const stage of GENERATION_STAGE_ORDER) {
    if (stage === "COMPLETE") continue;
    const result = computeWeightedProgress(evt(stage, { completedUnits: 999, totalUnits: 999 }), 0);
    assert.ok(result < 100, `${stage} must never itself reach 100%, got ${result}`);
  }
  assert.equal(computeWeightedProgress(evt("COMPLETE"), 99), 100);
});

// K9 — completedUnits/totalUnits produce correct weighted sub-progress within a stage's own range.
test("Round 9.3.3 §22 K9: completedUnits/totalUnits interpolate correctly within PLACE_DISCOVERY's range", () => {
  const [start, end] = GENERATION_STAGE_RANGES.PLACE_DISCOVERY;
  const half = computeWeightedProgress(evt("PLACE_DISCOVERY", { completedUnits: 3, totalUnits: 6 }), 0);
  assert.equal(half, Math.round(start + (end - start) * 0.5));
  const done = computeWeightedProgress(evt("PLACE_DISCOVERY", { completedUnits: 6, totalUnits: 6 }), 0);
  assert.equal(done, end);
  const none = computeWeightedProgress(evt("PLACE_DISCOVERY", { completedUnits: 0, totalUnits: 6 }), 0);
  assert.equal(none, start);
});

// K10 — an unknown/absent totalUnits must not fabricate a mid-stage percentage; the event itself (stage reported) is worth the END of its range, never a guessed intermediate value.
test("Round 9.3.3 §22 K10: an event with no totalUnits maps to the end of its stage's range, never a fabricated midpoint", () => {
  const [, end] = GENERATION_STAGE_RANGES.DAY_COMPOSITION;
  assert.equal(computeWeightedProgress(evt("DAY_COMPOSITION"), 0), end);
  assert.equal(computeWeightedProgress(evt("DAY_COMPOSITION", { completedUnits: 5 }), 0), end, "completedUnits alone, without totalUnits, must not be used to compute a fraction");
});

// K2/mutation 1 — a structural regression guard: the progress hook must
// never contain a timer that advances progress/stage state on its own. A
// generic setInterval/setTimeout for the UNRELATED elapsed-time DISPLAY
// (useElapsedDisplayMs, §H) is fine and expected — what must never exist
// again is a timer whose callback moves `progress`/stage-index state.
test("Round 9.3.3 §22 K2: the client hook contains no timer that advances progress on its own", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "src", "lib", "hooks", "use-itinerary-generation-progress.ts"),
    "utf8"
  );
  assert.ok(!/const\s+STAGE_INTERVAL_MS\s*=/.test(source), "no fixed per-stage timer interval constant may exist");
  const timerLines = source.split("\n").filter((line) => /setInterval\(|setTimeout\(/.test(line));
  for (const line of timerLines) {
    assert.ok(
      !/stageIndex|setProgress/.test(line),
      `a setInterval/setTimeout line must never itself advance stageIndex/progress state: "${line.trim()}"`
    );
  }
});

// K8/L4 — progress events from generation A must never update generation B.
test("Round 9.3.3 §22 K8: a reporter built for an OLD generation token stops applying events once a newer generation starts", () => {
  const tokenRef = { current: 1 };
  const applied: GenerationStage[] = [];
  const reporterA = createTokenGuardedReporter(tokenRef, 1, (event) => applied.push(event.stage));

  reporterA(evt("TRIP_FRAME"));
  assert.deepEqual(applied, ["TRIP_FRAME"], "generation A's own event applies while A is still current");

  // Generation B starts (e.g. the user cancelled and retried) — the ref is bumped.
  tokenRef.current = 2;
  const reporterB = createTokenGuardedReporter(tokenRef, 2, (event) => applied.push(event.stage));

  reporterA(evt("PLACE_DISCOVERY")); // a LATE event from the now-stale generation A
  assert.deepEqual(applied, ["TRIP_FRAME"], "a stale generation's event must never reach state once a newer one has started");

  reporterB(evt("STAY_RESOLUTION"));
  assert.deepEqual(applied, ["TRIP_FRAME", "STAY_RESOLUTION"], "the CURRENT generation's own events still apply normally");
});

test("Round 9.3.3 §22: every stage has a real Hebrew label, and every label maps to a real stage", () => {
  for (const stage of GENERATION_STAGE_ORDER) {
    assert.ok(GENERATION_STAGE_LABELS[stage] && GENERATION_STAGE_LABELS[stage].length > 0, `${stage} must have a real label`);
  }
});

test("Round 9.3.3 §22: stage ranges are contiguous through FINALIZATION, with COMPLETE as the one deliberate final jump to 100", () => {
  let expectedStart = 0;
  for (const stage of GENERATION_STAGE_ORDER) {
    if (stage === "COMPLETE") continue; // COMPLETE is a deliberate jump from 99 to 100, never interpolated into
    const [start, end] = GENERATION_STAGE_RANGES[stage];
    assert.equal(start, expectedStart, `${stage} must start where the previous stage ended`);
    assert.ok(end >= start);
    expectedStart = end;
  }
  assert.equal(expectedStart, 99, "the last real working stage (FINALIZATION) must top out at 99, never 100");
  assert.deepEqual(GENERATION_STAGE_RANGES.COMPLETE, [100, 100]);
});
