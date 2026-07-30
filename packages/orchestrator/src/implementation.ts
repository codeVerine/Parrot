import type { ImplementationResult } from "@platform/contracts";
import type { ResumeTurnRegistry } from "./resume.js";
import type { TurnDeps, TurnOutcome } from "./turn.js";
import { runTurn } from "./turn.js";

export type ImplementationInput = {
  workflowId: string;
  iterationId: string;
  agentId: string;
  task: string;
  proposalPath?: string;
  proposalSummary?: string;
  iterationNumber?: number;
};

export type ImplementationOutcome =
  | { status: "completed"; turnId: string; summary: string }
  | { status: "blocked"; turnId: string; summary: string }
  | { status: "deviation"; turnId: string; summary: string; deviationRequest: string }
  | { status: "failed"; turnId: string; reason: string };

/**
 * Route an approved plan to an implementation agent. A blocked result emits
 * ImplementationBlocked and escalates (engine sole writer); a deviation request
 * routes back to the human and never self-authorizes.
 */
export async function runImplementation(
  deps: TurnDeps,
  input: ImplementationInput,
  resumeRegistry?: ResumeTurnRegistry | null,
): Promise<ImplementationOutcome> {
  const turn = await runTurn(deps, {
    turnType: "implementation",
    workflowId: input.workflowId,
    iterationId: input.iterationId,
    agentId: input.agentId,
    context: {
      task: input.task,
      ...(input.proposalPath ? { proposalPath: input.proposalPath } : {}),
      ...(input.proposalSummary ? { proposalSummary: input.proposalSummary } : {}),
    },
    ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
  }, resumeRegistry);

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
