import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  ResumeTurnRegistry,
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

function recordingResolver(
  runsRoot: string,
  reply: (req: AgentTurnRequest) => { role: string; payload: Record<string, unknown> },
  throwOn?: { turnType: string; once: boolean },
) {
  const delivered: string[] = [];
  let thrown = false;
  const resolver = (req: AgentTurnRequest): string => {
    delivered.push(req.turnType);
    if (throwOn && req.turnType === throwOn.turnType && !(throwOn.once && thrown)) {
      thrown = true;
      throw new Error(`simulated interruption on ${req.turnType}`);
    }
    const { role, payload } = reply(req);
    const text = envelope(req, role, payload);
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };
  return { resolver, delivered };
}

function reply(req: AgentTurnRequest): { role: string; payload: Record<string, unknown> } {
  if (req.turnType.startsWith("planner")) {
    return { role: "planner", payload: { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] } };
  }
  if (req.turnType.includes("review")) {
    return { role: "reviewer", payload: { objections: [] } };
  }
  return { role: "frontier", payload: { readiness: "ready", risks: [], questions: [] } };
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
  assert.equal(seed.finalProposalPath, "plan.md");

  const result = await runReviewLoop(comp2, { ...loopInput, resume: seed });
  assert.equal(result.phase, "approved");
  assert.equal(result.finalProposalPath, "plan.md");

  assert.deepEqual(
    second.delivered.filter((t) => t.startsWith("planner") || t.includes("review")),
    [],
  );
  assert.ok(second.delivered.includes("frontier_report"));
});

test("resume rehydrates open objections raised before the interruption", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-resume-obj-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  const replyWithObjection = (req: AgentTurnRequest): { role: string; payload: Record<string, unknown> } => {
    if (req.turnType.includes("review") && req.iterationId.endsWith("iter-1")) {
      return { role: "reviewer", payload: { objections: [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }] } };
    }
    return reply(req);
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

  const comp = adoptComp(store, (req) => encodeToon({
    workflowId: req.workflowId, iterationId: req.iterationId, turnId: req.turnId,
    schemaVersion: "v1", nonce: req.nonce, role: "planner",
    payload: { role: "planner", proposalPath: "plan.md", summary: "s", objectionsAddressed: [] },
  }), "missing");
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
  writeFileSync(resultPath, encodeToon({
    workflowId: "w1", iterationId: "i1", turnId: "bad-comp",
    schemaVersion: "v1", nonce: "n", role: "resolution",
    payload: { role: "resolution", verified: ["expected-target"], unresolved: ["OBJ-1"] },
  }), "utf8");

  store.saveTurn(baseTurn({
    turnId: "bad-comp", nonce: "n", resultPath, state: "completed",
  }));

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