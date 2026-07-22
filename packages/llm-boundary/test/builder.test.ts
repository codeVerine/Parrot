import assert from "node:assert/strict";
import test from "node:test";
import { createBoundary, sampleObjections } from "./helpers.js";

test("builder is deterministic for same state + role prompt + nonce", () => {
  const { builder } = createBoundary();
  const identity = { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1" };
  const context = {
    task: "Build auth",
    openObjections: sampleObjections,
    proposalSummary: "Add delete auth.",
  };

  const first = builder.build({
    turnType: "planner_revise",
    identity,
    context,
    write: false,
  });
  const second = builder.build({
    turnType: "planner_revise",
    identity,
    context,
    write: false,
  });

  assert.equal(first.content, second.content);
  assert.equal(first.promptHash, second.promptHash);
  assert.equal(first.nonce, "fixed-nonce-001");
  assert.equal(first.promptVersion, "planner@1.0.0");
});

test("objection_merge prompt includes every candidate as evidence", () => {
  const { builder } = createBoundary();
  const built = builder.build({
    turnType: "objection_merge",
    identity: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-m" },
    context: { openObjections: sampleObjections },
    write: false,
  });

  for (const objection of sampleObjections) {
    assert.match(built.content, new RegExp(`id="${objection.id}"`));
    assert.match(built.content, /<<<EVIDENCE nonce="fixed-nonce-001"/);
    assert.match(built.content, /<<<END_EVIDENCE nonce="fixed-nonce-001">>>/);
  }
});

test("repair prompt embeds failure, schema, and original nonce only", () => {
  const { builder } = createBoundary();
  const built = builder.build({
    turnType: "repair",
    identity: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
    },
    context: {
      originalTurnType: "planner_propose",
      repairReason: "schema_invalid: summary missing",
      expectedSchemaDescription: "PlannerResultSchema",
    },
    write: false,
  });

  assert.match(built.path, /repair-prompt\.md$/);
  assert.match(built.content, /fixed-nonce-001/);
  assert.match(built.content, /PlannerResultSchema/);
  assert.match(built.content, /schema_invalid/);
  assert.doesNotMatch(built.content, /Open objections/i);
});
