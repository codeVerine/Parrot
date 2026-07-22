export {
  DEFAULT_HUMAN_LOOP_CONFIG,
  withHumanLoopConfig,
} from "./config.js";
export type { HumanLoopConfig } from "./config.js";

export {
  blockingFindings,
  findingsFromReport,
  objectionDraftsFromFindings,
} from "./frontier/convert.js";
export {
  adaptEscalationSink,
  approvalRequestedAttention,
  frontierFailedAttention,
} from "./frontier/escalate.js";
export {
  contradictionFindings,
  detectPanelContradictions,
  normalizeRiskKey,
} from "./frontier/panel.js";
export type { FrontierResult } from "./frontier/types.js";

export { createDashboardApi } from "./dashboard/api.js";
export { postHumanDecision } from "./dashboard/decisions.js";
export type { PostDecisionInput } from "./dashboard/decisions.js";
export { escapeHtml, isInertHtml, renderUntrusted } from "./dashboard/escape.js";
export {
  DASHBOARD_DTO_VERSION,
  markClaim,
} from "./dashboard/models.js";
export type {
  CostSummaryDto,
  DecisionDto,
  DrillDownLinks,
  EscalationViewDto,
  FrontierReportDto,
  ObjectionDto,
  TimelineEventDto,
  TranscriptRefDto,
  WorkflowSummaryDto,
} from "./dashboard/models.js";
export {
  assertDrillDownIntegrity,
  projectDashboard,
} from "./dashboard/project.js";
export type { DashboardSnapshot } from "./dashboard/project.js";

export {
  attentionRequestFromFolded,
  createHerdrSink,
  createMemorySink,
  createNoopSink,
  createNotificationSink,
  renotifyFromState,
} from "./notify/sink.js";

export {
  adapterForProvider,
  anthropicAdapter,
  googleAdapter,
  openaiAdapter,
} from "./ledger/adapters.js";
export type { SessionLogAdapter } from "./ledger/adapters.js";
export { deriveHealthMetrics } from "./ledger/health.js";
export type { HealthMetrics } from "./ledger/health.js";
export { ingestSessionLog } from "./ledger/ingest.js";
export type { IngestSessionLogInput } from "./ledger/ingest.js";
export { PRICING_TABLES, computeCost, pricingCorrectionMessageId } from "./ledger/pricing.js";
export type { PricingRates } from "./ledger/pricing.js";

export {
  DEFAULT_SECRET_RULES,
  scanAndRedact,
  shouldRenderTranscriptContent,
} from "./redaction/scan.js";
export type { SecretRule } from "./redaction/scan.js";

export { asUntrusted } from "./types.js";
export type {
  FrontierFinding,
  HumanAttentionKind,
  HumanAttentionRequest,
  HumanNotificationSink,
  PanelContradiction,
  ParsedUsageRecord,
  RedactedExcerpt,
  RedactionHit,
  TranscriptReference,
  UsageIngestResult,
} from "./types.js";
