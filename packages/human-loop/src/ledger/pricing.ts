export type PricingRates = {
  version: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
};

export const PRICING_TABLES: Record<string, PricingRates> = {
  v1: {
    version: "v1",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachePerMillion: 0.3,
  },
};

/**
 * UNIQUE(message_id) on usage_ledger means a same-id re-price is a no-op.
 * Pricing corrections (§5.4) use a distinct message_id for the audit row:
 * `${originalMessageId}@${pricingVersion}`. That row is not submitted to
 * the engine (audit-only; avoids double-counting enforced spend).
 */
export function pricingCorrectionMessageId(
  originalMessageId: string,
  pricingVersion: string,
): string {
  return `${originalMessageId}@${pricingVersion}`;
}

export function computeCost(
  tokens: { inputTokens: number; outputTokens: number; cacheTokens: number },
  pricingVersion: string,
): { cost: number; pricingVersion: string } {
  const table = PRICING_TABLES[pricingVersion];
  if (!table) throw new Error(`Unknown pricing table version: ${pricingVersion}`);
  const cost =
    (tokens.inputTokens / 1_000_000) * table.inputPerMillion +
    (tokens.outputTokens / 1_000_000) * table.outputPerMillion +
    (tokens.cacheTokens / 1_000_000) * table.cachePerMillion;
  return { cost, pricingVersion: table.version };
}
