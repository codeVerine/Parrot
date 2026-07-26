# Plan (iteration 1): Expand Phase 3 (Durable Event Log and Persistence) into a Full Technical Document

## 1. Context and Sources

The phase split and the Phase 1 / Phase 2 artifacts this plan builds on are the two approved plans:

- `approved-plans/task-20260718-043855-83ecd8/plan.md` - split the V2 architecture (`Multi-Agent-Orchestration-Architecture-v0.2.md`) into seven phases under `docs/phases/` and specified the twelve required sections of the Phase 1 contracts doc, including the twelve v1 platform events.
- `approved-plans/task-20260718-065524-90fca8/plan.md` - specified the Phase 2 (Herdr Runtime Adapter) doc in full, plus a concrete Phase 1 backfill: the complete runtime-signal taxonomy (four observation kinds, seven fault kinds, common signal envelope), the turn artifact layout, and the result envelope contract.

Per the approved split, Phase 3 is **Durable Event Log and Persistence**: SQLite (WAL) schema for all tables in V2 section 6.9; transactional outbox (persist-then-dispatch); runtime signals persisted separately from platform events; idempotent consumers; replay/fold; recovery tests that kill and restart mid-turn and require identical folded state; Drizzle ORM setup. Depends on Phase 1 (event schema); can proceed in parallel with Phase 2. (V2 sections 2 "Persist then dispatch", 6.2, 6.9, 10, 12.)

Current repo state: `docs/phases/` still does not exist; the two approved plans' execution artifacts were never written. The approved plans are therefore the authoritative Phase 1/2 artifacts, and this execution must preserve dependency order the same way the Phase 2 plan did: if `docs/phases/` is still absent at execution time, backfill the Phase 1 and Phase 2 docs (and skeletons) exactly per the two approved plans first, then write the Phase 3 doc. If the docs exist by then, only Phase 3 is written and the README status row updated. Nothing in the Phase 3 doc may contradict the approved plans; where this plan needs Phase 1/2 detail (event names, signal kinds, envelope fields) it cites them rather than inventing.

The V2 document remains the source architecture. The Phase 3 doc references V2 section numbers (2, 5, 6.2, 6.3, 6.9, 10) instead of duplicating rationale. Deliberate inline duplication exceptions, each with a "source:" marker: the table list from V2 section 6.9, the twelve-event enumeration (source: approved Phase 1 plan section 4), and the signal-kind list (source: approved Phase 2 plan section 3).

## 2. Deliverables

```
docs/
  phases/
    README.md                            (index; Phase 3 status set to "detailed")
    phase-1-contracts-and-schemas.md     (backfill if absent, per approved plan 83ecd8 section 4 + 90fca8 section 3)
    phase-2-herdr-runtime-adapter.md     (backfill if absent, per approved plan 90fca8 section 5)
    phase-3-event-log-and-persistence.md (full detail - the deliverable of this task)
    phase-4-workflow-engine.md           (skeleton, if absent)
    phase-5-llm-boundary-components.md   (skeleton, if absent)
    phase-6-frontier-review-dashboard-cost.md (skeleton, if absent)
    phase-7-implementation-agents-and-mvp.md  (skeleton, if absent)
```

No source code in this turn. Documentation only.

## 3. Contracts Consumed from Phases 1 and 2

The Phase 3 doc consumes, and may not redefine:

- **Platform event enumeration** (Phase 1): the twelve v1 events - `TurnCompleted`, `TurnFailed`, `AgentTimedOut`, `ObjectionRaised`, `ObjectionResolved`, `ConsensusReached`, `HumanApproved`, `HumanRejected`, `ImplementationBlocked`, `BudgetCapReached`, `IterationCapReached`, `OrphanResultSeen` - each with unique event ID and correlation fields (`workflowId`, `iterationId`, `turnId`, `agentId`).
- **Runtime-signal taxonomy** (Phase 1 schema, Phase 2 emitter): common signal envelope (signal ID, `kind`, `observedAt`, `source`, nullable correlation fields); observation kinds `HerdrStatusChanged`, `ResultFileSeen`, `DeadlineExpired`, `SnapshotReconciled`; fault kinds `AgentSpawnFailed`, `TurnDeliveryFailed`, `ResultWatchFailed`, `ArtifactRejected`, `ReconnectFailed`, `ProtocolMismatch`, `DegradedModeEntered`.
- **Turn artifact layout and envelope** (Phase 1): `runs/<workflowId>/<iterationId>/<turnId>/`, prompt content hash, artifact hash recorded before validation - these hashes and paths are what the `artifacts` table stores.
- **Identity-map invariants** (Phase 2 section 5.4): the in-memory `agentId ↔ pane_id`, `workflowId ↔ workspace_id`, session-identity shape that the `agents` table must persist; `pane_id` is never agent identity.
- **Timer re-derivation requirement** (Phase 2 section 5.7): after restart, turn deadline timers are re-derived from turn rows, never from memory - so the `turns` table must store the deadline and the attempt scope (primary vs repair).

## 4. Required Content of `phase-3-event-log-and-persistence.md`

### 4.1 Goal and Non-Goals

- Goal: SQLite as the single source of truth; a durable, replayable event log with the transactional outbox pattern; schema and access layer for every table in V2 section 6.9.
- Non-goals: no workflow decisions (the fold and the state machine guards are Phase 4 logic; Phase 3 provides the log and the fold *mechanism*), no Herdr calls (Phase 2), no LLM calls, no dashboard read models beyond what the tables naturally expose (Phase 6).

### 4.2 Signal/Event Separation as a Storage Rule

Restate the V2 section 6.2 split as a persistence invariant: `runtime_signals` and `events` are separate tables; a runtime signal is never a workflow fact until the Phase 4 state machine reduces it and appends a platform event in the same transaction as its state change. Runtime signals are stored with full provenance (source, raw payload) for audit and replay-divergence debugging (V2 section 10, "Replay/recovery divergence" row). No component other than the workflow engine writes to `events`.

### 4.3 Table Schemas

One subsection per table (source: V2 section 6.9 table list), each with columns, types, primary key, foreign keys, uniqueness constraints, and indexes:

- `workflows`, `iterations`, `turns`: the identity spine. `turns` carries turn state (the Phase 4 state enum from V2 section 6.3, stored as text), `deadlineAt`, attempt scope (`primary | repair`), prompt hash, nonce, and prompt-version reference - the columns Phase 2 timer re-derivation and Phase 5 prompt provenance require.
- `runtime_signals`: signal envelope columns (signal ID unique, `kind`, `observedAt`, `source`, nullable correlation columns), payload as TOON text. Indexed by `turnId` and `observedAt`.
- `events`: append-only platform event log. Unique event ID, event type, correlation columns, payload as TOON text, monotonic sequence (rowid/autoincrement) for total order, `dispatchedAt` nullable (outbox marker). Append-only enforced by policy and a guard trigger (no UPDATE/DELETE except setting `dispatchedAt`).
- `agents`: identity mapping and session references per the Phase 2 invariants - `agentId` primary, current `pane_id`, `workspace_id`, provider, role, `agent_session_id`/`agent_session_path` nullable, liveness status, remap history reference.
- `requirements`: stable ID, source path, content hash, priority, external identifier (V2 section 6.9).
- `objections`, `decisions`, `human_feedback`: columns per the Phase 1 objection and decision schemas (severity, status, cluster ID, evidence refs; decision provenance block as structured columns plus TOON payload).
- `artifacts`: prompt/result paths, content hashes, turn correlation, orphan flag (orphan results linked to their original turn, V2 section 6.3).
- `usage_ledger`: provider, message ID (unique, for replay dedup), cache/input/output tokens as separate columns, pricing version, wall-clock duration, retry/repair/timeout counts, agent startup time (V2 section 6.10). Schema only; the parsing adapters are Phase 6.

Payload storage rule (source: V2 section 6.9): opaque structured payloads stored as TOON text unless a consumer requires JSON; columns that queries or constraints touch are promoted to real columns, never left inside payloads.

### 4.4 Transactional Outbox and Dispatch

- Persist-then-dispatch (V2 section 2): platform event appended in the same SQLite transaction as the state change; commit is the publication point.
- Dispatcher: after commit, an in-process dispatcher reads undispatched events in sequence order, invokes registered consumers, marks `dispatchedAt`. Delivery is at-least-once; crash between commit and dispatch is recovered by scanning for `dispatchedAt IS NULL` at startup.
- Consumer idempotency contract: every consumer keyed by unique event ID; redelivery must be a no-op. Stated as a rule consumers in Phases 4-6 must satisfy.
- In-process only: dispatch exists to wake workers; replay and recovery always read from the log. NATS/Redis explicitly out of scope until multi-process is real (V2 section 12).

### 4.5 Replay and Fold

- The fold mechanism: deterministic function from event sequence to folded workflow state; Phase 3 provides the fold runner (ordered scan by sequence, checkpoint support), Phase 4 provides the reducer.
- Determinism rules: fold consumes only `events` (never `runtime_signals`, never wall clock); any nondeterministic input is a contract violation.
- Startup recovery procedure: open DB, run fold to rebuild in-memory state, scan outbox for undispatched events, hand turn deadlines to the adapter for timer re-derivation, then resume.

### 4.6 SQLite Configuration and Drizzle Setup

- WAL mode, `synchronous` level, `busy_timeout`, foreign keys ON - each a stated config value with rationale.
- Single-writer discipline: all writes through one connection/queue; readers use WAL snapshots.
- Drizzle ORM schema modules mirroring 4.3; migration policy: forward-only migration files, schema version recorded in DB, startup refuses a newer-than-known schema version (mirrors the Phase 2 protocol-pin posture).

### 4.7 Retention and Growth

`runtime_signals` is the only unbounded high-volume table; define a retention/compaction policy decision (keep-forever default for MVP, config hook for pruning signals older than N days once their turns are terminal). `events` is never pruned in v1 - replay depends on it. Recorded as a Phase 3-owned decision.

### 4.8 Configuration Surface

Single table: key, type, default, consuming section. Minimum: DB path, WAL/synchronous settings, busy timeout, dispatcher batch size, dispatcher retry backoff, signal retention window.

### 4.9 Test Plan

- Round-trip tests per table via Drizzle: insert, read back, TOON payload intact.
- Outbox tests: event append and state change commit atomically (crash injected between write and commit leaves neither); crash between commit and dispatch redelivers exactly the undispatched events on restart.
- Idempotency tests: duplicate delivery of every event type to a reference consumer is a no-op.
- Replay tests: fold of a recorded event log yields identical state across two runs; fold ignores `runtime_signals` by construction.
- Recovery tests (V2 section 10 requirement): kill the process mid-turn at defined points (after signal persist, after event commit pre-dispatch, after dispatch), restart, require identical folded state and correctly re-derived deadline timers.
- Append-only tests: UPDATE/DELETE on `events` (other than `dispatchedAt`) rejected by the guard trigger.
- Migration tests: fresh-create and step-through-migrations produce identical schemas; startup against a newer schema version refuses.

### 4.10 Assigned Open Questions

None of the four V2 section 11 open questions land in Phase 3 (dedup quality → Phase 5, concurrency → Phase 2, reviewer pool → Phase 5, redaction → Phase 6). The doc records one Phase 3-owned decision: the retention/compaction policy of 4.7.

### 4.11 Dependencies and Interfaces to Other Phases

- Depends on Phase 1: platform event enumeration, signal taxonomy, objection/decision/requirements schemas, envelope and artifact-layout fields the tables persist.
- Consumes from Phase 2: runtime signals to persist; identity-map invariants for `agents`.
- Provides to Phase 4: event log, outbox dispatcher, fold runner, turn rows with state and deadlines.
- Provides to Phase 6: the tables its read models and cost ledger query.
- Parallel with Phase 2 per the approved split; the Phase 1 signal schema is the shared contract.

## 5. Execution Steps

1. If `docs/phases/` is absent: create `README.md`, backfill `phase-1-contracts-and-schemas.md` and `phase-2-herdr-runtime-adapter.md` per the two approved plans, and create the Phase 4-7 skeletons. If present: verify Phase 1/2 docs exist, else backfill the missing ones.
2. Write `docs/phases/phase-3-event-log-and-persistence.md` with the eleven sections in section 4 above, citing Phase 1/2 doc sections for events, signals, envelope, and identity map.
3. Update `README.md` index: Phase 3 → "detailed".
4. Stop. No code.

## 6. Risks

- **Backfill scope repeats**: two approved executions have not landed; this turn may write four detailed docs. Accepted for the same reason as the Phase 2 plan: dependency order beats turn granularity, and Phase 3 citing nonexistent Phase 1/2 docs would be worse.
- **Schema over-specification before Phase 4 exists**: turn-state enum and fold contract are consumed from V2 section 6.3 as-written; if Phase 4 changes them, the fix is a documented schema migration, not silent drift - the migration policy in 4.6 exists for exactly this.
- **Duplication drift**: inline enumerations (tables, events, signal kinds) carry "source:" markers pointing at V2 6.9 and the two approved plans.
- **TOON-payload opacity**: queryable fields trapped inside TOON payloads would force table scans; mitigated by the promotion rule in 4.3 (anything queried or constrained becomes a column).
