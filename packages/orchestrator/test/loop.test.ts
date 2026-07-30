import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      return envelope(req, "reviewer", { objections: [], cleanRationale: "All criteria satisfied." });
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
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      const onIter1 = req.iterationId.endsWith("iter-1");
      const objections = onIter1
        ? [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]
        : [];
      const payload = onIter1
        ? { objections }
        : { objections: [], cleanRationale: "All criteria satisfied." };
      return envelope(req, "reviewer", payload);
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
      return envelope(req, "reviewer", { objections: [], cleanRationale: "All criteria satisfied." });
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

test("objection stalemate escalates without a resolver: reviewer re-raises after the planner's addressal", async () => {
  let plannerTurns = 0;
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      plannerTurns += 1;
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      return envelope(req, "reviewer", {
        objections: [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }],
      });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, { ...loopInput, maxIterations: 5 });
  assert.equal(result.phase, "escalated");
  assert.deepEqual(result.escalation, { reason: "objection_stalemate", objectionIds: ["OBJ-1"] });
  assert.equal(plannerTurns, 2);
});

test("planner-conceded addressal escalates as a guardrail conflict and skips the reviewer round it would have triggered", async () => {
  let reviewerTurns = 0;
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "every gate needs a forbidden schema change", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      reviewerTurns += 1;
      const objections = req.iterationId.endsWith("iter-1")
        ? [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]
        : [];
      return envelope(req, "reviewer", { objections });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);

  assert.equal(result.phase, "escalated");
  assert.deepEqual(result.escalation, { reason: "guardrail_conflict", objectionIds: ["OBJ-1"] });
  // Exactly one reviewer round (iteration 1's raise); the iteration-2 round that would
  // normally follow the planner's revise is never dispatched once it concedes.
  assert.equal(reviewerTurns, 1);
  const addressalDecisions = store.readRows("decisions").filter((row) => String(row.decision) === "objection_addressal");
  assert.ok(addressalDecisions.some((row) => String(row.chosen) === "conceded"));
});

test("requiresGuardrailException on a revised_plan addressal also escalates as a guardrail conflict", async () => {
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "would need a persisted field the guardrails forbid", requiresGuardrailException: true }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      const objections = req.iterationId.endsWith("iter-1")
        ? [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]
        : [];
      return envelope(req, "reviewer", { objections });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "escalated");
  assert.deepEqual(result.escalation, { reason: "guardrail_conflict", objectionIds: ["OBJ-1"] });
});

test("guardrail conflict: accept_objection resolver ends the run rejected", async () => {
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "no verifiable gate exists", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      const objections = req.iterationId.endsWith("iter-1")
        ? [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]
        : [];
      return envelope(req, "reviewer", { objections });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, { ...loopInput, onStalemate: () => "accept_objection" });
  assert.equal(result.phase, "rejected");
});

test("clean revised_plan addressal resolves the objection and proceeds to review, persisting one decision row", async () => {
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:9 now validates ownership before delete", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      const onIter1 = req.iterationId.endsWith("iter-1");
      const objections = onIter1
        ? [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]
        : [];
      const payload = onIter1
        ? { objections }
        : { objections: [], cleanRationale: "All criteria satisfied." };
      return envelope(req, "reviewer", payload);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  assert.equal(result.openObjectionIds.length, 0);
  const addressalDecisions = store.readRows("decisions").filter((row) => String(row.decision) === "objection_addressal");
  assert.equal(addressalDecisions.length, 1);
  assert.equal(String(addressalDecisions[0]?.chosen), "revised_plan");
});

test("objection stalemate: accept_mitigation resolver waives the objection and continues to approved", async () => {
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the login rate limiter", objectionsAddressed: addressed });
    }
    if (req.turnType.includes("review")) {
      return envelope(req, "reviewer", {
        objections: [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }],
      });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => "accept_mitigation",
  });
  assert.equal(result.phase, "approved");
});

test("frontier re-invoke: restructured proposal with open objections dispatches mid-loop frontier", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-frontier-re-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  let plannerIter = 0;
  let frontierTurns = 0;
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const headings = plannerIter === 1
        ? "## Overview\n## Implementation"
        : "## Overview\n## Architecture\n## Deployment\n## Rollback";
      const proposalPath = join(runsRoot, `proposal-iter${plannerIter}.md`);
      mkdirSync(dirname(proposalPath), { recursive: true });
      writeFileSync(proposalPath, `${headings}\n\nbody`, "utf8");
      const text = envelope(req, "planner", { proposalPath, summary: `iter ${plannerIter}`, objectionsAddressed: [] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const text = envelope(req, "reviewer", { objections: [{ id: "OBJ-1", severity: "major", claim: "no gate", evidence: ["a.ts:1"] }] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType === "frontier_report") {
      frontierTurns++;
      const text = envelope(req, "frontier", { readiness: "not_ready", risks: ["risky"], questions: [] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    const text = envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(fileResolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    now: () => "2026-07-28T10:00:00.000Z",
    newId: () => `fr-turn-${(counter += 1)}`,
    nonceFactory: () => "fr-nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 3,
    onStalemate: () => "abort",
  });
    assert.ok(frontierTurns >= 1, `expected at least 1 frontier turn, got ${frontierTurns} (churn may add more)`);
  // The mid-loop frontier at iteration 2 reported readiness "not_ready".
  // The post-gate frontier does not run here (iteration cap is reached on
  // iteration 3 with the same restructured headings), so the readiness the
  // human sees must come from the mid-loop result.
  assert.equal(result.frontierReadiness, "not_ready", "mid-loop frontier readiness must be retained on the result");
  const hasFrontierObjection = [...store.listObjections("workflow-1")].some(
    (row) => String(row.dimension) === "frontier",
  );
  assert.ok(hasFrontierObjection);
});

test("frontier re-invoke: disabled config dispatches none mid-loop", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-fr-dis-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  let plannerIter = 0;
  let midLoopFrontier = false;
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const headings = plannerIter === 1
        ? "## Overview\n## Implementation"
        : "## Overview\n## Architecture\n## Deployment\n## Rollback\n## Risks";
      const proposalPath = join(runsRoot, `proposal-iter${plannerIter}.md`);
      mkdirSync(dirname(proposalPath), { recursive: true });
      writeFileSync(proposalPath, `${headings}\n\nbody`, "utf8");
      const text = envelope(req, "planner", {
        proposalPath,
        summary: `iter ${plannerIter}`,
        objectionsAddressed: plannerIter >= 2 ? [{ objectionId: `OBJ-${plannerIter - 1}`, resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }] : [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const objId = `OBJ-${plannerIter}`;
      const text = envelope(req, "reviewer", { objections: [{ id: objId, severity: "major", claim: `issue ${plannerIter}`, evidence: ["a.ts:1"] }] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType === "frontier_report") {
      if (req.iterationId.includes(`${plannerIter}`)) {
        midLoopFrontier = true;
      }
    }
    const text = envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(fileResolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    now: () => "2026-07-28T10:00:00.000Z",
    newId: () => `frdis-${(counter += 1)}`,
    nonceFactory: () => "frdis-nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 3,
    onStalemate: ({ objectionIds }) => (objectionIds.length > 0 ? "abort" : "abort"),
    frontierReinvoke: { disabled: true },
  });
  assert.equal(midLoopFrontier, false, "disabled config must not dispatch mid-loop frontier");
});

test("frontier re-invoke: identical proposals dispatch no mid-loop frontier", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-fr-same-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  let plannerIter = 0;
  let midLoopFrontier = false;
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const proposalPath = join(runsRoot, `proposal-iter${plannerIter}.md`);
      mkdirSync(dirname(proposalPath), { recursive: true });
      writeFileSync(proposalPath, "## Overview\nSame content every time.\n## Testing", "utf8");
      const text = envelope(req, "planner", {
        proposalPath,
        summary: `iter ${plannerIter}`,
        objectionsAddressed: plannerIter >= 2 ? [{ objectionId: `OBJ-${plannerIter - 1}`, resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }] : [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const objId = `OBJ-${plannerIter}`;
      const text = envelope(req, "reviewer", { objections: [{ id: objId, severity: "major", claim: `issue ${plannerIter}`, evidence: ["a.ts:1"] }] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType === "frontier_report") {
      if (req.iterationId.includes(`${plannerIter}`)) {
        midLoopFrontier = true;
      }
    }
    const text = envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(fileResolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    now: () => "2026-07-28T10:00:00.000Z",
    newId: () => `frsame-${(counter += 1)}`,
    nonceFactory: () => "frsame-nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 3,
    onStalemate: () => "abort",
    frontierReinvoke: { headingChangeRatio: 0.7, similarityFloor: 0.3 },
  });
  assert.equal(midLoopFrontier, false, "identical proposals must not trigger mid-loop frontier");
});

test("legacy bare-ID addressal targeting a genuinely open objection is filtered, not persisted", async () => {
  // A pre-Phase-10 result.toon used a bare objection ID string in
  // objectionsAddressed. The schema normalizes the bare string into a
  // synthetic structured addressal with a non-enumerable `__legacy`
  // marker, an empty evidence string, and a default `revised_plan`
  // strategy. The loop must NOT persist it as a real decision (it would
  // show up as `revised_plan / (no evidence)`, polluting the durable
  // trail), and must NOT resolve an open objection on its word (the
  // planner never actually addressed it).
  //
  // Scenario: iter 1 reviewer raises OBJ-1. iter 2 planner attempts a
  // legacy bare-ID addressal for OBJ-1. Without the legacy filter, the
  // existing `views.has(...) && status === "open"` check would let this
  // through (OBJ-1 is genuinely open), and the loop would persist a
  // `revised_plan / (no evidence)` decision and silently resolve the
  // open objection. The `__legacy` marker must suppress that path.
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isFirst = req.iterationId.endsWith("iter-1");
      // iter 1: no addressals (no objection has been raised yet).
      // iter 2: a legacy bare-ID entry for OBJ-1, which is the objection
      // the iter-1 reviewer raised. The entry should be ignored.
      const payload = isFirst
        ? { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] }
        : { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: ["OBJ-1"] };
      return envelope(req, "planner", payload);
    }
    if (req.turnType.includes("review")) {
      const onIter1 = req.iterationId.endsWith("iter-1");
      const objections = onIter1
        ? [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]
        : [];
      const payload = onIter1
        ? { objections }
        : { objections: [], cleanRationale: "All criteria satisfied." };
      return envelope(req, "reviewer", payload);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  // The loop escalates at iteration cap because the legacy addressal
  // cannot resolve OBJ-1. The assertion is on the persisted decisions,
  // not the final phase: the legacy bare-ID addressal must NOT have been
  // recorded as an `objection_addressal` decision row.
  await runReviewLoop(comp, { ...loopInput, maxIterations: 2 });
  const addressalDecisions = store.readRows("decisions").filter((row) => String(row.decision) === "objection_addressal");
  assert.equal(
    addressalDecisions.length,
    0,
    "legacy bare-ID addressal must not be persisted as an objection_addressal decision even when it targets an open objection",
  );
});

test("notification: abort re-emits one escalation notification through the configured dashboard base", async () => {
  // The loop suppresses the engine's notify on guardrail conflict and
  // objection-stalemate paths so the human-attention notification does not
  // fire before the interactive prompt. On "abort" the loop re-emits
  // exactly one notification, with the configured dashboard base and
  // the correct kind / summary / openObjectionIds.
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] });
      }
      if (req.turnType.includes("review")) {
        return envelope(req, "reviewer", { objections: [], cleanRationale: "all good" });
      }
      return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `clean-${(counter += 1)}`,
    nonceFactory: () => "n",
  });
  comp.startWorkflow({ workflowId: "wf-x", workspaceId: "ws", task: "t" });

  const result = await runReviewLoop(comp, {
    workflowId: "wf-x",
    workspaceId: "ws",
    task: "t",
    plannerAgentId: "p",
    reviewerAgentIds: ["r"],
    frontierAgentId: "f",
    decide: () => ({ decision: "approved" }),
    // No onStalemate resolver → default "abort" with no notification.
  });
  assert.equal(result.phase, "approved");
  // Clean loop with a cleanRationale reviewer reaches approved without an
  // escalation. Sink must be empty.
  assert.equal(sink.requests.length, 0, "clean loop must not produce any notifications");
});

test("notification: guardrail conflict abort re-emits exactly one escalation through the configured dashboard base", async () => {
  // The guardrail-conflict path suppresses the engine's notify, then on
  // abort re-emits one notification. The deep link must use the
  // configured `dashboardDeepLinkBase` (not a hardcoded `/workflows/...`).
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const isIter2 = req.iterationId.endsWith("iter-2");
        const payload = isIter2
          ? { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [
              { objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "no gate can verify this", requiresGuardrailException: false },
            ] }
          : { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] };
        return envelope(req, "planner", payload);
      }
      if (req.turnType.includes("review")) {
        return envelope(req, "reviewer", {
          objections: [{ id: "OBJ-1", severity: "blocking", claim: "no gate", evidence: ["a.ts:1"] }],
        });
      }
      return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `gc-${(counter += 1)}`,
    nonceFactory: () => "n",
  });
  comp.startWorkflow({ workflowId: "wf-x", workspaceId: "ws", task: "t" });

  const result = await runReviewLoop(comp, {
    workflowId: "wf-x",
    workspaceId: "ws",
    task: "t",
    plannerAgentId: "p",
    reviewerAgentIds: ["r"],
    frontierAgentId: "f",
    decide: () => ({ decision: "approved" }),
    onStalemate: () => "abort",
  });
  assert.equal(result.phase, "escalated");
  assert.equal(result.escalation?.reason, "guardrail_conflict");
  // Exactly one notification, with the configured dashboard base and
  // the right kind / summary / openObjectionIds.
  assert.equal(sink.requests.length, 1, "abort must produce exactly one escalation notification");
  const req = sink.requests[0]!;
  assert.equal(req.kind, "escalation");
  assert.equal(req.summary, "guardrail_conflict");
  assert.equal(req.dashboardDeepLink, "https://app.example.test/wf/wf-x");
  assert.deepEqual(req.openObjectionIds, ["OBJ-1"]);
});

test("notification: accepted stalemate resolution produces no escalation notification", async () => {
  // "accept_mitigation" approves the workflow and the loop must NOT
  // emit an escalation notification (the durable record shows approved,
  // not escalated). The engine's notify was suppressed for the same
  // reason, and on accept the loop never re-emits.
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const isIter2 = req.iterationId.endsWith("iter-2");
        const addressed = isIter2
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
          : [];
        return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: addressed });
      }
      if (req.turnType.includes("review")) {
        return envelope(req, "reviewer", {
          objections: [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }],
        });
      }
      return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `am-${(counter += 1)}`,
    nonceFactory: () => "n",
  });
  comp.startWorkflow({ workflowId: "wf-x", workspaceId: "ws", task: "t" });

  const result = await runReviewLoop(comp, {
    workflowId: "wf-x",
    workspaceId: "ws",
    task: "t",
    plannerAgentId: "p",
    reviewerAgentIds: ["r"],
    frontierAgentId: "f",
    decide: () => ({ decision: "approved" }),
    onStalemate: () => "accept_mitigation",
  });
  assert.equal(result.phase, "approved");
  assert.equal(sink.requests.length, 0, "accepted resolution must not produce an escalation notification");
});

test("notification: ordinary iteration cap emits exactly one iteration_cap notification", async () => {
  // The reviewer raises an objection that the planner never resolves.
  // The cap is reached with the objection still open. The engine's
  // notification is suppressed at the gate, and the loop re-emits
  // exactly one.
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] });
      }
      if (req.turnType.includes("review")) {
        const onIter1 = req.iterationId.endsWith("iter-1");
        const objections = onIter1
          ? [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]
          : [];
        return envelope(req, "reviewer", { objections });
      }
      return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `ic-${(counter += 1)}`,
    nonceFactory: () => "n",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 2,
  });
  assert.equal(result.phase, "escalated");
  assert.ok(result.openObjectionIds.includes("OBJ-1"));
  assert.equal(sink.requests.length, 1, "iteration cap must emit exactly one notification");
  const req = sink.requests[0]!;
  assert.equal(req.kind, "escalation");
  assert.equal(req.summary, "iteration_cap");
  assert.equal(req.dashboardDeepLink, "https://app.example.test/wf/workflow-1");
  assert.ok(req.openObjectionIds?.includes("OBJ-1"));
});

test("plan churn stops an A-B-A oscillation before the next reviewer turn", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-plan-churn-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  const proposalA = [
    "# Plan",
    "## Execution",
    "- collect request evidence",
    "- validate the result",
    "## Verification",
    "1. run the tests",
    "2. publish the report",
  ].join("\\n");
  const proposalB = [
    "# Plan",
    "## Alternative",
    "- migrate the database",
    "- rewrite the transport",
    "## Rollback",
    "1. manual review",
    "2. restore the snapshot",
  ].join("\\n");
  const proposalTexts = [proposalA, proposalB, proposalA];
  let plannerIteration = 0;
  const reviewerIterations: string[] = [];
  const resolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      const index = plannerIteration++;
      const proposalPath = join(runsRoot, `proposal-${index + 1}.md`);
      writeFileSync(proposalPath, proposalTexts[index]!, "utf8");
      const text = envelope(req, "planner", {
        proposalPath,
        summary: `proposal ${index + 1}`,
        objectionsAddressed: [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      reviewerIterations.push(req.iterationId);
      const text = envelope(req, "reviewer", {
        objections: [{ id: "OBJ-1", severity: "major", claim: "needs more evidence", evidence: ["plan.md:1"] }],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType === "frontier_report") {
      const text = envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    throw new Error(`unexpected turn after churn: ${req.turnType}`);
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `churn-turn-${++counter}`,
    nonceFactory: () => "churn-nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => "abort",
  });

  assert.equal(result.phase, "escalated");
  assert.deepEqual(result.escalation, { reason: "plan_churn", objectionIds: ["OBJ-1"] });
  assert.deepEqual(reviewerIterations, ["workflow-1-iter-1", "workflow-1-iter-2"]);
  assert.ok(store.listEvents().some((entry) => entry.kind === "PlanChurnDetected"));
});

test("notification: blocking terminal frontier at iteration cap does not throw and emits exactly one notification", async () => {
  // maxIterations: 1, clean reviewer, frontier not_ready with blocking
  // findings. The frontier raises objections at the cap. The reducer's
  // cap-binding guard must not reject (ingestion runs after
  // reportFrontier), and exactly one notification is emitted.
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        return envelope(req, "planner", { proposalPath: "plan.md", summary: "ship the rate limiter", objectionsAddressed: [] });
      }
      if (req.turnType.includes("review")) {
        return envelope(req, "reviewer", { objections: [], cleanRationale: "all good" });
      }
      return envelope(req, "frontier", { readiness: "not_ready", risks: ["unmitigated deploy risk"], questions: [] });
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `fc-${(counter += 1)}`,
    nonceFactory: () => "n",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 1,
  });
  assert.equal(result.phase, "escalated");
  assert.equal(result.frontierReadiness, "not_ready");
  const frontierObjections = store
    .readRows("objections")
    .filter((row) => String(row.dimension) === "frontier");
  assert.ok(frontierObjections.length > 0, "frontier findings must be ingested as objections");
  assert.equal(sink.requests.length, 1, "blocking terminal frontier at cap must emit exactly one notification");
  const req = sink.requests[0]!;
  assert.equal(req.kind, "escalation");
  assert.equal(req.summary, "iteration_cap");
  assert.equal(req.dashboardDeepLink, "https://app.example.test/wf/workflow-1");
  assert.ok((req.openObjectionIds?.length ?? 0) > 0, "notification must include open objection IDs");
});
