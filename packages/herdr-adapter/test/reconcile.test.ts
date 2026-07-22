import assert from "node:assert/strict";
import test from "node:test";
import { agentId, type RuntimeSignal } from "@platform/contracts";
import { withConfig } from "../src/config.js";
import { IdentityMap } from "../src/identity.js";
import { Reconciler } from "../src/reconcile.js";
import { FakeHerdr } from "./fake-herdr.js";

test("reconciliation uses snapshot and agent list and emits a delta", async () => {
  const fake = new FakeHerdr(); const raw = await fake.startAgent({ provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false }, 100);
  const identity = new IdentityMap(); identity.bind({ agentId: agentId("agent-1"), paneId: raw.pane_id, workflowId: raw.workspace_id, provider: "codex", role: "reviewer", status: "working" });
  const signals: unknown[] = []; const result = await new Reconciler(fake, identity, (signal) => signals.push(signal), withConfig({ reconnectBackoffMs: [], operationTimeoutMs: 100 })).resync();
  assert.equal(result.signal.kind, "SnapshotReconciled"); assert.equal(signals.length, 1); assert.deepEqual(identity.get(agentId("agent-1"))?.status, "idle");
});

test("reconciliation binds a newly discovered pane without using pane_id as identity", async () => {
  const fake = new FakeHerdr(); await fake.startAgent({ provider: "codex", role: "reviewer", workspaceId: "workspace-1", worktreeRequired: false }, 100);
  const identity = new IdentityMap(); const result = await new Reconciler(fake, identity, () => {}, withConfig({ reconnectBackoffMs: [], operationTimeoutMs: 100 })).resync();
  assert.equal(result.signal.kind, "SnapshotReconciled");
  const signal = result.signal as Extract<RuntimeSignal, { kind: "SnapshotReconciled" }>;
  assert.equal(signal.delta.agentsAdded.length, 1);
  assert.equal(identity.values().length, 1);
  assert.notEqual(identity.values()[0].agentId, identity.values()[0].paneId);
});

test("reconciliation reports results found by its scan callback", async () => {
  const fake = new FakeHerdr(); const identity = new IdentityMap();
  const result = await new Reconciler(fake, identity, () => {}, withConfig({ reconnectBackoffMs: [], operationTimeoutMs: 100 }), async () => ["runs/workflow/iteration/turn/result.toon"]).resync();
  const signal = result.signal as Extract<RuntimeSignal, { kind: "SnapshotReconciled" }>;
  assert.deepEqual(signal.delta.missedResultsFound, ["runs/workflow/iteration/turn/result.toon"]);
});
