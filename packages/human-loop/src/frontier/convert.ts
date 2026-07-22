import { asUntrusted, type FrontierFinding } from "../types.js";
import type { FrontierResult } from "./types.js";

/**
 * Convert a validated frontier report into findings.
 * `not_ready` → each risk is a blocking finding; readiness itself yields a
 * blocking finding when risks are empty. Questions never block.
 * `ready` → risks are non-blocking (dashboard summary only).
 */
export function findingsFromReport(
  report: FrontierResult,
  options: { turnId?: string; prefix?: string } = {},
): FrontierFinding[] {
  const prefix = options.prefix ?? "FR";
  const turn = options.turnId ?? "frontier";
  const findings: FrontierFinding[] = [];

  if (report.readiness === "not_ready") {
    if (report.risks.length === 0) {
      findings.push({
        id: `${prefix}-${turn}-readiness`,
        blocking: true,
        claim: asUntrusted("Frontier readiness is not_ready with no enumerated risks."),
        evidence: [`frontier:${turn}`],
        source: "readiness",
      });
    }
    for (const [index, risk] of report.risks.entries()) {
      findings.push({
        id: `${prefix}-${turn}-risk-${index + 1}`,
        blocking: true,
        claim: asUntrusted(risk),
        evidence: [`frontier:${turn}`, `risk:${index}`],
        source: "risk",
      });
    }
    return findings;
  }

  for (const [index, risk] of report.risks.entries()) {
    findings.push({
      id: `${prefix}-${turn}-risk-${index + 1}`,
      blocking: false,
      claim: asUntrusted(risk),
      evidence: [`frontier:${turn}`, `risk:${index}`],
      source: "risk",
    });
  }
  return findings;
}

export function blockingFindings(findings: readonly FrontierFinding[]): FrontierFinding[] {
  return findings.filter((item) => item.blocking);
}

export type ObjectionDraft = {
  objectionId: string;
  severity: "blocking" | "major" | "minor";
  claim: string;
  evidence: string[];
};

/** Map blocking findings to engine raiseObjection payloads (severity blocking). */
export function objectionDraftsFromFindings(
  findings: readonly FrontierFinding[],
): ObjectionDraft[] {
  return blockingFindings(findings).map((finding) => ({
    objectionId: finding.id,
    severity: "blocking" as const,
    claim: finding.claim.value,
    evidence: finding.evidence,
  }));
}
