import assert from "node:assert/strict";
import test from "node:test";
import { createEngine, eventKinds, seedWorkflow } from "./helpers.js";

test("happy path: planning workflow reaches human approval", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.advancePlanning("workflow-1", "mergeCompleted");
  assert.equal(engine.getState("workflow-1").phase, "objection_gate");
  engine.advancePlanning("workflow-1", "evaluateObjectionGate");
  assert.equal(engine.getState("workflow-1").phase, "iteration_cap_check");
  engine.reportFrontier("workflow-1", false);
  assert.equal(engine.getState("workflow-1").phase, "await_human");
  engine.advancePlanning("workflow-1", "requestHuman");
  const approved = engine.humanDecision({ workflowId: "workflow-1", decision: "approved", comment: "lgtm" });
  assert.equal(approved.phase, "approved");
  assert.ok(eventKinds(store).includes("HumanApproved"));
  assert.ok(eventKinds(store).includes("ConsensusReached"));
});

test("open minor objection blocks consensus and loops until iteration cap", () => {
  const { store, engine } = createEngine({ maxIterations: 2 });
  seedWorkflow(engine, { config: { maxIterations: 2 } });
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-minor",
    severity: "minor",
    iterationId: "iteration-1",
  });
  engine.advancePlanning("workflow-1", "mergeCompleted");
  // count=1 after objection; under cap → loop
  engine.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-2" });
  assert.equal(engine.getState("workflow-1").phase, "planner_turn");
  assert.equal(engine.getState("workflow-1").iterationCount, 2);
  // return to gate; count=2 is not under maxIterations=2 → escalate
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.advancePlanning("workflow-1", "mergeCompleted");
  engine.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-3" });
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  assert.ok(eventKinds(store).includes("IterationCapReached"));
});

test("frontier blocking findings re-enter the objection loop", () => {
  const { engine } = createEngine();
  seedWorkflow(engine);
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.advancePlanning("workflow-1", "mergeCompleted");
  engine.advancePlanning("workflow-1", "evaluateObjectionGate");
  engine.reportFrontier("workflow-1", true);
  assert.equal(engine.getState("workflow-1").phase, "frontier_to_objections");
  assert.equal(engine.getState("workflow-1").frontierBlocking, true);
  engine.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-frontier",
    severity: "blocking",
    iterationId: "iteration-1",
  });
  engine.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-2" });
  assert.equal(engine.getState("workflow-1").phase, "planner_turn");
});

test("approval with open objections requires explicit waiver", () => {
  const { engine } = createEngine();
  seedWorkflow(engine);
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-1",
    severity: "major",
    iterationId: "iteration-1",
  });
  engine.advancePlanning("workflow-1", "mergeCompleted");
  // force to human_decision via escalate-style phase set through frontier without open? 
  // Move to await_human by resolving then frontier, then re-raise? Simpler: resolve path to await_human then raise before decision.
  engine.resolveObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", resolution: "fixed" });
  engine.advancePlanning("workflow-1", "evaluateObjectionGate");
  engine.reportFrontier("workflow-1", false);
  engine.advancePlanning("workflow-1", "requestHuman");
  engine.raiseObjection({
    workflowId: "workflow-1",
    objectionId: "OBJ-late",
    severity: "minor",
    iterationId: "iteration-1",
  });
  assert.throws(() => engine.humanDecision({ workflowId: "workflow-1", decision: "approved" }));
  const waived = engine.humanDecision({
    workflowId: "workflow-1",
    decision: "approved",
    waiveOpenObjections: true,
    comment: "waive late minor",
  });
  assert.equal(waived.phase, "approved");
  assert.equal(waived.objections["OBJ-late"]?.status, "waived");
});

test("budget pause during planning escalates via usage seam", () => {
  const { store, engine } = createEngine({ budgetCap: 1 });
  seedWorkflow(engine, { config: { budgetCap: 1 } });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "u1", inputTokens: 1, outputTokens: 1, cost: 1.01 });
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  assert.ok(eventKinds(store).includes("BudgetCapReached"));
});
