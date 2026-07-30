import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "@platform/contracts";
import type { AgentHandle, HerdrAgentRuntime } from "@platform/herdr-adapter";
import { createHerdrRunner } from "../src/herdr-runner.js";
import type { AgentTurnRequest } from "../src/runner.js";

function request(): AgentTurnRequest {
  return {
    agentId: "planner",
    turnType: "planner_propose",
    attempt: "primary",
    workflowId: "wf-1",
    iterationId: "wf-1-iter-1",
    turnId: "turn-1",
    nonce: "nonce-1",
    promptPath: "/tmp/prompt.md",
    promptContent: "prompt",
    promptHash: "hash",
    promptVersion: "planner@1.2.0",
    resultPath: "/tmp/result.toon",
  };
}

const handle: AgentHandle = {
  id: agentId("agent-planner"),
  paneId: "pane-1",
  workflowId: "workspace-1",
  provider: "claude",
  role: "planner",
  sessionId: null,
  sessionPath: null,
};

test("createHerdrRunner resolves a handle only when a turn is delivered", async () => {
  const getHandleCalls: string[] = [];
  const runtime = {
    send: async () => undefined,
    wait: async () => undefined,
    result: async () => ({ bytes: Buffer.from("result"), turnId: "turn-1" }),
  } as unknown as HerdrAgentRuntime;
  const runner = createHerdrRunner({
    runtime,
    getHandle: async (agent) => {
      getHandleCalls.push(agent);
      return handle;
    },
    maxMs: 1_000,
    idleTimeoutMs: 100,
  });

  assert.deepEqual(getHandleCalls, []);
  const result = await runner.deliver(request());

  assert.deepEqual(getHandleCalls, ["planner"]);
  assert.equal(result.resultText, "result");
});
