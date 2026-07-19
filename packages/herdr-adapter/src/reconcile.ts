import { RuntimeSignalSchema, signalId, type RuntimeSignal } from "@platform/contracts";
import { randomUUID } from "node:crypto";
import type { HerdrClient } from "./client/socket.js";
import type { HerdrAgent } from "./client/types.js";
import { withConfig, type AdapterConfig } from "./config.js";
import { ReconnectError } from "./errors.js";
import { IdentityMap } from "./identity.js";
import { normalizeStatus } from "./status.js";

export type ReconcileResult = { agents: HerdrAgent[]; signal: RuntimeSignal; attempts: number };

export class Reconciler {
  constructor(private readonly client: HerdrClient, private readonly identity: IdentityMap, private readonly emit: (signal: RuntimeSignal) => void, private readonly config: AdapterConfig = withConfig()) {}

  async resync(): Promise<ReconcileResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, this.config.reconnectBackoffMs.length + 1); attempt += 1) {
      try {
        const snapshot = await this.client.sessionSnapshot(this.config.operationTimeoutMs);
        const agents = await this.client.listAgents(this.config.operationTimeoutMs);
        const before = new Set(this.identity.ids());
        const knownPanes = new Set(this.identity.values().map((identity) => identity.paneId));
        const seen = new Set<string>(); const statusesCorrected: string[] = [];
        for (const agent of agents) {
          const current = this.identity.byPane(agent.pane_id); if (current) { seen.add(String(current.agentId)); const status = normalizeStatus(agent, String(current.agentId)); if (status.normalizedStatus !== current.status) statusesCorrected.push(String(current.agentId)); this.identity.updateFromHerdr(agent, status.normalizedStatus); }
        }
        const agentsAdded = agents.filter((agent) => !knownPanes.has(agent.pane_id)).map((agent) => agent.pane_id);
        const agentsRemoved = [...before].filter((id) => !seen.has(id));
        const signal = RuntimeSignalSchema.parse({ signalId: signalId(), kind: "SnapshotReconciled", classification: "observation", observedAt: new Date().toISOString(), source: "reconcile", workflowId: snapshot.workspace_id ?? null, iterationId: null, turnId: null, agentId: null, delta: { agentsAdded, agentsRemoved, statusesCorrected, missedResultsFound: [] } });
        this.emit(signal); return { agents, signal, attempts: attempt };
      } catch (error) { lastError = error; const backoff = this.config.reconnectBackoffMs[attempt - 1]; if (backoff !== undefined) await new Promise((resolve) => setTimeout(resolve, backoff)); }
    }
    const failure = new ReconnectError(this.config.reconnectBackoffMs.length + 1, lastError instanceof Error ? lastError.message : String(lastError));
    this.emit({ signalId: `signal-${randomUUID()}`, kind: "ReconnectFailed", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: null, iterationId: null, turnId: null, agentId: null, attempts: failure.attempts, rawError: failure.message } as RuntimeSignal);
    throw failure;
  }
}
