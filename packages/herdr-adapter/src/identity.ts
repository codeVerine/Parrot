import type { AgentId } from "@platform/contracts";
import type { HerdrAgent } from "./client/types.js";
import type { NormalizedStatus } from "./status.js";

export type AgentIdentity = { agentId: AgentId; paneId: string; workflowId: string; provider: string; role: string; status: NormalizedStatus; sessionId: string | null; sessionPath: string | null };

export class IdentityMap {
  private readonly byAgentId = new Map<AgentId, AgentIdentity>();
  private readonly agentByPane = new Map<string, AgentId>();

  bind(input: { agentId: AgentId; paneId: string; workflowId: string; provider: string; role: string; status?: NormalizedStatus; sessionId?: string | null; sessionPath?: string | null }): AgentIdentity {
    const existing = this.byAgentId.get(input.agentId);
    if (existing && existing.paneId !== input.paneId) this.agentByPane.delete(existing.paneId);
    const identity = { ...existing, ...input, status: input.status ?? existing?.status ?? "unknown", sessionId: input.sessionId ?? existing?.sessionId ?? null, sessionPath: input.sessionPath ?? existing?.sessionPath ?? null };
    this.byAgentId.set(input.agentId, identity); this.agentByPane.set(input.paneId, input.agentId); return identity;
  }

  updateFromHerdr(agent: HerdrAgent, status: NormalizedStatus): AgentIdentity | null {
    const agentId = this.agentByPane.get(agent.pane_id); if (!agentId) return null;
    const current = this.byAgentId.get(agentId); if (!current) return null;
    const next = { ...current, status, sessionId: agent.agent_session_id ?? current.sessionId, sessionPath: agent.agent_session_path ?? current.sessionPath };
    this.byAgentId.set(agentId, next); return next;
  }

  removePane(paneId: string): AgentIdentity | null {
    const agentId = this.agentByPane.get(paneId); if (!agentId) return null;
    this.agentByPane.delete(paneId); const current = this.byAgentId.get(agentId); if (!current) return null;
    const next = { ...current, paneId: "", status: "unknown" as const }; this.byAgentId.set(agentId, next); return next;
  }

  get(agentId: AgentId) { return this.byAgentId.get(agentId); }
  byPane(paneId: string) { const id = this.agentByPane.get(paneId); return id ? this.byAgentId.get(id) : undefined; }
  values() { return [...this.byAgentId.values()]; }
  ids() { return [...this.byAgentId.keys()]; }
  snapshot() { return this.values().map((value) => ({ ...value })); }
}
