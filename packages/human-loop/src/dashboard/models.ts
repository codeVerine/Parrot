import type { UntrustedText } from "@platform/llm-boundary";
import { asUntrusted } from "../types.js";

export const DASHBOARD_DTO_VERSION = "v1" as const;

export type WorkflowSummaryDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  workflowId: string;
  phase: string;
  iterationCount: number;
  maxIterations: number | null;
  budgetCap: number | null;
  spendTotal: number;
  degradedMode: boolean;
  consensusReached: boolean;
  humanDecision: "approved" | "rejected" | null;
};

export type ObjectionDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  id: string;
  severity: string;
  status: string;
  claim: UntrustedText;
  evidenceIds: string[];
  decisionIds: string[];
  transcriptArtifactIds: string[];
  clusterId?: string;
};

export type DecisionDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  decisionId: string;
  chosen: string;
  reason: UntrustedText;
  objectionIds: string[];
  evidenceIds: string[];
  transcriptArtifactIds: string[];
};

export type TimelineEventDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  sequence: number;
  kind: string;
  occurredAt: string;
  eventId: string;
  turnId?: string;
  iterationId?: string;
};

export type CostSummaryDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  workflowId: string;
  spendTotal: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  pricingVersions: string[];
  recordCount: number;
};

export type FrontierReportDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  readiness: "ready" | "not_ready" | null;
  risks: UntrustedText[];
  questions: UntrustedText[];
  artifactIds: string[];
};

export type EscalationViewDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  phase: string;
  reason: string | null;
  openObjectionIds: string[];
};

export type TranscriptRefDto = {
  dtoVersion: typeof DASHBOARD_DTO_VERSION;
  artifactId: string;
  path: string;
  contentHash: string;
  locallyReadable: boolean;
  sensitive: boolean;
};

export type DrillDownLinks = {
  summaryWorkflowId: string;
  objectionIds: string[];
  decisionIds: string[];
  evidenceIds: string[];
  transcriptArtifactIds: string[];
};

export function markClaim(claim: string): UntrustedText {
  return asUntrusted(claim);
}
