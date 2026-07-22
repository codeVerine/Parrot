import assert from "node:assert/strict";
import test from "node:test";
import { FoldRunner, PersistenceStore, foldEvents } from "../src/index.js";
import { sampleEvent, sampleSignal, seedTurn } from "./helpers.js";

test("iterateEvents walks the full log without the default list cap", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  seedTurn(store);
  store.transaction((tx) => {
    for (let i = 0; i < 1_050; i += 1) {
      tx.appendEvent(sampleEvent(`event-iter-${i}`));
    }
  });
  assert.equal(store.listEvents({ workflowId: "workflow-1", limit: 100 }).length, 100);
  assert.equal([...store.iterateEvents({ workflowId: "workflow-1", batchSize: 100 })].length, 1_050);
  store.close();
});

test("fold reads only ordered platform events and is deterministic", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.recordSignal(sampleSignal());
  const first = store.appendEvent(sampleEvent("event-1"))!;
  const second = store.appendEvent({ ...sampleEvent("event-2"), kind: "TurnFailed", payload: { reason: "timeout" }, occurredAt: "2026-07-19T10:00:02.000Z" });
  const reducer = (state: string[], event: { kind: string }) => [...state, event.kind];
  const runner = new FoldRunner(store);
  const result = runner.run([], reducer);
  assert.deepEqual(result.state, ["TurnCompleted", "TurnFailed"]);
  assert.equal(result.sequence, second!.sequence);
  assert.deepEqual(runner.run([], reducer), result);
  assert.deepEqual(foldEvents([first!, second!], [], reducer, { sequence: first!.sequence, state: ["TurnCompleted"] }), { state: ["TurnCompleted", "TurnFailed"], sequence: second!.sequence });
  store.close();
});
