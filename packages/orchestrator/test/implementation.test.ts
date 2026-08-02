import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { encodeToon } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import {
  APPROVED_PROPOSAL_ARTIFACT_KIND,
  createComposition,
  createFixtureRunner,
  reuseImplementation,
  verificationCompleted,
  type AgentTurnRequest,
} from "../src/index.js";
import { approvedProposal } from "./author-pair-fixtures.js";

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
  const memory = createMemorySink();
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: memory,
    writePrompts: false,
    now: () => "2026-07-23T10:00:00.000Z",
    newId: () => `turn-${(counter += 1)}`,
    nonceFactory: () => "nonce-1",
  });
  comp.startWorkflow({ workflowId: "workflow-1", workspaceId: "workspace-1", task: "Ship feature" });
  return { store, comp, memory };
}

function setupFileBackedImplementation() {
  const runsRoot = join(tmpdir(), `parrot-direct-resume-${randomUUID()}`);
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      const text = envelope(req, "implementation", {
        status: "completed",
        summary: "shipped",
      });
      mkdirSync(dirname(req.resultPath), { recursive: true });
      writeFileSync(req.resultPath, text, "utf8");
      return text;
    }),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => `turn-${++counter}`,
    nonceFactory: () => "nonce-1",
  });
  comp.startWorkflow({
    workflowId: "workflow-1",
    workspaceId: "workspace-1",
    task: "Ship feature",
  });
  return { comp, runsRoot, store };
}

function resumeWithoutDispatch(store: PersistenceStore, runsRoot: string) {
  const comp = createComposition({
    store,
    runner: createFixtureRunner(() => {
      throw new Error("completed implementation must not be dispatched again");
    }),
    humanSink: createMemorySink(),
    runsRoot,
    writePrompts: false,
    newId: () => "unexpected-turn",
    nonceFactory: () => "unexpected-nonce",
  });
  comp.resumeWorkflow("workflow-1");
  return comp;
}

function seedWorkflow(store: PersistenceStore, workflowId = "workflow-1") {
  store.saveWorkflow({
    workflowId,
    workspaceId: "workspace-1",
    status: "running",
    task: "Ship feature",
    state: {},
    config: {},
  });
}

function seedIteration(store: PersistenceStore, iterationId: string, workflowId = "workflow-1") {
  const match = iterationId.match(/-(\d+)$/);
  const iterationNumber = match ? parseInt(match[1]!, 10) : 1;
  store.saveIteration({
    iterationId,
    workflowId,
    iterationNumber,
    status: "running",
  });
}

test("blocked result emits ImplementationBlocked, escalates, and notifies", async () => {
  const { comp, memory } = setup((req) =>
    envelope(req, "implementation", { status: "blocked", summary: "missing prod credentials" }),
  );
  const proposal = approvedProposal();
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "blocked");
  assert.equal(comp.engine.getState("workflow-1").phase, "escalated");
  await comp.flush();
  assert.ok(memory.requests.some((r) => r.kind === "escalation"));
});

test("deviation request routes back without self-authorizing", async () => {
  const { comp, memory } = setup((req) =>
    envelope(req, "implementation", {
      status: "completed",
      summary: "core done",
      deviationRequest: "approved plan omits rate limiting; request scope change",
    }),
  );
  const proposal = approvedProposal();
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "deviation");
  if (out.status === "deviation") {
    assert.match(out.deviationRequest, /scope change/);
  }
  assert.equal(comp.engine.getState("workflow-1").phase, "escalated");
  await comp.flush();
  assert.ok(memory.requests.some((request) => request.kind === "escalation"));
});

test("completed implementation is verified through resolution_verification", async () => {
  const { comp, store } = setup((req) =>
    req.turnType === "implementation"
      ? envelope(req, "implementation", { status: "completed", summary: "done" })
      : envelope(req, "resolution", { verified: ["turn-1"], unresolved: [] }),
  );
  store.saveIteration({
    iterationId: "review-iteration",
    workflowId: "workflow-1",
    iterationNumber: 1,
    status: "complete",
  });
  const proposal = approvedProposal();
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "post-review",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(impl.status, "completed");
  const verify = await comp.runVerification({
    workflowId: "workflow-1",
    iterationId: "post-review",
    agentId: "agent-verify",
    targetTurnId: impl.turnId,
    summary: impl.status === "completed" ? impl.summary : "",
    evidence: ["src/auth.ts:42"],
  });
  assert.equal(verify.status, "valid");
  const postReview = store.readRows("iterations").find(
    (row) => row.iteration_id === "post-review",
  );
  assert.equal(postReview?.iteration_number, 2);
});

test("missing proposalPath or proposalHash fails preflight without dispatch", async () => {
  const { comp } = setup(() => {
    throw new Error("implementation must not be dispatched");
  });
  const missingPath = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: "",
    proposalHash: "abc",
  });
  assert.deepEqual(missingPath, {
    status: "failed",
    turnId: "preflight",
    reason: "Implementation requires proposalPath and proposalHash of the approved Author proposal",
  });

  const missingHash = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: "/tmp/proposal.md",
    proposalHash: "",
  });
  assert.equal(missingHash.status, "failed");
  assert.equal(missingHash.turnId, "preflight");
});

test("mutated proposal before dispatch fails preflight", async () => {
  const { comp } = setup(() => {
    throw new Error("implementation must not be dispatched");
  });
  const proposal = approvedProposal("original plan");
  writeFileSync(proposal.proposalPath, "# Plan\n\nmutated after approval\n");
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "failed");
  assert.equal(out.turnId, "preflight");
  if (out.status === "failed") {
    assert.match(out.reason, /hash mismatch/i);
  }
});

test("completed implementation persists approved_proposal and reuseImplementation verifies binding", async () => {
  const { comp, store } = setup((req) => {
    const text = envelope(req, "implementation", { status: "completed", summary: "shipped" });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  });
  const proposal = approvedProposal("binding test plan");
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(impl.status, "completed");
  if (impl.status !== "completed") return;

  const artifacts = store.listArtifacts("workflow-1");
  const binding = artifacts.find((row) => String(row.kind) === APPROVED_PROPOSAL_ARTIFACT_KIND);
  assert.ok(binding, "expected approved_proposal artifact");
  assert.equal(String(binding?.path), proposal.proposalPath);
  assert.equal(String(binding?.content_hash), proposal.proposalHash);

  const reused = reuseImplementation(store, "workflow-1", "iteration-1", {
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.deepEqual(reused, { turnId: impl.turnId, summary: "shipped" });

  assert.throws(
    () => reuseImplementation(store, "workflow-1", "iteration-1", {
      proposalPath: proposal.proposalPath,
      proposalHash: "0".repeat(64),
    }),
    /Durable state inconsistency|Cannot reuse implementation|hash mismatch/i,
  );
});

test("approved_proposal binding exists before implementation turn completes", async () => {
  let bindingSeenBeforeComplete = false;
  const { comp, store } = setup((req) => {
    if (req.turnType === "implementation") {
      const artifacts = store.listArtifacts("workflow-1");
      const binding = artifacts.find((row) => String(row.kind) === APPROVED_PROPOSAL_ARTIFACT_KIND);
      assert.ok(binding, "expected approved_proposal artifact before agent returns");
      const turn = store.getTurn(req.turnId);
      assert.notEqual(String(turn?.state), "completed");
      bindingSeenBeforeComplete = true;
    }
    const text = envelope(req, "implementation", { status: "completed", summary: "shipped" });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  });
  const proposal = approvedProposal("binding before completion");
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "implementation",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(impl.status, "completed");
  assert.ok(bindingSeenBeforeComplete);
});

test("reuseImplementation throws when completed implementation result.toon is tampered", async () => {
  const { comp, store } = setup((req) => {
    const text = envelope(req, "implementation", { status: "completed", summary: "shipped" });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  });
  const proposal = approvedProposal("tamper test plan");
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "implementation",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(impl.status, "completed");
  if (impl.status !== "completed") return;

  const turn = store.getTurn(impl.turnId);
  assert.ok(turn?.result_path);
  writeFileSync(String(turn.result_path), "tampered result bytes\n");

  assert.throws(
    () => reuseImplementation(store, "workflow-1", "iteration-1", {
      proposalPath: proposal.proposalPath,
      proposalHash: proposal.proposalHash,
    }),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});

test("direct composition resume rejects a schema-valid tampered implementation result", async () => {
  const { comp, runsRoot, store } = setupFileBackedImplementation();
  const proposal = approvedProposal("direct resume tamper test");
  const input = {
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "implementation",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  };
  const implementation = await comp.runImplementation(input);
  assert.equal(implementation.status, "completed");

  const turn = store.getTurn(implementation.turnId);
  assert.ok(turn);
  writeFileSync(
    String(turn?.result_path),
    encodeToon({
      workflowId: "workflow-1",
      iterationId: "iteration-1",
      turnId: implementation.turnId,
      schemaVersion: "v1",
      nonce: String(turn?.nonce),
      role: "implementation",
      payload: {
        role: "implementation",
        status: "completed",
        summary: "tampered but schema-valid",
      },
    }),
    "utf8",
  );

  const resumed = resumeWithoutDispatch(store, runsRoot);
  await assert.rejects(
    () => resumed.runImplementation(input),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});

test("direct composition resume requires the original approved proposal binding", async () => {
  const { comp, runsRoot, store } = setupFileBackedImplementation();
  const originalProposal = approvedProposal("original approved proposal");
  const implementation = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "implementation",
    task: "Implement the approved plan",
    proposalPath: originalProposal.proposalPath,
    proposalHash: originalProposal.proposalHash,
  });
  assert.equal(implementation.status, "completed");

  const differentProposal = approvedProposal("different approved proposal");
  const resumed = resumeWithoutDispatch(store, runsRoot);
  await assert.rejects(
    () => resumed.runImplementation({
      workflowId: "workflow-1",
      iterationId: "iteration-1",
      agentId: "implementation",
      task: "Implement the approved plan",
      proposalPath: differentProposal.proposalPath,
      proposalHash: differentProposal.proposalHash,
    }),
    /bound to .* expected /i,
  );
});

test("verificationCompleted throws when completed verification result.toon is tampered", async () => {
  const { comp, store } = setup((req) => {
    const text = req.turnType === "implementation"
      ? envelope(req, "implementation", { status: "completed", summary: "done" })
      : envelope(req, "resolution", { verified: ["turn-1"], unresolved: [] });
    mkdirSync(dirname(req.resultPath), { recursive: true });
    writeFileSync(req.resultPath, text, "utf8");
    return text;
  });
  const proposal = approvedProposal();
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "post-review",
    agentId: "implementation",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(impl.status, "completed");
  if (impl.status !== "completed") return;

  const verify = await comp.runVerification({
    workflowId: "workflow-1",
    iterationId: "post-review",
    agentId: "verifier",
    targetTurnId: impl.turnId,
    summary: impl.summary,
    evidence: [],
  });
  assert.equal(verify.status, "valid");

  const turn = store.getTurn(verify.turnId);
  assert.ok(turn?.result_path);
  writeFileSync(String(turn.result_path), "tampered verification bytes\n");

  assert.throws(
    () => verificationCompleted(store, "workflow-1", "post-review", impl.turnId),
    /result bytes do not match TurnCompleted\.resultHash/i,
  );
});

test("reuseImplementation throws when completed implementation lacks approved_proposal binding", async () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedWorkflow(store, "workflow-1");
  seedIteration(store, "iteration-1", "workflow-1");

  const resultPath = join(tmpdir(), `parrot-unbound-${randomUUID()}`, "result.toon");
  mkdirSync(dirname(resultPath), { recursive: true });
  const text = encodeToon({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "impl-unbound",
    schemaVersion: "v1",
    nonce: "nonce-impl",
    role: "implementation",
    payload: { role: "implementation", status: "completed", summary: "shipped without binding" },
  });
  writeFileSync(resultPath, text, "utf8");

  store.saveTurn({
    turnId: "impl-unbound",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "implementation",
    state: "completed",
    attempt: "primary",
    deadlineAt: null,
    promptPath: "/prompt.md",
    promptHash: "h",
    nonce: "nonce-impl",
    promptVersion: "implementation@1.0.0",
    resultPath,
  });
  store.appendEvent({
    eventId: randomUUID(),
    occurredAt: "2026-07-23T10:00:00.000Z",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "impl-unbound",
    agentId: "implementation",
    kind: "TurnCompleted",
    payload: { resultHash: createHash("sha256").update(text).digest("hex") },
  });

  const proposal = approvedProposal("unbound reuse test");
  assert.throws(
    () => reuseImplementation(store, "workflow-1", "iteration-1", {
      proposalPath: proposal.proposalPath,
      proposalHash: proposal.proposalHash,
    }),
    /no approved_proposal binding/i,
  );
});
