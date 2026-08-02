import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "@platform/contracts";
import { ArtifactRejectedError, type AgentHandle, type HerdrAgentRuntime } from "@platform/herdr-adapter";
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

function fakeRuntime(startConfirmed: boolean): HerdrAgentRuntime {
  return {
    send: async () => ({ turnId: "turn-1", promptHash: "hash", deliveredAt: new Date().toISOString(), startConfirmed }),
    wait: async () => undefined,
    result: async () => ({ bytes: Buffer.from("result"), turnId: "turn-1" }),
  } as unknown as HerdrAgentRuntime;
}

test("createHerdrRunner resolves a handle only when a turn is delivered", async () => {
  const getHandleCalls: string[] = [];
  const notices: string[] = [];
  const runner = createHerdrRunner({
    runtime: fakeRuntime(true),
    getHandle: async (agent) => {
      getHandleCalls.push(agent);
      return handle;
    },
    onNotice: (message) => notices.push(message),
    maxMs: 1_000,
    idleTimeoutMs: 100,
  });

  assert.deepEqual(getHandleCalls, []);
  const result = await runner.deliver(request());

  assert.deepEqual(getHandleCalls, ["planner"]);
  assert.equal(result.resultText, "result");
  assert.deepEqual(notices, [], "a confirmed start should not produce a notice");
});

test("createHerdrRunner notifies the operator when the agent never confirmed it started", async () => {
  const notices: string[] = [];
  const runner = createHerdrRunner({
    runtime: fakeRuntime(false),
    getHandle: async () => handle,
    onNotice: (message) => notices.push(message),
    maxMs: 1_000,
    idleTimeoutMs: 100,
  });

  const result = await runner.deliver(request());

  assert.equal(result.resultText, "result", "the turn still completes from the result file");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /\[planner\] claude \(pane pane-1\) has not confirmed it started working/);
  assert.match(notices[0]!, /Ctrl\+C/);
});

test("createHerdrRunner rewrites ArtifactRejected into an operator-facing error", async () => {
  const runner = createHerdrRunner({
    runtime: {
      send: async () => ({ turnId: "turn-1", promptHash: "hash", deliveredAt: new Date().toISOString(), startConfirmed: true }),
      wait: async () => undefined,
      result: async () => {
        throw new ArtifactRejectedError("stale_mtime", "/tmp/result.toon", "1", "2");
      },
    } as unknown as HerdrAgentRuntime,
    getHandle: async () => handle,
    maxMs: 1_000,
    idleTimeoutMs: 100,
  });

  await assert.rejects(
    () => runner.deliver(request()),
    /Agent planner wrote a result Parrot cannot accept \(stale_mtime\)/,
  );
});
