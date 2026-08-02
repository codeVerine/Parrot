import { EventSchema, eventId, type EventKind, type PlatformEvent } from "@platform/contracts";
import { hasOpenObjections, humanRuleAllows, openObjectionIds, stalemateObjectionIds, underIterationCap } from "./guards.js";
import { foldReducer } from "./fold.js";
import type { EngineEffect, FoldedState, HumanDecisionInput, ContinueAfterStalemateInput, TransitionResult, WorkflowEngineConfig, WorkflowPhase } from "./types.js";

function asEvent(value: unknown): PlatformEvent {
  return EventSchema.parse(value) as PlatformEvent & { kind: EventKind };
}

function iso(value?: string): string {
  return value ?? new Date().toISOString();
}

function eventBase(workflowId: string, occurredAt: string, extra: Partial<PlatformEvent> = {}): Pick<PlatformEvent, "eventId" | "occurredAt" | "workflowId"> & Partial<Pick<PlatformEvent, "iterationId" | "turnId" | "agentId">> {
  return {
    eventId: String(eventId()),
    occurredAt,
    workflowId,
    ...(extra.iterationId ? { iterationId: extra.iterationId } : {}),
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    ...(extra.agentId ? { agentId: extra.agentId } : {}),
  };
}

function persist(workflowId: string, state: FoldedState, config: WorkflowEngineConfig, status?: string): EngineEffect {
  const derived =
    state.phase === "escalated" ? "escalated"
      : state.phase === "approved" ? "approved"
        : state.phase === "rejected" ? "rejected"
          : status ?? "running";
  return { type: "saveWorkflowState", workflowId, status: derived, state, config };
}

export type PlanningInput =
  | { type: "plannerCompleted"; workflowId: string }
  | { type: "reviewersSpawned"; workflowId: string }
  | { type: "objectionsCollected"; workflowId: string }
  | { type: "mergeCompleted"; workflowId: string }
  | { type: "evaluateObjectionGate"; workflowId: string; nextIterationId?: string }
  | { type: "frontierReport"; workflowId: string; blocking: boolean; occurredAt?: string }
  | { type: "requestHuman"; workflowId: string }
  | { type: "humanDecision"; input: HumanDecisionInput }
  | { type: "continueAfterStalemate"; input: ContinueAfterStalemateInput }
  | { type: "blockImplementation"; workflowId: string; reason: string; occurredAt?: string }
  | { type: "setPhase"; workflowId: string; phase: WorkflowPhase };

/** Pure planning-phase transitions and guards. */
export function reducePlanning(state: FoldedState, config: WorkflowEngineConfig, input: PlanningInput): TransitionResult {
  const effects: EngineEffect[] = [];

  const advance = (phase: WorkflowPhase, nextState: FoldedState = { ...state, phase }): TransitionResult => {
    effects.push(persist(nextState.workflowId, nextState, config));
    return { accepted: true, state: nextState, effects };
  };

  switch (input.type) {
    case "setPhase":
      return advance(input.phase, { ...state, phase: input.phase, workflowId: input.workflowId || state.workflowId });
    case "plannerCompleted":
      if (state.phase !== "planner_turn") return { accepted: false, state, effects: [], reason: `illegal plannerCompleted in ${state.phase}` };
      return advance("spawn_reviewers");
    case "reviewersSpawned":
      if (state.phase !== "spawn_reviewers") return { accepted: false, state, effects: [], reason: `illegal reviewersSpawned in ${state.phase}` };
      return advance("collect_objections");
    case "objectionsCollected":
      if (state.phase !== "collect_objections") return { accepted: false, state, effects: [], reason: `illegal objectionsCollected in ${state.phase}` };
      return advance("merge_objections");
    case "mergeCompleted":
      if (state.phase !== "merge_objections") return { accepted: false, state, effects: [], reason: `illegal mergeCompleted in ${state.phase}` };
      return advance("objection_gate");
    case "evaluateObjectionGate": {
      if (state.phase !== "objection_gate" && state.phase !== "frontier_to_objections") {
        return { accepted: false, state, effects: [], reason: `illegal evaluateObjectionGate in ${state.phase}` };
      }
      const stalemateIds = stalemateObjectionIds(state);
      if (stalemateIds.length > 0) {
        const event = asEvent({
          ...eventBase(state.workflowId, iso()),
          kind: "ObjectionStalemate",
          payload: { objectionIds: stalemateIds },
        });
        const folded = foldReducer(state, event);
        effects.push({ type: "appendEvent", event });
        effects.push({
          type: "notifyEscalation",
          workflowId: state.workflowId,
          target: config.escalationNotificationTarget,
          reason: "objection_stalemate",
          openObjectionIds: openObjectionIds(folded),
        });
        effects.push(persist(state.workflowId, folded, config, "escalated"));
        return { accepted: true, state: folded, effects };
      }
      if (hasOpenObjections(state)) {
        if (!underIterationCap(state, config)) {
          const event = asEvent({
            ...eventBase(state.workflowId, iso()),
            kind: "IterationCapReached",
            payload: { cap: config.maxIterations },
          });
          const folded = foldReducer(state, event);
          effects.push({ type: "appendEvent", event });
          effects.push({
            type: "notifyEscalation",
            workflowId: state.workflowId,
            target: config.escalationNotificationTarget,
            reason: "iteration_cap",
            openObjectionIds: openObjectionIds(folded),
          });
          effects.push(persist(state.workflowId, folded, config, "escalated"));
          return { accepted: true, state: folded, effects };
        }
        const next: FoldedState = {
          ...state,
          phase: "planner_turn",
          iterationCount: state.iterationCount + (input.nextIterationId && !state.seenIterationIds.includes(input.nextIterationId) ? 1 : 0),
          seenIterationIds: input.nextIterationId && !state.seenIterationIds.includes(input.nextIterationId)
            ? [...state.seenIterationIds, input.nextIterationId]
            : state.seenIterationIds,
          frontierBlocking: false,
        };
        return advance("planner_turn", next);
      }
      return advance("iteration_cap_check", { ...state, phase: "iteration_cap_check" });
    }
    case "frontierReport": {
      if (state.phase !== "iteration_cap_check" && state.phase !== "frontier_review") {
        return { accepted: false, state, effects: [], reason: `illegal frontierReport in ${state.phase}` };
      }
      if (!underIterationCap(state, config) && hasOpenObjections(state)) {
        return { accepted: false, state, effects: [], reason: "iteration cap already binding" };
      }
      if (input.blocking) {
        return advance("frontier_to_objections", { ...state, phase: "frontier_to_objections", frontierBlocking: true });
      }
      const match = humanRuleAllows(state, config);
      if (match.action === "approve") {
        return reducePlanning({ ...state, phase: "human_decision", frontierBlocking: false }, config, {
          type: "humanDecision",
          input: { workflowId: state.workflowId, decision: "approved", comment: `auto:${match.rule?.id}` },
        });
      }
      if (match.action === "reject") {
        return reducePlanning({ ...state, phase: "human_decision", frontierBlocking: false }, config, {
          type: "humanDecision",
          input: { workflowId: state.workflowId, decision: "rejected", comment: `auto:${match.rule?.id}` },
        });
      }
      if (match.action === "escalate") {
        const next = { ...state, phase: "escalated" as const, frontierBlocking: false };
        effects.push({
          type: "notifyEscalation",
          workflowId: state.workflowId,
          target: config.escalationNotificationTarget,
          reason: "human_rule_escalate",
          openObjectionIds: openObjectionIds(next),
        });
        return advance("escalated", next);
      }
      return advance("await_human", { ...state, phase: "await_human", frontierBlocking: false });
    }
    case "requestHuman":
      if (state.phase !== "await_human") return { accepted: false, state, effects: [], reason: `illegal requestHuman in ${state.phase}` };
      return advance("human_decision");
    case "humanDecision": {
      const { input: decision } = input;
      if (state.phase !== "human_decision" && state.phase !== "await_human" && state.phase !== "escalated") {
        return { accepted: false, state, effects: [], reason: `illegal humanDecision in ${state.phase}` };
      }
      if (decision.decision === "approved") {
        if (hasOpenObjections(state) && !decision.waiveOpenObjections) {
          return { accepted: false, state, effects: [], reason: "approval with open objections requires explicit waiver" };
        }
        const approved = asEvent({
          ...eventBase(decision.workflowId, iso(decision.occurredAt)),
          kind: "HumanApproved",
          payload: { ...(decision.comment ? { comment: decision.comment } : {}) },
        });
        let folded = foldReducer(state, approved);
        effects.push({ type: "appendEvent", event: approved });
        if (!hasOpenObjections(state)) {
          const consensus = asEvent({
            ...eventBase(decision.workflowId, iso(decision.occurredAt)),
            kind: "ConsensusReached",
            payload: { objectionIds: Object.keys(state.objections) },
          });
          folded = foldReducer(folded, consensus);
          effects.push({ type: "appendEvent", event: consensus });
        }
        effects.push(persist(decision.workflowId, folded, config, "approved"));
        return { accepted: true, state: folded, effects };
      }
      const rejected = asEvent({
        ...eventBase(decision.workflowId, iso(decision.occurredAt)),
        kind: "HumanRejected",
        payload: { comment: decision.comment ?? "rejected" },
      });
      const folded = foldReducer(state, rejected);
      effects.push({ type: "appendEvent", event: rejected });
      effects.push(persist(decision.workflowId, folded, config, "rejected"));
      return { accepted: true, state: folded, effects };
    }
    case "continueAfterStalemate": {
      const { input: cont } = input;
      if (state.phase !== "escalated") {
        return { accepted: false, state, effects: [], reason: `illegal continueAfterStalemate in ${state.phase}` };
      }
      if (cont.objectionIds.length === 0) {
        return { accepted: false, state, effects: [], reason: "continueAfterStalemate requires at least one objection id" };
      }
      const previousThreshold = state.stalemateReraiseThreshold ?? 1;
      const newThreshold = previousThreshold + 1;
      const newConfig: WorkflowEngineConfig = { ...config, maxIterations: config.maxIterations + 1 };
      const event = asEvent({
        ...eventBase(cont.workflowId, iso(cont.occurredAt)),
        kind: "StalemateContinued",
        payload: {
          objectionIds: cont.objectionIds,
          previousThreshold,
          newThreshold,
          maxIterations: newConfig.maxIterations,
        },
      });
      const folded = foldReducer(state, event);
      effects.push({ type: "appendEvent", event });
      effects.push(persist(cont.workflowId, folded, newConfig, "running"));
      return { accepted: true, state: folded, effects };
    }
    case "blockImplementation": {
      const event = asEvent({
        ...eventBase(input.workflowId, iso(input.occurredAt)),
        kind: "ImplementationBlocked",
        payload: { reason: input.reason },
      });
      const folded = foldReducer(state, event);
      effects.push({ type: "appendEvent", event });
      effects.push({
        type: "notifyEscalation",
        workflowId: input.workflowId,
        target: config.escalationNotificationTarget,
        reason: input.reason,
        openObjectionIds: openObjectionIds(folded),
      });
      effects.push(persist(input.workflowId, folded, config, "escalated"));
      return { accepted: true, state: folded, effects };
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

/** Enter frontier review after a clean objection gate. */
export function enterFrontierReview(state: FoldedState, config: WorkflowEngineConfig): TransitionResult {
  if (state.phase !== "iteration_cap_check") {
    return { accepted: false, state, effects: [], reason: `illegal enterFrontierReview in ${state.phase}` };
  }
  return reducePlanning(state, config, { type: "setPhase", workflowId: state.workflowId, phase: "frontier_review" });
}
