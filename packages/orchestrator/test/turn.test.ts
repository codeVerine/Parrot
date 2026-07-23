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
  comp.startWorkflow({ workflowId: "workflow-1", workspaceId: "workspace-1", task: "Ship feature" });
  return { store, comp };
}

test("implementation turn validates and completes", async () => {
  const { store, comp } = setup((req) =>
    envelope(req, "implementation", { status: "completed", summary: "shipped auth guard" }),
  );
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(out.status, "completed");
  const turns = store.readRows("turns");
  assert.equal(turns.length, 1);
  assert.equal(String(turns[0].state), "completed");
});

test("first result fails validation, bounded repair completes the turn", async () => {
  const { store, comp } = setup((req) =>
    req.attempt === "primary"
      ? "this is not a toon envelope"
      : envelope(req, "implementation", { status: "completed", summary: "fixed output" }),
  );
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(out.status, "completed");
  const turn = store.readRows("turns")[0];
  assert.equal(String(turn.attempt), "repair");
  assert.equal(String(turn.state), "completed");
});

test("two validation failures fail the turn", async () => {
  const { store, comp } = setup(() => "still not a toon envelope");
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
  });
  assert.equal(out.status, "failed");
  assert.equal(String(store.readRows("turns")[0].state), "failed");
});
