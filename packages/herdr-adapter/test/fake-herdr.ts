import type { HerdrCli } from "../src/client/cli.js";
import type { HerdrClient } from "../src/client/socket.js";
import type { AgentStartSpec, HerdrAgent, HerdrEvent, HerdrSchema, HerdrSnapshot, IntegrationStatus } from "../src/client/types.js";

export class FakeHerdr implements HerdrClient, HerdrCli {
  readonly sentCommands: string[] = [];
  readonly agents = new Map<string, HerdrAgent>();
  failStart = false;
  failSnapshot = false;
  missingIntegrations: string[] = [];
  private subscribers = new Set<(event: HerdrEvent) => void>();
  private paneCounter = 0;

  async schema(_timeoutMs: number): Promise<HerdrSchema> {
    return { protocol: 16, schema_version: 1, event: { $defs: { EventData: { oneOf: Array.from({ length: 23 }, (_, index) => ({ properties: { type: { const: `event_${index}` } } })) } } } };
  }
  async integrationStatus(_timeoutMs: number): Promise<IntegrationStatus> {
    return { integrations: ["claude", "codex"].filter((name) => !this.missingIntegrations.includes(name)).map((name) => ({ name, installed: true })) };
  }
  async startAgent(spec: AgentStartSpec, _timeoutMs: number): Promise<HerdrAgent> {
    if (this.failStart) throw new Error("fake spawn failed");
    const agent: HerdrAgent = { pane_id: `pane-${++this.paneCounter}`, workspace_id: spec.workspaceId, agent: spec.provider, agent_status: "idle", agent_session_id: `session-${this.paneCounter}`, agent_session_path: `/tmp/session-${this.paneCounter}` };
    this.agents.set(agent.pane_id, agent); return agent;
  }
  async sendAgent(paneId: string, command: string, _timeoutMs: number): Promise<void> { if (!this.agents.has(paneId)) throw new Error("dead pane"); this.sentCommands.push(command); }
  async waitAgent(paneId: string, _timeoutMs: number) { return this.agents.get(paneId) ?? null; }
  async interruptAgent(_paneId: string, _timeoutMs: number) {}
  async stopAgent(_paneId: string, _timeoutMs: number) {}
  async sessionSnapshot(_timeoutMs: number): Promise<HerdrSnapshot> { if (this.failSnapshot) throw new Error("snapshot failed"); return { protocol: 16, workspace_id: "workspace-1", agents: [...this.agents.values()] }; }
  async listAgents(_timeoutMs: number) { if (this.failSnapshot) throw new Error("list failed"); return [...this.agents.values()]; }
  async subscribeEvents(onEvent: (event: HerdrEvent) => void, _timeoutMs: number) { this.subscribers.add(onEvent); return () => this.subscribers.delete(onEvent); }
  emit(event: HerdrEvent) { for (const subscriber of this.subscribers) subscriber(event); }
  setStatus(paneId: string, status: HerdrAgent["agent_status"]) { const agent = this.agents.get(paneId); if (!agent) throw new Error("unknown pane"); agent.agent_status = status; this.emit({ type: "pane_agent_status_changed", pane_id: paneId, workspace_id: agent.workspace_id, agent_status: status }); }
}
