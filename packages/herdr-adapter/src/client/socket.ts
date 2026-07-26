import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  AgentInfo,
  AgentStartSpec,
  HerdrAgent,
  HerdrEvent,
  HerdrSnapshot,
  PaneAgentStatusChangedData,
  PaneReadResult,
} from "./types.js";
import type { HerdrCli } from "./cli.js";

export interface SocketTransport {
  /**
   * One request over its own short-lived connection. Herdr closes the socket after a
   * single response, so every RPC dials a fresh connection, sends one frame, reads one
   * reply, and closes. Multiplexing many requests over one socket is not supported.
   */
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  /**
   * Open a dedicated long-lived connection for a subscription. Resolves once the server
   * acknowledges (`subscription_started`); pushed events thereafter feed {@link onEvent}
   * listeners. The returned closer tears the streaming connection down.
   */
  subscribe(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<() => void>;
  /** Register a local listener for server-pushed subscription events. */
  onEvent(listener: (event: HerdrEvent) => void): () => void;
  /** Close every open streaming connection. */
  close(): void;
}

export type HerdrClient = {
  /** Create a tab in the workspace so spawned agents share it instead of splitting the current pane. Returns the new tab id. */
  createTab(workspaceId: string | null, label: string | null, timeoutMs: number): Promise<string>;
  startAgent(spec: AgentStartSpec, timeoutMs: number): Promise<HerdrAgent>;
  sendAgent(target: string, text: string, verificationMarker: string, timeoutMs: number, cli?: HerdrCli): Promise<void>;
  /** Read the visible text content of a pane. */
  readPane(paneId: string, timeoutMs: number): Promise<PaneReadResult>;
  waitAgent(paneId: string, timeoutMs: number): Promise<HerdrAgent | null>;
  interruptAgent(paneId: string, timeoutMs: number): Promise<void>;
  stopAgent(paneId: string, timeoutMs: number): Promise<void>;
  sessionSnapshot(timeoutMs: number): Promise<HerdrSnapshot>;
  listAgents(timeoutMs: number): Promise<HerdrAgent[]>;
  /** Ask the server to stream `pane.agent_status_changed` for one pane. */
  subscribeAgentStatus(paneId: string, timeoutMs: number): Promise<void>;
  onEvent(listener: (event: HerdrEvent) => void): () => void;
  /** Release any streaming connections held for subscriptions. */
  close(): void;
};

/** Map the wire {@link AgentInfo} onto the adapter-normalized {@link HerdrAgent}. */
export function toHerdrAgent(info: AgentInfo): HerdrAgent {
  const session = info.agent_session ?? null;
  return {
    pane_id: info.pane_id,
    workspace_id: info.workspace_id,
    agent: info.agent ?? null,
    agent_status: info.agent_status,
    name: info.name ?? null,
    cwd: info.cwd ?? null,
    terminal_id: info.terminal_id ?? null,
    agent_session_id: session && session.kind === "id" ? session.value : null,
    agent_session_path: session && session.kind === "path" ? session.value : null,
  };
}

type TabCreatedResult = { type: "tab_created"; tab: { tab_id: string; workspace_id?: string }; root_pane?: AgentInfo };
type AgentStartedResult = { type: "agent_started"; agent: AgentInfo; argv: string[] };
type AgentListResult = { type: "agent_list"; agents: AgentInfo[] };
type SessionSnapshotResult = { type: "session_snapshot"; snapshot?: { protocol?: number; focused_workspace_id?: string; agents?: AgentInfo[] } };
type WaitMatchedResult = { type: "wait_matched"; event?: { event: string; data: PaneAgentStatusChangedData } };
type PaneReadResponse = { type: "pane_read"; read: PaneReadResult };

/**
 * Herdr protocol 16 socket client. Every method maps to a real request from
 * `herdr api schema --json`; there is no `agent.wait`/`agent.interrupt`/`agent.stop`,
 * so completion is observed via `events.wait`, interruption via `pane.send_keys`, and
 * termination via `pane.close`. Request/response params are validated against the
 * checked-in schema fixture by `test/schema-conformance.test.ts`.
 */
export class Protocol16SocketClient implements HerdrClient {
  private readonly streamClosers = new Set<() => void>();
  constructor(private readonly transport: SocketTransport, private readonly cli?: HerdrCli) {}

  async createTab(workspaceId: string | null, label: string | null, timeoutMs: number): Promise<string> {
    const result = (await this.transport.request(
      "tab.create",
      { workspace_id: workspaceId, label, focus: false },
      timeoutMs,
    )) as TabCreatedResult;
    return result.tab.tab_id;
  }

  async startAgent(spec: AgentStartSpec, timeoutMs: number): Promise<HerdrAgent> {
    const result = (await this.transport.request(
      "agent.start",
      {
        name: spec.name,
        argv: spec.argv,
        cwd: spec.cwd ?? null,
        workspace_id: spec.workspace_id ?? null,
        tab_id: spec.tab_id ?? null,
        env: spec.env ?? {},
        focus: spec.focus ?? false,
      },
      timeoutMs,
    )) as AgentStartedResult;
    return toHerdrAgent(result.agent);
  }

  async sendAgent(target: string, text: string, verificationMarker: string, timeoutMs: number, cli?: HerdrCli): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const remaining = (): number => Math.max(0, deadline - Date.now());

    // Atomic pane run via CLI. Exit code 0 means command was dispatched.
    if (cli) {
      await cli.paneRun(target, text, remaining());
      return;
    }

    // Fallback: paste text, confirm via pane.read, then Enter.
    await this.transport.request("pane.send_text", { pane_id: target, text }, remaining());

    const PANE_READ_POLL_MS = 25;
    for (;;) {
      const read = await this.readPane(target, remaining());
      if (read.text.includes(verificationMarker) && !read.truncated) break;
      if (remaining() <= 0) {
        throw new Error(
          `Paste not confirmed: verification marker "${verificationMarker}" not observed in pane ${target} within ${timeoutMs}ms.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, PANE_READ_POLL_MS));
    }

    const ENTER_CONFIRMATION_MS = 750;
    const MAX_ENTER_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ENTER_ATTEMPTS; attempt++) {
      await this.transport.request("pane.send_keys", { pane_id: target, keys: ["Enter"] }, remaining());

      const pollDeadline = Date.now() + ENTER_CONFIRMATION_MS;
      for (;;) {
        const timeout = Math.max(1, pollDeadline - Date.now());
        const raw = await this.waitAgent(target, timeout);
        if (raw && ["working", "blocked", "done"].includes(raw.agent_status as string)) {
          return;
        }
        if (Date.now() >= pollDeadline || remaining() <= 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, PANE_READ_POLL_MS));
      }

      if (remaining() <= 0) {
        break;
      }
    }

    throw new Error(
      `Enter not acknowledged: pane ${target} unchanged after ${MAX_ENTER_ATTEMPTS} Enter attempts within ${timeoutMs}ms.`,
    );
  }

  async readPane(paneId: string, timeoutMs: number): Promise<PaneReadResult> {
    const result = (await this.transport.request(
      "pane.read",
      { pane_id: paneId, source: "visible", format: "text", strip_ansi: true },
      timeoutMs,
    )) as PaneReadResponse;
    return result.read;
  }

  async waitAgent(paneId: string, timeoutMs: number): Promise<HerdrAgent | null> {
    try {
      const result = (await this.transport.request(
        "events.wait",
        { match_event: { event: "pane_agent_status_changed", pane_id: paneId }, timeout_ms: timeoutMs },
        timeoutMs,
      )) as WaitMatchedResult;
      const data = result.event?.data;
      if (!data) return null;
      return { pane_id: data.pane_id, workspace_id: data.workspace_id, agent: data.agent ?? null, agent_status: data.agent_status };
    } catch {
      // Best-effort status probe; the fs result watcher drives completion regardless.
      return null;
    }
  }

  async interruptAgent(paneId: string, timeoutMs: number): Promise<void> {
    await this.transport.request("pane.send_keys", { pane_id: paneId, keys: ["C-c"] }, timeoutMs);
  }

  async stopAgent(paneId: string, timeoutMs: number): Promise<void> {
    await this.transport.request("pane.close", { pane_id: paneId }, timeoutMs);
  }

  async sessionSnapshot(timeoutMs: number): Promise<HerdrSnapshot> {
    const result = (await this.transport.request("session.snapshot", {}, timeoutMs)) as SessionSnapshotResult;
    const snapshot = result.snapshot;
    return {
      protocol: snapshot?.protocol,
      workspace_id: snapshot?.focused_workspace_id,
      agents: (snapshot?.agents ?? []).map(toHerdrAgent),
    };
  }

  async listAgents(timeoutMs: number): Promise<HerdrAgent[]> {
    const result = (await this.transport.request("agent.list", {}, timeoutMs)) as AgentListResult;
    return (result.agents ?? []).map(toHerdrAgent);
  }

  async subscribeAgentStatus(paneId: string, timeoutMs: number): Promise<void> {
    const closer = await this.transport.subscribe(
      "events.subscribe",
      { subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }] },
      timeoutMs,
    );
    this.streamClosers.add(closer);
  }

  onEvent(listener: (event: HerdrEvent) => void): () => void {
    return this.transport.onEvent(listener);
  }

  close(): void {
    for (const closer of this.streamClosers) closer();
    this.streamClosers.clear();
    this.transport.close();
  }
}

type WireFrame = { id?: string; result?: unknown; error?: { code?: string; message?: string }; event?: string; data?: Record<string, unknown> };

function errorMessage(error: { code?: string; message?: string }): string {
  return error.message ?? error.code ?? "Herdr error";
}

/**
 * Line-delimited JSON transport for Herdr protocol 16. Herdr serves one request per
 * connection and closes it after the single response, so {@link request} dials a fresh
 * connection each call. Subscriptions ({@link subscribe}) hold their own long-lived
 * connection open to receive pushed frames. Herdr remains an external process.
 */
export class LineSocketTransport implements SocketTransport {
  private readonly subscribers = new Set<(event: HerdrEvent) => void>();
  private readonly streams = new Set<Socket>();

  constructor(private readonly socketPath: string) {}

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        action();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`Herdr request ${method} timed out.`))), timeoutMs);
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        if (!line) return;
        let frame: WireFrame;
        try { frame = JSON.parse(line) as WireFrame; }
        catch { finish(() => reject(new Error(`Malformed Herdr response for ${method}.`))); return; }
        if (frame.error) finish(() => reject(new Error(errorMessage(frame.error!))));
        else finish(() => resolve(frame.result));
      });
      socket.on("error", (error) => finish(() => reject(error)));
      socket.on("close", () => finish(() => reject(new Error(`Herdr socket closed before responding to ${method}.`))));
    });
  }

  subscribe(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      let acked = false;
      const closer = () => { this.streams.delete(socket); socket.destroy(); };
      const timer = setTimeout(() => { if (!acked) { socket.destroy(); reject(new Error(`Herdr subscribe ${method} timed out.`)); } }, timeoutMs);
      socket.on("connect", () => socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
          if (!line) continue;
          let frame: WireFrame;
          try { frame = JSON.parse(line) as WireFrame; } catch { continue; }
          if (!acked && frame.error) { clearTimeout(timer); socket.destroy(); reject(new Error(errorMessage(frame.error))); return; }
          if (!acked && frame.id) { acked = true; clearTimeout(timer); this.streams.add(socket); resolve(closer); continue; }
          if (typeof frame.event === "string" && frame.data) {
            const herdrEvent = { ...frame.data, type: frame.event.replaceAll(".", "_") } as unknown as HerdrEvent;
            for (const subscriber of this.subscribers) subscriber(herdrEvent);
          }
        }
      });
      socket.on("error", (error) => { this.streams.delete(socket); if (!acked) { clearTimeout(timer); reject(error); } });
      socket.on("close", () => { this.streams.delete(socket); if (!acked) { clearTimeout(timer); reject(new Error(`Herdr subscription ${method} closed before acknowledgement.`)); } });
    });
  }

  onEvent(listener: (event: HerdrEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  close(): void {
    for (const socket of this.streams) socket.destroy();
    this.streams.clear();
  }
}
