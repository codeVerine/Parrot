import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId, turnId } from "@platform/contracts";
import { HerdrAgentRuntime } from "../src/runtime.js";
import { FakeHerdr } from "./fake-herdr.js";

test("runtime correlates delivery, result hash, and result-file signal", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { turnDeadlineMs: 500, operationTimeoutMs: 100, pollIntervalMs: 5 } });
  const handle = await runtime.start({ id: agentId("agent-1"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const dir = await mkdtemp(join(tmpdir(), "herdr-runtime-")); await mkdir(join(dir, "turn"));
  const id = turnId("turn-1"); const resultPath = join(dir, "turn", "result.toon"); const request = { turnId: id, workflowId: "workspace-1", iterationId: "iteration-1", promptPath: join(dir, "prompt.md"), promptHash: "prompt-hash", resultPath, schemaId: "reviewer", nonce: "nonce", deadline: new Date(Date.now() + 500) };
  await writeFile(request.promptPath, "prompt"); const receipt = await runtime.send(handle.id, request); assert.equal(receipt.promptHash, "prompt-hash");
  await writeFile(resultPath, "value: ok\n"); let signal = await runtime.wait(handle.id, id, 500); while (signal.kind !== "ResultFileSeen") signal = await runtime.wait(handle.id, id, 500); assert.equal(signal.kind, "ResultFileSeen");
  const result = await runtime.result(handle.id, id); assert.equal(result.hash.length, 64); assert.equal(result.turnId, id); await runtime.close();
});

test("onStatus receives normalized live Herdr status", async () => {
  const fake = new FakeHerdr(); const runtime = new HerdrAgentRuntime({ client: fake, config: { operationTimeoutMs: 100 } });
  const handle = await runtime.start({ id: agentId("agent-status"), provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false });
  const statuses: string[] = []; runtime.onStatus((event) => statuses.push(event.normalizedStatus)); fake.setStatus(handle.paneId, "done");
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.deepEqual(statuses, ["idle"]); await runtime.close();
});
