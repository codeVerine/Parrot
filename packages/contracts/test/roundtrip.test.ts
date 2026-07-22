import assert from "node:assert/strict";
import test from "node:test";
import { encodeToon, parseToon } from "../src/index.js";

test("TOON round trips deterministic objects", () => {
  const value = { z: "last", nested: { ok: true, count: 2 }, items: [{ id: "one" }, { id: "two" }] };
  const encoded = encodeToon(value);
  assert.equal(encoded, encodeToon(value));
  assert.deepEqual(parseToon(encoded), value);
});

test("TOON uses one canonical order and preserves quoted primitive arrays", () => {
  const value = {
    z: "last",
    alternatives: ["a,b", "1e-7", "true", "plain"],
    small: 1e-7,
    large: 1e21,
  };

  const encoded = encodeToon(value);

  assert.equal(encoded.split("\n")[0], 'alternatives[4]: "a,b","1e-7","true",plain');
  assert.deepEqual(parseToon(encoded), value);
});

test("TOON supports tabular arrays and validates their shape", () => {
  const value = { rows: [{ name: "Ada", note: "a,b" }, { name: "Lin", note: "plain" }] };
  const encoded = encodeToon(value);

  assert.match(encoded, /rows\[2\]\{name,note\}:/);
  assert.deepEqual(parseToon(encoded), value);
  assert.throws(() => parseToon('values[2]: "a,b"'), /Expected 2 array entries, got 1/);
});
