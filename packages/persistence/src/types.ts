import type { EventKind, PlatformEvent, RuntimeSignal } from "@platform/contracts";

export type TurnState = "created" | "sent" | "waiting" | "result_seen" | "validating" | "completed" | "repair_sent" | "failed" | "timed_out" | "cancelled";
export type Attempt = "primary" | "repair";
export type PersistedPlatformEvent = PlatformEvent & { kind: EventKind };

export type WorkflowInput = {
  workflowId: string;
  workspaceId: string;
  status: string;
  task: string;
  config?: unknown;
  state?: unknown;
  createdAt?: string;
};

export type IterationInput = {
  iterationId: string;
  workflowId: string;
  iterationNumber: number;
  status: string;
  state?: unknown;
  createdAt?: string;
};

export type TurnInput = {
  turnId: string;
  workflowId: string;
  iterationId: string;
  agentId?: string | null;
  state: TurnState;
  attempt: Attempt;
  deadlineAt?: string | null;
  promptPath: string;
  promptHash: string;
  nonce: string;
  promptVersion: string;
  resultPath: string;
  createdAt?: string;
};

export type AgentInput = {
  agentId: string;
  paneId: string;
  workspaceId: string;
  provider: string;
  role: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  status: string;
  remapHistory?: unknown;
  createdAt?: string;
};

export type RequirementInput = {
  requirementId: string;
  sourcePath: string;
  contentHash: string;
  priority: "must" | "should" | "could";
  externalId?: string | null;
  text: string;
};

export type ObjectionInput = {
  objectionId: string;
  workflowId: string;
  iterationId: string;
  turnId: string;
  dimension: string;
  severity: "blocking" | "major" | "minor";
  claim: string;
  evidence: string[];
  evidenceMissing?: boolean;
  suggestedResolution?: string | null;
  status: string;
  raisedBy: string;
  clusterId?: string | null;
};

export type DecisionInput = {
  decisionId: string;
  workflowId: string;
  iterationId: string;
  turnId: string;
  decision: string;
  chosen: string;
  alternatives: string[];
  reason: string;
  confidence?: number | null;
  objectionIds: string[];
  payload?: unknown;
  createdAt?: string;
};

export type HumanFeedbackInput = {
  feedbackId: string;
  workflowId: string;
  iterationId?: string | null;
  turnId?: string | null;
  decision: string;
  comment?: string | null;
  payload?: unknown;
  createdAt?: string;
};

export type ArtifactInput = {
  artifactId: string;
  workflowId: string;
  iterationId: string;
  turnId: string;
  agentId?: string | null;
  kind: string;
  path: string;
  contentHash: string;
  orphan?: boolean;
  metadata?: unknown;
  createdAt?: string;
};

export type UsageInput = {
  usageId: string;
  workflowId: string;
  iterationId?: string | null;
  turnId?: string | null;
  agentId?: string | null;
  provider: string;
  messageId: string;
  cacheTokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  pricingVersion: string;
  wallClockMs: number;
  retryCount: number;
  repairCount: number;
  timeoutCount: number;
  startupMs: number;
  payload?: unknown;
  recordedAt?: string;
};

export type StoredEvent = {
  sequence: number;
  eventId: string;
  kind: EventKind;
  occurredAt: string;
  workflowId: string;
  iterationId: string | null;
  turnId: string | null;
  agentId: string | null;
  payloadToon: string;
  dispatchedAt: string | null;
  event: PersistedPlatformEvent;
};

export type StoredSignal = {
  signalId: string;
  kind: RuntimeSignal["kind"];
  classification: RuntimeSignal["classification"];
  observedAt: string;
  source: RuntimeSignal["source"];
  workflowId: string | null;
  iterationId: string | null;
  turnId: string | null;
  agentId: string | null;
  payloadToon: string;
  signal: RuntimeSignal;
};

export type PendingDeadline = {
  turnId: string;
  deadline: string;
  attempt: Attempt;
};

export type RecoverySnapshot = {
  undispatchedEvents: StoredEvent[];
  pendingDeadlines: PendingDeadline[];
};
