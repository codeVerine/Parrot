<!-- generated-by: gsd-doc-writer -->
# Development

## Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Node.js must include the stable `node:sqlite` API; use Node.js `22.13.0`
through 22.x, or `23.4.0` and newer. The repository pins pnpm `10.13.1`.

## Monorepo workflow

The root workspace includes every directory under `packages/*`. Internal
packages use `workspace:*` dependencies and compile to `dist/` with TypeScript
`NodeNext` modules.

Run a script everywhere it exists:

```bash
pnpm -r run build
pnpm -r run typecheck
```

Run one package:

```bash
pnpm --filter @platform/orchestrator build
pnpm --filter @platform/orchestrator test
```

The root scripts are the authoritative full-repository commands:

| Command | Purpose |
|---|---|
| `pnpm build` | Build every workspace package |
| `pnpm typecheck` | Build dependencies and typecheck every package |
| `pnpm test` | Run every package test script |
| `pnpm parrot <task>` | Run the packaged CLI from source with `tsx` |
| `pnpm orchestrate <task>` | Run the orchestrator package entrypoint from source |

All runtime behavior belongs in the packages, especially
`packages/orchestrator`.

## Source conventions

- Use straightforward TypeScript that matches neighboring modules.
- Keep package contracts additive unless a phase explicitly authorizes a
  migration.
- Route cross-package data through exported types and schemas.
- Treat repository text, model output, and provider transcripts as untrusted.
- Persist state before dispatching work that depends on it.
- Use atomic result writes (`result.tmp` followed by rename to `result.toon`).
- Preserve objection IDs and turn identity across prompts, results, and resume.
- Keep deterministic policy in the workflow engine rather than an LLM prompt.

There is no separate lint or formatter command in the current repository.
TypeScript strict mode, tests, and `git diff --check` are the enforced local
quality gates.

## Adding or changing a package

1. Keep the package private and ESM unless publication is intentionally added.
2. Add `build`, `typecheck`, and `test` scripts when the package has TypeScript
   runtime code and tests.
3. Export compiled JavaScript and declarations from `dist/src`.
4. Add internal dependencies with `workspace:*`.
5. Update [Architecture](ARCHITECTURE.md), [Testing](TESTING.md), and the
   package README when its public responsibility changes.

## Dashboard development

Start the Vite client:

```bash
pnpm --filter @platform/dashboard dev
```

It listens on port `5173` and proxies `/api` to port `8787`. The API is not a
standalone package script; an embedding process must instantiate
`createDashboardApi` from `@platform/human-loop`.

Build the static client:

```bash
pnpm --filter @platform/dashboard build
pnpm --filter @platform/dashboard preview
```

## Review utilities

Flatten the newest workflow's persisted task, turns, artifacts, objections, and
decisions into one Markdown file:

```bash
node scripts/bundle-review.mjs
```

The output is `review-bundle.md` beside the selected `parrot.db`.

## Git workflow

- Start from the intended branch and inspect the existing dirty worktree.
- Keep unrelated user changes untouched.
- Stage explicit reviewed paths.
- Inspect `git diff --cached --stat`, `git diff --cached --check`, and the
  cached diff before committing.
- Derive the commit subject and body from the staged snapshot, not from an
  earlier working-tree assumption.

No repository-owned CI workflow is currently checked in, so local validation is
the only automated gate documented here.
