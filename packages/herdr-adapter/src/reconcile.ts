import { agentId, RuntimeSignalSchema, signalId, type RuntimeSignal } from "@platform/contracts";
import { randomUUID } from "node:crypto";
import type { HerdrClient } from "./client/socket.js";
import type { HerdrAgent } from "./client/types.js";
import { withConfig, type AdapterConfig } from "./config.js";
import { ReconnectError } from "./errors.js";
import { IdentityMap } from "./identity.js";
import { normalizeStatus } from "./status.js";

export type ReconcileResult = { agents: HerdrAgent[]; signal: RuntimeSignal; attempts: number };
export type MissedResultFinder = () => Promise<string[]>;

export class Reconciler {
  constructor(private readonly client: HerdrClient, private readonly identity: IdentityMap, private readonly emit: (signal: RuntimeSignal) => void, private readonly config: AdapterConfig = withConfig(), private readonly findMissedResults: MissedResultFinder = async () => []) {}

  async resync(): Promise<ReconcileResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, this.config.reconnectBackoffMs.length + 1); attempt += 1) {
      try {
        const snapshot = await this.client.sessionSnapshot(this.config.operationTimeoutMs);
        const agents = await this.client.listAgents(this.config.operationTimeoutMs);
        const before = new Set(this.identity.ids());
        const seen = new Set<string>(); const statusesCorrected: string[] = []; const agentsAdded: string[] = [];
        for (const agent of agents) {
          const current = this.identity.byPane(agent.pane_id) ?? (agent.agent_session_id ? this.identity.bySession(agent.agent_session_id) : undefined);
          const status = normalizeStatus(agent, current ? String(current.agentId) : null);
          const identity = current ?? this.identity.bind({ agentId: agentId(), paneId: agent.pane_id, workflowId: agent.workspace_id ?? snapshot.workspace_id ?? "unknown", provider: agent.agent ?? "unknown", role: "unknown", status: status.normalizedStatus, sessionId: agent.agent_session_id, sessionPath: agent.agent_session_path });
          if (current) {
            if (status.normalizedStatus !== current.status) statusesCorrected.push(String(current.agentId));
            this.identity.bind({ agentId: current.agentId, paneId: agent.pane_id, workflowId: agent.workspace_id ?? snapshot.workspace_id ?? current.workflowId, provider: current.provider, role: current.role, status: status.normalizedStatus, sessionId: agent.agent_session_id ?? current.sessionId, sessionPath: agent.agent_session_path ?? current.sessionPath });
          } else {
            agentsAdded.push(String(identity.agentId));
          }
          seen.add(String(identity.agentId));
        }
        const agentsRemoved = [...before].filter((id) => !seen.has(id));
        const missedResultsFound = await this.findMissedResults();
        const signal = RuntimeSignalSchema.parse({ signalId: signalId(), kind: "SnapshotReconciled", classification: "observation", observedAt: new Date().toISOString(), source: "reconcile", workflowId: snapshot.workspace_id ?? null, iterationId: null, turnId: null, agentId: null, delta: { agentsAdded, agentsRemoved, statusesCorrected, missedResultsFound } });
        this.emit(signal); return { agents, signal, attempts: attempt };
      } catch (error) { lastError = error; const backoff = this.config.reconnectBackoffMs[attempt - 1]; if (backoff !== undefined) await new Promise((resolve) => setTimeout(resolve, backoff)); }
    }
    const failure = new ReconnectError(this.config.reconnectBackoffMs.length + 1, lastError instanceof Error ? lastError.message : String(lastError));
    this.emit({ signalId: `signal-${randomUUID()}`, kind: "ReconnectFailed", classification: "fault", observedAt: new Date().toISOString(), source: "adapter_internal", workflowId: null, iterationId: null, turnId: null, agentId: null, attempts: failure.attempts, rawError: failure.message } as RuntimeSignal);
    throw failure;
  }
}
