import assert from "node:assert/strict";
import test from "node:test";
import { foldEvents, foldReducer, initialFoldedState } from "../src/index.js";
import { createEngine, eventKinds, seedWorkflow } from "./helpers.js";

test("UsageRecorded accumulates spend; duplicate messageId is a no-op", () => {
  const { engine } = createEngine({ budgetCap: 10 });
  seedWorkflow(engine, { config: { budgetCap: 10 } });
  const first = engine.submitUsage({
    workflowId: "workflow-1",
    messageId: "msg-1",
    inputTokens: 10,
    outputTokens: 5,
    cost: 1.5,
  });
  assert.equal(first.recorded, true);
  assert.equal(engine.getState("workflow-1").spendTotal, 1.5);
  const dup = engine.submitUsage({
    workflowId: "workflow-1",
    messageId: "msg-1",
    inputTokens: 99,
    outputTokens: 99,
    cost: 9,
  });
  assert.equal(dup.recorded, false);
  assert.equal(engine.getState("workflow-1").spendTotal, 1.5);
});

test("crossing budget cap emits BudgetCapReached once and escalates", () => {
  const { store, engine } = createEngine({ budgetCap: 2 });
  seedWorkflow(engine, { config: { budgetCap: 2 } });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "a", inputTokens: 1, outputTokens: 1, cost: 1.5 });
  assert.equal(engine.getState("workflow-1").phase !== "escalated", true);
  const crossed = engine.submitUsage({ workflowId: "workflow-1", messageId: "b", inputTokens: 1, outputTokens: 1, cost: 1 });
  assert.equal(crossed.budgetCapReached, true);
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  assert.equal(eventKinds(store).filter((kind) => kind === "BudgetCapReached").length, 1);
  engine.submitUsage({ workflowId: "workflow-1", messageId: "c", inputTokens: 1, outputTokens: 1, cost: 1 });
  assert.equal(eventKinds(store).filter((kind) => kind === "BudgetCapReached").length, 1);
});

test("zero-usage workflow passes underBudgetCap trivially", () => {
  const { engine } = createEngine({ budgetCap: 1 });
  seedWorkflow(engine, { config: { budgetCap: 1 } });
  assert.equal(engine.getState("workflow-1").spendTotal, 0);
  assert.equal(engine.getState("workflow-1").budgetCapReached, false);
});

test("replay of usage events yields identical spendTotal", () => {
  const { store, engine } = createEngine({ budgetCap: null });
  seedWorkflow(engine);
  engine.submitUsage({ workflowId: "workflow-1", messageId: "m1", inputTokens: 1, outputTokens: 1, cost: 0.25 });
  engine.submitUsage({ workflowId: "workflow-1", messageId: "m2", inputTokens: 1, outputTokens: 1, cost: 0.5 });
  const live = engine.getState("workflow-1").spendTotal;
  const events = store.listEvents({ workflowId: "workflow-1" }).map((entry) => entry.event);
  const foldedOnce = foldEvents(events, initialFoldedState("workflow-1"));
  const foldedTwice = events.reduce((state, event) => foldReducer(state, event), initialFoldedState("workflow-1"));
  assert.equal(foldedOnce.spendTotal, live);
  assert.deepEqual(foldedOnce, foldedTwice);
});
