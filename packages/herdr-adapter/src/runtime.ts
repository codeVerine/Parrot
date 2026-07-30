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
import { readSafeArtifact, ResultFileWatcher, ResultWatchStoppedError, ResultWatchTimeoutError, type SafeArtifact } from "./watch.js";

export type AgentSessionResume = { sessionId?: string | null; sessionPath?: string | null };
export type AgentSpec = { id?: AgentId; provider: string; role: string; workspaceId: string; worktreeRequired: boolean; env?: Record<string, string>; argv?: string[]; cwd?: string; name?: string; tabId?: string; resume?: AgentSessionResume };
export type AgentHandle = { id: AgentId; paneId: string; workflowId: string; provider: string; role: string; sessionId: string | null; sessionPath: string | null };
export type TurnRequest = { turnId: TurnId; workflowId: string; iterationId: string; promptPath: string; promptHash: string; resultPath: string; schemaId: string; nonce: string; deadline: Date; idleMs?: number; attempt?: "primary" | "repair" };
export type DeliveryReceipt = { turnId: TurnId; promptHash: string; deliveredAt: string };
export type TurnResult = SafeArtifact & { turnId: TurnId };
export type StatusEvent = { agentId: AgentId | null; paneId: string; rawStatus: "idle" | "working" | "blocked" | "done" | "unknown"; normalizedStatus: NormalizedStatus; completionCandidate: boolean; resultCheckRequested: boolean };
export type AgentStatus = { id: AgentId; paneId: string; status: NormalizedStatus; provider: string; role: string };

/**
 * Compose documented provider resume arguments. Current provider CLIs expose
 * session-id reattach, but not a stable session-path argument: Claude uses
 * `--resume <id>` and Codex uses `resume <id>`. A path is retained in the
 * persisted metadata for reconciliation but is not guessed into argv.
 */
export function composeProviderReattachArgv(
  provider: string,
  argv: readonly string[],
  resume?: AgentSessionResume,
): string[] {
  const sessionId = resume?.sessionId?.trim();
  if (!sessionId) return [...argv];
  if (provider === "claude") {
    if (argv.includes("--resume") || argv.includes("-r")) return [...argv];
    return [...argv, "--resume", sessionId];
  }
  if (provider === "codex") {
    if (argv.includes("resume")) return [...argv];
    const [executable, ...rest] = argv;
    return [executable ?? provider, "resume", sessionId, ...rest];
  }
  return [...argv];
}

export interface AgentRuntime {
  start(spec: AgentSpec): Promise<AgentHandle>;
  attach(spec: AgentSpec & { paneId: string }): Promise<AgentHandle | null>;
  send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt>;
  wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal>;
  result(id: AgentId, turnId: TurnId): Promise<TurnResult>;
  onStatus(handler: (event: StatusEvent) => void): void;
  resync(): Promise<AgentStatus[]>;
  interrupt(id: AgentId): Promise<void>;
  stop(id: AgentId): Promise<void>;
}

type TurnContext = { agentId: AgentId; request: TurnRequest; watcher: ResultFileWatcher; sentAtMs: number; cancelled: boolean; repairUsed: boolean; resultSeen: boolean; resultRead: boolean };
type RuntimeOptions = { client: HerdrClient; cli?: HerdrCli; config?: Partial<AdapterConfig>; identity?: IdentityMap; startup?: StartupResult; persistedDeadlines?: Array<{ turnId: string; deadline: string; attempt: "primary" | "repair" }>; onSignal?: (signal: RuntimeSignal) => void };

export class HerdrAgentRuntime implements AgentRuntime {
  readonly identity: IdentityMap;
  readonly config: AdapterConfig;
  private readonly deadlines: TurnDeadlineManager;
  private readonly reconciler: Reconciler;
  private readonly turns = new Map<string, TurnContext>();
  private readonly orphanTurns = new Map<string, TurnContext>();
  private readonly signalQueues = new Map<string, RuntimeSignal[]>();
  private readonly signalWaiters = new Map<string, Array<(signal: RuntimeSignal) => void>>();
  private readonly statusHandlers: Array<(event: StatusEvent) => void> = [];
  private readonly receivedSignals: RuntimeSignal[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: RuntimeOptions) {
    this.config = withConfig(options.config);
    this.identity = options.identity ?? new IdentityMap();
    this.deadlines = new TurnDeadlineManager((signal) => this.emitSignal(signal), options.persistedDeadlines ?? []);
    this.reconciler = new Reconciler(options.client, this.identity, (signal) => this.emitSignal(signal), this.config, () => this.findMissedResults());
    if (options.startup?.degraded) this.emitSignal(degradedSignal(options.startup));
    this.subscribe();
  }

  static async create(options: RuntimeOptions & { cli: HerdrCli }): Promise<HerdrAgentRuntime> {
    const config = withConfig(options.config);
    const startup = await runStartupChecks(options.client, options.cli, config, options.onSignal);
    return new HerdrAgentRuntime({ ...options, config, startup });
  }

  async start(spec: AgentSpec): Promise<AgentHandle> {
    if (!spec.provider.trim() || !this.config.supportedProviders.includes(spec.provider)) throw this.spawnFailure(new AgentSpawnError("unsupported_provider", spec.provider, `Unsupported provider: ${spec.provider || "missing"}.`));
    try {
      const baseArgv = spec.argv ?? this.config.providerArgv[spec.provider] ?? [spec.provider];
      const argv = composeProviderReattachArgv(spec.provider, baseArgv, spec.resume);
      const name = spec.name ?? `${spec.provider}-${spec.role}`;
      const started = await this.options.client.startAgent({ name, argv, cwd: spec.cwd ?? null, workspace_id: spec.workspaceId, tab_id: spec.tabId ?? null, env: spec.env }, this.config.operationTimeoutMs);
      const raw = normalizeStatus(started).normalizedStatus === "idle"
        ? started
        : await this.waitForAgentReady(started.pane_id, spec.provider);
      const id = spec.id ?? agentId();
      const status = normalizeStatus(raw).normalizedStatus;
      const identity = this.identity.bind({ agentId: id, paneId: raw.pane_id, workflowId: spec.workspaceId, provider: spec.provider, role: spec.role, status, sessionId: raw.agent_session_id, sessionPath: raw.agent_session_path });
      try { await this.options.client.subscribeAgentStatus(identity.paneId, this.config.operationTimeoutMs); }
      catch { /* per-pane status stream is best-effort; the fs result watcher drives completion */ }
      return { id, paneId: identity.paneId, workflowId: identity.workflowId, provider: identity.provider, role: identity.role, sessionId: identity.sessionId, sessionPath: identity.sessionPath };
    } catch (error) {
      if (error instanceof AgentSpawnError) throw error;
      throw this.spawnFailure(new AgentSpawnError("spawn_error", spec.provider, error instanceof Error ? error.message : String(error)));
    }
  }

  async attach(spec: AgentSpec & { paneId: string }): Promise<AgentHandle | null> {
    if (!spec.id) throw new Error("Attaching an agent requires a stable platform agent id.");
    const agents = await this.options.client.listAgents(this.config.operationTimeoutMs);
    const existing = agents.find((candidate) => candidate.pane_id === spec.paneId);
    if (!existing) return null;
    if (existing.workspace_id !== spec.workspaceId || existing.agent !== spec.provider) return null;

    const existingStatus = normalizeStatus(existing).normalizedStatus;
    const raw = existingStatus === "unknown"
      ? await this.waitForAgentReady(existing.pane_id, spec.provider)
      : existing;
    const status = normalizeStatus(raw).normalizedStatus;
    const identity = this.identity.bind({
      agentId: spec.id,
      paneId: raw.pane_id,
      workflowId: spec.workspaceId,
      provider: spec.provider,
      role: spec.role,
      status,
      sessionId: raw.agent_session_id,
      sessionPath: raw.agent_session_path,
    });
    try {
      await this.options.client.subscribeAgentStatus(
        identity.paneId,
        this.config.operationTimeoutMs,
      );
    } catch {
      // Per-pane status is best-effort; result artifacts remain authoritative.
    }
    return {
      id: identity.agentId,
      paneId: identity.paneId,
      workflowId: identity.workflowId,
      provider: identity.provider,
      role: identity.role,
      sessionId: identity.sessionId,
      sessionPath: identity.sessionPath,
    };
  }

  async send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt> {
    const identity = this.identity.get(id);
    const attempt = turn.attempt ?? "primary";
    if (!identity || !identity.paneId) throw this.deliveryFailure(new TurnDeliveryError("pane_dead", String(turn.turnId), attempt, "Agent pane is not available."));
    if (attempt === "primary") this.pruneReadTurns(id);
    const key = this.turnKey(id, turn.turnId);
    const existing = this.turns.get(key);
    if (attempt === "repair") {
      if (!existing) throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), "repair", "Repair requires an active primary turn."));
      if (existing.repairUsed) throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), "repair", "Only one repair attempt is permitted."));
      if (basename(turn.promptPath) !== "repair-prompt.md") throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), "repair", "Repair turns must reference repair-prompt.md."));
    } else if (existing) {
      throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), attempt, "Turn is already active."));
    }
    if (attempt === "primary" && this.hasActiveTurn(id)) throw this.deliveryFailure(new TurnDeliveryError("agent_not_idle", String(turn.turnId), attempt, "Agent already has an active turn."));
    if (identity.status !== "idle" && !(attempt === "repair" && existing)) throw this.deliveryFailure(new TurnDeliveryError("agent_not_idle", String(turn.turnId), attempt, `Agent is ${identity.status}.`));

    const sentAtMs = Date.now();
    // Idle deadline: the turn's `deadline` is the absolute cap; when `idleMs` is set
    // the timer is armed at now+idleMs and re-armed (up to the cap) on every result-dir
    // write, so a turn that keeps producing output is not killed by a fixed wall clock,
    // while a truly silent agent still fails after idleMs. Absent idleMs preserves the
    // old fixed-deadline behavior.
    const capMs = turn.deadline.getTime();
    const idleMs = turn.idleMs;
    const rearmIdle = idleMs === undefined ? undefined : () => {
      if (!this.turns.has(key)) return;
      const next = Math.min(Date.now() + idleMs, capMs);
      if (next > Date.now()) this.deadlines.arm(String(turn.turnId), new Date(next), attempt);
    };
    const watcher = new ResultFileWatcher(turn.resultPath, { turnDir: dirname(turn.resultPath), sentAtMs, maxBytes: this.config.artifactSizeLimitBytes, pollIntervalMs: this.config.pollIntervalMs, debounceMs: this.config.watchDebounceMs }, (signal) => this.emitSignal({ ...signal, workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id) } as RuntimeSignal), rearmIdle);
    if (turn.deadline.getTime() > Date.now()) watcher.start();
    const command = `Read ${turn.promptPath} and write the ${turn.attempt === "repair" ? "repair " : ""}result to ${turn.resultPath}; schema=${turn.schemaId}; nonce=${turn.nonce}; promptHash=${turn.promptHash}`;
    try {
      await this.options.client.sendAgent(identity.paneId, command, turn.promptHash, this.config.operationTimeoutMs, this.options.cli);
    } catch (error) {
      watcher.stop();
      throw this.deliveryFailure(new TurnDeliveryError("transport_error", String(turn.turnId), attempt, error instanceof Error ? error.message : String(error)));
    }
    const context = this.turns.get(key);
    if (context) { context.request = turn; context.sentAtMs = sentAtMs; context.repairUsed = true; context.resultSeen = false; context.resultRead = false; context.watcher.stop(); context.watcher = watcher; }
    else this.turns.set(key, { agentId: id, request: turn, watcher, sentAtMs, cancelled: false, repairUsed: attempt === "repair", resultSeen: false, resultRead: false });
    this.identity.setStatus(id, "working");
    const initialDeadline = idleMs === undefined ? turn.deadline : new Date(Math.min(sentAtMs + idleMs, capMs));
    this.deadlines.arm(String(turn.turnId), initialDeadline, attempt);
    const remainingMs = turn.deadline.getTime() - Date.now();
    if (remainingMs <= 0) return { turnId: turn.turnId, promptHash: turn.promptHash, deliveredAt: new Date(sentAtMs).toISOString() };
    void watcher.wait(remainingMs).then((artifact) => {
      const current = this.turns.get(key);
      if (current) current.resultSeen = true;
      this.emitSignal(RuntimeSignalSchema.parse({
        signalId: signalId(), kind: "ResultFileSeen", classification: "observation", observedAt: new Date().toISOString(), source: "fs_watch",
        workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id), artifactPath: artifact.path, size: artifact.size, contentHash: artifact.hash,
      }));
    }).catch((error) => {
      if (error instanceof ArtifactRejectedError || error instanceof ResultWatchStoppedError || error instanceof ResultWatchTimeoutError) return;
      if (error instanceof ResultWatchError) {
        this.emitSignal(RuntimeSignalSchema.parse({ signalId: signalId(), kind: "ResultWatchFailed", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: turn.workflowId, iterationId: turn.iterationId, turnId: String(turn.turnId), agentId: String(id), artifactPath: turn.resultPath, rawError: error.message }));
        const current = this.turns.get(key);
        if (current) this.moveToOrphans(key, current, true);
      }
    });
    return { turnId: turn.turnId, promptHash: turn.promptHash, deliveredAt: new Date(sentAtMs).toISOString() };
  }

  async wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal> {
    const timeout = Math.max(0, timeoutMs);
    void this.options.client.waitAgent(this.identity.get(id)?.paneId ?? "", timeout).then((raw) => { if (raw) this.handleAgentStatus(id, raw); }).catch(() => undefined);
    return new Promise<RuntimeSignal>((resolve, reject) => {
      const key = String(turnId);
      const queue = this.signalQueues.get(key);
      if (queue?.length) { const signal = queue.shift()!; if (!queue.length) this.signalQueues.delete(key); resolve(signal); return; }
      const waiter = (signal: RuntimeSignal) => { clearTimeout(timer); resolve(signal); };
      const timer = setTimeout(() => { const waiters = this.signalWaiters.get(key) ?? []; const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); if (!waiters.length) this.signalWaiters.delete(key); reject(new Error(`Timed out waiting for signal for ${String(turnId)}.`)); }, timeout);
      const waiters = this.signalWaiters.get(key) ?? []; waiters.push(waiter); this.signalWaiters.set(key, waiters);
    });
  }

  /** Returns raw bytes and a pre-parse hash; envelope and schema validation belongs to Extraction. */
  async result(id: AgentId, turnId: TurnId): Promise<TurnResult> {
    const key = this.turnKey(id, turnId);
    const context = this.turns.get(key) ?? this.orphanTurns.get(key);
    if (!context) throw this.watchFailure(new ResultWatchError(String(turnId), "No active turn artifact path is known."));
    try {
      const artifact = await readSafeArtifact(context.request.resultPath, { turnDir: dirname(context.request.resultPath), sentAtMs: context.sentAtMs, maxBytes: this.config.artifactSizeLimitBytes, pollIntervalMs: this.config.pollIntervalMs, debounceMs: this.config.watchDebounceMs });
      context.resultRead = true;
      this.signalQueues.delete(String(turnId));
      if (context.cancelled) this.orphanTurns.delete(key);
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
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.options.client.close();
    this.deadlines.dispose();
    for (const context of this.turns.values()) context.watcher.stop();
    for (const context of this.orphanTurns.values()) context.watcher.stop();
    this.turns.clear();
    this.orphanTurns.clear();
    this.signalQueues.clear();
    this.signalWaiters.clear();
  }

  private async control(id: AgentId, action: "interrupt" | "stop") {
    const identity = this.identity.get(id);
    if (identity?.paneId) {
      try { if (action === "interrupt") await this.options.client.interruptAgent(identity.paneId, this.config.operationTimeoutMs); else await this.options.client.stopAgent(identity.paneId, this.config.operationTimeoutMs); }
      catch (error) { throw this.deliveryFailure(new TurnDeliveryError("transport_error", "control", "primary", error instanceof Error ? error.message : String(error))); }
    }
    for (const [key, context] of [...this.turns]) {
      if (context.agentId !== id) continue;
      context.cancelled = true;
      this.moveToOrphans(key, context);
    }
    this.identity.setStatus(id, "idle");
  }

  private async waitForAgentReady(paneId: string, provider: string): Promise<HerdrAgent> {
    const deadline = Date.now() + this.config.operationTimeoutMs;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      const agents = await this.options.client.listAgents(
        Math.max(1, deadline - Date.now()),
      );
      const agent = agents.find((candidate) => candidate.pane_id === paneId);
      if (agent) {
        const status = normalizeStatus(agent).normalizedStatus;
        lastStatus = status;
        if (status === "idle") return agent;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.config.pollIntervalMs, remaining)),
      );
    }

    throw new AgentSpawnError(
      "spawn_error",
      provider,
      `Agent pane ${paneId} did not become ready within ${this.config.operationTimeoutMs}ms (last status: ${lastStatus}).`,
    );
  }

  private subscribe() {
    this.unsubscribe = this.options.client.onEvent((event) => consumeEvent(event, this.identity, (signal) => {
      if (signal.kind === "HerdrStatusChanged") {
        const identity = signal.agentId ? this.identity.get(signal.agentId as AgentId) : undefined;
        const status: StatusEvent = { agentId: signal.agentId as AgentId | null, paneId: identity?.paneId ?? "", rawStatus: signal.rawStatus, normalizedStatus: signal.normalizedStatus, completionCandidate: signal.hints.completionCandidate, resultCheckRequested: signal.hints.resultCheckRequested };
        for (const handler of this.statusHandlers) handler(status);
      }
      this.emitSignal(signal);
    }));
  }

  private handleAgentStatus(id: AgentId, raw: HerdrAgent) {
    const identity = this.identity.get(id); const normalized = normalizeStatus(raw, String(id));
    this.identity.updateFromHerdr(raw, normalized.normalizedStatus);
    const event: StatusEvent = { agentId: id, paneId: raw.pane_id, rawStatus: normalized.rawStatus, normalizedStatus: normalized.normalizedStatus, completionCandidate: normalized.completionCandidate, resultCheckRequested: normalized.resultCheckRequested };
    for (const handler of this.statusHandlers) handler(event);
  }

  private emitSignal(signal: RuntimeSignal) {
    const parsed = RuntimeSignalSchema.parse(signal); this.receivedSignals.push(parsed);
    if (this.receivedSignals.length > this.config.signalHistoryLimit) this.receivedSignals.splice(0, this.receivedSignals.length - this.config.signalHistoryLimit);
    const turnId = parsed.turnId; if (!turnId) return;
    const waiters = this.signalWaiters.get(turnId);
    const waiter = waiters?.shift();
    if (waiters?.length === 0) this.signalWaiters.delete(turnId);
    if (waiter) waiter(parsed);
    else if (this.findTurnContext(turnId)) {
      const queue = this.signalQueues.get(turnId) ?? [];
      queue.push(parsed);
      if (queue.length > this.config.signalQueueLimit) queue.splice(0, queue.length - this.config.signalQueueLimit);
      this.signalQueues.set(turnId, queue);
    }
    if (parsed.kind === "DeadlineExpired") {
      const key = this.findTurnKey(turnId);
      const context = key ? this.turns.get(key) : undefined;
      if (key && context) this.moveToOrphans(key, context, true);
    }
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
  private hasActiveTurn(id: AgentId): boolean { return [...this.turns.values()].some((context) => context.agentId === id && !context.resultRead); }
  private pruneReadTurns(id: AgentId): void {
    for (const [key, context] of [...this.turns]) if (context.agentId === id && context.resultRead) this.cleanupTurn(key, context);
  }
  private findTurnContext(turnId: string): TurnContext | undefined { return [...this.turns.values(), ...this.orphanTurns.values()].find((context) => String(context.request.turnId) === turnId); }
  private findTurnKey(turnId: string): string | undefined {
    for (const [key, context] of this.turns) if (String(context.request.turnId) === turnId) return key;
    for (const [key, context] of this.orphanTurns) if (String(context.request.turnId) === turnId) return key;
    return undefined;
  }
  private cleanupTurn(key: string, context: TurnContext, keepQueue = false): void {
    context.watcher.stop();
    this.deadlines.cancel(String(context.request.turnId));
    this.turns.delete(key);
    if (!keepQueue) this.signalQueues.delete(String(context.request.turnId));
    this.identity.setStatus(context.agentId, "idle");
  }
  private moveToOrphans(key: string, context: TurnContext, keepQueue = false): void {
    this.cleanupTurn(key, context, keepQueue);
    this.orphanTurns.set(key, context);
    while (this.orphanTurns.size > this.config.orphanTurnLimit) {
      const oldest = this.orphanTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.orphanTurns.delete(oldest);
    }
  }
  private async findMissedResults(): Promise<string[]> {
    const missed: string[] = [];
    for (const [key, context] of [...this.turns, ...this.orphanTurns]) {
      try {
        const artifact = await readSafeArtifact(context.request.resultPath, { turnDir: dirname(context.request.resultPath), sentAtMs: context.sentAtMs, maxBytes: this.config.artifactSizeLimitBytes, pollIntervalMs: this.config.pollIntervalMs, debounceMs: this.config.watchDebounceMs });
        missed.push(artifact.path);
        if (!context.resultSeen) {
          context.resultSeen = true;
          this.emitSignal(RuntimeSignalSchema.parse({ signalId: signalId(), kind: "ResultFileSeen", classification: "observation", observedAt: new Date().toISOString(), source: "reconcile", workflowId: context.request.workflowId, iterationId: context.request.iterationId, turnId: String(context.request.turnId), agentId: String(context.agentId), artifactPath: artifact.path, size: artifact.size, contentHash: artifact.hash }));
        }
        if (context.cancelled) this.orphanTurns.delete(key);
      } catch (error) {
        if (error instanceof ArtifactRejectedError || (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
    }
    return missed;
  }
  private turnKey(id: AgentId, turnId: TurnId) { return `${String(id)}:${String(turnId)}`; }
}
