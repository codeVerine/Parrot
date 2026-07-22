# Phase 4: Workflow Engine

**Status: implemented**

The workflow engine is the deterministic orchestration core. The
implementation is `@platform/workflow-engine` under
`packages/workflow-engine`. It folds persisted platform events and reduces
adapter signals into explicit turn and workflow states, evaluates pure
guards, and is the sole writer of the `events` table. It never analyses
code and never calls an LLM. V2 sections: 6.3 and 6.6. It depends on
Phase 1 contracts, the Phase 2 `AgentRuntime` and signal stream, and
Phase 3 persistence (outbox, fold runner, turn rows).

The machine seam is library-independent: pure `foldReducer`, `reduceTurn`,
and `reducePlanning` functions are the source of truth. An XState (or
equivalent) wrapper may sit on top later; XState internal persistence is
not used.

## 1. Goal and Non-Goals

**Goal.** A state machine with guard conditions that consume folded
workflow state, objection status, and human rules. Waiting, retries,
routing, caps, cancellation, timeout synthesis, orphan handling, and
human escalation are all engine decisions. Live execution and replay use
the same reducer so recovery cannot diverge from live behavior.

**Non-goals.**

- No prompt construction (Phase 5).
- No TOON parsing or schema validation of agent results (Phase 5).
- No Herdr-specific APIs (Phase 2).
- No persistence schema ownership (Phase 3; consumed).
- No semantic judgement of any kind — objection dedup, review, and
  frontier analysis are LLM calls owned by Phase 5/6 components, invoked
  as workflow steps, never as management decisions inside the engine.

## 2. Turn State Machine

source: V2 section 6.3

```
created → sent → waiting → result_seen → validating
  → completed
  → repair_sent → waiting
  → failed | timed_out | cancelled
```

Every transition commits its state change and platform events in one
Phase 3 transaction. The engine is the only writer of `events`.

### 2.1 Transition table

| Current | Triggering input | Guard | Actions | Emitted events |
|---|---|---|---|---|
| (none) | engine starts turn | — | `saveTurn(created)`; prepare prompt path (Phase 5 hook) | — |
| `created` | delivery ack from `AgentRuntime.send` | — | `saveTurn(sent)` then `saveTurn(waiting)`; arm deadline via adapter | — |
| `waiting` | `ResultFileSeen` (correlated) | turn not terminal | `saveTurn(result_seen)` then `saveTurn(validating)`; invoke Phase 5 validation hook | — |
| `validating` | validation success (Phase 5 verdict) | — | `saveTurn(completed)` | `TurnCompleted` |
| `validating` | first validation failure | repair attempts remaining (`MAX_REPAIR_ATTEMPTS = 1`) | `AgentRuntime.send` repair; `saveTurn(repair_sent)` then `saveTurn(waiting)` | — |
| `validating` | second validation failure | no repair remaining | `saveTurn(failed)` | `TurnFailed` |
| `waiting` | `DeadlineExpired` | turn in `waiting` | `saveTurn(timed_out)` | `AgentTimedOut` |
| `waiting` / `sent` / `validating` | `interrupt` or `stop` | — | `AgentRuntime.interrupt`/`stop`; `saveTurn(cancelled)` | — |
| `waiting` | fault: spawn/delivery/watch/artifact (see §11) | — | `saveTurn(failed)` | `TurnFailed` |
| terminal (`failed` \| `timed_out` \| `cancelled`) | `ResultFileSeen` | — | link artifact to original turn; no workflow advance | `OrphanResultSeen` |

Illegal transitions are rejected and produce no events.

### 2.2 Signal reduction

| Signal | Classification | Reduction |
|---|---|---|
| `ResultFileSeen` | observation | → `result_seen` when turn is `waiting`; orphan path when terminal |
| Phase 5 validation success | engine input (not a signal) | → `completed` + `TurnCompleted` |
| Phase 5 first validation failure | engine input | → `repair_sent` → `waiting` |
| Phase 5 second validation failure | engine input | → `failed` + `TurnFailed` |
| `DeadlineExpired` | observation | → `timed_out` + `AgentTimedOut` |
| `interrupt` / `stop` | engine command | → `cancelled` |
| `HerdrStatusChanged` | observation | recorded; may accelerate artifact check; never completes a turn alone |
| `SnapshotReconciled` | observation | may rediscover late artifacts; reduced through the same `ResultFileSeen` / orphan paths |
| Fault signals | fault | mapped per §11; no fault is silently dropped |

### 2.3 Orphan-result rule

source: V2 sections 5 (step 8) and 6.3

A `ResultFileSeen` for a turn already in `failed`, `timed_out`, or
`cancelled` emits `OrphanResultSeen`, links the artifact to the original
turn for audit, and cannot advance the workflow or satisfy a retry.

### 2.4 Late and duplicate signal safety

Correlation key: `turnId` + nonce + artifact hash.

- A signal already reduced (same correlation key) is a no-op.
- Signals for stale turns are recorded in `runtime_signals` but never
  re-reduce a completed transition.
- Out-of-order delivery cannot produce a second consensus, a duplicate
  platform event for the same transition, or an unbounded iteration.

## 3. Planning Workflow Definition

source: V2 section 6.3

The planning workflow is an explicit machine. States below are workflow
phase names; turn machines (section 2) run as child actors for each
active turn.

| Step | Workflow state | What happens | Guards / events |
|---|---|---|---|
| 1 | `planner_turn` | Persistent planner turn → proposal | `TurnCompleted` for planner role |
| 2 | `spawn_reviewers` | Spawn fresh ephemeral reviewers via `AgentRuntime.start`; send review turns | — |
| 3 | `collect_objections` | Collect reviewer results; all rounds deadline-bounded | `ObjectionRaised` per validated objection |
| 4 | `merge_objections` | Invoke Phase 5 Objection Engine merge/dedupe as a workflow step (non-destructive clustering) | merge turn completed |
| 5 | `objection_gate` | Evaluate open objections | `hasOpenObjections` true → planner iteration, `iteration++`; false → step 6 |
| 6 | `iteration_cap_check` / `frontier_review` | Cap check then frontier | `underIterationCap` false → escalate (§6); else frontier turn |
| 7 | `frontier_to_objections` | Frontier blocking findings → objections | `ObjectionRaised`; `frontierHasBlockingFindings` → back to step 5, same iteration cap |
| 8 | `await_human` | Dashboard read models refresh (Phase 6); request human decision via `NotificationSink` | engine emits request event only |
| 9 | `human_decision` | Human response | `HumanApproved` → `ConsensusReached` / approved path → Phase 7 handoff; `HumanRejected` → recorded, end or re-iterate per human rule; approval with open objections is explicit waiver (`waived`), never silent |
| 10 | `escalated` | Iteration or budget cap | `IterationCapReached` or `BudgetCapReached` with open objection list; never loop silently |

**Reviewer context rule** (V2 section 11 resolved question 2): first-round
reviewers are independent (no merged state). Later rounds receive merged
objection state.

**Resolution verification** (V2 section 6.6): planner responses to
objection IDs are verified by a fresh reviewer session. Modeled as a
distinct turn type `resolution_verification` inside the objection loop,
not as a side effect of the planner turn.

**Consensus gate** (V2 section 6.6 / Phase 1): zero open objections of
any severity. Severity enum: `blocking | major | minor`. Status enum:
`open | accepted | rejected | superseded | resolved | waived`
(source: V2 section 6.6, defined in Phase 1).

## 4. Guards

Guards are pure functions over folded state and config. No clock, no I/O,
no table queries, no randomness. Every guard input is traceable to a
platform event payload.

| Guard | Inputs (folded) | Predicate | Consuming transition |
|---|---|---|---|
| `hasOpenObjections` | objections with status `open` | any open objection of any severity | objection gate → planner iteration vs frontier |
| `underIterationCap` | `iterationCount`, config `maxIterations` | `iterationCount < maxIterations` | cap check before frontier / next iteration |
| `underBudgetCap` | `spendTotal`, config `budgetCap` | `budgetCap === null` or `spendTotal < budgetCap` | before continuing after usage reduction; cap crossing pauses |
| `frontierHasBlockingFindings` | frontier-report outcome flags | any blocking finding present | frontier → re-enter objection loop |
| `humanRuleAllows` | folded human-rule match result | matching auto-rule action applies; absent rule → ask human | human decision step |

### 4.1 Guard-input-to-event table

| Folded field | Produced by |
|---|---|
| objection status / severity / id | `ObjectionRaised`, `ObjectionResolved` (and waiver via human path updating status) |
| `iterationCount` | planner-iteration transitions recorded with workflow events; cap emission `IterationCapReached` |
| `spendTotal` | `UsageRecorded` (cost payload accumulated) |
| frontier blocking flags | frontier turn completion folded from validated frontier report (Phase 5 verdict → engine input → events) |
| human decision / waiver | `HumanApproved`, `HumanRejected`, `ConsensusReached` |
| degraded mode flag | fault reduction of `DegradedModeEntered` into folded state |

## 5. Usage and Budget Event Flow

Closes the requirement that budget data live in the event log so
`underBudgetCap` stays pure.

**`UsageRecorded`** is an additive Phase 1 catalog revision (thirteenth
v1 event family member; see Phase 1 doc). The engine does not redefine
the contract schema; it folds the cost-related fields cited in V2
section 6.10 (provider message ID for dedup, cache/input/output tokens,
computed cost, pricing version, correlation).

**Flow.**

1. Phase 6 cost ledger parses session logs via versioned provider
   adapters and writes `usage_ledger` rows (Phase 3 schema).
2. The ledger submits each new usage fact to the engine as an input.
3. The engine — sole writer of `events` — deduplicates by provider
   message ID against folded state, appends `UsageRecorded`, and folds
   `spendTotal += cost` in the same transaction.
4. Replay refolds the same payloads, so live and replayed spend totals
   are identical by construction.

**Cap crossing.** The reduction that pushes `spendTotal` over the config
cap emits `BudgetCapReached` in the same transaction and moves the
workflow to `escalated` (V2 section 6.10: pause and notify, never
continue silently).

**Phasing.** Phase 4 specifies the reduction, the fold field, the guard,
and the cap-crossing emission. Until Phase 6 exists, no usage inputs
arrive, `spendTotal` stays zero, and `underBudgetCap` passes trivially.
Enforcement activates when Phase 6 lands with no engine change. A zero
total is not measured cost.

`usage_ledger` remains the audit/reporting table (Phase 3/6). The event
log is the enforcement path. The two roles must not be conflated.

## 6. Escalation and Caps

Triggers that enter the named workflow state `escalated`:

- Iteration cap reached with open objections → `IterationCapReached`
  (payload: cap value, observed value, open objection IDs).
- Budget cap reached → `BudgetCapReached` (payload: cap, observed
  spend, open objection IDs) and pause.
- Frontier flags that cannot be resolved within the iteration cap.
- `ImplementationBlocked`.

Each case emits its platform event, pauses in `escalated`, and requests
human input with the open objection list attached. Explicitly: no silent
looping, no silent continuation past a cap.

## 7. Engine as Fold Reducer

Phase 3 provides `FoldRunner`; Phase 4 provides the reducer:

```ts
(foldedState, platformEvent) → foldedState
```

The live path and the replay path execute the same reducer. The
machine's transition function *is* the reducer, so recovery cannot
diverge from live behavior (V2 section 10, replay/recovery divergence).

**Startup recovery.**

1. Phase 3 opens the database, reconstructs undispatched outbox events
   and active turn deadlines.
2. Engine folds the event log to rebuild workflow state.
3. Engine resumes from folded state; in-flight turns resume in
   `waiting`.
4. Adapter re-arms deadlines from turn rows and runs `resync()` for
   results missed during downtime.
5. Outbox re-dispatches undispatched events to idempotent consumers.

**Determinism.** Given the same event log, the reducer yields identical
state. Enforced by Phase 3 replay tests plus Phase 4 property tests
(section 10).

## 8. XState Mapping

source: V2 section 12 (XState chosen); interface seam keeps "or
equivalent" honest.

| Abstract concept | XState landing |
|---|---|
| Planning workflow | One parent workflow machine |
| Active turns | Child turn machines (actors) per `turnId` |
| Guards | Pure functions; no services, no I/O |
| Persist-then-dispatch | Actions are effects that go through Phase 3 transactions; XState internal persistence is not used |
| Deadlines | Live in the Phase 2 adapter; not XState delayed transitions from wall clock |
| Source of truth | Event log only (V2 section 2) |

**Nondeterminism ban.** No XState feature may introduce nondeterminism:
no delayed transitions from wall clock inside the machine; no invoked
promises whose outcome is not reduced through a platform event. The
reducer and guard signatures are library-independent so an equivalent
machine library can replace XState without changing contracts.

## 9. Configuration Surface

| Key | Type | Default | Consuming section |
|---|---|---|---|
| `maxIterations` | positive int | `5` | §4 `underIterationCap`, §6 |
| `budgetCap` | `number \| null` | `null` (unlimited until set) | §4 `underBudgetCap`, §5, §6 |
| `reviewerCountPerRound` | positive int | `2` | §3 step 2 |
| `adversarialReviewerEnabled` | boolean | `true` (min one adversarial when enabled; V2 §6.6) | §3 step 2 |
| `frontierPanelSize` | positive int | `1` | §3 steps 6–7 |
| `humanAutoRules` | versioned list (see §11) | `[]` | §4 `humanRuleAllows`, §3 step 9 |
| `escalationNotificationTarget` | string | configured at deploy | §6 |

## 10. Test Plan

Package tests live under `packages/workflow-engine/test/` and cover:

- **Transition-table coverage:** created→completed, repair then fail,
  deadline timeout, cancel, illegal transitions rejected.
- **Orphan tests:** result after `failed` / `timed_out` / `cancelled`
  emits `OrphanResultSeen`, workflow unaffected, artifact linked.
- **Guard tests:** each guard against boundary inputs (cap exactly
  reached, single `minor` open objection blocks consensus, waiver path).
- **Guard-input traceability:** every field a guard reads from folded
  state is produced by at least one platform event reduction (mechanical
  check against §4.1 / `GUARD_INPUT_EVENTS`).
- **Usage/budget:** `UsageRecorded` accumulates spend; duplicate provider
  message ID is a no-op; crossing the cap emits `BudgetCapReached`
  exactly once and pauses; replay yields the same `spendTotal`;
  zero-usage workflow passes the guard trivially.
- **Reduction idempotency:** duplicate `ResultFileSeen` correlation is a
  no-op; duplicate orphan hashes do not re-emit.
- **Planning walkthroughs:** happy path to approval; objection loop to
  cap escalation; frontier finding re-entering the loop; budget pause;
  approval-with-waived-objections.
- **Replay determinism:** fold twice over the same log; recover mid-turn
  with pending deadlines and restored spend.

## 11. Assigned Decisions

None of the four V2 section 11 open questions land in Phase 4
(dedup → Phase 5, concurrency → Phase 2, reviewer pool → Phase 5,
redaction → Phase 6). Phase 4-owned decisions:

### 11.1 Defaults

Recorded in §9: `maxIterations = 5`, `budgetCap = null`,
`reviewerCountPerRound = 2`, `adversarialReviewerEnabled = true`,
`frontierPanelSize = 1`.

### 11.2 Human auto-rule representation

```ts
type HumanAutoRule = {
  id: string;
  version: number; // positive int; rules are immutable per version
  predicate: string; // named folded-state check, e.g. "noOpenObjections"
  action: "approve" | "reject" | "escalate";
};
```

Rules are an ordered, versioned list on the workflow config. Evaluation
picks the first matching predicate against folded state. Absent matching
rule means ask the human (V2 section 11 resolved question 6). Predicates
are named checks over folded fields only — same purity rule as guards.

### 11.3 Fault-signal-to-escalation mapping

| Fault signal | Outcome |
|---|---|
| `AgentSpawnFailed` | turn `failed` + `TurnFailed` |
| `TurnDeliveryFailed` | turn `failed` + `TurnFailed` |
| `ResultWatchFailed` | turn `failed` + `TurnFailed` |
| `ArtifactRejected` | turn `failed` + `TurnFailed` |
| `ReconnectFailed` | workflow `escalated` + pause |
| `ProtocolMismatch` | workflow `escalated` + pause |
| `DegradedModeEntered` | recorded in folded state; continue with degraded features disabled (no silent success path for disabled features) |

No fault signal is silently dropped.

### 11.4 `UsageRecorded` revision

Additive Phase 1 catalog revision already recorded in the Phase 1 doc
and `@platform/contracts`. This phase owns the reduction, fold field,
guard, and cap-crossing behavior (§5), not a second schema definition.

## 12. Dependencies and Interfaces

**Depends on.**

- Phase 1: event/objection/decision contracts, including `UsageRecorded`.
- Phase 2: `AgentRuntime` (`start`, `send`, `wait`, `result`,
  `interrupt`, `stop`, `resync`) and the runtime signal stream.
- Phase 3: transactional outbox, `FoldRunner`, turn rows, recovery
  snapshots, sole-writer rule for `events` (engine is that writer).

**Provides to Phase 5.** Turn lifecycle hooks: when to build prompts,
when validation verdicts feed back, when the objection-merge step runs,
and the `resolution_verification` turn type.

**Provides to Phase 6.** Workflow states and events for dashboard read
models and the frontier step; the usage-input seam of §5 (Phase 6
submits usage facts; the engine owns the event). Escalation delivery
goes through the engine's required `NotificationSink.notifyEscalation`
hook; Phase 6 can wrap that sink with dashboard/notify integrations.

**Provides to Phase 7.** Approved-plan handoff:
`HumanApproved` → implementation workflow.
