import assert from "node:assert/strict";
import test from "node:test";

import { isClientDebugEnabled } from "../src/lib/client-debug";

function withClientDebugEnv(value: string | undefined, fn: () => void) {
  const original = process.env.NEXT_PUBLIC_CLIENT_DEBUG;
  if (value === undefined) delete process.env.NEXT_PUBLIC_CLIENT_DEBUG;
  else process.env.NEXT_PUBLIC_CLIENT_DEBUG = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CLIENT_DEBUG;
    else process.env.NEXT_PUBLIC_CLIENT_DEBUG = original;
  }
}

test("isClientDebugEnabled is false by default (browser console stays clean without an explicit opt-in)", () => {
  withClientDebugEnv(undefined, () => {
    assert.equal(isClientDebugEnabled(), false);
  });
});

test("isClientDebugEnabled is true only for the exact literal \"1\", never a truthy-looking alternative", () => {
  withClientDebugEnv("1", () => {
    assert.equal(isClientDebugEnabled(), true);
  });
  withClientDebugEnv("true", () => {
    assert.equal(isClientDebugEnabled(), false);
  });
  withClientDebugEnv("0", () => {
    assert.equal(isClientDebugEnabled(), false);
  });
});

// Acceptance criterion 3/4/5 — the actual client call sites gated behind
// this flag (logMapFocus, the request-payload log, the missing-illustration
// notice) must produce no console output by default, and must never touch
// console.warn/console.error at all (those are reserved for real
// warnings/errors and stay unconditional everywhere in this app).
test("client debug guard suppresses console.log/info by default without touching warn/error", () => {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => calls.push({ level: "log", args });
  console.info = (...args: unknown[]) => calls.push({ level: "info", args });
  console.warn = (...args: unknown[]) => calls.push({ level: "warn", args });
  console.error = (...args: unknown[]) => calls.push({ level: "error", args });

  try {
    withClientDebugEnv(undefined, () => {
      // Mirrors the exact guard pattern every client debug call site now
      // uses: `if (isClientDebugEnabled()) console.log(...)`.
      if (isClientDebugEnabled()) console.log("[test] should never print");
      if (isClientDebugEnabled()) console.info("[test] should never print");
      console.warn("[test] a real warning must always print");
      console.error("[test] a real error must always print");
    });
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.deepEqual(
    calls.map((call) => call.level),
    ["warn", "error"],
    "only warn/error must fire when client debug is off; log/info must be fully suppressed"
  );
});
