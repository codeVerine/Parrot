import assert from "node:assert/strict";
import test from "node:test";
import type { ObjectionView } from "@platform/llm-boundary";
import {
  askOptionalGuidance,
  askUntilValid,
  formatDecisionPrompt,
  formatStalematePrompt,
  parseDecisionInput,
  parseStalemateInput,
  sanitizeForTerminal,
} from "../src/cli-format.js";

function objection(partial: Partial<ObjectionView> & Pick<ObjectionView, "id" | "claim">): ObjectionView {
  return {
    dimension: "review",
    severity: "blocking",
    evidence: [],
    status: "open",
    raisedBy: "reviewer",
    turnId: "turn-1",
    ...partial,
  };
}

test("sanitizeForTerminal strips ANSI and C0 controls but keeps newline/tab", () => {
  assert.equal(sanitizeForTerminal("plain"), "plain");
  assert.equal(sanitizeForTerminal("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeForTerminal("a\u0000b\u0007c"), "abc");
  assert.equal(sanitizeForTerminal("line1\nline2\tok"), "line1\nline2\tok");
  assert.equal(sanitizeForTerminal(""), "");
});

test("formatDecisionPrompt lists objections and numbered options", () => {
  const prompt = formatDecisionPrompt({
    frontierReadiness: "ready",
    openObjections: [
      objection({ id: "OBJ-1", severity: "blocking", claim: "Hash check is fail-open", raisedBy: "reviewer" }),
      objection({ id: "OBJ-2", severity: "major", claim: "Missing callback tests", raisedBy: "reviewer" }),
    ],
  });

  assert.match(prompt, /Status: open objections remain/);
  assert.match(prompt, /Why: Pair review did not clear everything/);
  assert.match(prompt, /Frontier readiness: Ready/);
  assert.match(prompt, /Open objections \(2\)/);
  assert.match(prompt, /\[blocking\] OBJ-1/);
  assert.match(prompt, /Hash check is fail-open/);
  assert.match(prompt, /\[major\] OBJ-2/);
  assert.match(prompt, /\[1\] Approve/);
  assert.match(prompt, /waives 2 open objections/);
  assert.match(prompt, /\[2\] Reject/);
  assert.match(prompt, /optional guidance for the next agent turn/i);
  assert.match(prompt, /Enter choice \(1\/2\):/);
});

test("formatDecisionPrompt handles zero objections and pending frontier", () => {
  const prompt = formatDecisionPrompt({ frontierReadiness: null, openObjections: [] });
  assert.match(prompt, /Status: ready for approval/);
  assert.match(prompt, /Why: Author and Pair finished with no open objections/);
  assert.match(prompt, /Frontier readiness: Pending/);
  assert.match(prompt, /Open objections: none/);
  assert.match(prompt, /Accept the plan as-is$/m);
  assert.doesNotMatch(prompt, /waives/);
});

test("formatDecisionPrompt truncates long claims and sanitizes control sequences", () => {
  const long = `${"x".repeat(200)}\u001b[31mboom\u001b[0m`;
  const prompt = formatDecisionPrompt({
    frontierReadiness: "not_ready",
    openObjections: [objection({ id: "OBJ-9", claim: long })],
  });
  assert.match(prompt, /Status: open objections remain/);
  assert.match(prompt, /Frontier readiness: Not ready/);
  assert.doesNotMatch(prompt, /\u001b/);
  assert.doesNotMatch(prompt, /boom/);
  assert.match(prompt, /…/);
});

test("formatDecisionPrompt shows Author proposal path, hash, and suggestedResolution", () => {
  const prompt = formatDecisionPrompt({
    frontierReadiness: "ready",
    proposalPath: "/runs/wf/proposal.md",
    proposalHash: "a".repeat(64),
    proposalSummary: "Ship auth guard",
    pairReviewSummaries: [{ agentId: "reviewer", summary: "Solid plan with minor risks noted." }],
    openObjections: [
      objection({
        id: "OBJ-1",
        claim: "Missing callback tests",
        suggestedResolution: "Add tests in auth/callback.test.ts",
      }),
    ],
  });
  assert.match(prompt, /Author proposal: .*proposal\.md \(sha256 aaaaaaaa/);
  assert.match(prompt, /Author summary: Ship auth guard/);
  assert.match(prompt, /Pair \(Pair\): Solid plan with minor risks/);
  assert.match(prompt, /suggested: Add tests in auth\/callback\.test\.ts/);
});

test("formatDecisionPrompt renders each Pair summary on its own line with agent label", () => {
  const prompt = formatDecisionPrompt({
    frontierReadiness: "ready",
    openObjections: [],
    pairReviewSummaries: [
      { agentId: "agent-reviewer-a", summary: "First reviewer notes minor risks." },
      { agentId: "agent-reviewer-b", summary: "Second reviewer approves the plan." },
    ],
  });
  assert.match(prompt, /Pair \(agent-reviewer-a\): First reviewer notes minor risks/);
  assert.match(prompt, /Pair \(agent-reviewer-b\): Second reviewer approves the plan/);
});

test("formatDecisionPrompt maps raisedBy reviewer/planner to Pair/Author and preserves custom ids", () => {
  const prompt = formatDecisionPrompt({
    frontierReadiness: "ready",
    openObjections: [
      objection({ id: "OBJ-R", claim: "from reviewer", raisedBy: "reviewer" }),
      objection({ id: "OBJ-P", claim: "from planner", raisedBy: "planner" }),
      objection({ id: "OBJ-C", claim: "from custom", raisedBy: "security-bot" }),
    ],
  });
  assert.match(prompt, /OBJ-R \(by Pair\)/);
  assert.match(prompt, /OBJ-P \(by Author\)/);
  assert.match(prompt, /OBJ-C \(by security-bot\)/);
});

test("formatStalematePrompt includes Author proposal path when provided", () => {
  const prompt = formatStalematePrompt({
    reason: "objection_stalemate",
    objectionIds: ["OBJ-1"],
    report: "Objection stalemate report body",
    proposalPath: "/runs/wf-1/iter-2/proposal.md",
    proposalHash: "b".repeat(64),
    proposalSummary: "Ship auth guard",
  });
  assert.match(prompt, /Author proposal: .*proposal\.md \(sha256 bbbbbbbb/);
  assert.match(prompt, /Author summary: Ship auth guard/);
});

test("formatStalematePrompt includes report, numbered options, and reason header", () => {
  const prompt = formatStalematePrompt({
    reason: "objection_stalemate",
    objectionIds: ["OBJ-CLI-002"],
    report: "Objection stalemate: 1 objection(s).\n\n### OBJ-CLI-002\nclaim: needs callback tests",
  });
  assert.match(prompt, /^Objection stalemate/m);
  assert.match(prompt, /Status: deadlock — objection stalemate/);
  assert.match(prompt, /Why: Author and Pair disagreed/);
  assert.match(prompt, /needs callback tests/);
  assert.match(prompt, /\[1\] Accept mitigation/);
  assert.match(prompt, /\[2\] Continue planning/);
  assert.match(prompt, /\[3\] Abort/);
  assert.match(prompt, /optional guidance for the next agent turn/i);
  assert.match(prompt, /Enter choice \(1\/2\/3\):/);
});

test("formatStalematePrompt headers for guardrail and churn", () => {
  const guardrail = formatStalematePrompt({ reason: "guardrail_conflict", objectionIds: [], report: "x" });
  assert.match(guardrail, /^Guardrail conflict/m);
  assert.match(guardrail, /Status: deadlock — guardrail conflict/);
  assert.match(guardrail, /Why: The Author cannot satisfy an objection without violating a guardrail/);

  const churn = formatStalematePrompt({ reason: "plan_churn", objectionIds: [], report: "x" });
  assert.match(churn, /^Plan churn/m);
  assert.match(churn, /Status: deadlock — plan churn/);
  assert.match(churn, /Why: The plan is oscillating without converging/);
});

test("parseDecisionInput accepts numbered and legacy approve/reject forms", () => {
  assert.equal(parseDecisionInput("1"), "approved");
  assert.equal(parseDecisionInput("a"), "approved");
  assert.equal(parseDecisionInput(" Approve "), "approved");
  assert.equal(parseDecisionInput("2"), "rejected");
  assert.equal(parseDecisionInput("r"), "rejected");
  assert.equal(parseDecisionInput("reject"), "rejected");
  assert.equal(parseDecisionInput(""), null);
  assert.equal(parseDecisionInput("   "), null);
  assert.equal(parseDecisionInput("xyz"), null);
  assert.equal(parseDecisionInput("abort"), null);
});

test("parseStalemateInput accepts numbered and legacy forms", () => {
  assert.equal(parseStalemateInput("1"), "accept_mitigation");
  assert.equal(parseStalemateInput("m"), "accept_mitigation");
  assert.equal(parseStalemateInput("accept_mitigation"), "accept_mitigation");
  assert.equal(parseStalemateInput("2"), "accept_objection");
  assert.equal(parseStalemateInput("o"), "accept_objection");
  assert.equal(parseStalemateInput("continue"), "accept_objection");
  assert.equal(parseStalemateInput("3"), "abort");
  assert.equal(parseStalemateInput("a"), "abort");
  assert.equal(parseStalemateInput("abort"), "abort");
  assert.equal(parseStalemateInput(""), null);
  assert.equal(parseStalemateInput("xyz"), null);
});

test("askUntilValid re-prompts on invalid input and commits only after a valid answer", async () => {
  const answers = ["", "xyz", "1"];
  const hints: string[] = [];
  const prompts: string[] = [];

  const result = await askUntilValid({
    prompt: "Enter choice (1/2): ",
    question: async (message) => {
      prompts.push(message);
      return answers.shift() ?? "1";
    },
    parse: parseDecisionInput,
    invalidHint: "Unrecognized input. Valid options: 1 (approve), 2 (reject).",
    writeLine: (message) => hints.push(message),
  });

  assert.equal(result, "approved");
  assert.equal(prompts.length, 3);
  assert.deepEqual(hints, [
    "Unrecognized input. Valid options: 1 (approve), 2 (reject).",
    "Unrecognized input. Valid options: 1 (approve), 2 (reject).",
  ]);
});

test("askUntilValid does not commit abort on blank stalemate input", async () => {
  const answers = ["", "1"];
  const result = await askUntilValid({
    prompt: "Enter choice (1/2/3): ",
    question: async () => answers.shift() ?? "1",
    parse: parseStalemateInput,
    invalidHint: "bad",
    writeLine: () => undefined,
  });
  assert.equal(result, "accept_mitigation");
});

test("askOptionalGuidance skips blank Enter and returns trimmed text", async () => {
  assert.equal(
    await askOptionalGuidance({ question: async () => "   " }),
    undefined,
  );
  assert.equal(
    await askOptionalGuidance({ question: async () => "" }),
    undefined,
  );
  assert.equal(
    await askOptionalGuidance({ question: async () => "  use machine-ratchet  " }),
    "use machine-ratchet",
  );
});
