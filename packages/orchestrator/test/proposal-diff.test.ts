import assert from "node:assert/strict";
import test from "node:test";
import {
  headingChangeRatio,
  isMajorRestructuring,
  proposalSimilarity,
  sectionHeadings,
  sectionSteps,
  weightedProposalSimilarity,
} from "../src/proposal-diff.js";

test("proposalSimilarity: identical documents score 1", () => {
  assert.equal(proposalSimilarity("the quick brown fox", "the quick brown fox"), 1);
});

test("proposalSimilarity: disjoint documents score near 0", () => {
  const sim = proposalSimilarity("alpha beta gamma", "delta epsilon zeta");
  assert.ok(sim === 0);
});

test("proposalSimilarity: both empty scores 1", () => {
  assert.equal(proposalSimilarity("", ""), 1);
});

test("proposalSimilarity: partial overlap", () => {
  const sim = proposalSimilarity("the quick brown fox", "the lazy brown dog");
  assert.ok(sim > 0.2 && sim < 0.7);
});

test("sectionSteps extracts only bullet and numbered execution lines", () => {
  const text = [
    "## Plan",
    "context prose",
    "- collect evidence",
    "  1. validate the result",
    "* write the report",
    "+ notify the human",
    "not a step",
  ].join("\n");
  assert.deepEqual(sectionSteps(text), [
    "collect evidence",
    "validate the result",
    "write the report",
    "notify the human",
  ]);
});

test("weighted proposal similarity exposes structural components and weights steps most", () => {
  const a = [
    "## Plan",
    "## Verification",
    "- collect evidence",
    "- run the verifier",
    "The implementation uses a durable result file.",
  ].join("\n");
  const b = [
    "## Plan",
    "## Verification",
    "- collect evidence",
    "- run the verifier",
    "The implementation uses a different persistence detail.",
  ].join("\n");
  const score = weightedProposalSimilarity(a, b);

  assert.equal(score.simHeadings, 1);
  assert.equal(score.simSteps, 1);
  assert.ok(score.simAll > 0 && score.simAll < 1);
  assert.equal(score.score, 0.5 * score.simSteps + 0.3 * score.simHeadings + 0.2 * score.simAll);

  const changedSteps = weightedProposalSimilarity(a, b.replace("run the verifier", "rewrite the transport"));
  assert.ok(changedSteps.score < score.score);
});

test("sectionHeadings extracts and normalizes headings", () => {
  const text = [
    "## 1. Overview",
    "some text",
    "### 2.3 Implementation Details",
    "## 4. Testing",
  ].join("\n");
  const headings = sectionHeadings(text);
  assert.deepEqual(headings, ["overview", "implementation details", "testing"]);
});

test("headingChangeRatio: identical headings score 0", () => {
  const ratio = headingChangeRatio(["a", "b"], ["a", "b"]);
  assert.equal(ratio, 0);
});

test("headingChangeRatio: all different returns 1", () => {
  const ratio = headingChangeRatio(["a", "b"], ["c", "d"]);
  assert.equal(ratio, 1);
});

test("headingChangeRatio: partial change", () => {
  const ratio = headingChangeRatio(["a", "b", "c"], ["a", "d", "e"]);
  assert.equal(ratio, 4 / 6);
});

test("isMajorRestructuring: heading change ratio >= threshold fires", () => {
  const prev = "## a\n## b\n## c";
  const next = "## a\n## d\n## e";
  assert.equal(isMajorRestructuring(prev, next, { headingChangeRatio: 0.4 }), true);
});

test("isMajorRestructuring: heading change below threshold with high sim returns false", () => {
  const prev = "## a\n## b\nSame content here.";
  const next = "## a\n## b\nSame content here.";
  assert.equal(isMajorRestructuring(prev, next, { headingChangeRatio: 0.4, similarityFloor: 0.3 }), false);
});

test("isMajorRestructuring: low document similarity fires even with same headings", () => {
  const prev = "## overview\nalpha beta gamma delta epsilon";
  const next = "## overview\nzeta eta theta iota kappa";
  assert.equal(isMajorRestructuring(prev, next, { headingChangeRatio: 0.4, similarityFloor: 0.2 }), true);
});

test("isMajorRestructuring: no headings on one side, only sim check applies", () => {
  const prev = "alpha beta gamma";
  const next = "delta epsilon zeta";
  assert.equal(isMajorRestructuring(prev, next, { headingChangeRatio: 0.4, similarityFloor: 0.3 }), true);
  assert.equal(isMajorRestructuring(prev, prev, { headingChangeRatio: 0.4, similarityFloor: 0.3 }), false);
});

test("corpus calibration: cited mid-loop firings match defaults", () => {
  // The motivating real run produced these metric values for three consecutive
  // pairs (N-1 -> N) as measured by the proposal-diff module on the actual
  // proposal text:
  //
  //   Pair    sim      hcr       default outcome
  //   ────    ─────    ────────  ──────────────
  //   1 → 2   0.489    0.533     skip (sim above 0.4 floor; hcr below 0.7)
  //   2 → 3   0.562    0.765     fire (hcr clears 0.7 threshold)
  //   3 → 4   0.528    0.677     skip (sim above floor; hcr below threshold)
  //
  // Each pair is reconstructed from the cited counts (token-set Jaccard
  // shares `sharedBody` body tokens and `sharedHeadings` heading tokens
  // across both sides, with the remaining `aOnly` / `bOnly` tokens split
  // between prev and next). The assertions on `sim` and `hcr` are made
  // WITHIN a 0.005 tolerance: token-set Jaccard is a discrete metric and
  // the headings contribute to the token set, so exact reproduction
  // requires matching the cited value to three decimal places.
  const TOLERANCE = 0.005;
  const DEFAULTS = { headingChangeRatio: 0.7, similarityFloor: 0.4 };

  const buildCitedPair = (params: {
    sharedBody: number;
    aOnlyBody: number;
    bOnlyBody: number;
    sharedHeadings: number;
    aOnlyHeadings: number;
    bOnlyHeadings: number;
  }): { prev: string; next: string } => {
    const prevBody: string[] = [];
    for (let i = 0; i < params.sharedBody; i++) prevBody.push(`s${i}`);
    for (let i = 0; i < params.aOnlyBody; i++) prevBody.push(`a${i}`);
    const nextBody: string[] = [];
    for (let i = 0; i < params.sharedBody; i++) nextBody.push(`s${i}`);
    for (let i = 0; i < params.bOnlyBody; i++) nextBody.push(`b${i}`);

    const sharedHeadings: string[] = [];
    for (let i = 0; i < params.sharedHeadings; i++) sharedHeadings.push(`h${i}`);
    const prevOnlyHeadings: string[] = [];
    for (let i = 0; i < params.aOnlyHeadings; i++) prevOnlyHeadings.push(`h_po${i}`);
    const nextOnlyHeadings: string[] = [];
    for (let i = 0; i < params.bOnlyHeadings; i++) nextOnlyHeadings.push(`h_no${i}`);

    const prev = [...sharedHeadings, ...prevOnlyHeadings].map((h) => `## ${h}`).join("\n") + "\n" + prevBody.join(" ");
    const next = [...sharedHeadings, ...nextOnlyHeadings].map((h) => `## ${h}`).join("\n") + "\n" + nextBody.join(" ");
    return { prev, next };
  };

  const cases: { label: string; citedSim: number; citedHcr: number; expectFire: boolean; params: Parameters<typeof buildCitedPair>[0] }[] = [
    {
      label: "1 → 2 (sim 0.489, hcr 0.533)",
      citedSim: 0.489,
      citedHcr: 0.533,
      expectFire: false,
      params: { sharedBody: 971, aOnlyBody: 503, bOnlyBody: 503, sharedHeadings: 7, aOnlyHeadings: 8, bOnlyHeadings: 8 },
    },
    {
      label: "2 → 3 (sim 0.562, hcr 0.765)",
      citedSim: 0.562,
      citedHcr: 0.765,
      expectFire: true,
      params: { sharedBody: 558, aOnlyBody: 206, bOnlyBody: 206, sharedHeadings: 4, aOnlyHeadings: 13, bOnlyHeadings: 13 },
    },
    {
      label: "3 → 4 (sim 0.528, hcr 0.677)",
      citedSim: 0.528,
      citedHcr: 0.677,
      expectFire: false,
      params: { sharedBody: 523, aOnlyBody: 224, bOnlyBody: 227, sharedHeadings: 5, aOnlyHeadings: 11, bOnlyHeadings: 10 },
    },
  ];

  for (const c of cases) {
    const { prev, next } = buildCitedPair(c.params);
    const measuredSim = proposalSimilarity(prev, next);
    const measuredHcr = headingChangeRatio(sectionHeadings(prev), sectionHeadings(next));
    assert.ok(
      Math.abs(measuredSim - c.citedSim) < TOLERANCE,
      `${c.label}: measured sim ${measuredSim.toFixed(4)} outside ${TOLERANCE} of cited ${c.citedSim}`,
    );
    assert.ok(
      Math.abs(measuredHcr - c.citedHcr) < TOLERANCE,
      `${c.label}: measured hcr ${measuredHcr.toFixed(4)} outside ${TOLERANCE} of cited ${c.citedHcr}`,
    );
    const fire = isMajorRestructuring(prev, next, DEFAULTS);
    assert.equal(
      fire,
      c.expectFire,
      `${c.label}: defaults must ${c.expectFire ? "fire" : "skip"} (sim=${measuredSim.toFixed(3)}, hcr=${measuredHcr.toFixed(3)})`,
    );
  }
});
