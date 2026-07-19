import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { AgentStartSpec, HerdrAgent, HerdrEvent, HerdrSchema, HerdrSnapshot, IntegrationStatus } from "./types.js";

export interface SocketTransport {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  subscribe(method: string, params: Record<string, unknown>, onEvent: (event: HerdrEvent) => void, timeoutMs: number): Promise<() => void>;
}

export type HerdrClient = {
  schema(timeoutMs: number): Promise<HerdrSchema>;
  integrationStatus(timeoutMs: number): Promise<IntegrationStatus>;
  startAgent(spec: AgentStartSpec, timeoutMs: number): Promise<HerdrAgent>;
  sendAgent(paneId: string, command: string, timeoutMs: number): Promise<void>;
  waitAgent(paneId: string, timeoutMs: number): Promise<HerdrAgent | null>;
  interruptAgent(paneId: string, timeoutMs: number): Promise<void>;
  stopAgent(paneId: string, timeoutMs: number): Promise<void>;
  sessionSnapshot(timeoutMs: number): Promise<HerdrSnapshot>;
  listAgents(timeoutMs: number): Promise<HerdrAgent[]>;
  subscribeEvents(onEvent: (event: HerdrEvent) => void, timeoutMs: number): Promise<() => void>;
};

export class Protocol16SocketClient implements HerdrClient {
  constructor(private readonly transport: SocketTransport) {}

  schema(timeoutMs: number) { return this.transport.request("api.schema", { json: true }, timeoutMs) as Promise<HerdrSchema>; }
  integrationStatus(timeoutMs: number) { return this.transport.request("integration.status", {}, timeoutMs) as Promise<IntegrationStatus>; }
  startAgent(spec: AgentStartSpec, timeoutMs: number) { return this.transport.request("agent.start", spec, timeoutMs) as Promise<HerdrAgent>; }
  async sendAgent(paneId: string, command: string, timeoutMs: number) { await this.transport.request("agent.send", { pane_id: paneId, command }, timeoutMs); }
  waitAgent(paneId: string, timeoutMs: number) { return this.transport.request("agent.wait", { pane_id: paneId, timeout_ms: timeoutMs }, timeoutMs) as Promise<HerdrAgent | null>; }
  async interruptAgent(paneId: string, timeoutMs: number) { await this.transport.request("agent.interrupt", { pane_id: paneId }, timeoutMs); }
  async stopAgent(paneId: string, timeoutMs: number) { await this.transport.request("agent.stop", { pane_id: paneId }, timeoutMs); }
  sessionSnapshot(timeoutMs: number) { return this.transport.request("session.snapshot", {}, timeoutMs) as Promise<HerdrSnapshot>; }
  async listAgents(timeoutMs: number) {
    const response = await this.transport.request("agent.list", {}, timeoutMs) as { agents?: HerdrAgent[]; result?: { agents?: HerdrAgent[] } };
    return response.agents ?? response.result?.agents ?? [];
  }
  subscribeEvents(onEvent: (event: HerdrEvent) => void, timeoutMs: number) { return this.transport.subscribe("events.subscribe", { subscriptions: ["all"] }, onEvent, timeoutMs); }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Minimal line-delimited JSON transport. Herdr remains an external process. */
export class LineSocketTransport implements SocketTransport {
  private readonly socket: Socket;
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Set<(event: HerdrEvent) => void>();
  private buffer = "";

  constructor(socketPath: string) {
    this.socket = createConnection(socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.receive(chunk));
    this.socket.on("error", (error) => this.failPending(error));
    this.socket.on("close", () => this.failPending(new Error("Herdr socket closed.")));
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Herdr request ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async subscribe(method: string, params: Record<string, unknown>, onEvent: (event: HerdrEvent) => void, timeoutMs: number): Promise<() => void> {
    this.subscribers.add(onEvent);
    const response = await this.request(method, params, timeoutMs) as { subscription_id?: string };
    const subscriptionId = response.subscription_id;
    return () => { this.subscribers.delete(onEvent); if (subscriptionId) void this.request("events.unsubscribe", { subscription_id: subscriptionId }, timeoutMs); };
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); newline = this.buffer.indexOf("\n");
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: string; result?: unknown; error?: string; event?: HerdrEvent };
        if (message.event) { for (const subscriber of this.subscribers) subscriber(message.event); continue; }
        if (!message.id) continue;
        const pending = this.pending.get(message.id); if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      } catch { /* malformed transport frames are ignored until the request timeout */ }
    }
  }

  private failPending(error: Error) { for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); } }
}
