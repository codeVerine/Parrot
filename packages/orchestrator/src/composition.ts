import { randomUUID } from "node:crypto";
import type { PersistenceStore } from "@platform/persistence";
import {
  PromptBuilder,
  ResultExtractor,
  withLlmBoundaryConfig,
  type LlmBoundaryConfig,
} from "@platform/llm-boundary";
import { WorkflowEngine, type FoldedState, type WorkflowEngineConfig } from "@platform/workflow-engine";
import {
  adaptEscalationSink,
  createNotificationSink,
  postHumanDecision,
  withHumanLoopConfig,
  type HumanLoopConfig,
  type HumanNotificationSink,
  type PostDecisionInput,
} from "@platform/human-loop";
import {
  runImplementation,
  runVerification,
  type ImplementationInput,
  type ImplementationOutcome,
  type VerificationInput,
} from "./implementation.js";
import type { AgentRunner } from "./runner.js";
import { buildResumeSeed, ResumeTurnRegistry, type ResumeSeed } from "./resume.js";
import { runTurn, type RunTurnInput, type TurnDeps, type TurnOutcome } from "./turn.js";
import { ResolutionResultSchema } from "@platform/contracts";

export type CompositionOptions = {
  store: PersistenceStore;
  runner: AgentRunner;
  /** Override the human notification sink (tests inject a memory sink). */
  humanSink?: HumanNotificationSink;
  engineConfig?: Partial<WorkflowEngineConfig>;
  boundaryConfig?: Partial<LlmBoundaryConfig>;
  humanLoopConfig?: Partial<HumanLoopConfig>;
  runsRoot?: string;
  deadlineMs?: number;
  /** Write prompt files to disk. Tests set false to stay in memory. */
  writePrompts?: boolean;
  now?: () => string;
  newId?: () => string;
  nonceFactory?: () => string;
};

export type Composition = {
  engine: WorkflowEngine;
  store: PersistenceStore;
  humanSink: HumanNotificationSink;
  /** Resolved human-loop config (with defaults). The loop uses the configured
   * dashboard base for the escalation notifications it re-emits after a
   * suppressed engine notify, so the deep link matches what the engine
   * adapter would have produced. */
  humanLoopConfig: HumanLoopConfig;
  startWorkflow(input: {
    workflowId: string;
    workspaceId: string;
    task: string;
    config?: Partial<WorkflowEngineConfig>;
  }): FoldedState;
  /** Recover an interrupted workflow's folded state and rebuild the loop's scratch. */
  resumeWorkflow(workflowId: string): ResumeSeed;
  /** The resume turn registry for the current resume session (null for fresh runs). */
  resumeRegistry: ResumeTurnRegistry | null;
  runTurn(input: RunTurnInput): Promise<TurnOutcome>;
  runImplementation(input: ImplementationInput): Promise<ImplementationOutcome>;
  runVerification(input: VerificationInput): Promise<TurnOutcome>;
  humanDecision(decision: PostDecisionInput): { phase: string };
  flush(): Promise<void>;
};

function iterationNumberFor(
  store: PersistenceStore,
  workflowId: string,
  iterationId: string,
): number {
  const rows = store.readRows("iterations");
  const existing = rows.find(
    (row) =>
      String(row.workflow_id) === workflowId &&
      String(row.iteration_id) === iterationId,
  );
  if (existing) return Number(existing.iteration_number);

  const highest = rows
    .filter((row) => String(row.workflow_id) === workflowId)
    .reduce(
      (max, row) => Math.max(max, Number(row.iteration_number) || 0),
      0,
    );
  return highest + 1;
}

/** Wire the @platform stack into one runnable MVP composition. Wiring only. */
export function createComposition(options: CompositionOptions): Composition {
  const humanLoopConfig = withHumanLoopConfig(options.humanLoopConfig);
  const humanSink = options.humanSink ?? createNotificationSink(humanLoopConfig);
  const notifications = adaptEscalationSink(humanSink, humanLoopConfig);

  const engine = new WorkflowEngine({
    store: options.store,
    notifications,
    ...(options.engineConfig ? { config: options.engineConfig } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const boundaryConfig = withLlmBoundaryConfig(options.boundaryConfig);
  const runsRoot = options.runsRoot ?? "runs";
  const builder = new PromptBuilder({
    config: boundaryConfig,
    runsRoot,
    ...(options.nonceFactory ? { nonceFactory: options.nonceFactory } : {}),
  });
  const extractor = new ResultExtractor({ config: boundaryConfig });

  const deps: TurnDeps = {
    engine,
    builder,
    extractor,
    runner: options.runner,
    runsRoot,
    deadlineMs: options.deadlineMs ?? 15 * 60 * 1000,
    writePrompts: options.writePrompts ?? true,
    newId: options.newId ?? (() => randomUUID()),
    nowIso: options.now ?? (() => new Date().toISOString()),
  };

  // Mutable resume registry - populated by resumeWorkflow(), consumed by runTurn().
  let resumeRegistry: ResumeTurnRegistry | null = null;

  return {
    engine,
    store: options.store,
    humanSink,
    humanLoopConfig,
    get resumeRegistry(): ResumeTurnRegistry | null { return resumeRegistry; },
    startWorkflow: (input) => engine.startWorkflow(input),
    resumeWorkflow: (workflowId) => {
      const seed = buildResumeSeed(engine, options.store, workflowId);
      resumeRegistry = new ResumeTurnRegistry(options.store, workflowId);
      return seed;
    },
    runTurn: (input) => runTurn(deps, input, resumeRegistry),
    runImplementation: async (input) => {
      const result = await runImplementation(
        deps,
        {
          ...input,
          iterationNumber:
            input.iterationNumber ??
            iterationNumberFor(options.store, input.workflowId, input.iterationId),
        },
        resumeRegistry,
      );
      if (result.status === "completed") {
        options.store.updatePostReviewStage(input.workflowId, "verification_pending");
      }
      return result;
    },
    runVerification: async (input) => {
      const result = await runVerification(
        deps,
        {
          ...input,
          iterationNumber:
            input.iterationNumber ??
            iterationNumberFor(options.store, input.workflowId, input.iterationId),
        },
        resumeRegistry,
      );
      if (result.status === "valid") {
        const parsed = ResolutionResultSchema.safeParse(result.payload);
        if (parsed.success && parsed.data.verified.includes(input.targetTurnId) && parsed.data.unresolved.length === 0) {
          options.store.updatePostReviewStage(input.workflowId, "complete");
        }
      }
      return result;
    },
    humanDecision: (decision) => postHumanDecision({ engine, store: options.store, decision }),
    flush: () => engine.flush(),
  };
}
