import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeToon } from "@platform/contracts";
import type { AgentTurnRequest } from "../src/index.js";

export function approvedProposal(summary = "approved plan"): { proposalPath: string; proposalHash: string } {
  const dir = mkdtempSync(join(tmpdir(), "parrot-impl-"));
  const proposalPath = join(dir, "proposal.md");
  writeFileSync(proposalPath, `# Plan\n\n${summary}\n`);
  const proposalHash = createHash("sha256").update(readFileSync(proposalPath)).digest("hex");
  return { proposalPath, proposalHash };
}

export function envelope(req: AgentTurnRequest, role: string, payload: Record<string, unknown>): string {
  return encodeToon({
    workflowId: req.workflowId,
    iterationId: req.iterationId,
    turnId: req.turnId,
    schemaVersion: "v1",
    nonce: req.nonce,
    role,
    payload: { role, ...payload },
  });
}

export function authorEnvelope(
  req: AgentTurnRequest,
  summary: string,
  objectionsAddressed: unknown[] = [],
): string {
  const proposalPath = join(dirname(req.resultPath), "proposal.md");
  mkdirSync(dirname(proposalPath), { recursive: true });
  writeFileSync(proposalPath, `# Plan\n\n${summary}\n`, "utf8");
  return envelope(req, "planner", { proposalPath, summary, objectionsAddressed });
}

export function pairClean(req: AgentTurnRequest, proposalPath: string): string {
  const hash = createHash("sha256").update(readFileSync(proposalPath)).digest("hex");
  return envelope(req, "reviewer", {
    reviewedProposalPath: proposalPath,
    reviewedProposalHash: hash,
    summary: "Pair review: plan looks solid.",
    objections: [],
    cleanRationale: "All criteria satisfied.",
  });
}

export function pairObjections(
  req: AgentTurnRequest,
  proposalPath: string,
  objections: Array<{
    id: string;
    severity: string;
    claim: string;
    evidence: string[];
    suggestedResolution?: string;
  }>,
): string {
  const hash = createHash("sha256").update(readFileSync(proposalPath)).digest("hex");
  return envelope(req, "reviewer", {
    reviewedProposalPath: proposalPath,
    reviewedProposalHash: hash,
    summary: "Pair review with objections.",
    objections: objections.map((o) => ({
      ...o,
      suggestedResolution: o.suggestedResolution ?? `Fix: ${o.claim}`,
    })),
  });
}
