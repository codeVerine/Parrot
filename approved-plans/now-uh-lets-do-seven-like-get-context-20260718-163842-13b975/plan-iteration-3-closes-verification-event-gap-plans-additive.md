# Plan (iteration 3): Expand Phase 7 (Implementation Agents and MVP End-to-End) into a Full Technical Document

## 0. Changes from Iteration 2

- **OBJ-002 (major)**: the implementation verification step claimed its results are "recorded as events" while section 3 simultaneously declared Phase 7 adds no new events - and the approved Phase 1 enumeration has no verification event, so the verification gate would have violated the Phase 4 rule that every guard input is traceable to a platform event payload. Resolved by closing the loop the same way the Phase 4 plan closed its budget gap (`UsageRecorded`) and the Phase 5 plan closed its merge gap (merge-result schema): this plan's additive Phase 1 revision now has two parts - the implementation-agent result schemas (unchanged from iteration 2) **and a `VerificationCompleted` platform event** added to the Phase 1 enumeration under the versioning policy's additive rule. The platform runs the deterministic verification commands; the engine - sole writer of `events` per the Phase 3 rule - appends `VerificationCompleted` with the outcome and provenance payload in the same transaction as the state change; the new guard `verificationPassed` reads only the folded verification outcome, keeping the Phase 4 guard purity and traceability rules intact. Sections 1, 3, 4.2 (step 5 rewritten), a new 4.2a guard note, 4.8, 4.10, 4.11, 5, and 6 updated. The "no new events" claim in section 3 is corrected to name the one event this plan adds.

Carried from iteration 2 (OBJ-001, resolved): MVP acceptance restored to the verbatim V2 section 13 item 7 scope - two agents, plan → review → gate → human, ending at the recorded human decision; the implementation machinery is proven by a separate post-MVP implementation slice named as the first generalization step.

## 1. Context and Sources

Per the approved phase split (`approved-plans/task-20260718-043855-83ecd8/plan.md`), Phase 7 is the final phase: **Implementation Agents and MVP End-to-End** - worktree isolation, branch naming, cleanup, merge ordering, `ImplementationBlocked` escalation (V2 section 7); and the MVP roadmap from V2 section 13 item 7: one workflow (plan → review → gate → human) with two agents, end to end, before any generalization. Depends on all previous phases.

The previous phase artifacts, all verified present in the checkout:

- `approved-plans/task-20260718-043855-83ecd8/plan.md` - phase split; Phase 1 doc spec (twelve v1 platform events including `ImplementationBlocked`; role result schemas; objection/decision schemas; versioning policy with the additive-change rule).
- `approved-plans/task-20260718-065524-90fca8/plan.md` - Phase 2 doc spec; `AgentRuntime` interface methods; the verified 23-event table with worktree lifecycle events (`worktree_created`, `worktree_opened`, `worktree_removed`) classified as consumed for worktree lifecycle correlation; identity map with `agent_session_id`/`agent_session_path`.
- `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` - Phase 3 doc spec; sole-event-writer rule; turn rows with state, deadline, attempt scope; `artifacts` table; recovery procedure.
- `approved-plans/now-lets-create-next-phase-document-i-think-20260718-074737-1f04c6/plan-iteration-2-phase-4-workflow-engine-md-corrects.md` - Phase 4 doc spec; the `HumanApproved` → implementation workflow handoff point (its section 4.12); escalation states and the fault-signal-to-escalation mapping; guard purity and guard-input-to-event traceability rules; the `UsageRecorded` additive Phase 1 revision (the additive-revision precedent this plan follows twice).
- `approved-plans/next-lets-create-phase-5-go-through-other-20260718-161914-fc22a3/plan-iteration-2-phase-5-llm-boundary-components-md.md` - Phase 5 doc spec; its section 4.9 explicitly provides to Phase 7: implementation-agent prompt turn types reuse the role-prompt registry, and `ImplementationBlocked` deviation requests are validated through the same extraction pipeline; the objection-merge result schema (second additive-revision precedent).
- `approved-plans/now-uh-lets-do-six-like-get-context-20260718-163152-199477/plan-phase-6-frontier-review-dashboard-cost-md-frontier.md` - Phase 6 doc spec; its section 4.9 provides to Phase 7: the approval surface that triggers the implementation workflow (`HumanApproved` handoff), and cost/health metrics covering implementation agents identically (same ledger, same adapters); its section 4.9 also records that the MVP loop's human end - plan → review → gate → human - happens through Phase 6 surfaces, which is why MVP acceptance in this plan adds no machinery beyond Phases 1-6.

Current repo state, re-verified this turn: `docs/phases/` still does not exist; none of the six approved executions have landed. Same posture as every plan since Phase 2, now at its endpoint: if `docs/phases/` is absent at execution time, backfill the Phase 1-6 docs per the six approved plans (verified filenames above) first, then write the Phase 7 doc. This is the last phase, so executing this plan lands the complete eight-document set in one pass and retires the backfill debt entirely. The backfilled Phase 1 doc carries all approved additive revisions (`UsageRecorded`, objection-merge result schema) plus this plan's (below).

This plan makes one deliberate additive contract change with two parts, following the established mechanism (Phase 4's `UsageRecorded`, Phase 5's merge-result schema), both under the Phase 1 versioning policy with revision notes:

1. **Implementation-agent result schemas**: an implementation progress/result schema and a structured deviation-request schema, added to the Phase 1 role result schemas. The approved Phase 1 enumeration lists role result schemas for planner, reviewer, resolution verification, and frontier report only; V2 section 7 requires implementation agents to deliver results and structured deviation requests through the same artifact contract, and Phase 5 section 4.9 already commits their validation to the standard extraction pipeline. Without registered schemas, the Phase 5 rule "a catalog turn type without a registered result schema is a startup error" would make implementation turns unconstructible.
2. **`VerificationCompleted` platform event** (closes OBJ-002): added to the Phase 1 event enumeration as an additive revision. The implementation workflow's verification gate needs a durable, replayable fact: the Phase 4 rules require every guard input to be traceable to a platform event payload and the fold to consume only `events`. No existing event carries a verification outcome - `TurnCompleted` records an agent's turn result, but verification is run by the platform itself, not an agent turn, so overloading `TurnCompleted` would misattribute a platform action to an agent and break the event's correlation semantics. Payload: workflow and iteration correlation, verification attempt number, outcome (`passed | failed`), the config-declared command set with a content hash, per-command exit codes, and log artifact references (stored via the Phase 3 `artifacts` table, referenced by hash).

Inline duplication exceptions in the Phase 7 doc, each with a "source:" marker: the implementation-agent role description (source: V2 section 7), the MVP definition (source: V2 section 13 item 7), and the worktree API facts (source: V2 section 3).

## 2. Deliverables

```
docs/
  phases/
    README.md                            (index; Phase 7 status set to "detailed" - all seven phases detailed)
    phase-1-contracts-and-schemas.md     (backfill if absent, incl. all additive revisions)
    phase-2-herdr-runtime-adapter.md     (backfill if absent)
    phase-3-event-log-and-persistence.md (backfill if absent)
    phase-4-workflow-engine.md           (backfill if absent)
    phase-5-llm-boundary-components.md   (backfill if absent)
    phase-6-frontier-review-dashboard-cost.md (backfill if absent)
    phase-7-implementation-agents-and-mvp.md  (full detail - the deliverable of this task)
```

No source code in this turn. Documentation only.

## 3. Contracts Consumed from Phases 1-6

The Phase 7 doc consumes, and may not redefine:

- **Platform events** (Phase 1): `ImplementationBlocked` is already in the twelve-event v1 enumeration; `HumanApproved` triggers the handoff; the engine remains sole event writer (Phase 3 rule). This plan adds exactly one event - `VerificationCompleted`, as an additive Phase 1 revision (section 1) - plus the result schemas noted there; nothing else in the enumeration changes.
- **Turn protocol and artifact layout** (Phase 1/2): implementation turns are ordinary turns - `prompt.md` immutable and hash-identified, nonce-bound envelope, `result.toon` atomic write, single bounded repair, `TurnFailed` on second failure.
- **AgentRuntime interface** (Phase 2): `start(spec)` with worktree requirement in the agent spec; worktree lifecycle correlation via the consumed `worktree_*` events; identity map rules (`pane_id` never identity).
- **Persistence** (Phase 3): turn rows, `artifacts`, `decisions` with provenance; the event log as sole durable state; verification logs land in `artifacts` and are referenced by hash from the `VerificationCompleted` payload.
- **Workflow engine seams** (Phase 4): the `HumanApproved` handoff point (Phase 4 section 4.12); escalation states pause with notification; guards read folded state only, every guard input traceable to a platform event payload (the rule that forced this iteration's event revision); every transition commits state and events in one transaction.
- **LLM boundary infrastructure** (Phase 5): implementation-agent turn types enter the role-prompt registry; prompts built from state (the approved plan and decisions, never transcripts); deviation requests validated through the standard extraction pipeline with the single bounded repair; natural-language fields marked untrusted.
- **Approval surface and cost coverage** (Phase 6): the dashboard's approve/reject surface produces the `HumanApproved` that starts implementation; the cost ledger and health metrics cover implementation agents with the same adapters and `usage_ledger` - no new cost machinery. The MVP loop's human end runs entirely through Phase 6 surfaces (its section 4.9).

## 4. Required Content of `phase-7-implementation-agents-and-mvp.md`

### 4.1 Goal and Non-Goals

- Goal: two distinct deliverables, kept distinct throughout the doc - (a) the MVP end-to-end proof of the planning loop at exactly the V2 section 13 item 7 scope, and (b) the implementation workflow that consumes an approved plan, proven by its own post-MVP slice.
- Non-goals: no generalization beyond the implementation slice (multi-workflow scheduling, cross-project reuse - explicitly future work); no new orchestration machinery (Phase 4 engine runs this workflow); no new LLM boundary machinery (Phase 5 reused end to end); no silent architecture changes by implementation agents (V2 resolved question 5).

### 4.2 Implementation Workflow Definition

An explicit Phase 4-style machine, with states, guards, and emitted events per step:

1. Entry: `HumanApproved` on the planning workflow triggers the implementation workflow with the approved plan and its decision provenance as input (Phase 4 section 4.12 handoff).
2. Setup: worktree creation (4.3), implementation agent spawn via `start(spec)` with the worktree requirement, dependency bootstrap, port allocation.
3. Implementation turns: standard turn protocol; each turn's prompt is built from the approved plan, relevant decisions, and folded implementation state - never from chat history.
4. Per-turn outcome reduction: progress result → next turn or verification; deviation request → `ImplementationBlocked` escalation (4.5); turn failure/timeout → the standard Phase 4 failure transitions.
5. Verification step: the platform (not an agent) runs the config-declared verification commands; the engine appends **`VerificationCompleted`** (payload per section 1: attempt number, outcome, command-set hash, exit codes, log artifact refs) in the same transaction as the state change. Guard `verificationPassed` reads the folded outcome of the latest verification attempt - folded state and config only, per the Phase 4 purity rule, with the guard-input-to-event traceability satisfied by construction. A failed verification produces a bounded fix turn (the fix-turn prompt embeds the failure output as quoted evidence, 4.6); the fix loop is capped by the implementation iteration cap, and cap exhaustion escalates with the last verification payload attached - never silent looping.
6. Merge sequencing (4.4): single-agent slice merges directly; the multi-agent ordering rule is specified now but exercised later.
7. Cleanup: worktree removal per the cleanup policy, agent stop, final workflow state recorded.

All transitions are engine-owned; implementation agents only ever deliver result artifacts. The doc includes the guard table for this workflow (`verificationPassed`, `underImplementationIterationCap`, plus the reused Phase 4 guards) with the guard-input-to-event traceability rows, matching the Phase 4 doc's format.

### 4.3 Worktree Isolation and Repository Management

- Herdr's native `worktree create/open/remove` API handles mechanics (source: V2 section 3); the platform owns policy (source: V2 section 7): worktree isolation mandatory for concurrent writing agents, configurable for single-agent work (implementation-slice default: enabled, so the slice exercises the real path).
- **Branch naming**: deterministic scheme derived from correlation IDs - `parrot/<workflowId>/<agentId>` - recorded in the doc as the Phase 7-owned decision; branch recorded in the agents table row.
- **Cleanup policy**: worktrees removed on workflow completion; on failure/escalation kept for inspection until human release; orphaned worktrees (crash before cleanup) detected at startup by diffing Herdr worktree state against workflow state - reconciliation, same posture as Phase 2's `resync()`.
- **Dependency bootstrap**: per-worktree install step declared in workflow config, run before the first turn; failure is a setup fault escalated, never a silent skip.
- **Port allocation**: a per-workflow port range allocated from config, passed to agents via spec env; collisions are a setup failure.
- **Shared external resources**: named in workflow config as exclusive or shared; exclusive resources serialize the workflows that claim them - a deterministic queue, no LLM judgement.

### 4.4 Merge Ordering and Conflict Handling

- Merge ordering is deterministic platform policy: completed worktrees merge in workflow-defined dependency order, falling back to completion order; the ordering rule is config, the doc records the default.
- Conflict handling: a merge conflict is never resolved by an implementation agent silently continuing - the conflicting merge pauses in an escalated state with the conflict summary attached; resolution is a human action or an explicitly configured re-run of the later agent's work on the updated base. Recorded as policy, revisable by config.
- Slice scope note: with one implementing agent, the merge queue has depth one; the machinery is specified fully but the multi-agent path is exercised in later tests.

### 4.5 ImplementationBlocked Escalation

- **Deviation-request schema** (part of the additive Phase 1 revision, with revision note): blocked reason category (ambiguous plan, infeasible step, contradicting constraint, missing dependency), the plan step reference, a structured description marked untrusted, proposed deviation (optional), evidence references. Zod-enforced; validated through the Phase 5 extraction pipeline (its section 4.9 commitment) with the standard single bounded repair.
- **Flow**: a validated deviation request reduces to `ImplementationBlocked` (already in the Phase 1 twelve); the workflow pauses in the escalated state; routing per workflow rule - to the planner (a bounded revision loop through the existing planning machinery) or to the human (dashboard escalation view, Phase 6) - per V2 resolved question 5: challenging architecture happens only through this path.
- A deviation accepted by planner or human produces a decision with provenance linking the deviation request, then implementation resumes; a rejected deviation returns instruction to proceed or ends the workflow. Never a silent workaround.

### 4.6 Implementation Result Schema and Turn Types

- **Implementation result schema** (the other half of the additive Phase 1 schema revision): turn outcome (progress, complete, blocked - blocked meaning the payload carries a deviation request), summary marked untrusted, changed-file list, verification hints (commands the agent believes relevant), evidence references. Worked TOON example and Zod type, matching the Phase 1 doc's format for the other role schemas.
- **Turn types** added to the Phase 5 registry catalog (per its section 4.9): implementation task turn, fix turn (embeds the `VerificationCompleted` failure payload's command output as quoted evidence), deviation-resolution turn. Each with prompt spec, injection-defense rendering (verification output and plan prose as quoted evidence blocks), and the turn-type-to-schema mapping entries the Phase 5 completeness check requires.

### 4.7 MVP End-to-End Definition (source scope, unmodified)

- Scope, verbatim from the source (source: V2 section 13 item 7, repeated by the approved phase split): **one workflow - plan → review → gate → human - with two agents, end to end, before any generalization.**
- Concrete MVP cast, exactly two agents: the persistent planner (Claude via session-identity integration) and one ephemeral reviewer per round running the adversarial role (reviewer count 1, adversarial count 1 - the Phase 5 minimum). Frontier review runs at panel size 1 using the same reviewer provisioning; it is a workflow step, not a third roster agent beyond the two-agent cast: the frontier turn is an ephemeral session under the same reviewer-provisioning machinery. The workflow ends at the recorded human decision (`HumanApproved` or `HumanRejected`) made through the Phase 6 dashboard - the human end of the loop that Phase 6 section 4.9 already places on Phase 6 surfaces.
- **MVP acceptance checklist ends at the human decision**: startup checks pass against pinned Herdr; planning loop produces a proposal, at least one objection cycle, and consensus; frontier review runs; notification fires; the human records a decision in the dashboard; the decision and its provenance are persisted. Nothing after the gate is MVP acceptance: no worktree, no implementation execution, no verification, no merge, no cleanup.
- Replay determinism and cost-ledger coverage are **not MVP gate criteria**: they are Phase 3/4 replay-test and Phase 6 ledger-test obligations that the MVP run additionally feeds (its archived event log becomes a replay fixture; its session logs flow through the ledger), observed and reported but owned by those phases' test plans.
- Everything the MVP does not exercise is listed explicitly (implementation workflow, multi-reviewer rounds, panel mode N>1, merge queue, budget-cap pause in live operation) so MVP completion cannot be mistaken for full coverage.

### 4.8 Implementation Slice (post-MVP, first generalization step)

- Sequencing rule, stated in the doc: the implementation slice runs only after MVP acceptance passes. V2 orders the MVP "before any generalization"; attaching the implementation workflow is the first generalization act, and the doc names it as such rather than folding it into the MVP.
- The slice: the human approval from an accepted planning workflow triggers the implementation workflow (4.2) with a single implementation agent in a worktree; it executes the approved plan, passes the verification gate, merges, and cleans up.
- Slice acceptance checklist (separate from MVP): worktree created and correlated via `worktree_*` events; implementation turns round-trip through the standard protocol with the new result schema; a seeded deviation fixture exercises the `ImplementationBlocked` path end to end; a seeded failing verification produces `VerificationCompleted(failed)`, a fix turn, then `VerificationCompleted(passed)` on the retry; merge lands; cleanup removes the worktree; the slice's event log replays to identical folded state including the folded verification outcomes.
- The slice is where the Phase 7 machinery (4.2-4.6) gets its live proof; the MVP is where the platform (Phases 1-6) gets its proof. The doc keeps the two checklists in separate sections with this rationale stated.

### 4.9 Configuration Surface

Single table: key, type, default, consuming section. Minimum: worktree isolation toggle (default on), branch naming template, cleanup policy (complete/failure cases), bootstrap command, verification command set (the hashed, config-declared list the `VerificationCompleted` payload references), port range, exclusive-resource declarations, merge ordering rule, implementation iteration cap, deviation routing rule (planner vs human), MVP and slice agent/provider/model assignments and role-prompt version pins.

### 4.10 Test Plan

- Workflow machine: transition-table coverage for the implementation workflow; handoff test (`HumanApproved` payload starts implementation with the approved plan attached); verification-failure fix loop bounded by the iteration cap, cap exhaustion escalates with the last verification payload.
- Verification event: platform-run commands produce `VerificationCompleted` with correct outcome, attempt number, command-set hash, exit codes, and artifact refs; `verificationPassed` guard reads only folded state (traceability row test, extending the Phase 4 mechanical check); duplicate reduction of the same verification event is a no-op; replay of a log containing failed-then-passed verification folds to the passed outcome.
- Worktree lifecycle: create/bootstrap/remove against a fake Herdr socket; cleanup-on-failure keeps the worktree; orphaned-worktree reconciliation at startup; branch naming deterministic from IDs.
- Deviation path: valid deviation request fixture → `ImplementationBlocked` → escalated state with routing per rule; invalid deviation payload → repair → `TurnFailed`; accepted deviation produces a decision with provenance and resumes; schema round-trips per the Phase 5 fixture conventions.
- Result schema: fixtures per outcome; changed-file list and untrusted marking respected downstream (dashboard render test extension).
- Merge and conflict: ordering rule honored with a seeded queue; injected conflict pauses in escalated state and never auto-resolves.
- MVP end-to-end: the 4.7 acceptance checklist as an integration test against real Herdr, gated behind an env flag (Phase 2 convention), with exactly the two-agent cast; the run's event log archived as a replay fixture for the Phase 3/4 replay suites.
- Implementation-slice end-to-end: the 4.8 checklist as a second, separately gated integration test, run only after the MVP test passes; its log archived likewise.
- All LLM calls in unit/contract tests faked via recorded fixtures; the two gated e2e runs are the only deliberate live exercises.

### 4.11 Assigned Open Questions and Phase-Owned Decisions

None of the four V2 section 11 remaining open questions land in Phase 7 (dedup → Phase 5, concurrency → Phase 2, reviewer pool → Phase 5, redaction → Phase 6); the doc states this and points at each owner. Phase 7-owned decisions recorded in the doc: branch naming scheme, cleanup policy, merge ordering default, port allocation scheme, deviation routing default, the two-part additive Phase 1 revision (implementation result/deviation schemas, `VerificationCompleted` event), and the MVP/slice sequencing rule of 4.8.

### 4.12 Dependencies and Interfaces to Other Phases

- Depends on all previous phases: Phase 1 (contracts, incl. this plan's additive revision), Phase 2 (runtime, worktree events), Phase 3 (persistence, replay, artifacts for verification logs), Phase 4 (engine, handoff, escalation, guard rules), Phase 5 (registry, extraction, injection defense), Phase 6 (approval surface, notifications, cost coverage).
- Provides: the completed MVP proof at the V2 section 13 exit criterion, plus the proven implementation workflow as generalization step one. Further generalization (multi-agent merge queues in anger, multi-workflow concurrency per the Phase 2 measurement, cross-project decision reuse per resolved question 7) is future work beyond the phase plan, listed as such.

## 5. Execution Steps

1. If `docs/phases/` is absent: create `README.md` and backfill Phases 1-6 from the six verified sources in section 1. The backfilled Phase 1 doc includes all additive revisions - `UsageRecorded` (Phase 4 plan), the objection-merge result schema (Phase 5 plan), and this plan's two-part revision (implementation result + deviation-request schemas, `VerificationCompleted` event) - each with its revision note, so no doc ever exists in an unrevised state. If present: backfill only what is missing and apply the revisions.
2. Write `docs/phases/phase-7-implementation-agents-and-mvp.md` with the twelve sections of section 4 above, citing Phase 1-6 doc sections throughout.
3. Update `README.md` index: Phase 7 → "detailed". All seven phases now detailed; the index gains a closing note that the doc set is complete and implementation may begin with Phase 1.
4. Stop. No code.

## 6. Risks

- **Backfill debt at its terminus**: six approved executions have not landed; this turn may write all eight documents. This is the final planning turn, so the deferral question ends here: executing this plan produces the complete doc set in one pass. Flagged one last time for the human: nothing further should be planned before `docs/phases/` exists.
- **Third additive Phase 1 revision, now two-part**: follows the established mechanism (revision note, additive rule) with the same containment as before - all revisions land in the same backfill write. Both parts are forced, not optional: implementation turns without registered result schemas violate the Phase 5 startup-error rule, and a verification gate without a platform event violates the Phase 4 guard traceability rule (the exact gap OBJ-002 caught - the alternative, overloading `TurnCompleted`, would misattribute a platform action to an agent turn).
- **MVP scope drift**: the failure OBJ-001 caught, contained structurally: the MVP section quotes the source scope verbatim with a source marker, its checklist ends at the human decision, and the implementation slice lives in a separate section with an explicit sequencing rule - a future edit that blurs the boundary has to delete a stated rule, not just reword a list.
- **Frontier-turn cast accounting**: the MVP counts two roster agents; the frontier turn reuses reviewer provisioning rather than adding a third. Stated explicitly in 4.7 so the two-agent claim is auditable against the workflow definition.
- **Merge/conflict policy is judgement, not measurement**: recorded as revisable config-backed policy with a fail-safe default (pause and escalate, never auto-resolve); the slice's single-agent scope keeps the untested surface small and explicitly listed.
- **Live-run dependence**: two deliberate live e2e runs (MVP, then slice) can flake with real Herdr and real providers. Contained: env-flag gating (Phase 2 convention), all other tests fixture-based, and each successful run's event log archived as a deterministic replay fixture so the proof is reproducible offline afterwards.
- **Duplication drift**: role description, MVP definition, and worktree facts carry "source:" markers to V2 sections 7, 13, and 3.
