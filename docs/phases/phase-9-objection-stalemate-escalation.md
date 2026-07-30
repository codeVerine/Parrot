# Phase 9: Objection Stalemate Escalation

**Status: implemented**

Phase 9 adds the loop-level circuit breaker the review loop lacks. In the
observed run the loop spun three iterations on one objection cluster: the
planner patched a fundamentally flawed concept, the reviewer re-raised it, and
nothing capped the wasted attempts. The debate was a design tension, not a
planning defect, so it should have reached a human after the first failed
mitigation.

The rule is engine-enforced, not prompt-advised: if an objection ID is `open` in
iteration N, resolved by the planner in N+1, and raised again in N+2, the
objection gate hard-stops instead of dispatching iteration N+3. It escalates
with the full objection history and both sides' evidence, and the human chooses
between accepting the mitigation, accepting the objection as a hard block, or
aborting.

It introduces **one new platform event kind** (`ObjectionStalemate`), one
additive folded-state field, and **no schema migration**. V2 sections: 6.3, 6.6.

Packages consume:

- `@platform/contracts` - event catalog, `ObjectionRaised`,
  `ObjectionResolved`.
- `@platform/workflow-engine` - `foldReducer`, guards, `reducePlanning`
  objection gate, escalation notification effect.
- `@platform/persistence` - `objections`, `events`, `decisions` (read-only for
  the report).
- `@platform/human-loop` - escalation notification sink.
- `@platform/orchestrator` - review loop, CLI human prompt.

## 1. Goal and Non-Goals

**Goal.** Cap wasted iterations at exactly one failed mitigation attempt per
objection, and hand the human a decision packet rather than a dead run.

**Non-goals.**

- No semantic judgement of whether the mitigation was good. The engine counts
  state transitions; it never reads a claim.
- No SQL migration. The `objections` row is lossy by design (its status is
  overwritten on re-raise); the event log is the history.
- No change to the iteration cap. Stalemate escalation is a second, tighter
  breaker that fires before the cap in the same gate.

## 2. Detection Model

source: V2 section 6.3 (guards consume folded state only)

### 2.1 Folded state

`FoldedObjection` gains one counter:

```ts
export type FoldedObjection = {
  objectionId: string;
  severity: "blocking" | "major" | "minor";
  status: "open" | "accepted" | "rejected" | "superseded" | "resolved" | "waived";
  reraiseCount: number;   // additive
};
```

`ObjectionRaised` no longer clobbers an existing entry. It preserves the counter
and increments it **only** when the prior status was `resolved`:

| Prior state | New state |
|---|---|
| absent | `open`, `reraiseCount = 0` |
| `open` | `open`, counter unchanged |
| `resolved` | `open`, `reraiseCount + 1` |

Incrementing only out of `resolved` is what makes the signal precise: two
reviewers raising the same still-open ID in one round is not a stalemate, and
does not count.

`ObjectionResolved` keeps its existing behavior (status -> `resolved`), and the
loop now passes `iterationId` and `turnId` on the resolve call so the event log
carries the addressal's provenance for the report.

### 2.2 Snapshot compatibility

`rehydrateFromSnapshot` spreads a durable snapshot over initial state, so a
workflow persisted before this phase would restore objections without the
counter. A normalizer defaults missing `reraiseCount` to `0` on rehydrate. Fold
from the event log needs no normalizer - it recomputes the counter.

### 2.3 Guard

```ts
stalemateObjectionIds(state): string[]   // status === "open" && reraiseCount >= 1, sorted
```

## 3. Gate Enforcement

The check runs inside `reducePlanning` at `evaluateObjectionGate`, **before**
the iteration-cap branch, so a stalemate escalates even when iterations remain.

| Condition | Transition | Events | Effects |
|---|---|---|---|
| stalemate IDs non-empty | -> `escalated` | `ObjectionStalemate` | `notifyEscalation(reason: "objection_stalemate")`; persist status `escalated` |
| open objections, under cap | -> `planner_turn` | — | (unchanged) |
| open objections, cap reached | -> `escalated` | `IterationCapReached` | (unchanged) |
| no open objections | -> `iteration_cap_check` | — | (unchanged) |

New event:

```
ObjectionStalemate { objectionIds: string[] }   // min length 1
```

It folds to `escalated`, matching `ImplementationBlocked`. The persistence fold
projection is extended alongside the catalog so the new kind is projected, not
silently ignored.

## 4. Human Decision Packet

An escalation that only prints "stalemate" is useless, and `escalated` is
excluded from `listResumableWorkflows`, so a bare escalation would dead-end the
run. Phase 9 therefore ships both a report and an override path.

### 4.1 Report

`buildStalemateReport(store, workflowId, objectionIds)` composes, per objection:

- claim, evidence, severity, raising agent, turn ID, iteration;
- the planner's addressal for that ID - the resolution string from the
  `ObjectionResolved` event, and (once Phase 10 lands) the structured evidence
  from the `decisions` row;
- the iteration numbers of the original raise, the resolve, and the re-raise.

### 4.2 Override

The review loop invokes a resolver on escalation:

```ts
onStalemate?: (ctx: {
  workflowId: string;
  objectionIds: string[];
  report: string;
}) => "accept_mitigation" | "accept_objection" | "abort"
      | Promise<"accept_mitigation" | "accept_objection" | "abort">;
```

| Choice | Engine call | Result |
|---|---|---|
| `accept_mitigation` | `humanDecision({ decision: "approved", waiveOpenObjections: true })` | run continues into implementation |
| `accept_objection` | `humanDecision({ decision: "rejected" })` | run ends rejected, plan is the record |
| `abort` (default) | none | run ends `escalated` for offline review |

`reducePlanning` already accepts `humanDecision` from the `escalated` phase, so
no new transition is needed. The CLI prints the report and prompts on the
existing readline interface; the default when no resolver is supplied is
`abort`, preserving current behavior for tests and non-interactive runs.

`ReviewLoopResult` gains
`escalation?: { reason: "objection_stalemate"; objectionIds: string[] }` so
callers can distinguish a stalemate stop from an iteration-cap stop.

## 5. Configuration Surface

| Setting | Default | Effect |
|---|---|---|
| re-raise threshold | `1` | Fixed by design: exactly one failed mitigation attempt. Not configurable until a run shows a reason. |
| `escalationNotificationTarget` | existing | Reused; reason string is `objection_stalemate`. |

## 6. Test Plan

- Fold: raise -> raise keeps `reraiseCount` at 0; raise -> resolve -> raise sets
  it to 1; replay from the event log reproduces the counter exactly.
- Rehydrate: a snapshot without the field restores `reraiseCount = 0`.
- Gate: with one stalemate ID and iterations remaining, the gate escalates,
  emits `ObjectionStalemate`, and does not transition to `planner_turn`.
- Loop: reviewer raises OBJ-1 in iteration 1, planner addresses it in iteration
  2, reviewer re-raises in iteration 2 -> loop returns `escalated` with exactly
  two planner turns dispatched.
- Override: `accept_mitigation` from `escalated` reaches `approved` with the
  objection waived; `abort` leaves the workflow `escalated`.
- Report: contains claim, evidence, both turn IDs, and the resolution string.

## 7. Assigned Open Questions

- **Cluster-level stalemate.** Merged objection clusters share a representative
  claim; whether a re-raise of any member should escalate the cluster is
  deferred until clustering is exercised in a real run.
- **Reframe path.** The V2 human choice list includes "reframe the requirement",
  which needs a task-edit-and-restart flow. Deferred; `accept_objection` plus a
  fresh run is the interim answer.

## 8. Dependencies and Interfaces

**Depends on.**

- Phase 1: event catalog and additive-kind precedent.
- Phase 3: `events`, `objections`, `decisions`, fold projection.
- Phase 4: objection gate, guards, escalation effect, `humanDecision` from
  `escalated`.
- Phase 6: escalation notification sink.
- Phase 7: composition root, review loop, CLI human prompt.

**Provides.**

- A bounded objection debate with a durable stalemate record.
- The report surface Phase 10 fills in with structured addressal evidence.
