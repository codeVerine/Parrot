import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventSchema, encodeToon } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import { buildStalemateReport } from "../src/escalation-report.js";
import { repairObjectionProjection } from "../src/objection-projection.js";

function seedWorkflow(store: PersistenceStore, workflowId: string, turnId: string, resultPath: string): void {
  const iterationId = `${workflowId}-iter-1`;
  store.transaction((tx) => {
    tx.saveWorkflow({ workflowId, workspaceId: "ws", status: "running", task: "task" });
    tx.saveIteration({ iterationId, workflowId, iterationNumber: 1, status: "running" });
    tx.saveTurn({
      turnId,
      workflowId,
      iterationId,
      agentId: "reviewer",
      state: "completed",
      attempt: "primary",
      promptPath: join(resultPath, "..", "prompt.md"),
      promptHash: "hash",
      nonce: "nonce",
      promptVersion: "reviewer@1",
      resultPath,
    });
  });
}

test("repairObjectionProjection restores missing rows from events and result.toon", () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-obj-repair-"));
  const turnDir = join(dir, "turn");
  mkdirSync(turnDir);
  const resultPath = join(turnDir, "result.toon");
  writeFileSync(
    resultPath,
    encodeToon({
      iterationId: "wf-new-iter-1",
      nonce: "nonce",
      role: "reviewer",
      schemaVersion: "v1",
      turnId: "turn-new",
      workflowId: "wf-new",
      payload: {
        role: "reviewer",
        objections: [
          {
            id: "OBJ-001",
            severity: "blocking",
            claim: "restored claim for OBJ-001",
            evidence: ["evidence-1"],
          },
        ],
      },
    }),
  );

  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store, "wf-new", "turn-new", resultPath);

  // Simulate the old global-PK collision: another workflow already owns OBJ-001, so this
  // workflow's raise only left an event (no local objections row).
  store.transaction((tx) => {
    tx.saveWorkflow({ workflowId: "wf-old", workspaceId: "ws", status: "running", task: "old" });
    tx.saveIteration({ iterationId: "wf-old-iter-1", workflowId: "wf-old", iterationNumber: 1, status: "running" });
    tx.saveTurn({
      turnId: "turn-old",
      workflowId: "wf-old",
      iterationId: "wf-old-iter-1",
      agentId: "reviewer",
      state: "completed",
      attempt: "primary",
      promptPath: "old/prompt.md",
      promptHash: "h",
      nonce: "n",
      promptVersion: "reviewer@1",
      resultPath: "old/result.toon",
    });
    tx.saveObjection({
      objectionId: "OBJ-001",
      workflowId: "wf-old",
      iterationId: "wf-old-iter-1",
      turnId: "turn-old",
      dimension: "review",
      severity: "minor",
      claim: "old workflow claim",
      evidence: [],
      status: "open",
      raisedBy: "reviewer",
    });
    tx.appendEvent(
      EventSchema.parse({
        eventId: "evt-raise-new",
        occurredAt: "2026-07-31T12:00:00.000Z",
        workflowId: "wf-new",
        iterationId: "wf-new-iter-1",
        turnId: "turn-new",
        agentId: "reviewer",
        kind: "ObjectionRaised",
        payload: { objectionId: "OBJ-001", severity: "blocking" },
      }),
    );
  });

  assert.equal(store.listObjections("wf-new").length, 0);
  repairObjectionProjection(store, "wf-new");
  const rows = store.listObjections("wf-new");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.claim, "restored claim for OBJ-001");
  assert.equal(rows[0]?.severity, "blocking");
  assert.equal(store.listObjections("wf-old")[0]?.claim, "old workflow claim");

  const report = buildStalemateReport(store, "wf-new", ["OBJ-001"]);
  assert.match(report, /severity: blocking/);
  assert.match(report, /restored claim for OBJ-001/);
  assert.doesNotMatch(report, /\(unavailable\)/);
  store.close();
});
