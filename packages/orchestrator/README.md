<!-- generated-by: gsd-doc-writer -->
# @platform/orchestrator

Parrot's packaged composition root and CLI. It wires persistence, workflow
policy, prompt validation, Herdr runtime delivery, human escalation,
implementation, and verification into one resumable workflow.

## CLI

Development entrypoint:

```bash
pnpm --filter @platform/orchestrator orchestrate task.md
```

Compiled/global entrypoint:

```bash
pnpm --filter @platform/orchestrator build
pnpm --filter @platform/orchestrator link --global
parrot task.md
```

Resume:

```bash
parrot --resume
parrot --resume wf-123
```

The implementation and verifier roles share one workflow-specific worktree.
Worktree identity includes a stable hash of the raw workflow ID and is validated
before reuse.

## Library API

The package exports the composition root, review loop, turn runner, resume
helpers, implementation/verification helpers, proposal-diff utilities, codebase
context resolver, Herdr runner, and agent-session helpers. Worktree creation is
currently a CLI-internal module.

```ts
import {
  createComposition,
  runReviewLoop,
} from "@platform/orchestrator";
```

Plan-churn detection is currently deferred. `ReviewLoopInput.churnDetection`
remains an accepted no-op compatibility field. Frontier re-invocation is active.

## Commands

```bash
pnpm --filter @platform/orchestrator build
pnpm --filter @platform/orchestrator typecheck
pnpm --filter @platform/orchestrator test
```
