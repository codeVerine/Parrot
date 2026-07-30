import assert from "node:assert/strict";
import test from "node:test";
import { PersistenceStore } from "@platform/persistence";
import {
  findStoredAgent,
  findStoredAgentSession,
  workflowRoleAgentKey,
  workflowRoleAgentName,
} from "../src/agent-session.js";

test("workflow role agent names are Herdr-safe and workflow-scoped", () => {
  const first = workflowRoleAgentName("wf/a", "claude", "planner");
  const second = workflowRoleAgentName("wf_a", "claude", "planner");

  assert.match(first, /^claude-planner-[a-f0-9]{10}$/);
  assert.match(second, /^claude-planner-[a-f0-9]{10}$/);
  assert.notEqual(first, second);
});

test("findStoredAgentSession scopes provider sessions by workflow and role", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  const workspaceId = "workspace-1";

  store.saveAgent({
    agentId: workflowRoleAgentKey("wf-1", "planner"),
    paneId: "pane-1",
    workspaceId,
    provider: "claude",
    role: "planner",
    sessionId: "sess-1",
    status: "idle",
    remapHistory: [],
  });
  store.saveAgent({
    agentId: workflowRoleAgentKey("wf-2", "planner"),
    paneId: "pane-2",
    workspaceId,
    provider: "claude",
    role: "planner",
    sessionId: "sess-2",
    status: "idle",
    remapHistory: [],
  });

  assert.deepEqual(
    findStoredAgentSession(store, "wf-1", "planner", "claude", workspaceId),
    { sessionId: "sess-1", sessionPath: null },
  );
  assert.deepEqual(
    findStoredAgent(store, "wf-1", "planner", "claude", workspaceId),
    {
      paneId: "pane-1",
      resume: { sessionId: "sess-1", sessionPath: null },
    },
  );
  assert.deepEqual(
    findStoredAgentSession(store, "wf-2", "planner", "claude", workspaceId),
    { sessionId: "sess-2", sessionPath: null },
  );

  // Mismatched provider/workspace should not reattach a stale row.
  assert.equal(findStoredAgentSession(store, "wf-1", "planner", "codex", workspaceId), undefined);
  assert.equal(findStoredAgentSession(store, "wf-1", "planner", "claude", "workspace-2"), undefined);
});
