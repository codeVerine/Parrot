import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { encodeToon } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import {
  createComposition,
  createFixtureRunner,
  runReviewLoop,
  selectResumeWorkflowId,
  collectResumeCandidates,
  reuseImplementation,
  verificationCompleted,
  ResumeTurnRegistry,
  buildResumeSeed,
  rehydrateViews,
  type AgentTurnRequest,
} from "../src/index.js";
import { WorkflowEngine } from "@platform/workflow-engine";
import { sha256Hex } from "@platform/llm-boundary";
import {
  authorEnvelope,
  envelope,
  pairClean,
  pairObjections,
  approvedProposal,
} from "./author-pair-fixtures.js";

function recordingResolver(
  runsRoot: string,
  reply: (req: AgentTurnRequest, state: { proposalPath: string }) => { role: string; payload: Record<string, unknown> } | string,
  throwOn?: { turnType: string; once: boolean },
) {
  const delivered: string[] = [];
  let thrown = false;
  const state = { proposalPath: "" };
  const resolver = (req: AgentTurnRequest): string => {
    delivered.push(req.turnType);
    if (throwOn && req.turnType === throwOn.turnType && !(throwOn.once && thrown)) {
      thrown = true;
      throw new Error(`simulated interruption on ${req.turnType}`);
    }
    const result = reply(req, state);
    if (typeof result === "string") {
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, result, "utf8");
      return result;
    }
    const { role, payload } = result;
    const text = envelope(req, role, payload);
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };
  return { resolver, delivered, state };
}

function reply(req: AgentTurnRequest, state: { proposalPath: string }): string {
  if (req.turnType.startsWith("planner")) {
    const text = authorEnvelope(req, "ship the rate limiter");
    state.proposalPath = join(dirname(req.resultPath), "proposal.md");
    return text;
  }
  if (req.turnType.includes("review")) {
    return pairClean(req, state.proposalPath);
  }
  return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
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

function composition(store: PersistenceStore, runsRoot: string, resolver: (req: AgentTurnRequest) => string, prefix = "") {
  let counter = 0;
  return createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `turn-${prefix}${(counter += 1)}`,
    nonceFactory: () => "nonce-1",
  });
}

function adoptComp(
  store: PersistenceStore,
  resolver: (req: AgentTurnRequest) => string,
  suffix = "",
) {
  let counter = 0;
  const runsRoot = mkdtempSync(join(tmpdir(), `parrot-adopt${suffix}`));
  return createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `adopt-turn-${suffix}${(counter += 1)}`,
    nonceFactory: () => "adopt-nonce",
  });
}

function seedWorkflow(store: PersistenceStore, workflowId = "w1") {
  store.saveWorkflow({
    workflowId,
    workspaceId: "ws1",
    status: "running",
    task: "test",
    state: {},
    config: {},
  });
}

function seedIteration(store: PersistenceStore, iterationId: string, workflowId = "w1") {
  // iteration_number must be unique per workflow; extract number from id or use 1.
  const match = iterationId.match(/-(\d+)$/);
  const iterationNumber = match ? parseInt(match[1]!, 10) : 1;
  store.saveIteration({
    iterationId,
    workflowId,
    iterationNumber,
    status: "running",
  });
}

function baseTurn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "t1", workflowId: "w1", iterationId: "i1",
    agentId: "a1", state: "waiting" as const, attempt: "primary" as const,
    deadlineAt: null, promptPath: "/p.md", promptHash: "h", nonce: "n",
    promptVersion: "v1", resultPath: "/r.toon",
    ...overrides,
  };
}

function appendTurnCompleted(
  store: PersistenceStore,
  turnId: string,
  resultBytes: string,
  identity: { workflowId?: string; iterationId?: string; agentId?: string } = {},
): void {
  store.appendEvent({
    eventId: randomUUID(),
    occurredAt: "2026-07-23T10:00:00.000Z",
    workflowId: identity.workflowId ?? "w1",
    iterationId: identity.iterationId ?? "i1",
    turnId,
    agentId: identity.agentId ?? "a1",
    kind: "TurnCompleted",
    payload: { resultHash: sha256Hex(resultBytes) },
  });
}

test("resume continues from the interrupted phase without re-running completed turns", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  const first = recordingResolver(runsRoot, reply, { turnType: "frontier_report", once: true });
  const comp1 = composition(store, runsRoot, first.resolver, "a-");
  await assert.rejects(runReviewLoop(comp1, loopInput), /simulated interruption/);

  assert.equal(selectResumeWorkflowId(store), "workflow-1");
  assert.ok(first.delivered.includes("planner_propose"));
  assert.ok(first.delivered.some((t) => t.includes("review")));

  const second = recordingResolver(runsRoot, reply);
  const comp2 = composition(store, runsRoot, second.resolver, "b-");
  const seed = comp2.resumeWorkflow("workflow-1");
  assert.ok(seed.finalProposalPath?.endsWith("proposal.md"));

  const result = await runReviewLoop(comp2, { ...loopInput, resume: seed });
  assert.equal(result.phase, "approved");
  assert.equal(result.finalProposalPath, seed.finalProposalPath);

  assert.deepEqual(
    second.delivered.filter((t) => t.startsWith("planner") || t.includes("review")),
    [],
  );
  assert.ok(second.delivered.includes("frontier_report"));
});

test("resume rehydrates open objections raised before the interruption", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-obj-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  const replyWithObjection = (req: AgentTurnRequest, state: { proposalPath: string }): string => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the rate limiter");
      state.proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review") && req.iterationId.endsWith("iter-1")) {
      return pairObjections(req, state.proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
    }
    return reply(req, state);
  };
  const first = recordingResolver(runsRoot, replyWithObjection, { turnType: "planner_revise", once: true });
  const comp1 = composition(store, runsRoot, first.resolver, "c-");
  await assert.rejects(runReviewLoop(comp1, loopInput), /simulated interruption/);

  const seed = composition(store, runsRoot, first.resolver, "d-").resumeWorkflow("workflow-1");
  assert.ok(seed.views.has("OBJ-1"), "objection view should be rehydrated from the database");
  assert.equal(seed.views.get("OBJ-1")?.claim, "missing tests");
});

test("ResumeTurnRegistry collects eligible candidates and removes consumed ones", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  const workflowId = "workflow-1";
  seedWorkflow(store, workflowId);
  seedIteration(store, "iter-1", workflowId);
  seedIteration(store, "iter-2", workflowId);
  store.saveTurn(baseTurn({
    turnId: "turn-waiting", workflowId, iterationId: "iter-1", agentId: "agent-planner",
    state: "waiting",
  }));
  store.saveTurn(baseTurn({
    turnId: "turn-validating", workflowId, iterationId: "iter-1", agentId: "agent-reviewer",
    state: "validating",
  }));
  store.saveTurn(baseTurn({
    turnId: "turn-completed", workflowId, iterationId: "iter-2", agentId: "agent-frontier",
    state: "completed",
  }));
  store.saveTurn(baseTurn({
    turnId: "turn-failed", workflowId, iterationId: "iter-1", agentId: "agent-failed",
    state: "failed",
  }));
  store.saveTurn(baseTurn({
    turnId: "turn-cancelled", workflowId, iterationId: "iter-1", agentId: "agent-cancelled",
    state: "cancelled",
  }));

  const registry = new ResumeTurnRegistry(store, workflowId);
  assert.ok(registry.consume(workflowId, "iter-1", "agent-planner"));
  assert.ok(registry.consume(workflowId, "iter-1", "agent-reviewer"));
  assert.ok(registry.consume(workflowId, "iter-2", "agent-frontier"));
  assert.equal(registry.consume(workflowId, "iter-1", "agent-failed"), undefined);
  assert.equal(registry.consume(workflowId, "iter-1", "agent-cancelled"), undefined);
  assert.equal(registry.consume(workflowId, "iter-1", "agent-planner"), undefined);
});

test("collectResumeCandidates excludes terminal turn states", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  const rows = [
    { turnId: "t1", state: "waiting", agentId: "a1" },
    { turnId: "t2", state: "validating", agentId: "a2" },
    { turnId: "t3", state: "completed", agentId: "a3" },
    { turnId: "t4", state: "failed", agentId: "a4" },
    { turnId: "t5", state: "timed_out", agentId: "a5" },
    { turnId: "t6", state: "cancelled", agentId: "a6" },
  ] as const;
  for (const row of rows) {
    store.saveTurn(baseTurn({
      turnId: row.turnId, agentId: row.agentId, state: row.state,
    }));
  }
  const candidates = collectResumeCandidates(store, "w1");
  const ids = candidates.map((c) => c.turnId);
  assert.ok(ids.includes("t1"));
  assert.ok(ids.includes("t2"));
  assert.ok(ids.includes("t3"));
  assert.equal(ids.includes("t4"), false);
  assert.equal(ids.includes("t5"), false);
  assert.equal(ids.includes("t6"), false);
});

test("missing result file for waiting turn falls back to fresh turn", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  store.saveTurn(baseTurn({
    turnId: "old-waiting", nonce: "n1", resultPath: "/nonexistent.toon", state: "waiting",
  }));

  const comp = adoptComp(store, (req) => {
    const proposalPath = join(dirname(req.resultPath), "proposal.md");
    mkdirSync(dirname(proposalPath), { recursive: true });
    writeFileSync(proposalPath, "# Plan\n\ns\n", "utf8");
    return encodeToon({
      workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
      schemaVersion: "v1", nonce: req.nonce, role: "planner",
      payload: { role: "planner", proposalPath, summary: "s", objectionsAddressed: [] },
    });
  }, "missing");
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1"); // populate the resume registry

  const result = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "w1",
    iterationId: "i1",
    agentId: "a1",
    context: { task: "t" },
  });
  assert.equal(store.getTurn("old-waiting")?.state, "cancelled");
  assert.equal(result.status, "valid");
  assert.notEqual(result.turnId, "old-waiting");
});

test("late result on disk for a waiting turn is adopted without dispatching a replacement", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  const resultPath = join(tmpdir(), `resume-late-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "late-t1",
    schemaVersion: "v1", nonce: "late-nonce", role: "planner",
    payload: { role: "planner", proposalPath: "plan.md", summary: "late planner result", objectionsAddressed: [] },
  }), "utf8");
  store.saveTurn(baseTurn({
    turnId: "late-t1", nonce: "late-nonce", resultPath, state: "waiting",
  }));

  const comp = adoptComp(store, () => { throw new Error("late result must be adopted"); }, "late");
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1");

  const result = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "w1",
    iterationId: "i1",
    agentId: "a1",
    context: { task: "t" },
  });

  assert.equal(result.status, "valid");
  assert.equal(result.turnId, "late-t1");
  assert.equal(store.getTurn("late-t1")?.state, "completed");
});

test("completed implementation and verification are both reusable after interruption", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-post-review-resume-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  let counter = 0;
  const resolver = (req: AgentTurnRequest): string => {
    const role = req.turnType === "implementation" ? "implementation" : "resolution";
    const payload = role === "implementation"
      ? { status: "completed", summary: "implementation finished" }
      : { verified: ["post-review-turn-1"], unresolved: [] };
    const text = envelope(req, role, payload);
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };
  const comp1 = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `post-review-turn-${++counter}`,
    nonceFactory: () => "post-review-nonce",
  });
  comp1.startWorkflow({ workflowId: "post-review", workspaceId: "ws1", task: "implement" });
  const proposal = approvedProposal("post-review plan");
  const implementation = await comp1.runImplementation({
    workflowId: "post-review",
    iterationId: "post-review-impl",
    agentId: "implementation",
    task: "implement",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(implementation.status, "completed");
  if (implementation.status !== "completed") return;

  const verification = await comp1.runVerification({
    workflowId: "post-review",
    iterationId: "post-review-impl",
    agentId: "agent-verifier",
    targetTurnId: implementation.turnId,
    summary: implementation.summary,
    evidence: [],
  });
  assert.equal(verification.status, "valid");

  // A fresh process/resume must reuse the implementation and recognize that its
  // already-complete verification does not need another verifier dispatch.
  const reused = reuseImplementation(store, "post-review", "post-review-impl", {
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.deepEqual(reused, { turnId: implementation.turnId, summary: "implementation finished" });
  assert.equal(verificationCompleted(store, "post-review", "post-review-impl", implementation.turnId), true);
});

test("rehydrateViews restores addressal strategy and evidence from objection_addressal decisions", async () => {
  let proposalPath = "";
  const store = new PersistenceStore({ path: ":memory:" });
  const comp = composition(
    store,
    mkdtempSync(join(tmpdir(), "parrot-rehydrate-addr-")),
    (req) => {
      if (req.turnType.startsWith("planner")) {
        const addressed = req.iterationId.endsWith("iter-2")
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:9 adds gate", requiresGuardrailException: false }]
          : [];
        const text = authorEnvelope(req, "ship the rate limiter", addressed);
        proposalPath = join(dirname(req.resultPath), "proposal.md");
        return text;
      }
      if (req.turnType.includes("review")) {
        if (req.iterationId.endsWith("iter-1")) {
          return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
        }
        return pairClean(req, proposalPath);
      }
      return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    },
    "addr-",
  );
  await runReviewLoop(comp, loopInput);

  const views = rehydrateViews(store, "workflow-1");
  const obj = views.get("OBJ-1");
  assert.ok(obj, "OBJ-1 should be rehydrated");
  assert.equal(obj?.addressal?.resolutionStrategy, "revised_plan");
  assert.equal(obj?.addressal?.evidence, "proposal.md:9 adds gate");
});

test("buildResumeSeed throws when a Pair turn lacks suggestedResolution under reviewer@1.2.0", () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-multi-pair-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  const workflowId = "workflow-1";
  const iterationId = `${workflowId}-iter-1`;
  const proposalPath = join(runsRoot, "proposal.md");
  writeFileSync(proposalPath, "# Plan\n\napproved\n");
  const proposalHash = createHash("sha256").update("# Plan\n\napproved\n").digest("hex");

  seedWorkflow(store, workflowId);
  seedIteration(store, iterationId, workflowId);

  const plannerResultPath = join(runsRoot, "planner.toon");
  const plannerBytes = encodeToon({
    workflowId,
    iterationId,
    turnId: "planner-1",
    schemaVersion: "v1",
    nonce: "nonce-p",
    role: "planner",
    payload: {
      role: "planner",
      proposalPath,
      summary: "plan",
      objectionsAddressed: [],
    },
  });
  writeFileSync(plannerResultPath, plannerBytes);

  const pair1ResultPath = join(runsRoot, "pair1.toon");
  const pair1Bytes = encodeToon({
    workflowId,
    iterationId,
    turnId: "pair-1",
    schemaVersion: "v1",
    nonce: "nonce-r1",
    role: "reviewer",
    payload: {
      role: "reviewer",
      reviewedProposalPath: proposalPath,
      reviewedProposalHash: proposalHash,
      summary: "First pair review.",
      objections: [{ id: "OBJ-1", severity: "major", claim: "bad", evidence: ["src/a.ts:1"] }],
    },
  });
  writeFileSync(pair1ResultPath, pair1Bytes);

  const pair2ResultPath = join(runsRoot, "pair2.toon");
  const pair2Bytes = encodeToon({
    workflowId,
    iterationId,
    turnId: "pair-2",
    schemaVersion: "v1",
    nonce: "nonce-r2",
    role: "reviewer",
    payload: {
      role: "reviewer",
      reviewedProposalPath: proposalPath,
      reviewedProposalHash: proposalHash,
      summary: "Second pair review.",
      objections: [],
      cleanRationale: "Looks good.",
    },
  });
  writeFileSync(pair2ResultPath, pair2Bytes);

  store.saveTurn(baseTurn({
    turnId: "planner-1",
    workflowId,
    iterationId,
    agentId: "agent-planner",
    state: "completed",
    nonce: "nonce-p",
    promptVersion: "planner@1.8.0",
    resultPath: plannerResultPath,
  }));
  store.saveTurn(baseTurn({
    turnId: "pair-1",
    workflowId,
    iterationId,
    agentId: "agent-reviewer-a",
    state: "completed",
    nonce: "nonce-r1",
    promptVersion: "reviewer@1.2.0",
    resultPath: pair1ResultPath,
  }));
  store.saveTurn(baseTurn({
    turnId: "pair-2",
    workflowId,
    iterationId,
    agentId: "agent-reviewer-b",
    state: "completed",
    nonce: "nonce-r2",
    promptVersion: "reviewer@1.2.0",
    resultPath: pair2ResultPath,
  }));

  for (const [turnId, bytes] of [
    ["planner-1", plannerBytes],
    ["pair-1", pair1Bytes],
    ["pair-2", pair2Bytes],
  ] as const) {
    store.appendEvent({
      eventId: randomUUID(),
      occurredAt: "2026-07-23T10:00:00.000Z",
      workflowId,
      iterationId,
      turnId,
      agentId: turnId.startsWith("pair") ? "agent-reviewer" : "agent-planner",
      kind: "TurnCompleted",
      payload: { resultHash: sha256Hex(bytes) },
    });
  }

  const engine = new WorkflowEngine({
    store,
    notifications: { notifyEscalation: () => undefined },
  });
  engine.startWorkflow({ workflowId, workspaceId: "ws1", task: "test" });

  assert.throws(
    () => buildResumeSeed(engine, store, workflowId),
    /suggestedResolution|semantic validation/i,
  );
});

test("resume fallback uses the newest older frontier and verifies its completion hash", () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-frontier-fallback-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  const workflowId = "fallback";
  seedWorkflow(store, workflowId);

  const saveCompleted = (input: {
    iteration: number;
    turnId: string;
    agentId: string;
    promptVersion: string;
    role: string;
    payload: Record<string, unknown>;
  }) => {
    const iterationId = `${workflowId}-iter-${input.iteration}`;
    seedIteration(store, iterationId, workflowId);
    const resultPath = join(runsRoot, `${input.turnId}.toon`);
    const resultBytes = encodeToon({
      workflowId,
      iterationId,
      turnId: input.turnId,
      schemaVersion: "v1",
      nonce: `nonce-${input.turnId}`,
      role: input.role,
      payload: { role: input.role, ...input.payload },
    });
    writeFileSync(resultPath, resultBytes, "utf8");
    store.saveTurn(baseTurn({
      turnId: input.turnId,
      workflowId,
      iterationId,
      agentId: input.agentId,
      state: "completed",
      nonce: `nonce-${input.turnId}`,
      promptVersion: input.promptVersion,
      resultPath,
    }));
    appendTurnCompleted(store, input.turnId, resultBytes, {
      workflowId,
      iterationId,
      agentId: input.agentId,
    });
    return { resultBytes, resultPath };
  };

  saveCompleted({
    iteration: 1,
    turnId: "frontier-1",
    agentId: "frontier",
    promptVersion: "frontier@1.0.0",
    role: "frontier",
    payload: { readiness: "ready", risks: [], questions: [] },
  });
  const newestFrontier = saveCompleted({
    iteration: 2,
    turnId: "frontier-2",
    agentId: "frontier",
    promptVersion: "frontier@1.0.0",
    role: "frontier",
    payload: { readiness: "not_ready", risks: [], questions: [] },
  });
  const proposalPath = join(runsRoot, "proposal.md");
  writeFileSync(proposalPath, "# Plan\n\nCurrent proposal\n", "utf8");
  saveCompleted({
    iteration: 3,
    turnId: "planner-3",
    agentId: "planner",
    promptVersion: "planner@1.8.0",
    role: "planner",
    payload: { proposalPath, summary: "current", objectionsAddressed: [] },
  });

  const engine = new WorkflowEngine({
    store,
    notifications: { notifyEscalation: () => undefined },
  });
  engine.startWorkflow({ workflowId, workspaceId: "ws1", task: "test" });
  assert.equal(buildResumeSeed(engine, store, workflowId).frontierReadiness, "not_ready");

  writeFileSync(
    newestFrontier.resultPath,
    newestFrontier.resultBytes.replace("not_ready", "ready"),
    "utf8",
  );
  assert.throws(
    () => buildResumeSeed(engine, store, workflowId),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});

test("resume adoption preserves original turn identity for completed turn", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  const resultPath = join(tmpdir(), `resume-test-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  const text = encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "completed-t1",
    schemaVersion: "v1", nonce: "n1", role: "planner",
    payload: { role: "planner", proposalPath: "plan.md", summary: "s", objectionsAddressed: [] },
  });
  writeFileSync(resultPath, text, "utf8");

  store.saveTurn(baseTurn({
    turnId: "completed-t1", nonce: "n1", resultPath, state: "completed",
  }));
  appendTurnCompleted(store, "completed-t1", text);

  const comp = adoptComp(store, () => { throw new Error("should not be called"); }, "preserve");
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1"); // populate the resume registry

  const result = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "w1",
    iterationId: "i1",
    agentId: "a1",
    context: { task: "t" },
  });
  assert.equal(result.status, "valid");
  assert.equal(result.turnId, "completed-t1");
  assert.equal(store.getTurn("completed-t1")?.state, "completed");
});

test("resume rehydrates a completed planner turn whose result.toon used the pre-Phase-10 bare-ID objectionsAddressed form", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  const resultPath = join(tmpdir(), `resume-legacy-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  const text = encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "legacy-t1",
    schemaVersion: "v1", nonce: "n1", role: "planner",
    // Pre-Phase-10 shape: bare objection ID strings, no evidence/strategy/guardrail fields.
    payload: { role: "planner", proposalPath: "plan.md", summary: "s", objectionsAddressed: ["OBJ-1", "OBJ-2"] },
  });
  writeFileSync(resultPath, text, "utf8");

  store.saveTurn(baseTurn({
    turnId: "legacy-t1", nonce: "n1", resultPath, state: "completed",
  }));
  appendTurnCompleted(store, "legacy-t1", text);

  const comp = adoptComp(store, () => { throw new Error("should not be called"); }, "legacy");
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1"); // populate the resume registry

  const result = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "w1",
    iterationId: "i1",
    agentId: "a1",
    context: { task: "t" },
  });
  assert.equal(result.status, "valid");
  assert.equal(result.turnId, "legacy-t1");
  const payload = result.status === "valid" ? (result.payload as { objectionsAddressed: Array<{ objectionId: string }> }) : undefined;
  assert.deepEqual(payload?.objectionsAddressed.map((a) => a.objectionId), ["OBJ-1", "OBJ-2"]);
});

test("startTurn rejects duplicate IDs in engine", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");
  store.saveTurn(baseTurn({
    turnId: "existing", state: "created",
  }));

  const comp = createComposition({
    store,
    runner: createFixtureRunner(() => ""),
    humanSink: createMemorySink(),
    runsRoot: tmpdir(),
    writePrompts: false,
    newId: () => `existing`,
    nonceFactory: () => "n",
  });
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  await assert.rejects(() => comp.runTurn({
    turnType: "planner_propose",
    workflowId: "w1", iterationId: "i1", agentId: "a1",
    context: { task: "t" },
  }), /already exists/);
  assert.equal(store.getTurn("existing")?.state, "created");
});

test("waiting turn with unresolved resolution findings cancelled, fresh verification dispatched", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");

  const resultPath = join(tmpdir(), `parrot-waitunres-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "w-turn",
    schemaVersion: "v1", nonce: "n", role: "resolution",
    payload: { role: "resolution", verified: ["expected-target"], unresolved: ["OBJ-1"] },
  }), "utf8");

  store.saveTurn(baseTurn({
    turnId: "w-turn", nonce: "n", resultPath, state: "waiting",
  }));

  let calls = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      calls++;
      return encodeToon({
        workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
        schemaVersion: "v1", nonce: req.nonce, role: "resolution",
        payload: { role: "resolution", verified: ["expected-target"], unresolved: [] },
      });
    }),
    humanSink: createMemorySink(),
    runsRoot: tmpdir(),
    writePrompts: false,
    newId: () => `fresh-${calls}`,
    nonceFactory: () => "fn",
  });
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1");

  const result = await comp.runTurn({
    turnType: "resolution_verification",
    workflowId: "w1", iterationId: "i1", agentId: "a1",
    context: { verificationTarget: { objectionId: "expected-target", plannerResponse: "impl summary for verification", evidence: [] } },
  });

  assert.equal(store.getTurn("w-turn")?.state, "cancelled", "waiting turn should be cancelled, not committed");
  assert.notEqual(result.turnId, "w-turn");
  assert.equal(calls, 1, "fresh verifier should have been dispatched");
});

test("waiting turn with missing target in verified list cancelled, fresh verification dispatched", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");

  const resultPath = join(tmpdir(), `parrot-misstarget-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "w-turn",
    schemaVersion: "v1", nonce: "n", role: "resolution",
    payload: { role: "resolution", verified: ["unrelated-turn"], unresolved: [] },
  }), "utf8");

  store.saveTurn(baseTurn({
    turnId: "w-turn", nonce: "n", resultPath, state: "waiting",
  }));

  let calls = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      calls++;
      return encodeToon({
        workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
        schemaVersion: "v1", nonce: req.nonce, role: "resolution",
        payload: { role: "resolution", verified: ["expected-target"], unresolved: [] },
      });
    }),
    humanSink: createMemorySink(),
    runsRoot: tmpdir(),
    writePrompts: false,
    newId: () => `fresh-${calls}`,
    nonceFactory: () => "fn",
  });
  comp.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp.resumeWorkflow("w1");

  const result = await comp.runTurn({
    turnType: "resolution_verification",
    workflowId: "w1", iterationId: "i1", agentId: "a1",
    context: { verificationTarget: { objectionId: "expected-target", plannerResponse: "impl summary for verification", evidence: [] } },
  });

  assert.equal(store.getTurn("w-turn")?.state, "cancelled", "waiting turn should be cancelled, not committed");
  assert.notEqual(result.turnId, "w-turn");
  assert.equal(calls, 1, "fresh verifier should have been dispatched");
});

test("completed semantically invalid resolution bypassed for fresh verification on each resume", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store);
  seedIteration(store, "i1");

  const resultPath = join(tmpdir(), `parrot-compbad-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  const staleResult = encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "bad-comp",
    schemaVersion: "v1", nonce: "n", role: "resolution",
    payload: { role: "resolution", verified: ["expected-target"], unresolved: ["OBJ-1"] },
  });
  writeFileSync(resultPath, staleResult, "utf8");

  store.saveTurn(baseTurn({
    turnId: "bad-comp", nonce: "n", resultPath, state: "completed",
  }));
  appendTurnCompleted(store, "bad-comp", staleResult);

  // First resume: should bypass the stale completed turn and dispatch fresh.
  let calls1 = 0;
  const comp1 = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      calls1++;
      const text = encodeToon({
        workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
        schemaVersion: "v1", nonce: req.nonce, role: "resolution",
        payload: { role: "resolution", verified: ["expected-target"], unresolved: [] },
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }),
    humanSink: createMemorySink(),
    runsRoot: tmpdir(),
    writePrompts: false,
    newId: () => `a-${calls1}`,
    nonceFactory: () => "a-n",
  });
  comp1.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp1.resumeWorkflow("w1");

  const result1 = await comp1.runTurn({
    turnType: "resolution_verification",
    workflowId: "w1", iterationId: "i1", agentId: "a1",
    context: { verificationTarget: { objectionId: "expected-target", plannerResponse: "impl summary for verification", evidence: [] } },
  });
  assert.equal(result1.status, "valid");
  assert.ok(calls1 >= 1, "fresh verifier should be dispatched, not stale completed turn adopted");

  // Second resume: stale turn is still completed in the DB. Regardless of
  // which candidate the registry picks, the result must complete cleanly
  // (valid adoption or fresh dispatch) and never loop with zero-runner failed.
  let calls2 = 0;
  const comp2 = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      calls2++;
      const text = encodeToon({
        workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
        schemaVersion: "v1", nonce: req.nonce, role: "resolution",
        payload: { role: "resolution", verified: ["expected-target"], unresolved: [] },
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }),
    humanSink: createMemorySink(),
    runsRoot: tmpdir(),
    writePrompts: false,
    newId: () => `b-${calls2}`,
    nonceFactory: () => "b-n",
  });
  comp2.startWorkflow({ workflowId: "w1", workspaceId: "ws1", task: "t" });
  comp2.resumeWorkflow("w1");

  const result2 = await comp2.runTurn({
    turnType: "resolution_verification",
    workflowId: "w1", iterationId: "i1", agentId: "a1",
    context: { verificationTarget: { objectionId: "expected-target", plannerResponse: "impl summary for verification", evidence: [] } },
  });
  assert.ok(
    result2.status === "valid",
    "second resume should complete with valid status, not loop on stale artifact",
  );
});

test("resume decision pairReviewSummaries match fresh run at human_decision", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-pair-summaries-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  let freshContext:
    | { pairReviewSummaries?: Array<{ agentId: string; summary: string }> }
    | undefined;
  const pairSummary = "Resume parity pair summary marker";

  const replyAtDecision = (req: AgentTurnRequest, state: { proposalPath: string }): string => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the rate limiter");
      state.proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      const hash = createHash("sha256").update(readFileSync(state.proposalPath)).digest("hex");
      return envelope(req, "reviewer", {
        reviewedProposalPath: state.proposalPath,
        reviewedProposalHash: hash,
        summary: pairSummary,
        objections: [],
        cleanRationale: "All criteria satisfied.",
      });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  };

  const first = recordingResolver(runsRoot, replyAtDecision);
  const comp1 = composition(store, runsRoot, first.resolver, "pair-a-");
  await assert.rejects(
    runReviewLoop(comp1, {
      ...loopInput,
      decide: (ctx) => {
        freshContext = ctx;
        throw new Error("interrupt at human_decision");
      },
    }),
    /interrupt at human_decision/,
  );
  assert.deepEqual(freshContext?.pairReviewSummaries, [{ agentId: "agent-reviewer", summary: pairSummary }]);

  const compForSeed = composition(store, runsRoot, first.resolver, "pair-seed-");
  const seed = compForSeed.resumeWorkflow("workflow-1");
  assert.deepEqual(seed.pairReviewSummaries, freshContext?.pairReviewSummaries);

  let resumeContext:
    | { pairReviewSummaries?: Array<{ agentId: string; summary: string }> }
    | undefined;
  const second = recordingResolver(runsRoot, replyAtDecision);
  const comp2 = composition(store, runsRoot, second.resolver, "pair-b-");
  const result = await runReviewLoop(comp2, {
    ...loopInput,
    resume: seed,
    decide: (ctx) => {
      resumeContext = ctx;
      return { decision: "approved" };
    },
  });
  assert.equal(result.phase, "approved");
  assert.deepEqual(resumeContext?.pairReviewSummaries, freshContext?.pairReviewSummaries);
});

test("tampered completed implementation result.toon throws on reuseImplementation", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-tamper-impl-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  let counter = 0;
  const resolver = (req: AgentTurnRequest): string => {
    const text = envelope(req, "implementation", { status: "completed", summary: "implementation finished" });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };
  const comp1 = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `post-review-turn-${++counter}`,
    nonceFactory: () => "post-review-nonce",
  });
  comp1.startWorkflow({ workflowId: "post-review", workspaceId: "ws1", task: "implement" });
  const proposal = approvedProposal("post-review plan");
  const implementation = await comp1.runImplementation({
    workflowId: "post-review",
    iterationId: "post-review-impl",
    agentId: "implementation",
    task: "implement",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(implementation.status, "completed");
  if (implementation.status !== "completed") return;

  const turn = store.getTurn(implementation.turnId);
  writeFileSync(String(turn?.result_path), "tampered implementation bytes\n");

  assert.throws(
    () => reuseImplementation(store, "post-review", "post-review-impl", {
      proposalPath: proposal.proposalPath,
      proposalHash: proposal.proposalHash,
    }),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});

test("tampered verification result throws from verificationCompleted", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-tamper-verify-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  let counter = 0;
  const resolver = (req: AgentTurnRequest): string => {
    const role = req.turnType === "implementation" ? "implementation" : "resolution";
    const payload = role === "implementation"
      ? { status: "completed", summary: "implementation finished" }
      : { verified: ["post-review-turn-1"], unresolved: [] };
    const text = envelope(req, role, payload);
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };
  const comp1 = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `post-review-turn-${++counter}`,
    nonceFactory: () => "post-review-nonce",
  });
  comp1.startWorkflow({ workflowId: "post-review", workspaceId: "ws1", task: "implement" });
  const proposal = approvedProposal("post-review plan");
  const implementation = await comp1.runImplementation({
    workflowId: "post-review",
    iterationId: "post-review-impl",
    agentId: "implementation",
    task: "implement",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(implementation.status, "completed");
  if (implementation.status !== "completed") return;

  const verification = await comp1.runVerification({
    workflowId: "post-review",
    iterationId: "post-review-impl",
    agentId: "verifier",
    targetTurnId: implementation.turnId,
    summary: implementation.summary,
    evidence: [],
  });
  assert.equal(verification.status, "valid");

  const verifyTurn = store.getTurn(verification.turnId);
  writeFileSync(String(verifyTurn?.result_path), "tampered verification bytes\n");

  assert.throws(
    () => verificationCompleted(store, "post-review", "post-review-impl", implementation.turnId),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});
