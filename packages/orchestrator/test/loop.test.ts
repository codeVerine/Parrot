import assert from "node:assert/strict";
import test from "node:test";
import { encodeToon } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import {
  createComposition,
  createFixtureRunner,
  runReviewLoop,
  type AgentTurnRequest,
} from "../src/index.js";

function envelope(req: AgentTurnRequest, role: string, payload: Record<string, unknown>): string {
  return encodeToon({
    workflowId: req.workflowId,
    iterationId: req.iterationId,
    turnId: req.turnId,
    schemaVersion: "v1",
    nonce: req.nonce,
    role,
    payload: { role, ...payload },
  });
}

function setup(resolver: (req: AgentTurnRequest) => string) {
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    writePrompts: false,
    now: () => "2026-07-23T10:00:00.000Z",
    newId: () => `turn-${(counter += 1)}`,
    nonceFactory: () => "nonce-1",
  });
  return { store, comp };
}

const loopInput = {
  workflowId: "workflow-1",
  workspaceId: "workspace-1",
  task: "Ship the feature",
  plannerAgentId: "agent-planner",
  reviewerAgentIds: ["agent-reviewer"],
  frontierAgentId: "agent-frontier",
  decide: () => ({ decision: "approved" as const }),
};

test("clean loop reaches approved through the human gate", async () => {
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: [] });
    }
    if (req.turnType.includes("review")) {
      return envelope(req, "reviewer", { objections: [] });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  assert.equal(result.frontierReadiness, "ready");
  assert.equal(result.finalProposalPath, "plan.md");
});

test("reviewer objection forces a revise, then converges to approved", async () => {
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2") ? ["OBJ-1"] : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      const objections = req.iterationId.endsWith("iter-1")
        ? [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]
        : [];
      return envelope(req, "reviewer", { objections });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  assert.ok(result.iterations >= 2);
  assert.equal(result.openObjectionIds.length, 0);
});

test("blocking frontier finding converts to an objection and re-enters the loop", async () => {
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: [] });
    }
    if (req.turnType.includes("review")) {
      return envelope(req, "reviewer", { objections: [] });
    }
    return envelope(req, "frontier", { readiness: "not_ready", risks: ["unmitigated deploy risk"], questions: [] });
  });

  const result = await runReviewLoop(comp, { ...loopInput, maxIterations: 3 });
  assert.equal(result.frontierReadiness, "not_ready");
  assert.notEqual(result.phase, "approved");
  const frontierObjections = store
    .readRows("objections")
    .filter((row) => String(row.dimension) === "frontier");
  assert.ok(frontierObjections.length > 0);
});
