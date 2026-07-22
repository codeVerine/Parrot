import type { RedactedExcerpt, RedactionHit } from "../types.js";

export type SecretRule = {
  id: string;
  pattern: RegExp;
};

export const DEFAULT_SECRET_RULES: SecretRule[] = [
  { id: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { id: "generic_api_key", pattern: /(?<![A-Za-z0-9])(sk|api)[_-][A-Za-z0-9]{16,}(?![A-Za-z0-9])/gi },
  { id: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { id: "private_key", pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
];

/**
 * Pattern-based secret scanning. Matches become redaction markers with counts;
 * never emit the match text.
 */
export function scanAndRedact(
  text: string,
  rules: readonly SecretRule[] = DEFAULT_SECRET_RULES,
): RedactedExcerpt {
  let output = text;
  const hits: RedactionHit[] = [];

  for (const rule of rules) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const global = new RegExp(rule.pattern.source, flags);
    const matches = output.match(global);
    const count = matches?.length ?? 0;
    if (count > 0) {
      hits.push({ ruleId: rule.id, count });
      output = output.replace(global, `[REDACTED:${rule.id}]`);
    }
  }

  return { text: output, hits };
}

export function shouldRenderTranscriptContent(input: {
  locallyReadable: boolean;
  sensitive: boolean;
}): boolean {
  return input.locallyReadable && !input.sensitive;
}
