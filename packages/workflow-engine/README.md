<!-- generated-by: gsd-doc-writer -->
# @platform/workflow-engine

Deterministic workflow state machine for Parrot. It folds platform events,
enforces planning transitions and caps, tracks objection state, handles human
decisions and escalations, and emits persistence/runtime effects.

## Usage

```ts
import {
  DEFAULT_WORKFLOW_CONFIG,
  WorkflowEngine,
} from "@platform/workflow-engine";
```

The engine is the sole policy authority for workflow transitions. Semantic
reasoning stays in role turns; durable state changes stay here.

## Commands

```bash
pnpm --filter @platform/workflow-engine build
pnpm --filter @platform/workflow-engine typecheck
pnpm --filter @platform/workflow-engine test
```
