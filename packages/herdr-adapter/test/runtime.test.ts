import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId, turnId } from "@platform/contracts";
import { composeProviderReattachArgv, HerdrAgentRuntime } from "../src/runtime.js";
import { FakeHerdr } from "./fake-herdr.js";

test("provider reattach argv uses documented session-id forms", () => {
  assert.deepEqual(composeProviderReattachArgv("claude", ["claude"], { sessionId: "claude-session" }), [
    "claude", "--resume", "claude-session",
  ]);
  assert.deepEqual(composeProviderReattachArgv("codex", ["codex"], { sessionId: "codex-session" }), [
    "codex", "resume", "codex-session",
  ]);
  // Session paths are persisted for identity/reconciliation, but neither
  // installed CLI documents a path argument, so do not invent one.
  assert.deepEqual(composeProviderReattachArgv("claude", ["claude"], { sessionPath: "/tmp/session" }), ["claude"]);
  assert.deepEqual(composeProviderReattachArgv("gemini", ["gemini"], { sessionId: "gemini-session" }), ["gemini"]);
});

test("runtime correlates delivery, result hash, and result-file signal", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { turnDeadlineMs: 500, operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-1"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-runtime-")); await mkdir(join(dir, "turn"));
  const id = turnId("turn-1"); const resultPath = join(dir, "turn", "result.toon"); const request = { turnId: id, workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "prompt-hash", resultPath, schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 500) };
  await writeFile(request.promptPath, "prompt"); const receipt = await runtime.send(handle.id, request); assert.equal(receipt.promptHash, "prompt-hash");
  await writeFile(resultPath, "value: ok\n"); let signal = await runtime.wait(handle.id, id, 500); while (signal.kind !== "ResultFileSeen") signal = await runtime.wait(handle.id, id, 500); assert.equal(signal.kind, "ResultFileSeen");
  const result = await runtime.result(handle.id, id); assert.equal(result.hash.length, 64); assert.equal(result.turnId, id); await runtime.close();
});

test("runtime waits for a newly spawned agent to become ready", async () => {
  const fake = new FakeHerdr();
  fake.startStatus = "unknown";
  fake.readyAfterListCalls = 2;
  const runtime = new HerdrAgentRuntime({
    client: fake,
    config: { operationTimeoutMs: 100, pollIntervalMs: 5 },
  });

  const handle = await runtime.start({
    id: agentId("agent-starting"),
    provider: "claude",
    role: "planner",
    workspaceId: "workspace-1",
    worktreeRequired: false,
  });

  assert.equal(fake.listAgentCalls, 2);
  assert.equal(runtime.identity.get(handle.id)?.status, "idle");
  await runtime.close();
});

test("runtime attaches an existing persisted pane without spawning another", async () => {
  const fake = new FakeHerdr();
  const raw = await fake.startAgent({
    name: "claude-planner",
    argv: ["claude"],
    workspace_id: "workspace-1",
  }, 100);
  const runtime = new HerdrAgentRuntime({
    client: fake,
    config: { operationTimeoutMs: 100, pollIntervalMs: 5 },
  });

  const handle = await runtime.attach({
    id: agentId("workflow-1:planner"),
    paneId: raw.pane_id,
    provider: "claude",
    role: "planner",
    workspaceId: "workspace-1",
    worktreeRequired: false,
  });

  assert.equal(handle?.paneId, raw.pane_id);
  assert.equal(fake.agents.size, 1);
  assert.equal(runtime.identity.get(agentId("workflow-1:planner"))?.status, "idle");
  await runtime.close();
});

test("runtime immediately reattaches a persisted pane that is still working", async () => {
  const fake = new FakeHerdr();
  fake.startStatus = "working";
  const raw = await fake.startAgent({
    name: "claude-planner",
    argv: ["claude"],
    workspace_id: "workspace-1",
  }, 100);
  const runtime = new HerdrAgentRuntime({
    client: fake,
    config: { operationTimeoutMs: 20, pollIntervalMs: 5 },
  });

  const handle = await runtime.attach({
    id: agentId("workflow-1:planner"),
    paneId: raw.pane_id,
    provider: "claude",
    role: "planner",
    workspaceId: "workspace-1",
    worktreeRequired: false,
  });

  assert.equal(handle?.paneId, raw.pane_id);
  assert.equal(fake.listAgentCalls, 1);
  assert.equal(runtime.identity.get(agentId("workflow-1:planner"))?.status, "working");
  await runtime.close();
});

test("onStatus receives normalized live Herdr status", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100 } });
  const handle = await runtime.start({ id: agentId("agent-status"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const statuses: string[] = []; runtime.onStatus((event) => statuses.push(event.normalizedStatus)); fake.setStatus(handle.paneId, "done");
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.deepEqual(statuses, ["idle"]); await runtime.close();
});

test("a local send marks the agent busy before Herdr status catches up", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-busy"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-busy-")); await mkdir(join(dir, "turn"));
  const first = { turnId: turnId("turn-busy-1"), workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath: join(dir, "turn", "result.toon"), schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 1_000) };
  await runtime.send(handle.id, first);
  await assert.rejects(() => runtime.send(handle.id, { ...first, turnId: turnId("turn-busy-2") }), /active turn/);
  await runtime.close();
});

test("deliberate watcher shutdown does not emit a watch fault", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-shutdown"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-shutdown-")); await mkdir(join(dir, "turn"));
  await runtime.send(handle.id, { turnId: turnId("turn-shutdown"), workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath: join(dir, "turn", "result.toon"), schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 1_000) });
  await runtime.close(); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.getSignals().filter((signal) => signal.kind === "ResultWatchFailed").length, 0);
});

test("a past-due turn emits DeadlineExpired instead of a watch fault", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-past-due"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-past-due-")); await mkdir(join(dir, "turn"));
  await runtime.send(handle.id, { turnId: turnId("turn-past-due"), workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath: join(dir, "turn", "result.toon"), schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() - 1) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.getSignals().some((signal) => signal.kind === "DeadlineExpired"), true);
  assert.equal(runtime.getSignals().some((signal) => signal.kind === "ResultWatchFailed"), false);
  await runtime.close();
});

test("reading a result allows the next turn and prunes the old context", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-prune"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-prune-")); await mkdir(join(dir, "turn"));
  const first = { turnId: turnId("turn-prune-1"), workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath: join(dir, "turn", "result.toon"), schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 1_000) };
  await runtime.send(handle.id, first); await writeFile(first.resultPath, "value: one\n");
  let signal = await runtime.wait(handle.id, first.turnId, 500); while (signal.kind !== "ResultFileSeen") signal = await runtime.wait(handle.id, first.turnId, 500);
  await runtime.result(handle.id, first.turnId);
  await runtime.send(handle.id, { ...first, turnId: turnId("turn-prune-2"), resultPath: join(dir, "turn", "result-2.toon") });
  await runtime.close();
});

test("cancelled turns stop their watcher and resync late artifacts as observations", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-orphan"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-orphan-")); await mkdir(join(dir, "turn"));
  const resultPath = join(dir, "turn", "result.toon");
  await runtime.send(handle.id, { turnId: turnId("turn-orphan"), workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath, schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 1_000) });
  await runtime.interrupt(handle.id); await writeFile(resultPath, "value: late\n"); await runtime.resync();
  assert.equal(runtime.getSignals().some((signal) => signal.kind === "ResultFileSeen" && signal.source === "reconcile"), true);
  await runtime.close();
});

test("signal history is capped for long-lived runtimes", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { signalHistoryLimit: 2 } });
  for (let index = 0; index < 4; index += 1) await assert.rejects(() => runtime.start({ id: agentId(`agent-history-${index}`), provider: "unsupported", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false }));
  assert.equal(runtime.getSignals().length, 2);
  await runtime.close();
});
