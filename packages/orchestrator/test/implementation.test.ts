import assert from "node:assert/strict";
import test from "node:test";
import { encodeToon } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import { createComposition, createFixtureRunner, type AgentTurnRequest } from "../src/index.js";

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

test("blocked result emits ImplementationBlocked, escalates, and notifies", async () => {
  const { comp, memory } = setup((req) =>
    envelope(req, "implementation", { status: "blocked", summary: "missing prod credentials" }),
  );
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(out.status, "blocked");
  assert.equal(comp.engine.getState("workflow-1").phase, "escalated");
  await comp.flush();
  assert.ok(memory.requests.some((r) => r.kind === "escalation"));
});

test("deviation request routes back without self-authorizing", async () => {
  const { comp } = setup((req) =>
    envelope(req, "implementation", {
      status: "completed",
      summary: "core done",
      deviationRequest: "approved plan omits rate limiting; request scope change",
    }),
  );
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(out.status, "deviation");
  if (out.status === "deviation") {
    assert.match(out.deviationRequest, /scope change/);
  }
  // Not approved: the workflow did not advance to approved on the agent's say-so.
  assert.notEqual(comp.engine.getState("workflow-1").phase, "approved");
});

test("completed implementation is verified through resolution_verification", async () => {
  const { comp } = setup((req) =>
    req.turnType === "implementation"
      ? envelope(req, "implementation", { status: "completed", summary: "done" })
      : envelope(req, "resolution", { verified: ["turn-1"], unresolved: [] }),
  );
  const impl = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(impl.status, "completed");
  const verify = await comp.runVerification({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-verify",
    targetTurnId: impl.turnId,
    summary: impl.status === "completed" ? impl.summary : "",
    evidence: ["src/auth.ts:42"],
  });
  assert.equal(verify.status, "valid");
});
