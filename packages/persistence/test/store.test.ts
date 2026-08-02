import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseToon, RuntimeSignalSchema } from "@platform/contracts";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, schemaTables } from "../src/index.js";
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
  const feedback = store.listHumanFeedback("workflow-1");
  assert.equal(feedback.length, 1);
  assert.equal(String(feedback[0]?.comment), "Proceed.");
  store.close();
});

test("same objection id can exist independently on two workflows", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.transaction((tx) => {
    tx.saveWorkflow({ workflowId: "workflow-a", workspaceId: "workspace-1", status: "running", task: "a" });
    tx.saveWorkflow({ workflowId: "workflow-b", workspaceId: "workspace-1", status: "running", task: "b" });
    tx.saveIteration({ iterationId: "workflow-a-iter-1", workflowId: "workflow-a", iterationNumber: 1, status: "running" });
    tx.saveIteration({ iterationId: "workflow-b-iter-1", workflowId: "workflow-b", iterationNumber: 1, status: "running" });
    tx.saveTurn({
      turnId: "turn-a",
      workflowId: "workflow-a",
      iterationId: "workflow-a-iter-1",
      agentId: "reviewer",
      state: "completed",
      attempt: "primary",
      promptPath: "a/prompt.md",
      promptHash: "ha",
      nonce: "na",
      promptVersion: "reviewer@1",
      resultPath: "a/result.toon",
    });
    tx.saveTurn({
      turnId: "turn-b",
      workflowId: "workflow-b",
      iterationId: "workflow-b-iter-1",
      agentId: "reviewer",
      state: "completed",
      attempt: "primary",
      promptPath: "b/prompt.md",
      promptHash: "hb",
      nonce: "nb",
      promptVersion: "reviewer@1",
      resultPath: "b/result.toon",
    });
    tx.saveObjection({
      objectionId: "OBJ-001",
      workflowId: "workflow-a",
      iterationId: "workflow-a-iter-1",
      turnId: "turn-a",
      dimension: "review",
      severity: "blocking",
      claim: "claim from workflow A",
      evidence: ["a"],
      status: "open",
      raisedBy: "reviewer",
    });
    tx.saveObjection({
      objectionId: "OBJ-001",
      workflowId: "workflow-b",
      iterationId: "workflow-b-iter-1",
      turnId: "turn-b",
      dimension: "review",
      severity: "major",
      claim: "claim from workflow B",
      evidence: ["b"],
      status: "open",
      raisedBy: "reviewer",
    });
  });

  const a = store.listObjections("workflow-a");
  const b = store.listObjections("workflow-b");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0]?.claim, "claim from workflow A");
  assert.equal(b[0]?.claim, "claim from workflow B");
  assert.equal(a[0]?.severity, "blocking");
  assert.equal(b[0]?.severity, "major");

  store.updateObjectionStatus("workflow-a", "OBJ-001", "resolved");
  assert.equal(store.listObjections("workflow-a")[0]?.status, "resolved");
  assert.equal(store.listObjections("workflow-b")[0]?.status, "open");
  store.close();
});

test("objection upsert within a workflow updates claim without leaking across workflows", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.transaction((tx) => {
    tx.saveWorkflow({ workflowId: "workflow-a", workspaceId: "workspace-1", status: "running", task: "a" });
    tx.saveWorkflow({ workflowId: "workflow-b", workspaceId: "workspace-1", status: "running", task: "b" });
    tx.saveIteration({ iterationId: "workflow-a-iter-1", workflowId: "workflow-a", iterationNumber: 1, status: "running" });
    tx.saveIteration({ iterationId: "workflow-b-iter-1", workflowId: "workflow-b", iterationNumber: 1, status: "running" });
    for (const [turnId, workflowId, iterationId] of [
      ["turn-a", "workflow-a", "workflow-a-iter-1"],
      ["turn-b", "workflow-b", "workflow-b-iter-1"],
    ] as const) {
      tx.saveTurn({
        turnId,
        workflowId,
        iterationId,
        agentId: "reviewer",
        state: "completed",
        attempt: "primary",
        promptPath: `${turnId}/prompt.md`,
        promptHash: "h",
        nonce: "n",
        promptVersion: "reviewer@1",
        resultPath: `${turnId}/result.toon`,
      });
    }
    tx.saveObjection({
      objectionId: "OBJ-002",
      workflowId: "workflow-a",
      iterationId: "workflow-a-iter-1",
      turnId: "turn-a",
      dimension: "review",
      severity: "blocking",
      claim: "original A",
      evidence: [],
      status: "resolved",
      raisedBy: "reviewer",
    });
    tx.saveObjection({
      objectionId: "OBJ-002",
      workflowId: "workflow-b",
      iterationId: "workflow-b-iter-1",
      turnId: "turn-b",
      dimension: "review",
      severity: "blocking",
      claim: "original B",
      evidence: [],
      status: "open",
      raisedBy: "reviewer",
    });
    tx.saveObjection({
      objectionId: "OBJ-002",
      workflowId: "workflow-a",
      iterationId: "workflow-a-iter-1",
      turnId: "turn-a",
      dimension: "review",
      severity: "blocking",
      claim: "re-raised A",
      evidence: ["new evidence"],
      status: "open",
      raisedBy: "reviewer",
    });
  });

  assert.equal(store.listObjections("workflow-a")[0]?.claim, "re-raised A");
  assert.equal(store.listObjections("workflow-a")[0]?.status, "open");
  assert.equal(store.listObjections("workflow-b")[0]?.claim, "original B");
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

test("migration v3 → v4 adds suggested_resolution and round-trips Pair fields", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "parrot-migrate-v4-")), "parrot.db");
  const bootstrap = new DatabaseSync(dbPath);
  bootstrap.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (let version = 1; version <= 3; version += 1) {
    bootstrap.exec(MIGRATIONS[version - 1]!);
    bootstrap.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, "2026-07-19T10:00:00.000Z");
  }
  bootstrap.prepare(`
    INSERT INTO workflows (workflow_id, workspace_id, status, task, config_toon, state_toon, created_at, updated_at)
    VALUES ('workflow-1', 'workspace-1', 'running', 'task', '{}', '{}', ?, ?)
  `).run("2026-07-19T10:00:00.000Z", "2026-07-19T10:00:00.000Z");
  bootstrap.prepare(`
    INSERT INTO iterations (iteration_id, workflow_id, iteration_number, status, state_toon, created_at, updated_at)
    VALUES ('iteration-1', 'workflow-1', 1, 'running', '{}', ?, ?)
  `).run("2026-07-19T10:00:00.000Z", "2026-07-19T10:00:00.000Z");
  bootstrap.prepare(`
    INSERT INTO turns (turn_id, workflow_id, iteration_id, agent_id, state, attempt, deadline_at, prompt_path, prompt_hash, nonce, prompt_version, result_path, created_at, updated_at)
    VALUES ('turn-1', 'workflow-1', 'iteration-1', 'reviewer', 'completed', 'primary', NULL, 'p.md', 'h', 'n', 'reviewer@1.1.0', 'r.toon', ?, ?)
  `).run("2026-07-19T10:00:00.000Z", "2026-07-19T10:00:00.000Z");
  bootstrap.prepare(`
    INSERT INTO objections (
      objection_id, workflow_id, iteration_id, turn_id, dimension, severity, claim,
      evidence_toon, evidence_missing, status, raised_by, cluster_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "OBJ-legacy", "workflow-1", "iteration-1", "turn-1", "review", "major",
    "legacy objection", "[]", 0, "open", "reviewer", null, "2026-07-19T10:00:00.000Z",
  );
  bootstrap.close();

  const store = new PersistenceStore({ path: dbPath });
  const migrated = new DatabaseSync(dbPath).prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  assert.equal(Number(migrated.version), CURRENT_SCHEMA_VERSION);

  const columns = store.readRows("objections");
  assert.ok(columns.length >= 1);
  const legacy = columns.find((row) => String(row.objection_id) === "OBJ-legacy");
  assert.ok(legacy);
  assert.equal(legacy?.suggested_resolution, null);

  store.saveObjection({
    objectionId: "OBJ-rich",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    dimension: "review",
    severity: "blocking",
    claim: "Missing auth",
    evidence: ["src/a.ts:1"],
    status: "open",
    raisedBy: "reviewer",
    suggestedResolution: "Add ownership check before delete.",
  });

  const rich = store.listObjections("workflow-1").find((row) => String(row.objection_id) === "OBJ-rich");
  assert.equal(String(rich?.suggested_resolution), "Add ownership check before delete.");
  store.close();
});
