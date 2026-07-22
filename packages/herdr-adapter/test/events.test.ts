import assert from "node:assert/strict";
import test from "node:test";
import { HERDR_EVENT_TYPES } from "../src/client/types.js";
import { EVENT_POLICY } from "../src/events.js";

test("event policy classifies every pinned Herdr event variant", () => {
  assert.equal(Object.keys(EVENT_POLICY).length, HERDR_EVENT_TYPES.length);
  for (const eventType of HERDR_EVENT_TYPES) assert.ok(EVENT_POLICY[eventType]);
});
