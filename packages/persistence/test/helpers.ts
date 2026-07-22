import { EventSchema, RuntimeSignalSchema, type PlatformEvent, type RuntimeSignal } from "@platform/contracts";
import { PersistenceStore } from "../src/index.js";

export function sampleEvent(eventId = "event-1"): PlatformEvent {
  return EventSchema.parse({
    eventId,
    occurredAt: "2026-07-19T10:00:00.000Z",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    agentId: "agent-1",
    kind: "TurnCompleted",
    payload: { resultHash: "a".repeat(64) },
  }) as PlatformEvent;
}

export function sampleSignal(signalId = "signal-1"): RuntimeSignal {
  return RuntimeSignalSchema.parse({
    signalId,
    observedAt: "2026-07-19T10:00:01.000Z",
    source: "fs_watch",
    classification: "observation",
    kind: "ResultFileSeen",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    agentId: "agent-1",
    artifactPath: "runs/workflow-1/iteration-1/turn-1/result.toon",
    size: 12,
    contentHash: "b".repeat(64),
  });
}

export function seedTurn(store: PersistenceStore, state: "waiting" | "completed" = "waiting"): void {
  store.transaction((tx) => {
    tx.saveWorkflow({ workflowId: "workflow-1", workspaceId: "workspace-1", status: "running", task: "Persist this task", config: { cap: 3 } });
    tx.saveIteration({ iterationId: "iteration-1", workflowId: "workflow-1", iterationNumber: 1, status: "running" });
    tx.saveTurn({
      turnId: "turn-1",
      workflowId: "workflow-1",
      iterationId: "iteration-1",
      agentId: "agent-1",
      state,
      attempt: "primary",
      deadlineAt: state === "waiting" ? "2026-07-19T10:05:00.000Z" : null,
      promptPath: "runs/workflow-1/iteration-1/turn-1/prompt.md",
      promptHash: "prompt-hash",
      nonce: "nonce-1",
      promptVersion: "planner-v1",
      resultPath: "runs/workflow-1/iteration-1/turn-1/result.toon",
    });
  });
}
