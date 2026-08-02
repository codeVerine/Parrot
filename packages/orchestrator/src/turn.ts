import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeSignal } from "@platform/contracts";
import { PlannerResultSchema, ResolutionResultSchema } from "@platform/contracts";
import type { BuildContext, PromptBuilder, ResultExtractor, TurnType } from "@platform/llm-boundary";
import { isAuthorProposalPathPrompt, sha256Hex, toEngineValidationVerdict } from "@platform/llm-boundary";
import type { PersistenceStore } from "@platform/persistence";
import type { WorkflowEngine } from "@platform/workflow-engine";
import { snapshotCitations, verifyCitationsDetailed } from "./citations.js";
import { loadCompletedResult } from "./completed-result.js";
import {
  persistApprovedProposalBinding,
  readApprovedProposalBinding,
} from "./proposal-integrity.js";
import type { AgentRunner } from "./runner.js";
import { ResumeTurnRegistry, type ResumableTurn } from "./resume.js";

export type TurnDeps = {
  engine: WorkflowEngine;
  builder: PromptBuilder;
  extractor: ResultExtractor;
  runner: AgentRunner;
  runsRoot: string;
  deadlineMs: number;
  writePrompts: boolean;
  newId: () => string;
  nowIso: () => string;
  /** When set, planner citations are verified against this working tree. */
  projectDir?: string;
  /** Required for Author proposal binding on implementation turns. */
  store?: PersistenceStore;
};

export type RunTurnInput = {
  turnType: TurnType;
  workflowId: string;
  iterationId: string;
  agentId: string;
  context: BuildContext;
  iterationNumber?: number;
  inputObjectionIds?: readonly string[];
  /** Pair: bind review to this immutable Author proposal. */
  expectedProposalPath?: string;
  expectedProposalHash?: string;
  /**
   * Persist approved_proposal binding as soon as the turn id exists (before
   * agent dispatch), so TurnCompleted cannot race ahead of the binding.
   */
  approvedProposalBinding?: { proposalPath: string; proposalHash: string };
};

export type TurnOutcome =
  | { status: "valid"; turnId: string; role: string; payload: unknown; resultHash: string }
  | { status: "failed"; turnId: string; reason: string };

/**
 * Check the semantic content of a resolution verdict beyond schema validation.
 * Returns null when the resolution is complete, or an error string describing
 * why it is not (missing target, unresolved objections).
 */
function resolutionSemanticIssue(payload: unknown, targetTurnId?: string): string | null {
  const parsed = ResolutionResultSchema.safeParse(payload);
  if (!parsed.success) return "resolution payload failed schema validation";
  const resolution = parsed.data;
  if (resolution.unresolved.length > 0) {
    return `Resolution has ${resolution.unresolved.length} unresolved objection(s): ${resolution.unresolved.join(", ")}`;
  }
  if (targetTurnId && !resolution.verified.includes(targetTurnId)) {
    return `Target turn ${targetTurnId} not found in verified list: ${resolution.verified.join(", ") || "(empty)"}`;
  }
  return null;
}

/** Propose/revise only. compacted_state_refresh also validates against
 *  PlannerResultSchema but summarizes rather than plans, so citations are not verified. */
function isPlannerTurn(turnType: TurnType): boolean {
  return turnType === "planner_propose" || turnType === "planner_revise";
}

function validateArgsFromInput(
  input: RunTurnInput,
  promptVersion: string,
  proposalOutputPath?: string,
): {
  promptVersion: string;
  expectedProposalOutputPath?: string;
  expectedProposalPath?: string;
  expectedProposalHash?: string;
} {
  return {
    promptVersion,
    ...(proposalOutputPath ? { expectedProposalOutputPath: proposalOutputPath } : {}),
    ...(input.expectedProposalPath ? { expectedProposalPath: input.expectedProposalPath } : {}),
    ...(input.expectedProposalHash ? { expectedProposalHash: input.expectedProposalHash } : {}),
  };
}

/**
 * Author@1.8.0+: proposal file must exist at the declared path with non-whitespace content.
 */
function authorProposalFileIssue(promptVersion: string, payload: unknown): string | null {
  if (!isAuthorProposalPathPrompt(promptVersion)) return null;
  const parsed = PlannerResultSchema.safeParse(payload);
  if (!parsed.success) return "planner payload failed schema validation";
  const path = parsed.data.proposalPath;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return `Author proposal file missing or unreadable at ${path}`;
  }
  if (!text.trim()) {
    return `Author proposal file at ${path} is empty`;
  }
  return null;
}

/**
 * Verify structured planner citations against the working tree. On success,
 * snapshot the already-verified spans next to result.toon (single read — no
 * re-verify). Returns null when skipped or all match; otherwise diagnostics.
 */
function plannerCitationIssue(
  deps: TurnDeps,
  turnType: TurnType,
  payload: unknown,
  resultPath: string,
  options?: { skip?: boolean },
): string | null {
  if (options?.skip || !deps.projectDir || !isPlannerTurn(turnType)) return null;

  const parsed = PlannerResultSchema.safeParse(payload);
  if (!parsed.success) return "planner payload failed schema validation";

  const citations = parsed.data.citations ?? [];
  const detailed = verifyCitationsDetailed({ projectDir: deps.projectDir, citations });
  if (!detailed.ok) return detailed.diagnostics;

  if (detailed.verified.length > 0) {
    snapshotCitations({
      projectDir: deps.projectDir,
      resultPath,
      verified: detailed.verified,
    });
  }
  return null;
}

function applyPostSchemaIssues(
  turnType: TurnType,
  promptVersion: string,
  payload: unknown,
  deps: TurnDeps,
  resultPath: string,
  input: RunTurnInput,
  options?: { skipCitation?: boolean; skipProposalFile?: boolean },
): string | null {
  if (turnType === "resolution_verification") {
    return resolutionSemanticIssue(payload, input.context.verificationTarget?.objectionId);
  }
  if (!options?.skipProposalFile) {
    const proposalIssue = authorProposalFileIssue(promptVersion, payload);
    if (proposalIssue) return proposalIssue;
  }
  return plannerCitationIssue(deps, turnType, payload, resultPath, { skip: options?.skipCitation });
}

/**
 * Drive one turn end to end: build prompt, register with the engine, deliver to
 * the agent, validate, and run at most one bounded repair. The engine flips the
 * turn to `repair` on the first validation failure; the second failure fails it.
 *
 * When a resume registry is provided and contains a matching candidate for
 * (workflowId, iterationId, agentId), the turn is adopted from storage instead
 * of dispatching a new agent run.
 */
export async function runTurn(
  deps: TurnDeps,
  input: RunTurnInput,
  resumeRegistry?: ResumeTurnRegistry | null,
): Promise<TurnOutcome> {
  const { engine, builder, extractor, runner } = deps;
  const { turnType, workflowId, iterationId, agentId } = input;

  // Check for a resume candidate before creating a new turn.
  if (resumeRegistry) {
    const candidate = resumeRegistry.consume(workflowId, iterationId, agentId);
    if (candidate) {
      return adoptResumeCandidate(deps, input, candidate);
    }
  }

  const turnId = deps.newId();
  const resultPath = join(deps.runsRoot, workflowId, iterationId, turnId, "result.toon");
  const proposalOutputPath = isPlannerTurn(turnType)
    ? join(dirname(resultPath), "proposal.md")
    : undefined;

  const built = builder.build({
    turnType,
    identity: { workflowId, iterationId, turnId },
    context: {
      ...input.context,
      resultPath,
      ...(proposalOutputPath ? { proposalOutputPath } : {}),
    },
    write: deps.writePrompts,
  });

  engine.startTurn({
    turnId,
    workflowId,
    iterationId,
    agentId,
    attempt: "primary",
    deadlineAt: new Date(Date.now() + deps.deadlineMs).toISOString(),
    promptPath: built.path,
    promptHash: built.promptHash,
    nonce: built.nonce,
    promptVersion: built.promptVersion,
    resultPath,
    ...(input.iterationNumber !== undefined ? { iterationNumber: input.iterationNumber } : {}),
  });
  if (input.approvedProposalBinding) {
    if (!deps.store) {
      throw new Error("approvedProposalBinding requires TurnDeps.store");
    }
    persistApprovedProposalBinding(deps.store, {
      workflowId,
      iterationId,
      turnId,
      agentId,
      proposalPath: input.approvedProposalBinding.proposalPath,
      proposalHash: input.approvedProposalBinding.proposalHash,
    });
  }
  engine.markDelivered(turnId);

  const primary = await runner.deliver({
    agentId,
    turnType,
    attempt: "primary",
    workflowId,
    iterationId,
    turnId,
    nonce: built.nonce,
    promptPath: built.path,
    promptContent: built.content,
    promptHash: built.promptHash,
    promptVersion: built.promptVersion,
    resultPath,
  });

  signalResultSeen(deps, {
    workflowId,
    iterationId,
    turnId,
    agentId,
    resultPath,
    attempt: "primary",
    resultText: primary.resultText,
  });

  const validateExtra = validateArgsFromInput(input, built.promptVersion, proposalOutputPath);
  const primaryVerdict = extractor.validate({
    bytes: primary.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "primary" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
    ...validateExtra,
  });

  let effectivePrimaryVerdict = primaryVerdict;
  if (primaryVerdict.outcome === "valid") {
    const semanticIssue = applyPostSchemaIssues(
      turnType,
      built.promptVersion,
      primaryVerdict.payload,
      deps,
      resultPath,
      input,
    );
    if (semanticIssue) {
      effectivePrimaryVerdict = {
        outcome: "needsRepair",
        reason: semanticIssue,
        diagnostics: semanticIssue,
      };
    }
  }

  engine.applyValidation(toEngineValidationVerdict(turnId, effectivePrimaryVerdict));

  if (effectivePrimaryVerdict.outcome === "valid") {
    return {
      status: "valid",
      turnId,
      role: effectivePrimaryVerdict.role,
      payload: effectivePrimaryVerdict.payload,
      resultHash: effectivePrimaryVerdict.resultHash,
    };
  }
  if (effectivePrimaryVerdict.outcome === "failed") {
    return { status: "failed", turnId, reason: effectivePrimaryVerdict.reason };
  }

  const repairReason =
    effectivePrimaryVerdict.diagnostics &&
    effectivePrimaryVerdict.diagnostics !== effectivePrimaryVerdict.reason
      ? `${effectivePrimaryVerdict.reason}: ${effectivePrimaryVerdict.diagnostics}`
      : effectivePrimaryVerdict.diagnostics || effectivePrimaryVerdict.reason;
  const repairBuilt = builder.build({
    turnType: "repair",
    identity: { workflowId, iterationId, turnId, nonce: built.nonce },
    context: {
      ...input.context,
      resultPath,
      ...(proposalOutputPath ? { proposalOutputPath } : {}),
      originalTurnType: turnType,
      repairReason,
    },
    write: deps.writePrompts,
  });

  const repair = await runner.deliver({
    agentId,
    turnType,
    attempt: "repair",
    workflowId,
    iterationId,
    turnId,
    nonce: built.nonce,
    promptPath: repairBuilt.path,
    promptContent: repairBuilt.content,
    promptHash: repairBuilt.promptHash,
    promptVersion: repairBuilt.promptVersion,
    resultPath,
  });

  signalResultSeen(deps, {
    workflowId,
    iterationId,
    turnId,
    agentId,
    resultPath,
    attempt: "repair",
    resultText: repair.resultText,
  });

  const repairVerdict = extractor.validate({
    bytes: repair.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "repair" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
    ...validateExtra,
  });

  let effectiveRepairVerdict = repairVerdict;
  if (repairVerdict.outcome === "valid") {
    const semanticIssue = applyPostSchemaIssues(
      turnType,
      built.promptVersion,
      repairVerdict.payload,
      deps,
      resultPath,
      input,
    );
    if (semanticIssue) {
      effectiveRepairVerdict = { outcome: "failed", reason: semanticIssue };
    }
  }

  engine.applyValidation(toEngineValidationVerdict(turnId, effectiveRepairVerdict));

  if (effectiveRepairVerdict.outcome === "valid") {
    return {
      status: "valid",
      turnId,
      role: effectiveRepairVerdict.role,
      payload: effectiveRepairVerdict.payload,
      resultHash: effectiveRepairVerdict.resultHash,
    };
  }
  return { status: "failed", turnId, reason: effectiveRepairVerdict.reason };
}

/**
 * Advance the turn `waiting -> validating` via a ResultFileSeen signal, as the
 * runtime adapter would on observing the result file. The content hash is salted
 * with the attempt so a repair with identical text is not deduped by correlation.
 */
function signalResultSeen(
  deps: TurnDeps,
  args: {
    workflowId: string;
    iterationId: string;
    turnId: string;
    agentId: string;
    resultPath: string;
    attempt: "primary" | "repair";
    resultText: string;
  },
): void {
  const signal: RuntimeSignal = {
    signalId: `${args.turnId}-${args.attempt}-result`,
    observedAt: deps.nowIso(),
    source: "fs_watch",
    classification: "observation",
    kind: "ResultFileSeen",
    workflowId: args.workflowId,
    iterationId: args.iterationId,
    turnId: args.turnId,
    agentId: args.agentId,
    artifactPath: args.resultPath,
    size: Buffer.byteLength(args.resultText, "utf8"),
    contentHash: sha256Hex(`${args.attempt}:${args.resultText}`),
  };
  deps.engine.handleSignal(signal);
}

/**
 * Adopt a previously persisted turn's result instead of dispatching a new agent run.
 *
 * Behavior by persisted state:
 *   waiting    -> emit ResultFileSeen, validate, apply normal validation
 *   validating -> apply validation directly (ResultFileSeen already fired)
 *   completed  -> read and validate artifact, return result without transition
 *
 * For completed-state corruption (missing/invalid artifact), throws a hard error.
 * For missing/invalid artifacts in waiting/validating, falls through to create a fresh turn.
 */
export async function adoptResumeCandidate(
  deps: TurnDeps,
  input: RunTurnInput,
  candidate: ResumableTurn,
): Promise<TurnOutcome> {
  const { engine, extractor } = deps;
  const { turnType, workflowId, iterationId, agentId } = input;

  if (candidate.workflowId !== workflowId || candidate.iterationId !== iterationId || candidate.agentId !== agentId) {
    throw new Error(
      `Resume candidate mismatch: expected ${workflowId}/${iterationId}/${agentId}, ` +
        `got ${candidate.workflowId}/${candidate.iterationId}/${candidate.agentId}.`,
    );
  }

  if (input.approvedProposalBinding) {
    if (!deps.store) {
      throw new Error("approvedProposalBinding requires TurnDeps.store");
    }
    const persisted = readApprovedProposalBinding(deps.store, workflowId, candidate.turnId);
    if (!persisted) {
      throw new Error(
        `Durable state inconsistency: implementation turn ${candidate.turnId} has no approved_proposal binding.`,
      );
    }
    const expected = input.approvedProposalBinding;
    if (
      persisted.proposalPath !== expected.proposalPath ||
      persisted.proposalHash !== expected.proposalHash
    ) {
      throw new Error(
        `Durable state inconsistency: implementation turn ${candidate.turnId} bound to ` +
          `${persisted.proposalPath}@${persisted.proposalHash}, expected ` +
          `${expected.proposalPath}@${expected.proposalHash}.`,
      );
    }
  }

  const resultPath = candidate.resultPath;
  let resultBytes: string | null = null;
  let readError: NodeJS.ErrnoException | null = null;
  if (candidate.state === "completed") {
    if (!deps.store) {
      throw new Error(
        `Durable state inconsistency: completed turn ${candidate.turnId} cannot be adopted without a PersistenceStore.`,
      );
    }
    resultBytes = loadCompletedResult(deps.store, {
      workflowId,
      turnId: candidate.turnId,
      resultPath,
      identity: {
        workflowId: candidate.workflowId,
        iterationId: candidate.iterationId,
        turnId: candidate.turnId,
        nonce: candidate.nonce,
      },
    }).resultBytes;
  } else {
    for (let i = 0; i < 2; i++) {
      readError = null;
      try {
        resultBytes = readFileSync(resultPath, "utf8");
        break;
      } catch (error) {
        readError = error as NodeJS.ErrnoException;
        if (readError.code !== "ENOENT") {
          break;
        }
        if (i === 0) await delay(250);
      }
    }
  }

  if (resultBytes === null && readError) {
    if (readError.code !== "ENOENT") throw readError;

    if (candidate.state === "waiting" || candidate.state === "validating") {
      engine.cancelTurn(candidate.turnId);
      return runTurn(deps, input, null);
    }
    throw new Error(
      `Durable state inconsistency: completed turn ${candidate.turnId} result file missing at ${resultPath}.`,
    );
  }

  const resultBytesSafe = resultBytes!;
  const skipObjectionIdCheck = candidate.state === "completed" && isPlannerTurn(turnType);
  const skipCitationCheck = candidate.state === "completed" && isPlannerTurn(turnType);
  // Skip existence/content re-check for completed Author turns (tree may drift),
  // but never drop expectedProposalOutputPath — path equality stays for 1.8.0+.
  const skipProposalFileCheck = candidate.state === "completed" && isPlannerTurn(turnType);
  const proposalOutputPath = isPlannerTurn(turnType) ? join(dirname(resultPath), "proposal.md") : undefined;
  const validateExtra = validateArgsFromInput(input, candidate.promptVersion, proposalOutputPath);
  const resultVerdict = extractor.validate({
    bytes: resultBytesSafe,
    turn: {
      workflowId: candidate.workflowId,
      iterationId: candidate.iterationId,
      turnId: candidate.turnId,
      nonce: candidate.nonce,
      turnType,
      attempt: candidate.attempt,
    },
    ...(input.inputObjectionIds && !skipObjectionIdCheck
      ? { inputObjectionIds: input.inputObjectionIds }
      : {}),
    ...validateExtra,
  });

  const extractorValid = resultVerdict.outcome === "valid";
  const semanticIssue = extractorValid
    ? applyPostSchemaIssues(
        turnType,
        candidate.promptVersion,
        resultVerdict.payload,
        deps,
        resultPath,
        input,
        { skipCitation: skipCitationCheck, skipProposalFile: skipProposalFileCheck },
      )
    : null;
  const fullyValid = extractorValid && !semanticIssue;

  if (!fullyValid) {
    if (candidate.state === "completed") {
      if (!extractorValid) {
        throw new Error(
          `Durable state inconsistency: completed turn ${candidate.turnId} has an invalid result artifact.`,
        );
      }
      return runTurn(deps, input, null);
    }

    if (candidate.attempt === "primary") {
      engine.cancelTurn(candidate.turnId);
      return runTurn(deps, input, null);
    }

    if (candidate.state === "waiting") {
      signalResultSeen(deps, {
        workflowId: candidate.workflowId,
        iterationId: candidate.iterationId,
        turnId: candidate.turnId,
        agentId: candidate.agentId,
        resultPath,
        attempt: "repair",
        resultText: resultBytesSafe,
      });
    }

    if (!extractorValid) {
      engine.applyValidation(toEngineValidationVerdict(candidate.turnId, resultVerdict));
      return { status: "failed", turnId: candidate.turnId, reason: resultVerdict.reason };
    }
    const failReason = semanticIssue!;
    engine.applyValidation(
      toEngineValidationVerdict(candidate.turnId, { outcome: "failed", reason: failReason }),
    );
    return { status: "failed", turnId: candidate.turnId, reason: failReason };
  }

  if (candidate.state === "waiting") {
    signalResultSeen(deps, {
      workflowId: candidate.workflowId,
      iterationId: candidate.iterationId,
      turnId: candidate.turnId,
      agentId: candidate.agentId,
      resultPath,
      attempt: candidate.attempt,
      resultText: resultBytesSafe,
    });
    engine.applyValidation(toEngineValidationVerdict(candidate.turnId, resultVerdict));
  } else if (candidate.state === "validating") {
    engine.applyValidation(toEngineValidationVerdict(candidate.turnId, resultVerdict));
  }

  return {
    status: "valid",
    turnId: candidate.turnId,
    role: resultVerdict.role,
    payload: resultVerdict.payload,
    resultHash: resultVerdict.resultHash,
  };
}

/** Hash proposal file bytes (SHA-256 hex). */
export function hashProposalFile(path: string): string {
  return sha256Hex(readFileSync(path));
}
