import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSignal } from "@platform/contracts";
import { TurnDeadlineManager } from "../src/deadline.js";

test("deadline emits a repair-scoped observation and can be re-derived", async () => {
  const signals: RuntimeSignal[] = [];
  const manager = new TurnDeadlineManager((signal) => signals.push(signal));
  manager.arm("turn-1", new Date(Date.now() + 10), "repair");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signals[0]?.kind, "DeadlineExpired");
  assert.equal(signals[0]?.attempt, "repair");
  manager.dispose();
});
