import { constants } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { z } from "zod";
import { schemaForRole, type Role, type TurnIdentity } from "./schemas.js";

export type WaitOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; reason: "timeout" | "invalid"; message: string };

export async function prepareResultPath(resultPath: string): Promise<Date> {
  await rm(resultPath, { force: true });
  return new Date();
}

export async function waitForResult<T>(
  resultPath: string,
  identity: TurnIdentity,
  sentAt: Date,
  timeoutMs: number,
): Promise<WaitOutcome<T>> {
  const sentAtMs = sentAt.getTime();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const dir = dirname(resultPath);
  let watcherClosed = false;

  const wakeups: Array<() => void> = [];
  const watcher = watch(dir, () => {
    for (const wake of wakeups.splice(0)) {
      wake();
    }
  });
  watcher.on("error", () => undefined);

  try {
    while (Date.now() < deadline) {
      const attempt = await tryReadResult<T>(resultPath, identity, sentAtMs);
      if (attempt.ok) {
        return attempt;
      }
      if (attempt.reason === "invalid") {
        return attempt;
      }

      const remaining = Math.max(0, Math.min(2000, deadline - Date.now()));
      await waitForWakeup(wakeups, remaining);
    }

    return { ok: false, reason: "timeout", message: `Timed out waiting for ${resultPath}` };
  } finally {
    if (!watcherClosed) {
      watcherClosed = true;
      watcher.close();
    }
  }
}

async function tryReadResult<T>(
  resultPath: string,
  identity: TurnIdentity,
  sentAtMs: number,
): Promise<WaitOutcome<T> | { ok: false; reason: "missing" }> {
  try {
    await access(resultPath, constants.R_OK);
  } catch {
    return { ok: false, reason: "missing" };
  }

  const fileStat = await stat(resultPath);
  if (fileStat.mtimeMs <= sentAtMs) {
    return {
      ok: false,
      reason: "invalid",
      message: `Rejected stale result file: ${resultPath}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      message: `Result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const schema = schemaForRole(identity.role as Role) as unknown as z.ZodType<T>;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    };
  }

  const result = parsed.data as TurnIdentity;
  if (
    result.runId !== identity.runId ||
    result.iteration !== identity.iteration ||
    result.role !== identity.role ||
    result.turnId !== identity.turnId
  ) {
    return {
      ok: false,
      reason: "invalid",
      message: `Result envelope does not match active turn. Expected ${JSON.stringify(identity)}, got ${JSON.stringify({
        runId: result.runId,
        iteration: result.iteration,
        role: result.role,
        turnId: result.turnId,
      })}`,
    };
  }

  return { ok: true, result: parsed.data };
}

async function waitForWakeup(wakeups: Array<() => void>, timeoutMs: number): Promise<void> {
  let wake: (() => void) | undefined;
  const watched = new Promise<void>((resolve) => {
    wake = resolve;
    wakeups.push(resolve);
  });
  await Promise.race([watched, delay(timeoutMs)]);

  if (wake) {
    const index = wakeups.indexOf(wake);
    if (index !== -1) {
      wakeups.splice(index, 1);
    }
  }
}
