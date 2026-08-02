import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import {
  createComposition,
  createFixtureRunner,
  runReviewLoop,
  type AgentTurnRequest,
} from "../src/index.js";
import {
  authorEnvelope,
  envelope,
  pairClean,
  pairObjections,
} from "./author-pair-fixtures.js";

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
  const progress: string[] = [];
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the login rate limiter");
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, { ...loopInput, onProgress: (line) => progress.push(line) });
  assert.equal(result.phase, "approved");
  assert.equal(result.frontierReadiness, "ready");
  assert.equal(result.finalProposalPath, proposalPath);
  assert.deepEqual(progress, [
    "[author iter 1] ship the login rate limiter",
    "[pair iter 1] objections=0, cleanRationale=present",
    "[frontier iter 1] readiness=ready, risks=0, questions=0",
  ]);
});

test("reviewer objection forces a revise, then converges to approved", async () => {
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      const onIter1 = req.iterationId.endsWith("iter-1");
      if (onIter1) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  assert.ok(result.iterations >= 2);
  assert.equal(result.openObjectionIds.length, 0);
});

test("blocking frontier finding converts to an objection and re-enters the loop", async () => {
  let proposalPath = "";
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the login rate limiter");
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairClean(req, proposalPath);
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
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      plannerTurns += 1;
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
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
  let proposalPath = "";
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "every gate needs a forbidden schema change", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      reviewerTurns += 1;
      if (req.iterationId.endsWith("iter-1")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, proposalPath);
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
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "would need a persisted field the guardrails forbid", requiresGuardrailException: true }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-1")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "escalated");
  assert.deepEqual(result.escalation, { reason: "guardrail_conflict", objectionIds: ["OBJ-1"] });
});

test("guardrail conflict: accept_objection continues planning instead of rejecting", async () => {
  let plannerTurns = 0;
  let stalemateCalls = 0;
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      plannerTurns += 1;
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "no verifiable gate exists", requiresGuardrailException: false }]
        : req.iterationId.endsWith("iter-3")
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:9 adds a gate", requiresGuardrailException: false }]
          : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-1") || req.iterationId.endsWith("iter-2")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "blocking", claim: "no gate can verify this", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => {
      stalemateCalls += 1;
      // First escalation is the guardrail conflict; continue planning.
      if (stalemateCalls === 1) return "accept_objection";
      return "accept_mitigation";
    },
  });
  assert.notEqual(result.phase, "rejected");
  assert.ok(plannerTurns >= 3, `expected at least 3 planner turns after continue, got ${plannerTurns}`);
});

test("clean revised_plan addressal resolves the objection and proceeds to review, persisting one decision row", async () => {
  let proposalPath = "";
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const addressed = req.iterationId.endsWith("iter-2")
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:9 now validates ownership before delete", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
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
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  assert.equal(result.openObjectionIds.length, 0);
  const addressalDecisions = store.readRows("decisions").filter((row) => String(row.decision) === "objection_addressal");
  assert.equal(addressalDecisions.length, 1);
  assert.equal(String(addressalDecisions[0]?.chosen), "revised_plan");
});

test("objection stalemate: accept_objection continues another planner round", async () => {
  let plannerTurns = 0;
  let stalemateCalls = 0;
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      plannerTurns += 1;
      const isIter2 = req.iterationId.endsWith("iter-2");
      const isIter3 = req.iterationId.endsWith("iter-3");
      const addressed = isIter2 || isIter3
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-3")) {
        return pairClean(req, proposalPath);
      }
      return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => {
      stalemateCalls += 1;
      return "accept_objection";
    },
  });
  assert.equal(stalemateCalls, 1);
  assert.notEqual(result.phase, "rejected");
  assert.equal(result.phase, "approved");
  assert.ok(plannerTurns >= 3, `expected at least 3 planner turns, got ${plannerTurns}`);
  assert.deepEqual(result.humanMessages, []);
});

test("stalemate continue with guidance injects humanMessages into next planner revise", async () => {
  const seen: AgentTurnRequest[] = [];
  let stalemateCalls = 0;
  let proposalPath = "";
  const { store, comp } = setup((req) => {
    seen.push(req);
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const isIter3 = req.iterationId.endsWith("iter-3");
      const addressed = isIter2 || isIter3
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-3")) {
        return pairClean(req, proposalPath);
      }
      return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const guidance = "Stop exhaustive prose tables; use machine-ratchet inventory files.";
  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => {
      stalemateCalls += 1;
      return { choice: "accept_objection" as const, guidance };
    },
  });

  assert.equal(stalemateCalls, 1);
  assert.equal(result.phase, "approved");
  assert.deepEqual(result.humanMessages, [{ afterIteration: 2, message: guidance }]);

  const feedback = store.listHumanFeedback("workflow-1");
  assert.equal(feedback.length, 1);
  assert.equal(String(feedback[0]?.decision), "stalemate_continue");
  assert.equal(String(feedback[0]?.comment), guidance);

  const reviseAfterContinue = seen.find(
    (req) => req.turnType === "planner_revise" && req.iterationId.endsWith("iter-3") && req.attempt === "primary",
  );
  assert.ok(reviseAfterContinue, "expected planner_revise on iter-3");
  assert.match(reviseAfterContinue.promptContent, /## Human guidance/);
  assert.match(reviseAfterContinue.promptContent, /machine-ratchet inventory files/);
});

test("objection stalemate: accept_mitigation resolver waives the objection and continues to approved", async () => {
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
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

test("planner revise prompt includes Author proposal context and prior summary", async () => {
  const seen: AgentTurnRequest[] = [];
  let firstProposalPath = "";
  let secondProposalPath = "";
  const { comp } = setup((req) => {
    seen.push(req);
    if (req.turnType.startsWith("planner")) {
      const isRevise = req.turnType === "planner_revise";
      const addressed = isRevise
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:1 fixed", requiresGuardrailException: false }]
        : [];
      const summary = isRevise ? "revised login rate limiter" : "ship the login rate limiter";
      const text = authorEnvelope(req, summary, addressed);
      if (isRevise) {
        secondProposalPath = join(dirname(req.resultPath), "proposal.md");
      } else {
        firstProposalPath = join(dirname(req.resultPath), "proposal.md");
      }
      return text;
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-1")) {
        return pairObjections(req, firstProposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, secondProposalPath || firstProposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, loopInput);
  assert.equal(result.phase, "approved");
  const revise = seen.find((req) => req.turnType === "planner_revise" && req.attempt === "primary");
  assert.ok(revise, "expected a planner_revise delivery");
  assert.match(revise.promptContent, /## Proposal path/);
  assert.match(revise.promptContent, /proposal\.md/);
  assert.match(revise.promptContent, /## Proposal output path/);
  assert.match(revise.promptContent, /## Proposal summary/);
  assert.match(revise.promptContent, /ship the login rate limiter/);
  assert.match(revise.promptContent, /suggestedResolution/i);
});

test("frontier re-invoke: restructured proposal with open objections dispatches mid-loop frontier", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-frontier-re-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });

  let plannerIter = 0;
  let frontierTurns = 0;
  let lastProposalPath = "";
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const headings = plannerIter === 1
        ? "## Overview\n## Implementation"
        : "## Overview\n## Architecture\n## Deployment\n## Rollback";
      const proposalPath = join(runsRoot, `proposal-iter${plannerIter}.md`);
      mkdirSync(dirname(proposalPath), { recursive: true });
      writeFileSync(proposalPath, `${headings}\n\nbody`, "utf8");
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, `${headings}\n\nbody`, "utf8");
      lastProposalPath = turnProposalPath;
      const text = envelope(req, "planner", {
        proposalPath: turnProposalPath,
        summary: `iter ${plannerIter}`,
        objectionsAddressed: plannerIter >= 2
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "proposal.md:1 adds gate", requiresGuardrailException: false }]
          : [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const text = pairObjections(req, lastProposalPath, [{ id: "OBJ-1", severity: "major", claim: "no gate", evidence: ["a.ts:1"] }]);
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
  assert.ok(frontierTurns >= 1, `expected at least 1 frontier turn, got ${frontierTurns}`);
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
  let lastProposalPath = "";
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const headings = plannerIter === 1
        ? "## Overview\n## Implementation"
        : "## Overview\n## Architecture\n## Deployment\n## Rollback\n## Risks";
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, `${headings}\n\nbody`, "utf8");
      lastProposalPath = turnProposalPath;
      const text = envelope(req, "planner", {
        proposalPath: turnProposalPath,
        summary: `iter ${plannerIter}`,
        objectionsAddressed: plannerIter >= 2 ? [{ objectionId: `OBJ-${plannerIter - 1}`, resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }] : [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const objId = `OBJ-${plannerIter}`;
      const text = pairObjections(req, lastProposalPath, [{ id: objId, severity: "major", claim: `issue ${plannerIter}`, evidence: ["a.ts:1"] }]);
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
  let lastProposalPath = "";
  const fileResolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      plannerIter++;
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, "## Overview\nSame content every time.\n## Testing", "utf8");
      lastProposalPath = turnProposalPath;
      const text = envelope(req, "planner", {
        proposalPath: turnProposalPath,
        summary: `iter ${plannerIter}`,
        objectionsAddressed: plannerIter >= 2 ? [{ objectionId: `OBJ-${plannerIter - 1}`, resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }] : [],
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      const objId = `OBJ-${plannerIter}`;
      const text = pairObjections(req, lastProposalPath, [{ id: objId, severity: "major", claim: `issue ${plannerIter}`, evidence: ["a.ts:1"] }]);
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
  // Author@1.8.0+ rejects legacy bare-ID addressals at validation time.
  // The loop must NOT persist them as objection_addressal decisions.
  let proposalPath = "";
  const { store, comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isFirst = req.iterationId.endsWith("iter-1");
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, "# Plan\n\nship the rate limiter\n", "utf8");
      proposalPath = turnProposalPath;
      const payload = isFirst
        ? { proposalPath: turnProposalPath, summary: "ship the rate limiter", objectionsAddressed: [] }
        : { proposalPath: turnProposalPath, summary: "ship the rate limiter", objectionsAddressed: ["OBJ-1"] };
      return envelope(req, "planner", payload);
    }
    if (req.turnType.includes("review")) {
      if (req.iterationId.endsWith("iter-1")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
      }
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, { ...loopInput, maxIterations: 2 });
  assert.notEqual(result.phase, "approved");
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
  let proposalPath = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const text = authorEnvelope(req, "ship the rate limiter");
        proposalPath = join(dirname(req.resultPath), "proposal.md");
        return text;
      }
      if (req.turnType.includes("review")) {
        return pairClean(req, proposalPath);
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
  let proposalPath = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const isIter2 = req.iterationId.endsWith("iter-2");
        const addressed = isIter2
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "conceded" as const, evidence: "no gate can verify this", requiresGuardrailException: false }]
          : [];
        const text = authorEnvelope(req, "ship the rate limiter", addressed);
        proposalPath = join(dirname(req.resultPath), "proposal.md");
        return text;
      }
      if (req.turnType.includes("review")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "blocking", claim: "no gate", evidence: ["a.ts:1"] }]);
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
  let proposalPath = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const isIter2 = req.iterationId.endsWith("iter-2");
        const addressed = isIter2
          ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
          : [];
        const text = authorEnvelope(req, "ship the rate limiter", addressed);
        proposalPath = join(dirname(req.resultPath), "proposal.md");
        return text;
      }
      if (req.turnType.includes("review")) {
        return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
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
  let proposalPath = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const text = authorEnvelope(req, "ship the rate limiter");
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
    }),
    humanSink: sink,
    humanLoopConfig: { dashboardDeepLinkBase: "https://app.example.test/wf" },
    writePrompts: false,
    newId: () => `ic-${(counter += 1)}`,
    nonceFactory: () => "n",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 1,
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

test("churnDetection is deferred (no-op): A-B-A does not stop before the next reviewer turn", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-churn-deferred-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  const proposalA = [
    "# Plan",
    "## Execution",
    "- collect request evidence",
    "- validate the result",
  ].join("\n");
  const proposalB = [
    "# Plan",
    "## Alternative",
    "- migrate the database",
    "- rewrite the transport",
  ].join("\n");
  const proposalTexts = [proposalA, proposalB, proposalA];

  let plannerIteration = 0;
  let lastProposalPath = "";
  const reviewerIterations: string[] = [];
  const resolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      const index = plannerIteration++;
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, proposalTexts[index]!, "utf8");
      lastProposalPath = turnProposalPath;
      const addressed = index === 1
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "src/a.ts:1 updated plan section", requiresGuardrailException: false }]
        : index === 2
          ? [{ objectionId: "OBJ-2", resolutionStrategy: "revised_plan" as const, evidence: "src/a.ts:2 updated plan section", requiresGuardrailException: false }]
          : [];
      const text = envelope(req, "planner", {
        proposalPath: turnProposalPath,
        summary: `proposal ${index + 1}`,
        objectionsAddressed: addressed,
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      reviewerIterations.push(req.iterationId);
      if (req.iterationId.endsWith("iter-3")) {
        const text = pairClean(req, lastProposalPath);
        mkdirSync(dirname(req.resultPath), { recursive: true });
        writeFileSync(req.resultPath, text, "utf8");
        return text;
      }
      const objId = req.iterationId.endsWith("iter-1") ? "OBJ-1" : "OBJ-2";
      const text = pairObjections(req, lastProposalPath, [{ id: objId, severity: "major", claim: "needs more evidence", evidence: ["src/a.ts:1"] }]);
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
    throw new Error(`unexpected turn after review loop: ${req.turnType}`);
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `turn-${++counter}`,
    nonceFactory: () => "nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 3,
    churnDetection: { scoreFloor: 0, churnMargin: 0, disabled: false }, // currently ignored
  });

  assert.equal(result.escalation, undefined);
  assert.deepEqual(reviewerIterations, ["workflow-1-iter-1", "workflow-1-iter-2", "workflow-1-iter-3"]);
  assert.ok(!store.listEvents().some((entry) => entry.kind === "PlanChurnDetected"));
});

test("churnDetection is deferred (no-op): A-A-A does not falsely trigger churn", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "parrot-churn-deferred-aaa-"));
  const store = new PersistenceStore({ path: join(runsRoot, "parrot.db") });
  const proposalA = [
    "# Plan",
    "## Execution",
    "- collect request evidence",
    "- validate the result",
  ].join("\n");
  const proposalTexts = [proposalA, proposalA, proposalA];

  let plannerIteration = 0;
  let lastProposalPath = "";
  const reviewerIterations: string[] = [];
  const resolver = (req: AgentTurnRequest): string => {
    if (req.turnType.startsWith("planner")) {
      const index = plannerIteration++;
      const turnProposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(turnProposalPath), { recursive: true });
      writeFileSync(turnProposalPath, proposalTexts[index]!, "utf8");
      lastProposalPath = turnProposalPath;
      const addressed = index === 1
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "src/a.ts:1 updated plan section", requiresGuardrailException: false }]
        : index === 2
          ? [{ objectionId: "OBJ-2", resolutionStrategy: "revised_plan" as const, evidence: "src/a.ts:2 updated plan section", requiresGuardrailException: false }]
          : [];
      const text = envelope(req, "planner", {
        proposalPath: turnProposalPath,
        summary: `proposal ${index + 1}`,
        objectionsAddressed: addressed,
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }
    if (req.turnType.includes("review")) {
      reviewerIterations.push(req.iterationId);
      if (req.iterationId.endsWith("iter-3")) {
        const text = pairClean(req, lastProposalPath);
        mkdirSync(dirname(req.resultPath), { recursive: true });
        writeFileSync(req.resultPath, text, "utf8");
        return text;
      }
      const objId = req.iterationId.endsWith("iter-1") ? "OBJ-1" : "OBJ-2";
      const text = pairObjections(req, lastProposalPath, [{ id: objId, severity: "major", claim: "needs more evidence", evidence: ["src/a.ts:1"] }]);
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
    throw new Error(`unexpected turn after review loop: ${req.turnType}`);
  };

  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `turn-${++counter}`,
    nonceFactory: () => "nonce",
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 3,
    churnDetection: { scoreFloor: 0, churnMargin: 0, disabled: false }, // currently ignored
  });

  assert.equal(result.escalation, undefined);
  assert.deepEqual(reviewerIterations, ["workflow-1-iter-1", "workflow-1-iter-2", "workflow-1-iter-3"]);
  assert.ok(!store.listEvents().some((entry) => entry.kind === "PlanChurnDetected"));
});

test("notification: blocking terminal frontier at iteration cap does not throw and emits exactly one notification", async () => {
  // maxIterations: 1, clean reviewer, frontier not_ready with blocking
  // findings. The frontier raises objections at the cap. The reducer's
  // cap-binding guard must not reject (ingestion runs after
  // reportFrontier), and exactly one notification is emitted.
  const sink = createMemorySink();
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  let proposalPath = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      if (req.turnType.startsWith("planner")) {
        const text = authorEnvelope(req, "ship the rate limiter");
        proposalPath = join(dirname(req.resultPath), "proposal.md");
        return text;
      }
      if (req.turnType.includes("review")) {
        return pairClean(req, proposalPath);
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

test("decision callback mutating proposal.md before approve refuses approval", async () => {
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the login rate limiter");
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    decide: (ctx) => {
      writeFileSync(ctx.proposalPath!, "# Plan\n\nmutated during decide\n");
      return { decision: "approved" };
    },
  });
  assert.notEqual(result.phase, "approved");
});

test("rejection still works when proposal is stale at human decision", async () => {
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const text = authorEnvelope(req, "ship the login rate limiter");
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairClean(req, proposalPath);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    decide: (ctx) => {
      writeFileSync(ctx.proposalPath!, "# Plan\n\nmutated during decide\n");
      return { decision: "rejected" };
    },
  });
  assert.equal(result.phase, "rejected");
});

test("decide context includes only current iteration Pair summaries", async () => {
  const decideContexts: Array<{ pairReviewSummaries?: Array<{ agentId: string; summary: string }> }> = [];
  let proposalPath = "";
  const iter1Summary = "iter-1 pair summary marker";
  const iter2Summary = "iter-2 pair summary marker";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      const hash = createHash("sha256").update(readFileSync(proposalPath)).digest("hex");
      if (req.iterationId.endsWith("iter-1")) {
        return envelope(req, "reviewer", {
          reviewedProposalPath: proposalPath,
          reviewedProposalHash: hash,
          summary: iter1Summary,
          objections: [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"], suggestedResolution: "Add tests" }],
        });
      }
      return envelope(req, "reviewer", {
        reviewedProposalPath: proposalPath,
        reviewedProposalHash: hash,
        summary: iter2Summary,
        objections: [],
        cleanRationale: "All criteria satisfied.",
      });
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  await runReviewLoop(comp, {
    ...loopInput,
    decide: (ctx) => {
      decideContexts.push(ctx);
      return { decision: "approved" };
    },
  });

  const lastDecide = decideContexts.at(-1);
  assert.ok(lastDecide?.pairReviewSummaries);
  assert.equal(lastDecide?.pairReviewSummaries?.length, 1);
  assert.match(lastDecide?.pairReviewSummaries?.[0]?.summary ?? "", /iter-2 pair summary marker/);
  assert.doesNotMatch(lastDecide?.pairReviewSummaries?.[0]?.summary ?? "", /iter-1 pair summary marker/);
});

test("accept_mitigation refuses when proposal.md mutated during stalemate", async () => {
  let proposalPath = "";
  const { comp } = setup((req) => {
    if (req.turnType.startsWith("planner")) {
      const isIter2 = req.iterationId.endsWith("iter-2");
      const addressed = isIter2
        ? [{ objectionId: "OBJ-1", resolutionStrategy: "revised_plan" as const, evidence: "a.ts:1 fixed", requiresGuardrailException: false }]
        : [];
      const text = authorEnvelope(req, "ship the login rate limiter", addressed);
      proposalPath = join(dirname(req.resultPath), "proposal.md");
      return text;
    }
    if (req.turnType.includes("review")) {
      return pairObjections(req, proposalPath, [{ id: "OBJ-1", severity: "major", claim: "missing tests", evidence: ["a.ts:1"] }]);
    }
    return envelope(req, "frontier", { readiness: "ready", risks: [], questions: [] });
  });

  const result = await runReviewLoop(comp, {
    ...loopInput,
    maxIterations: 5,
    onStalemate: () => {
      writeFileSync(proposalPath, "# Plan\n\nmutated during stalemate\n");
      return "accept_mitigation";
    },
  });
  assert.notEqual(result.phase, "approved");
});

test("empty reviewerAgentIds throws at loop entry", async () => {
  const { comp } = setup(() => "");
  await assert.rejects(
    () => runReviewLoop(comp, { ...loopInput, reviewerAgentIds: [] }),
    /requires at least one Pair agent/,
  );
});
