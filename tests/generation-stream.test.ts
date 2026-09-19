import assert from "node:assert/strict";
import test from "node:test";

import { readGenerationStream, ApiRequestError } from "../src/lib/queries/country-itineraries";
import type { GenerationProgressEvent } from "../src/lib/server/generation-progress";

function ndjsonResponse(lines: unknown[], init: { ok?: boolean; status?: number } = {}): Response {
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200 });
}

test("Round 9.3.3 §22: readGenerationStream relays every progress frame to onProgress, in order", async () => {
  const events: GenerationProgressEvent[] = [];
  const response = ndjsonResponse([
    { type: "progress", event: { stage: "INITIALIZING", message: "a" } },
    { type: "progress", event: { stage: "TRIP_FRAME", message: "b" } },
    { type: "result", data: { itinerary: { id: "1" }, success: { ok: true } } },
  ]);
  const result = await readGenerationStream(response, (event) => events.push(event));
  assert.deepEqual(
    events.map((e) => e.stage),
    ["INITIALIZING", "TRIP_FRAME"]
  );
  assert.deepEqual(result, { itinerary: { id: "1" }, success: { ok: true } });
});

test("Round 9.3.3 §22: readGenerationStream throws ApiRequestError from a real error frame, carrying its status/code/message", async () => {
  const response = ndjsonResponse([
    { type: "progress", event: { stage: "INITIALIZING", message: "a" } },
    { type: "error", status: 422, code: "PLAN_NOT_FEASIBLE", message: "לא הצלחנו לבנות מסלול" },
  ]);
  await assert.rejects(
    () => readGenerationStream(response, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "PLAN_NOT_FEASIBLE");
      return true;
    }
  );
});

test("Round 9.3.3 §22: readGenerationStream never resolves successfully if the stream ends with no result frame", async () => {
  const response = ndjsonResponse([{ type: "progress", event: { stage: "INITIALIZING", message: "a" } }]);
  await assert.rejects(() => readGenerationStream(response, () => {}), ApiRequestError);
});

test("Round 9.3.3 §22: a non-200 response falls back to plain JSON error parsing (pre-generation validation failures never stream)", async () => {
  const response = new Response(JSON.stringify({ error: "COUNTRY_NOT_FOUND", message: "No country found." }), {
    status: 404,
  });
  await assert.rejects(
    () => readGenerationStream(response, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "COUNTRY_NOT_FOUND");
      return true;
    }
  );
});

// Round 9.3.5 §18/M — a streamed generation failure commits HTTP headers to
// 200 before the application-level outcome is known; the resulting
// ApiRequestError must carry the REAL transport status (200) distinctly
// from the application-level status/code the error frame reports, so no
// caller ever logs a fabricated "[Itinerary 500]" for what was actually a
// successful HTTP 200 transport.
test("Round 9.3.5 M: a streamed application-level failure keeps httpStatus (200) distinct from the application status/code", async () => {
  const response = ndjsonResponse([
    { type: "error", status: 422, code: "INSUFFICIENT_REAL_ACTIVITY_COVERAGE", message: "Insufficient real-activity coverage" },
  ]);
  await assert.rejects(
    () => readGenerationStream(response, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.httpStatus, 200, "the real wire-level transport status must be preserved as 200");
      assert.equal(error.status, 422, "the application-level status must remain distinct, never overwritten by the transport status");
      assert.equal(error.code, "INSUFFICIENT_REAL_ACTIVITY_COVERAGE");
      return true;
    }
  );
});

test("Round 9.3.5 M: a non-streamed (pre-generation) failure has httpStatus equal to the real HTTP status, never fabricated", async () => {
  const response = new Response(JSON.stringify({ error: "COUNTRY_NOT_FOUND", message: "No country found." }), { status: 404 });
  await assert.rejects(
    () => readGenerationStream(response, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.httpStatus, 404);
      assert.equal(error.status, 404);
      return true;
    }
  );
});
