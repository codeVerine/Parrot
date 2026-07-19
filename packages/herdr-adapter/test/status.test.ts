import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStatus, STATUS_NORMALIZATION } from "../src/status.js";

test("done is a non-authoritative completion hint", () => {
  const status = normalizeStatus({ pane_id: "pane-1", agent_status: "done" });
  assert.equal(status.normalizedStatus, "idle");
  assert.equal(status.completionCandidate, true);
  assert.equal(status.resultCheckRequested, true);
  assert.deepEqual(STATUS_NORMALIZATION.done, { normalized: "idle", completionCandidate: true, resultCheckRequested: true });
});
