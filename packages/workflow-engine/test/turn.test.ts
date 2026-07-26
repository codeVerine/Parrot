import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeSignalSchema } from "@platform/contracts";
import { initialFoldedState, reduceTurn } from "../src/index.js";
import { createEngine, deadlineSignal, eventKinds, resultSeenSignal, sampleTurn, seedWorkflow, turnState } from "./helpers.js";

test("turn transitions: created → sent → waiting → validating → completed", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  assert.equal(turnState(store, "turn-1"), "created");
  engine.markDelivered("turn-1");
  assert.equal(turnState(store, "turn-1"), "waiting");
  assert.equal(engine.handleSignal(resultSeenSignal()).accepted, true);
  assert.equal(turnState(store, "turn-1"), "validating");
  engine.applyValidation({ turnId: "turn-1", outcome: "success", resultHash: "cd".repeat(32) });
  assert.equal(turnState(store, "turn-1"), "completed");
  assert.ok(eventKinds(store).includes("TurnCompleted"));
});

test("first validation failure repairs; second fails the turn", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  engine.handleSignal(resultSeenSignal());
  engine.applyValidation({ turnId: "turn-1", outcome: "failure", reason: "schema" });
  assert.equal(turnState(store, "turn-1"), "waiting");
  assert.equal(store.readRows("turns")[0].attempt, "repair");
  engine.handleSignal(resultSeenSignal({ signalId: "signal-result-2", contentHash: "ef".repeat(32) }));
  engine.applyValidation({ turnId: "turn-1", outcome: "failure", reason: "schema-again" });
  assert.equal(turnState(store, "turn-1"), "failed");
  assert.ok(eventKinds(store).includes("TurnFailed"));
});

test("deadline expiry times out a waiting turn", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  assert.equal(engine.handleSignal(deadlineSignal()).accepted, true);
  assert.equal(turnState(store, "turn-1"), "timed_out");
  assert.ok(eventKinds(store).includes("AgentTimedOut"));
});

test("cancel from waiting marks cancelled", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  engine.cancelTurn("turn-1");
  assert.equal(turnState(store, "turn-1"), "cancelled");
});

test("illegal transitions are rejected with no events", () => {
  const folded = initialFoldedState("workflow-1");
  const turn = { ...sampleTurn(), state: "completed" as const };
  const result = reduceTurn(folded, {
    type: "resultSeen",
    turn,
    artifactPath: "x",
    contentHash: "ab".repeat(32),
  });
  // completed is not an orphan source; illegal
  assert.equal(result.accepted, false);
  assert.equal(result.effects.length, 0);
});

test("orphan result after failed/timed_out/cancelled emits OrphanResultSeen", () => {
  for (const terminal of ["failed", "timed_out", "cancelled"] as const) {
    const { store, engine } = createEngine();
    seedWorkflow(engine);
    engine.startTurn(sampleTurn({ turnId: `turn-${terminal}` }));
    engine.markDelivered(`turn-${terminal}`);
    if (terminal === "timed_out") {
      engine.handleSignal(deadlineSignal({ turnId: `turn-${terminal}` }));
    } else if (terminal === "cancelled") {
      engine.cancelTurn(`turn-${terminal}`);
    } else {
      engine.handleSignal(RuntimeSignalSchema.parse({
        signalId: `fault-${terminal}`,
        observedAt: "2026-07-22T10:01:00.000Z",
        source: "adapter_internal",
        classification: "fault",
        kind: "TurnDeliveryFailed",
        workflowId: "workflow-1",
        iterationId: "iteration-1",
        turnId: `turn-${terminal}`,
        agentId: "agent-1",
        reason: "transport_error",
        attempt: "primary",
        rawError: "boom",
      }));
    }
    assert.equal(turnState(store, `turn-${terminal}`), terminal);
    const before = eventKinds(store).filter((kind) => kind === "OrphanResultSeen").length;
    const accepted = engine.handleSignal(resultSeenSignal({
      signalId: `orphan-${terminal}`,
      turnId: `turn-${terminal}`,
      contentHash: "11".repeat(32),
    }));
    assert.equal(accepted.accepted, true);
    assert.equal(turnState(store, `turn-${terminal}`), terminal);
    assert.equal(eventKinds(store).filter((kind) => kind === "OrphanResultSeen").length, before + 1);
    assert.equal(store.readRows("artifacts").some((row) => String(row.kind) === "orphan_result"), true);
  }
});

test("duplicate ResultFileSeen correlation is a no-op", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  engine.handleSignal(resultSeenSignal());
  assert.equal(turnState(store, "turn-1"), "validating");
  const again = engine.handleSignal(resultSeenSignal({ signalId: "signal-result-dup" }));
  assert.equal(again.accepted, true);
  assert.equal(again.reason, "duplicate_correlation");
  assert.equal(turnState(store, "turn-1"), "validating");
});

test("startTurn rejects duplicate turn IDs", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  assert.throws(() => engine.startTurn(sampleTurn()), { message: /already exists/ });
  // Original turn remains unchanged
  const row = store.getTurn("turn-1");
  assert.equal(String(row?.state), "created");
});
