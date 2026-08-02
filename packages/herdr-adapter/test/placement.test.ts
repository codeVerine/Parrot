import assert from "node:assert/strict";
import test from "node:test";
import { reclaimEmptyRootPane } from "../src/client/socket.js";
import { FakeHerdr } from "./fake-herdr.js";

test("createTab returns the empty root pane id alongside the tab id", async () => {
  const fake = new FakeHerdr();
  const tab = await fake.createTab("workspace-1", "parrot agents", 100);
  assert.equal(tab.tabId, "tab-1");
  assert.equal(tab.rootPaneId, "root-1");
});

test("reclaimEmptyRootPane closes the empty root after agent.start splits", async () => {
  const fake = new FakeHerdr();
  const tab = await fake.createTab("workspace-1", "parrot agents", 100);
  const agent = await fake.startAgent(
    { name: "claude-planner", argv: ["claude"], workspace_id: "workspace-1", tab_id: tab.tabId },
    100,
  );
  assert.notEqual(agent.pane_id, tab.rootPaneId);
  await reclaimEmptyRootPane(fake, tab.rootPaneId, agent.pane_id, 100);
  assert.deepEqual(fake.closedPanes, [tab.rootPaneId]);
});

test("reclaimEmptyRootPane is a no-op when the agent already owns the root pane", async () => {
  const fake = new FakeHerdr();
  await reclaimEmptyRootPane(fake, "pane-same", "pane-same", 100);
  assert.deepEqual(fake.closedPanes, []);
});
