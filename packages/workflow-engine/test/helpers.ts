import { RuntimeSignalSchema, type RuntimeSignal } from "@platform/contracts";
import { PersistenceStore } from "@platform/persistence";
import {
  WorkflowEngine,
  type EscalationNotification,
  type TurnRecord,
  type WorkflowEngineConfig,
} from "../src/index.js";

export function createEngine(config: Partial<WorkflowEngineConfig> = {}, options: {
  runtime?: ConstructorParameters<typeof WorkflowEngine>[0]["runtime"];
  notifications?: EscalationNotification[];
} = {}): {
  store: PersistenceStore;
  engine: WorkflowEngine;
  escalations: EscalationNotification[];
} {
  const escalations = options.notifications ?? [];
  const store = new PersistenceStore({ path: ":memory:" });
  const engine = new WorkflowEngine({
    store,
    config,
    runtime: options.runtime,
    now: () => "2026-07-22T10:00:00.000Z",
    notifications: {
      notifyEscalation: (notification) => {
        escalations.push(notification);
      },
    },
  });
  return { store, engine, escalations };
}

export function seedWorkflow(
  engine: WorkflowEngine,
  options: { workflowId?: string; config?: Partial<WorkflowEngineConfig> } = {},
): string {
  const workflowId = options.workflowId ?? "workflow-1";
  engine.startWorkflow({
    workflowId,
    workspaceId: "workspace-1",
    task: "Plan the feature",
    config: options.config,
  });
  return workflowId;
}

export function sampleTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-1",
    state: "created",
    attempt: "primary",
    deadlineAt: "2026-07-22T10:05:00.000Z",
    promptPath: "runs/workflow-1/iteration-1/turn-1/prompt.md",
    promptHash: "prompt-hash",
    nonce: "nonce-1",
    promptVersion: "planner-v1",
    resultPath: "runs/workflow-1/iteration-1/turn-1/result.toon",
    ...overrides,
  };
}

export function resultSeenSignal(overrides: Partial<RuntimeSignal> = {}): RuntimeSignal {
  return RuntimeSignalSchema.parse({
    signalId: "signal-result-1",
    observedAt: "2026-07-22T10:01:00.000Z",
    source: "fs_watch",
    classification: "observation",
    kind: "ResultFileSeen",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    agentId: "agent-1",
    artifactPath: "runs/workflow-1/iteration-1/turn-1/result.toon",
    size: 32,
    contentHash: "ab".repeat(32),
    ...overrides,
  });
}

export function deadlineSignal(overrides: Partial<RuntimeSignal> = {}): RuntimeSignal {
  return RuntimeSignalSchema.parse({
    signalId: "signal-deadline-1",
    observedAt: "2026-07-22T10:05:00.000Z",
    source: "deadline_timer",
    classification: "observation",
    kind: "DeadlineExpired",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    turnId: "turn-1",
    agentId: "agent-1",
    deadline: "2026-07-22T10:05:00.000Z",
    attempt: "primary",
    ...overrides,
  });
}

export function turnState(store: PersistenceStore, turnId: string): string {
  const row = store.getTurn(turnId);
  return String(row?.state ?? "");
}

export function eventKinds(store: PersistenceStore, workflowId = "workflow-1"): string[] {
  return [...store.iterateEvents({ workflowId })].map((entry) => entry.event.kind);
}
