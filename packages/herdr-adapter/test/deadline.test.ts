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

test("onExpire can suppress DeadlineExpired by re-arming", async () => {
  const signals: RuntimeSignal[] = [];
  let fires = 0;
  const manager = new TurnDeadlineManager(
    (signal) => signals.push(signal),
    [],
    (turnId, _deadline, attempt) => {
      fires += 1;
      if (fires === 1) {
        manager.arm(turnId, new Date(Date.now() + 15), attempt);
        return;
      }
      manager.emitExpired(turnId, new Date(), attempt);
    },
  );
  manager.arm("turn-rearm", new Date(Date.now() + 10), "primary");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fires, 2);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.kind, "DeadlineExpired");
  manager.dispose();
});
