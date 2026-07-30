# TODO

Current repository follow-ups as of 2026-07-30. Completed implementation history
is summarized below; phase details remain in `docs/phases/`.

## Active

### Validate and design plan-churn detection

**Priority:** P1

**Status:** deferred intentionally

The motivating A → B → A run cannot be separated from ordinary revisions by the
tested absolute or relative token-set Jaccard rules. The live review loop
therefore does not report plan churn.

What already exists:

- proposal token, heading, step, and weighted similarity utilities;
- `PlanChurnDetected` in the additive event catalog;
- `WorkflowEngine.reportPlanChurn`;
- churn escalation report formatting; and
- `ReviewLoopInput.churnDetection` as an accepted no-op compatibility field.

Before enabling the rule:

1. collect a larger real-proposal corpus with labelled reversion/non-reversion
   pairs;
2. evaluate section-aware and period-greater-than-two signals;
3. choose an acceptable false-positive rate;
4. add loop-level positive/negative/resume tests; and
5. define whether a human can continue an escalated workflow without starting a
   fresh run.

Design record:
`docs/phases/phase-12-plan-churn-and-frontier-reinvoke.md`.

### Retire the legacy root orchestrator

**Priority:** P1

**Status:** pending live parity approval

The current runtime is `@platform/orchestrator`; the root `src/` tree remains a
compatibility implementation behind `pnpm orchestrate:legacy`. Follow the
guarded acceptance criteria in `task.md` before deleting it. Until then, keep the
root TypeScript check and its dependencies.

### Reconstruct the last frontier iteration on resume

**Priority:** P2

**Status:** open

`ResumeSeed.lastFrontierIteration` currently starts at `0`. A resume that enters
the objection-collection phase after a frontier turn can dispatch one additional
frontier turn for the same iteration. Reconstruct the value from completed
frontier turn rows and add a resume regression test.

### Define worktree cleanup

**Priority:** P2

**Status:** open

Implementation/verifier worktrees are intentionally retained for audit and are
not cleaned automatically. Decide between manual cleanup, cleanup after verified
success, or cleanup after a later human acknowledgement. Any automated policy
must preserve blocked/deviation evidence and avoid deleting an operator-owned
worktree.

### Provide a runnable dashboard server

**Priority:** P2

**Status:** partial

The versioned read-model projection, HTTP API, decision endpoint, and React/Vite
client are implemented. The main CLI does not instantiate the API or expose a
`dashboard` command. Add a supported server entrypoint before documenting the
dashboard as an end-user feature.

### Add dashboard automation and repository CI

**Priority:** P2

**Status:** open

The dashboard has a production build but no component/browser test script. The
repository also has no checked-in CI workflow. Add focused UI coverage first,
then run the documented build/typecheck/test/dashboard-build gates in CI.

### Repeat live Herdr verification

**Priority:** P2

**Status:** environment-dependent

Run a real workflow that covers:

- a large prompt submission;
- interruption followed by late-result adoption/resume;
- a major proposal restructuring with one bounded frontier re-invocation;
- approval, implementation, and verification in the shared worktree; and
- global `parrot` invocation from a different target repository.

Keep this result separate from deterministic package-test counts.

## Shipped

The current package implementation includes:

- reliable Herdr prompt submission with bounded acknowledgement/retry;
- idle-reset plus absolute-cap turn deadlines;
- durable event-log recovery and semantically validated late-result adoption;
- workflow-scoped provider session reattachment;
- codebase-context injection and cite-or-block role prompts;
- objection stalemate escalation;
- structured objection addressals and guardrail-conflict escalation;
- reviewer `cleanRationale` enforcement;
- proposal-diff utilities and calibrated frontier re-invocation;
- notification-after-interactive-resolution ordering;
- concise per-turn terminal progress;
- lazy role spawning;
- portable/global `parrot` entrypoint;
- isolated implementation worktrees with collision-safe identity and ownership
  validation; and
- verification in the implementation worktree with git evidence.

Phase status:
`docs/phases/README.md`.
