import type { TurnState } from "@platform/persistence";

export type WorkflowPhase =
  | "planner_turn"
  | "spawn_reviewers"
  | "collect_objections"
  | "merge_objections"
  | "objection_gate"
  | "iteration_cap_check"
  | "frontier_review"
  | "frontier_to_objections"
  | "await_human"
  | "human_decision"
  | "escalated"
  | "approved"
  | "rejected";

export type HumanAutoRule = {
  id: string;
  version: number;
  predicate: string;
  action: "approve" | "reject" | "escalate";
};

export type WorkflowEngineConfig = {
  maxIterations: number;
  budgetCap: number | null;
  reviewerCountPerRound: number;
  adversarialReviewerEnabled: boolean;
  frontierPanelSize: number;
  humanAutoRules: HumanAutoRule[];
  escalationNotificationTarget: string;
  /** Used only when a repair turn has no deadlineAt. */
  defaultRepairDeadlineMs: number;
};

export type EscalationNotification = {
  workflowId: string;
  target: string;
  reason: string;
  openObjectionIds: string[];
};

/** Phase 6 will own richer sinks; the engine requires this for human-in-loop delivery. */
export type NotificationSink = {
  notifyEscalation(notification: EscalationNotification): void | Promise<void>;
};

export type FoldedObjection = {
  objectionId: string;
  severity: "blocking" | "major" | "minor";
  status: "open" | "accepted" | "rejected" | "superseded" | "resolved" | "waived";
  /** Incremented only when a raise follows a `resolved` status; a stalemate signal. */
  reraiseCount: number;
};

export type OrphanLink = {
  turnId: string;
  artifactPath: string;
  contentHash: string;
};

export type FoldedState = {
  workflowId: string;
  phase: WorkflowPhase;
  iterationCount: number;
  seenIterationIds: readonly string[];
  spendTotal: number;
  seenUsageMessageIds: readonly string[];
  objections: Readonly<Record<string, FoldedObjection>>;
  frontierBlocking: boolean;
  consensusReached: boolean;
  humanDecision: "approved" | "rejected" | null;
  degradedMode: boolean;
  orphanLinks: readonly OrphanLink[];
  budgetCapReached: boolean;
  iterationCapReached: boolean;
  /**
   * Open objections with `reraiseCount >= stalemateReraiseThreshold` trip a stalemate.
   * Starts at 1; each human "continue planning" choice increments it by 1.
   */
  stalemateReraiseThreshold: number;
};

export type ContinueAfterStalemateInput = {
  workflowId: string;
  objectionIds: string[];
  comment?: string;
  occurredAt?: string;
};

export type TurnRecord = {
  turnId: string;
  workflowId: string;
  iterationId: string;
  agentId: string | null;
  state: TurnState;
  attempt: "primary" | "repair";
  deadlineAt: string | null;
  promptPath: string;
  promptHash: string;
  nonce: string;
  promptVersion: string;
  resultPath: string;
};

export type ValidationVerdict = {
  turnId: string;
  outcome: "success" | "failure";
  resultHash?: string;
  reason?: string;
};

export type UsageFact = {
  workflowId: string;
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  provider?: string;
  cacheTokens?: number;
  pricingVersion?: string;
  iterationId?: string;
  turnId?: string;
  agentId?: string;
  occurredAt?: string;
};

export type HumanDecisionInput = {
  workflowId: string;
  decision: "approved" | "rejected";
  comment?: string;
  waiveOpenObjections?: boolean;
  occurredAt?: string;
};

export type ObjectionInput = {
  workflowId: string;
  objectionId: string;
  severity: "blocking" | "major" | "minor";
  iterationId?: string;
  turnId?: string;
  agentId?: string;
  occurredAt?: string;
};

export type EngineEffect =
  | { type: "saveTurn"; turn: TurnRecord }
  | { type: "saveArtifact"; artifact: { artifactId: string; workflowId: string; iterationId: string; turnId: string; kind: string; path: string; contentHash: string; orphan?: boolean } }
  | { type: "appendEvent"; event: import("@platform/contracts").PlatformEvent }
  | { type: "saveWorkflowState"; workflowId: string; status: string; state: FoldedState; config: WorkflowEngineConfig }
  | { type: "runtimeSendRepair"; agentId: string; turn: TurnRecord }
  | { type: "runtimeInterrupt"; agentId: string }
  | { type: "runtimeStop"; agentId: string }
  | { type: "notifyEscalation"; workflowId: string; target: string; reason: string; openObjectionIds: string[] };

export type TransitionResult = {
  accepted: boolean;
  state: FoldedState;
  effects: EngineEffect[];
  reason?: string;
};

export const TERMINAL_TURN_STATES: readonly TurnState[] = ["failed", "timed_out", "cancelled", "completed"];
export const ORPHAN_SOURCE_STATES: readonly TurnState[] = ["failed", "timed_out", "cancelled"];
