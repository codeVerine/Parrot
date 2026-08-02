import assert from "node:assert/strict";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId, turnId } from "@platform/contracts";
import { HerdrAgentRuntime } from "../src/runtime.js";
import { FakeHerdr } from "./fake-herdr.js";

test("repair reuses the turn and is bounded to one attempt", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { turnDeadlineMs: 500, operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-1"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-repair-")); await mkdir(join(dir, "turn")); const id = turnId("turn-1");
  const base = { turnId: id, workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "hash", resultPath: join(dir, "turn", "result.toon"), schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 500) };
  await writeFile(base.promptPath, "prompt"); await runtime.send(handle.id, base); await runtime.send(handle.id, { ...base, promptPath: join(dir, "repair-prompt.md"), attempt: "repair" });
  assert.match(fake.sentCommands[1], /repair-prompt/);
  await assert.rejects(() => runtime.send(handle.id, { ...base, promptPath: join(dir, "repair-prompt-2.md"), attempt: "repair" }), /Only one repair attempt/);
  await runtime.close();
  const watchFailures = runtime.getSignals().filter((signal) => signal.kind === "ResultWatchFailed");
  assert.equal(watchFailures.length, 0, JSON.stringify(watchFailures));
});

test("repair deletes the leftover primary result.toon before re-watching", async () => {
  const fake = new FakeHerdr();
  const runtime = new HerdrAgentRuntime({
    client: fake,
    config: { turnDeadlineMs: 2_000, operationTimeoutMs: 100, pollIntervalMs: 10 },
  });
  const handle = await runtime.start({
    id: agentId("agent-repair-stale"),
    provider: "codex",
    role: "planner",
    workspaceId: "workspace-1",
    worktreeRequired: false,
  });
  const dir = await mkdtemp(join(tmpdir(), "herdr-repair-stale-"));
  await mkdir(join(dir, "turn"));
  const id = turnId("turn-repair-stale");
  const resultPath = join(dir, "turn", "result.toon");
  const base = {
    turnId: id,
    workflowId: "workspace-1",
    iterationId: "iteration-1",
    promptPath: join(dir, "prompt.md"),
    promptHash: "hash",
    resultPath,
    schemaId: "planner",
    nonce: "nonce",
    deadline: new Date(Date.now() + 2_000),
  };
  await writeFile(base.promptPath, "prompt");
  await writeFile(resultPath, "workflowId: workspace-1\nbad: primary\n");
  await runtime.send(handle.id, base);
  await runtime.send(handle.id, { ...base, promptPath: join(dir, "repair-prompt.md"), attempt: "repair" });
  await assert.rejects(() => access(resultPath, constants.F_OK), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(runtime.getSignals().filter((signal) => signal.kind === "ArtifactRejected").length, 0);
  await runtime.close();
});
