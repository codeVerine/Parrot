import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CodebaseContextFile } from "@platform/llm-boundary";

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024;
const BINARY_PROBE_BYTES = 4 * 1024;
const MAX_BARE_NAME_HITS = 2;
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", "dist", "runs"]);

export function resolveCodebaseContext(input: {
  projectDir: string;
  task: string;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}): CodebaseContextFile[] {
  const projectDir = input.projectDir;
  const rootReal = realpathSync(projectDir);
  const maxFiles = normalizeLimit(input.maxFiles, DEFAULT_MAX_FILES);
  const maxBytesPerFile = normalizeLimit(input.maxBytesPerFile, DEFAULT_MAX_BYTES_PER_FILE);
  const maxTotalBytes = normalizeLimit(input.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  if (maxFiles === 0 || maxTotalBytes === 0) return [];

  const mentions = extractMentions(input.task);
  const basenameIndex = buildBasenameIndex(loadGitFiles(projectDir));
  const files: CodebaseContextFile[] = [];
  const seen = new Set<string>();
  let remainingBytes = maxTotalBytes;

  for (const mention of mentions) {
    if (files.length >= maxFiles || remainingBytes <= 0) break;

    const candidates = mention.includes("/") || mention.includes("\\")
      ? [mention]
      : basenameIndex.get(mention)?.slice(0, MAX_BARE_NAME_HITS) ?? [];

    for (const candidate of candidates) {
      if (files.length >= maxFiles || remainingBytes <= 0) break;
      const file = readContextFile({
        projectDir,
        rootReal,
        candidate,
        maxBytesPerFile,
        remainingBytes,
      });
      if (!file) continue;
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
      remainingBytes -= Buffer.byteLength(file.content, "utf8");
    }
  }

  return files;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function extractMentions(task: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const pattern = /`([^`]+)`|(?<![\w/.-])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.[\w.-]+)/g;

  for (const match of task.matchAll(pattern)) {
    const mention = normalizeMention(match[1] ?? match[2]);
    if (!mention || seen.has(mention)) continue;
    seen.add(mention);
    mentions.push(mention);
  }

  return mentions;
}

function normalizeMention(mention: string | undefined): string {
  if (mention === undefined) return "";
  return mention.trim().replace(/[),.;:!?]+$/, "");
}

function loadGitFiles(projectDir: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["-C", projectDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--full-name"],
      {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ) as Buffer;
    return output
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function buildBasenameIndex(paths: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const pathValue of paths) {
    const name = basenameForRepoPath(pathValue);
    const bucket = index.get(name);
    if (bucket) bucket.push(pathValue);
    else index.set(name, [pathValue]);
  }
  for (const bucket of index.values()) bucket.sort();
  return index;
}

function basenameForRepoPath(pathValue: string): string {
  const normalized = normalizeRepoPath(pathValue);
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

function normalizeRepoPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

function readContextFile(input: {
  projectDir: string;
  rootReal: string;
  candidate: string;
  maxBytesPerFile: number;
  remainingBytes: number;
}): CodebaseContextFile | null {
  const absolutePath = resolve(input.projectDir, input.candidate);

  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch {
    return null;
  }

  if (!isInsideRoot(input.rootReal, realPath)) return null;

  const repoRelative = normalizeRepoPath(relative(input.rootReal, realPath));
  if (repoRelative.length === 0 || isExcludedPath(repoRelative)) return null;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(realPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const raw = readFileSync(realPath);
  if (hasNulByte(raw)) return null;

  const contentLimit = Math.min(input.maxBytesPerFile, input.remainingBytes, raw.length);
  if (contentLimit <= 0) return null;

  const content = truncateUtf8(raw, contentLimit);
  const emittedBytes = Buffer.byteLength(content, "utf8");
  if (emittedBytes <= 0) return null;

  return {
    path: repoRelative,
    content,
    bytes: raw.length,
    truncated: emittedBytes < raw.length,
  };
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relativePath = relative(rootReal, candidateReal);
  return relativePath !== "" && !relativePath.startsWith("..") && !relativePath.startsWith("../");
}

function isExcludedPath(repoRelative: string): boolean {
  return repoRelative.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, BINARY_PROBE_BYTES)).includes(0);
}

function truncateUtf8(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0) {
    const text = buffer.subarray(0, end).toString("utf8");
    if (Buffer.byteLength(text, "utf8") === end) return text;
    end -= 1;
  }
  return "";
}
