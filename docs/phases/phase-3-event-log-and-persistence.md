# Phase 3: Event Log and Persistence

**Status: implemented**

Phase 3 makes SQLite the durable source of truth for platform state. The
implementation is `@platform/persistence` under `packages/persistence`.
It consumes the Phase 1 event and signal contracts and accepts runtime
signals from the Phase 2 adapter. It does not make workflow decisions or
call Herdr or an LLM.

## Storage Rules

- Runtime signals and platform events are separate tables. A signal is an
  observation or adapter fault until Phase 4 reduces it into a platform event.
- Platform events are appended in the same transaction as the state change
  that caused them. The transaction commit is the publication point.
- Structured payloads are stored as TOON text. Fields needed for lookup or
  constraints are promoted to ordinary SQLite columns.
- Event consumers are at-least-once and must be idempotent by `eventId`. A
  consumer may succeed before another consumer fails, so it must tolerate
  receiving the same event again on retry.
- Replay reads only the ordered `events` table. It never folds
  `runtime_signals` or current wall-clock time.

## Database

`PersistenceStore` uses Node's built-in `node:sqlite` `DatabaseSync` API.
This keeps the access layer dependency-light and makes the transaction and
append-only guarantees visible in the code. Node 22.13-22.x or Node 23.4+
is required; those are the first releases in their respective lines where
`node:sqlite` runs without the `--experimental-sqlite` flag.

The store enables:

- WAL journal mode for concurrent readers.
- `synchronous=NORMAL` by default, configurable to `FULL`.
- Foreign keys and a five-second busy timeout.
- Forward-only migrations recorded in `schema_migrations`.

Startup refuses a database whose recorded schema version is newer than the
package supports. The first migration creates:

`workflows`, `iterations`, `turns`, `runtime_signals`, `events`, `agents`,
`requirements`, `objections`, `decisions`, `human_feedback`, `artifacts`, and
`usage_ledger`.

The `events` table has an autoincrement sequence for total ordering and a
nullable `dispatched_at` outbox marker. A delete trigger rejects every delete.
An update trigger allows only the first transition from a null dispatch marker
to a timestamp; event identity, correlation, kind, and payload cannot change.

## Access Layer

`PersistenceStore.transaction()` exposes a small `PersistenceTransaction`
object. State writes such as `saveTurn` and `saveWorkflow` can be followed by
`appendEvent` in the same callback. Any thrown error rolls back both writes.

The store provides typed writes for every Phase 3 table, signal persistence,
event reads, undispatched-event reads, pending deadline reconstruction, and
recovery snapshots. Duplicate signal IDs, event IDs, and usage message IDs are
no-ops. The usage message ID is the replay-deduplication key.

Turn rows retain the explicit lifecycle state, deadline, attempt scope,
prompt hash, nonce, prompt version, and artifact paths needed by later phases.
`pendingDeadlines()` returns active turn deadlines so the Phase 2 adapter can
re-arm timers after a restart without trusting in-memory state.

## Outbox and Replay

`OutboxDispatcher` reads undispatched events in sequence order, invokes all
registered in-process consumers, and sets `dispatched_at` only after every
consumer succeeds. A consumer failure leaves the event visible for retry on
the next dispatch or process restart, including for consumers that already
succeeded during the failed attempt. Consumers therefore use `eventId` as
their idempotency key. The dispatcher has an optional polling loop; it does
not introduce NATS, Redis, or another multi-process broker.

`FoldRunner` scans events in sequence order and applies a caller-provided
deterministic reducer. It accepts a `{ sequence, state }` checkpoint, so a
future workflow engine can resume a fold without changing the event log.

Recovery opens the database, reconstructs undispatched events, returns active
turn deadlines, and leaves workflow reduction to the Phase 4 reducer.

## Tests

The package tests cover:

- Table creation and TOON payload round trips.
- Atomic rollback of state and event writes.
- Duplicate signal, event, and usage-record handling.
- Ordered outbox dispatch and redelivery after consumer failure.
- Append-only event enforcement.
- Deterministic replay and checkpoint folding.
- Restart recovery for outbox events and turn deadlines.
- At-least-once redelivery to consumers that already succeeded in a failed
  dispatch attempt.
- Refusal to open a newer schema version.

Retention is intentionally conservative for the MVP: events are never
pruned, because replay depends on them. Runtime signals are retained by
default; when `signalRetentionDays` is configured, `pruneSignals()` removes
only signals older than the window whose turns are terminal, plus turnless
adapter faults. This keeps the cleanup policy explicit and leaves the event
log untouched.
