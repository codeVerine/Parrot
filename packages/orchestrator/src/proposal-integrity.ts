import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PersistenceStore } from "@platform/persistence";

export const APPROVED_PROPOSAL_ARTIFACT_KIND = "approved_proposal";

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

/** SHA-256 hex of file contents; null if unreadable. */
export function readProposalHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Refuse human approval / implementation when the on-disk proposal no longer
 * matches the hash that Pair reviewed (or that Author last accepted).
 */
export function assertProposalFresh(input: {
  proposalPath: string;
  expectedHash: string;
}): { ok: true; hash: string } | { ok: false; reason: string } {
  const actual = readProposalHash(input.proposalPath);
  if (!actual) {
    return { ok: false, reason: `Proposal file missing or unreadable at ${input.proposalPath}` };
  }
  if (actual !== input.expectedHash) {
    return {
      ok: false,
      reason: `Proposal hash mismatch for ${input.proposalPath}: expected ${input.expectedHash}, got ${actual}`,
    };
  }
  return { ok: true, hash: actual };
}

/** Persist the approved Author proposal identity against an implementation turn. */
export function persistApprovedProposalBinding(
  store: PersistenceStore,
  input: {
    workflowId: string;
    iterationId: string;
    turnId: string;
    agentId: string;
    proposalPath: string;
    proposalHash: string;
  },
): void {
  store.saveArtifact({
    artifactId: `${input.turnId}-approved-proposal`,
    workflowId: input.workflowId,
    iterationId: input.iterationId,
    turnId: input.turnId,
    agentId: input.agentId,
    kind: APPROVED_PROPOSAL_ARTIFACT_KIND,
    path: input.proposalPath,
    contentHash: input.proposalHash,
  });
}

/** Read the Author proposal identity bound to an implementation turn. */
export function readApprovedProposalBinding(
  store: PersistenceStore,
  workflowId: string,
  turnId: string,
): { proposalPath: string; proposalHash: string } | null {
  for (const row of store.listArtifacts(workflowId)) {
    if (text(row.turn_id) !== turnId) continue;
    if (text(row.kind) !== APPROVED_PROPOSAL_ARTIFACT_KIND) continue;
    return {
      proposalPath: text(row.path),
      proposalHash: text(row.content_hash),
    };
  }
  return null;
}
