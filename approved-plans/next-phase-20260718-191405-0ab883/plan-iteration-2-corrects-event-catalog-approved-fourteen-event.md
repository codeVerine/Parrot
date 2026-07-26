# Plan (iteration 2): Land the Phase Documentation Set and Implement Phase 1 (Contracts and Schemas) as Code

## 0. Changes from Iteration 1

- **OBJ-001 (blocking)**: iteration 1 proposed a fourteen-event catalog that was not the approved enumeration: it dropped `BudgetCapReached`, `IterationCapReached`, and `OrphanResultSeen`, and invented `IterationStarted`, `WorkflowCompleted`, and `EscalatedToHuman` with no cited approval - and made the completeness test assert exactly that wrong list, which would have locked an incompatible contract into code. Resolved by replacing section 4.1 with the approved enumeration verbatim: the twelve v1 events from the approved Phase 1 spec (`approved-plans/task-20260718-043855-83ecd8/plan.md` section 4 item 4) plus exactly the two approved additive revisions - `UsageRecorded` (Phase 4 plan, iteration 2, change note) and `VerificationCompleted` (Phase 7 plan, iteration 3, section 1 item 2) - for fourteen total. The three invented events are gone; if the Phase 4 state machine later needs lifecycle events, that is a future additive revision under the versioning policy with its own approval, not something this plan smuggles in. The completeness test now asserts the approved list, and gains a provenance comment mapping each event to the plan section that approved it.
- **OBJ-002 (major)**: iteration 1's package had no runtime-signal module, despite the Phase 2 plan (iteration 4, section 3) requiring Phase 1 to define the complete runtime-signal taxonomy as a shared contract that Phase 3 consumes and may not redefine. Resolved by adding a `signals/` module implementing the full taxonomy from the Phase 2 plan verbatim: the common signal envelope (unique signal ID, `kind`, `observedAt`, `source` enum `herdr_event | fs_watch | deadline_timer | reconcile | adapter_internal`, nullable correlation fields), the four observation kinds (`HerdrStatusChanged`, `ResultFileSeen`, `DeadlineExpired`, `SnapshotReconciled`), the seven fault kinds (`AgentSpawnFailed`, `TurnDeliveryFailed`, `ResultWatchFailed`, `ArtifactRejected`, `ReconnectFailed`, `ProtocolMismatch`, `DegradedModeEntered`), and the classification rule as a doc-comment invariant plus a disjointness test. New sections 3 (deliverables) and 4.6 below; new test file `signals.test.ts`.

Everything else from iteration 1 stands: the docs backfill bundled with the Phase 1 implementation, the workspace layout, the envelope/objection/decision/versioning/TOON modules, and the non-goals.

## 1. Context

The V2 architecture (`Multi-Agent-Orchestration-Architecture-v0.2.md`) was split into seven phases by the approved plan `approved-plans/task-20260718-043855-83ecd8/plan.md`, and every phase now has a fully detailed, human-approved specification:

| Phase | Approved plan | Status |
|---|---|---|
| 1. Contracts and Schemas | `approved-plans/task-20260718-043855-83ecd8/plan.md` (+ additive revisions from Phases 2, 4, 5, 7) | detailed |
| 2. Herdr Runtime Adapter | `approved-plans/task-20260718-065524-90fca8/plan.md` (iteration 4) | detailed |
| 3. Event Log and Persistence | `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/` | detailed |
| 4. Workflow Engine | `approved-plans/now-lets-create-next-phase-document-i-think-20260718-074737-1f04c6/` (iteration 2) | detailed |
| 5. LLM Boundary Components | `approved-plans/next-lets-create-phase-5-go-through-other-20260718-161914-fc22a3/` (iteration 2) | detailed |
| 6. Frontier Review, Dashboard, Cost | `approved-plans/now-uh-lets-do-six-like-get-context-20260718-163152-199477/` | detailed |
| 7. Implementation Agents and MVP | `approved-plans/now-uh-lets-do-seven-like-get-context-20260718-163842-13b975/` (iteration 3) | detailed |

Repo state, verified this turn:

- `docs/phases/` does not exist. None of the seven approved executions ever landed; every plan since Phase 2 has carried a "backfill if absent" clause, and the debt is now maximal: the entire documentation set exists only inside `approved-plans/`.
- The repo's `src/` is the Parrot bootstrap orchestrator (the tool running this very loop), not the platform. It already contains a working TOON codec (`src/toon.ts`), Zod result schemas (`src/schemas.ts`), and an objection-gated plan/review loop. It is a proof of the turn protocol at small scale, not an implementation of the V2 platform.

The documentation series is complete. There is no Phase 8 in the approved split. "The next phase" therefore means the next phase of the project: stop planning documents and start landing artifacts. Per the split's dependency order and V2 section 13 ("the contracts are the architecture"), that is Phase 1.

## 2. Decision

The next phase has two parts, in strict order:

1. **Materialize `docs/phases/`** - a mechanical transcription step. The seven approved plans are the source of truth; this step converts them into the seven phase documents plus the index README exactly as each approved plan's "Deliverables" section specifies, including every additive Phase 1 revision: the runtime-signal taxonomy (Phase 2 plan), `UsageRecorded` (Phase 4 plan), the objection-merge result schema (Phase 5 plan), and the implementation-agent result schemas plus `VerificationCompleted` (Phase 7 plan). No new design content is invented in this step; where an approved plan left a section as a spec-of-a-section, the document says what the plan says, no more.
2. **Implement Phase 1 as executable contracts** - the twelve-section Phase 1 document becomes a TypeScript package: Zod schemas, TOON codecs, and contract tests. This is the first code artifact of the platform proper.

Rationale for bundling the backfill with the Phase 1 implementation rather than shipping it alone: the backfill has been promised and skipped six consecutive times because a documentation-only turn produces nothing executable to verify. Binding it to the Phase 1 package gives it a verification anchor - the contract tests import the schemas, and the docs are checked against the same enumerations the tests assert - so drift between `docs/phases/phase-1-contracts-and-schemas.md` and the code is caught at build time, not by a future reviewer's memory.

## 3. Deliverables

```
docs/
  phases/
    README.md                                 (index: phase, title, status, depends-on, V2 sections)
    phase-1-contracts-and-schemas.md          (full detail, incl. all additive revisions)
    phase-2-herdr-runtime-adapter.md          (full detail per approved plan)
    phase-3-event-log-and-persistence.md      (full detail per approved plan)
    phase-4-workflow-engine.md                (full detail per approved plan)
    phase-5-llm-boundary-components.md        (full detail per approved plan)
    phase-6-frontier-review-dashboard-cost.md (full detail per approved plan)
    phase-7-implementation-agents-and-mvp.md  (full detail per approved plan)
packages/
  contracts/
    package.json                (name: @platform/contracts; no runtime deps beyond zod)
    tsconfig.json
    src/
      ids.ts                    (WorkflowId, IterationId, TurnId, AgentId, EventId, SignalId brands + constructors)
      envelope.ts               (result envelope schema + rejection rules as predicates)
      events/
        catalog.ts              (the approved v1 platform event enumeration, one schema per event)
        index.ts                (discriminated union, EventId uniqueness, correlation-field invariants)
      signals/
        envelope.ts             (common signal envelope: signal ID, kind, observedAt, source, nullable correlation)
        observation.ts          (the four observation-signal schemas)
        fault.ts                (the seven fault-signal schemas)
        index.ts                (discriminated union over all eleven kinds; classification rule documented)
      results/
        planner.ts, reviewer.ts, resolution.ts, frontier.ts,
        implementation.ts       (progress/result + deviation-request schemas, per the Phase 7 additive revision)
        merge.ts                (objection-merge result schema, per the Phase 5 additive revision)
      objection.ts              (schema, severity rubric enum, status machine as a transition table)
      decision.ts               (schema with provenance block)
      requirements.ts           (imported-requirement schema: source path, content hash, priority, external id)
      versioning.ts             (schemaVersion format, additive-change rule as a checkable predicate)
      repair.ts                 (repair-protocol constants: single bounded attempt, failure classification)
      toon/                     (TOON encode/decode, extracted and hardened from src/toon.ts)
    test/
      roundtrip.test.ts         (every schema: build → TOON encode → decode → parse → deep-equal)
      envelope.test.ts          (rejection rules: envelope mismatch, missing nonce, stale turn)
      events.test.ts            (enumeration completeness vs the approved Phase 1 list + additive revisions; correlation fields present on every event)
      signals.test.ts           (taxonomy completeness vs the Phase 2 plan taxonomy; observation/fault disjointness; source-enum coverage; DeadlineExpired classified as observation)
      objection.test.ts         (legal/illegal status transitions, cluster max-severity rule)
      versioning.test.ts        (additive rule accepts the approved revisions, rejects a field removal)
```

Root `package.json` gains a `pnpm-workspace.yaml` with `packages/*`; the existing `src/` (Parrot bootstrap) stays where it is and is untouched. Moving Parrot into the workspace is explicitly out of scope for this phase.

## 4. Phase 1 Implementation Specification

### 4.1 Event catalog (corrected, closes OBJ-001)

The v1 enumeration is exactly the approved Phase 1 list plus the two approved additive revisions - fourteen events, each with the approving source:

| # | Event | Approval source |
|---|---|---|
| 1-12 | `TurnCompleted`, `TurnFailed`, `AgentTimedOut`, `ObjectionRaised`, `ObjectionResolved`, `ConsensusReached`, `HumanApproved`, `HumanRejected`, `ImplementationBlocked`, `BudgetCapReached`, `IterationCapReached`, `OrphanResultSeen` | `approved-plans/task-20260718-043855-83ecd8/plan.md` section 4, item 4 |
| 13 | `UsageRecorded` | Phase 4 plan (iteration 2), additive revision |
| 14 | `VerificationCompleted` | Phase 7 plan (iteration 3), section 1 item 2 |

No other events. The `IterationStarted`, `WorkflowCompleted`, and `EscalatedToHuman` events proposed in iteration 1 of this plan are removed: they appear in no approved enumeration. Iteration and workflow lifecycle is represented in persistence state (Phase 3's `workflows`/`iterations` tables), and escalation is a workflow state with notification (Phase 4), not an unapproved event.

Every event schema shares a base: unique `eventId`, `occurredAt`, and the correlation block (`workflowId`, always; `iterationId`, `turnId`, `agentId` where the approved payload defines them). `VerificationCompleted` carries the Phase 7 payload verbatim: attempt number, outcome `passed | failed`, command set with content hash, per-command exit codes, log artifact references by hash. The completeness test asserts the discriminated union covers exactly this fourteen-event list, with a provenance comment per event naming its approval source, so a fifteenth event cannot be added silently without a versioning-policy revision note.

### 4.2 Result envelope

Fields: `workflowId`, `iterationId`, `turnId`, `schemaVersion`, `nonce`, role payload. Rejection rules from the Phase 1/2 specs are implemented as named predicates (`rejectEnvelopeMismatch`, `rejectMissingNonce`, `rejectStaleTurn`) rather than being buried in a parse function, because Phase 2's adapter and Phase 5's extraction pipeline both consume them and must agree.

### 4.3 Objection and decision schemas

Directly from V2 sections 6.6 and 8: severity `blocking | major | minor` with the rubric recorded as doc comments on the enum; status machine `open | accepted | rejected | superseded | resolved | waived` with the legal-transition table exported as data (the Phase 4 engine folds it; tests enforce it). Evidence is required or `evidence_missing` is explicit. Clusters preserve every original objection ID and take max severity. Decisions carry the full provenance block.

### 4.4 Versioning policy

`schemaVersion` is `v<major>` per artifact type. The additive rule is a predicate over two schema descriptors (old, new): adding optional fields or new union members passes; removing or retyping fails. The approved revisions (`UsageRecorded`, `VerificationCompleted`, the merge and implementation-agent result schemas, and the runtime-signal taxonomy addition itself) are the positive test fixtures.

### 4.5 TOON codec

Extracted from Parrot's `src/toon.ts` into `packages/contracts/src/toon/` and hardened: size limit before parse, no prototype-key injection, deterministic key order on encode (hash stability for artifacts). Parrot keeps its own copy for now; unifying is future work.

### 4.6 Runtime-signal taxonomy (new, closes OBJ-002)

Implemented verbatim from the Phase 2 plan (iteration 4, section 3), which revised Phase 1 to own this taxonomy; Phase 3 consumes it and may not redefine it.

**Common envelope** (`signals/envelope.ts`): unique `signalId` (branded, format defined here), `kind`, `observedAt`, `source: herdr_event | fs_watch | deadline_timer | reconcile | adapter_internal`, and correlation fields (`workflowId`, `iterationId`, `turnId`, `agentId`) - each nullable, populated when known. Nullability is the deliberate contrast with platform events, where `workflowId` is mandatory: signals are observations that may arrive before attribution is possible.

**Observation signals** (`signals/observation.ts`) - facts observed about agents, files, and timers, including unwelcome ones:

| Kind | Payload highlights |
|---|---|
| `HerdrStatusChanged` | raw Herdr status preserved, normalized status, hint flags |
| `ResultFileSeen` | artifact path, size, content hash (recorded before validation) |
| `DeadlineExpired` | turn deadline, whether primary or repair-scoped attempt |
| `SnapshotReconciled` | reconciliation delta (agents added/removed/status-corrected, missed results found) |

**Fault signals** (`signals/fault.ts`) - adapter-internal failures; every adapter-internal error path emits exactly one:

| Kind | Payload highlights |
|---|---|
| `AgentSpawnFailed` | reason enum, provider, raw error |
| `TurnDeliveryFailed` | reason enum, turnId, attempt (primary/repair) |
| `ResultWatchFailed` | path, raw error |
| `ArtifactRejected` | reason enum `symlink \| ownership \| world_writable \| stale_mtime \| path_escape \| oversize`, path, observed value vs limit |
| `ReconnectFailed` | attempt count, raw error |
| `ProtocolMismatch` | expected vs observed protocol and schema_version |
| `DegradedModeEntered` | missing integrations list, disabled capabilities |

The classification rule is recorded as a doc comment on the union: a fault signal means "the adapter failed or refused"; an observation signal means "the adapter observed something" - so turn timeout (`DeadlineExpired`) is an observation, not a fault. `signals.test.ts` asserts: the union covers exactly these eleven kinds; the observation and fault kind sets are disjoint; every source-enum member is producible; and `DeadlineExpired` is typed in the observation group (pinning the classification the Phase 2 plan's own iteration history corrected once already). Signals are not platform events: nothing in `signals/` imports `events/`, and the type-level separation enforces the V2 section 6.2 rule that only the workflow engine turns signals into facts.

## 5. Execution Order

1. Workspace scaffolding (`pnpm-workspace.yaml`, `packages/contracts` skeleton, build green).
2. Docs backfill, Phase 1 document first (the code in steps 3-6 is written against it).
3. `ids`, `envelope`, `versioning`, `toon` modules with tests.
4. Event catalog with completeness test; runtime-signal taxonomy with completeness and disjointness tests.
5. Result schemas (all six roles), objection, decision, requirements modules with tests.
6. Cross-check pass: Phase 1 doc enumerations vs `events/catalog.ts` and `signals/index.ts` vs test fixtures; README index states all seven phases "detailed", Phase 1 additionally "implemented".

Verification command for the human to run: `pnpm --filter @platform/contracts test`.

## 6. Non-Goals

- No Herdr adapter code (Phase 2), no SQLite (Phase 3), no state machine (Phase 4). The contracts package has zero runtime dependencies beyond `zod` precisely so later phases consume it without inheriting anything. The signal taxonomy ships as schemas only; nothing in this phase emits a signal.
- No modification of the Parrot bootstrap under `src/`.
- No changes to the V2 architecture document.
- No new design decisions: every schema field traces to an approved plan section; anything genuinely underspecified is flagged in the Phase 1 doc's open-questions section instead of being invented.

## 7. Open Objections

- OBJ-001: addressed - section 4.1 now carries the approved fourteen-event enumeration with per-event approval sources; the three uncited events are removed and the completeness test asserts the approved list.
- OBJ-002: addressed - new `signals/` module and section 4.6 implement the complete runtime-signal taxonomy (common envelope, four observation kinds, seven fault kinds, classification rule) with completeness, disjointness, and classification tests; deliverables and execution order updated.
