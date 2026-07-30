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

test("objection stalemate escalates ahead of the iteration cap, even with iterations remaining", () => {
  const { store, engine } = createEngine({ maxIterations: 5 });
  seedWorkflow(engine, { config: { maxIterations: 5 } });
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.raiseObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", severity: "major", iterationId: "iteration-1" });
  engine.advancePlanning("workflow-1", "mergeCompleted");
  engine.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-2" });
  assert.equal(engine.getState("workflow-1").phase, "planner_turn");

  engine.resolveObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", resolution: "addressed by planner" });
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.advancePlanning("workflow-1", "objectionsCollected");
  engine.raiseObjection({ workflowId: "workflow-1", objectionId: "OBJ-1", severity: "major", iterationId: "iteration-2" });
  assert.equal(engine.getState("workflow-1").objections["OBJ-1"]?.reraiseCount, 1);
  engine.advancePlanning("workflow-1", "mergeCompleted");

  engine.advancePlanning("workflow-1", "evaluateObjectionGate", { nextIterationId: "iteration-3" });
  const state = engine.getState("workflow-1");
  assert.equal(state.phase, "escalated");
  assert.equal(state.iterationCapReached, false);
  assert.ok(eventKinds(store).includes("ObjectionStalemate"));
  assert.ok(!eventKinds(store).includes("IterationCapReached"));
});

test("budget pause during planning escalates via usage seam", () => {
  const { store, engine } = createEngine({ budgetCap: 1 });
  seedWorkflow(engine, { config: { budgetCap: 1 } });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "u1", inputTokens: 1, outputTokens: 1, cost: 1.01 });
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  assert.ok(eventKinds(store).includes("BudgetCapReached"));
});

test("reportPlanChurn emits PlanChurnDetected, folds to escalated, and replay reproduces it", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.advancePlanning("workflow-1", "plannerCompleted");
  engine.advancePlanning("workflow-1", "reviewersSpawned");
  engine.reportPlanChurn({
    workflowId: "workflow-1",
    fromIterationId: "workflow-1-iter-1",
    toIterationId: "workflow-1-iter-3",
    similarity: 0.65,
    detail: "reverted to iter-1 approach",
    iterationId: "iteration-3",
  });
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  const kinds = eventKinds(store);
  assert.ok(kinds.includes("PlanChurnDetected"));

  const events = store.listEvents({ workflowId: "workflow-1" });
  const churnEvent = events.find((e) => e.event.kind === "PlanChurnDetected");
  assert.ok(churnEvent);
  const payload = churnEvent!.event.payload as { fromIterationId: string; toIterationId: string; similarity: number };
  assert.equal(payload.fromIterationId, "workflow-1-iter-1");
  assert.equal(payload.toIterationId, "workflow-1-iter-3");
  assert.ok(Math.abs(payload.similarity - 0.65) < 0.001);
});

test("reportGuardrailConflict emits GuardrailConflict, folds to escalated", () => {
  const { store, engine } = createEngine();
  seedWorkflow(engine);
  engine.reportGuardrailConflict({
    workflowId: "workflow-1",
    objectionIds: ["OBJ-1", "OBJ-2"],
    detail: "guardrail exception required",
    iterationId: "iteration-2",
  });
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  const kinds = eventKinds(store);
  assert.ok(kinds.includes("GuardrailConflict"));
});
