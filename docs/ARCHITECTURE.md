<!-- generated-by: gsd-doc-writer -->
# Architecture

## Overview

Parrot is a pnpm TypeScript monorepo. A deterministic workflow engine owns state
transitions; model-backed agents only perform semantic work through
schema-validated turn artifacts. SQLite and the append-only event log are the
durable source of truth.

The packaged runtime is assembled by `@platform/orchestrator`. The root `src/`
tree is a retained compatibility implementation and is not part of the package
architecture described below.

## Components

```text
operator
   |
   v
@platform/orchestrator CLI
   |-- @platform/herdr-adapter ---- Herdr ---- provider CLIs
   |-- @platform/llm-boundary ----- prompts / TOON validation
   |-- @platform/workflow-engine -- deterministic transitions
   |-- @platform/persistence ------ SQLite / event log / outbox
   `-- @platform/human-loop ------- frontier, notification, dashboard, cost
                                                |
                                                v
                                      @platform/dashboard
```

All role and event payloads cross package boundaries through
`@platform/contracts`.

| Package | Responsibility |
|---|---|
| `@platform/contracts` | Branded IDs, event and signal catalogs, TOON codec, objections, decisions, and role-result schemas |
| `@platform/herdr-adapter` | Protocol-16 client, startup validation, role identity, reliable prompt submission, deadlines, result watching, and reconciliation |
| `@platform/persistence` | SQLite schema and access layer, event append/fold, outbox, recovery, artifacts, turns, decisions, objections, and usage |
| `@platform/workflow-engine` | Planning phase reducer, guards, caps, escalation, turn reduction, and human decisions |
| `@platform/llm-boundary` | Versioned prompt registry, injection-delimited evidence, result extraction, schema/evidence rules, repair verdicts, and objection lifecycle |
| `@platform/human-loop` | Frontier finding conversion, notification sinks, dashboard projection/API, cost ledger, redaction, and retention policy |
| `@platform/orchestrator` | Composition root, CLI, review loop, resume adoption, implementation/verification, codebase context, proposal diffing, and worktrees |
| `@platform/dashboard` | React/Vite client for structured workflow read models and human decisions |

## Workflow

```text
planner
  -> reviewers
  -> objection gate
     -> revise and repeat
     -> frontier review
     -> human decision
        -> implementation
        -> verification
```

The loop can stop earlier for malformed results, turn failure, iteration cap,
objection stalemate, or a planner-reported guardrail conflict. A materially
restructured proposal can trigger another frontier turn while objections remain
open. Plan-churn detection is not active.

### Turn protocol

1. The orchestrator creates a durable turn identity and writes `prompt.md`.
2. The Herdr adapter submits the prompt to the role pane.
3. The agent writes `result.tmp`, validates its response shape, and atomically
   renames it to `result.toon`.
4. The extractor checks turn identity, nonce, schema, and role-specific evidence
   rules.
5. A failed validation gets one bounded repair turn. A valid result advances the
   workflow engine.
6. Events, folded workflow state, artifacts, decisions, and objections are
   persisted before downstream work is dispatched.

Runtime status is an observability hint. A turn completes only from the expected,
validated result artifact.

## Persistence and recovery

`runs/parrot.db` stores workflows, turns, events, signals, artifacts, objections,
decisions, usage, agent sessions, and outbox work. Recovery folds the event log
and reconstructs loop scratch from durable rows.

Resume is phase-driven. Completed turns are not replayed. An interrupted turn
may adopt a late result only if its persisted identity and semantic contents are
valid; otherwise the turn is re-dispatched through the normal bounded path.

## Agent and filesystem isolation

Role panes are created lazily in a dedicated Herdr tab. Stored session metadata
is scoped by workflow and role, which prevents one workflow from attaching to
another workflow's provider session.

Planner, reviewer, and frontier roles run in the target checkout. Implementation
and verifier roles run in the same workflow-specific git worktree. The worktree
name and branch contain a sanitized workflow ID plus a stable hash of the raw
ID. Existing worktrees are reused only after repository and branch ownership
checks.

The verifier receives git evidence from that worktree: path, branch, HEAD,
porcelain status, changed names, and diff statistics.

## Codebase context and trust boundaries

The orchestrator resolves task-mentioned files in first-mention order, with
defaults of 12 files, 8 KiB per file, and 48 KiB total. Repository contents,
objection prose, model output, and transcript text are untrusted. Prompts wrap
evidence in explicit delimiters, and the dashboard renders claims as escaped text
instead of markup.

## Dashboard boundary

`@platform/human-loop` exposes `createDashboardApi`, which serves versioned JSON
read models and accepts human decisions. `@platform/dashboard` is a Vite client
that proxies `/api` to the API's default `127.0.0.1:8787` bind.

The main `parrot` CLI does not currently start the dashboard API. Applications
embedding the library must create it with a store, engine, resolved
configuration, and workflow configuration resolver.

## Directory rationale

- `packages/` contains all current reusable runtime components.
- `docs/phases/` preserves the implementation contract and decisions for each
  delivered phase.
- `approved-plans/` preserves accepted planning artifacts for audit.
- `runs/` contains local runtime state and is git-ignored.
- `scripts/` contains operator utilities such as review-bundle generation.
- `src/` is the pre-package compatibility stack pending gated retirement.

See [Configuration](CONFIGURATION.md) for defaults and
[Testing](TESTING.md) for package-level verification.
