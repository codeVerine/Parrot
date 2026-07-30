import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureWorktree } from "../src/worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("ensureWorktree creates and reuses an isolated git worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "parrot-worktree-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");

  // Init a tiny repo with one commit.
  execFileSync("git", ["init", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "parrot-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const ref1 = ensureWorktree({
    projectDir: repo,
    workflowId: "wf-1",
    worktreeRoot: worktrees,
  });
  assert.ok(existsSync(join(ref1.path, ".git")), "worktree must contain .git pointer");
  assert.equal(git(ref1.path, ["rev-parse", "HEAD"]), head);

  // Edits in the worktree are isolated from the original checkout.
  writeFileSync(join(ref1.path, "only-in-worktree.txt"), "x\n", "utf8");
  assert.equal(existsSync(join(repo, "only-in-worktree.txt")), false);

  // Second call reuses the existing worktree.
  const ref2 = ensureWorktree({
    projectDir: repo,
    workflowId: "wf-1",
    worktreeRoot: worktrees,
  });
  assert.equal(ref2.path, ref1.path);
});

test("ensureWorktree does not collide on lossy workflow ID sanitization", () => {
  const root = mkdtempSync(join(tmpdir(), "parrot-worktree-collision-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");

  execFileSync("git", ["init", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "parrot-test"]);
  writeFileSync(join(repo, "README.md"), "hello\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);

  const a = ensureWorktree({ projectDir: repo, workflowId: "wf/a", worktreeRoot: worktrees });
  const b = ensureWorktree({ projectDir: repo, workflowId: "wf_a", worktreeRoot: worktrees });
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);
});

test("ensureWorktree reuses a workflow worktree when launched from a linked source worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "parrot-worktree-linked-source-"));
  const mainRepo = join(root, "repo-main");
  const sourceWorktree = join(root, "source-wt");
  const worktrees = join(root, "impl-worktrees");

  execFileSync("git", ["init", mainRepo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(mainRepo, ["config", "user.email", "test@example.com"]);
  git(mainRepo, ["config", "user.name", "parrot-test"]);
  writeFileSync(join(mainRepo, "README.md"), "hello\n", "utf8");
  git(mainRepo, ["add", "README.md"]);
  git(mainRepo, ["commit", "-m", "init"]);

  // Create a linked worktree and launch ensureWorktree from inside it.
  git(mainRepo, ["worktree", "add", "-b", "source-branch", sourceWorktree, "HEAD"]);

  const ref1 = ensureWorktree({ projectDir: sourceWorktree, workflowId: "wf-1", worktreeRoot: worktrees });
  const ref2 = ensureWorktree({ projectDir: sourceWorktree, workflowId: "wf-1", worktreeRoot: worktrees });
  assert.equal(ref2.path, ref1.path);
  assert.equal(ref2.branch, ref1.branch);
});
