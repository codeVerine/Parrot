import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EventSchema, eventId } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import {
  initialFoldedState,
  repairPromptPath,
  toPersistedFoldedState,
  WorkflowEngine,
} from "../src/index.js";
import { createEngine, eventKinds, resultSeenSignal, sampleTurn, seedWorkflow, turnState } from "./helpers.js";

test("W1: budget/iteration escalations invoke NotificationSink", async () => {
  const { engine, escalations } = createEngine({ budgetCap: 1, maxIterations: 1 });
  seedWorkflow(engine, { config: { budgetCap: 1, maxIterations: 1 } });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "m1", inputTokens: 1, outputTokens: 1, cost: 1.5 });
  await engine.flush();
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]?.reason, "budget_cap");
  assert.equal(escalations[0]?.workflowId, "workflow-1");

  const { engine: engine2, escalations: esc2 } = createEngine({ maxIterations: 1 });
  seedWorkflow(engine2, { config: { maxIterations: 1 } });
  engine2.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-1",
    severity: "minor",
    iterationId: "iteration-1",
  });
  engine2.advancePlanning("workflow-1", "plannerCompleted");
  engine2.advancePlanning("workflow-1", "reviewersSpawned");
  engine2.advancePlanning("workflow-1", "objectionsCollected");
  engine2.advancePlanning("workflow-1", "mergeCompleted");
  engine2.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-2" });
  await engine2.flush();
  assert.ok(esc2.some((item) => item.reason === "iteration_cap"));
});

test("W2: repair send failure fails the turn instead of hanging", async () => {
  const { store, engine } = createEngine({}, {
    runtime: {
      send: async () => {
        throw new Error("pane_dead");
      },
    },
  });
  seedWorkflow(engine);
  engine.startTurn(sampleTurn());
  engine.markDelivered("turn-1");
  engine.handleSignal(resultSeenSignal());
  engine.applyValidation({ turnId: "turn-1", outcome: "failure", reason: "schema" });
  assert.equal(turnState(store, "turn-1"), "waiting");
  await engine.flush();
  assert.equal(turnState(store, "turn-1"), "failed");
  assert.ok(eventKinds(store).includes("TurnFailed"));
});

test("W3: fold paginates past the default listEvents limit", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  const engine = new WorkflowEngine({
    store,
    notifications: { notifyEscalation: () => undefined },
  });
  seedWorkflow(engine);
  store.transaction((tx) => {
    for (let i = 0; i < 10_050; i += 1) {
      tx.appendEvent(EventSchema.parse({
        eventId: String(eventId(`usage-${i}`)),
        occurredAt: "2026-07-22T10:00:00.000Z",
        workflowId: "workflow-1",
        kind: "UsageRecorded",
        payload: { messageId: `msg-${i}`, inputTokens: 1, outputTokens: 0, cost: 0.001 },
      }));
    }
  });
  const truncated = store.listEvents({ workflowId: "workflow-1" });
  assert.equal(truncated.length, 10_000);
  const folded = engine.fold("workflow-1");
  assert.equal(folded.seenUsageMessageIds.length, 10_050);
  assert.ok(Math.abs(folded.spendTotal - 10.05) < 1e-9);
});

test("W5: malformed config_toon fails loud instead of widening caps", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-engine-"));
  const path = join(dir, "t.db");
  const store = new PersistenceStore({ path });
  const engine = new WorkflowEngine({
    store,
    config: { budgetCap: 1 },
    notifications: { notifyEscalation: () => undefined },
  });
  seedWorkflow(engine, { config: { budgetCap: 1 } });
  store.close();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE workflows SET config_toon = ? WHERE workflow_id = ?").run("{{{not-valid-toon", "workflow-1");
  db.close();
  const reopened = new PersistenceStore({ path });
  const engine2 = new WorkflowEngine({
    store: reopened,
    config: { budgetCap: 1 },
    notifications: { notifyEscalation: () => undefined },
  });
  assert.throws(() => engine2.submitUsage({
    workflowId: "workflow-1",
    messageId: "m",
    inputTokens: 1,
    outputTokens: 1,
    cost: 0.1,
  }), /malformed config_toon|refusing to widen|TOON|Invalid/);
  reopened.close();
});

test("W6: persisted state omits growing dedup arrays", () => {
  const state = {
    ...initialFoldedState("workflow-1"),
    seenUsageMessageIds: ["a", "b", "c"],
    seenIterationIds: ["i1"],
    spendTotal: 3,
  };
  const persisted = toPersistedFoldedState(state);
  assert.deepEqual(persisted.seenUsageMessageIds, []);
  assert.deepEqual(persisted.seenIterationIds, []);
  assert.equal(persisted.spendTotal, 3);
});

test("W9: repairPromptPath rejects non-prompt.md paths", () => {
  assert.equal(
    repairPromptPath("runs/wf/it/turn/prompt.md"),
    "runs/wf/it/turn/repair-prompt.md",
  );
  assert.throws(() => repairPromptPath("runs/wf/it/turn/PROMPT.MD"), /does not end with prompt.md/);
});
