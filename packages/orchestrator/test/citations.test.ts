import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseToon } from "@platform/contracts";
import { snapshotCitations, verifyCitations, verifyCitationsDetailed } from "../src/citations.js";

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "parrot-citations-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });

  writeFileSync(
    join(root, "src", "api.ts"),
    ["export function existingGate() {", "  return true;", "}", ""].join("\n"),
  );
  writeFileSync(join(root, "node_modules", "ignored.ts"), "export const secret = 1;\n");
  writeFileSync(join(root, "runs", "ignored.ts"), "export const run = 1;\n");

  const outsideRoot = mkdtempSync(join(tmpdir(), "parrot-citations-outside-"));
  writeFileSync(join(outsideRoot, "outside.ts"), "export const leak = 1;\n");
  symlinkSync(join(outsideRoot, "outside.ts"), join(root, "src", "outside-link.ts"));

  execFileSync("git", ["add", "src/api.ts"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

test("matching citation passes", () => {
  const projectDir = createFixtureRepo();
  const issue = verifyCitations({
    projectDir,
    citations: [
      {
        path: "src/api.ts",
        startLine: 1,
        endLine: 3,
        quote: "export function existingGate() {\n  return true;\n}",
      },
    ],
  });
  assert.equal(issue, null);
});

test("whitespace-normalized quote still matches", () => {
  const projectDir = createFixtureRepo();
  const issue = verifyCitations({
    projectDir,
    citations: [
      {
        path: "src/api.ts",
        startLine: 1,
        endLine: 3,
        quote: "export function existingGate() { return true; }",
      },
    ],
  });
  assert.equal(issue, null);
});

test("wrong quote fails with useful diagnostics", () => {
  const projectDir = createFixtureRepo();
  const issue = verifyCitations({
    projectDir,
    citations: [
      {
        path: "src/api.ts",
        startLine: 1,
        endLine: 1,
        quote: "export function missingGate() {",
      },
    ],
  });
  assert.ok(issue);
  assert.match(issue, /quote does not match/);
  assert.match(issue, /src\/api\.ts:1-1/);
});

test("wrong lines / missing file / traversal / symlink escape / excluded paths fail", () => {
  const projectDir = createFixtureRepo();

  const wrongLines = verifyCitations({
    projectDir,
    citations: [{ path: "src/api.ts", startLine: 10, endLine: 12, quote: "x" }],
  });
  assert.match(wrongLines ?? "", /out of bounds/);

  const missing = verifyCitations({
    projectDir,
    citations: [{ path: "src/missing.ts", startLine: 1, endLine: 1, quote: "x" }],
  });
  assert.match(missing ?? "", /not found/);

  const traversal = verifyCitations({
    projectDir,
    citations: [{ path: "../outside.ts", startLine: 1, endLine: 1, quote: "x" }],
  });
  assert.ok(traversal);
  assert.match(traversal, /not found|escapes|excluded/);

  const symlink = verifyCitations({
    projectDir,
    citations: [{ path: "src/outside-link.ts", startLine: 1, endLine: 1, quote: "export const leak = 1;" }],
  });
  assert.match(symlink ?? "", /escapes project root/);

  const excluded = verifyCitations({
    projectDir,
    citations: [{ path: "node_modules/ignored.ts", startLine: 1, endLine: 1, quote: "export const secret = 1;" }],
  });
  assert.match(excluded ?? "", /excluded/);
});

test("snapshotCitations writes citations.toon with span, hash, and commit", () => {
  const projectDir = createFixtureRepo();
  const turnDir = join(projectDir, "runs", "wf", "it", "turn-1");
  mkdirSync(turnDir, { recursive: true });
  const resultPath = join(turnDir, "result.toon");
  writeFileSync(resultPath, "placeholder\n");

  const citations = [
    {
      path: "src/api.ts",
      startLine: 1,
      endLine: 1,
      quote: "export function existingGate() {",
    },
  ];
  const detailed = verifyCitationsDetailed({ projectDir, citations });
  assert.equal(detailed.ok, true);
  if (!detailed.ok) return;

  snapshotCitations({ projectDir, resultPath, verified: detailed.verified });

  const snapshotPath = join(turnDir, "citations.toon");
  const parsed = parseToon(readFileSync(snapshotPath, "utf8")) as {
    role: string;
    commit: string;
    citations: Array<{ path: string; span: string; contentSha256: string }>;
  };
  assert.equal(parsed.role, "citations");
  assert.match(parsed.commit, /^[0-9a-f]{40,64}$/);
  assert.equal(parsed.citations.length, 1);
  assert.equal(parsed.citations[0]?.path, "src/api.ts");
  assert.equal(parsed.citations[0]?.span, "export function existingGate() {");
  assert.match(parsed.citations[0]?.contentSha256 ?? "", /^[0-9a-f]{64}$/);
});

test("diagnostics are capped when many citations fail", () => {
  const projectDir = createFixtureRepo();
  const citations = Array.from({ length: 80 }, (_, index) => ({
    path: "src/api.ts",
    startLine: 1,
    endLine: 1,
    quote: `export function missingGate${index}() {`,
  }));
  const issue = verifyCitations({ projectDir, citations });
  assert.ok(issue);
  assert.ok(issue.length <= 2001);
  assert.match(issue, /…$/);
});
