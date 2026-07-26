import type { AgentId, TurnId } from "@platform/contracts";
import type { AgentHandle, HerdrAgentRuntime, TurnRequest } from "@platform/herdr-adapter";
import type { AgentRunner, AgentTurnRequest } from "./runner.js";

export type HerdrRunnerOptions = {
  runtime: HerdrAgentRuntime;
  /** Orchestrator agent id (planner/reviewer/...) to a started Herdr agent handle. */
  handles: ReadonlyMap<string, AgentHandle>;
  /** Absolute per-turn ceiling regardless of activity. */
  maxMs?: number;
  /** Fail a turn only after this much silence; the timer resets on each result-dir write. */
  idleTimeoutMs?: number;
  /** @deprecated alias for `maxMs`. */
  timeoutMs?: number;
};

/**
 * Back the agent runner with a live Herdr runtime: deliver the prompt, wait for
 * the result-file signal, and read the bytes. Envelope validation stays in the
 * turn engine; the runner only returns raw result text.
 *
 * Timeout is idle-based, not wall-clock: a turn fails after `idleTimeoutMs` of no
 * result-dir activity (reset on each write by the runtime), bounded by an absolute
 * `maxMs` cap. This keeps a long but actively-working agent alive while still
 * failing a genuinely stalled one.
 */
export function createHerdrRunner(options: HerdrRunnerOptions): AgentRunner {
  const maxMs = options.maxMs ?? options.timeoutMs ?? 45 * 60 * 1000;
  const idleMs = options.idleTimeoutMs ?? 10 * 60 * 1000;
  return {
    async deliver(request: AgentTurnRequest) {
      const handle = options.handles.get(request.agentId);
      if (!handle) throw new Error(`No Herdr agent bound for ${request.agentId}`);
      const agentId = handle.id as AgentId;
      const turnId = request.turnId as TurnId;
      const turnRequest: TurnRequest = {
        turnId,
        workflowId: request.workflowId,
        iterationId: request.iterationId,
        promptPath: request.promptPath,
        promptHash: request.promptHash,
        resultPath: request.resultPath,
        schemaId: request.promptVersion,
        nonce: request.nonce,
        deadline: new Date(Date.now() + maxMs),
        idleMs,
        attempt: request.attempt,
      };
      await options.runtime.send(agentId, turnRequest);
      await options.runtime.wait(agentId, turnId, maxMs);
      try {
        const result = await options.runtime.result(agentId, turnId);
        return { resultText: result.bytes.toString("utf8") };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(
            `Agent ${request.agentId} did not write ${request.resultPath}: no result-dir activity for ${Math.round(idleMs / 1000)}s (idle cutoff), within a ${Math.round(maxMs / 60000)}min cap. The prompt may never have been submitted, or the agent stalled.`,
          );
        }
        throw error;
      }
    },
  };
}
