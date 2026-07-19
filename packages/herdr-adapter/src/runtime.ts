import { agentId, RuntimeSignalSchema, signalId, type AgentId, type RuntimeSignal, type TurnId } from "@platform/contracts";
import { basename, dirname } from "node:path";
import type { HerdrCli } from "./client/cli.js";
import type { HerdrClient } from "./client/socket.js";
import type { HerdrAgent } from "./client/types.js";
import { withConfig, type AdapterConfig } from "./config.js";
import { consumeEvent } from "./events.js";
import { AgentSpawnError, AdapterError, ArtifactRejectedError, DegradedModeError, ProtocolMismatchError, ReconnectError, ResultWatchError, TurnDeliveryError } from "./errors.js";
import { TurnDeadlineManager } from "./deadline.js";
import { IdentityMap } from "./identity.js";
import { Reconciler } from "./reconcile.js";
import { normalizeStatus, type NormalizedStatus } from "./status.js";
import { runStartupChecks, degradedSignal, type StartupResult } from "./startup.js";
import { readSafeArtifact, ResultFileWatcher, type SafeArtifact } from "./watch.js";

export type AgentSpec = { id?: AgentId; provider: string; role: string; workspaceId: string; worktreeRequired: boolean; env?: Record<string, string> };
export type AgentHandle = { id: AgentId; paneId: string; workflowId: string; provider: string; role: string; sessionId: string | null; sessionPath: string | null };
export type TurnRequest = { turnId: TurnId; workflowId: string; iterationId: string; promptPath: string; promptHash: string; resultPath: string; schemaId: string; nonce: string; deadline: Date; attempt?: "primary" | "repair" };
export type DeliveryReceipt = { turnId: TurnId; promptHash: string; deliveredAt: string };
export type TurnResult = SafeArtifact & { turnId: TurnId };
export type StatusEvent = { agentId: AgentId | null; paneId: string; rawStatus: "idle" | "working" | "blocked" | "done" | "unknown"; normalizedStatus: NormalizedStatus; completionCandidate: boolean; resultCheckRequested: boolean };
export type AgentStatus = { id: AgentId; paneId: string; status: NormalizedStatus; provider: string; role: string };

export interface AgentRuntime {
  start(spec: AgentSpec): Promise<AgentHandle>;
  send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt>;
  wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal>;
  result(id: AgentId, turnId: TurnId): Promise<TurnResult>;
  onStatus(handler: (event: StatusEvent) => void): void;
  resync(): Promise<AgentStatus[]>;
  interrupt(id: AgentId): Promise<void>;
  stop(id: AgentId): Promise<void>;
}

type TurnContext = { request: TurnRequest; watcher: ResultFileWatcher; sentAtMs: number; cancelled: boolean; repairUsed: boolean };
type RuntimeOptions = { client: HerdrClient; cli?: HerdrCli; config?: Partial<AdapterConfig>; identity?: IdentityMap; startup?: StartupResult; persistedDeadlines?: Array<{ turnId: string; deadline: string; attempt: "primary" | "repair" }>; onSignal?: (signal: RuntimeSignal) => void };

export class HerdrAgentRuntime implements AgentRuntime {
  readonly identity: IdentityMap;
  readonly config: AdapterConfig;
  private readonly deadlines: TurnDeadlineManager;
  private readonly reconciler: Reconciler;
  private readonly turns = new Map<string, TurnContext>();
  private readonly signalQueues = new Map<string, RuntimeSignal[]>();
  private readonly signalWaiters = new Map<string, Array<(signal: RuntimeSignal) => void>>();
  private readonly statusHandlers: Array<(event: StatusEvent) => void> = [];
  private readonly receivedSignals: RuntimeSignal[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: RuntimeOptions) {
    this.config = withConfig(options.config);
    this.identity = options.identity ?? new IdentityMap();
    this.deadlines = new TurnDeadlineManager((signal) => this.emitSignal(signal), options.persistedDeadlines ?? []);
    this.reconciler = new Reconciler(options.client, this.identity, (signal) => this.emitSignal(signal), this.config);
    if (options.startup?.degraded) this.emitSignal(degradedSignal(options.startup));
    void this.subscribe();
  }

  static async create(options: RuntimeOptions & { cli: HerdrCli }): Promise<HerdrAgentRuntime> {
    const config = withConfig(options.config);
    let startup: StartupResult;
    try { startup = await runStartupChecks(options.client, options.cli, config, options.onSignal); }
    catch (error) { if (error instanceof AdapterError) throw error; throw error; }
    return new HerdrAgentRuntime({ ...options, config, startup });
  }

  async start(spec: AgentSpec): Promise<AgentHandle> {
    if (!spec.provider.trim() || !this.config.supportedProviders.includes(spec.provider)) throw this.spawnFailure(new AgentSpawnError("unsupported_provider", spec.provider, `Unsupported provider: ${spec.provider || "missing"}.`));
    try {
      const raw = await this.options.client.startAgent({ provider: spec.provider, role: spec.role, workspaceId: spec.workspaceId, worktreeRequired: spec.worktreeRequired, env: spec.env }, this.config.operationTimeoutMs);
      const id = spec.id ?? agentId();
      const status = normalizeStatus(raw).normalizedStatus;
      const identity = this.identity.bind({ agentId: id, paneId: raw.pane_id, workflowId: spec.workspaceId, provider: spec.provider, role: spec.role, status, sessionId: raw.agent_session_id, sessionPath: raw.agent_session_path });
      return { id, paneId: identity.paneId, workflowId: identity.workflowId, provider: identity.provider, role: identity.role, sessionId: identity.sessionId, sessionPath: identity.sessionPath };
    } catch (error) {
      if (error instanceof AgentSpawnError) throw error;
      throw this.spawnFailure(new AgentSpawnError("spawn_error", spec.provider, error instanceof Error ? error.message : String(error)));
    }
  }

  async send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt> {
    const identity = this.identity.get(id);
    const attempt = turn.attempt ?? "primary";
    if (!identity || !identity.paneId) throw this.deliveryFailure(new TurnDeliveryError("pane_dead", String(turn.turnId), attempt, "Agent pane is not available."));
    if (attempt === "repair") {
      const existing = this.turns.get(this.turnKey(id, turn.turnId));
      if (existing?.repairUsed) throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), "repair", "Only one repair attempt is permitted."));
      if (basename(turn.promptPath) !== "repair-prompt.md") throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), "repair", "Repair turns must reference repair-prompt.md."));
    } else if (this.turns.has(this.turnKey(id, turn.turnId))) {
      throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), attempt, "Turn is already active."));
    }
    if (identity.status !== "idle") throw this.deliveryFailure(new TurnDeliveryError("agent_not_idle", String(turn.turnId), attempt, `Agent is ${identity.status}.`));

    const sentAtMs = Date.now();
    const watcher = new ResultFileWatcher(turn.resultPath, { turnDir: dirname(turn.resultPath), sentAtMs, maxBytes: this.config.artifactSizeLimitBytes, pollIntervalMs: this.config.pollIntervalMs, debounceMs: this.config.watchDebounceMs }, (signal) => this.emitSignal({ ...signal, workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id) } as RuntimeSignal));
    watcher.start();
    const command = `Read ${turn.promptPath} and write the ${turn.attempt === "repair" ? "repair " : ""}result to ${turn.resultPath}; schema=${turn.schemaId}; nonce=${turn.nonce}; promptHash=${turn.promptHash}`;
    try {
      await this.options.client.sendAgent(identity.paneId, command, this.config.operationTimeoutMs);
    } catch (error) {
      watcher.stop();
      throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), attempt, error instanceof Error ? error.message : String(error)));
    }
    const key = this.turnKey(id, turn.turnId);
    const context = this.turns.get(key);
    if (context) { context.request = turn; context.sentAtMs = sentAtMs; context.repairUsed = true; context.watcher.stop(); context.watcher = watcher; }
    else this.turns.set(key, { request: turn, watcher, sentAtMs, cancelled: false, repairUsed: attempt === "repair" });
    this.deadlines.arm(String(turn.turnId), turn.deadline, attempt);
    void watcher.wait(Math.max(1, turn.deadline.getTime() - Date.now())).then((artifact) => {
      this.emitSignal(RuntimeSignalSchema.parse({
        signalId: signalId(), kind: "ResultFileSeen", classification: "observation", observedAt: new Date().toISOString(), source: "fs_watch",
        workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id), artifactPath: artifact.path, size: artifact.size, contentHash: artifact.hash,
      }));
    }).catch((error) => {
      if (error instanceof ArtifactRejectedError) return;
      if (error instanceof ResultWatchError) this.emitSignal(RuntimeSignalSchema.parse({ signalId: signalId(), kind: "ResultWatchFailed", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id), artifactPath: turn.resultPath, rawError: error.message }));
    });
    return { turnId: turn.turnId, promptHash: turn.promptHash, deliveredAt: new Date(sentAtMs).toISOString() };
  }

  async wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal> {
    const timeout = Math.max(0, timeoutMs);
    void this.options.client.waitAgent(this.identity.get(id)?.paneId ?? "", timeout).then((raw) => { if (raw) this.handleAgentStatus(id, raw); }).catch(() => undefined);
    return new Promise<RuntimeSignal>((resolve, reject) => {
      const key = String(turnId);
      const queue = this.signalQueues.get(key);
      if (queue?.length) { resolve(queue.shift()!); return; }
      const waiter = (signal: RuntimeSignal) => { clearTimeout(timer); resolve(signal); };
      const timer = setTimeout(() => { const waiters = this.signalWaiters.get(key) ?? []; const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Timed out waiting for signal for ${String(turnId)}.`)); }, timeout);
      const waiters = this.signalWaiters.get(key) ?? []; waiters.push(waiter); this.signalWaiters.set(key, waiters);
    });
  }

  /** Returns raw bytes and a pre-parse hash; envelope and schema validation belongs to Extraction. */
  async result(id: AgentId, turnId: TurnId): Promise<TurnResult> {
    const context = this.turns.get(this.turnKey(id, turnId));
    if (!context) throw this.watchFailure(new ResultWatchError(String(turnId), "No active turn artifact path is known."));
    try {
      const artifact = await readSafeArtifact(context.request.resultPath, { turnDir: dirname(context.request.resultPath), sentAtMs: context.sentAtMs, maxBytes: this.config.artifactSizeLimitBytes, pollIntervalMs: this.config.pollIntervalMs, debounceMs: this.config.watchDebounceMs });
      return { ...artifact, turnId };
    } catch (error) {
      if (error instanceof ArtifactRejectedError) throw this.artifactFailure(error, context.request);
      throw error;
    }
  }

  onStatus(handler: (event: StatusEvent) => void): void { this.statusHandlers.push(handler); }

  async resync(): Promise<AgentStatus[]> {
    const result = await this.reconciler.resync();
    return result.agents.map((agent) => { const identity = this.identity.byPane(agent.pane_id); return identity ? { id: identity.agentId, paneId: identity.paneId, status: identity.status, provider: identity.provider, role: identity.role } : null; }).filter((value): value is AgentStatus => value !== null);
  }

  async interrupt(id: AgentId): Promise<void> { await this.control(id, "interrupt"); }
  async stop(id: AgentId): Promise<void> { await this.control(id, "stop"); }

  getSignals(): readonly RuntimeSignal[] { return this.receivedSignals; }
  async close(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = null; this.deadlines.dispose(); for (const context of this.turns.values()) context.watcher.stop(); }

  private async control(id: AgentId, action: "interrupt" | "stop") {
    const identity = this.identity.get(id); if (!identity?.paneId) return;
    try { if (action === "interrupt") await this.options.client.interruptAgent(identity.paneId, this.config.operationTimeoutMs); else await this.options.client.stopAgent(identity.paneId, this.config.operationTimeoutMs); }
    catch (error) { throw this.deliveryFailure(new TurnDeliveryError("transport_error", "control", "primary", error instanceof Error ? error.message : String(error))); }
    for (const [key, context] of this.turns) if (key.startsWith(`${String(id)}:`)) { context.cancelled = true; this.deadlines.cancel(context.request.turnId as string); }
  }

  private async subscribe() {
    try {
      this.unsubscribe = await this.options.client.subscribeEvents((event) => consumeEvent(event, this.identity, (signal) => {
        if (signal.kind === "HerdrStatusChanged") {
          const identity = signal.agentId ? this.identity.get(signal.agentId as AgentId) : undefined;
          const status: StatusEvent = { agentId: signal.agentId as AgentId | null, paneId: identity?.paneId ?? "", rawStatus: signal.rawStatus, normalizedStatus: signal.normalizedStatus, completionCandidate: signal.hints.completionCandidate, resultCheckRequested: signal.hints.resultCheckRequested };
          for (const handler of this.statusHandlers) handler(status);
        }
        this.emitSignal(signal);
      }), this.config.operationTimeoutMs);
    }
    catch (error) { this.emitError(new ReconnectError(0, error instanceof Error ? error.message : String(error))); }
  }

  private handleAgentStatus(id: AgentId, raw: HerdrAgent) {
    const identity = this.identity.get(id); const normalized = normalizeStatus(raw, String(id));
    this.identity.updateFromHerdr(raw, normalized.normalizedStatus);
    const event: StatusEvent = { agentId: id, paneId: raw.pane_id, rawStatus: normalized.rawStatus, normalizedStatus: normalized.normalizedStatus, completionCandidate: normalized.completionCandidate, resultCheckRequested: normalized.resultCheckRequested };
    for (const handler of this.statusHandlers) handler(event);
  }

  private emitSignal(signal: RuntimeSignal) {
    const parsed = RuntimeSignalSchema.parse(signal); this.receivedSignals.push(parsed);
    const turnId = parsed.turnId; if (!turnId) return;
    const waiter = this.signalWaiters.get(turnId)?.shift(); if (waiter) { waiter(parsed); return; }
    const queue = this.signalQueues.get(turnId) ?? []; queue.push(parsed); this.signalQueues.set(turnId, queue);
  }

  private emitError(error: AdapterError): never | void {
    const common = { signalId: signalId(), observedAt: new Date().toISOString(), source: "adapter_internal" as const, workflowId: null, iterationId: null, turnId: null, agentId: null, classification: "fault" as const };
    if (error instanceof AgentSpawnError) this.emitSignal({ ...common, kind: "AgentSpawnFailed", reason: error.reason, provider: error.provider, rawError: error.message });
    else if (error instanceof TurnDeliveryError) this.emitSignal({ ...common, kind: "TurnDeliveryFailed", reason: error.reason, turnId: error.turnId, attempt: error.attempt, rawError: error.message });
    else if (error instanceof ResultWatchError) this.emitSignal({ ...common, kind: "ResultWatchFailed", artifactPath: error.artifactPath, rawError: error.message });
    else if (error instanceof ArtifactRejectedError) this.emitSignal({ ...common, kind: "ArtifactRejected", reason: error.reason, artifactPath: error.artifactPath, observed: error.observed, limit: error.limit });
    else if (error instanceof ReconnectError) this.emitSignal({ ...common, kind: "ReconnectFailed", attempts: error.attempts, rawError: error.message });
    else if (error instanceof ProtocolMismatchError) this.emitSignal({ ...common, kind: "ProtocolMismatch", expectedProtocol: error.expectedProtocol, observedProtocol: error.observedProtocol, expectedSchemaVersion: error.expectedSchemaVersion, observedSchemaVersion: error.observedSchemaVersion });
    else if (error instanceof DegradedModeError) this.emitSignal({ ...common, kind: "DegradedModeEntered", missingIntegrations: error.missingIntegrations, disabledCapabilities: error.disabledCapabilities });
  }
  private spawnFailure(error: AgentSpawnError): AgentSpawnError { this.emitError(error); return error; }
  private deliveryFailure(error: TurnDeliveryError): TurnDeliveryError { this.emitError(error); return error; }
  private watchFailure(error: ResultWatchError): ResultWatchError { this.emitError(error); return error; }
  private artifactFailure(error: ArtifactRejectedError, turn: TurnRequest): ArtifactRejectedError { this.emitSignal({ signalId: signalId(), kind: "ArtifactRejected", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: null, reason: error.reason, artifactPath: error.artifactPath, observed: error.observed, limit: error.limit }); return error; }
  private turnKey(id: AgentId, turnId: TurnId) { return `${String(id)}:${String(turnId)}`; }
}
