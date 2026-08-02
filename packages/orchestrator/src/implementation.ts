import type { ImplementationResult } from "@platform/contracts";
import type { PersistenceStore } from "@platform/persistence";
import {
  APPROVED_PROPOSAL_ARTIFACT_KIND,
  assertProposalFresh,
  persistApprovedProposalBinding,
} from "./proposal-integrity.js";
import type { ResumeTurnRegistry } from "./resume.js";
import type { TurnDeps, TurnOutcome } from "./turn.js";
import { runTurn } from "./turn.js";

export type ImplementationInput = {
  workflowId: string;
  iterationId: string;
  agentId: string;
  task: string;
  /** Approved Author proposal path — required; verified immediately before dispatch. */
  proposalPath: string;
  /** Approved Author proposal SHA-256 — required; must still match on-disk bytes. */
  proposalHash: string;
  proposalSummary?: string;
  iterationNumber?: number;
  humanMessages?: Array<{ afterIteration: number; message: string }>;
};

export type ImplementationOutcome =
  | { status: "completed"; turnId: string; summary: string }
  | { status: "blocked"; turnId: string; summary: string }
  | { status: "deviation"; turnId: string; summary: string; deviationRequest: string }
  | { status: "failed"; turnId: string; reason: string };

export { APPROVED_PROPOSAL_ARTIFACT_KIND, persistApprovedProposalBinding };

/**
 * Route an approved plan to an implementation agent. A blocked result emits
 * ImplementationBlocked and escalates (engine sole writer); a deviation request
 * routes back to the human and never self-authorizes.
 *
 * Fail-closed: refuses to dispatch when path/hash are missing or the on-disk
 * proposal no longer matches the approved hash. The approved_proposal binding is
 * persisted as soon as the turn id exists (before agent dispatch).
 */
export async function runImplementation(
  deps: TurnDeps,
  input: ImplementationInput,
  store: PersistenceStore,
  resumeRegistry?: ResumeTurnRegistry | null,
): Promise<ImplementationOutcome> {
  if (!store) {
    return {
      status: "failed",
      turnId: "preflight",
      reason: "Implementation requires a PersistenceStore to bind the approved proposal",
    };
  }
  const path = input.proposalPath?.trim() ?? "";
  const hash = input.proposalHash?.trim() ?? "";
  if (!path || !hash) {
    return {
      status: "failed",
      turnId: "preflight",
      reason: "Implementation requires proposalPath and proposalHash of the approved Author proposal",
    };
  }
  const fresh = assertProposalFresh({ proposalPath: path, expectedHash: hash });
  if (!fresh.ok) {
    return { status: "failed", turnId: "preflight", reason: fresh.reason };
  }

  const turn = await runTurn(
    { ...deps, store },
    {
      turnType: "implementation",
      workflowId: input.workflowId,
      iterationId: input.iterationId,
      agentId: input.agentId,
      context: {
        task: input.task,
        proposalPath: path,
        proposalHash: hash,
        ...(input.proposalSummary ? { proposalSummary: input.proposalSummary } : {}),
        ...(input.humanMessages && input.humanMessages.length > 0
          ? { humanMessages: input.humanMessages }
          : {}),
      },
      approvedProposalBinding: { proposalPath: path, proposalHash: hash },
      ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
    },
    resumeRegistry,
  );

  if (turn.status === "failed") {
    return { status: "failed", turnId: turn.turnId, reason: turn.reason };
  }

  const result = turn.payload as ImplementationResult;

  if (result.status === "blocked" || result.deviationRequest) {
    const reason = result.deviationRequest
      ? `Implementation deviation requested: ${result.deviationRequest}`
      : result.summary;
    deps.engine.reportImplementationBlocked({
      workflowId: input.workflowId,
      reason,
      iterationId: input.iterationId,
      turnId: turn.turnId,
      agentId: input.agentId,
    });
  }

  if (result.status === "blocked") {
    return { status: "blocked", turnId: turn.turnId, summary: result.summary };
  }

  if (result.deviationRequest) {
    return {
      status: "deviation",
      turnId: turn.turnId,
      summary: result.summary,
      deviationRequest: result.deviationRequest,
    };
  }

  return { status: "completed", turnId: turn.turnId, summary: result.summary };
}

export type VerificationInput = {
  workflowId: string;
  iterationId: string;
  agentId: string;
  targetTurnId: string;
  summary: string;
  evidence: string[];
  iterationNumber?: number;
};

/**
 * Verify a completed implementation through the resolution_verification turn.
 * A completion is checked, not trusted; failure follows the bounded-repair path.
 */
export async function runVerification(
  deps: TurnDeps,
  input: VerificationInput,
  resumeRegistry?: ResumeTurnRegistry | null,
): Promise<TurnOutcome> {
  return runTurn(deps, {
    turnType: "resolution_verification",
    workflowId: input.workflowId,
    iterationId: input.iterationId,
    agentId: input.agentId,
    context: {
      verificationTarget: {
        objectionId: input.targetTurnId,
        plannerResponse: input.summary,
        evidence: input.evidence,
      },
    },
    ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
  }, resumeRegistry);
}
