# Phase 7: Implementation Agents and MVP

**Status: planned**

Phase 7 closes the V2 MVP loop. After a human approves a plan, the approved
work is routed to isolated implementation agents, their structured results and
deviation requests are collected through the same turn protocol as review, and
the human retains approval and audit control. It also performs the composition
migration: the phase 1-2 era root `src/` orchestrator is retired in favor of a
workspace package that wires the `@platform/*` stack into one runnable MVP.

It depends on Phases 1 through 6. It introduces **no new platform event kinds**
and **no new role-result schemas**: `ImplementationResultSchema` and the
`ImplementationBlocked` event already exist in Phase 1, and the `implementation`
and `resolution_verification` turn types already exist in the Phase 5 registry.
V2 sections: 7 and 8.

Packages consume:

- `@platform/contracts` - `ImplementationResultSchema`, `ImplementationBlocked`,
  `HumanApproved`, `TurnCompleted` / `TurnFailed`.
- `@platform/workflow-engine` - `startTurn`, `markDelivered`, `applyValidation`,
  `handleSignal`, `submitUsage`, `humanDecision`, `getState`, `recover`.
- `@platform/llm-boundary` - `implementation` and `resolution_verification`
  turn types, Prompt Builder, Extraction and Validation, `UntrustedText`.
- `@platform/human-loop` - approval surface, dashboard projections,
  notification sinks, cost ledger ingest.
- `@platform/herdr-adapter` - agent spawn, turn delivery, result watch,
  deadlines, and reconciliation for implementation agents.
- `@platform/persistence` - `agent_session_path` identity map, `artifacts`,
  `turns`, `events`, and the tables the audit surface reads.

## 1. Goal and Non-Goals

**Goal.** Two deliverables that finish the MVP:

1. **Composition root** - one workspace package that owns the end-to-end run,
   wiring engine, LLM boundary, human loop, and runtime adapter. Replaces the
   parallel legacy stack in root `src/`.
2. **Implementation agents** - route an approved plan to isolated agents, drive
   the implementation turn, collect `ImplementationResult` (completed or
   blocked) and deviation requests, and hand control back to the human with
   full audit links.

**Non-goals.**

- No new event kinds or role-result schemas (both already exist in Phase 1).
- No new LLM-boundary machinery (reuses Phase 5 turn protocol end to end).
- No dashboard orchestration logic (audit surface reuses Phase 6 projections).
- No provider-specific implementation tuning beyond the config seam in section 7
  (assigned open question).

## 2. Composition Root Migration

source: repo shape decision; this phase owns the retirement of legacy `src/`

### 2.1 Direction

Root `src/` is a phase 1-2 era orchestrator with its own duplicate schemas
(`src/schemas.ts`), its own Herdr shim (`src/herdr.ts`), its own human gate
(`src/gate.ts`), and its own prompt assembly (`src/prompts.ts`). Six of its
seven files are reimplementations of what the `@platform/*` packages now own,
and `orchestrate.ts` imports only its own modules plus `@platform/contracts`.
It is a parallel stack, not a partial one.

The MVP composition lands in a new workspace package,
**`@platform/orchestrator`** under `packages/orchestrator`, built against the
real seams. Legacy `src/` is deleted once the new package reaches loop parity.
Keeping `src/` would preserve a second source of truth (the same reason
`src/toon.ts` was deleted earlier); a package also joins the uniform
`pnpm -r` build / typecheck / test graph instead of the root-only special case.

### 2.2 Migrate-then-delete sequencing

`src/` is currently the only runnable end-to-end MVP. It is not deleted first.

1. Build `packages/orchestrator` composition against `@platform/*` and reach
   loop parity (plan -> review -> merge -> gate -> frontier -> human -> approve).
2. Move the run entrypoint (`pnpm orchestrate`) to the orchestrator package.
3. Delete root `src/` and drop the root-only `tsc --noEmit` special case from
   the `typecheck` script once every source file lives in a workspace package.

### 2.3 Salvage before delete

Read, do not port: mine `src/orchestrate.ts` for the loop **order** and gate
placement, and `src/registry.ts` for `agent_session_path` wiring. The
sequencing knowledge is the value; the code is superseded.

### 2.4 Composition responsibilities

The orchestrator package is wiring only. It constructs the engine, the LLM
boundary, the human-loop sinks and dashboard API, and the Herdr adapter, then
drives the turn protocol. It writes **no** platform events directly (the engine
stays the sole writer) and holds **no** business rules that belong in a package.

## 3. Implementation Agents

source: V2 sections 7 and 8

### 3.1 Placement and trigger

The implementation workflow starts on `HumanApproved` for a plan (Phase 4
`approved` / Phase 6 approval surface). The approved plan and its provenance
(objection history, decisions, frontier report) are the implementation input.

### 3.2 Isolation

Each implementation agent runs in an isolated worktree so concurrent or retried
work cannot corrupt a shared tree. The platform stores a **reference** to the
worktree (path plus content identity), consistent with the Phase 6 transcript
policy: the platform owns references and hashes, not copies. Worktree lifecycle
and cleanup are an assigned open question (section 9).

### 3.3 Turn mechanics

Standard turn protocol via Phase 5, identical to review:

- Role prompt `implementation` / turn type `implementation` (already in the
  Phase 5 registry), driven through `startTurn` -> `markDelivered` -> result
  watch -> `applyValidation`.
- Result is `ImplementationResultSchema`:

  ```ts
  { role: "implementation", status: "completed" | "blocked", summary: string, deviationRequest?: string }
  ```

- `summary` and `deviationRequest` are untrusted data per Phase 5 marking rules.
- Validation plus single bounded repair as usual; deadlines and reconciliation
  come from the Phase 2 adapter (`TurnDeadlineManager`, `Reconciler`).

### 3.4 Blocked and deviation paths

- `status: "blocked"` maps to the existing `ImplementationBlocked` event and
  escalates to the human (never a silent stop), reusing the Phase 6
  `NotificationSink` / `frontier_failed`-style attention surface.
- A `deviationRequest` is a structured request to change the approved plan. It
  does not let the agent self-authorize: it routes back to the human decision
  surface (Phase 6 `humanDecision`) as a fresh approval, preserving the "human
  authorizes plan changes" invariant.

### 3.5 Cost and health parity

Implementation agents feed the Phase 6 cost ledger identically: session logs are
found via `agent_session_path`, parsed by the versioned provider adapters, and
submitted through `submitUsage`. Health metrics (wall clock, retries, repairs,
timeouts, startup) cover implementation turns with the same code path as review.

## 4. Verification

source: V2 section 8; Phase 5 `resolution_verification` turn type

Completed implementation results are verified through the existing
`resolution_verification` turn type before the human sees a ready state, so a
claimed completion is checked rather than trusted. Verification failure follows
the same bounded-repair-then-escalate path as any other turn. Verification is
structured (result files remain the canonical contract), never a prose read.

## 5. Human Approval and Audit

source: V2 section 8; Phase 6 dashboard

The human end reuses Phase 6 with no new surfaces:

- Approval, rejection, and approval-with-deviation post through
  `humanDecision`.
- The dashboard drill-down chain
  (`summary -> objection -> decision -> evidence -> transcript`) extends to
  implementation artifacts: the implementation turn's result and worktree
  reference are audit links resolved against the seeded DB, exactly like
  review transcripts.
- Notifications fire on `approval_requested` when an implementation result is
  ready for human sign-off and on `ImplementationBlocked`.

## 6. Configuration Surface

| Key | Type | Default | Consuming section |
|---|---|---|---|
| `implementationRolePromptPin` | `{ id, version }` | Phase 5 implementation pin | §3.3 |
| `implementationProviderModel` | `{ provider, model }` | Phase 5 stub | §3.3 |
| `worktreeRoot` | path | repo-local isolated root | §3.2 |
| `worktreeCleanupPolicy` | `"on_success" \| "on_approval" \| "manual"` | assigned question | §3.2, §9 |
| `implementationRepairBound` | positive int | Phase 5 repair bound | §3.3 |
| `deviationRequiresHuman` | boolean | `true` | §3.4 |
| `providerImplementationLimits` | map | assigned question | §9 |

## 7. Test Plan

- **Composition:** orchestrator drives a full loop against fixtures with no live
  model; `src/` deletion leaves the run entrypoint working; whole-repo
  `pnpm -r` build and typecheck stay green with no root-only special case.
- **Implementation:** approved plan spawns an isolated agent; completed result
  round-trips `ImplementationResultSchema`; blocked result emits
  `ImplementationBlocked` and escalates; deviation request routes to
  `humanDecision` and does not self-authorize; deadline and reconciliation
  fixtures exercise the Phase 2 adapter paths.
- **Verification:** completed implementation runs `resolution_verification`;
  verification failure triggers bounded repair then escalation.
- **Approval and audit:** approval posts the right events; dashboard drill-down
  resolves implementation artifact and worktree references against the seeded
  DB; notifications fire per kind.
- **Cost and health:** implementation session-log fixtures per provider ingest
  through `submitUsage`; duplicate message ID idempotent; health metrics cover
  implementation turns.
- All LLM calls faked via fixtures; no live-model dependence.

## 8. Assigned Open Questions

- **Worktree cleanup (V2):** when to reclaim an isolated worktree
  (`on_success`, `on_approval`, or `manual`). Conservative default keeps the
  worktree until human approval so a blocked or deviating run stays auditable.
- **Provider-specific implementation limits (V2):** per-provider constraints on
  implementation agents (context, tool access, concurrency) captured in
  `providerImplementationLimits`; pinned at deploy, not inferred at runtime.

## 9. Dependencies and Interfaces

**Depends on.**

- Phase 1: `ImplementationResultSchema`, `ImplementationBlocked`,
  `HumanApproved`, turn events.
- Phase 2: agent spawn, turn delivery, result watch, deadlines, reconciliation,
  `agent_session_path`.
- Phase 3: `artifacts`, `turns`, `events`, identity map, audit source tables.
- Phase 4: turn and human seams, engine as sole event writer, `approved` state.
- Phase 5: `implementation` and `resolution_verification` turns; `UntrustedText`.
- Phase 6: approval surface, dashboard audit links, notification sinks, cost
  ledger.

**Provides.**

- The complete V2 section 13 MVP loop: plan -> review -> gate -> human ->
  implement -> verify -> approve, run from a single composition root.

Completes the MVP. After this phase the platform runs end to end from a task to
an approved, verified implementation with full cost, health, and audit coverage.
