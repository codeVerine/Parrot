<!-- generated-by: gsd-doc-writer -->
# Getting Started

## Prerequisites

- Node.js `22.13.0` through 22.x, or `23.4.0` and newer.
- pnpm `10.13.1`.
- git.
- A running Herdr protocol-16 daemon.
- Working provider CLIs. The defaults use Claude for planner/frontier/
  implementation and Codex for reviewer/verifier.

The repository's Nix shell provides Node.js 24 and pnpm:

```bash
nix develop
```

Without Nix, activate the pinned package manager with Corepack:

```bash
corepack enable
corepack use pnpm@10.13.1
```

## Install

```bash
pnpm install
pnpm build
```

## First run

Parrot operates on a git repository because implementation runs are isolated in
a git worktree.

Start Herdr:

```bash
herdr
```

From this repository, pass a task as text or point to your own task file:

```bash
pnpm parrot "Describe the change you want to plan and implement."
```

For another project, either install the global command:

```bash
pnpm --filter @platform/orchestrator build
pnpm --filter @platform/orchestrator link --global
cd /path/to/project
parrot task.md
```

or keep invoking the development CLI while pointing it at the project:

```bash
PARROT_PROJECT_DIR=/path/to/project pnpm parrot /path/to/task.md
```

Parrot prints one short line after each role completes. At escalation points it
asks how to resolve the conflict; at the final gate it asks for approval or
rejection. Approval starts implementation and then verification in the isolated
workflow worktree.

## Task input

Each positional argument is checked relative to the invocation directory:

- if it names an existing file, Parrot reads that file;
- otherwise, Parrot treats it as inline task text.

Multiple inputs are joined with a blank line:

```bash
pnpm parrot requirements.md constraints.md "Keep the public API additive."
```

## Resume

Resume the newest non-terminal workflow:

```bash
pnpm parrot --resume
```

Resume a specific workflow:

```bash
pnpm parrot --resume wf-123
```

Do not supply a replacement task when resuming; the durable workflow row remains
authoritative.

## Common issues

### Herdr daemon not found

Start `herdr`, or select a non-default socket:

```bash
HERDR_SOCKET=/path/to/herdr.sock pnpm parrot "Describe the change."
```

Use `herdr status server` to find the active socket.

### No focused Herdr workspace

Focus the desired workspace in Herdr or set its ID:

```bash
PARROT_WORKSPACE=<workspace-id> pnpm parrot "Describe the change."
```

### Global command imports missing build output

The bin wrapper loads `packages/orchestrator/dist/src/cli.js`. Rebuild after
source changes:

```bash
pnpm --filter @platform/orchestrator build
```

### Worktree path already exists

Parrot refuses to reuse a directory that is not the expected worktree, or a
worktree that belongs to another repository/branch. Remove or relocate that
specific stale directory, or choose another root:

```bash
PARROT_WORKTREE_ROOT=/absolute/clean/path parrot /path/to/task.md
```

### Package-manager signature verification fails

This is a Corepack/package-manager bootstrap failure, not a test failure.
Confirm that Corepack can obtain and verify the repository's pinned
`pnpm@10.13.1`, then rerun the command. Do not report the project suite as
failed when pnpm never started it.

## Next steps

- Read [Configuration](CONFIGURATION.md) before changing providers, paths, or
  deadlines.
- Read [Architecture](ARCHITECTURE.md) before changing package boundaries.
- Use [Testing](TESTING.md) for full and focused validation.
