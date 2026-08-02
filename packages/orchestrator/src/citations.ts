import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { encodeToon, type CodeCitation } from "@platform/contracts";
import { CITATION_MAX_QUOTE_CHARS, CITATION_MAX_SPAN_LINES } from "@platform/llm-boundary";

const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", "runs"]);
/** Matches DEFAULT_LLM_BOUNDARY_CONFIG.repairDiagnosticsMaxChars. */
const MAX_DIAGNOSTICS_CHARS = 2_000;

export type VerifiedCitation = CodeCitation & {
  span: string;
  contentSha256: string;
};

/**
 * Verify planner citations against the working tree. Returns null on success,
 * or a diagnostics string listing every failing citation for the repair prompt.
 */
export function verifyCitations(input: {
  projectDir: string;
  citations: readonly CodeCitation[];
}): string | null {
  const result = verifyCitationsDetailed(input);
  return result.ok ? null : result.diagnostics;
}

export function verifyCitationsDetailed(input: {
  projectDir: string;
  citations: readonly CodeCitation[];
}): { ok: true; verified: VerifiedCitation[] } | { ok: false; diagnostics: string } {
  if (input.citations.length === 0) return { ok: true, verified: [] };

  let rootReal: string;
  try {
    rootReal = realpathSync(input.projectDir);
  } catch {
    return {
      ok: false,
      diagnostics: truncateDiagnostics(
        `citation verification failed: cannot resolve projectDir ${input.projectDir}`,
      ),
    };
  }

  const verified: VerifiedCitation[] = [];
  const failures: string[] = [];

  for (const [index, citation] of input.citations.entries()) {
    const label = `citations[${index}] ${citation.path}:${citation.startLine}-${citation.endLine}`;
    const checked = checkOneCitation({ projectDir: input.projectDir, rootReal, citation });
    if (checked.ok) verified.push(checked.verified);
    else failures.push(`${label}: ${checked.reason}`);
  }

  if (failures.length > 0) {
    return {
      ok: false,
      diagnostics: truncateDiagnostics(
        `citation verification failed (${failures.length}):\n${failures.join("\n")}`,
      ),
    };
  }
  return { ok: true, verified };
}

/**
 * Persist already-verified citation spans next to result.toon as citations.toon.
 * Accepts the spans from verifyCitationsDetailed so the working tree is not
 * re-read (avoids a TOCTOU throw if a cited file changes between verify and snapshot).
 */
export function snapshotCitations(input: {
  projectDir: string;
  resultPath: string;
  verified: readonly VerifiedCitation[];
}): void {
  const commit = readHeadCommit(input.projectDir);
  const snapshot = {
    role: "citations",
    commit,
    citations: input.verified.map((item) => ({
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      quote: item.quote,
      span: item.span,
      contentSha256: item.contentSha256,
    })),
  };

  const snapshotPath = join(dirname(input.resultPath), "citations.toon");
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  writeFileSync(snapshotPath, encodeToon(snapshot), { encoding: "utf8", mode: 0o600 });
}

function checkOneCitation(input: {
  projectDir: string;
  rootReal: string;
  citation: CodeCitation;
}): { ok: true; verified: VerifiedCitation } | { ok: false; reason: string } {
  const { citation } = input;

  if (citation.quote.length > CITATION_MAX_QUOTE_CHARS) {
    return { ok: false, reason: `quote exceeds ${CITATION_MAX_QUOTE_CHARS} characters` };
  }

  const spanLines = citation.endLine - citation.startLine + 1;
  if (spanLines > CITATION_MAX_SPAN_LINES) {
    return { ok: false, reason: `span exceeds ${CITATION_MAX_SPAN_LINES} lines` };
  }

  const absolutePath = resolve(input.projectDir, citation.path);
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch {
    return { ok: false, reason: "file not found or unreadable" };
  }

  if (!isInsideRoot(input.rootReal, realPath)) {
    return { ok: false, reason: "path escapes project root" };
  }

  const repoRelative = normalizeRepoPath(relative(input.rootReal, realPath));
  if (repoRelative.length === 0 || isExcludedPath(repoRelative)) {
    return { ok: false, reason: "path is excluded (node_modules/.git/dist/runs)" };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(realPath);
  } catch {
    return { ok: false, reason: "file not readable" };
  }

  const text = raw.toString("utf8");
  const lines = splitLines(text);
  if (citation.startLine > lines.length || citation.endLine > lines.length) {
    return {
      ok: false,
      reason: `line range out of bounds (file has ${lines.length} lines)`,
    };
  }

  const span = lines.slice(citation.startLine - 1, citation.endLine).join("\n");
  if (!quoteMatches(span, citation.quote)) {
    return { ok: false, reason: "quote does not match cited lines" };
  }

  return {
    ok: true,
    verified: {
      ...citation,
      path: repoRelative,
      span,
      contentSha256: createHash("sha256").update(raw).digest("hex"),
    },
  };
}

function quoteMatches(span: string, quote: string): boolean {
  if (span.includes(quote)) return true;
  return normalizeWhitespace(span).includes(normalizeWhitespace(quote));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitLines(text: string): string[] {
  // Preserve final empty line only when the file ends with a newline and has
  // content; trailing empty string from split is dropped for citation ranges.
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relativePath = relative(rootReal, candidateReal);
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.startsWith("../");
}

function isExcludedPath(repoRelative: string): boolean {
  return repoRelative.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function normalizeRepoPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

function truncateDiagnostics(value: string): string {
  if (value.length <= MAX_DIAGNOSTICS_CHARS) return value;
  return `${value.slice(0, MAX_DIAGNOSTICS_CHARS)}…`;
}

function readHeadCommit(projectDir: string): string {
  try {
    return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
