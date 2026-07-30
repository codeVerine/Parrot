import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type WorktreeRef = {
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
};

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "worktree";
}

function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 10);
}

function canonical(path: string): string {
  return realpathSync(path);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function defaultWorktreeRoot(projectDir: string): string {
  // Default outside the repo worktree: git rejects nesting worktrees inside
  // an existing worktree directory.
  const parent = resolve(projectDir, "..");
  return resolve(parent, ".parrot-worktrees", basename(projectDir));
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ["rev-parse", "--verify", branch]);
    return true;
  } catch {
    return false;
  }
}

function isWorktreeDir(path: string): boolean {
  try {
    const dotGit = join(path, ".git");
    if (!existsSync(dotGit)) return false;
    const stat = statSync(dotGit);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ensure an isolated git worktree exists for a workflow and return its path.
 * Worktrees are created outside the primary worktree to avoid nested-worktree
 * rejection by git.
 */
export function ensureWorktree(input: {
  projectDir: string;
  workflowId: string;
  worktreeRoot?: string;
  branchPrefix?: string;
}): WorktreeRef {
  const repoRoot = git(input.projectDir, ["rev-parse", "--show-toplevel"]);
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]);

  const worktreeRoot = input.worktreeRoot ?? defaultWorktreeRoot(repoRoot);
  const workflowKey = `${sanitize(input.workflowId)}-${shortHash(input.workflowId)}`;
  const path = resolve(worktreeRoot, workflowKey);
  const branchPrefix = input.branchPrefix ?? "parrot";
  const branch = `${sanitize(branchPrefix)}/${workflowKey}`;

  if (existsSync(path)) {
    if (isWorktreeDir(path)) {
      // Validate ownership before reuse: correct repo + correct branch.
      const commonDir = resolve(path, git(path, ["rev-parse", "--git-common-dir"]));
      const expectedCommon = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]));
      const resolvedCommon = canonical(commonDir);
      const resolvedExpected = canonical(expectedCommon);
      if (resolvedCommon !== resolvedExpected) {
        throw new Error(
          `Worktree at ${path} belongs to a different repo (git-common-dir=${resolvedCommon}). ` +
          `Expected ${resolvedExpected}. Refusing to reuse.`,
        );
      }
      const currentBranch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (currentBranch !== branch) {
        throw new Error(
          `Worktree at ${path} is on branch ${currentBranch}, expected ${branch}. ` +
          "Refusing to reuse; delete the worktree or choose a different PARROT_WORKTREE_ROOT.",
        );
      }
      return { repoRoot, path, branch, baseCommit };
    }
    throw new Error(
      `Worktree path exists but is not a git worktree: ${path}. ` +
      "Remove it or set PARROT_WORKTREE_ROOT to a clean directory.",
    );
  }

  mkdirSync(dirname(path), { recursive: true });

  if (branchExists(repoRoot, branch)) {
    git(repoRoot, ["worktree", "add", path, branch]);
  } else {
    git(repoRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  }

  return { repoRoot, path, branch, baseCommit };
}
