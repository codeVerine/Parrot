import assert from "node:assert/strict";
import test from "node:test";
import { PersistenceStore } from "@platform/persistence";
import {
  humanMessagesFromFeedback,
  iterationNumberFromId,
  normalizeStalemateResolution,
  stalemateFeedbackDecision,
} from "../src/human-guidance.js";

test("normalizeStalemateResolution accepts bare choice or object", () => {
  assert.deepEqual(normalizeStalemateResolution("abort"), { choice: "abort" });
  assert.deepEqual(normalizeStalemateResolution({ choice: "accept_objection", guidance: "fix 3f" }), {
    choice: "accept_objection",
    guidance: "fix 3f",
  });
  assert.deepEqual(normalizeStalemateResolution({ choice: "accept_mitigation" }), {
    choice: "accept_mitigation",
  });
});

test("iterationNumberFromId parses iter suffixes", () => {
  assert.equal(iterationNumberFromId("wf-1-iter-5"), 5);
  assert.equal(iterationNumberFromId("iter-2"), 2);
  assert.equal(iterationNumberFromId(undefined), 0);
  assert.equal(iterationNumberFromId("nope"), 0);
});

test("stalemateFeedbackDecision maps choices", () => {
  assert.equal(stalemateFeedbackDecision("accept_mitigation"), "stalemate_accept_mitigation");
  assert.equal(stalemateFeedbackDecision("accept_objection"), "stalemate_continue");
  assert.equal(stalemateFeedbackDecision("abort"), "stalemate_abort");
});

test("humanMessagesFromFeedback skips empty comments and orders by created_at", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.saveWorkflow({ workflowId: "wf-1", workspaceId: "w1", status: "running", task: "t" });
  store.saveHumanFeedback({
    feedbackId: "f1",
    workflowId: "wf-1",
    iterationId: "wf-1-iter-2",
    decision: "stalemate_continue",
    comment: "first",
    createdAt: "2026-08-02T10:00:00.000Z",
  });
  store.saveHumanFeedback({
    feedbackId: "f2",
    workflowId: "wf-1",
    decision: "approved",
    comment: "   ",
    createdAt: "2026-08-02T10:01:00.000Z",
  });
  store.saveHumanFeedback({
    feedbackId: "f3",
    workflowId: "wf-1",
    iterationId: "wf-1-iter-4",
    decision: "approved",
    comment: "second",
    createdAt: "2026-08-02T10:02:00.000Z",
  });

  assert.deepEqual(humanMessagesFromFeedback(store, "wf-1"), [
    { afterIteration: 2, message: "first" },
    { afterIteration: 4, message: "second" },
  ]);
  store.close();
});
