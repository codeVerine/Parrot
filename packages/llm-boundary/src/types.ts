import type { ObjectionSeverity, ObjectionStatus } from "@platform/contracts";

export type TurnType =
  | "planner_propose"
  | "planner_revise"
  | "reviewer_review"
  | "adversarial_review"
  | "resolution_verification"
  | "objection_merge"
  | "repair"
  | "compacted_state_refresh"
  | "frontier_report"
  | "implementation";

export type RoleName =
  | "planner"
  | "reviewer"
  | "adversarial"
  | "verifier"
  | "merge"
  | "planner-compact"
  | "frontier"
  | "implementation";

export type UntrustedText = {
  kind: "untrusted";
  value: string;
};

export function untrusted(value: string): UntrustedText {
  return { kind: "untrusted", value };
}

export function isUntrustedText(value: unknown): value is UntrustedText {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as UntrustedText).kind === "untrusted" &&
    typeof (value as UntrustedText).value === "string"
  );
}

export type RolePromptEntry = {
  rolePromptId: string;
  version: string;
  contentHash: string;
  body: string;
  role: RoleName;
};

export type RolePromptPin = {
  rolePromptId: string;
  version: string;
};

export type ProviderModel = {
  provider: string;
  model: string;
};

export type LlmBoundaryConfig = {
  rolePromptPins: Partial<Record<RoleName, RolePromptPin>>;
  providerModelByRole: Partial<Record<RoleName, ProviderModel>>;
  reviewerCountPerRound: number;
  adversarialCount: number;
  compactedStateCadenceIterations: number;
  clusteringBatchSize: number;
  mergeFailureDegrade: boolean;
  repairDiagnosticsMaxChars: number;
  acceptedSchemaVersions: readonly string[];
};

export type TurnIdentity = {
  workflowId: string;
  iterationId: string;
  turnId: string;
  nonce: string;
};

export type RequirementView = {
  id: string;
  text: string;
  priority?: string;
};

export type ObjectionView = {
  id: string;
  dimension: string;
  severity: ObjectionSeverity;
  claim: string;
  evidence: string[];
  evidence_missing?: boolean;
  status: ObjectionStatus;
  raisedBy: string;
  turnId: string;
};

export type DecisionView = {
  id: string;
  chosen: string;
  reason: string;
};

export type CodebaseContextFile = {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
};

export type BuildContext = {
  task?: string;
  proposalSummary?: string;
  proposalPath?: string;
  codebaseContext?: CodebaseContextFile[];
  requirements?: RequirementView[];
  openObjections?: ObjectionView[];
  allObjections?: ObjectionView[];
  humanMessages?: Array<{ afterIteration: number; message: string }>;
  recentDecisions?: DecisionView[];
  requirementsDelta?: string;
  /** For resolution verification. */
  verificationTarget?: {
    objectionId: string;
    plannerResponse: string;
    evidence: string[];
  };
  /** Original turn type when building a repair prompt. */
  originalTurnType?: TurnType;
  repairReason?: string;
  expectedSchemaDescription?: string;
  resultPath?: string;
};

export type BuiltPrompt = {
  turnType: TurnType;
  path: string;
  content: string;
  promptHash: string;
  rolePromptId: string;
  promptVersion: string;
  nonce: string;
  workflowId: string;
  iterationId: string;
  turnId: string;
};

export type ExtractionVerdict =
  | { outcome: "valid"; payload: unknown; resultHash: string; role: string }
  | { outcome: "needsRepair"; reason: string; diagnostics: string }
  | { outcome: "failed"; reason: string };

/** Phase 4 ValidationVerdict shape (mapped). */
export type EngineValidationVerdict = {
  turnId: string;
  outcome: "success" | "failure";
  resultHash?: string;
  reason?: string;
};

export type ValidateResultInput = {
  bytes: string | Buffer;
  contentHash?: string;
  turn: TurnIdentity & { turnType: TurnType; attempt: "primary" | "repair" };
  expectedRole?: RoleName;
};

export type ClusteredObjection = {
  clusterId: string;
  objectionIds: string[];
  severity: ObjectionSeverity;
  representativeClaim: UntrustedText;
  mergeRationale?: UntrustedText;
  evidence: string[];
  members: ObjectionView[];
};

export type MergePostProcessResult = {
  clusters: ClusteredObjection[];
  standalone: ObjectionView[];
};
