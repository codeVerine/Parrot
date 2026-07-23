import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** A single delivery of a built prompt to an agent, and the result it produced. */
export type AgentTurnRequest = {
  agentId: string;
  turnType: string;
  attempt: "primary" | "repair";
  workflowId: string;
  iterationId: string;
  turnId: string;
  nonce: string;
  promptPath: string;
  promptContent: string;
  resultPath: string;
};

export type AgentTurnResult = { resultText: string };

/**
 * The composition drives turns; the runner delivers a prompt to an agent and
 * returns the raw result text. Production wraps the Herdr runtime; tests inject
 * a fixture so no live model is required.
 */
export type AgentRunner = {
  deliver(request: AgentTurnRequest): Promise<AgentTurnResult>;
};

export type FixtureResolver = (request: AgentTurnRequest) => string | Promise<string>;

/** In-memory runner for tests: a resolver maps each delivery to result text. */
export function createFixtureRunner(resolver: FixtureResolver): AgentRunner {
  return {
    async deliver(request) {
      return { resultText: await resolver(request) };
    },
  };
}

export type FileRunnerOptions = {
  /** Deliver the instruction to the agent (e.g. Herdr sendInstruction). */
  deliver: (request: AgentTurnRequest) => void | Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

/**
 * Production-style runner: deliver the instruction, then watch the result path
 * until the agent writes it (atomic rename convention from the MVP file loop).
 */
export function createFileRunner(options: FileRunnerOptions): AgentRunner {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  return {
    async deliver(request) {
      const before = await fileMtimeMs(request.resultPath);
      await options.deliver(request);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const mtime = await fileMtimeMs(request.resultPath);
        if (mtime !== null && (before === null || mtime > before)) {
          const resultText = await readFile(request.resultPath, "utf8");
          if (resultText.trim().length > 0) return { resultText };
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for result at ${request.resultPath}`);
        }
        await delay(pollIntervalMs);
      }
    },
  };
}

async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
