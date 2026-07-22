import type { RuntimeSignal } from "@platform/contracts";
import type { FoldedState, TransitionResult, TurnRecord } from "./types.js";
import { reduceTurn } from "./turn.js";

export type FaultOutcome =
  | { scope: "turn"; action: "fail"; reason: string }
  | { scope: "workflow"; action: "escalate"; reason: string }
  | { scope: "workflow"; action: "degrade"; reason: string };

/** Phase 4 §11.3 fault mapping. No fault is silently dropped. */
export function mapFault(signal: Extract<RuntimeSignal, { classification: "fault" }>): FaultOutcome {
  switch (signal.kind) {
    case "AgentSpawnFailed":
      return { scope: "turn", action: "fail", reason: `AgentSpawnFailed:${signal.reason}` };
    case "TurnDeliveryFailed":
      return { scope: "turn", action: "fail", reason: `TurnDeliveryFailed:${signal.reason}` };
    case "ResultWatchFailed":
      return { scope: "turn", action: "fail", reason: "ResultWatchFailed" };
    case "ArtifactRejected":
      return { scope: "turn", action: "fail", reason: `ArtifactRejected:${signal.reason}` };
    case "ReconnectFailed":
      return { scope: "workflow", action: "escalate", reason: "ReconnectFailed" };
    case "ProtocolMismatch":
      return { scope: "workflow", action: "escalate", reason: "ProtocolMismatch" };
    case "DegradedModeEntered":
      return { scope: "workflow", action: "degrade", reason: "DegradedModeEntered" };
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}

export function correlationKey(turnId: string, nonce: string, contentHash: string): string {
  return `${turnId}|${nonce}|${contentHash}`;
}

export type SignalReduceResult = TransitionResult & {
  correlationKey?: string;
  workflowEscalate?: boolean;
  degrade?: boolean;
};

/**
 * Reduce a runtime signal against the current turn row and folded state.
 * Duplicate correlation keys are no-ops.
 */
export function reduceSignal(
  folded: FoldedState,
  turn: TurnRecord | null,
  signal: RuntimeSignal,
  seenCorrelationKeys: ReadonlySet<string>,
): SignalReduceResult {
  if (signal.classification === "fault") {
    const mapped = mapFault(signal);
    if (mapped.action === "degrade") {
      return {
        accepted: true,
        state: { ...folded, degradedMode: true },
        effects: [],
        degrade: true,
      };
    }
    if (mapped.action === "escalate") {
      return {
        accepted: true,
        state: { ...folded, phase: "escalated" },
        effects: [],
        workflowEscalate: true,
        reason: mapped.reason,
      };
    }
    if (!turn) {
      return { accepted: false, state: folded, effects: [], reason: "fault without turn context" };
    }
    return reduceTurn(folded, { type: "faultFailed", turn, reason: mapped.reason, occurredAt: signal.observedAt });
  }

  switch (signal.kind) {
    case "ResultFileSeen": {
      if (!turn) return { accepted: false, state: folded, effects: [], reason: "ResultFileSeen without turn" };
      const key = correlationKey(turn.turnId, turn.nonce, signal.contentHash);
      if (seenCorrelationKeys.has(key)) {
        return { accepted: true, state: folded, effects: [], correlationKey: key, reason: "duplicate_correlation" };
      }
      const result = reduceTurn(folded, {
        type: "resultSeen",
        turn,
        artifactPath: signal.artifactPath,
        contentHash: signal.contentHash,
        occurredAt: signal.observedAt,
      });
      return { ...result, correlationKey: key };
    }
    case "DeadlineExpired": {
      if (!turn) return { accepted: false, state: folded, effects: [], reason: "DeadlineExpired without turn" };
      return reduceTurn(folded, {
        type: "deadlineExpired",
        turn,
        deadline: signal.deadline,
        occurredAt: signal.observedAt,
      });
    }
    case "HerdrStatusChanged":
      // Status never completes a turn alone.
      return { accepted: true, state: folded, effects: [], reason: "status_ignored_for_completion" };
    case "SnapshotReconciled":
      // Missed results are rediscovered as ResultFileSeen by the adapter.
      return { accepted: true, state: folded, effects: [], reason: "snapshot_ack" };
    default: {
      const _exhaustive: never = signal;
      return _exhaustive;
    }
  }
}
