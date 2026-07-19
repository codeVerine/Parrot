import assert from "node:assert/strict";
import test from "node:test";
import { TurnDeadlineManager } from "../src/deadline.js";

test("restart reconstructs timers from persisted deadline records", async () => {
  const first: unknown[] = []; const original = new TurnDeadlineManager((signal) => first.push(signal));
  original.arm("turn-1", new Date(Date.now() + 20), "primary"); const persisted = original.snapshot(); original.dispose();
  const restarted: unknown[] = []; const next = new TurnDeadlineManager((signal) => restarted.push(signal), persisted); await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(restarted.length, 1); next.dispose();
});
