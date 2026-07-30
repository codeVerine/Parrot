import { createHash } from "node:crypto";
import type { AgentSessionResume } from "@platform/herdr-adapter";
import type { PersistenceStore } from "@platform/persistence";

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export type StoredAgentSession = {
  paneId: string;
  resume: AgentSessionResume;
};

/** Stable key for workflow-scoped role metadata (sessions, worktrees, etc.). */
export function workflowRoleAgentKey(workflowId: string, roleId: string): string {
  return `${workflowId}:${roleId}`;
}

/** Herdr agent names are workspace-global, so include the workflow identity. */
export function workflowRoleAgentName(
  workflowId: string,
  provider: string,
  roleId: string,
): string {
  const clean = (value: string): string =>
    value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const workflowHash = createHash("sha256")
    .update(workflowId, "utf8")
    .digest("hex")
    .slice(0, 10);
  return `${clean(provider)}-${clean(roleId)}-${workflowHash}`;
}

/**
 * Find durable provider session metadata for a role when resuming a specific workflow.
 *
 * The `agents` table is keyed by `agent_id`, so this uses a workflow-scoped key
 * (`${workflowId}:${roleId}`) to avoid cross-workflow overwrite and accidental reattach.
 */
export function findStoredAgentSession(
  store: PersistenceStore,
  workflowId: string,
  roleId: string,
  provider: string,
  workspaceId: string,
): AgentSessionResume | undefined {
  const key = workflowRoleAgentKey(workflowId, roleId);
  const row = store.readRows("agents").find((candidate) => str(candidate.agent_id) === key);
  if (!row) return undefined;

  // Defensive: ignore mismatched providers/workspaces so a stale row cannot reattach
  // a role to the wrong runtime context.
  if (provider && str(row.provider) !== provider) return undefined;
  if (workspaceId && str(row.workspace_id) !== workspaceId) return undefined;
  if (roleId && str(row.role) !== roleId) return undefined;

  const sessionId = typeof row.agent_session_id === "string" ? row.agent_session_id : null;
  const sessionPath = typeof row.agent_session_path === "string" ? row.agent_session_path : null;
  if (!sessionId && !sessionPath) return undefined;
  return { sessionId, sessionPath };
}

export function findStoredAgent(
  store: PersistenceStore,
  workflowId: string,
  roleId: string,
  provider: string,
  workspaceId: string,
): StoredAgentSession | undefined {
  const key = workflowRoleAgentKey(workflowId, roleId);
  const row = store.readRows("agents").find((candidate) => str(candidate.agent_id) === key);
  if (!row) return undefined;
  if (provider && str(row.provider) !== provider) return undefined;
  if (workspaceId && str(row.workspace_id) !== workspaceId) return undefined;
  if (roleId && str(row.role) !== roleId) return undefined;

  const paneId = str(row.pane_id);
  if (!paneId) return undefined;
  return {
    paneId,
    resume: {
      sessionId: typeof row.agent_session_id === "string" ? row.agent_session_id : null,
      sessionPath: typeof row.agent_session_path === "string" ? row.agent_session_path : null,
    },
  };
}
