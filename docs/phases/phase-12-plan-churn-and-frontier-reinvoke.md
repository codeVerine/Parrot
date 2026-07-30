# Phase 12: Proposal-Diff Signal and Frontier Re-invoke

**Status: implemented (churn detection deferred)**

Phase 12 builds the shared proposal-diff signal and the loop rules that
consume it. The **frontier re-invoke** rule ships: it re-runs the frontier
mid-loop when the planner makes a major restructuring while objections
remain open. The originally proposed **churn detection** rule is
intentionally **deferred**: deterministic similarity metrics did not
separate the motivating reversion from ordinary revisions on real
proposals, so wiring a false-positive-prone alarm into the loop would cost
runs.

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
- No semantic or LLM-based diff. The deterministic signals are
  intentionally conservative and configurable; if churn detection is
  re-enabled, the human remains the authority on a reported alarm.

## 2. The Proposal-Diff Signal

New orchestrator module `proposal-diff.ts`:

```ts
proposalSimilarity(a: string, b: string): number
sectionHeadings(text: string): string[]
sectionSteps(text: string): string[]
weightedProposalSimilarity(a: string, b: string): { simAll, simHeadings, simSteps, score, weights, used }
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
base weights: steps=0.5, headings=0.3, all=0.2
exclude a component when it is empty on both sides
renormalize remaining weights to sum to 1
score = w_steps*simSteps + w_headings*simHeadings + w_all*simAll
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
`[]` when neither side has any, so the
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

## 3. Rule 1: Churn Detection (Deferred)

The churn detector was designed to halt a loop that is oscillating between
two approaches (e.g. A → B → A). In practice, deterministic similarity
metrics did not cleanly separate the motivating reversion from legitimate
iteration-to-iteration drift on real proposals, so the loop integration is
**disabled** for now.

What ships today:

- The `PlanChurnDetected` event kind and `engine.reportPlanChurn(...)` method.
- The `buildChurnReport(...)` formatter for human review.
- The `ReviewLoopInput.churnDetection` config field as a **no-op** stub (so
  callers passing legacy config do not fail validation).

A future phase can re-enable this rule once a heuristic is validated on real
corpora (e.g. section-weighted similarity, longer-period oscillation
detection, or structure-aware hashing).

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

Churn detection is currently deferred, so there is no interaction: only the
frontier re-invoke rule is active.

### 4.4 Corpus calibration

Defaults are calibrated against the motivating run's three
consecutive pairs (N-1 -> N) as measured by `proposalSimilarity` and
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
| `ReviewLoopInput.churnDetection.*` | n/a | Reserved. Currently a no-op stub; churn detection is deferred. |
| `escalationNotificationTarget` | existing | Reused; the loop emits notifications for guardrail conflict and objection stalemate at abort time (see section 6). |

No environment variables. Configuration is per-run via
`ReviewLoopInput`; the CLI does not expose these because each is
operator-tuned per workflow and the defaults are calibrated.

## 6. Notification Ordering

Three engine entry points can produce an `escalation` or `escalated`
notification:

- `reportGuardrailConflict({ notify: false })` (engine method).
- `reportPlanChurn({ notify: false })` (engine method; currently unused by the loop).
- `engine.advancePlanning(workflowId, "evaluateObjectionGate", { notify: false })`
  (the gate itself, covering both `ObjectionStalemate` and
  `IterationCapReached`).

All three accept an optional `notify: boolean` parameter. When
`false`, the engine commits the event and the workflow state but
suppresses the `notifyEscalation` side effect.

The review loop passes `notify: false` to guardrail-conflict reporting and the
objection gate. The plan-churn entry point is retained for future callers but is
not invoked by the loop while churn detection is deferred. For active loop
escalations, the loop emits the notification itself via
`comp.humanSink.notify` only when the resolver returns `"abort"`. The re-emit uses
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

- **"Keep iterating" choice.** If churn detection is re-enabled, a false-positive
  churn alarm would cost the run: the human must abort and start fresh. A
  fourth resolver choice that un-escalates back to `planner_turn`
  needs a new engine method (escalated is terminal today);
  deferred until a false positive is observed.
- **Period > 2 oscillation.** If/when churn detection is re-enabled, comparing
  N against every prior iteration and taking the max similarity would catch
  3-cycle orbits.
- **False-positive calibration.** If/when churn detection is re-enabled, tune
  any floor/margin against real corpora before wiring an alarm into the loop.
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
  ready for a future churn heuristic (the loop does not wire it today).
