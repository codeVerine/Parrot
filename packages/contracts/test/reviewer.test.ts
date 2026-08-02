import assert from "node:assert/strict";
import test from "node:test";
import {
  ReviewerResultSchema,
  isProposalContentHash,
} from "../src/results/reviewer.js";

test("ReviewerResultSchema parses optional rich Pair fields", () => {
  const parsed = ReviewerResultSchema.safeParse({
    role: "reviewer",
    reviewedProposalPath: "/runs/wf/it/turn/proposal.md",
    reviewedProposalHash: "a".repeat(64),
    summary: "Looks good overall.",
    objections: [
      {
        id: "OBJ-1",
        severity: "major",
        claim: "Missing tests",
        evidence: ["src/a.ts:1"],
        suggestedResolution: "Add integration tests for the callback path.",
      },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.reviewedProposalPath, "/runs/wf/it/turn/proposal.md");
    assert.equal(parsed.data.summary, "Looks good overall.");
    assert.equal(parsed.data.objections[0]?.suggestedResolution, "Add integration tests for the callback path.");
  }
});

test("ReviewerResultSchema accepts legacy results without rich fields", () => {
  const parsed = ReviewerResultSchema.safeParse({
    role: "reviewer",
    objections: [],
    cleanRationale: "All criteria satisfied.",
  });
  assert.equal(parsed.success, true);
});

test("isProposalContentHash accepts 64 lowercase hex and rejects other shapes", () => {
  assert.equal(isProposalContentHash("a".repeat(64)), true);
  assert.equal(isProposalContentHash("A".repeat(64)), false);
  assert.equal(isProposalContentHash("abc"), false);
  assert.equal(isProposalContentHash(""), false);
});
