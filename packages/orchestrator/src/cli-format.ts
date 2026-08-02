import { displayAgentLabel } from "./display-labels.js";
import type { ObjectionView } from "@platform/llm-boundary";
import type { HumanDecision, StalemateChoice } from "./loop.js";

const CLAIM_TRUNCATE = 120;

/** Strip ANSI escapes and C0/C1 controls (keep newline/tab) before terminal output. */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function truncateClaim(claim: string): string {
  const clean = sanitizeForTerminal(claim).replace(/\s+/g, " ").trim();
  if (clean.length <= CLAIM_TRUNCATE) return clean;
  return `${clean.slice(0, CLAIM_TRUNCATE - 1)}…`;
}

function formatObjectionLine(
  objection: Pick<ObjectionView, "id" | "severity" | "claim" | "raisedBy" | "suggestedResolution">,
): string {
  const claim = truncateClaim(objection.claim) || "(no claim)";
  const raisedBy = displayAgentLabel(sanitizeForTerminal(objection.raisedBy));
  const lines = [`  - [${objection.severity}] ${objection.id} (by ${raisedBy}): ${claim}`];
  if (objection.suggestedResolution?.trim()) {
    lines.push(`      suggested: ${truncateClaim(objection.suggestedResolution)}`);
  }
  return lines.join("\n");
}

function frontierLabel(readiness: "ready" | "not_ready" | null): string {
  if (readiness === "ready") return "Ready";
  if (readiness === "not_ready") return "Not ready";
  return "Pending";
}

export type DecisionPromptContext = {
  openObjections: readonly ObjectionView[];
  frontierReadiness: "ready" | "not_ready" | null;
  proposalPath?: string;
  proposalHash?: string;
  proposalSummary?: string;
  pairReviewSummaries?: ReadonlyArray<{ agentId: string; summary: string }>;
};

function decisionSituation(ctx: DecisionPromptContext): { status: string; why: string } {
  if (ctx.openObjections.length === 0) {
    return {
      status: "ready for approval",
      why: "Author and Pair finished with no open objections. Approve to accept the plan, or reject to send it back.",
    };
  }
  return {
    status: "open objections remain",
    why: `Pair review did not clear everything — ${ctx.openObjections.length} objection${ctx.openObjections.length === 1 ? " is" : "s are"} still open. Approving waives them; rejecting continues revision.`,
  };
}

export function formatDecisionPrompt(ctx: DecisionPromptContext): string {
  const situation = decisionSituation(ctx);
  const lines: string[] = [
    "Human decision needed",
    `Status: ${situation.status}`,
    `Why: ${situation.why}`,
    `Frontier readiness: ${frontierLabel(ctx.frontierReadiness)}`,
  ];

  if (ctx.proposalPath) {
    const shortHash = ctx.proposalHash ? ctx.proposalHash.slice(0, 12) : "unknown";
    lines.push(`Author proposal: ${sanitizeForTerminal(ctx.proposalPath)} (sha256 ${shortHash}…)`);
  }
  if (ctx.proposalSummary?.trim()) {
    lines.push(`Author summary: ${truncateClaim(ctx.proposalSummary)}`);
  }
  if (ctx.pairReviewSummaries && ctx.pairReviewSummaries.length > 0) {
    for (const item of ctx.pairReviewSummaries) {
      const who = displayAgentLabel(item.agentId);
      lines.push(`Pair (${who}): ${truncateClaim(item.summary)}`);
    }
  }

  if (ctx.openObjections.length === 0) {
    lines.push("Open objections: none");
  } else {
    lines.push(`Open objections (${ctx.openObjections.length}):`);
    for (const objection of ctx.openObjections) {
      lines.push(formatObjectionLine(objection));
    }
  }

  const waiveNote =
    ctx.openObjections.length > 0
      ? `Accept the plan as-is (waives ${ctx.openObjections.length} open objection${ctx.openObjections.length === 1 ? "" : "s"})`
      : "Accept the plan as-is";

  lines.push(
    "",
    "Options:",
    `  [1] Approve  — ${waiveNote}`,
    "  [2] Reject  — Send the plan back for revision",
    "",
    "After choosing, you may add optional guidance for the next agent turn.",
    "",
    "Enter choice (1/2): ",
  );
  return lines.join("\n");
}

export type StalematePromptContext = {
  objectionIds: readonly string[];
  report: string;
  reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn";
  openObjections?: readonly ObjectionView[];
  proposalPath?: string;
  proposalHash?: string;
  proposalSummary?: string;
};

function stalemateSituation(reason: StalematePromptContext["reason"]): { header: string; status: string; why: string } {
  if (reason === "guardrail_conflict") {
    return {
      header: "Guardrail conflict",
      status: "deadlock — guardrail conflict",
      why: "The Author cannot satisfy an objection without violating a guardrail. Approve the concession, continue planning, or abort.",
    };
  }
  if (reason === "plan_churn") {
    return {
      header: "Plan churn",
      status: "deadlock — plan churn",
      why: "The plan is oscillating without converging. Approve the current mitigation, continue planning, or abort.",
    };
  }
  return {
    header: "Objection stalemate",
    status: "deadlock — objection stalemate",
    why: "Author and Pair disagreed on the same objection(s) past the stalemate threshold. Approve the mitigation, continue planning, or abort.",
  };
}

export function formatStalematePrompt(ctx: StalematePromptContext): string {
  const situation = stalemateSituation(ctx.reason);
  const lines: string[] = [
    situation.header,
    `Status: ${situation.status}`,
    `Why: ${situation.why}`,
    "",
  ];

  if (ctx.proposalPath) {
    const shortHash = ctx.proposalHash ? ctx.proposalHash.slice(0, 12) : "unknown";
    lines.push(`Author proposal: ${sanitizeForTerminal(ctx.proposalPath)} (sha256 ${shortHash}…)`);
  }
  if (ctx.proposalSummary?.trim()) {
    lines.push(`Author summary: ${truncateClaim(ctx.proposalSummary)}`);
  }
  if (ctx.proposalPath || ctx.proposalSummary?.trim()) {
    lines.push("");
  }

  lines.push(sanitizeForTerminal(ctx.report).trimEnd(), "");

  if (ctx.openObjections && ctx.openObjections.length > 0) {
    lines.push("Open objections at stake:");
    for (const objection of ctx.openObjections) {
      lines.push(formatObjectionLine(objection));
    }
    lines.push("");
  }

  lines.push(
    "Options:",
    "  [1] Accept mitigation — Approve the plan (waive open objections)",
    "  [2] Continue planning — Pair is right; run another Author→Pair round",
    "  [3] Abort             — Stop the workflow and escalate",
    "",
    "After choosing, you may add optional guidance for the next agent turn.",
    "",
    "Enter choice (1/2/3): ",
  );
  return lines.join("\n");
}

export function parseDecisionInput(raw: string): HumanDecision["decision"] | null {
  const answer = raw.trim().toLowerCase();
  if (!answer) return null;
  if (answer === "1" || answer === "a" || answer === "approve" || answer.startsWith("approve")) return "approved";
  if (answer === "2" || answer === "r" || answer === "reject" || answer.startsWith("reject")) return "rejected";
  return null;
}

export function parseStalemateInput(raw: string): StalemateChoice | null {
  const answer = raw.trim().toLowerCase();
  if (!answer) return null;
  if (
    answer === "1" ||
    answer === "m" ||
    answer.startsWith("accept_m") ||
    answer === "accept mitigation" ||
    answer.startsWith("mitigation")
  ) {
    return "accept_mitigation";
  }
  if (
    answer === "2" ||
    answer === "o" ||
    answer.startsWith("accept_o") ||
    answer === "accept objection" ||
    answer.startsWith("objection") ||
    answer === "continue" ||
    answer.startsWith("continue")
  ) {
    return "accept_objection";
  }
  if (answer === "3" || answer === "a" || answer === "abort" || answer.startsWith("abort")) return "abort";
  return null;
}

/**
 * Ask until the parser accepts input. Keeps prompting on blank/unrecognized answers
 * so blank Enter cannot silently become reject/abort.
 */
export async function askUntilValid<T>(input: {
  prompt: string;
  question: (message: string) => Promise<string>;
  parse: (raw: string) => T | null;
  invalidHint: string;
  writeLine?: (message: string) => void;
}): Promise<T> {
  const writeLine = input.writeLine ?? ((message: string) => console.log(message));
  for (;;) {
    const raw = await input.question(input.prompt);
    const parsed = input.parse(raw);
    if (parsed !== null) return parsed;
    writeLine(input.invalidHint);
  }
}

export const OPTIONAL_GUIDANCE_PROMPT = "Optional guidance (Enter to skip): ";

/**
 * Collect optional free-text guidance after a human choice. Blank Enter skips.
 */
export async function askOptionalGuidance(input: {
  question: (message: string) => Promise<string>;
  writeLine?: (message: string) => void;
  prompt?: string;
}): Promise<string | undefined> {
  void input.writeLine;
  const raw = await input.question(input.prompt ?? OPTIONAL_GUIDANCE_PROMPT);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
