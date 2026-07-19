import { createHash, randomUUID } from "node:crypto";
import { constants, watch as fsWatch, type FSWatcher } from "node:fs";
import { access, lstat, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ArtifactRejectedError, ResultWatchError } from "./errors.js";
import type { RuntimeSignal } from "@platform/contracts";

export type ArtifactSafetyConfig = { turnDir: string; sentAtMs: number; maxBytes: number; pollIntervalMs: number; debounceMs: number; expectedUid?: number };
export type SafeArtifact = { path: string; bytes: Buffer; hash: string; size: number };
export type WatchEmit = (signal: RuntimeSignal) => void;

/** The adapter stops at file safety. It does not parse TOON or validate the result envelope. */
export async function readSafeArtifact(path: string, config: ArtifactSafetyConfig): Promise<SafeArtifact> {
  const canonicalPath = resolve(path);
  const canonicalDir = resolve(config.turnDir);
  const relation = relative(canonicalDir, canonicalPath);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new ArtifactRejectedError("path_escape", path, canonicalPath, canonicalDir);
  const file = await lstat(canonicalPath);
  if (file.isSymbolicLink()) throw new ArtifactRejectedError("symlink", path);
  const ownerUid = config.expectedUid ?? process.getuid?.();
  if (ownerUid !== undefined && file.uid !== ownerUid) throw new ArtifactRejectedError("ownership", path, String(file.uid), String(ownerUid));
  const directory = await stat(canonicalDir);
  if ((directory.mode & 0o002) !== 0) throw new ArtifactRejectedError("world_writable", canonicalDir, (directory.mode & 0o777).toString(8), "no world write bit");
  if (file.mtimeMs <= config.sentAtMs) throw new ArtifactRejectedError("stale_mtime", path, String(file.mtimeMs), String(config.sentAtMs));
  if (file.size > config.maxBytes) throw new ArtifactRejectedError("oversize", path, String(file.size), String(config.maxBytes));
  await access(canonicalPath, constants.R_OK);
  const bytes = await readFile(canonicalPath);
  return { path: canonicalPath, bytes, hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

export class ResultFileWatcher {
  private watcher: FSWatcher | null = null;
  private stopped = false;
  private wakeups: Array<() => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly resultPath: string, private readonly config: ArtifactSafetyConfig, private readonly emit: WatchEmit) {}

  start() {
    try {
      this.watcher = fsWatch(dirname(this.resultPath), () => this.wake());
      this.watcher.on("error", (error) => { this.emitWatchFailure(error); this.startPolling(); });
    } catch (error) {
      this.emitWatchFailure(error); this.startPolling();
    }
  }

  async wait(timeoutMs: number): Promise<SafeArtifact> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && Date.now() < deadline) {
      try { return await readSafeArtifact(this.resultPath, this.config); }
      catch (error) {
        if (error instanceof ArtifactRejectedError) { this.emitArtifactRejected(error); throw error; }
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { const failure = new ResultWatchError(this.resultPath, error instanceof Error ? error.message : String(error)); this.emitWatchFailure(failure); throw failure; }
      }
      const remaining = Math.min(this.config.pollIntervalMs, deadline - Date.now());
      await this.waitForWakeup(Math.max(1, remaining));
    }
    throw new ResultWatchError(this.resultPath, "Timed out waiting for result artifact.");
  }

  stop() { this.stopped = true; this.watcher?.close(); if (this.pollTimer) clearInterval(this.pollTimer); for (const wake of this.wakeups.splice(0)) wake(); }

  private wake() { for (const wake of this.wakeups.splice(0)) wake(); }
  private startPolling() { if (this.pollTimer || this.stopped) return; this.pollTimer = setInterval(() => this.wake(), this.config.pollIntervalMs); }
  private waitForWakeup(timeoutMs: number) { return new Promise<void>((resolve) => { const timer = setTimeout(() => { const index = this.wakeups.indexOf(wake); if (index >= 0) this.wakeups.splice(index, 1); resolve(); }, timeoutMs); const wake = () => { clearTimeout(timer); resolve(); }; this.wakeups.push(wake); }); }
  private emitWatchFailure(error: unknown) { const failure = new ResultWatchError(this.resultPath, error instanceof Error ? error.message : String(error)); this.emit(faultSignal(failure)); }
  private emitArtifactRejected(error: ArtifactRejectedError) { this.emit(faultSignal(error)); }
}

function faultSignal(error: ResultWatchError | ArtifactRejectedError): RuntimeSignal {
  const common = { signalId: `signal-${randomUUID()}`, observedAt: new Date().toISOString(), source: "adapter_internal" as const, workflowId: null, iterationId: null, turnId: null, agentId: null, classification: "fault" as const };
  if (error instanceof ArtifactRejectedError) return { ...common, kind: "ArtifactRejected", reason: error.reason, artifactPath: error.artifactPath, observed: error.observed, limit: error.limit } as RuntimeSignal;
  return { ...common, kind: "ResultWatchFailed", artifactPath: error.artifactPath, rawError: error.message } as RuntimeSignal;
}
