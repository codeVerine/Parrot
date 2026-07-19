export const HERDR_EVENT_TYPES = [
  "workspace_created", "workspace_updated", "workspace_closed", "workspace_renamed", "workspace_moved", "workspace_focused",
  "worktree_created", "worktree_opened", "worktree_removed", "tab_created", "tab_closed", "tab_renamed", "tab_moved",
  "tab_focused", "pane_created", "pane_closed", "pane_focused", "pane_moved", "pane_output_changed", "pane_exited",
  "pane_agent_detected", "pane_agent_status_changed", "layout_updated",
] as const;

export type HerdrEventType = (typeof HERDR_EVENT_TYPES)[number];

export type HerdrEvent = {
  type: HerdrEventType;
  workspace_id?: string;
  pane_id?: string;
  agent?: string | null;
  agent_status?: "idle" | "working" | "blocked" | "done" | "unknown";
  custom_status?: string | null;
  [key: string]: unknown;
};

export type HerdrAgent = {
  agent?: string | null;
  agent_status?: "idle" | "working" | "blocked" | "done" | "unknown";
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

export type AgentStartSpec = {
  provider: string;
  role: string;
  workspaceId: string;
  worktreeRequired: boolean;
  env?: Record<string, string>;
};

export type HerdrSnapshot = {
  protocol?: number;
  workspace_id?: string;
  agents?: HerdrAgent[];
  [key: string]: unknown;
};
