import { join } from "node:path";
import type { RuntimeSignal } from "@platform/contracts";
import type { BuildContext, PromptBuilder, ResultExtractor, TurnType } from "@platform/llm-boundary";
import { sha256Hex, toEngineValidationVerdict } from "@platform/llm-boundary";
import type { WorkflowEngine } from "@platform/workflow-engine";
import type { AgentRunner } from "./runner.js";

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
 * Drive one turn end to end: build prompt, register with the engine, deliver to
 * the agent, validate, and run at most one bounded repair. The engine flips the
 * turn to `repair` on the first validation failure; the second failure fails it.
 */
export async function runTurn(deps: TurnDeps, input: RunTurnInput): Promise<TurnOutcome> {
  const { engine, builder, extractor, runner } = deps;
  const { turnType, workflowId, iterationId, agentId } = input;
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
    resultPath,
  });

  signalResultSeen(deps, { workflowId, iterationId, turnId, agentId, resultPath, attempt: "primary", resultText: primary.resultText });

  const primaryVerdict = extractor.validate({
    bytes: primary.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "primary" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
  });
  engine.applyValidation(toEngineValidationVerdict(turnId, primaryVerdict));

  if (primaryVerdict.outcome === "valid") {
    return { status: "valid", turnId, role: primaryVerdict.role, payload: primaryVerdict.payload, resultHash: primaryVerdict.resultHash };
  }
  if (primaryVerdict.outcome === "failed") {
    return { status: "failed", turnId, reason: primaryVerdict.reason };
  }

  // needsRepair: build the repair prompt with the original nonce and deliver once.
  const repairBuilt = builder.build({
    turnType: "repair",
    identity: { workflowId, iterationId, turnId, nonce: built.nonce },
    context: { ...input.context, resultPath, originalTurnType: turnType, repairReason: primaryVerdict.reason },
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
    resultPath,
  });

  signalResultSeen(deps, { workflowId, iterationId, turnId, agentId, resultPath, attempt: "repair", resultText: repair.resultText });

  const repairVerdict = extractor.validate({
    bytes: repair.resultText,
    turn: { workflowId, iterationId, turnId, nonce: built.nonce, turnType, attempt: "repair" },
    ...(input.inputObjectionIds ? { inputObjectionIds: input.inputObjectionIds } : {}),
  });
  engine.applyValidation(toEngineValidationVerdict(turnId, repairVerdict));

  if (repairVerdict.outcome === "valid") {
    return { status: "valid", turnId, role: repairVerdict.role, payload: repairVerdict.payload, resultHash: repairVerdict.resultHash };
  }
  return { status: "failed", turnId, reason: repairVerdict.reason };
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
