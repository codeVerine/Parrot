import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCodebaseContext } from "../src/codebase-context.js";

function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "parrot-codebase-context-"));
  execFileSync("git", ["init", "-q"], { cwd: root });

  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });

  writeFileSync(join(root, "src", "loop.ts"), "loop file content 01\n");
  writeFileSync(join(root, "src", "config.ts"), "config file content 02\n");
  writeFileSync(join(root, "src", "nested", "config.ts"), "nested config content 03\n");
  writeFileSync(join(root, "src", "binary.bin"), Buffer.from([0x61, 0x00, 0x62, 0x63]));
  writeFileSync(join(root, "node_modules", "ignored.ts"), "node module content\n");
  writeFileSync(join(root, "dist", "ignored.ts"), "dist content\n");
  writeFileSync(join(root, "runs", "ignored.ts"), "runs content\n");

  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside content\n");
  symlinkSync(outside, join(root, "src", "outside-link.ts"));

  return root;
}

test("resolves codebase context in first-mention order and applies byte caps", () => {
  const projectDir = createFixtureRepo();
  const task = "Inspect `src/loop.ts`, config.ts, and `src/nested/config.ts`.";
  const input = { projectDir, task, maxFiles: 3, maxBytesPerFile: 10, maxTotalBytes: 25 };

  const first = resolveCodebaseContext(input);
  const second = resolveCodebaseContext(input);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((file) => file.path),
    ["src/loop.ts", "src/config.ts", "src/nested/config.ts"],
  );
  assert.equal(Buffer.byteLength(first[0]!.content, "utf8"), 10);
  assert.equal(Buffer.byteLength(first[1]!.content, "utf8"), 10);
  assert.equal(Buffer.byteLength(first[2]!.content, "utf8"), 5);
  assert.equal(first[0]!.truncated, true);
  assert.equal(first[1]!.truncated, true);
  assert.equal(first[2]!.truncated, true);
  assert.equal(
    first.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0),
    25,
  );
});

test("rejects traversal, symlink escapes, excluded directories, and binary files", () => {
  const projectDir = createFixtureRepo();
  const files = resolveCodebaseContext({
    projectDir,
    task:
      "Check `../../etc/passwd`, `src/outside-link.ts`, `node_modules/ignored.ts`, `dist/ignored.ts`, `runs/ignored.ts`, `src/binary.bin`, and `src/loop.ts`.",
  });

  assert.deepEqual(files.map((file) => file.path), ["src/loop.ts"]);
  assert.equal(files[0]!.truncated, false);
  assert.equal(files[0]!.bytes > Buffer.byteLength(files[0]!.content, "utf8"), false);
});
