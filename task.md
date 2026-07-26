# Task: Retire the legacy root `src/` orchestrator (phase 7 §2 migrate-then-delete)

## Context

Parrot V2 is implemented across phases 1 through 7. The end-to-end MVP now lives
in the workspace package **`@platform/orchestrator`** (`packages/orchestrator`),
which wires the `@platform/*` stack (contracts, persistence, workflow-engine,
llm-boundary, human-loop, herdr-adapter) into one runnable review-and-implement
loop.

Root `src/` is the phase 1-2 era orchestrator: a parallel stack with its own
duplicate schemas, Herdr shim, human gate, prompt assembly, and result watcher.
Per `docs/phases/phase-7-implementation-agents-and-mvp.md` §2, it is retired once
the new package reaches loop parity. This task performs that retirement.

## Precondition (approval gate)

Do **not** treat this task as ready to merge until loop parity is confirmed:
`pnpm orchestrate:next <task>` drives the full loop (plan -> review -> merge ->
gate -> frontier -> human -> approve) against a live Herdr daemon. Parity is the
human's assertion at the approval step. If parity is not yet confirmed, stop and
escalate rather than deleting `src/`.

## Goal

Make `@platform/orchestrator` the single composition root and remove the legacy
parallel stack, so every source file lives in a workspace package under the
uniform `pnpm -r` build / typecheck / test graph.

## Scope

1. **Salvage check (read-only, do not port code).** Confirm the loop *order* and
   gate placement in `src/orchestrate.ts`, and the `agent_session_path` wiring in
   `src/registry.ts`, are already represented in the package
   (`packages/orchestrator/src/loop.ts`, `composition.ts`, and the
   herdr-adapter identity map). If any behavior in `src/` is **not** represented
   in the package, raise a deviation request (see Guardrails) instead of
   deleting.

2. **Move the run entrypoint to the package.** In root `package.json`:
   - Point `orchestrate` at the package:
     `"orchestrate": "pnpm --filter @platform/orchestrator orchestrate"`.
   - Remove the now-redundant `orchestrate:next` script.

3. **Delete the legacy stack.** Remove the entire root `src/` directory
   (`gate.ts`, `herdr.ts`, `orchestrate.ts`, `prompts.ts`, `registry.ts`,
   `schemas.ts`, `waitResult.ts`) and the root `tsconfig.json` (its only role is
   `"include": ["src/**/*.ts"]`).

4. **Drop the root-only typecheck special case.** In root `package.json`, change
   `typecheck` from
   `"pnpm run build && pnpm -r run typecheck && tsc --noEmit"` to
   `"pnpm run build && pnpm -r run typecheck"` (no root file remains to compile).

5. **Prune root dependencies that only `src/` used.** After removal, remove root
   `dependencies` (`@platform/contracts`, `zod`) and any root `devDependencies`
   used solely by the deleted entrypoint (`tsx`). Keep only what the workspace
   root still needs. Verify by a clean install plus full build.

6. **Update documentation to the package entrypoint and implemented status.**
   - `docs/phases/README.md`: flip the phase 7 row status from `skeleton` to
     `implemented`.
   - `docs/phases/phase-7-implementation-agents-and-mvp.md`: change
     `**Status: planned**` to `**Status: implemented**`.
   - `README.md`: replace every `pnpm exec tsx src/orchestrate.ts ...` and
     `tsx src/orchestrate.ts` usage example with the `pnpm orchestrate ...`
     package entrypoint; update the "What Is Implemented" / "What Is Not
     Implemented Yet" sections so phase 7 (implementation agents + composition
     root) is listed as implemented; and update the `src/` file-tree section to
     describe `packages/orchestrator` instead of the deleted `src/`.

## Acceptance criteria

- `src/` and root `tsconfig.json` no longer exist; no file under `packages/`
  or the repo root imports from `../src` / `./src`.
- `pnpm install` is clean; `pnpm build`, `pnpm typecheck`, and `pnpm test` all
  pass with the legacy stack gone.
- `pnpm orchestrate <task>` resolves to and runs the `@platform/orchestrator`
  package (socket auto-discovered, workspace auto-resolved).
- No dangling references to `src/orchestrate.ts` or `orchestrate:next` remain in
  scripts or docs.
- Phase 7 is marked `implemented` in both `docs/phases/README.md` and the
  phase-7 document.

## Guardrails

- **No new event kinds or role-result schemas** (phase 7 is a non-goal for both).
  The engine remains the sole writer of platform events.
- **Do not port `src/` code into the package.** The package is the source of
  truth; `src/` is read for sequencing knowledge only, then deleted.
- If the salvage check finds behavior present in `src/` but missing from the
  package, do **not** delete `src/`. Emit a `deviationRequest` describing the gap
  so the human can decide whether to widen the package first. Deleting a proven
  behavior that has no replacement is a blocking defect, not a cleanup.

## Out of scope

- Worktree lifecycle/cleanup for implementation agents (assigned open question).
- Any provider-specific tuning or new CLI bootstrap (session/workspace creation).
- Changes to package internals beyond what the entrypoint move requires.
