import {
  EventSchema,
  eventId,
  parseToon,
  type EventKind,
  type PlatformEvent,
  type RuntimeSignal,
} from "@platform/contracts";
import {
  PersistenceStore,
  type TurnInput as PersistedTurnInput,
  type TurnState,
} from "@platform/persistence";
import { parseHumanAutoRules, withWorkflowConfig } from "./config.js";
import { foldReducer, hasSeenUsageMessage, initialFoldedState } from "./fold.js";
import { openObjectionIds, underBudgetCap } from "./guards.js";
import { enterFrontierReview, reducePlanning } from "./planning.js";
import { reduceSignal } from "./signals.js";
import { reduceTurn } from "./turn.js";
import type {
  EngineEffect,
  EscalationNotification,
  FoldedState,
  HumanDecisionInput,
  NotificationSink,
  ObjectionInput,
  TurnRecord,
  UsageFact,
  ValidationVerdict,
  WorkflowEngineConfig,
} from "./types.js";

function asEvent(value: unknown): PlatformEvent {
  return EventSchema.parse(value) as PlatformEvent & { kind: EventKind };
}

/** Minimal AgentRuntime surface the engine may invoke. */
export type EngineRuntime = {
  send?: (agentId: string, turn: {
    turnId: string;
    workflowId: string;
    iterationId: string;
    promptPath: string;
    promptHash: string;
    resultPath: string;
    schemaId: string;
    nonce: string;
    deadline: Date;
    attempt?: "primary" | "repair";
  }) => Promise<unknown>;
  interrupt?: (agentId: string) => Promise<void>;
  stop?: (agentId: string) => Promise<void>;
  resync?: () => Promise<unknown>;
};

export type WorkflowEngineOptions = {
  store: PersistenceStore;
  runtime?: EngineRuntime;
  /** Required for human-in-loop escalations (budget/iteration/fault/blocked). */
  notifications: NotificationSink;
  config?: Partial<WorkflowEngineConfig>;
  now?: () => string;
};

/** Drop reconstructible dedup sets from durable workflow.state_toon (W6). */
export function toPersistedFoldedState(state: FoldedState): FoldedState {
  return {
    ...state,
    seenUsageMessageIds: [],
    seenIterationIds: [],
  };
}

export function repairPromptPath(promptPath: string): string {
  if (!promptPath.endsWith("prompt.md")) {
    throw new Error(`Cannot derive repair prompt from path that does not end with prompt.md: ${promptPath}`);
  }
  return promptPath.replace(/prompt\.md$/, "repair-prompt.md");
}

export class WorkflowEngine {
  readonly store: PersistenceStore;
  readonly config: WorkflowEngineConfig;
  private readonly runtime?: EngineRuntime;
  private readonly notifications: NotificationSink;
  private readonly now: () => string;
  private readonly seenCorrelationKeys = new Map<string, Set<string>>();
  private readonly states = new Map<string, FoldedState>();
  private runtimeQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkflowEngineOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.notifications = options.notifications;
    this.config = withWorkflowConfig(options.config);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Await pending runtime/notification side effects (send, interrupt, notify). */
  async flush(): Promise<void> {
    await this.runtimeQueue;
  }

  /** Rebuild folded state from the full event log (paginated; never truncates). */
  fold(workflowId: string): FoldedState {
    let state = initialFoldedState(workflowId);
    for (const entry of this.store.iterateEvents({ workflowId })) {
      state = foldReducer(state, entry.event);
    }
    this.states.set(workflowId, state);
    return state;
  }

  getState(workflowId: string): FoldedState {
    return this.states.get(workflowId) ?? this.fold(workflowId);
  }

  startWorkflow(input: {
    workflowId: string;
    workspaceId: string;
    task: string;
    config?: Partial<WorkflowEngineConfig>;
  }): FoldedState {
    const config = withWorkflowConfig({ ...this.config, ...input.config });
    const state = initialFoldedState(input.workflowId);
    this.store.transaction((tx) => {
      tx.saveWorkflow({
        workflowId: input.workflowId,
        workspaceId: input.workspaceId,
        status: "running",
        task: input.task,
        config,
        state: toPersistedFoldedState(state),
      });
    });
    this.states.set(input.workflowId, state);
    return state;
  }

  startTurn(turn: Omit<TurnRecord, "state"> & { state?: TurnState; iterationNumber?: number }): TurnRecord {
    if (this.store.getTurn(turn.turnId)) {
      throw new Error(`Turn ${turn.turnId} already exists.`);
    }
    const record: TurnRecord = { ...turn, state: "created", attempt: turn.attempt ?? "primary" };
    this.store.transaction((tx) => {
      tx.saveIteration({
        iterationId: turn.iterationId,
        workflowId: turn.workflowId,
        iterationNumber: turn.iterationNumber ?? 1,
        status: "running",
      });
    });
    const folded = this.getState(turn.workflowId);
    const result = reduceTurn(folded, { type: "start", turn: record });
    this.commit(turn.workflowId, result.state, result.effects);
    return { ...record, state: "created" };
  }

  markDelivered(turnId: string): void {
    const turn = this.requireTurn(turnId);
    const folded = this.getState(turn.workflowId);
    const result = reduceTurn(folded, { type: "delivered", turn });
    if (!result.accepted) throw new Error(result.reason ?? "markDelivered rejected");
    this.commit(turn.workflowId, result.state, result.effects);
  }

  handleSignal(signal: RuntimeSignal): { accepted: boolean; reason?: string } {
    const turn = signal.turnId ? this.loadTurn(signal.turnId) : null;
    const workflowId = signal.workflowId ?? turn?.workflowId;
    if (!workflowId) {
      // Still persist the orphaned signal for audit.
      this.store.recordSignal(signal);
      return { accepted: false, reason: "signal missing workflowId" };
    }

    const folded = this.getState(workflowId);
    const seen = this.seenCorrelationKeys.get(workflowId) ?? new Set<string>();
    const result = reduceSignal(folded, turn, signal, seen);

    if (result.correlationKey) seen.add(result.correlationKey);
    this.seenCorrelationKeys.set(workflowId, seen);

    if (result.workflowEscalate) {
      const escalated = { ...result.state, phase: "escalated" as const };
      this.commit(workflowId, escalated, [
        ...result.effects,
        {
          type: "notifyEscalation",
          workflowId,
          target: this.configFor(workflowId).escalationNotificationTarget,
          reason: result.reason ?? "fault",
          openObjectionIds: openObjectionIds(escalated),
        },
        {
          type: "saveWorkflowState",
          workflowId,
          status: "escalated",
          state: escalated,
          config: this.configFor(workflowId),
        },
      ], { signal });
      return { accepted: true, reason: result.reason };
    }

    if (result.degrade) {
      this.commit(workflowId, result.state, [{
        type: "saveWorkflowState",
        workflowId,
        status: "running",
        state: result.state,
        config: this.configFor(workflowId),
      }], { signal });
      return { accepted: true, reason: "degraded" };
    }

    if (!result.accepted && result.effects.length === 0) {
      this.store.recordSignal(signal);
      return { accepted: false, reason: result.reason };
    }

    this.commit(workflowId, result.state, result.effects, { signal });
    return { accepted: result.accepted, reason: result.reason };
  }

  applyValidation(verdict: ValidationVerdict): void {
    const turn = this.requireTurn(verdict.turnId);
    const folded = this.getState(turn.workflowId);
    const result = reduceTurn(folded, { type: "validation", turn, verdict, occurredAt: this.now() });
    if (!result.accepted) throw new Error(result.reason ?? "validation rejected");
    this.commit(turn.workflowId, result.state, result.effects);
  }

  cancelTurn(turnId: string): void {
    const turn = this.requireTurn(turnId);
    const folded = this.getState(turn.workflowId);
    const result = reduceTurn(folded, { type: "cancel", turn, occurredAt: this.now() });
    if (!result.accepted) throw new Error(result.reason ?? "cancel rejected");
    this.commit(turn.workflowId, result.state, result.effects);
  }

  raiseObjection(input: ObjectionInput): void {
    const event = asEvent({
      eventId: String(eventId()),
      occurredAt: input.occurredAt ?? this.now(),
      workflowId: input.workflowId,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      kind: "ObjectionRaised",
      payload: { objectionId: input.objectionId, severity: input.severity },
    });
    const folded = foldReducer(this.getState(input.workflowId), event);
    this.commit(input.workflowId, folded, [
      { type: "appendEvent", event },
      {
        type: "saveWorkflowState",
        workflowId: input.workflowId,
        status: "running",
        state: folded,
        config: this.configFor(input.workflowId),
      },
    ]);
  }

  resolveObjection(input: { workflowId: string; objectionId: string; resolution: string; occurredAt?: string }): void {
    const event = asEvent({
      eventId: String(eventId()),
      occurredAt: input.occurredAt ?? this.now(),
      workflowId: input.workflowId,
      kind: "ObjectionResolved",
      payload: { objectionId: input.objectionId, resolution: input.resolution },
    });
    const folded = foldReducer(this.getState(input.workflowId), event);
    this.commit(input.workflowId, folded, [
      { type: "appendEvent", event },
      {
        type: "saveWorkflowState",
        workflowId: input.workflowId,
        status: "running",
        state: folded,
        config: this.configFor(input.workflowId),
      },
    ]);
  }

  submitUsage(fact: UsageFact): { recorded: boolean; budgetCapReached: boolean } {
    const config = this.configFor(fact.workflowId);
    let state = this.getState(fact.workflowId);
    if (hasSeenUsageMessage(state, fact.messageId)) {
      return { recorded: false, budgetCapReached: state.budgetCapReached };
    }

    const usageEvent = asEvent({
      eventId: String(eventId()),
      occurredAt: fact.occurredAt ?? this.now(),
      workflowId: fact.workflowId,
      ...(fact.iterationId ? { iterationId: fact.iterationId } : {}),
      ...(fact.turnId ? { turnId: fact.turnId } : {}),
      ...(fact.agentId ? { agentId: fact.agentId } : {}),
      kind: "UsageRecorded",
      payload: {
        messageId: fact.messageId,
        inputTokens: fact.inputTokens,
        outputTokens: fact.outputTokens,
        cost: fact.cost,
        ...(fact.provider ? { provider: fact.provider } : {}),
        ...(fact.cacheTokens !== undefined ? { cacheTokens: fact.cacheTokens } : {}),
        ...(fact.pricingVersion ? { pricingVersion: fact.pricingVersion } : {}),
      },
    });

    state = foldReducer(state, usageEvent);
    const effects: EngineEffect[] = [{ type: "appendEvent", event: usageEvent }];

    let budgetCapReached = false;
    if (!underBudgetCap(state, config) && !state.budgetCapReached && config.budgetCap !== null) {
      const capEvent = asEvent({
        eventId: String(eventId()),
        occurredAt: fact.occurredAt ?? this.now(),
        workflowId: fact.workflowId,
        kind: "BudgetCapReached",
        payload: { cap: config.budgetCap },
      });
      state = foldReducer(state, capEvent);
      effects.push({ type: "appendEvent", event: capEvent });
      effects.push({
        type: "notifyEscalation",
        workflowId: fact.workflowId,
        target: config.escalationNotificationTarget,
        reason: "budget_cap",
        openObjectionIds: openObjectionIds(state),
      });
      budgetCapReached = true;
    }

    effects.push({
      type: "saveWorkflowState",
      workflowId: fact.workflowId,
      status: state.phase === "escalated" ? "escalated" : "running",
      state,
      config,
    });
    this.commit(fact.workflowId, state, effects);
    return { recorded: true, budgetCapReached: budgetCapReached || state.budgetCapReached };
  }

  advancePlanning(
    workflowId: string,
    step:
      | "plannerCompleted"
      | "reviewersSpawned"
      | "objectionsCollected"
      | "mergeCompleted"
      | "evaluateObjectionGate"
      | "enterFrontier"
      | "requestHuman",
    options: { nextIterationId?: string; frontierBlocking?: boolean } = {},
  ): FoldedState {
    const config = this.configFor(workflowId);
    const state = this.getState(workflowId);

    if (step === "enterFrontier") {
      const entered = enterFrontierReview(state, config);
      if (!entered.accepted) throw new Error(entered.reason ?? "enterFrontier rejected");
      this.commit(workflowId, entered.state, entered.effects);
      if (options.frontierBlocking === undefined) return entered.state;
      const report = reducePlanning(entered.state, config, {
        type: "frontierReport",
        workflowId,
        blocking: options.frontierBlocking,
      });
      if (!report.accepted) throw new Error(report.reason ?? "frontierReport rejected");
      this.commit(workflowId, report.state, report.effects);
      return report.state;
    }

    const result = step === "evaluateObjectionGate"
      ? reducePlanning(state, config, {
        type: "evaluateObjectionGate",
        workflowId,
        nextIterationId: options.nextIterationId,
      })
      : reducePlanning(state, config, { type: step, workflowId });

    if (!result.accepted) throw new Error(result.reason ?? `planning step ${step} rejected`);
    this.commit(workflowId, result.state, result.effects);
    return result.state;
  }

  reportFrontier(workflowId: string, blocking: boolean): FoldedState {
    const config = this.configFor(workflowId);
    let state = this.getState(workflowId);
    if (state.phase === "iteration_cap_check") {
      const entered = enterFrontierReview(state, config);
      if (!entered.accepted) throw new Error(entered.reason);
      this.commit(workflowId, entered.state, entered.effects);
      state = entered.state;
    }
    const result = reducePlanning(state, config, { type: "frontierReport", workflowId, blocking });
    if (!result.accepted) throw new Error(result.reason ?? "frontierReport rejected");
    this.commit(workflowId, result.state, result.effects);
    return result.state;
  }

  /**
   * Record a blocked implementation result. Emits the existing ImplementationBlocked
   * event (folds to `escalated`) and notifies the human; never a silent stop.
   */
  reportImplementationBlocked(input: {
    workflowId: string;
    reason: string;
    iterationId?: string;
    turnId?: string;
    agentId?: string;
    occurredAt?: string;
  }): FoldedState {
    const event = asEvent({
      eventId: String(eventId()),
      occurredAt: input.occurredAt ?? this.now(),
      workflowId: input.workflowId,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      kind: "ImplementationBlocked",
      payload: { reason: input.reason },
    });
    const state = foldReducer(this.getState(input.workflowId), event);
    const config = this.configFor(input.workflowId);
    this.commit(input.workflowId, state, [
      { type: "appendEvent", event },
      {
        type: "notifyEscalation",
        workflowId: input.workflowId,
        target: config.escalationNotificationTarget,
        reason: "implementation_blocked",
        openObjectionIds: openObjectionIds(state),
      },
      { type: "saveWorkflowState", workflowId: input.workflowId, status: "escalated", state, config },
    ]);
    return state;
  }

  humanDecision(input: HumanDecisionInput): FoldedState {
    const config = this.configFor(input.workflowId);
    const state = this.getState(input.workflowId);
    const result = reducePlanning(state, config, { type: "humanDecision", input });
    if (!result.accepted) throw new Error(result.reason ?? "humanDecision rejected");
    this.commit(input.workflowId, result.state, result.effects);
    return result.state;
  }

  recover(workflowId: string): {
    state: FoldedState;
    pendingDeadlines: ReturnType<PersistenceStore["pendingDeadlines"]>;
  } {
    const snapshot = this.store.recover();
    const state = this.fold(workflowId);
    return {
      state,
      pendingDeadlines: snapshot.pendingDeadlines.filter((item) => this.loadTurn(item.turnId)?.workflowId === workflowId),
    };
  }

  /**
   * Prime the in-memory folded state from the durable workflow snapshot so an
   * interrupted workflow resumes at the exact planning phase it stopped at. The event
   * log alone cannot do this: fine-grained planning transitions (planner_turn ->
   * spawn_reviewers -> ... -> objection_gate) are persisted only in the workflow
   * `state_toon` snapshot, never as events, so {@link fold} would collapse them back to
   * `planner_turn`. The stripped dedup set `seenIterationIds` is rebuilt from the
   * distinct iteration ids in the turn log.
   */
  rehydrateFromSnapshot(workflowId: string): FoldedState {
    const row = this.store.getWorkflow(workflowId);
    if (!row) throw new Error(`Cannot resume unknown workflow ${workflowId}.`);
    let snapshot: unknown;
    try {
      snapshot = parseToon(String(row.state_toon ?? ""));
    } catch (error) {
      throw new Error(
        `Workflow ${workflowId} has malformed state_toon; cannot resume. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error(`Workflow ${workflowId} has non-object state_toon; cannot resume.`);
    }
    const seenIterationIds = [
      ...new Set(this.store.listTurns(workflowId).map((turn) => String(turn.iteration_id)).filter(Boolean)),
    ];
    const state: FoldedState = {
      ...initialFoldedState(workflowId),
      ...(snapshot as Partial<FoldedState>),
      workflowId,
      seenIterationIds,
    };
    this.states.set(workflowId, state);
    return state;
  }

  private commit(
    workflowId: string,
    state: FoldedState,
    effects: EngineEffect[],
    options: { signal?: RuntimeSignal } = {},
  ): void {
    this.states.set(workflowId, state);
    const runtimeEffects: EngineEffect[] = [];
    const workflow = this.loadWorkflowRow(workflowId);

    this.store.transaction((tx) => {
      if (options.signal) tx.recordSignal(options.signal);
      for (const effect of effects) {
        switch (effect.type) {
          case "saveTurn": {
            const turn: PersistedTurnInput = {
              turnId: effect.turn.turnId,
              workflowId: effect.turn.workflowId,
              iterationId: effect.turn.iterationId,
              agentId: effect.turn.agentId,
              state: effect.turn.state,
              attempt: effect.turn.attempt,
              deadlineAt: effect.turn.deadlineAt,
              promptPath: effect.turn.promptPath,
              promptHash: effect.turn.promptHash,
              nonce: effect.turn.nonce,
              promptVersion: effect.turn.promptVersion,
              resultPath: effect.turn.resultPath,
            };
            tx.saveTurn(turn);
            break;
          }
          case "appendEvent":
            tx.appendEvent(EventSchema.parse(effect.event) as PlatformEvent);
            break;
          case "saveArtifact":
            tx.saveArtifact(effect.artifact);
            break;
          case "saveWorkflowState":
            tx.saveWorkflow({
              workflowId: effect.workflowId,
              workspaceId: workflow?.workspaceId ?? "workspace",
              status: effect.status,
              task: workflow?.task ?? "",
              config: effect.config,
              state: toPersistedFoldedState(effect.state),
            });
            break;
          case "runtimeSendRepair":
          case "runtimeInterrupt":
          case "runtimeStop":
          case "notifyEscalation":
            runtimeEffects.push(effect);
            break;
          default: {
            const _exhaustive: never = effect;
            void _exhaustive;
          }
        }
      }
    });

    this.enqueueRuntimeEffects(runtimeEffects);
  }

  private enqueueRuntimeEffects(effects: EngineEffect[]): void {
    if (effects.length === 0) return;
    this.runtimeQueue = this.runtimeQueue
      .then(() => this.applyRuntimeEffects(effects))
      .catch((error) => {
        // Last-resort: never leave an unhandled rejection on the process.
        console.error("[workflow-engine] runtime effect queue failure:", error);
      });
  }

  private async applyRuntimeEffects(effects: EngineEffect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.type === "notifyEscalation") {
        const notification: EscalationNotification = {
          workflowId: effect.workflowId,
          target: effect.target,
          reason: effect.reason,
          openObjectionIds: effect.openObjectionIds,
        };
        await this.notifications.notifyEscalation(notification);
        continue;
      }

      if (effect.type === "runtimeSendRepair") {
        if (!this.runtime?.send) {
          // No runtime wired (pure unit tests): leave turn waiting for a later result signal.
          continue;
        }
        try {
          const promptPath = repairPromptPath(effect.turn.promptPath);
          const deadline = effect.turn.deadlineAt
            ? new Date(effect.turn.deadlineAt)
            : new Date(Date.now() + this.configFor(effect.turn.workflowId).defaultRepairDeadlineMs);
          await this.runtime.send(effect.agentId, {
            turnId: effect.turn.turnId as never,
            workflowId: effect.turn.workflowId,
            iterationId: effect.turn.iterationId,
            promptPath,
            promptHash: effect.turn.promptHash,
            resultPath: effect.turn.resultPath,
            schemaId: effect.turn.promptVersion,
            nonce: effect.turn.nonce,
            deadline,
            attempt: "repair",
          });
        } catch (error) {
          this.failTurnAfterRepairDelivery(
            effect.turn,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        continue;
      }

      if (effect.type === "runtimeInterrupt" && this.runtime?.interrupt) {
        try {
          await this.runtime.interrupt(effect.agentId);
        } catch (error) {
          console.error("[workflow-engine] interrupt failed:", error);
        }
      }
      if (effect.type === "runtimeStop" && this.runtime?.stop) {
        try {
          await this.runtime.stop(effect.agentId);
        } catch (error) {
          console.error("[workflow-engine] stop failed:", error);
        }
      }
    }
  }

  /** Repair delivery failed after turn was persisted as waiting — record TurnFailed. */
  private failTurnAfterRepairDelivery(turn: TurnRecord, error: Error): void {
    const current = this.loadTurn(turn.turnId) ?? turn;
    const folded = this.getState(current.workflowId);
    const result = reduceTurn(folded, {
      type: "faultFailed",
      turn: current,
      reason: `repair_delivery_failed:${error.message}`,
      occurredAt: this.now(),
    });
    if (!result.accepted) {
      // Turn may already be terminal; still surface the error.
      console.error("[workflow-engine] repair delivery failed and turn could not be failed:", error);
      return;
    }
    this.commit(current.workflowId, result.state, result.effects);
  }

  private configFor(workflowId: string): WorkflowEngineConfig {
    const row = this.store.getWorkflow(workflowId);
    if (!row) return this.config;
    let parsed: unknown;
    try {
      parsed = parseToon(String(row.config_toon ?? ""));
    } catch (error) {
      throw new Error(
        `Workflow ${workflowId} has malformed config_toon; refusing to widen guardrails. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Workflow ${workflowId} has non-object config_toon; refusing to widen guardrails.`);
    }
    const config = parsed as Partial<WorkflowEngineConfig>;
    return withWorkflowConfig({
      ...this.config,
      ...config,
      humanAutoRules: parseHumanAutoRules(config.humanAutoRules),
    });
  }

  private loadWorkflowRow(workflowId: string): { workspaceId: string; task: string } | null {
    const row = this.store.getWorkflow(workflowId);
    if (!row) return null;
    return {
      workspaceId: String(row.workspace_id ?? "workspace"),
      task: String(row.task ?? ""),
    };
  }

  private loadTurn(turnId: string): TurnRecord | null {
    const row = this.store.getTurn(turnId);
    if (!row) return null;
    return {
      turnId: String(row.turn_id),
      workflowId: String(row.workflow_id),
      iterationId: String(row.iteration_id),
      agentId: row.agent_id == null ? null : String(row.agent_id),
      state: String(row.state) as TurnState,
      attempt: String(row.attempt) as "primary" | "repair",
      deadlineAt: row.deadline_at == null ? null : String(row.deadline_at),
      promptPath: String(row.prompt_path),
      promptHash: String(row.prompt_hash),
      nonce: String(row.nonce),
      promptVersion: String(row.prompt_version),
      resultPath: String(row.result_path),
    };
  }

  private requireTurn(turnId: string): TurnRecord {
    const turn = this.loadTurn(turnId);
    if (!turn) throw new Error(`Unknown turn: ${turnId}`);
    return turn;
  }
}
