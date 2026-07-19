import assert from "node:assert/strict";
import test from "node:test";
import { encodeToon, parseToon } from "../src/index.js";

test("TOON round trips deterministic objects", () => {
  const value = { z: "last", nested: { ok: true, count: 2 }, items: [{ id: "one" }, { id: "two" }] };
  const encoded = encodeToon(value);
  assert.equal(encoded, encodeToon(value));
  assert.deepEqual(parseToon(encoded), value);
});
