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

test("planner revised_plan addressal with whitespace-only evidence needs repair, then fails on repair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [
        // A true "" fails ObjectionAddressalSchema's min(1) as schema_invalid before this
        // rule ever runs; whitespace-only satisfies min(1) but is still not real evidence.
        { objectionId: "OBJ-1", resolutionStrategy: "revised_plan", evidence: "   ", requiresGuardrailException: false },
      ],
    },
  });

  const primary = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "primary" },
    inputObjectionIds: ["OBJ-1"],
  });
  assert.equal(primary.outcome, "needsRepair");
  if (primary.outcome === "needsRepair") assert.equal(primary.reason, "evidence_rules");

  const repair = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "repair" },
    inputObjectionIds: ["OBJ-1"],
  });
  assert.equal(repair.outcome, "failed");
});

test("planner addressal referencing an objection ID outside inputObjectionIds fails", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [
        { objectionId: "OBJ-9", resolutionStrategy: "revised_plan", evidence: "plan.md:3 fixed", requiresGuardrailException: false },
      ],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "primary" },
    inputObjectionIds: ["OBJ-1"],
  });
  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") assert.equal(verdict.reason, "evidence_rules");
});

test("planner legacy bare-ID addressal validates without evidence or inputObjectionIds", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: ["OBJ-1"],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "primary" },
  });
  assert.equal(verdict.outcome, "valid");
});

test("planner structured addressal with quoted evidence and a covered ID validates", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "plan.md",
      summary: "x",
      objectionsAddressed: [
        { objectionId: "OBJ-1", resolutionStrategy: "retracted", evidence: "proposal.md:20 disproves the premise", requiresGuardrailException: false },
      ],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "primary" },
    inputObjectionIds: ["OBJ-1"],
  });
  assert.equal(verdict.outcome, "valid");
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

test("reviewer zero objections without cleanRationale → needsRepair on primary", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [] },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.equal(verdict.reason, "evidence_rules");
    assert.match(verdict.diagnostics, /cleanRationale/);
  }
});

test("reviewer zero objections without cleanRationale → failed on repair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [] },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "repair" },
  });

  assert.equal(verdict.outcome, "failed");
});

test("reviewer zero objections with whitespace-only cleanRationale → needsRepair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [], cleanRationale: "   " },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.equal(verdict.reason, "evidence_rules");
  }
});

test("reviewer zero objections with cleanRationale → valid", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [], cleanRationale: "All acceptance criteria and guardrails are satisfied." },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
  });

  assert.equal(verdict.outcome, "valid");
});

test("reviewer non-empty objections without cleanRationale → valid", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: {
      role: "reviewer",
      objections: [{ id: "OBJ-1", severity: "major", claim: "bad", evidence: ["src/a.ts:1"] }],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
  });

  assert.equal(verdict.outcome, "valid");
});

test("adversarial_review zero objections without cleanRationale → needsRepair on primary", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [] },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "adversarial_review", attempt: "primary" },
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.equal(verdict.reason, "evidence_rules");
  }
});

test("reviewer@1.2.0 clean review missing rich fields → needsRepair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: { role: "reviewer", objections: [], cleanRationale: "All criteria satisfied." },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
    promptVersion: "reviewer@1.2.0",
    expectedProposalPath: "/runs/wf/proposal.md",
    expectedProposalHash: "a".repeat(64),
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /reviewedProposalPath|summary/i);
  }
});

test("reviewer@1.2.0 path/hash mismatch → needsRepair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: {
      role: "reviewer",
      reviewedProposalPath: "/wrong/proposal.md",
      reviewedProposalHash: "b".repeat(64),
      summary: "Review summary.",
      objections: [],
      cleanRationale: "All criteria satisfied.",
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
    promptVersion: "reviewer@1.2.0",
    expectedProposalPath: "/runs/wf/proposal.md",
    expectedProposalHash: "a".repeat(64),
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /mismatch/i);
  }
});

test("reviewer@1.2.0 objection without suggestedResolution → needsRepair", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: {
      role: "reviewer",
      reviewedProposalPath: "/runs/wf/proposal.md",
      reviewedProposalHash: "a".repeat(64),
      summary: "Review summary.",
      objections: [{ id: "OBJ-1", severity: "major", claim: "bad", evidence: ["src/a.ts:1"] }],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
    promptVersion: "reviewer@1.2.0",
    expectedProposalPath: "/runs/wf/proposal.md",
    expectedProposalHash: "a".repeat(64),
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /suggestedResolution/i);
  }
});

test("reviewer@1.2.0 rich clean review with matching identity → valid", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "reviewer",
    payload: {
      role: "reviewer",
      reviewedProposalPath: "/runs/wf/proposal.md",
      reviewedProposalHash: "a".repeat(64),
      summary: "Pair review: plan looks solid.",
      objections: [],
      cleanRationale: "All criteria satisfied.",
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "reviewer_review", attempt: "primary" },
    promptVersion: "reviewer@1.2.0",
    expectedProposalPath: "/runs/wf/proposal.md",
    expectedProposalHash: "a".repeat(64),
  });

  assert.equal(verdict.outcome, "valid");
});

test("planner@1.8.0 revise must address every open objection exactly once", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    iterationId: "it-2",
    turnId: "turn-2",
    payload: {
      role: "planner",
      proposalPath: "/runs/wf/turn/proposal.md",
      summary: "revised plan",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-2", turnId: "turn-2", nonce: "fixed-nonce-001", turnType: "planner_revise", attempt: "primary" },
    promptVersion: "planner@1.8.0",
    expectedProposalOutputPath: "/runs/wf/turn/proposal.md",
    inputObjectionIds: ["OBJ-1", "OBJ-2"],
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /missing addressals/i);
  }
});

test("planner@1.8.0 rejects legacy bare-ID addressal", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    iterationId: "it-2",
    turnId: "turn-2",
    payload: {
      role: "planner",
      proposalPath: "/runs/wf/turn/proposal.md",
      summary: "revised plan",
      objectionsAddressed: ["OBJ-1"],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-2", turnId: "turn-2", nonce: "fixed-nonce-001", turnType: "planner_revise", attempt: "primary" },
    promptVersion: "planner@1.8.0",
    expectedProposalOutputPath: "/runs/wf/turn/proposal.md",
    inputObjectionIds: ["OBJ-1"],
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /legacy bare-ID/i);
  }
});

test("planner@1.8.0 proposalPath must equal expected output path", () => {
  const { extractor } = createBoundary();
  const bytes = envelopeBytes({
    role: "planner",
    payload: {
      role: "planner",
      proposalPath: "/wrong/proposal.md",
      summary: "plan",
      objectionsAddressed: [],
    },
  });

  const verdict = extractor.validate({
    bytes,
    turn: { workflowId: "wf-1", iterationId: "it-1", turnId: "turn-1", nonce: "fixed-nonce-001", turnType: "planner_propose", attempt: "primary" },
    promptVersion: "planner@1.8.0",
    expectedProposalOutputPath: "/runs/wf/turn/proposal.md",
  });

  assert.equal(verdict.outcome, "needsRepair");
  if (verdict.outcome === "needsRepair") {
    assert.match(verdict.diagnostics ?? "", /proposalPath must equal/i);
  }
});
