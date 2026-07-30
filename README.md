# Parrot

Parrot is a TypeScript multi-agent orchestration runtime built on
[Herdr](https://herdr.dev/). It coordinates a durable
plan → review → frontier → human approval → implementation → verification
workflow while keeping state and evidence outside the model sessions.

The current packaged runtime lives in `packages/orchestrator`. It supports:

- schema-validated TOON results with one bounded repair attempt;
- a SQLite event log, replay, and interrupted-workflow resume;
- planner, reviewer, frontier, implementation, and verifier roles;
- objection stalemate and guardrail-conflict escalation;
- frontier re-review after a materially restructured proposal;
- bounded, injection-delimited codebase context;
- workflow-scoped provider sessions with supported session reattachment;
- a shared isolated git worktree for implementation and verification; and
- concise per-turn progress in the operator terminal.

Plan-churn detection is deliberately deferred: its compatibility configuration
is accepted but ignored until a real-corpus heuristic is reliable. See
[Phase 12](docs/phases/phase-12-plan-churn-and-frontier-reinvoke.md).

## Requirements

- Node.js `22.13.0` through 22.x, or `23.4.0` and newer. The Nix development
  shell currently provides Node.js 24.
- pnpm `10.13.1`, as pinned by `packageManager` in `package.json`.
- git.
- Herdr with protocol 16 and working provider integrations.
- At least the `claude` and `codex` CLIs for the default role mapping.

If you use Nix:

```bash
nix develop
```

Otherwise, enable the pnpm version pinned by the repository:

```bash
corepack enable
corepack use pnpm@10.13.1
```

## Install

```bash
pnpm install
pnpm build
```

## Run from this repository

Start Herdr in one terminal:

```bash
herdr
```

Then run Parrot from the target git repository. During development, this
repository itself is the target:

```bash
pnpm parrot task.md
```

A task can be one or more existing file paths, inline text arguments, or a mix
of both. Existing files are read relative to the directory where the command
was invoked.

```bash
pnpm parrot task.md "Also verify resume safety."
```

The CLI requires an interactive terminal for the escalation and final
approve/reject prompts.

## Install the global command

The global wrapper executes the compiled orchestrator, so build before linking:

```bash
pnpm --filter @platform/orchestrator build
pnpm --filter @platform/orchestrator link --global
parrot --help
```

You can then invoke Parrot from any target git repository:

```bash
cd /path/to/target/repository
parrot task.md
```

To use a target directory without changing directories:

```bash
PARROT_PROJECT_DIR=/path/to/target/repository parrot /path/to/task.md
```

## Resume a workflow

Resume the newest non-terminal workflow:

```bash
parrot --resume
```

Resume a specific workflow:

```bash
parrot --resume wf-123
```

The equivalent environment variable forms are:

```bash
PARROT_RESUME=1 parrot
PARROT_RESUME=wf-123 parrot
```

Resume folds the stored event log, restores persisted objections and proposal
state, adopts a completed late result only after identity and semantic
validation, and reattaches provider sessions when their installed CLI exposes a
documented session-id option.

## Runtime files

By default, Parrot writes target-project state under `runs/`:

```text
runs/
├── parrot.db
└── <workflow-id>/
    └── <iteration-id>/
        └── <turn-id>/
            ├── prompt.md
            ├── result.toon
            └── proposal.md       # planner turns
```

`runs/` is ignored by git. The SQLite database is the durable source of truth;
prompt, result, proposal, transcript, and session-log paths are persisted as
audit evidence.

Create a review bundle from the newest workflow:

```bash
node scripts/bundle-review.mjs
```

Select a project/runs/database path and workflow explicitly:

```bash
node scripts/bundle-review.mjs /path/to/project wf-123
```

## Implementation worktrees

The implementation and verifier roles use the same workflow-specific git
worktree. The verifier receives the worktree path, branch, commit, status, and
diff summary, so it checks the files the implementation agent actually changed.

The default location is outside the target checkout:

```text
../.parrot-worktrees/<repo>/<sanitized-workflow-id>-<stable-hash>/
```

The branch is:

```text
parrot/<sanitized-workflow-id>-<stable-hash>
```

The stable hash prevents workflow IDs such as `wf/a` and `wf_a` from colliding.
Before reuse, Parrot verifies that the directory belongs to the expected
repository and is on the expected branch. Worktrees are not removed
automatically.

## Configuration

The CLI reads configuration from environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `PARROT_PROJECT_DIR` | Target git repository and base for relative paths | invocation directory (`INIT_CWD`, then `cwd`) |
| `PARROT_RUNS_ROOT` | Workflow artifact directory, relative to the target unless absolute | `runs` |
| `PARROT_DB` | SQLite database path | `<runs-root>/parrot.db` |
| `PARROT_WORKFLOW` | Workflow ID for a fresh run | `wf-<timestamp>` |
| `PARROT_RESUME` | Resume newest workflow (`1`, `true`, `auto`, `yes`, `on`) or the named ID | unset |
| `PARROT_WORKSPACE` | Herdr workspace ID | focused workspace |
| `PARROT_TAB` | Reuse an existing Herdr tab | create `parrot agents` tab |
| `PARROT_WORKTREE_ROOT` | Worktree parent, relative to target unless absolute | sibling `.parrot-worktrees/<repo>` |
| `PARROT_PLANNER_PROVIDER` | Planner provider | `claude` |
| `PARROT_REVIEWER_PROVIDER` | Reviewer provider | `codex` |
| `PARROT_FRONTIER_PROVIDER` | Frontier provider | `claude` |
| `PARROT_IMPL_PROVIDER` | Implementation provider | `claude` |
| `PARROT_VERIFIER_PROVIDER` | Verifier provider | `codex` |
| `PARROT_CONTEXT_DISABLE` | Set to `1` to omit codebase context | unset |
| `PARROT_CONTEXT_MAX_FILES` | Maximum injected files | resolver default (`12`) |
| `PARROT_CONTEXT_MAX_BYTES` | Maximum total injected bytes | resolver default (`49152`) |
| `PARROT_TURN_IDLE_TIMEOUT_MS` | Idle timeout, reset by agent activity | runner default |
| `PARROT_TURN_MAX_MS` | Absolute turn deadline | runner default |
| `PARROT_TURN_TIMEOUT_MS` | Deprecated absolute-deadline alias | unset |
| `HERDR_BIN` | Herdr executable | `herdr` |
| `HERDR_SOCKET` | Explicit daemon socket path | discovered socket, then default socket |

Invalid context-limit values are ignored. `PARROT_TURN_MAX_MS` takes precedence
over the deprecated `PARROT_TURN_TIMEOUT_MS`.

The library packages expose additional typed configuration objects. See
[Configuration](docs/CONFIGURATION.md).

## Development commands

Run these from the repository root:

```bash
pnpm build
pnpm typecheck
pnpm test
```

Useful focused commands:

```bash
pnpm --filter @platform/orchestrator test
pnpm --filter @platform/workflow-engine test
pnpm --filter @platform/dashboard dev
pnpm --filter @platform/dashboard build
```

The dashboard development server listens on `127.0.0.1:5173` and proxies
`/api` to `127.0.0.1:8787`. The HTTP API is a library surface
(`createDashboardApi`); the main CLI does not start it automatically.

See [Getting Started](docs/GETTING-STARTED.md),
[Development](docs/DEVELOPMENT.md), and [Testing](docs/TESTING.md) for the
complete workflows.

## Repository map

```text
packages/
├── contracts/          shared IDs, events, signals, TOON, and role schemas
├── herdr-adapter/      protocol-16 runtime adapter and reliable turn delivery
├── persistence/        SQLite store, schema, event fold, outbox, and recovery
├── workflow-engine/    deterministic planning state machine and guards
├── llm-boundary/       prompt construction, extraction, validation, objections
├── human-loop/         frontier conversion, notifications, dashboard, cost
├── orchestrator/       CLI composition, review loop, resume, worktrees
└── dashboard/          React/Vite dashboard client
```

The root `src/` directory is the pre-package compatibility implementation. It is
still runnable with `pnpm orchestrate:legacy`, but new work belongs in the
workspace packages. Its retirement remains a separate gated task in `task.md`.

## Documentation

- [Documentation index](docs/README.md)
- [Current architecture](docs/ARCHITECTURE.md)
- [Phase implementation map](docs/phases/README.md)
- [Architecture v0.2](Multi-Agent-Orchestration-Architecture-v0.2.md), the
  historical design baseline
- `approved-plans/`, immutable planning evidence retained for audit

Parrot is currently a private `0.1.0` workspace and does not publish packages to
a registry.
