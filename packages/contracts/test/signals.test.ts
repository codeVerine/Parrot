import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineExpiredSchema, FAULT_KINDS, OBSERVATION_KINDS, RuntimeSignalSchema, SIGNAL_KINDS, SIGNAL_SOURCES } from "../src/index.js";

test("runtime signal taxonomy is complete and disjoint", () => {
  assert.equal(SIGNAL_KINDS.length, 11);
  assert.equal(new Set(SIGNAL_KINDS).size, SIGNAL_KINDS.length);
  assert.equal(new Set([...OBSERVATION_KINDS, ...FAULT_KINDS]).size, SIGNAL_KINDS.length);
  assert.equal(OBSERVATION_KINDS.some((kind) => FAULT_KINDS.includes(kind as never)), false);
  assert.equal(SIGNAL_SOURCES.length, 5);
  const signal = DeadlineExpiredSchema.parse({
    signalId: "sig-1", observedAt: "2026-07-19T00:00:00.000Z", source: "deadline_timer",
    workflowId: null, iterationId: null, turnId: "turn-1", agentId: "agent-1",
    classification: "observation", kind: "DeadlineExpired", deadline: "2026-07-19T00:01:00.000Z", attempt: "primary",
  });
  assert.equal(signal.classification, "observation");
  assert.equal(RuntimeSignalSchema.parse(signal).kind, "DeadlineExpired");
});
