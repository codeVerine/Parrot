import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_KINDS, EventSchema } from "../src/index.js";

test("event catalog contains the approved fourteen events", () => {
  assert.deepEqual(EVENT_KINDS, [
    "TurnCompleted", "TurnFailed", "AgentTimedOut", "ObjectionRaised", "ObjectionResolved",
    "ConsensusReached", "HumanApproved", "HumanRejected", "ImplementationBlocked",
    "BudgetCapReached", "IterationCapReached", "OrphanResultSeen", "UsageRecorded", "VerificationCompleted",
  ]);
  const parsed = EventSchema.parse({
    eventId: "evt-1", occurredAt: "2026-07-19T00:00:00.000Z", workflowId: "wf-1",
    kind: "AgentTimedOut", payload: { deadline: "2026-07-19T00:01:00.000Z" },
  });
  assert.equal(parsed.kind, "AgentTimedOut");
});
