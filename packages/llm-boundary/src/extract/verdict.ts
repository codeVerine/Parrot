import type { EngineValidationVerdict, ExtractionVerdict } from "../types.js";

export function toEngineValidationVerdict(
  turnId: string,
  verdict: ExtractionVerdict,
): EngineValidationVerdict {
  if (verdict.outcome === "valid") {
    return {
      turnId,
      outcome: "success",
      resultHash: verdict.resultHash,
    };
  }
  return {
    turnId,
    outcome: "failure",
    reason: verdict.reason,
  };
}

export function truncateDiagnostics(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}
