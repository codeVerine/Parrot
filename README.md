# Parrot

Parrot is a bare-bones plan/review orchestrator for two manually started
AI agents in Herdr:

- `planner`: Claude Code
- `reviewer`: Codex

The MVP replaces manual copy/paste between the two panes. It sends each
agent a short instruction pointing to a prompt file, waits for a
turn-scoped `result.json`, tracks objections, and pauses for a human
decision after every review round.

The full architecture is described in
`Multi-Agent-Orchestration-Architecture-v0.2.md`. This implementation is
only the file-backed MVP from the local plan.

## What Is Implemented

- TypeScript CLI launched with `tsx`.
- Herdr CLI integration through `child_process`.
- Strict pane resolution for exactly one `planner` and one `reviewer`.
- Prompt files for planner and reviewer turns.
- Turn identity with `{ runId, iteration, role, turnId }`.
- Result validation with Zod.
- Freshness checks so stale `result.json` files are rejected.
- One repair prompt after invalid JSON.
- Append-only objection registry in `runs/<runId>/state.json`.
- Atomic state writes using `state.tmp` then rename.
- Human gate after every round, including consensus rounds.
- Herdr notification when a round completes.

## What Is Not Implemented Yet

- SQLite persistence.
- Durable event log.
- XState workflow engine.
- Dashboard.
- Frontier review.
- Worktree orchestration.
- Cost ledger.
- Herdr socket API client.
- Provider session log parsing.
- Automatic agent startup.

## Requirements

- Node.js installed.
- Herdr installed and running.
- Claude Code and Codex available in Herdr panes.
- Project dependencies installed with `pnpm install`.

The local implementation was validated against Herdr `0.7.3` protocol
`16`.

## Install

From the repo root:

```bash
pnpm install
```

Validate TypeScript:

```bash
pnpm typecheck
```

## Prepare Herdr Panes

Start Herdr and open two panes manually:

1. In one pane, start Claude Code.
2. In another pane, start Codex.
3. Rename exactly one pane to `planner`.
4. Rename exactly one pane to `reviewer`.

Use:

```bash
herdr agent rename <target> planner
herdr agent rename <target> reviewer
```

`<target>` can be a terminal ID, unique agent name, detected/reported
agent label, or pane ID accepted by Herdr.

To inspect current agents:

```bash
herdr agent list
```

The orchestrator intentionally fails if either role resolves to zero or
multiple agents. The error prints current candidates and the rename
command to use.

## Create A Task File

Create a markdown file describing the task for the planner.

Example:

```bash
cat > task.md <<'EOF'
Design the SQLite persistence layer for Parrot based on section 6.9 of
Multi-Agent-Orchestration-Architecture-v0.2.md.
EOF
```

## Run

```bash
pnpm exec tsx src/orchestrate.ts task.md
```

Or through the package script:

```bash
pnpm orchestrate task.md
```

The orchestrator will:

1. Check `herdr status`.
2. Resolve `planner` and `reviewer` panes.
3. Create a new run directory under `runs/`.
4. Write the planner prompt.
5. Send a one-line instruction to the planner pane.
6. Wait for the planner `result.json`.
7. Write the reviewer prompt.
8. Send a one-line instruction to the reviewer pane.
9. Wait for the reviewer `result.json`.
10. Update the objection registry.
11. Print a round summary.
12. Ask the human what to do next.

## Human Gate

After every round, Parrot stops for a terminal decision.

If open blocking objections remain:

```text
Open blockers remain. [c]ontinue / [a]pprove anyway / [q]uit:
```

If no blocking objections remain:

```text
Consensus reached. [a]pprove / [c]ontinue another round / [q]uit:
```

If an agent times out:

```text
Agent timed out. [r]etry / [q]uit:
```

Consensus never auto-exits. Human approval is still required.

## Runtime Artifacts

Runs are created under:

```text
runs/<runId>/
```

Each iteration writes:

```text
runs/<runId>/iter-<n>/planner/
  prompt.md
  plan.md
  result.json
  repair-prompt.md    # only if repair was needed

runs/<runId>/iter-<n>/reviewer/
  prompt.md
  result.json
  repair-prompt.md    # only if repair was needed

runs/<runId>/state.json
```

`runs/` is gitignored.

## Result Contract

Every result must include this envelope:

```json
{
  "runId": "20260717-1432-x7k2",
  "iteration": 1,
  "role": "planner",
  "turnId": "abc123",
  "payload": {}
}
```

The envelope is checked before the payload. A result is rejected if:

- `runId` does not match the active run.
- `iteration` does not match the active iteration.
- `role` is not the expected role.
- `turnId` does not match the active turn.
- The file is older than the send time.
- The JSON does not match the role schema.

Agents are instructed to write `result.tmp` first, then rename it to
`result.json`.

## Planner Payload

Planner results must match:

```ts
{
  planPath: string;
  summary: string;
  addressedObjections: Array<{
    id: string;
    response: string;
    evidence: string[];
  }>;
}
```

The full plan should be written to `plan.md`. Every open objection sent
to the planner must appear in `addressedObjections` before the reviewer
turn runs.

## Reviewer Payload

Reviewer results must match:

```ts
{
  priorObjectionStatuses: Array<{
    id: string;
    status: "open" | "resolved";
    rationale: string;
  }>;
  newObjections: Array<{
    severity: "blocking" | "major" | "minor";
    claim: string;
    evidence: string[];
  }>;
}
```

The reviewer cannot delete, rename, or downgrade prior objections. The
orchestrator maintains the registry and derives current status.

## Objection Registry

`state.json` stores:

- immutable objection records
- status transition records
- resolved Herdr pane IDs
- current iteration

Objection records are never edited in place. Status is derived from the
last transition for each objection.

## Configuration

Environment variables:

```bash
PARROT_MAX_ITERATIONS=5
PARROT_TURN_TIMEOUT_MS=900000
```

Defaults:

- `PARROT_MAX_ITERATIONS`: `5`
- `PARROT_TURN_TIMEOUT_MS`: `900000` milliseconds, or 15 minutes

Example:

```bash
PARROT_MAX_ITERATIONS=3 PARROT_TURN_TIMEOUT_MS=300000 pnpm exec tsx src/orchestrate.ts task.md
```

## Validation Commands

Typecheck:

```bash
pnpm typecheck
```

CLI usage check:

```bash
pnpm exec tsx src/orchestrate.ts
```

Expected output:

```text
Usage: pnpm exec tsx src/orchestrate.ts <task.md>
```

Preflight check:

```bash
pnpm exec tsx src/orchestrate.ts task.md
```

If panes are not renamed correctly, it should fail before sending any
agent instruction and print current Herdr candidates.

## Troubleshooting

### `Expected exactly one Herdr agent named "planner"`

No pane, or more than one pane, resolves to `planner`.

Run:

```bash
herdr agent list
```

Then rename exactly one intended pane:

```bash
herdr agent rename <target> planner
```

Do the same for `reviewer`.

### The Agent Does Not Submit The Prompt

Parrot sends text with:

```text
herdr agent send <pane> <text>
herdr pane send-keys <pane> enter
```

This is required because `herdr agent send` writes literal text without
submitting it to the TUI.

### Invalid `result.json`

Parrot sends one repair prompt with a new `turnId`. If the second result
is invalid, the turn fails and the CLI exits or asks for retry depending
on where the failure occurred.

### Stale Result Rejected

This is expected. Before each turn, Parrot removes any existing
`result.json` and records the send time. A result must be newer than that
send time and must carry the active `turnId`.

## Source Layout

```text
src/
  gate.ts          terminal human gate
  herdr.ts         Herdr CLI wrapper and pane resolution
  orchestrate.ts   main loop
  prompts.ts       planner, reviewer, and repair prompt builders
  registry.ts      append-only objection registry and state writes
  schemas.ts       Zod schemas and TypeScript types
  waitResult.ts    result watching, freshness, and identity checks
```

## Current Development Notes

- The repo has been initialized with git, but no commit has been made.
- `node_modules/`, `runs/`, and `dist/` are ignored.
- The implementation is intentionally small and file-backed so it can be
  dogfooded before adding the full durable architecture.
