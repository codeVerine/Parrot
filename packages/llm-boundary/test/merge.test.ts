import assert from "node:assert/strict";
import test from "node:test";
import {
  validateMergeStructure,
  type MergeResult,
} from "@platform/contracts";
import {
  allEvidencePreserved,
  allObjectionIdsPreserved,
  postProcessMerge,
} from "../src/index.js";
import { createBoundary, envelopeBytes, sampleObjections } from "./helpers.js";

test("merge structure rejects invented IDs and overlaps; size owned by Zod", () => {
  const invented: MergeResult = {
    role: "merge",
    clusters: [
      {
        clusterId: "C1",
        objectionIds: ["OBJ-1", "OBJ-999"],
        representativeClaim: "x",
      },
    ],
  };
  assert.ok(validateMergeStructure(invented, ["OBJ-1", "OBJ-2"]).some((i) => i.code === "invented_id"));

  const overlap: MergeResult = {
    role: "merge",
    clusters: [
      { clusterId: "C1", objectionIds: ["OBJ-1", "OBJ-2"], representativeClaim: "a" },
      { clusterId: "C2", objectionIds: ["OBJ-2", "OBJ-3"], representativeClaim: "b" },
    ],
  };
  assert.ok(
    validateMergeStructure(overlap, ["OBJ-1", "OBJ-2", "OBJ-3"]).some(
      (i) => i.code === "duplicate_across_clusters",
    ),
  );

  assert.deepEqual(validateMergeStructure({ role: "merge", clusters: [] }, ["OBJ-1"]), []);
});

test("extractor accepts empty merge clusters and rejects invented members", () => {
  const { extractor } = createBoundary();
  const ok = envelopeBytes({
    role: "merge",
    turnId: "turn-m",
    payload: { role: "merge", clusters: [] },
  });
  const okVerdict = extractor.validate({
    bytes: ok,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-m",
      nonce: "fixed-nonce-001",
      turnType: "objection_merge",
      attempt: "primary",
    },
    inputObjectionIds: sampleObjections.map((o) => o.id),
  });
  assert.equal(okVerdict.outcome, "valid");

  const bad = envelopeBytes({
    role: "merge",
    turnId: "turn-m",
    payload: {
      role: "merge",
      clusters: [
        {
          clusterId: "C1",
          objectionIds: ["OBJ-1", "OBJ-nope"],
          representativeClaim: "same issue",
        },
      ],
    },
  });
  const badVerdict = extractor.validate({
    bytes: bad,
    turn: {
      workflowId: "wf-1",
      iterationId: "it-1",
      turnId: "turn-m",
      nonce: "fixed-nonce-001",
      turnType: "objection_merge",
      attempt: "primary",
    },
    inputObjectionIds: sampleObjections.map((o) => o.id),
  });
  assert.equal(badVerdict.outcome, "needsRepair");
});

test("post-process ignores LLM severity and uses member max", () => {
  const merge: MergeResult = {
    role: "merge",
    clusters: [
      {
        clusterId: "C1",
        objectionIds: ["OBJ-1", "OBJ-2"],
        representativeClaim: "Auth missing on delete",
        severity: "minor",
      },
    ],
  };
  const result = postProcessMerge(merge, sampleObjections);
  assert.equal(result.clusters[0].severity, "blocking");
  assert.equal(result.clusters[0].representativeClaim.kind, "untrusted");
  assert.equal(result.standalone.map((o) => o.id).join(","), "OBJ-3");
  assert.equal(allObjectionIdsPreserved(sampleObjections, result), true);
  assert.equal(allEvidencePreserved(sampleObjections, result), true);
});

test("merge failure degradation leaves all objections standalone", () => {
  const { objections } = createBoundary();
  const degraded = objections.degradeUnmerged(sampleObjections);
  assert.equal(degraded.clusters.length, 0);
  assert.equal(degraded.standalone.length, sampleObjections.length);
});
