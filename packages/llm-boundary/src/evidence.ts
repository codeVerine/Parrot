import type { UntrustedText } from "./types.js";
import { isUntrustedText, untrusted } from "./types.js";

/** Prefix of open markers (always pair with a per-turn sentinel). */
export const EVIDENCE_OPEN = "<<<EVIDENCE";
/** Legacy static close — never emit alone; use evidenceClose(sentinel). */
export const EVIDENCE_CLOSE = "<<<END_EVIDENCE>>>";

const CLOSE_TOKEN = "<<<END_EVIDENCE";
const OPEN_TOKEN = "<<<EVIDENCE";

export function evidenceOpen(sentinel: string, id: string, field: string): string {
  return `${EVIDENCE_OPEN} nonce=${JSON.stringify(sentinel)} id=${JSON.stringify(id)} field=${JSON.stringify(field)}>>>`;
}

export function evidenceClose(sentinel: string): string {
  return `${CLOSE_TOKEN} nonce=${JSON.stringify(sentinel)}>>>`;
}

/**
 * Neutralize delimiter tokens inside untrusted payloads so a forged close
 * cannot terminate a block even if a sentinel were somehow predicted.
 */
export function neutralizeEvidencePayload(value: string): string {
  return value
    .replaceAll(CLOSE_TOKEN, "«END_EVIDENCE»")
    .replaceAll(OPEN_TOKEN, "«EVIDENCE»");
}

export function containsEvidenceDelimiterToken(value: string): boolean {
  return value.includes(CLOSE_TOKEN) || value.includes(OPEN_TOKEN);
}

export function evidenceBlock(
  sentinel: string,
  id: string,
  field: string,
  text: string | UntrustedText,
): string {
  if (!sentinel) throw new Error("evidenceBlock requires a non-empty sentinel nonce");
  const raw = isUntrustedText(text) ? text.value : text;
  const value = neutralizeEvidencePayload(raw);
  return [evidenceOpen(sentinel, id, field), value, evidenceClose(sentinel)].join("\n");
}

export function markUntrusted(value: string): UntrustedText {
  return untrusted(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceOpenPrefix(sentinel: string): string {
  return `${EVIDENCE_OPEN} nonce=${JSON.stringify(sentinel)}`;
}

/**
 * Strip only blocks closed with the matching per-turn sentinel.
 * A forged `<<<END_EVIDENCE>>>` without the sentinel does not close a block.
 */
export function stripEvidenceBlocks(prompt: string, sentinel: string): string {
  if (!sentinel) throw new Error("stripEvidenceBlocks requires a sentinel nonce");
  const open = escapeRegExp(evidenceOpenPrefix(sentinel));
  const close = escapeRegExp(evidenceClose(sentinel));
  const pattern = new RegExp(`${open}[\\s\\S]*?${close}`, "g");
  return prompt.replace(pattern, "");
}

/** Untrusted values that embed raw open/close delimiter tokens. */
export function findEmbeddedDelimiterTokens(untrustedValues: readonly string[]): string[] {
  return untrustedValues.filter((value) => value.length > 0 && containsEvidenceDelimiterToken(value));
}

/**
 * Returns injection issues found outside sentinel-matched evidence blocks:
 * orphan closes, full untrusted values, and breakout fragments after a forged close.
 */
export function findUntrustedOutsideEvidence(
  prompt: string,
  untrustedValues: readonly string[],
  sentinel: string,
): string[] {
  const outside = stripEvidenceBlocks(prompt, sentinel);
  const issues: string[] = [];

  if (/<<<END_EVIDENCE\b/.test(outside)) {
    issues.push("orphan_evidence_close_outside_block");
  }

  for (const value of untrustedValues) {
    if (!value) continue;

    if (outside.includes(value)) {
      issues.push(value);
      continue;
    }

    // Delimiter-collision split: text after a forged close in the original value.
    const parts = value.split(/<<<END_EVIDENCE\b[^\n]*/);
    for (const fragment of parts.slice(1)) {
      const trimmed = fragment.trim();
      if (trimmed.length > 0 && outside.includes(trimmed)) {
        issues.push(trimmed);
      }
    }
  }

  return issues;
}

export function assertNoInjectionLeaks(
  prompt: string,
  untrustedValues: readonly string[],
  sentinel: string,
): void {
  const issues = [...findUntrustedOutsideEvidence(prompt, untrustedValues, sentinel)];

  // Raw delimiter-bearing payloads must be neutralized before embedding.
  for (const value of findEmbeddedDelimiterTokens(untrustedValues)) {
    if (prompt.includes(value)) {
      issues.push(`raw_delimiter_payload_not_neutralized:${value.slice(0, 80)}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Untrusted text leaked outside evidence blocks: ${issues
        .slice(0, 5)
        .map((v) => JSON.stringify(v.slice(0, 80)))
        .join(", ")}`,
    );
  }
}
