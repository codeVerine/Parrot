import { asUntrusted, type PanelContradiction } from "../types.js";
import type { FrontierResult } from "./types.js";

/** Normalize risk text for contradiction matching. */
export function normalizeRiskKey(risk: string): string {
  return risk
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic panel contradiction rule (Phase 6 §2.5).
 * No LLM adjudicates between panel members.
 */
export function detectPanelContradictions(
  reports: readonly FrontierResult[],
): PanelContradiction[] {
  if (reports.length < 2) return [];

  const contradictions: PanelContradiction[] = [];
  const readiness = new Set(reports.map((report) => report.readiness));
  if (readiness.size > 1) {
    contradictions.push({
      id: "PANEL-readiness",
      kind: "divergent_readiness",
      claim: asUntrusted(
        `Frontier panel readiness diverges: ${[...readiness].join(" vs ")}`,
      ),
      memberIndexes: reports.map((_, index) => index),
    });
  }

  // Build asserted keys per member; detect mutually exclusive polarity markers.
  type Polarity = "assert" | "deny";
  const byKey = new Map<string, Map<Polarity, number[]>>();

  for (const [memberIndex, report] of reports.entries()) {
    for (const risk of report.risks) {
      const { key, polarity } = classifyRiskPolarity(risk);
      if (!key) continue;
      const bucket = byKey.get(key) ?? new Map<Polarity, number[]>();
      const members = bucket.get(polarity) ?? [];
      members.push(memberIndex);
      bucket.set(polarity, members);
      byKey.set(key, bucket);
    }
  }

  let exclusiveIndex = 0;
  for (const [key, polarities] of byKey) {
    const asserted = polarities.get("assert") ?? [];
    const denied = polarities.get("deny") ?? [];
    if (asserted.length > 0 && denied.length > 0) {
      exclusiveIndex += 1;
      contradictions.push({
        id: `PANEL-risk-${exclusiveIndex}`,
        kind: "exclusive_risk",
        claim: asUntrusted(
          `Frontier panel mutually exclusive risk claim on "${key}"`,
        ),
        memberIndexes: [...new Set([...asserted, ...denied])],
      });
    }
  }

  return contradictions;
}

function classifyRiskPolarity(risk: string): { key: string; polarity: "assert" | "deny" } {
  const normalized = normalizeRiskKey(risk);
  const denyPrefix = /^(no|not|without|absent|lacks?)\s+/.exec(normalized);
  if (denyPrefix) {
    return { key: normalized.slice(denyPrefix[0].length).trim(), polarity: "deny" };
  }
  return { key: normalized, polarity: "assert" };
}

export function contradictionFindings(
  contradictions: readonly PanelContradiction[],
): Array<{
  id: string;
  blocking: true;
  claim: PanelContradiction["claim"];
  evidence: string[];
  source: "contradiction";
}> {
  return contradictions.map((item) => ({
    id: item.id,
    blocking: true as const,
    claim: item.claim,
    evidence: item.memberIndexes.map((index) => `panel-member:${index}`),
    source: "contradiction" as const,
  }));
}
