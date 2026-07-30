import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("parrot bin is directly executable (shebang preserved in dist)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const binPath = resolve(here, "../bin/parrot.js");

  const firstLine = readFileSync(binPath, "utf8").split("\n")[0];
  assert.equal(firstLine, "#!/usr/bin/env node");

  // The package manager's shim usually runs `node <script>` even without a
  // shebang, but direct execution (global link, copy-to-bin) needs it.
  chmodSync(binPath, 0o755);

  const otherDir = mkdtempSync(join(tmpdir(), "parrot-bin-smoke-"));
  const output = execFileSync(binPath, ["--help"], { cwd: otherDir, encoding: "utf8" });
  assert.match(output, /Usage:\n\s+parrot \[--resume \[workflowId\]\] <task\.md \| prompt text \.\.\.>/);
});
