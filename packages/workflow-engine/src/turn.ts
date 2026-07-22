import { eventId, MAX_REPAIR_ATTEMPTS, type PlatformEvent } from "@platform/contracts";
import type { TurnState } from "@platform/persistence";
import type { EngineEffect, TransitionResult, TurnRecord, ValidationVerdict } from "./types.js";
import { ORPHAN_SOURCE_STATES, TERMINAL_TURN_STATES, type FoldedState } from "./types.js";

export type TurnInput =
  | { type: "start"; turn: TurnRecord }
  | { type: "delivered"; turn: TurnRecord; occurredAt?: string }
  | { type: "resultSeen"; turn: TurnRecord; artifactPath: string; contentHash: string; occurredAt?: string }
  | { type: "validation"; turn: TurnRecord; verdict: ValidationVerdict; occurredAt?: string }
  | { type: "deadlineExpired"; turn: TurnRecord; deadline: string; occurredAt?: string }
  | { type: "cancel"; turn: TurnRecord; occurredAt?: string }
  | { type: "faultFailed"; turn: TurnRecord; reason: string; occurredAt?: string };

function iso(value?: string): string {
  return value ?? new Date().toISOString();
}

function baseEvent(turn: TurnRecord, occurredAt: string): Pick<PlatformEvent, "eventId" | "occurredAt" | "workflowId" | "iterationId" | "turnId"> & Partial<Pick<PlatformEvent, "agentId">> {
  return {
    eventId: String(eventId()),
    occurredAt,
    workflowId: turn.workflowId,
    iterationId: turn.iterationId,
    turnId: turn.turnId,
    ...(turn.agentId ? { agentId: turn.agentId } : {}),
  };
}

function save(turn: TurnRecord, state: TurnState, attempt: TurnRecord["attempt"] = turn.attempt): EngineEffect {
  return { type: "saveTurn", turn: { ...turn, state, attempt } };
}

export function isTerminalTurn(state: TurnState): boolean {
  return (TERMINAL_TURN_STATES as readonly string[]).includes(state);
}

export function isOrphanSource(state: TurnState): boolean {
  return (ORPHAN_SOURCE_STATES as readonly string[]).includes(state);
}

/** Pure turn transition table. Illegal transitions are rejected with no effects. */
export function reduceTurn(folded: FoldedState, input: TurnInput): TransitionResult {
  const effects: EngineEffect[] = [];
  const occurredAt = "occurredAt" in input ? input.occurredAt : undefined;

  switch (input.type) {
    case "start": {
      effects.push(save({ ...input.turn, state: "created", attempt: "primary" }, "created", "primary"));
      return { accepted: true, state: folded, effects };
    }
    case "delivered": {
      if (input.turn.state !== "created") {
        return { accepted: false, state: folded, effects: [], reason: `illegal delivered from ${input.turn.state}` };
      }
      // Persist the post-delivery state only; intermediate `sent` is not separately durable.
      effects.push(save(input.turn, "waiting"));
      return { accepted: true, state: folded, effects };
    }
    case "resultSeen": {
      if (isOrphanSource(input.turn.state)) {
        const event = {
          ...baseEvent(input.turn, iso(occurredAt)),
          kind: "OrphanResultSeen" as const,
          payload: { artifactPath: input.artifactPath, contentHash: input.contentHash },
        };
        effects.push({ type: "appendEvent", event });
        effects.push({
          type: "saveArtifact",
          artifact: {
            artifactId: `orphan-${input.turn.turnId}-${input.contentHash.slice(0, 12)}`,
            workflowId: input.turn.workflowId,
            iterationId: input.turn.iterationId,
            turnId: input.turn.turnId,
            kind: "orphan_result",
            path: input.artifactPath,
            contentHash: input.contentHash,
            orphan: true,
          },
        });
        const next = {
          ...folded,
          orphanLinks: [
            ...folded.orphanLinks,
            { turnId: input.turn.turnId, artifactPath: input.artifactPath, contentHash: input.contentHash },
          ],
        };
        return { accepted: true, state: next, effects };
      }
      if (input.turn.state !== "waiting") {
        return { accepted: false, state: folded, effects: [], reason: `illegal resultSeen from ${input.turn.state}` };
      }
      // Persist validating only; intermediate `result_seen` is not separately durable.
      effects.push(save(input.turn, "validating"));
      return { accepted: true, state: folded, effects };
    }
    case "validation": {
      if (input.turn.state !== "validating") {
        return { accepted: false, state: folded, effects: [], reason: `illegal validation from ${input.turn.state}` };
      }
      if (input.verdict.outcome === "success") {
        effects.push(save(input.turn, "completed"));
        effects.push({
          type: "appendEvent",
          event: {
            ...baseEvent(input.turn, iso(occurredAt)),
            kind: "TurnCompleted",
            payload: { resultHash: input.verdict.resultHash ?? "0".repeat(64) },
          },
        });
        return { accepted: true, state: folded, effects };
      }
      if (input.turn.attempt === "primary") {
        const repaired = { ...input.turn, attempt: "repair" as const };
        effects.push(save(repaired, "waiting", "repair"));
        if (input.turn.agentId) {
          effects.push({ type: "runtimeSendRepair", agentId: input.turn.agentId, turn: { ...repaired, state: "waiting" } });
        }
        return { accepted: true, state: folded, effects };
      }
      effects.push(save(input.turn, "failed"));
      effects.push({
        type: "appendEvent",
        event: {
          ...baseEvent(input.turn, iso(occurredAt)),
          kind: "TurnFailed",
          payload: { reason: input.verdict.reason ?? "second_validation_failed" },
        },
      });
      return { accepted: true, state: folded, effects };
    }
    case "deadlineExpired": {
      if (input.turn.state !== "waiting") {
        return { accepted: false, state: folded, effects: [], reason: `illegal deadlineExpired from ${input.turn.state}` };
      }
      effects.push(save(input.turn, "timed_out"));
      effects.push({
        type: "appendEvent",
        event: {
          ...baseEvent(input.turn, iso(occurredAt)),
          kind: "AgentTimedOut",
          payload: { deadline: input.deadline },
        },
      });
      return { accepted: true, state: folded, effects };
    }
    case "cancel": {
      if (input.turn.state !== "waiting" && input.turn.state !== "sent" && input.turn.state !== "validating") {
        return { accepted: false, state: folded, effects: [], reason: `illegal cancel from ${input.turn.state}` };
      }
      effects.push(save(input.turn, "cancelled"));
      if (input.turn.agentId) {
        effects.push({ type: "runtimeInterrupt", agentId: input.turn.agentId });
        effects.push({ type: "runtimeStop", agentId: input.turn.agentId });
      }
      return { accepted: true, state: folded, effects };
    }
    case "faultFailed": {
      if (input.turn.state !== "waiting" && input.turn.state !== "created" && input.turn.state !== "sent") {
        return { accepted: false, state: folded, effects: [], reason: `illegal faultFailed from ${input.turn.state}` };
      }
      effects.push(save(input.turn, "failed"));
      effects.push({
        type: "appendEvent",
        event: {
          ...baseEvent(input.turn, iso(occurredAt)),
          kind: "TurnFailed",
          payload: { reason: input.reason },
        },
      });
      return { accepted: true, state: folded, effects };
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

export const REPAIR_BOUND = MAX_REPAIR_ATTEMPTS;
