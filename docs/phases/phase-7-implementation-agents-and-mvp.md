# Phase 7: Implementation Agents and MVP

**Status: implemented**

Phase 7 closes the V2 MVP loop. After a human approves a plan, the approved
work is routed to isolated implementation agents, their structured results and
deviation requests are collected through the same turn protocol as review, and
the human retains approval and audit control. The workspace composition root is
shipped, and the phase 1-2 era root implementation has been retired: every
source file now lives in a workspace package.

It depends on Phases 1 through 6. The implementation flow uses the Phase 1
`ImplementationResultSchema` and `ImplementationBlocked` event, Phase 5
`implementation` and `resolution_verification` turn types, and Phase 7's
approved `VerificationCompleted` event. The legacy-retirement work added no
event kind or role-result schema. The engine remains the sole platform-event
writer. V2 sections: 7 and 8.

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
   wiring engine, LLM boundary, human loop, and runtime adapter. It is the sole
   implementation; the parallel root stack has been retired.
2. **Implementation agents** - route an approved plan to isolated agents, drive
   the implementation turn, collect `ImplementationResult` (completed or
   blocked) and deviation requests, and preserve the result and verification
   evidence in the durable run record.

**Non-goals.**

- No event-catalog change beyond Phase 7's approved additive
  `VerificationCompleted` event, and no new role-result schema.
- No new LLM-boundary machinery (reuses Phase 5 turn protocol end to end).
- No dashboard orchestration logic (audit surface reuses Phase 6 projections).
- No provider-specific implementation tuning beyond the config seam in section 7
  (assigned open question).

## 2. Composition Root Migration

source: repo shape decision; package migration shipped, legacy root retired

### 2.1 Direction

The former root stack was a phase 1-2 era orchestrator with its own duplicate
schemas, Herdr shim, human gate, and prompt assembly. Six of its seven files
reimplemented what the `@platform/*` packages now own. It was a parallel
compatibility stack, not a partial package, and has been deleted.

The MVP composition lives in **`@platform/orchestrator`** under
`packages/orchestrator`, built against the real seams. The root `orchestrate`
and `parrot` scripts select that package, which is now the single composition
root.

### 2.2 Migrate-then-delete sequencing

The package is the runnable end-to-end MVP. Retirement sequencing was:

1. Build `packages/orchestrator` against `@platform/*` and cover the packaged
   loop with deterministic tests. **Done.**
2. Move `pnpm orchestrate` to the package and add the `parrot` development and
   compiled bin entrypoints. **Done.**
3. Confirm live Herdr loop parity, then delete root `src/`, remove
   the legacy command, and drop the root-only typecheck/dependencies. **Done**
   (parity asserted at the `wf-phase7-final-20260730` final human gate; that
   approval authorized the deletion).

### 2.3 Salvage before delete

Before deletion the salvage step read the old loop for its **order** and gate
placement and the old registry for `agent_session_path` wiring, and confirmed
each is already represented in the package (`runReviewLoop` in
`packages/orchestrator/src/loop.ts`; the `agent_session_path` fold in the
herdr-adapter `IdentityMap`). No code was ported.

### 2.4 Composition responsibilities

The orchestrator package is wiring only. It constructs the engine, the LLM
boundary, human-loop notification sinks, and the Herdr adapter, then drives the
turn protocol. The dashboard API remains an embeddable `@platform/human-loop`
library surface. The orchestrator writes **no** platform events directly (the
engine stays the sole writer) and holds **no** business rules that belong in a
package.

## 3. Implementation Agents

source: V2 sections 7 and 8

### 3.1 Placement and trigger

The implementation workflow starts on `HumanApproved` for a plan (Phase 4
`approved` / Phase 6 approval surface). The task and final approved proposal
path are the implementation input; objection, decision, and frontier provenance
remain available in the durable workflow record.

### 3.2 Isolation

Implementation and verification run in the same workflow-specific isolated git
worktree so the verifier checks the files the implementation role changed. Its
directory and branch include a stable hash of the raw workflow ID, preventing
collisions after sanitization. Reuse validates repository and branch ownership.
Worktree cleanup remains manual and is an assigned open question (section 8).

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
  does not let the agent self-authorize: it emits the same
  `ImplementationBlocked` escalation, notifies the human, and is printed by the
  CLI for an explicit follow-up decision.

### 3.5 Cost and health parity

Implementation panes persist `agent_session_path` through the same identity map
as review panes. Phase 6's provider adapters, `submitUsage` seam, and health
projection therefore accept implementation turns without a separate Phase 7
schema or ledger. Automatic session-log ingestion remains an embedding concern;
the packaged CLI does not start a ledger poller.

## 4. Verification

source: V2 section 8; Phase 5 `resolution_verification` turn type

Completed implementation results are verified through the existing
`resolution_verification` turn type, so a claimed completion is checked rather
than trusted. Verification failure follows the same bounded-repair path as any
other turn and leaves the post-review stage incomplete for operator follow-up.
Verification is structured (result files remain the canonical contract), never
a prose read. The verifier runs in the implementation worktree and receives its
git branch, HEAD, porcelain status, changed-file list, and diff statistics as
evidence.

## 5. Human Approval and Audit

source: V2 section 8; Phase 6 dashboard

The human end reuses Phase 6 with no new event kinds or decision schema:

- Plan approval and rejection post through `humanDecision` before
  implementation starts.
- Blocked or deviating implementations emit `ImplementationBlocked`, notify the
  human, and cannot authorize their own scope change.
- Implementation and verification remain in the same durable turn, artifact,
  and event records as review work. The verifier prompt records the worktree
  path and git evidence used for its decision.

## 6. Configuration Surface

| Key | Type | Default | Consuming section |
|---|---|---|---|
| `DEFAULT_LLM_BOUNDARY_CONFIG.rolePromptPins.implementation` | `{ id, version }` | `implementation@1.0.0` | §3.3 |
| `PARROT_IMPL_PROVIDER` | provider id | `claude` | §3.3 |
| `PARROT_VERIFIER_PROVIDER` | provider id | `codex` | §4 |
| `PARROT_WORKTREE_ROOT` | path | sibling `.parrot-worktrees/<repo>` | §3.2 |
| repair bound | fixed policy | one repair | §3.3 |
| deviation authorization | fixed policy | human required | §3.4 |

## 7. Test Plan

- **Composition:** orchestrator drives a full loop against fixtures with no live
  model; root and global entrypoints resolve to the package.
- **Implementation:** approved plan spawns an isolated agent; completed result
  round-trips `ImplementationResultSchema`; blocked result emits
  `ImplementationBlocked` and escalates; deviation request routes to
  `ImplementationBlocked` and does not self-authorize; deadline and
  reconciliation fixtures exercise the Phase 2 adapter paths.
- **Verification:** completed implementation runs `resolution_verification`;
  validation failure gets one bounded repair, and an unresolved result leaves
  the post-review stage incomplete. Worktree regression tests pin identity and
  ownership; the recorded live parity run confirms that implementation and
  verification share the worktree and that the verifier receives git evidence.
- **Approval and audit:** approval posts the right events; blocked and deviating
  implementations notify through the existing escalation sink.
- **Cost and health:** the shared provider/session identity and Phase 6 ledger
  seams accept implementation turns without a Phase 7-specific contract.
- All LLM calls faked via fixtures; no live-model dependence.

## 8. Assigned Open Questions

- **Worktree cleanup (V2):** when to reclaim an isolated worktree
  (`on_success`, `on_approval`, or `manual`). Conservative default keeps the
  worktree indefinitely until an operator removes it, so a blocked or deviating
  run stays auditable.
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

- The complete packaged MVP loop: plan -> review -> gate -> human -> implement
  -> verify, run from one workspace composition root.

Completes the MVP. After this phase the platform runs end to end from a task to
an approved, verified implementation. Automatic worktree cleanup remains an
operational follow-up, not missing package behavior.
