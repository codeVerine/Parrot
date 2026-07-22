import assert from "node:assert/strict";
import test from "node:test";
import {
  cataloguedTurnTypes,
  toEngineValidationVerdict,
} from "../src/index.js";
import { createBoundary, envelopeBytes } from "./helpers.js";

test("catalog registers a schema for every non-repair turn type", () => {
  const types = cataloguedTurnTypes();
  assert.ok(types.includes("planner_propose"));
  assert.ok(types.includes("objection_merge"));
  assert.ok(types.includes("frontier_report"));
  assert.equal(types.includes("repair" as never), false);
});

test("valid planner result → valid verdict and engine success", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "Ship it",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
      turnType: "planner_propose",
      attempt: "primary",
    },
  });

  assert.equal(verdict.outcome, "valid");
  if (verdict.outcome === "valid") {
    const engine = toEngineValidationVerdict("turn-1", verdict);
    assert.equal(engine.outcome, "success");
    assert.ok(engine.resultHash);
  }
});

test("envelope nonce mismatch → needsRepair on primary", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    nonce: "wrong",
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
      turnType: "planner_propose",
      attempt: "primary",
    },
  });

  assert.equal(verdict.outcome, "needsRepair");
});

test("same failure on repair attempt → failed", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    nonce: "wrong",
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
      turnType: "planner_propose",
      attempt: "repair",
    },
  });

  assert.equal(verdict.outcome, "failed");
});

test("unsupported schemaVersion is rejected", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    schemaVersion: "v99",
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
      turnType: "planner_propose",
      attempt: "primary",
    },
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.equal(verdict.reason, "unsupported_schema_version");
  }
});

test("reviewer empty evidence without evidence_missing fails", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: {
      role: "reviewer",
      objections: [
        { id: "OBJ-9", severity: "minor", claim: "nit", evidence: [] },
      ],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-1",
      nonce: "fixed-nonce-001",
      turnType: "reviewer_review",
      attempt: "primary",
    },
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.equal(verdict.reason, "evidence_rules");
  }
});
