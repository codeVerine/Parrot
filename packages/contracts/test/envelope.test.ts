import assert from "node:assert/strict";
import test from "node:test";
import { rejectEnvelopeMismatch, rejectMissingNonce, rejectStaleTurn, ResultEnvelopeSchema } from "../src/index.js";

test("envelope rejection predicates expose the validation boundary", () => {
  const envelope = ResultEnvelopeSchema.parse({ workflowId: "wf", iterationId: "it", turnId: "turn", schemaVersion: "v1", nonce: "nonce", role: "planner", payload: {} });
  assert.equal(rejectEnvelopeMismatch(envelope, { workflowId: "other", iterationId: "it", turnId: "turn" }), "Envelope field workflowId does not match the active turn.");
  assert.equal(rejectMissingNonce({ nonce: "" }), "Result envelope is missing its turn nonce.");
  assert.equal(rejectStaleTurn({ turnId: "old" }, "turn"), "Result belongs to a stale turn.");
});
