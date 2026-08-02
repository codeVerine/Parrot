export const HERDR_EVENT_TYPES = [
  "workspace_created", "workspace_updated", "workspace_closed", "workspace_renamed", "workspace_moved", "workspace_focused",
  "worktree_created", "worktree_opened", "worktree_removed", "tab_created", "tab_closed", "tab_renamed", "tab_moved",
  "tab_focused", "pane_created", "pane_closed", "pane_focused", "pane_moved", "pane_output_changed", "pane_exited",
  "pane_agent_detected", "pane_agent_status_changed", "layout_updated",
] as const;

export type HerdrEventType = (typeof HERDR_EVENT_TYPES)[number];

/**
 * Normalized, flattened event as it reaches {@link consumeEvent}. The live socket
 * frames pushes as `{event: "pane.agent_status_changed", data: {...}}` with dotted
 * kinds; the transport translates the dotted kind into this underscore `type` and
 * spreads `data` before dispatching, so downstream code sees a single flat shape.
 */
export type HerdrEvent = {
  type: HerdrEventType;
  workspace_id?: string;
  pane_id?: string;
  agent?: string | null;
  agent_status?: HerdrAgentStatus;
  custom_status?: string | null;
  [key: string]: unknown;
};

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Adapter-normalized agent view (mapped from the wire {@link AgentInfo}). */
export type HerdrAgent = {
  agent?: string | null;
  agent_status?: HerdrAgentStatus;
  cwd?: string | null;
  name?: string | null;
  pane_id: string;
  terminal_id?: string | null;
  workspace_id: string;
  agent_session_id?: string | null;
  agent_session_path?: string | null;
};

export type HerdrSchema = {
  protocol?: number;
  schema_version?: number;
  event?: { $defs?: { EventData?: { oneOf?: Array<{ properties?: { type?: { const?: string } } }> } } };
  schemas?: { event?: { $defs?: { EventData?: { oneOf?: Array<{ properties?: { type?: { const?: string } } }> } } } };
  [key: string]: unknown;
};

export type IntegrationStatus = {
  integrations?: Array<{ name: string; installed?: boolean; available?: boolean; status?: string }>;
  [key: string]: unknown;
};

/** Result of `tab.create`: the new tab and its empty root shell pane. */
export type CreatedTab = {
  tabId: string;
  /** Empty shell pane created with the tab; reclaim after the first `agent.start` split. */
  rootPaneId: string;
};

/** Wire params for `agent.start` (Herdr protocol 16 `AgentStartParams`). */
export type AgentStartSpec = {
  name: string;
  argv: string[];
  cwd?: string | null;
  workspace_id?: string | null;
  tab_id?: string | null;
  /** When set, Herdr splits before spawning. When omitted with `tab_id`, Herdr 0.7.3 still defaults to `right`. */
  split?: "right" | "down" | null;
  env?: Record<string, string>;
  focus?: boolean;
};

/** Wire agent record returned by `agent.start` / `agent.get` / `agent.list`. */
export type AgentSessionInfo = { source: string; agent: string; kind: "id" | "path"; value: string };
export type AgentInfo = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  agent_status: HerdrAgentStatus;
  agent?: string | null;
  name?: string | null;
  cwd?: string | null;
  agent_session?: AgentSessionInfo | null;
  focused: boolean;
  revision: number;
};

/** Wire push payload for `pane.agent_status_changed` subscription events. */
export type PaneAgentStatusChangedData = {
  pane_id: string;
  workspace_id: string;
  agent_status: HerdrAgentStatus;
  agent?: string | null;
  custom_status?: string | null;
  display_agent?: string | null;
  title?: string | null;
  state_labels?: Record<string, string>;
};

export type HerdrSnapshot = {
  protocol?: number;
  workspace_id?: string;
  agents?: HerdrAgent[];
  [key: string]: unknown;
};

/** Wire result for `pane.read`. */
export type PaneReadResult = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: string;
  format: string;
  text: string;
  revision: number;
  truncated: boolean;
};
