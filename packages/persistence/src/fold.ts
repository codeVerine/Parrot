import type { EventKind, PlatformEvent } from "@platform/contracts";
import type { PersistenceStore } from "./store.js";

export type FoldReducer<State> = (state: State, event: PlatformEvent & { kind: EventKind }) => State;
export type FoldCheckpoint<State> = { sequence: number; state: State };
export type FoldResult<State> = { state: State; sequence: number };

export function foldEvents<State>(events: Iterable<{ sequence: number; event: PlatformEvent & { kind: EventKind } }>, initial: State, reducer: FoldReducer<State>, checkpoint?: FoldCheckpoint<State>): FoldResult<State> {
  let state = checkpoint?.state ?? initial;
  let sequence = checkpoint?.sequence ?? 0;
  for (const entry of events) {
    if (entry.sequence <= sequence) continue;
    state = reducer(state, entry.event);
    sequence = entry.sequence;
  }
  return { state, sequence };
}

export class FoldRunner {
  constructor(private readonly store: PersistenceStore) {}

  run<State>(initial: State, reducer: FoldReducer<State>, checkpoint?: FoldCheckpoint<State>): FoldResult<State> {
    const events = this.store.listEvents({ afterSequence: checkpoint?.sequence ?? 0 });
    return foldEvents(events, initial, reducer, checkpoint);
  }
}
