import type { PlatformEvent } from "@platform/contracts";
import type { PersistenceStore } from "./store.js";
import type { StoredEvent } from "./types.js";

/**
 * Consumers must be idempotent by eventId. Dispatch is at-least-once: a
 * consumer that succeeds before another consumer fails will receive the same
 * event again when the event is retried.
 */
export type EventConsumer = (event: PlatformEvent, stored: StoredEvent) => void;

export class OutboxDispatchError extends Error {
  constructor(readonly eventId: string, cause: unknown) {
    super(`Dispatch failed for event ${eventId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OutboxDispatchError";
  }
}

export class OutboxDispatcher {
  private readonly consumers = new Set<EventConsumer>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: PersistenceStore) {}

  addConsumer(consumer: EventConsumer): () => void {
    this.consumers.add(consumer);
    return () => this.consumers.delete(consumer);
  }

  dispatchOnce(): number {
    let dispatched = 0;
    for (const stored of this.store.listUndispatchedEvents()) {
      try {
        for (const consumer of this.consumers) consumer(stored.event, stored);
      } catch (error) {
        throw new OutboxDispatchError(stored.eventId, error);
      }
      if (this.store.markEventDispatched(stored.eventId)) dispatched += 1;
    }
    return dispatched;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      try { this.dispatchOnce(); } catch { /* The next tick retries the unmarked event. */ }
      this.timer = setTimeout(tick, this.store.config.dispatcherRetryBackoffMs);
    };
    tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
