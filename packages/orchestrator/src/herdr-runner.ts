import type { AgentId, TurnId } from "@platform/contracts";
import type { AgentHandle, HerdrAgentRuntime, TurnRequest } from "@platform/herdr-adapter";
import type { AgentRunner, AgentTurnRequest } from "./runner.js";

export type HerdrRunnerOptions = {
  runtime: HerdrAgentRuntime;
  /** Orchestrator agent id (planner/reviewer/...) to a started Herdr agent handle. */
  handles: ReadonlyMap<string, AgentHandle>;
  timeoutMs?: number;
};

/**
 * Back the agent runner with a live Herdr runtime: deliver the prompt, wait for
 * the result-file signal, and read the bytes. Envelope validation stays in the
 * turn engine; the runner only returns raw result text.
 */
export function createHerdrRunner(options: HerdrRunnerOptions): AgentRunner {
  const timeoutMs = options.timeoutMs ?? 120_000;
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
        deadline: new Date(Date.now() + timeoutMs),
        attempt: request.attempt,
      };
      await options.runtime.send(agentId, turnRequest);
      await options.runtime.wait(agentId, turnId, timeoutMs);
      const result = await options.runtime.result(agentId, turnId);
      return { resultText: result.bytes.toString("utf8") };
    },
  };
}
