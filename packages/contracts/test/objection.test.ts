import assert from "node:assert/strict";
import test from "node:test";
import { isLegalObjectionTransition } from "../src/index.js";

test("objection transition table rejects illegal closure", () => {
  assert.equal(isLegalObjectionTransition("open", "resolved"), true);
  assert.equal(isLegalObjectionTransition("superseded", "open"), false);
});
