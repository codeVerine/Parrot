# Plan: Implement Phase 2 (Herdr Runtime Adapter) as Code

## 1. Context

Verified this turn:

- All seven phase specifications are approved and complete. The phase split comes from `approved-plans/task-20260718-043855-83ecd8/plan.md`; the Phase 2 specification is `approved-plans/task-20260718-065524-90fca8/plan.md` (iteration 4, approved), which defines the full content of `docs/phases/phase-2-herdr-runtime-adapter.md` in its sections 4-5.
- The most recent approved plan (`approved-plans/next-phase-20260718-191405-0ab883/`, iteration 2, approved 2026-07-18T19:40Z) covers the phase before this one: materialize `docs/phases/` from the approved plans and implement Phase 1 as `packages/contracts` (`@platform/contracts`), including the fourteen-event catalog and the eleven-kind runtime-signal taxonomy.
- Repo state: neither `docs/phases/` nor `packages/` exists yet. The Phase 1 plan is approved but its execution has not landed. `src/` remains the Parrot bootstrap orchestrator, untouched per that plan's non-goals.

The pending-phase chain is therefore unambiguous: Phase 1 implementation is planned and approved; the next phase with no plan is **Phase 2: implement the Herdr Runtime Adapter as code**. Phase 2's specification exists only as a document spec; no implementation plan for it has ever been written. This plan is that implementation plan.

Per the approved Phase 2 spec (section 5.14) and V2 section 6.1, the adapter is the only component that speaks Herdr-specific APIs (Herdr 0.7.3, protocol 16, socket API / CLI only - never embedded or linked, per the license boundary in V2 section 3). It emits runtime signals; it never decides workflow facts.

## 2. Precondition: Phase 1 Must Land First

This plan does not re-specify or re-plan Phase 1; the approved plan in `approved-plans/next-phase-20260718-191405-0ab883/` governs it verbatim. But Phase 2 code imports `@platform/contracts` (signal taxonomy, ids, envelope predicates, event enumeration), so execution of this plan is gated:

1. **Gate check** at execution start: `packages/contracts` exists and `pnpm --filter @platform/contracts test` is green.
2. If the gate fails because Phase 1 execution never landed, the executor first executes the approved Phase 1 plan exactly as written (docs backfill included), then re-checks the gate, then proceeds to Phase 2. No Phase 1 content is redefined here; if executing Phase 1 surfaces a contract defect, that is a Phase 1 revision under the versioning policy, raised as its own objection, not silently patched from this phase.

This mirrors the backfill-with-anchor pattern the previous plan established: bundling the unlanded dependency into the first execution that can verify it, rather than assuming it exists.

## 3. Deliverables

```
packages/
  herdr-adapter/
    package.json                  (name: @platform/herdr-adapter; deps: @platform/contracts, zod; no Herdr code linked)
    tsconfig.json
    src/
      runtime.ts                  (HerdrAgentRuntime implements AgentRuntime verbatim from V2 section 6.1)
      client/
        socket.ts                 (protocol-16 socket client: request/response + events.subscribe stream)
        cli.ts                    (herdr CLI invocations: `herdr api schema --json`, `herdr integration status`)
        types.ts                  (raw Herdr wire types for the 23 EventData variants + snapshot/list shapes)
      startup.ts                  (ordered startup checks per spec 5.3)
      identity.ts                 (identity map: agentId<->pane_id, workflowId<->workspace_id, session identity)
      status.ts                   (raw->canonical normalization table per spec 5.5)
      events.ts                   (subscription consumer: consumed/ignored classification of the 23 types)
      watch.ts                    (result-file watcher + poll fallback + pre-parse artifact safety checks)
      deadline.ts                 (per-turn deadline timers, primary/repair scoped, restart re-derivation hook)
      reconcile.ts                (resync(): session.snapshot + agent.list diff -> SnapshotReconciled)
      errors.ts                   (adapter error classes, each statically mapped to one signal kind)
      signalmap.ts                (the 5.11 failure-path -> signal-kind mapping table, exported as data)
      config.ts                   (config surface per spec 5.10: key, type, default)
      index.ts
    test/
      fake-herdr.ts               (in-process fake implementing the protocol-16 surface the adapter uses)
      fixtures/                   (one rejected-artifact fixture per ArtifactRejected reason code)
      startup.test.ts
      identity.test.ts
      status.test.ts
      watch.test.ts
      deadline.test.ts
      repair.test.ts
      reconcile.test.ts
      signalmap.test.ts           (failure-path coverage + completeness over errors.ts)
      restart.test.ts
      schema-pin.test.ts          (real-binary test, gated behind env flag)
docs/
  phases/
    README.md                     (updated: Phase 2 status "detailed, implemented")
```

No other files change. The Parrot bootstrap `src/` is untouched.

## 4. Implementation Specification

Every requirement below cites the approved Phase 2 spec (`approved-plans/task-20260718-065524-90fca8/plan.md`); this plan adds only code-structure decisions, no new contract content.

### 4.1 Interface and method semantics (spec 5.2)

`HerdrAgentRuntime` implements the eight-method `AgentRuntime` interface reproduced verbatim from V2 section 6.1. Per-method behavior:

- `start(spec)`: spawn via the socket API using provider/role/workspace/worktree/env from `AgentSpec`; returns `AgentHandle`. Every failure path (spawn error, missing integration, unsupported provider) throws a typed adapter error whose static mapping is `AgentSpawnFailed` with the matching reason code.
- `send(id, turn)`: delivers the turn prompt; `DeliveryReceipt` echoes `turnId` and the prompt content hash (correlating delivery to the immutable `prompt.md` per the Phase 1 hash-identified prompt rule). Dead pane or non-idle agent throws -> `TurnDeliveryFailed` with reason. Repair sends reference `repair-prompt.md` in the same turn directory, reuse the `turnId`, carry the `repair` attempt marker, and are permitted at most once per turn (Phase 1 repair protocol constants imported from `@platform/contracts`).
- `wait(id, turnId, timeoutMs)`: returns the next `RuntimeSignal` (contracts type) correlated to the turn; never blocks past `timeoutMs`; every underlying Herdr call passes an explicit timeout (defaults are undocumented, V2 section 3).
- `result(id, turnId)`: runs the file-safety checks (4.4), then returns raw bytes + hash. The adapter never parses TOON; envelope validation (mismatch, nonce, stale turn, schemaVersion) belongs to Phase 5 Extraction & Validation. This split is stated in doc comments on both `result()` and the safety-check module so neither component assumes the other performs a check (spec 5.6 validation boundary).
- `onStatus(handler)`: normalized status events only (4.3).
- `resync()`: full reconciliation pass (4.6).
- `interrupt(id)` / `stop(id)`: idempotent; in-flight turn moves to `cancelled`; artifacts arriving afterwards are orphans (V2 section 5 step 8) - the adapter still emits `ResultFileSeen` for them; the engine decides `OrphanResultSeen`.
- No `read()` exists on the interface. Pane text is display/debug only.

### 4.2 Startup checks (spec 5.3)

Ordered, fail-fast, in `startup.ts`:

1. `herdr api schema --json`: pin protocol 16, `schema_version` 1, exactly 23 `EventData` variants. Any mismatch emits `ProtocolMismatch` (expected vs observed) and aborts construction.
2. Full `herdr integration status` run.
3. Required integrations verified installed. Production mode fails closed. Development mode continues with restore guarantees disabled and session-log features unavailable, emitting `DegradedModeEntered` with the missing-integrations list and disabled capabilities.
4. License boundary honored structurally: the package has no Herdr dependency; all interaction is socket/CLI.

### 4.3 Identity mapping and status normalization (spec 5.4, 5.5)

- `identity.ts` owns `agentId <-> pane_id`, `workflowId <-> workspace_id`, plus `agent_session_id`/`agent_session_path` when the provider integration supplies them (Claude Code, Codex yes; Gemini no - degradation documented per case). Hard invariant, asserted in code: `pane_id` is never used as agent identity. Remap runs on `pane_created`, `pane_exited`, `pane_agent_detected`. The in-memory shape matches the invariants Phase 3's `agents` table must store; persistence itself is out of scope.
- `status.ts` exports the normalization table as data (source marker: V2 section 3): raw `idle | working | blocked | done | unknown` -> canonical `idle | working | blocked | unknown` + hint flags. Herdr `done` is preserved raw in signal metadata but reduced to a non-authoritative idle-like completion hint; it may trigger an early result check, never turn completion. Status is a heuristic hint, never a completion signal (V2 section 10).

### 4.4 Result watching and artifact safety (spec 5.6)

`watch.ts`: fs watch on the turn directory for `result.toon`; `result.tmp` and partials ignored (atomic-rename contract from the Phase 1 artifact layout). Watcher establishment failure or mid-turn death emits `ResultWatchFailed` and switches to a manual poll fallback until re-established - a watcher crash cannot silently hang a turn. Pre-parse rejection checks, each emitting `ArtifactRejected` with its reason code: `symlink`, `ownership`, `world_writable`, `stale_mtime`, `path_escape` (after canonicalization), `oversize` (config default). Artifact hash is computed before validation and travels with `ResultFileSeen`. Trust boundary doc comment: agent-written files are untrusted even same-OS-user.

### 4.5 Deadlines and repair turns (spec 5.7)

`deadline.ts`: per-turn timer armed at `send` acknowledgment. Expiry emits the observation signal `DeadlineExpired` (attempt marker `primary | repair`); the engine, not the adapter, derives `AgentTimedOut`. `working -> idle/done` without a result file triggers the early result check, then a grace timer (config default), then the failure signal. Repair sends re-arm the watch and start a fresh repair-scoped timer. Timers are re-derivable: the module exposes a constructor taking persisted turn deadlines (Phase 3 will supply them) so restart never trusts memory.

### 4.6 Reconnect reconciliation and event subscription (spec 5.8, 5.9)

- `reconcile.ts`: on reconnect, `session.snapshot` + `agent.list` before resuming; diff against the identity map; emit `SnapshotReconciled` with the delta (agents added/removed/status-corrected, missed results found). Failure after bounded retries (config backoff) emits `ReconnectFailed`. Herdr subscriptions have no cursor/replay, so nothing durable depends on having observed a live event; each live-event consumer in `events.ts` documents its reconciliation fallback, covering the four missed-during-disconnect cases (finished agent, dead agent, status change, worktree events).
- `events.ts`: `events.subscribe` handling all 23 verified event types with the consumed/ignored classification from the approved spec section 4 (provenance line included; classification marked as adapter policy). Duplicate/out-of-order tolerance: unique signal IDs, correlation by `turnId`, idempotent downstream handling.

### 4.7 Total failure-path mapping (spec 5.11)

`errors.ts` defines one error class per adapter failure path; `signalmap.ts` exports the mapping table as data, exactly the eight rows of spec 5.11: seven fault paths plus turn timeout mapped to the observation signal `DeadlineExpired` (explicitly marked: agent outcome, not adapter error). Completeness rule enforced by test: every error class exported from `errors.ts` appears in the table; the adapter never fails silently. Signal kinds come only from `@platform/contracts` - the adapter cannot invent kinds; a missing kind is a Phase 1 schema revision under the versioning policy.

### 4.8 Configuration surface (spec 5.10)

`config.ts`: single table - key, type, default, consuming module. Minimum keys: protocol pin, required integrations list, mode (`production | development`), turn deadline default, grace timer, artifact size limit, watch debounce, reconnect backoff.

## 5. Test Plan (spec 5.12)

All tests run against `fake-herdr.ts`, an in-process fake of exactly the protocol-16 surface the adapter uses; no real Herdr required except the pin test.

- Failure-path signal coverage: one test per `signalmap.ts` row forcing its emission path (spawn failure, dead-pane send, watcher kill mid-turn, each of the six `ArtifactRejected` fixtures, deadline expiry, reconnect failure, protocol mismatch, degraded mode), plus the completeness test over `errors.ts`.
- Deadline tests: expiry, early-completion hint without artifact, grace-timer path.
- Repair tests: repair send reuses `turnId`, re-arms watch, fresh repair-scoped deadline, second repair attempt impossible.
- Reconnect tests: each of the four missed-event cases reconciles to the same state the live-event path would have produced.
- Restart tests: kill adapter mid-turn, reconstruct with persisted deadlines, timers re-derived correctly.
- Identity tests: pane respawn remap, `pane_id`-as-identity misuse impossible through the public API.
- Schema-pin test: `herdr api schema --json` yields protocol 16 with 23 variants; gated behind `HERDR_PIN_TEST=1`.

Verification command for the human to run: `pnpm --filter @platform/herdr-adapter test`.

## 6. Execution Order

1. Gate check (section 2); execute approved Phase 1 plan first if unlanded.
2. Package scaffolding: `packages/herdr-adapter` in the workspace, build green against `@platform/contracts`.
3. `errors.ts` + `signalmap.ts` + completeness test (the contract skeleton everything else must satisfy).
4. `client/` + `startup.ts` + fake Herdr + startup/pin tests.
5. `identity.ts`, `status.ts`, `events.ts` with tests.
6. `watch.ts` + fixtures, `deadline.ts`, repair flow, with tests.
7. `reconcile.ts` + reconnect/restart tests.
8. `runtime.ts` assembling the interface; full suite green.
9. Update `docs/phases/README.md`: Phase 2 "detailed, implemented".

## 7. Risks

- **Phase 1 not landed**: mitigated by the section 2 gate; Phase 2 execution cannot silently proceed against imagined contracts.
- **Fake-Herdr fidelity**: the fake could drift from the real protocol. Mitigated by the env-gated schema-pin test against the real binary and by keeping the fake's surface minimal (only what the adapter calls).
- **Concurrency limits unknown** (spec 5.13, V2 open question 2, Phase 2-owned): not blocking implementation; the measurement scale-test is deferred until after the adapter exists to measure, and its answer lands as a config default. Noted in the phase doc as still open.
- **Signal taxonomy gap discovered during implementation**: fix is a Phase 1 revision under the versioning policy with its own approval, never an ad-hoc adapter signal; the completeness test makes the violation loud.

## 8. Non-Goals

- No workflow logic, no state machine (Phase 4), no persistence (Phase 3), no prompt construction or TOON parsing (Phase 5), no LLM calls.
- No modification of the Parrot bootstrap `src/`.
- No changes to any approved phase document content; `docs/phases/README.md` status cell is the only doc edit.
- No re-planning of Phase 1; its approved plan governs verbatim.

## 9. Open Objections

None outstanding for this run.
