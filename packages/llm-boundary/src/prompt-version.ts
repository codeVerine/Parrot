/**
 * Prompt pin format is `rolePromptId@version` (e.g. planner@1.8.0).
 * Semantic rules for Author/Pair are gated on these versions so older
 * completed results remain valid under their persisted prompt version.
 */

export type ParsedPromptVersion = {
  rolePromptId: string;
  version: string;
};

export function parsePromptVersion(promptVersion: string): ParsedPromptVersion | null {
  const at = promptVersion.lastIndexOf("@");
  if (at <= 0 || at === promptVersion.length - 1) return null;
  return {
    rolePromptId: promptVersion.slice(0, at),
    version: promptVersion.slice(at + 1),
  };
}

/** Compare dotted numeric versions; non-numeric segments compare lexicographically. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".");
  const right = minimum.split(".");
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i] ?? "0";
    const b = right[i] ?? "0";
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an > bn) return true;
      if (an < bn) return false;
      continue;
    }
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function isRichPairPrompt(promptVersion: string): boolean {
  const parsed = parsePromptVersion(promptVersion);
  if (!parsed) return false;
  if (parsed.rolePromptId !== "reviewer" && parsed.rolePromptId !== "adversarial") return false;
  return versionAtLeast(parsed.version, "1.2.0");
}

export function isAuthorProposalPathPrompt(promptVersion: string): boolean {
  const parsed = parsePromptVersion(promptVersion);
  if (!parsed || parsed.rolePromptId !== "planner") return false;
  return versionAtLeast(parsed.version, "1.8.0");
}

export function isAuthorCompleteAddressalPrompt(promptVersion: string): boolean {
  return isAuthorProposalPathPrompt(promptVersion);
}
