import type { EventKind, PlatformEvent } from "@platform/contracts";
import type { FoldedObjection, FoldedState, WorkflowPhase } from "./types.js";

export function initialFoldedState(workflowId: string): FoldedState {
  return {
    workflowId,
    phase: "planner_turn",
    iterationCount: 0,
    seenIterationIds: [],
    spendTotal: 0,
    seenUsageMessageIds: [],
    objections: {},
    frontierBlocking: false,
    consensusReached: false,
    humanDecision: null,
    degradedMode: false,
    orphanLinks: [],
    budgetCapReached: false,
    iterationCapReached: false,
  };
}

type Mutable = {
  -readonly [K in keyof FoldedState]: FoldedState[K] extends readonly (infer E)[]
    ? E[]
    : FoldedState[K] extends Readonly<Record<string, FoldedObjection>>
      ? Record<string, FoldedObjection>
      : FoldedState[K];
};

function clone(state: FoldedState): Mutable {
  return {
    ...state,
    seenIterationIds: [...state.seenIterationIds],
    seenUsageMessageIds: [...state.seenUsageMessageIds],
    objections: { ...state.objections },
    orphanLinks: [...state.orphanLinks],
  };
}

function trackIterationId(state: Mutable, iterationId: string | undefined): void {
  if (!iterationId || state.seenIterationIds.includes(iterationId)) return;
  state.seenIterationIds.push(iterationId);
  state.iterationCount = state.seenIterationIds.length;
}

function setPhase(state: Mutable, phase: WorkflowPhase): void {
  state.phase = phase;
}

/**
 * Deterministic fold reducer. Live path and replay share this function.
 * Library-independent seam (XState or equivalent can wrap it).
 */
export function foldReducer(state: FoldedState, event: PlatformEvent): FoldedState {
  const next = clone(state);
  if (event.workflowId) next.workflowId = event.workflowId;
  trackIterationId(next, event.iterationId);
  const kind = event.kind as EventKind;

  switch (kind) {
    case "UsageRecorded": {
      if (event.kind !== "UsageRecorded") return next;
      const messageId = event.payload.messageId;
      if (next.seenUsageMessageIds.includes(messageId)) return next;
      next.seenUsageMessageIds.push(messageId);
      next.spendTotal += event.payload.cost;
      return next;
    }
    case "ObjectionRaised": {
      if (event.kind !== "ObjectionRaised") return next;
      const existing = next.objections[event.payload.objectionId];
      next.objections[event.payload.objectionId] = {
        objectionId: event.payload.objectionId,
        severity: event.payload.severity,
        status: "open",
        reraiseCount: existing?.status === "resolved" ? existing.reraiseCount + 1 : existing?.reraiseCount ?? 0,
      };
      return next;
    }
    case "ObjectionResolved": {
      if (event.kind !== "ObjectionResolved") return next;
      const existing = next.objections[event.payload.objectionId];
      if (existing) {
        next.objections[event.payload.objectionId] = { ...existing, status: "resolved" };
      }
      return next;
    }
    case "BudgetCapReached": {
      next.budgetCapReached = true;
      setPhase(next, "escalated");
      return next;
    }
    case "IterationCapReached": {
      if (event.kind !== "IterationCapReached") return next;
      next.iterationCapReached = true;
      next.iterationCount = Math.max(next.iterationCount, event.payload.cap);
      setPhase(next, "escalated");
      return next;
    }
    case "OrphanResultSeen": {
      if (event.kind !== "OrphanResultSeen") return next;
      if (event.turnId) {
        const link = {
          turnId: event.turnId,
          artifactPath: event.payload.artifactPath,
          contentHash: event.payload.contentHash,
        };
        if (!next.orphanLinks.some((item) => item.turnId === link.turnId && item.contentHash === link.contentHash)) {
          next.orphanLinks.push(link);
        }
      }
      return next;
    }
    case "ConsensusReached": {
      next.consensusReached = true;
      return next;
    }
    case "HumanApproved": {
      next.humanDecision = "approved";
      setPhase(next, "approved");
      for (const objection of Object.values(next.objections)) {
        if (objection.status === "open") {
          next.objections[objection.objectionId] = { ...objection, status: "waived" };
        }
      }
      return next;
    }
    case "HumanRejected": {
      next.humanDecision = "rejected";
      setPhase(next, "rejected");
      return next;
    }
    case "ImplementationBlocked": {
      setPhase(next, "escalated");
      return next;
    }
    case "ObjectionStalemate": {
      setPhase(next, "escalated");
      return next;
    }
    case "GuardrailConflict": {
      setPhase(next, "escalated");
      return next;
    }
    case "PlanChurnDetected": {
      setPhase(next, "escalated");
      return next;
    }
    case "TurnCompleted":
    case "TurnFailed":
    case "AgentTimedOut":
    case "VerificationCompleted":
      return next;
    default:
      return next;
  }
}

export function foldEvents(events: Iterable<PlatformEvent>, initial: FoldedState): FoldedState {
  let state = initial;
  for (const event of events) {
    state = foldReducer(state, event);
  }
  return state;
}

export function hasSeenUsageMessage(state: FoldedState, messageId: string): boolean {
  return state.seenUsageMessageIds.includes(messageId);
}
