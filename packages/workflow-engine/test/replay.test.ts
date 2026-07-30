import assert from "node:assert/strict";
import test from "node:test";
import { foldEvents, foldReducer, initialFoldedState, withWorkflowConfig } from "../src/index.js";
import { createEngine, eventKinds, resultSeenSignal, sampleTurn, seedWorkflow, turnState } from "./helpers.js";

test("fold twice over the same log yields identical state", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-1",
    severity: "blocking",
    iterationId: "iteration-1",
  });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "m1", inputTokens: 1, outputTokens: 2, cost: 0.3 });
  engine.resolveObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", resolution: "done" });
  const events = store.listEvents({ workflowId: "workflow-1" }).map((entry) => entry.event);
  const a = foldEvents(events, initialFoldedState("workflow-1"));
  const b = foldEvents(events, initialFoldedState("workflow-1"));
  assert.deepEqual(a, b);
  assert.equal(a.spendTotal, 0.3);
  assert.equal(a.objections["OBJ-1"]?.status, "resolved");
});

test("recover mid-turn leaves waiting turn and restores folded spend", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.submitUsage({ workflowId: "workflow-1", messageId: "m1", inputTokens: 1, outputTokens: 1, cost: 0.7 });
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  assert.equal(turnState(store, "turn-1"), "waiting");
  const recovered = engine.recover("workflow-1");
  assert.equal(recovered.state.spendTotal, 0.7);
  assert.equal(recovered.pendingDeadlines.length, 1);
  assert.equal(recovered.pendingDeadlines[0]?.turnId, "turn-1");
});

test("random valid signal sequences never emit events after terminal turn for orphans only once per hash", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  engine.cancelTurn("turn-1");
  const hashes = ["aa".repeat(32), "bb".repeat(32), "aa".repeat(32)];
  for (const [index, contentHash] of hashes.entries()) {
    engine.handleSignal(resultSeenSignal({
      signalId: `orphan-${index}`,
      contentHash,
    }));
  }
  const orphans = eventKinds(store).filter((kind) => kind === "OrphanResultSeen");
  assert.equal(orphans.length, 2);
});

test("reraiseCount increments only across a resolved status, and replay reproduces it exactly", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.raiseObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", severity: "major", iterationId: "iteration-1" });
  engine.raiseObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", severity: "major", iterationId: "iteration-1" });
  assert.equal(engine.getState("workflow-1").objections["OBJ-1"]?.reraiseCount, 0);

  engine.resolveObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", resolution: "addressed by planner" });
  engine.raiseObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", severity: "major", iterationId: "iteration-2" });
  assert.equal(engine.getState("workflow-1").objections["OBJ-1"]?.reraiseCount, 1);

  const events = store.listEvents({ workflowId: "workflow-1" }).map((entry) => entry.event);
  const replayed = foldEvents(events, initialFoldedState("workflow-1"));
  assert.equal(replayed.objections["OBJ-1"]?.reraiseCount, 1);
  assert.equal(replayed.objections["OBJ-1"]?.status, "open");
});

test("rehydrateFromSnapshot defaults a pre-Phase-9 objection's reraiseCount to 0", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  store.saveWorkflow({
    workflowId: "workflow-1",
    workspaceId: "workspace-1",
    status: "running",
    task: "Plan the feature",
    config: withWorkflowConfig({}),
    state: {
      workflowId: "workflow-1",
      phase: "objection_gate",
      iterationCount: 1,
      spendTotal: 0,
      objections: { "OBJ-1": { objectionId: "OBJ-1", severity: "major", status: "open" } },
      frontierBlocking: false,
      consensusReached: false,
      humanDecision: null,
      degradedMode: false,
      orphanLinks: [],
      budgetCapReached: false,
      iterationCapReached: false,
    },
  });
  const rehydrated = engine.rehydrateFromSnapshot("workflow-1");
  assert.equal(rehydrated.phase, "objection_gate");
  assert.equal(rehydrated.objections["OBJ-1"]?.reraiseCount, 0);
});

test("foldReducer is referentially transparent for UsageRecorded duplicates", () => {
  let state = initialFoldedState("workflow-1");
  const event = {
    eventId: "e1",
    occurredAt: "2026-07-22T10:00:00.000Z",
    workflowId: "workflow-1",
    kind: "UsageRecorded" as const,
    payload: { messageId: "x", inputTokens: 1, outputTokens: 1, cost: 2 },
  };
  state = foldReducer(state, event);
  const again = foldReducer(state, event);
  assert.equal(again.spendTotal, 2);
  assert.equal(again.seenUsageMessageIds.length, 1);
});
