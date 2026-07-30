# Phase 12: Proposal-Diff Signal and Frontier Re-invoke

**Status: implemented**

Phase 12 builds the shared proposal-diff signal and the loop rules that
consume it. Churn detection compares high-signal headings and execution
steps against the previous two planner proposals; frontier re-invoke uses
the same proposal diff to scrutinize major restructurings.

It adds **one new platform event kind** (`PlanChurnDetected`) and **no
SQL migration**. V2 sections: 6.3, 6.6, 6.7.

Packages consume:

- `@platform/contracts` - event catalog.
- `@platform/workflow-engine` - fold reducer, escalation effect.
- `@platform/persistence` - `turns` (read-only; proposal lookup by
  iteration).
- `@platform/orchestrator` - proposal-diff module, review loop,
  escalation report, CLI.

## 1. Goal and Non-Goals

**Goal.** Surface restructured plans to the frontier without requiring
the weak models to notice the condition, and provide a reusable
proposal-diff signal for future loop rules.

**Non-goals.**

- No semantic diff. The signal is token overlap and heading-set
  comparison, not an LLM judgement; an LLM-based diff would
  reintroduce the weak-model problem it exists to solve.
- No change to the objection gate, iteration cap, or stalemate
  breaker. The frontier re-invoke rule is an additive path.
- No engine-side file access. The workflow engine stays pure: the
  loop detects, the engine records - the same split Phase 10 used
  for `GuardrailConflict`.
- No semantic or LLM-based diff. The deterministic weighted score is
  intentionally conservative and configurable; the human remains the
  authority on a reported churn alarm.

## 2. The Proposal-Diff Signal

New orchestrator module `proposal-diff.ts`:

```ts
proposalSimilarity(a: string, b: string): number
sectionHeadings(text: string): string[]
sectionSteps(text: string): string[]
weightedProposalSimilarity(a: string, b: string): { simAll, simHeadings, simSteps, score }
isMajorRestructuring(prev: string, next: string, opts?): boolean
loadProposalAtIteration(store, workflowId, iteration): Snapshot | null
addedRemovedHeadings(prev: string, next: string): { added: string[]; removed: string[] }
```

### 2.1 Similarity metric

Whole-document token-set Jaccard remains the fallback `simAll` signal:
lowercase, map non-alphanumerics to spaces, split on whitespace, dedupe
into a set, and compute `|A n B| / |A u B|` (both empty -> `1`). The
weighted signal also computes `simHeadings` from `sectionHeadings` and
`simSteps` from bullet/numbered lines matching
`^\\s*([-*+]|(\\d+\\.))\\s+`:

```text
score = 0.5 * simSteps + 0.3 * simHeadings + 0.2 * simAll
```

### 2.2 Restructuring predicate

A restructuring is a **gate-mechanism or phase-structure change**,
detected as either:

- **Heading-set change.** `sectionHeadings` extracts markdown
  headings, normalized (lowercased, leading `4.` / `4.3`-style
  numbering stripped via `^\d+(?:\.\d+)*\.?\s*`). When both sides
  have headings, `headingChangeRatio` computes
  `(added + removed) / total`; at or above `headingChangeRatio`
  (default `0.7`) the predicate fires.
- **Wholesale rewrite.** Document similarity below
  `similarityFloor` (default `0.4`) even when headings survive.

Either condition fires the predicate. `sectionHeadings` returns
`null` (treated as "no headings") when neither side has any, so the
similarity floor is the only signal in that case.

### 2.3 Proposal lookup

`loadProposalAtIteration` resolves the completed planner turn at
`${workflowId}-iter-${N}` from `store.listTurns` (newest completed
first), reads its result envelope, parses `PlannerResultSchema` for
`proposalPath`, and reads the proposal file capped at
`MAX_PROPOSAL_BYTES = 64 * 1024`. Any failure (no turn, corrupt
envelope, missing file) returns `null` and the calling rule
**skips** - a detection heuristic must never crash the loop. The
current iteration's proposal is already in loop scratch
(`finalProposalPath`); only N-1 goes through the store, so fresh and
resumed runs behave identically.

## 3. Rule 1: Churn Detection

### 3.1 Trigger

In the loop's `planner_turn` step, after a valid planner result at
`iteration >= 3`, load the completed planner proposals at N-1 and N-2
and read the current proposal. Compute the weighted score for both
pairs. Churn fires when `score(N,N-2) >= scoreFloor` (default `0.65`)
and `score(N,N-2) >= score(N,N-1) + churnMargin` (default `0.0`). The
`churnDetection.disabled` switch is respected.

### 3.2 Implementation

The loop records `PlanChurnDetected` through
`engine.reportPlanChurn({ notify: false, ... })`, then builds a human
report containing all component scores and the added/removed heading
delta. The existing `onStalemate` callback receives reason `plan_churn`.
The choices apply an approved mitigation with `waiveOpenObjections`,
reject the objection, or abort with a configured escalation attention
request.

### 3.3 Loop integration

The check runs before reviewers or frontier turns for N, so a genuine
A -> B -> A oscillation stops early. Missing or invalid proposal artifacts
are treated as no signal and never crash the loop. The integration test
writes A, B, A proposals, asserts `plan_churn`, verifies that no reviewer
turn runs for N, and checks the durable `PlanChurnDetected` event.

### 3.4 Conservative behavior

The absolute floor plus relative advantage avoids escalating ordinary
vocabulary drift. Operators can raise the floor or margin, or disable the
rule, if production proposals show legitimate revisions being flagged.

## 4. Rule 2: Frontier Re-invoke

### 4.1 Trigger

In the loop's `collect_objections` step, after the reviewer round
and before `objectionsCollected`, run one `frontier_report` turn
when **all** hold:

1. `iteration >= 2` (an N-1 proposal exists);
2. the rule is not disabled;
3. the frontier has not already run at this iteration
   (`lastFrontierIteration` loop scratch, also set by the existing
   `frontier_review` step);
4. open objections exist (the debate is still spinning - a clean
   round falls through to the existing frontier gate immediately
   after, so a mid-loop run there would duplicate it);
5. both proposals load and `isMajorRestructuring(N-1, N)` holds.

### 4.2 Mechanics

The mid-loop turn uses the same context shape as the
`frontier_review` step (proposal path, summary, all objections,
codebase context). Its payload is ingested through a helper
factored out of the `frontier_review` case: `frontierReadiness`
updates, and blocking findings become objections via the existing
`raiseObjection` + `views.set` path, so the very next objection
gate sees them. `engine.reportFrontier` is **not** called - it is
phase-gated to `iteration_cap_check` / `frontier_review`, and the
planning phase machine needs no new transition for a turn that
only adds objections.

A read failure on the current proposal is treated as a no-signal
and the check skips - a transient read failure must not dispatch
a frontier turn against an empty comparison.

Condition 4 also bounds cost: at most one frontier turn per
iteration, only on restructuring iterations with an ongoing debate.

### 4.3 Interaction with churn detection

A revert of N to N-2 is also a large N-1 -> N change, so both
rules could match the same iteration. They never both fire: the
churn check runs in `planner_turn` and escalates before any
reviewer or frontier turn is dispatched for that iteration.

### 4.4 Corpus calibration

Defaults are calibrated against the motivating run's three
consecutive pairs (N-1 -> N) as measured by the weighted score and
`headingChangeRatio` on the actual proposal text:

| Pair | sim | hcr | Fires? | Why |
|---|---|---|---|---|
| iter 1 -> iter 2 | 0.489 | 0.533 | no | sim 0.489 sits above the 0.4 floor; hcr 0.533 sits below the 0.7 threshold |
| iter 2 -> iter 3 | 0.562 | 0.765 | yes | hcr 0.765 clears the 0.7 threshold |
| iter 3 -> iter 4 | 0.528 | 0.677 | no | sim 0.528 sits above the 0.4 floor; hcr 0.677 sits below the 0.7 threshold |

`packages/orchestrator/test/proposal-diff.test.ts` "corpus
calibration: cited mid-loop firings match defaults" pins this
calibration. Each test case reconstructs the cited pair from the
shared/unique token and heading counts, asserts sim and hcr
within `0.005` of the cited values, then asserts the predicate
outcome. Bumping the defaults (e.g. `similarityFloor: 0.5`,
`headingChangeRatio: 0.8`) drops the iter 2 -> iter 3 fire; the
chosen values keep the one fire the design wants and discard the
two borderline cases.

## 5. Configuration Surface

| Setting | Default | Effect |
|---|---|---|
| `ReviewLoopInput.frontierReinvoke.headingChangeRatio` | `0.7` | Heading-set turnover that triggers a mid-loop frontier. |
| `ReviewLoopInput.frontierReinvoke.similarityFloor` | `0.4` | Document similarity below this triggers a mid-loop frontier. |
| `ReviewLoopInput.frontierReinvoke.disabled` | off | Skips the mid-loop frontier rule. |
| `ReviewLoopInput.churnDetection.scoreFloor` | `0.65` | Minimum weighted N vs N-2 similarity required to alarm. |
| `ReviewLoopInput.churnDetection.churnMargin` | `0.0` | Required advantage of N vs N-2 over N vs N-1. |
| `ReviewLoopInput.churnDetection.disabled` | off | Disables the churn check. |
| `escalationNotificationTarget` | existing | Reused; the loop emits notifications for guardrail conflict and objection stalemate at abort time (see section 6). |

No environment variables. Configuration is per-run via
`ReviewLoopInput`; the CLI does not expose these because each is
operator-tuned per workflow and the defaults are calibrated.

## 6. Notification Ordering

Three engine entry points can produce an `escalation` or `escalated`
notification:

- `reportGuardrailConflict({ notify: false })` (engine method).
- `reportPlanChurn({ notify: false })` (engine method used by the
  planner-turn churn check).
- `engine.advancePlanning(workflowId, "evaluateObjectionGate", { notify: false })`
  (the gate itself, covering both `ObjectionStalemate` and
  `IterationCapReached`).

All three accept an optional `notify: boolean` parameter. When
`false`, the engine commits the event and the workflow state but
suppresses the `notifyEscalation` side effect.

The review loop passes `notify: false` to all three and emits the
notification itself via `comp.humanSink.notify` only when the
resolver returns `"abort"`. The re-emit uses
`escalationAttention(workflowId, config, reason, objectionIds)` from
`@platform/human-loop` so the request has the configured
`dashboardDeepLinkBase`, the `escalation` kind, the reason as
summary, and the open objection ids - identical to what
`adaptEscalationSink` would have produced. The `humanSink.notify`
call is `await`ed so the loop returns only after the sink has
processed the request.

This avoids a duplicate "review needed" notification arriving
before the interactive prompt and lets `accept_mitigation` /
`accept_objection` resolve the escalation without ever notifying
the human. The engine path is retained for callers (e.g.
`reportImplementationBlocked`) that need the synchronous
escalation.

## 7. Assigned Open Questions

- **"Keep iterating" choice.** A false-positive churn alarm
  currently costs the run: the human must abort and start fresh. A
  fourth resolver choice that un-escalates back to `planner_turn`
  needs a new engine method (escalated is terminal today);
  deferred until a false positive is observed.
- **Period > 2 oscillation.** Comparing N against every prior
  iteration and taking the max similarity would catch 3-cycle
  orbits; deferred - the observed failure was period-2 and the
  N-2 rule catches it (in the synthetic corpus; see 3.4 for the
  real-run limit).
- **False-positive calibration.** Tune the score floor and margin if
  production runs show legitimate revisions being flagged; the defaults
  remain conservative until that evidence exists.
- **Resume-time `lastFrontierIteration`.** The scratch is
  in-memory; a resume can re-run one frontier turn at the current
  iteration. Harmless (objection IDs embed the turn ID, so
  duplicates never merge silently); reconstructing it from the
  turn log is deferred.

## 8. Dependencies and Interfaces

**Depends on.**

- Phase 1: event catalog and additive-kind precedent;
  `PlannerResultSchema`.
- Phase 3: `turns`, fold projection.
- Phase 4: fold reducer, escalation effect, `humanDecision` from
  `escalated`.
- Phase 6: frontier finding conversion (`findingsFromReport`,
  `blockingFindings`).
- Phase 7: composition root, review loop, resume seed.
- Phase 9: escalation report and human override path.
- Phase 10: the loop-detects / engine-records split this phase
  reuses.

**Provides.**

- A reusable weighted proposal-diff signal for loop rules.
- Frontier scrutiny of restructured plans while the debate is
  still live, at bounded cost.
- The `PlanChurnDetected` event and `engine.reportPlanChurn` method,
  wired to the planner-turn churn check.
