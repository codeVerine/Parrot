import assert from "node:assert/strict";
import test from "node:test";
import { OutboxDispatchError, OutboxDispatcher, PersistenceStore } from "../src/index.js";
import { sampleEvent } from "./helpers.js";

test("outbox dispatches in sequence and marks only successful deliveries", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.appendEvent(sampleEvent("event-1"));
  store.appendEvent({ ...sampleEvent("event-2"), occurredAt: "2026-07-19T10:00:02.000Z" });
  const delivered: string[] = [];
  const dispatcher = new OutboxDispatcher(store);
  dispatcher.addConsumer((event) => delivered.push(event.eventId));
  assert.equal(dispatcher.dispatchOnce(), 2);
  assert.deepEqual(delivered, ["event-1", "event-2"]);
  assert.equal(dispatcher.dispatchOnce(), 0);
  assert.equal(store.listUndispatchedEvents().length, 0);
  store.close();
});

test("a consumer failure leaves the event for at-least-once redelivery", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.appendEvent(sampleEvent());
  const dispatcher = new OutboxDispatcher(store);
  let shouldFail = true;
  let calls = 0;
  const remove = dispatcher.addConsumer(() => { calls += 1; if (shouldFail) throw new Error("consumer unavailable"); });
  assert.throws(() => dispatcher.dispatchOnce(), (error: unknown) => error instanceof OutboxDispatchError);
  assert.equal(store.listUndispatchedEvents().length, 1);
  shouldFail = false;
  assert.equal(dispatcher.dispatchOnce(), 1);
  assert.equal(calls, 2);
  assert.equal(store.listUndispatchedEvents().length, 0);
  remove();
  store.close();
});

test("a successful consumer receives a retry when another consumer fails", () => {
  const store = new PersistenceStore({ path: ":memory:" });
  store.appendEvent(sampleEvent());
  const dispatcher = new OutboxDispatcher(store);
  let successfulCalls = 0;
  let shouldFail = true;
  dispatcher.addConsumer(() => { successfulCalls += 1; });
  dispatcher.addConsumer(() => { if (shouldFail) throw new Error("consumer unavailable"); });

  assert.throws(() => dispatcher.dispatchOnce(), OutboxDispatchError);
  shouldFail = false;
  assert.equal(dispatcher.dispatchOnce(), 1);
  assert.equal(successfulCalls, 2);
  store.close();
});

test("outbox batching filters dispatched rows before applying the limit", () => {
  const store = new PersistenceStore({ path: ":memory:", dispatcherBatchSize: 1 });
  store.appendEvent(sampleEvent("event-1"));
  const dispatcher = new OutboxDispatcher(store);
  dispatcher.addConsumer(() => {});
  assert.equal(dispatcher.dispatchOnce(), 1);
  store.appendEvent({ ...sampleEvent("event-2"), occurredAt: "2026-07-19T10:00:02.000Z" });
  assert.equal(dispatcher.dispatchOnce(), 1);
  assert.equal(store.listUndispatchedEvents().length, 0);
  store.close();
});
