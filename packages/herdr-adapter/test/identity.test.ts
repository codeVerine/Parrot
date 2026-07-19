import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "@platform/contracts";
import { IdentityMap } from "../src/identity.js";

test("pane respawn remaps an existing platform identity", () => {
  const map = new IdentityMap(); const id = agentId("agent-1");
  map.bind({ agentId: id, paneId: "pane-a", workflowId: "workspace-1", provider: "codex", role: "reviewer" });
  map.bind({ agentId: id, paneId: "pane-b", workflowId: "workspace-1", provider: "codex", role: "reviewer" });
  assert.equal(map.get(id)?.paneId, "pane-b");
  assert.equal(map.byPane("pane-a"), undefined);
  assert.notEqual(map.get(id)?.agentId, "pane-b");
});
