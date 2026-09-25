import assert from "node:assert/strict";
import test from "node:test";

import { isolateText } from "../src/lib/bidi-text";

const FSI = "⁦";
const PDI = "⁩";

test("Round 9.10: isolateText wraps the value with FSI/PDI and never touches the underlying characters", () => {
  assert.equal(isolateText("Bar Harbor"), `${FSI}Bar Harbor${PDI}`);
});

test("Round 9.10: isolateText never reorders a multi-word English name", () => {
  const result = isolateText("North Conway");
  const inner = result.slice(FSI.length, result.length - PDI.length);
  assert.equal(inner, "North Conway", "internal word order must be untouched — never 'Conway North'");
});

test("Round 9.10: isolateText is a no-op on the visible characters for a Hebrew name", () => {
  const result = isolateText("בוסטון");
  const inner = result.slice(FSI.length, result.length - PDI.length);
  assert.equal(inner, "בוסטון");
});

test("Round 9.10: isolateText preserves numbers, punctuation, and mixed content exactly", () => {
  for (const value of ["09:00", "₪15,015", "Route 66 Diner", "Ben & Jerry's", "Cambridge, MA"]) {
    const result = isolateText(value);
    const inner = result.slice(FSI.length, result.length - PDI.length);
    assert.equal(inner, value);
  }
});

test("Round 9.10: isolateText adds no visible characters (only the two invisible isolate marks)", () => {
  const value = "Providence → Bar Harbor";
  const result = isolateText(value);
  assert.equal(result.length, value.length + 2);
});

test("Round 9.10: isolateText on an empty string is safe and reversible", () => {
  assert.equal(isolateText(""), `${FSI}${PDI}`);
});
