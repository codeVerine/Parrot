import assert from "node:assert/strict";
import test from "node:test";
import { parseToon, RuntimeSignalSchema } from "@platform/contracts";
import { schemaTables } from "../src/index.js";
import { PersistenceStore } from "../src/store.js";
import { sampleEvent, sampleSignal, seedTurn } from "./helpers.js";

test("persists the Phase 3 tables and keeps structured payloads as TOON", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedTurn(store);
  store.transaction((tx) => {
    tx.saveAgent({ agentId: "agent-1", paneId: "pane-1", workspaceId: "workspace-1", provider: "codex", role: "reviewer", status: "idle", remapHistory: [] });
    tx.saveRequirement({ requirementId: "requirement-1", sourcePath: "task.md", contentHash: "task-hash", priority: "must", text: "Persist events." });
    tx.saveObjection({ objectionId: "objection-1", workflowId: "workflow-1", iterationId: "iteration-1", turnId: "turn-1", dimension: "correctness", severity: "major", claim: "Needs a durable log.", evidence: ["section 6.9"], status: "open", raisedBy: "reviewer" });
    tx.saveDecision({ decisionId: "decision-1", workflowId: "workflow-1", iterationId: "iteration-1", turnId: "turn-1", decision: "storage", chosen: "SQLite", alternatives: ["JSON"], reason: "Replayable source of truth.", objectionIds: ["objection-1"] });
    tx.saveHumanFeedback({ feedbackId: "feedback-1", workflowId: "workflow-1", decision: "approved", comment: "Proceed." });
    tx.saveArtifact({ artifactId: "artifact-1", workflowId: "workflow-1", iterationId: "iteration-1", turnId: "turn-1", kind: "result", path: "result.toon", contentHash: "c".repeat(64), metadata: { role: "reviewer" } });
    tx.recordUsage({ usageId: "usage-1", workflowId: "workflow-1", provider: "codex", messageId: "message-1", cacheTokens: 1, inputTokens: 2, outputTokens: 3, cost: 0.04, pricingVersion: "2026-01", wallClockMs: 20, retryCount: 0, repairCount: 0, timeoutCount: 0, startupMs: 4 });
    tx.recordSignal(sampleSignal());
    tx.appendEvent(sampleEvent());
  });

  assert.deepEqual(store.tableNames().sort(), [...schemaTables(), "schema_migrations"].sort());
  for (const table of schemaTables()) assert.equal(store.readRows(table).length, 1, table);
  assert.deepEqual(parseToon(store.listEvents()[0].payloadToon), { resultHash: "a".repeat(64) });
  assert.equal(store.listSignals()[0].signal.kind, "ResultFileSeen");
  assert.deepEqual(store.pendingDeadlines(), [{ turnId: "turn-1", deadline: "2026-07-19T10:05:00.000Z", attempt: "primary" }]);
  store.close();
});

test("state and event writes roll back together", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  assert.throws(() => store.transaction((tx) => {
    tx.saveWorkflow({ workflowId: "workflow-rollback", workspaceId: "workspace-1", status: "running", task: "rollback" });
    tx.appendEvent(sampleEvent("event-rollback"));
    throw new Error("simulated crash before commit");
  }), /simulated crash/);
  assert.equal(store.readRows("workflows").length, 0);
  assert.equal(store.listEvents().length, 0);
  store.close();
});

test("duplicate signals, events, and usage records are idempotent", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedTurn(store);
  store.recordSignal(sampleSignal());
  store.recordSignal(sampleSignal());
  store.appendEvent(sampleEvent());
  store.appendEvent(sampleEvent());
  store.recordUsage({ usageId: "usage-1", workflowId: "workflow-1", provider: "codex", messageId: "same-message", cacheTokens: 1, inputTokens: 2, outputTokens: 3, cost: 0.04, pricingVersion: "2026-01", wallClockMs: 20, retryCount: 0, repairCount: 0, timeoutCount: 0, startupMs: 4 });
  store.recordUsage({ usageId: "usage-2", workflowId: "workflow-1", provider: "codex", messageId: "same-message", cacheTokens: 8, inputTokens: 9, outputTokens: 10, cost: 0.99, pricingVersion: "later", wallClockMs: 99, retryCount: 1, repairCount: 1, timeoutCount: 1, startupMs: 9 });
  assert.equal(store.listSignals().length, 1);
  assert.equal(store.listEvents().length, 1);
  assert.equal(store.readRows("usage_ledger").length, 1);
  store.close();
});

test("signal retention prunes only old signals from terminal turns", () => {
  const store = new PersistenceStore({ path: ":memory:", signalRetentionDays: 1 });
  seedTurn(store, "completed");
  store.recordSignal({ ...sampleSignal(), observedAt: "2026-07-17T10:00:00.000Z" });
  assert.equal(store.pruneSignals(new Date("2026-07-19T10:00:00.000Z")), 1);
  assert.equal(store.listSignals().length, 0);
  store.close();
});

test("signal retention also prunes old adapter faults without a turn", () => {
  const store = new PersistenceStore({ path: ":memory:", signalRetentionDays: 1 });
  store.recordSignal(RuntimeSignalSchema.parse({
    signalId: "fault-1",
    observedAt: "2026-07-17T10:00:00.000Z",
    source: "adapter_internal",
    classification: "fault",
    kind: "ProtocolMismatch",
    workflowId: null,
    iterationId: null,
    turnId: null,
    agentId: null,
    expectedProtocol: 1,
    observedProtocol: 2,
    expectedSchemaVersion: 1,
    observedSchemaVersion: 2,
  }));

  assert.equal(store.pruneSignals(new Date("2026-07-19T10:00:00.000Z")), 1);
  assert.equal(store.listSignals().length, 0);
  store.close();
});

test("saveDecision stores a schema-validated payload", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedTurn(store);

  assert.throws(() => store.saveDecision({
    decisionId: "decision-invalid-payload",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    decision: "storage",
    chosen: "SQLite",
    alternatives: ["JSON"],
    reason: "Persist it.",
    objectionIds: [],
    payload: { invalid: true },
  }), /decision|chosen|alternatives|reason|provenance/);

  assert.throws(() => store.saveDecision({
    decisionId: "decision-mismatched-payload",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    decision: "storage",
    chosen: "SQLite",
    alternatives: ["JSON"],
    reason: "Persist it.",
    objectionIds: [],
    payload: {
      decision: "storage",
      chosen: "JSON",
      alternatives: ["SQLite"],
      reason: "Persist it.",
      provenance: { workflowId: "workflow-1", iterationId: "iteration-1", turnId: "turn-1", objectionIds: [] },
    },
  }), /must match/);

  store.saveDecision({
    decisionId: "decision-valid-payload",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    decision: "storage",
    chosen: "SQLite",
    alternatives: ["JSON"],
    reason: "Persist it.",
    objectionIds: [],
    payload: {
      decision: "storage",
      chosen: "SQLite",
      alternatives: ["JSON"],
      reason: "Persist it.",
      provenance: { workflowId: "workflow-1", iterationId: "iteration-1", turnId: "turn-1", objectionIds: [] },
    },
  });

  assert.deepEqual(parseToon(String(store.readRows("decisions")[0].payload_toon)), {
    alternatives: ["JSON"],
    chosen: "SQLite",
    decision: "storage",
    provenance: { iterationId: "iteration-1", objectionIds: [], turnId: "turn-1", workflowId: "workflow-1" },
    reason: "Persist it.",
  });
  store.close();
});
