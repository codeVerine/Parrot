import { randomUUID } from "node:crypto";
import type { PersistenceStore } from "@platform/persistence";
import type { WorkflowEngine } from "@platform/workflow-engine";
import type { HumanLoopConfig } from "../config.js";
import type { UsageIngestResult } from "../types.js";
import { adapterForProvider } from "./adapters.js";
import { computeCost, pricingCorrectionMessageId } from "./pricing.js";

export type IngestSessionLogInput = {
  store: PersistenceStore;
  engine: WorkflowEngine;
  config: HumanLoopConfig;
  workflowId: string;
  provider: string;
  logText: string;
  iterationId?: string;
  turnId?: string;
  agentId?: string;
  health?: {
    wallClockMs?: number;
    retryCount?: number;
    repairCount?: number;
    timeoutCount?: number;
    startupMs?: number;
  };
  /**
   * Audit-only re-price (§5.4). Writes a ledger row under
   * `${messageId}@${pricingVersion}` and does **not** call submitUsage —
   * corrections must not double-count enforced spend.
   */
  asPricingCorrection?: boolean;
};

/**
 * Parse session log → usage_ledger (audit) → engine.submitUsage (enforcement).
 * Unparseable logs degrade without failing the workflow.
 *
 * Normal ingest always calls submitUsage; engine dedup is the source of truth
 * for fold enforcement. Pricing corrections are ledger-only (no submitUsage).
 */
export function ingestSessionLog(input: IngestSessionLogInput): UsageIngestResult[] {
  const adapter = adapterForProvider(input.provider, input.config.adapterVersionByProvider);
  const parsed = adapter.parse(input.logText);
  if (!parsed.ok) {
    return [{ status: "degraded", reason: parsed.reason }];
  }

  const results: UsageIngestResult[] = [];
  const health = input.health ?? {};
  let healthAttached = false;

  for (const record of parsed.records) {
    const { cost, pricingVersion } = computeCost(record, input.config.pricingTableVersion);
    const ledgerMessageId = input.asPricingCorrection
      ? pricingCorrectionMessageId(record.messageId, pricingVersion)
      : record.messageId;

    // Per-turn health once: first row in this ingest batch only (P3).
    const attachHealth = !healthAttached;
    if (attachHealth) healthAttached = true;

    input.store.recordUsage({
      usageId: `usage-${randomUUID()}`,
      workflowId: input.workflowId,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      provider: record.provider,
      messageId: ledgerMessageId,
      cacheTokens: record.cacheTokens,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cost,
      pricingVersion,
      wallClockMs: attachHealth ? (health.wallClockMs ?? 0) : 0,
      retryCount: attachHealth ? (health.retryCount ?? 0) : 0,
      repairCount: attachHealth ? (health.repairCount ?? 0) : 0,
      timeoutCount: attachHealth ? (health.timeoutCount ?? 0) : 0,
      startupMs: attachHealth ? (health.startupMs ?? 0) : 0,
      payload: {
        adapterVersion: record.adapterVersion,
        ...(input.asPricingCorrection
          ? { originalMessageId: record.messageId, pricingCorrection: true }
          : {}),
      },
    });

    // Corrections are audit-only: a distinct ledger id must not fold as fresh spend.
    if (input.asPricingCorrection) {
      results.push({ status: "correction_recorded", messageId: ledgerMessageId, cost });
      continue;
    }

    // Enforcement path: always submit. Engine dedups by messageId.
    const submitted = input.engine.submitUsage({
      workflowId: input.workflowId,
      messageId: ledgerMessageId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cost,
      provider: record.provider,
      cacheTokens: record.cacheTokens,
      pricingVersion,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });

    if (!submitted.recorded) {
      results.push({ status: "duplicate", messageId: ledgerMessageId });
      continue;
    }

    results.push({
      status: "recorded",
      messageId: ledgerMessageId,
      cost,
      budgetCapReached: submitted.budgetCapReached,
    });
  }

  return results;
}
