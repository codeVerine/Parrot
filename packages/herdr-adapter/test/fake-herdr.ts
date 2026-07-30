import type { HerdrCli } from "../src/client/cli.js";
import type { HerdrClient } from "../src/client/socket.js";
import { HERDR_EVENT_TYPES, type AgentStartSpec, type HerdrAgent, type HerdrEvent, type HerdrSchema, type HerdrSnapshot, type IntegrationStatus, type PaneReadResult } from "../src/client/types.js";

/**
 * In-memory stand-in for a live Herdr daemon. It speaks the same {@link HerdrClient}
 * surface the socket client exposes, so runtime/reconcile tests exercise the real
 * post-transport shapes: `startAgent` takes wire `AgentStartParams`, `sendAgent` takes
 * `(target, text)`, status flows through `onEvent`, and there is no `agent.wait`.
 */
export class FakeHerdr implements HerdrClient, HerdrCli {
  readonly sentCommands: string[] = [];
  readonly agents = new Map<string, HerdrAgent>();
  readonly subscribedPanes: string[] = [];
  failStart = false;
  failSnapshot = false;
  missingIntegrations: string[] = [];
  startStatus: HerdrAgent["agent_status"] = "idle";
  readyAfterListCalls = 0;
  listAgentCalls = 0;
  /** Deterministic pane read text and revision per pane. */
  readonly paneTexts = new Map<string, string>();
  private paneRevisions = new Map<string, number>();
  private subscribers = new Set<(event: HerdrEvent) => void>();
  private paneCounter = 0;

  async schema(_timeoutMs: number): Promise<HerdrSchema> {
    return { protocol: 16, schema_version: 1, event: { $defs: { EventData: { oneOf: HERDR_EVENT_TYPES.map((type) => ({ properties: { type: { const: type } } })) } } } };
  }
  async integrationStatus(_timeoutMs: number): Promise<IntegrationStatus> {
    return { integrations: ["claude", "codex"].filter((name) => !this.missingIntegrations.includes(name)).map((name) => ({ name, installed: true })) };
  }
  readonly createdTabs: Array<{ workspaceId: string | null; label: string | null }> = [];
  private tabCounter = 0;
  async createTab(workspaceId: string | null, label: string | null, _timeoutMs: number): Promise<string> {
    this.createdTabs.push({ workspaceId, label });
    return `tab-${++this.tabCounter}`;
  }
  async startAgent(spec: AgentStartSpec, _timeoutMs: number): Promise<HerdrAgent> {
    if (this.failStart) throw new Error("fake spawn failed");
    const provider = spec.argv[0] ?? spec.name;
    const agent: HerdrAgent = { pane_id: `pane-${++this.paneCounter}`, workspace_id: spec.workspace_id ?? "workspace-1", agent: provider, name: spec.name, agent_status: this.startStatus, agent_session_id: `session-${this.paneCounter}`, agent_session_path: `/tmp/session-${this.paneCounter}` };
    this.agents.set(agent.pane_id, agent); return agent;
  }
  async sendAgent(target: string, text: string, _verificationMarker: string, _timeoutMs: number, _cli?: HerdrCli): Promise<void> {
    if (!this.agents.has(target)) throw new Error("dead pane");
    this.sentCommands.push(text);
    const revision = (this.paneRevisions.get(target) ?? 0) + 1;
    this.paneRevisions.set(target, revision);
  }
  async paneRun(_paneId: string, _command: string, _timeoutMs: number): Promise<void> {
    // Simulate successful pane run
  }
  async readPane(paneId: string, _timeoutMs: number): Promise<PaneReadResult> {
    const agent = this.agents.get(paneId);
    if (!agent) throw new Error("dead pane");
    const revision = this.paneRevisions.get(paneId) ?? 0;
    const text = this.paneTexts.get(paneId) ?? "";
    return {
      pane_id: paneId,
      workspace_id: agent.workspace_id,
      tab_id: "",
      source: "visible",
      format: "text",
      text,
      revision,
      truncated: false,
    };
  }
  async waitAgent(paneId: string, _timeoutMs: number) { return this.agents.get(paneId) ?? null; }
  async interruptAgent(_paneId: string, _timeoutMs: number) {}
  async stopAgent(_paneId: string, _timeoutMs: number) {}
  async sessionSnapshot(_timeoutMs: number): Promise<HerdrSnapshot> { if (this.failSnapshot) throw new Error("snapshot failed"); return { protocol: 16, workspace_id: "workspace-1", agents: [...this.agents.values()] }; }
  async listAgents(_timeoutMs: number) {
    if (this.failSnapshot) throw new Error("list failed");
    this.listAgentCalls += 1;
    if (this.readyAfterListCalls > 0 && this.listAgentCalls >= this.readyAfterListCalls) {
      for (const agent of this.agents.values()) {
        if (agent.agent_status === "unknown") agent.agent_status = "idle";
      }
    }
    return [...this.agents.values()];
  }
  async subscribeAgentStatus(paneId: string, _timeoutMs: number) { this.subscribedPanes.push(paneId); }
  onEvent(listener: (event: HerdrEvent) => void) { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; }
  close() { this.subscribers.clear(); }
  emit(event: HerdrEvent) { for (const subscriber of this.subscribers) subscriber(event); }
  setStatus(paneId: string, status: HerdrAgent["agent_status"]) { const agent = this.agents.get(paneId); if (!agent) throw new Error("unknown pane"); agent.agent_status = status; this.emit({ type: "pane_agent_status_changed", pane_id: paneId, workspace_id: agent.workspace_id, agent_status: status }); }
}
