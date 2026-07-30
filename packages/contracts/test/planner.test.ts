import assert from "node:assert/strict";
import test from "node:test";
import { PlannerResultSchema } from "../src/index.js";

function base(objectionsAddressed: unknown) {
  return {
    role: "planner" as const,
    proposalPath: "plan.md",
    summary: "ship the feature",
    objectionsAddressed,
  };
}

test("PlannerResultSchema accepts a structured addressal", () => {
  const parsed = PlannerResultSchema.parse(
    base([
      {
        objectionId: "OBJ-1",
        resolutionStrategy: "revised_plan",
        evidence: "proposal.md:12 now retries with backoff",
        requiresGuardrailException: false,
      },
    ]),
  );
  assert.deepEqual(parsed.objectionsAddressed, [
    {
      objectionId: "OBJ-1",
      resolutionStrategy: "revised_plan",
      evidence: "proposal.md:12 now retries with backoff",
      requiresGuardrailException: false,
    },
  ]);
});

test("PlannerResultSchema normalizes a bare legacy ID string to revised_plan with empty evidence", () => {
  const parsed = PlannerResultSchema.parse(base(["OBJ-1", "OBJ-2"]));
  assert.deepEqual(parsed.objectionsAddressed, [
    { objectionId: "OBJ-1", resolutionStrategy: "revised_plan", evidence: "", requiresGuardrailException: false },
    { objectionId: "OBJ-2", resolutionStrategy: "revised_plan", evidence: "", requiresGuardrailException: false },
  ]);
});

test("PlannerResultSchema marks legacy bare-ID entries with a __legacy marker", () => {
  // The marker is a non-enumerable field so the JSON round-trip stays
  // clean (the structured form has no such field) but in-memory callers
  // can distinguish a rehydrated legacy entry from a live structured
  // one. The orchestrator's review loop uses the marker to skip
  // persisting legacy addressals as real decisions.
  const parsed = PlannerResultSchema.parse(
    base([
      "OBJ-legacy",
      { objectionId: "OBJ-live", resolutionStrategy: "revised_plan", evidence: "a.ts:1 fixed", requiresGuardrailException: false },
    ]),
  );
  assert.equal(parsed.objectionsAddressed[0]?.objectionId, "OBJ-legacy");
  assert.equal((parsed.objectionsAddressed[0] as { __legacy?: boolean }).__legacy, true);
  assert.equal((parsed.objectionsAddressed[1] as { __legacy?: boolean }).__legacy, undefined);
  // The marker must not appear in JSON.stringify output (non-enumerable).
  assert.equal(
    JSON.stringify(parsed.objectionsAddressed[0]).includes("__legacy"),
    false,
    "legacy marker must be non-enumerable to keep the JSON round-trip clean",
  );
});

test("PlannerResultSchema accepts a mix of structured and legacy entries in one array", () => {
  const parsed = PlannerResultSchema.parse(
    base([
      "OBJ-1",
      { objectionId: "OBJ-2", resolutionStrategy: "conceded", evidence: "no gate can verify this without a schema change", requiresGuardrailException: true },
    ]),
  );
  assert.equal(parsed.objectionsAddressed.length, 2);
  assert.equal(parsed.objectionsAddressed[0]?.objectionId, "OBJ-1");
  assert.equal(parsed.objectionsAddressed[1]?.resolutionStrategy, "conceded");
});

test("PlannerResultSchema rejects an addressal with an unknown resolutionStrategy", () => {
  assert.throws(() =>
    PlannerResultSchema.parse(
      base([{ objectionId: "OBJ-1", resolutionStrategy: "ignored", evidence: "x", requiresGuardrailException: false }]),
    ),
  );
});

test("PlannerResultSchema rejects structured addressals with missing required fields", () => {
  assert.throws(() => PlannerResultSchema.parse(base([
    { objectionId: "OBJ-1", resolutionStrategy: "revised_plan", requiresGuardrailException: false },
  ])));
  assert.throws(() => PlannerResultSchema.parse(base([
    { objectionId: "OBJ-1", resolutionStrategy: "revised_plan", evidence: "quote" },
  ])));
  assert.throws(() => PlannerResultSchema.parse(base([
    { objectionId: "", resolutionStrategy: "revised_plan", evidence: "quote", requiresGuardrailException: false },
  ])));
});
