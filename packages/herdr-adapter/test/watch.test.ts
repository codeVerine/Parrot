import assert from "node:assert/strict";
import { chmod, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactRejectedError } from "../src/errors.js";
import { readSafeArtifact } from "../src/watch.js";

async function fixture() { const dir = await mkdtemp(join(tmpdir(), "herdr-adapter-")); await chmod(dir, 0o700); const path = join(dir, "result.toon"); await writeFile(path, "value: ok\n"); return { dir, path }; }

test("artifact safety rejects symlinks, stale files, oversized files, and path escapes", async () => {
  const { dir, path } = await fixture();
  await symlink(path, join(dir, "link.toon"));
  await assert.rejects(() => readSafeArtifact(join(dir, "link.toon"), { turnDir: dir, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "symlink");
  await assert.rejects(() => readSafeArtifact(path, { turnDir: dir, sentAtMs: Date.now() + 10_000, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "stale_mtime");
  await writeFile(path, "x".repeat(101));
  await utimes(path, new Date(), new Date());
  await assert.rejects(() => readSafeArtifact(path, { turnDir: dir, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "oversize");
  await assert.rejects(() => readSafeArtifact(join(dir, "..", "outside.toon"), { turnDir: dir, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "path_escape");
});

test("artifact safety records a hash before parsing", async () => {
  const { dir, path } = await fixture(); const artifact = await readSafeArtifact(path, { turnDir: dir, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 });
  assert.equal(artifact.hash.length, 64); assert.equal(artifact.bytes.toString(), "value: ok\n");
});

test("artifact freshness tolerates a same-second filesystem timestamp", async () => {
  const { dir, path } = await fixture();
  const mtime = Math.floor(Date.now() / 1_000) * 1_000;
  await utimes(path, new Date(mtime), new Date(mtime));
  const artifact = await readSafeArtifact(path, { turnDir: dir, sentAtMs: mtime + 500, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 });
  assert.equal(artifact.bytes.toString(), "value: ok\n");
});

test("artifact safety rejects unexpected ownership and world-writable directories", async () => {
  const { dir, path } = await fixture();
  await assert.rejects(() => readSafeArtifact(path, { turnDir: dir, expectedUid: (process.getuid?.() ?? 0) + 1, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "ownership");
  await chmod(dir, 0o777);
  await assert.rejects(() => readSafeArtifact(path, { turnDir: dir, sentAtMs: 0, maxBytes: 100, pollIntervalMs: 2, debounceMs: 1 }), (error: unknown) => error instanceof ArtifactRejectedError && error.reason === "world_writable");
});
