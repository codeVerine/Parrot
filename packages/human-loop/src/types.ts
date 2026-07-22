import { untrusted, type UntrustedText } from "@platform/llm-boundary";
import type { FrontierResult } from "./frontier/types.js";

export type { FrontierResult };

export type FrontierFinding = {
  id: string;
  blocking: boolean;
  claim: UntrustedText;
  evidence: string[];
  source: "risk" | "readiness" | "contradiction";
};

export type PanelContradiction = {
  id: string;
  kind: "divergent_readiness" | "exclusive_risk";
  claim: UntrustedText;
  memberIndexes: number[];
};

export type HumanAttentionKind =
  | "approval_requested"
  | "escalation"
  | "budget_pause"
  | "frontier_failed";

export type HumanAttentionRequest = {
  workflowId: string;
  kind: HumanAttentionKind;
  summary: string;
  dashboardDeepLink: string;
  openObjectionIds?: string[];
};

export type HumanNotificationSink = {
  notify(request: HumanAttentionRequest): void | Promise<void>;
};

export type ParsedUsageRecord = {
  messageId: string;
  provider: string;
  cacheTokens: number;
  inputTokens: number;
  outputTokens: number;
  adapterVersion: string;
  raw?: unknown;
};

export type UsageIngestResult =
  | { status: "recorded"; messageId: string; cost: number; budgetCapReached: boolean }
  | { status: "correction_recorded"; messageId: string; cost: number }
  | { status: "duplicate"; messageId: string }
  | { status: "degraded"; reason: string };

export type TranscriptReference = {
  path: string;
  contentHash: string;
  sizeBytes?: number;
  provider?: string;
  locallyReadable: boolean;
  sensitive: boolean;
};

export type RedactionHit = {
  ruleId: string;
  count: number;
};

export type RedactedExcerpt = {
  text: string;
  hits: RedactionHit[];
};

export function asUntrusted(value: string): UntrustedText {
  return untrusted(value);
}
