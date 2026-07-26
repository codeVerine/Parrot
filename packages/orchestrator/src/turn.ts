import { join } from "node:path";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeSignal } from "@platform/contracts";
import { ResolutionResultSchema } from "@platform/contracts";
import type { BuildContext, PromptBuilder, ResultExtractor, TurnType } from "@platform/llm-boundary";
import { sha256Hex, toEngineValidationVerdict } from "@platform/llm-boundary";
import type { WorkflowEngine } from "@platform/workflow-engine";
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
};

export type RunTurnInput = {
  turnType: TurnType;
  workflowId: string;
  iterationId: string;
  agentId: string;
  context: BuildContext;
  iterationNumber?: number;
  inputObjectionIds?: readonly string[];
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

  const built = builder.build({
    turnType,
    identity: { workflowId, iterationId, turnId },
    context: { ...input.context, resultPath },
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

  signalResultSeen(deps, { workflowId, iterationId, turnId, agentId, resultPath, attempt: "primary", resultText: primary.resultText });

  const primaryVerdict = extractor.validate({
    bytes: primary.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "primary" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
  });

  // Resolution verification: a schema-valid result may still be semantically
  // incomplete (wrong target, unresolved objections). Enforce before the engine
  // commits the turn, so the bounded-repair path activates.
  let effectivePrimaryVerdict = primaryVerdict;
  if (turnType === "resolution_verification" && primaryVerdict.outcome === "valid") {
    const semanticIssue = resolutionSemanticIssue(primaryVerdict.payload, input.context.verificationTarget?.objectionId);
    if (semanticIssue) {
      effectivePrimaryVerdict = { outcome: "needsRepair", reason: semanticIssue, diagnostics: semanticIssue };
    }
  }

  engine.applyValidation(toEngineValidationVerdict(turnId, effectivePrimaryVerdict));

  if (effectivePrimaryVerdict.outcome === "valid") {
    return { status: "valid", turnId, role: effectivePrimaryVerdict.role, payload: effectivePrimaryVerdict.payload, resultHash: effectivePrimaryVerdict.resultHash };
  }
  if (effectivePrimaryVerdict.outcome === "failed") {
    return { status: "failed", turnId, reason: effectivePrimaryVerdict.reason };
  }

  // needsRepair: build the repair prompt with the original nonce and deliver once.
  const repairBuilt = builder.build({
    turnType: "repair",
    identity: { workflowId, iterationId, turnId, nonce: built.nonce },
    context: { ...input.context, resultPath, originalTurnType: turnType, repairReason: effectivePrimaryVerdict.reason },
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

  signalResultSeen(deps, { workflowId, iterationId, turnId, agentId, resultPath, attempt: "repair", resultText: repair.resultText });

  const repairVerdict = extractor.validate({
    bytes: repair.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "repair" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
  });

  // Same semantic override for repair: schema-valid but incomplete -> failed.
  let effectiveRepairVerdict = repairVerdict;
  if (turnType === "resolution_verification" && repairVerdict.outcome === "valid") {
    const semanticIssue = resolutionSemanticIssue(repairVerdict.payload, input.context.verificationTarget?.objectionId);
    if (semanticIssue) {
      effectiveRepairVerdict = { outcome: "failed", reason: semanticIssue };
    }
  }

  engine.applyValidation(toEngineValidationVerdict(turnId, effectiveRepairVerdict));

  if (effectiveRepairVerdict.outcome === "valid") {
    return { status: "valid", turnId, role: effectiveRepairVerdict.role, payload: effectiveRepairVerdict.payload, resultHash: effectiveRepairVerdict.resultHash };
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
  const { engine, extractor, builder, runner } = deps;
  const { turnType, workflowId, iterationId, agentId } = input;

  // Validate that the candidate matches the current input.
  if (candidate.workflowId !== workflowId || candidate.iterationId !== iterationId || candidate.agentId !== agentId) {
    throw new Error(
      `Resume candidate mismatch: expected ${workflowId}/${iterationId}/${agentId}, ` +
      `got ${candidate.workflowId}/${candidate.iterationId}/${candidate.agentId}.`,
    );
  }

  // Try to read the artifact with a retry for the race window.
  const resultPath = candidate.resultPath;
  let resultBytes: string | null = null;
  let readError: NodeJS.ErrnoException | null = null;
  for (let i = 0; i < 2; i++) {
    readError = null;
    try {
      resultBytes = readFileSync(resultPath, "utf8");
      break;
    } catch (error) {
      readError = error as NodeJS.ErrnoException;
      if (readError.code !== "ENOENT") {
        // Non-ENOENT errors (permissions, etc.) are final.
        break;
      }
      // Wait briefly for a late write before the second attempt.
      if (i === 0) await delay(250);
    }
  }

  if (resultBytes === null && readError) {
    // Only ENOENT triggers the cancellation path; other errors propagate.
    if (readError.code !== "ENOENT") throw readError;

    // Missing file for waiting/validating -> cancel old turn, create fresh one.
    if (candidate.state === "waiting" || candidate.state === "validating") {
      engine.cancelTurn(candidate.turnId);
      return runTurn(deps, input, null);
    }
    // Completed-state corruption is a hard error.
    throw new Error(
      `Durable state inconsistency: completed turn ${candidate.turnId} result file missing at ${resultPath}.`,
    );
  }

  // Validate the result bytes.
  const resultBytesSafe = resultBytes!;
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
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
  });

  // Compute semantic validity for resolution_verification BEFORE any engine
  // applyValidation, so waiting/validating candidates do not get committed as
  // completed with an incomplete resolution.
  const extractorValid = resultVerdict.outcome === "valid";
  const semanticIssue =
    extractorValid && input.turnType === "resolution_verification"
      ? resolutionSemanticIssue(resultVerdict.payload, input.context.verificationTarget?.objectionId)
      : null;
  const fullyValid = extractorValid && !semanticIssue;

  if (!fullyValid) {
    if (candidate.state === "completed") {
      if (!extractorValid) {
        throw new Error(
          `Durable state inconsistency: completed turn ${candidate.turnId} has an invalid result artifact.`,
        );
      }
      // Schema-valid but semantically incomplete completed turn: bypass so a
      // fresh verification can run instead of looping on the stale artifact.
      return runTurn(deps, input, null);
    }

    if (candidate.attempt === "primary") {
      // The agent that produced the invalid result is gone on resume. Rather
      // than sending a repair prompt to a fresh agent with no context, cancel
      // the old turn and create a fresh primary turn with a new identity.
      engine.cancelTurn(candidate.turnId);
      return runTurn(deps, input, null);
    }

    // Repair attempt: apply failure and return.
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
    engine.applyValidation(toEngineValidationVerdict(candidate.turnId, { outcome: "failed", reason: semanticIssue! }));
    return { status: "failed", turnId: candidate.turnId, reason: semanticIssue! };
  }

  // Fully valid (schema + semantics). Commit and return.
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
  // completed: return the validated outcome directly.

  return {
    status: "valid",
    turnId: candidate.turnId,
    role: resultVerdict.role,
    payload: resultVerdict.payload,
    resultHash: resultVerdict.resultHash,
  };
}
