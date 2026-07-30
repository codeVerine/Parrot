import assert from "node:assert/strict";
import test from "node:test";
import { Protocol16SocketClient, type SocketTransport } from "../src/client/socket.js";
import type { HerdrAgent, HerdrEvent, PaneReadResult } from "../src/client/types.js";
import type { HerdrCli } from "../src/client/cli.js";

class MockTransport implements SocketTransport {
  readonly requests: Array<{ method: string; params: Record<string, unknown>; timeoutMs: number }> = [];

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    this.requests.push({ method, params, timeoutMs });
    return {};
  }

  async subscribe(): Promise<() => void> {
    return () => undefined;
  }

  onEvent(_listener: (event: HerdrEvent) => void): () => void {
    return () => undefined;
  }

  close(): void {
    // no-op
  }
}

function agent(status: HerdrAgent["agent_status"]): HerdrAgent {
  return { pane_id: "pane-1", workspace_id: "workspace-1", agent_status: status };
}

function paneRead(text: string, truncated = false): PaneReadResult {
  return {
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    source: "visible",
    format: "text",
    text,
    revision: 1,
    truncated,
  };
}

class FallbackClient extends Protocol16SocketClient {
  readCount = 0;
  waitCount = 0;

  constructor(private readonly mockTransport: MockTransport) {
    super(mockTransport);
  }

  override async readPane(_paneId: string, _timeoutMs: number): Promise<PaneReadResult> {
    this.readCount += 1;
    return paneRead("prompt with PARROT-MARKER");
  }

  override async waitAgent(_paneId: string, _timeoutMs: number): Promise<HerdrAgent | null> {
    this.waitCount += 1;
    // No status event is emitted for the first Enter; the second Enter is acknowledged.
    const enterCount = this.mockTransport.requests.filter(({ method }) => method === "pane.send_keys").length;
    return enterCount === 1 ? null : agent("working");
  }
}

class CliSubmitClient extends Protocol16SocketClient {
  waitCount = 0;
  initialStatus: HerdrAgent["agent_status"] = "idle";

  override async listAgents(_timeoutMs: number): Promise<HerdrAgent[]> {
    return [agent(this.initialStatus)];
  }

  override async waitAgent(_paneId: string, _timeoutMs: number): Promise<HerdrAgent | null> {
    this.waitCount += 1;
    return agent("working");
  }
}

test("socket fallback confirms paste and retries Enter until the agent acknowledges it", async () => {
  const transport = new MockTransport();
  const client = new FallbackClient(transport);

  await client.sendAgent("pane-1", "prompt", "PARROT-MARKER", 2_000);

  assert.equal(client.readCount, 1, "paste confirmation should read the pane");
  assert.ok(client.waitCount > 1, "the fallback should keep polling before retrying Enter");
  assert.deepEqual(
    transport.requests.map(({ method, params }) => ({ method, params })),
    [
      { method: "pane.send_text", params: { pane_id: "pane-1", text: "prompt" } },
      { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["Enter"] } },
      { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["Enter"] } },
    ],
  );
});

test("CLI pane.run presses Enter when the provider has not started", async () => {
  for (const status of ["idle", "done"] as const) {
    const transport = new MockTransport();
    const client = new CliSubmitClient(transport);
    client.initialStatus = status;
    const calls: Array<{ paneId: string; command: string; timeoutMs: number }> = [];
    const cli: HerdrCli = {
      schema: async () => ({}),
      integrationStatus: async () => ({}),
      paneRun: async (paneId, command, timeoutMs) => {
        calls.push({ paneId, command, timeoutMs });
      },
    };

    await client.sendAgent("pane-1", "prompt", "PARROT-MARKER", 1_000, cli);

    assert.deepEqual(
      transport.requests.map(({ method, params }) => ({ method, params })),
      [{ method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["Enter"] } }],
    );
    assert.equal(client.waitCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.paneId, "pane-1");
    assert.equal(calls[0]?.command, "prompt");
    assert.ok((calls[0]?.timeoutMs ?? 0) > 0 && (calls[0]?.timeoutMs ?? Infinity) <= 1_000);
  }
});
