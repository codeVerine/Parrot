# Plan (iteration 2): Expand Phase 4 (Workflow Engine) into a Full Technical Document

## 0. Changes from Iteration 1

- **OBJ-001 (major)**: the Phase 3 approved plan was cited at a nonexistent path (`.../plan.md`). Corrected everywhere to the actual artifact: `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` (verified present in the checkout alongside `approval.toon`). Execution step 1 now names all three backfill sources by their verified filenames.
- **OBJ-002 (major)**: the budget-cap guard contradicted the guards-read-folded-state-only rule, because no platform event carried usage into the event log. Resolved by closing the loop, not by weakening the purity rule: the plan now specifies a `UsageRecorded` platform event, added to the Phase 1 enumeration as an additive schema revision under the Phase 1 versioning policy (thirteenth v1 event). The cost-ledger component submits usage facts to the engine as inputs; the engine - the sole writer of `events` per the Phase 3 rule - appends `UsageRecorded` and folds the spend total into workflow state; `underBudgetCap` reads only that folded total. The vague "or a versioned read model" escape hatch in the risk section is deleted. Until Phase 6 lands, no usage inputs flow, the folded total stays zero, and the guard is trivially true - enforcement activates with Phase 6, with no engine change. Section 4.4 (guard definition), new section 4.5 (usage and budget event flow), 4.10 (decision list), and risk section 6 updated accordingly.

## 1. Context and Sources

Per the approved phase split (`approved-plans/task-20260718-043855-83ecd8/plan.md`), Phase 4 is the **Workflow Engine**: a deterministic state machine (XState or equivalent); explicit turn states; orphan-result handling; guards over objection status, iteration caps, and budget caps; the planning workflow of V2 section 6.3. Depends on Phases 1-3.

The previous phase artifacts, in dependency order, are the three approved plans:

- `approved-plans/task-20260718-043855-83ecd8/plan.md` - phase split; Phase 1 doc spec including the twelve v1 platform events.
- `approved-plans/task-20260718-065524-90fca8/plan.md` - Phase 2 doc spec; complete runtime-signal taxonomy (four observation kinds, seven fault kinds); signal/event classification rule.
- `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` - Phase 3 doc spec: table schemas, transactional outbox, fold runner (Phase 3 provides the runner, Phase 4 the reducer), the rule that only the workflow engine writes to `events`, and the startup recovery procedure.

Current repo state: `docs/phases/` still does not exist; none of the three approved executions have landed. Same posture as the Phase 2 and Phase 3 plans: if `docs/phases/` is absent at execution time, backfill the Phase 1-3 docs (and remaining skeletons) exactly per the approved plans first, then write the Phase 4 doc. Nothing here contradicts the approved plans; every contract this plan needs (events, signals, turn states, fold, guards' inputs) is cited from them or from V2 sections 2, 5, 6.2, 6.3, 6.6, 6.7, 9, 10, 11, 12. The single deliberate contract change is the additive `UsageRecorded` event (section 4.5), made under the Phase 1 versioning policy rather than ad hoc.

The V2 document remains the source architecture. Inline duplication exceptions, each with a "source:" marker: the turn-state diagram (source: V2 section 6.3), the ten-step planning workflow (source: V2 section 6.3), and the objection status/severity enums the guards consume (source: V2 section 6.6, defined in the Phase 1 doc).

## 2. Deliverables

```
docs/
  phases/
    README.md                            (index; Phase 4 status set to "detailed")
    phase-1-contracts-and-schemas.md     (backfill if absent, per approved plans; includes the UsageRecorded additive revision)
    phase-2-herdr-runtime-adapter.md     (backfill if absent)
    phase-3-event-log-and-persistence.md (backfill if absent)
    phase-4-workflow-engine.md           (full detail - the deliverable of this task)
    phase-5-llm-boundary-components.md   (skeleton, if absent)
    phase-6-frontier-review-dashboard-cost.md (skeleton, if absent)
    phase-7-implementation-agents-and-mvp.md  (skeleton, if absent)
```

No source code in this turn. Documentation only.

## 3. Contracts Consumed from Phases 1-3

The Phase 4 doc consumes, and may not redefine:

- **Platform events** (Phase 1): the twelve v1 events, plus `UsageRecorded` added by this plan as an additive revision (section 4.5). Phase 4 is their sole producer (Phase 3 rule: no component other than the workflow engine writes to `events`).
- **Runtime signals** (Phases 1-2): the eleven signal kinds with the observation/fault split. Phase 4 is their sole consumer for workflow purposes: signals become workflow facts only through the engine's reduction.
- **Persistence and outbox** (Phase 3): platform events appended in the same transaction as the state change; fold runner with determinism rules (fold consumes only `events`, never signals, never wall clock); turn rows carry state, `deadlineAt`, attempt scope; startup recovery procedure hands deadlines to the adapter.
- **AgentRuntime interface** (Phase 2): `start`, `send`, `wait`, `result`, `interrupt`, `stop`, `resync` - the only actions the engine may invoke against agents.
- **Objection contract** (Phase 1, V2 section 6.6): severity enum (`blocking | major | minor`), status enum (`open | accepted | rejected | superseded | resolved | waived`), cluster max-severity rule - guard inputs.

## 4. Required Content of `phase-4-workflow-engine.md`

### 4.1 Goal and Non-Goals

- Goal: the deterministic orchestration core. A state machine with guard conditions consuming workflow state, objection status, and human rules. It never analyses code and never calls an LLM (V2 sections 6.3 and 9).
- Non-goals: no prompt construction (Phase 5), no TOON parsing or validation (Phase 5), no Herdr specifics (Phase 2), no persistence schema (Phase 3, consumed), no semantic judgement of any kind - objection dedup, review, and frontier analysis are explicit LLM calls owned by Phase 5/6 components, invoked as workflow steps, never as management decisions.

### 4.2 Turn State Machine

- The state diagram, verbatim from V2 section 6.3 (source-marked):

      created → sent → waiting → result_seen → validating
        → completed
        → repair_sent → waiting
        → failed | timed_out | cancelled

- A full transition table: current state, triggering input, guard, actions (AgentRuntime calls, Phase 3 writes), emitted platform events. Every transition commits its state change and events in one Phase 3 transaction.
- Input mapping (signal reduction): `ResultFileSeen` → `result_seen`; validation success (from Phase 5) → `completed` + `TurnCompleted`; first validation failure → `repair_sent` (repair turn via Phase 2 `send`); second failure → `failed` + `TurnFailed`; `DeadlineExpired` → `timed_out` + `AgentTimedOut`; `interrupt`/`stop` → `cancelled`. Fault signals (`AgentSpawnFailed`, `TurnDeliveryFailed`, etc.) map to turn failure or workflow-level escalation per a stated table - no fault signal is silently dropped.
- Orphan-result rule: a `ResultFileSeen` for a turn already in `failed`, `timed_out`, or `cancelled` emits `OrphanResultSeen`, links the artifact to the original turn for audit, and cannot advance the workflow or satisfy a retry (V2 sections 5 step 8 and 6.3).
- Late/duplicate signal safety: correlation by `turnId` + nonce + artifact hash, idempotent reduction (a signal already reduced is a no-op), stale-turn signals recorded but never re-reduce.

### 4.3 Planning Workflow Definition

The ten-step planning workflow of V2 section 6.3 as an explicit machine (source-marked), with states, guards, and emitted events per step:

1. Planner turn → proposal.
2. Spawn fresh reviewers (ephemeral, per V2 section 2); send review turns.
3. Collect objections; all rounds deadline-bounded.
4. Objection Engine merge/dedupe step (Phase 5 component invoked as a workflow step; non-destructive clustering).
5. Guard `hasOpenObjections` (any severity - the consensus gate is zero open objections of any severity, V2 section 6.6): open → planner iteration, `iteration++`.
6. Guard `underIterationCap` false → escalation (4.6). Zero open → frontier review turn.
7. Frontier blocking findings convert to objections (`ObjectionRaised`) → back to step 5, bounded by the same iteration cap. Frontier contradictions surface as objections too (V2 section 6.7).
8. Dashboard read models refresh; human decision requested via `NotificationSink` (Phase 6 surface; the engine only emits the request event).
9. `HumanApproved` → `ConsensusReached`/approved path → implementation workflow handoff (Phase 7). `HumanRejected` → recorded, workflow ends or re-iterates per human rule. Approval with open objections is the explicit waiver path (`waived` status), never silent.
10. Iteration cap or budget cap → escalate with the open objection list. Never loop silently.

First-round reviewers are independent (no merged state); later rounds receive merged objection state (V2 section 11 resolved question 2). Reviewer resolution verification: planner responses to objection IDs are verified by a fresh reviewer session (V2 section 6.6) - modeled as a distinct turn type in the workflow.

### 4.4 Guards

One subsection per guard: name, inputs (folded state fields only), predicate, consuming transition. Minimum set:

- `hasOpenObjections`: any objection in status `open`, any severity, from folded objection state.
- `underIterationCap`: folded iteration count vs config cap.
- `underBudgetCap`: folded `spendTotal` (accumulated exclusively from `UsageRecorded` event payloads, section 4.5) vs config cap. No table read, no ledger query at guard time.
- `frontierHasBlockingFindings`: folded frontier-report outcome.
- `humanRuleAllows`: explicit human-configured auto-rules; absent rule means ask the human (V2 section 11 resolved question 6).

Guard purity rule: guards read folded state and config only - no clock, no I/O, no table queries, no randomness; this is what makes replay deterministic. Every guard input must be traceable to a platform event payload; the doc includes a guard-input-to-event table making that traceability explicit.

### 4.5 Usage and Budget Event Flow

Closes the gap OBJ-002 identified: budget data must live in the event log for the guard to stay pure.

- **`UsageRecorded` platform event** (additive Phase 1 revision): added to the Phase 1 enumeration as the thirteenth v1 event, under the Phase 1 versioning policy's additive-change rule (backfilled Phase 1 doc lists it with the revision note; `schemaVersion` semantics unchanged - additive). Payload: provider, provider message ID (the usage_ledger dedup key), cache/input/output tokens, computed cost, pricing version, correlation fields. Source-marked to V2 section 6.10 field list.
- **Flow**: the cost-ledger component (Phase 6) parses session logs via versioned provider adapters and writes `usage_ledger` rows (Phase 3 schema), then submits each new usage fact to the engine as an input. The engine - sole writer of `events` - deduplicates by provider message ID against folded state, appends `UsageRecorded`, and folds `spendTotal += cost` in the same transaction. Replay refolds the same payloads, so live and replayed spend totals are identical by construction.
- **Cap crossing**: the reduction that pushes `spendTotal` over the config cap emits `BudgetCapReached` in the same transaction and moves the workflow to the paused/escalated state (V2 section 6.10: pause and notify, never continue silently).
- **Phasing**: Phase 4 implements the reduction, the fold field, the guard, and the cap-crossing emission. Until Phase 6 exists no usage inputs arrive, `spendTotal` stays zero, and `underBudgetCap` passes trivially; enforcement activates when Phase 6 lands with no engine change. The Phase 4 doc states this explicitly so nobody mistakes a zero total for measured cost.
- `usage_ledger` remains the audit/reporting table (Phase 3/6 concern); the event log is the enforcement path. The doc states both roles so the two are not conflated.

### 4.6 Escalation and Caps

- Iteration cap reached with open objections, budget cap reached (`BudgetCapReached` pauses workflow per V2 section 6.10 and section 4.5 above), frontier flags, or `ImplementationBlocked`: each emits its platform event, pauses the workflow in a named `escalated` state, and requests human input with the open objection list attached. Explicitly: no silent looping, no silent continuation past a cap.
- `IterationCapReached` and `BudgetCapReached` event payloads: cap value, observed value, open objection IDs.

### 4.7 Engine as Fold Reducer

- Phase 3 provides the fold runner; Phase 4 provides the reducer: `(foldedState, platformEvent) → foldedState`. The live path and the replay path execute the same reducer - the machine's transition function is the reducer, so recovery cannot diverge from live behavior (V2 section 10, replay/recovery divergence row).
- Startup recovery: Phase 3 rebuilds folded state, engine resumes from it, re-arms in-flight turns via the adapter (deadlines from turn rows), re-dispatches undispatched outbox events. In-flight turns resume in `waiting`; the adapter's `resync()` covers missed-during-downtime results.
- Determinism statement: given the same event log, the reducer yields identical state; enforced by the Phase 3 replay tests plus Phase 4's own property tests (4.10).

### 4.8 XState Mapping

- How the abstract machine lands in XState: one workflow machine, child turn machines (actors) per active turn; guards as pure functions; actions as effects that go through Phase 3 (persist-then-dispatch) - XState internal persistence is not used; the event log is the only durable state (source of truth rule, V2 section 2).
- Rule: no XState feature may introduce nondeterminism (no delayed transitions from wall clock inside the machine - deadlines live in the adapter per Phase 2 section 5.7; no invoked promises whose outcome isn't reduced through a platform event).
- XState chosen per V2 section 12; the doc states the interface seam so "or equivalent" stays true: the reducer and guard signatures are library-independent.

### 4.9 Configuration Surface

Single table: key, type, default, consuming section. Minimum: max iterations, per-workflow budget cap, reviewer count per round, adversarial reviewer enabled (min one, V2 section 6.6), frontier panel size N, human auto-rules (explicit, versioned), escalation notification target.

### 4.10 Test Plan

- Transition-table coverage: one test per row; illegal transitions rejected.
- Orphan tests: result after each terminal state emits `OrphanResultSeen`, workflow unaffected, artifact linked.
- Guard tests: each guard against boundary inputs (cap exactly reached, single `minor` open objection blocks consensus, waiver path).
- Guard-input traceability test: every field a guard reads from folded state is produced by at least one platform event reduction (mechanical check against the guard-input-to-event table of 4.4).
- Usage/budget tests: `UsageRecorded` reduction accumulates spend; duplicate provider message ID is a no-op; the reduction crossing the cap emits `BudgetCapReached` exactly once and pauses; replay of a log with usage events yields the same `spendTotal`; zero-usage workflow passes the guard trivially.
- Reduction idempotency: duplicate and out-of-order signal delivery produces no duplicate events or transitions.
- Full planning-workflow walkthroughs: happy path to approval; objection loop to cap escalation; frontier finding re-entering the loop; budget pause; approval-with-waived-objections.
- Replay determinism: run a workflow, capture the log, fold twice, require identical state; kill/restart mid-turn at defined points (extends the Phase 3 recovery tests with engine-level assertions).
- Property test: random valid signal sequences never produce a second consensus, an event after terminal workflow state, or an unbounded iteration count.

### 4.11 Assigned Open Questions

None of the four V2 section 11 open questions land in Phase 4 (dedup → Phase 5, concurrency → Phase 2, reviewer pool → Phase 5, redaction → Phase 6). Phase 4-owned decisions recorded in the doc: the default iteration cap, the human auto-rule representation (how "human rules" in guards are declared and versioned), the fault-signal-to-escalation mapping table, and the `UsageRecorded` additive event revision (section 4.5).

### 4.12 Dependencies and Interfaces to Other Phases

- Depends on Phase 1 (event/objection/decision contracts, including the `UsageRecorded` revision), Phase 2 (AgentRuntime, signal stream), Phase 3 (outbox, fold runner, turn rows).
- Provides to Phase 5: turn lifecycle hooks - when to build prompts, when validation verdicts feed back, when the objection-merge step runs.
- Provides to Phase 6: the workflow states and events the dashboard read models and frontier step consume, and the usage-input seam of 4.5 (Phase 6 submits usage facts; the engine owns the event).
- Provides to Phase 7: the approved-plan handoff point (`HumanApproved` → implementation workflow).

## 5. Execution Steps

1. If `docs/phases/` is absent: create `README.md` and backfill from the three verified sources - `approved-plans/task-20260718-043855-83ecd8/plan.md` (Phase 1 spec), `approved-plans/task-20260718-065524-90fca8/plan.md` (Phase 1 backfill detail + Phase 2 spec), `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` (Phase 3 spec) - then create Phase 5-7 skeletons. The backfilled Phase 1 doc includes the `UsageRecorded` additive revision with its revision note. If `docs/phases/` is present: backfill only what is missing and apply the Phase 1 revision.
2. Write `docs/phases/phase-4-workflow-engine.md` with the twelve sections of section 4 above, citing Phase 1-3 doc sections for events, signals, persistence, and adapter interface.
3. Update `README.md` index: Phase 4 → "detailed".
4. Stop. No code.

## 6. Risks

- **Backfill debt keeps growing**: three approved executions have not landed; this turn may write five detailed docs. Accepted again - dependency order beats turn granularity - but flagged: executing the backlog before detailing Phases 5-7 would stop the debt compounding.
- **Contract revision precedent**: adding `UsageRecorded` revises an approved Phase 1 enumeration. Done through the Phase 1 versioning policy's additive rule with an explicit revision note, exactly the mechanism the Phase 2 plan reserved for missing kinds - the alternative (an impure guard or an undocumented side channel) breaks replay determinism, which is a V2 section 10 requirement.
- **Reducer/live-path drift**: prevented structurally (same function is both), and by the replay tests; stated as a hard rule in 4.7, not a convention.
- **XState lock-in**: mitigated by the library-independent reducer/guard seam in 4.8; "or equivalent" from V2 stays honest.
- **Duplication drift**: state diagram, workflow steps, and enums carry "source:" markers to V2 6.3/6.6 and the Phase 1 doc.
