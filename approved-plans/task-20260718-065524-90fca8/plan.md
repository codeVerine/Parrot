# Plan (iteration 4): Expand Phase 2 (Herdr Runtime Adapter) into a Full Technical Document

## 0. Changes from Iteration 3

- **OBJ-004 (minor)**: the taxonomy wording was internally inconsistent about timeouts - it claimed every adapter error path emits a fault signal while mapping turn timeout to `DeadlineExpired`, an observation signal. Resolved by fixing the classification, not by reclassifying the signal: deadline expiry is an observed turn outcome (a timer fact about the agent's behavior), not an adapter-internal failure, so `DeadlineExpired` correctly stays an observation signal. The completeness claim is restated precisely: every *adapter-internal* error path emits exactly one fault signal; section 5.11 is retitled to a failure-path signal mapping covering both groups, with the timeout row explicitly marked as observation; section 5.12 renames the coverage test accordingly. No signal kinds changed.

Carried from earlier iterations: re-sequenced execution backfilling Phase 1 first (OBJ-001), verified 23-event list with provenance (OBJ-002), complete runtime-signal taxonomy with seven fault kinds (OBJ-003), and the human-directed cross-check against the existing Phase 1 plan (`approved-plans/task-20260718-043855-83ecd8/plan.md` section 4), which added repair-turn delivery, the validation-boundary split, and prompt-hash correlation.

## 1. Context

The approved plan `approved-plans/task-20260718-043855-83ecd8/plan.md` split the V2 architecture (`Multi-Agent-Orchestration-Architecture-v0.2.md`) into seven phases under `docs/phases/`. Phase 2 is the **Herdr Runtime Adapter**: the `AgentRuntime` implementation against Herdr 0.7.3 / protocol 16.

Current repo state: `docs/phases/` does not exist. The prior approved plan's execution artifacts were never written. This plan restores dependency order: Phase 1 doc first, Phase 2 doc second, both in this execution.

The V2 document remains the source architecture. Phase docs reference V2 section numbers (3, 5, 6.1, 6.2, 10) instead of duplicating rationale. Deliberate inline duplication exceptions, each carrying a "source:" marker: the status-normalization table, the startup-check list, and the verified event-type list.

The existing Phase 1 plan is a first-class review input: reviewers verify Phase 2 sections against its section 4 spec, not only against V2.

## 2. Deliverables

```
docs/
  phases/
    README.md                            (phase index table: phase, title, status, depends-on, V2 sections)
    phase-1-contracts-and-schemas.md     (backfill: full detail per approved plan section 4, twelve sections)
    phase-2-herdr-runtime-adapter.md     (full detail - the main deliverable of this task)
    phase-3-event-log-and-persistence.md (skeleton)
    phase-4-workflow-engine.md           (skeleton)
    phase-5-llm-boundary-components.md   (skeleton)
    phase-6-frontier-review-dashboard-cost.md (skeleton)
    phase-7-implementation-agents-and-mvp.md  (skeleton)
```

Skeletons contain: goal paragraph, scope bullets, dependencies, V2 section references, assigned open questions, "Status: skeleton" marker. No source code in this turn.

## 3. Phase 1 Backfill Specification

`phase-1-contracts-and-schemas.md` is written with the twelve sections enumerated in the approved plan (goal/non-goals; artifact layout; result envelope; platform event schema; role result schemas; objection schema; decision schema; requirements schema; versioning policy; validation and repair protocol; test plan; assigned open questions). Content is drawn from V2 sections 5, 6.2, 6.6, 6.9, and 8. The parts Phase 2 consumes must be concrete, not sketched:

- **Result envelope contract**: field list (`workflowId`, `iterationId`, `turnId`, `schemaVersion`, `nonce`, role payload) and rejection rules (envelope mismatch, missing nonce, stale turn).
- **Turn artifact layout**: `runs/<workflowId>/<iterationId>/<turnId>/` with `prompt.md` (immutable, hash-identified), `result.toon`, `repair-prompt.md`; atomic-write protocol; permission and ownership expectations.
- **Platform event enumeration**: the twelve v1 events named in the approved plan, with ID format, correlation fields, payload shape - so Phase 2 can state precisely which platform events its signals feed (`AgentTimedOut`, `TurnFailed`, `OrphanResultSeen`).
- **Runtime signal schema (complete taxonomy)**. Every signal shares a common envelope: unique signal ID (format defined here), `kind`, `observedAt`, `source` (herdr_event | fs_watch | deadline_timer | reconcile | adapter_internal), and correlation fields (`workflowId`, `iterationId`, `turnId`, `agentId` - each nullable, populated when known). Two disjoint kind groups:

  *Observation signals* (facts observed about agents, files, and timers - including negative outcomes like deadline expiry that are not adapter failures):
  | Kind | Payload highlights |
  |---|---|
  | `HerdrStatusChanged` | raw Herdr status preserved, normalized status, hint flags |
  | `ResultFileSeen` | artifact path, size, content hash (recorded before validation) |
  | `DeadlineExpired` | turn deadline, whether primary or repair-scoped attempt |
  | `SnapshotReconciled` | reconciliation delta (agents added/removed/status-corrected, missed results found) |

  *Fault signals* (adapter-internal failures: the adapter itself could not perform an operation or rejected an input; every adapter-internal error path emits exactly one of these):
  | Kind | Emitted when | Payload highlights |
  |---|---|---|
  | `AgentSpawnFailed` | `start()` fails: spawn error, missing integration, unsupported provider | reason enum, provider, raw error |
  | `TurnDeliveryFailed` | `send()` fails: dead pane, agent not idle, transport error | reason enum, turnId, attempt (primary/repair) |
  | `ResultWatchFailed` | fs watcher cannot be established or dies mid-turn | path, raw error |
  | `ArtifactRejected` | any pre-parse safety check fails | reason enum: `symlink \| ownership \| world_writable \| stale_mtime \| path_escape \| oversize`, path, observed value vs limit |
  | `ReconnectFailed` | reconnect or snapshot reconciliation fails after retries | attempt count, raw error |
  | `ProtocolMismatch` | startup or reconnect sees unpinned protocol/schema version | expected vs observed protocol and schema_version |
  | `DegradedModeEntered` | development mode proceeds despite missing required integrations | missing integrations list, disabled capabilities (restore, session-log features) |

  Classification rule, stated in the Phase 1 doc: a fault signal means "the adapter failed or refused"; an observation signal means "the adapter observed something", including unwelcome observations such as `DeadlineExpired`. Turn timeout is therefore an observation - the agent failed to deliver, the adapter worked correctly. Both groups are runtime signals, not platform events: the workflow engine decides what workflow fact (if any) each becomes (V2 section 6.2 signal/event split). The Phase 1 doc specifies this taxonomy; the Phase 2 doc consumes it and may not invent additional kinds.

## 4. Verified Herdr Event Types

Source: `herdr api schema --json`, herdr 0.7.3, protocol 16, `schema_version: 1`, extracted 2026-07-18 from the local binary. The `event.$defs.EventData.oneOf` union has exactly 23 variants:

| # | Event type | Adapter handling |
|---|---|---|
| 1 | `workspace_created` | ignored (identity map uses workspace_id at start only) |
| 2 | `workspace_updated` | ignored |
| 3 | `workspace_closed` | consumed: workflow-level teardown signal |
| 4 | `workspace_renamed` | ignored |
| 5 | `workspace_moved` | ignored |
| 6 | `workspace_focused` | ignored (UI concern) |
| 7 | `worktree_created` | consumed: worktree lifecycle correlation |
| 8 | `worktree_opened` | consumed: worktree lifecycle correlation |
| 9 | `worktree_removed` | consumed: worktree lifecycle correlation |
| 10 | `tab_created` | ignored |
| 11 | `tab_closed` | ignored |
| 12 | `tab_renamed` | ignored |
| 13 | `tab_moved` | ignored |
| 14 | `tab_focused` | ignored |
| 15 | `pane_created` | consumed: identity-map maintenance |
| 16 | `pane_closed` | consumed: identity-map maintenance |
| 17 | `pane_focused` | ignored |
| 18 | `pane_moved` | ignored |
| 19 | `pane_output_changed` | ignored for orchestration (display/debug only, per V2 "no read()") |
| 20 | `pane_exited` | consumed: agent-death detection |
| 21 | `pane_agent_detected` | consumed: identity-map maintenance, session identity capture |
| 22 | `pane_agent_status_changed` | consumed: status hint (normalized per section 5.5) |
| 23 | `layout_updated` | ignored |

The phase doc reproduces this table with the same provenance line and adds: "re-verify against `herdr api schema --json` whenever the pinned Herdr version changes; a count other than 23 or any renamed variant fails the protocol pin check." The consumed/ignored classification is adapter policy (this doc's decision), not Herdr fact, and is marked as such.

## 5. Required Content of `phase-2-herdr-runtime-adapter.md`

### 5.1 Goal and Non-Goals

- Goal: production-grade implementation of the `AgentRuntime` interface (V2 section 6.1), the only component speaking Herdr-specific APIs.
- Non-goals: no workflow logic, no persistence schema (Phase 3), no prompt construction (Phase 5), no LLM calls. The adapter emits runtime signals; it never decides workflow facts.

### 5.2 Interface Contract

Reproduce the `AgentRuntime` TypeScript interface verbatim from V2 section 6.1 and specify, per method:

- `start(spec)`: agent spec fields (provider, role, workspace, worktree requirement, env), returned `AgentHandle` contents, failure modes (spawn failure, integration missing, unsupported provider) - each emitting `AgentSpawnFailed` with its reason.
- `send(id, turn)`: `TurnRequest` fields as defined by the Phase 1 turn artifact contract (turnId, prompt path, prompt content hash, result path, schema id, nonce, deadline - cite Phase 1 doc section), `DeliveryReceipt` correlation semantics (receipt echoes turnId and prompt hash so delivery is correlated to the immutable prompt file, per the Phase 1 hash-identified prompt rule), behavior when the pane is dead or the agent is not idle (`TurnDeliveryFailed` with reason). `send` also carries repair turns: a repair send references `repair-prompt.md` in the same turn directory, reuses the turnId, and is flagged as the single bounded repair attempt defined by the Phase 1 repair protocol.
- `wait(id, turnId, timeoutMs)`: returns `RuntimeSignal` (Phase 1 schema), never blocks past `timeoutMs`, always passes explicit timeouts to Herdr (`events.wait`, `pane.wait_for_output`, `agent wait --status` defaults undocumented, V2 section 3).
- `result(id, turnId)`: returns raw artifact bytes plus hash after file-safety checks (5.6); parsing/validation belongs to Extraction & Validation (Phase 5 consumer of the Phase 1 contract).
- `onStatus(handler)`: normalized status events only (5.5).
- `resync()`: full reconciliation pass (5.8).
- `interrupt(id)` / `stop(id)`: semantics, idempotency, effect on in-flight turns (turn to `cancelled`; later artifacts become orphans, V2 section 5 step 8).

Restate: no `read()` in the orchestration interface; pane text is display/debug only.

### 5.3 Startup Checks

Ordered checklist with fail behavior:

1. Protocol version check via `herdr api schema --json`; refuse untested protocol (pin: 16, `schema_version` 1). Mismatch emits `ProtocolMismatch` and aborts.
2. Full `herdr integration status` run.
3. Required-integration verification: installed, not merely up to date. Production fails closed. Development mode may continue with restore guarantees disabled and session-log features (audit transcripts, usage extraction) marked unavailable, emitting `DegradedModeEntered` with the missing-integrations list and disabled capabilities.
4. License boundary note: socket API / CLI only; never embed or link Herdr (V2 section 3).

### 5.4 Identity Mapping

- Adapter-owned mapping: `agentId ↔ pane_id`, `workflowId ↔ workspace_id`, plus `agent_session_id` / `agent_session_path` when available.
- Hard rule: `pane_id` never used as agent identity. Remap procedure on pane respawn, on `pane_exited`, on `pane_agent_detected`.
- Session-identity integrations (Claude Code, Codex) vs none (Gemini): identity data available per case, degradation without it.
- Mapping persistence is Phase 3 (agents table); this doc defines the in-memory shape and invariants Phase 3 must store.

### 5.5 Status Normalization

- Canonical states: `idle | working | blocked | unknown`.
- Herdr `done`: raw value preserved in signal metadata, reduced to non-authoritative idle-like completion hint; may trigger early result check (V2 section 5 step 6), never completes a turn without the matching artifact.
- Normalization table (source: V2 section 3): each raw status (`idle`, `working`, `blocked`, `done`, `unknown`) to canonical state plus hint flags.
- All roster agents are screen-manifest heuristic: status is a hint, never a completion signal. Invariant, with pointer to V2 section 10 (status misdetection row).

### 5.6 Result-File Watching and Artifact Safety

- fs watch on turn directory for `result.toon`; ignore `result.tmp` and partials; atomic-rename contract per the Phase 1 artifact layout section. Watcher establishment failure or mid-turn watcher death emits `ResultWatchFailed` (and triggers a manual poll fallback until re-established, so a watcher crash cannot silently hang a turn).
- Pre-parse rejection checks, each emitting `ArtifactRejected` with its reason code: `symlink`, `ownership`, `world_writable`, `stale_mtime`, `path_escape` (after canonicalization), `oversize` (size limit as config with default).
- Artifact hash recorded before validation; travels with `ResultFileSeen`.
- Trust boundary: agent-written files untrusted even same-OS-user; hostile/multi-tenant requires per-agent sandboxes (deployment constraint, out of phase scope).
- Adapter does not parse TOON; delivers bytes + hash + turn correlation.
- Validation boundary, stated explicitly: the adapter enforces only the file-safety checks above. The Phase 1 envelope rejection rules (envelope mismatch, missing or wrong nonce, stale turn, `schemaVersion` check) require parsing and therefore belong to Extraction & Validation. The phase doc must state this split so neither component assumes the other performs a check.

### 5.7 Deadlines and Timeout Synthesis

- Deadline timer per turn, started at `send` acknowledgment.
- Expiry: adapter emits the observation signal `DeadlineExpired`; the workflow engine derives platform event `AgentTimedOut` (signal/event split per V2 section 6.2 and the Phase 1 event schema).
- `working → idle`/`done` without result file: early result check, short grace timer (config default), then failure signal. Completion candidate, never proof.
- Repair turns: when Extraction requests the single bounded repair (Phase 1 repair protocol), the adapter sends `repair-prompt.md` for the same turnId, re-arms the result watch, and starts a fresh deadline timer scoped to the repair attempt (`DeadlineExpired` carries the attempt marker); a second validation failure is Extraction's `TurnFailed`, not an adapter timeout.
- Timer persistence: re-derived after restart from turn deadlines stored by Phase 3, never from memory alone.

### 5.8 Reconnect Reconciliation

- On reconnect: `session.snapshot` + `agent.list` before resuming; diff against identity map; emit `SnapshotReconciled` with delta. Reconciliation failure after bounded retries emits `ReconnectFailed`.
- No cursor/replay in Herdr subscriptions: nothing durable depends on a live event having been observed; every live-event consumer states its reconciliation fallback.
- Missed-during-disconnect cases: agent finished (result file exists), agent died (missed `pane_exited`), status changed, worktree events missed.

### 5.9 Event Subscription

- `events.subscribe` with the verified 23-type table from section 4 of this plan (with provenance and re-verification rule), consumed vs ignored classification, and rationale per consumed type.
- Duplicate/out-of-order handling: unique signal IDs, idempotent downstream consumers, correlation by turnId (V2 section 10).

### 5.10 Configuration Surface

Single table: key, type, default, consuming section. Minimum: protocol pin, required integrations list, mode (production/development), turn deadline default, grace timer, artifact size limit, watch debounce, reconnect backoff.

### 5.11 Failure-Path Signal Mapping

A table in which every adapter failure path maps to exactly one named signal kind from the Phase 1 taxonomy (section 3). Adapter-internal errors map to fault signals; turn timeout is an observed agent outcome and maps to the observation signal `DeadlineExpired`, marked as such in the table. No unmapped failure paths; the adapter never fails silently.

| Failure path | Signal kind | Group | Reason codes |
|---|---|---|---|
| Spawn failure | `AgentSpawnFailed` | fault | `spawn_error \| integration_missing \| unsupported_provider` |
| Send failure | `TurnDeliveryFailed` | fault | `pane_dead \| agent_not_idle \| transport_error` |
| Watch failure | `ResultWatchFailed` | fault | - |
| Safety-check rejection | `ArtifactRejected` | fault | `symlink \| ownership \| world_writable \| stale_mtime \| path_escape \| oversize` |
| Turn timeout (agent outcome, not adapter error) | `DeadlineExpired` | observation | attempt marker: `primary \| repair` |
| Reconnect failure | `ReconnectFailed` | fault | - |
| Protocol/schema mismatch | `ProtocolMismatch` | fault | - |
| Degraded development mode | `DegradedModeEntered` | fault | - |

The phase doc states the completeness rule: adding an adapter failure path without a signal mapping is a contract violation caught by the test in 5.12 (every thrown adapter error class must appear in the mapping table).

### 5.12 Test Plan

- Contract tests against a fake Herdr socket implementing the protocol-16 surface the adapter uses.
- File-safety negative tests: one fixture per `ArtifactRejected` reason code.
- Failure-path signal coverage: one test per row of the 5.11 table forcing its emission path (spawn failure, dead-pane send, watcher kill mid-turn, each rejection, deadline expiry, reconnect failure, protocol mismatch, degraded mode); plus a completeness test asserting every adapter error class maps to a signal kind.
- Deadline tests: expiry, early-completion hint without artifact, grace-timer path.
- Repair-turn tests: repair send reuses turnId, re-arms watch, fresh repair-scoped deadline; only one repair attempt possible.
- Reconnect tests: each missed-event case reconciles to the same state as the live-event path.
- Restart tests: kill adapter mid-turn, restart, timers re-derived correctly.
- Schema-pin test: assert `herdr api schema --json` still yields protocol 16 with 23 `EventData` variants; gate real-binary tests behind an env flag.

### 5.13 Assigned Open Question

V2 section 11 remaining question 2: concurrency limits - workflows/agents per machine before Herdr session management degrades. Phase 2-owned. Measurement approach: scale test against real Herdr, tracking session-management latency and event delay. Answer becomes a documented config default, not code.

### 5.14 Dependencies and Interfaces to Other Phases

- Depends on Phase 1: turn artifact contract (envelope, nonce, paths), runtime-signal taxonomy (observation + fault signals), platform event enumeration - all concrete via the section 3 backfill.
- Provides to Phase 3: runtime signals to persist; identity-map invariants.
- Provides to Phase 4: `RuntimeSignal` stream and `AgentRuntime` methods the state machine drives.
- Phase 2 implementation can proceed in parallel with Phase 3, with Phase 1 signal schema as the shared contract.

## 6. Execution Steps

1. Create `docs/phases/README.md`: phase index table. Phase 1 "detailed", Phase 2 "detailed", Phases 3-7 "skeleton".
2. Write `docs/phases/phase-1-contracts-and-schemas.md`: twelve sections per approved plan section 4, drawing from V2 sections 5, 6.2, 6.6, 6.9, 8. The Phase 2-consumed contracts (section 3 above), including the complete runtime-signal taxonomy with its classification rule, at full concreteness.
3. Write `docs/phases/phase-2-herdr-runtime-adapter.md`: fourteen sections per section 5 above, citing Phase 1 doc sections for envelope, signals, events, and artifact layout; embedding the verified event table with provenance and the total failure-path signal mapping.
4. Write the five skeleton docs for Phases 3-7.
5. Stop. No code.

## 7. Risks

- **Backfill scope**: writing Phase 1 in the same execution as Phase 2 is more output in one turn; accepted because dependency order (V2 section 13, approved split) beats turn granularity, and the alternative - inventing contract details - was the original blocking objection.
- **Duplication drift**: inline tables (normalization, startup checks, event list) each carry "source:" markers; event list additionally carries a re-verification rule tied to the version pin.
- **Event classification wrong**: consumed/ignored is adapter policy and explicitly marked as such; reviewers can object per row with evidence without touching the verified Herdr fact list.
- **Signal taxonomy churn**: signal kinds and their observation/fault classification are Phase 1 contract; if implementation discovers a missing kind, the fix is a Phase 1 schema revision under the versioning policy, not an ad-hoc adapter signal - the completeness test enforces this.
