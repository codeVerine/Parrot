<!-- generated-by: gsd-doc-writer -->
# Testing

## Test stack

The backend packages use Node's built-in test runner with TypeScript loaded by
`tsx`:

```text
node --import tsx --test test/*.test.ts
```

Tests use temporary SQLite databases, fake Herdr transports/runtimes, fixture
runners, and filesystem fixtures. The dashboard package currently has no
browser or component test script; its production build is its local validation
gate.

## Full validation

From the repository root:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @platform/dashboard build
git diff --check
```

`pnpm typecheck` already runs a full build before package typechecks. Running
`pnpm build` separately is still useful because it makes the build result
explicit.

## Focused package tests

```bash
pnpm --filter @platform/contracts test
pnpm --filter @platform/herdr-adapter test
pnpm --filter @platform/persistence test
pnpm --filter @platform/workflow-engine test
pnpm --filter @platform/llm-boundary test
pnpm --filter @platform/human-loop test
pnpm --filter @platform/orchestrator test
```

The orchestrator and human-loop test scripts build their workspace dependencies
first. Several lower-level packages compile `@platform/contracts` before
running.

## Run one test file

Build the package dependencies first, then invoke the local test runner:

```bash
pnpm build
node --import tsx --test packages/orchestrator/test/worktree.test.ts
```

Run a group with shell globs:

```bash
node --import tsx --test packages/orchestrator/test/*.test.ts
```

Filter by test name with Node's test-runner option:

```bash
node --import tsx --test \
  --test-name-pattern='frontier re-invoke' \
  packages/orchestrator/test/loop.test.ts
```

## What each package covers

| Package | Main coverage |
|---|---|
| contracts | schema/version compatibility, events, signals, objections, TOON round trips |
| herdr-adapter | protocol pinning, startup, delivery, status, deadlines, result safety, reconnect and reconciliation |
| persistence | store transactions, folds, outbox, snapshots, recovery |
| workflow-engine | planning transitions, guards, findings, caps, usage, replay, turn reduction |
| llm-boundary | prompt pins, injection boundaries, extraction/evidence rules, objection merge/lifecycle |
| human-loop | dashboard projections, frontier conversion, notifications, cost ledger |
| orchestrator | composition, turns, resume, review loop, proposal diff, agent sessions, CLI bin, worktrees, implementation/verification |

## Live verification

Unit and integration tests do not replace these environment-dependent checks:

- start a real Herdr daemon and submit a large prompt;
- interrupt a workflow during a turn, then resume it;
- approve a workflow and confirm implementation and verification use the same
  worktree;
- inspect the generated prompt/result/proposal artifacts and SQLite rows.

Record these as live verification, not as part of the deterministic package test
count.

## Package-manager bootstrap failures

If Corepack refuses to launch the pinned pnpm because its registry signature
cannot be verified, no repository script has run. Report the bootstrap failure
separately. When dependencies and compiled workspace outputs already exist,
focused suites can still be run with the local `node --import tsx --test ...`
commands above.
