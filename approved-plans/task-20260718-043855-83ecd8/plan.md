# Plan: Split the V2 Architecture into Phases and Produce Phase 1 Technical Documentation

## 1. Context

`Multi-Agent-Orchestration-Architecture-v0.2.md` is a single monolithic architecture document. It does not currently define numbered delivery phases; the closest thing is section 13 ("Next Phase (contracts first)"), which gives a dependency-ordered list of contracts to define, and an MVP roadmap hint ("one workflow with two agents, end to end, before any generalization").

There is no `docs/` directory and no per-phase documentation anywhere in the repo. So this plan does two things:

1. Defines the phase split for the whole V2 architecture.
2. Specifies, in full detail, the technical document for Phase 1, which is the first document to be written. Later phases get skeleton documents only (title, scope, dependencies), to be expanded one at a time in subsequent turns, matching the task's "one by one" instruction.

## 2. Proposed File Layout

```
docs/
  phases/
    README.md                        (phase index: table of phases, status, dependencies)
    phase-1-contracts-and-schemas.md (full detail, written now)
    phase-2-herdr-runtime-adapter.md (skeleton)
    phase-3-event-log-and-persistence.md (skeleton)
    phase-4-workflow-engine.md       (skeleton)
    phase-5-llm-boundary-components.md (skeleton)
    phase-6-frontier-review-dashboard-cost.md (skeleton)
    phase-7-implementation-agents-and-mvp.md (skeleton)
```

The V2 document stays untouched as the source architecture. Phase docs reference its section numbers rather than duplicating rationale, so the two cannot drift silently.

## 3. Phase Split

The split follows the dependency order already implied by V2 section 13 (contracts first) and the component diagram in section 4. Each phase is independently reviewable and produces artifacts the next phase consumes.

### Phase 1: Contracts and Schemas (foundation)
Everything downstream depends on the data contracts, so they come first, exactly as V2 section 13 argues ("the contracts are the architecture").

Scope:
- Platform event schema: event IDs, correlation fields (`workflowId`, `iterationId`, `turnId`, `agentId`), runtime-signal vs platform-event distinction (V2 section 6.2).
- Turn artifact contracts: prompt file header format, result envelope (nonce, schema version, correlation IDs), TOON result schemas per role (proposal, review/objections, frontier report), repair protocol (V2 section 5).
- Objection schema and lifecycle (V2 section 6.6): severity rubric, status transitions, evidence rules, cluster/merge semantics.
- Decision schema with provenance (V2 section 8).
- Requirements schema (V2 section 6.9): source path, content hash, priority, external identifier.
- Zod validation modules for every schema; TOON serialization/parsing conventions.

Deliverables: schema source files under `src/contracts/` (or equivalent), Zod validators, TOON fixtures, contract-level unit tests, and the phase doc itself.

### Phase 2: Herdr Runtime Adapter
Scope: `AgentRuntime` interface implementation against protocol 16; startup checks (protocol pin, integration status, production fail-closed vs development mode); identity mapping (`pane_id` never used as agent identity); result-file watching with the security checks from V2 section 5 step 5; turn deadline timers and `AgentTimedOut` synthesis; status normalization (Herdr `done` reduced to a non-authoritative hint); reconnect reconciliation via `session.snapshot` + `agent.list`. (V2 sections 3, 6.1.)

Depends on: Phase 1 (turn artifact contracts, event schema).

### Phase 3: Durable Event Log and Persistence
Scope: SQLite (WAL) schema for all tables in V2 section 6.9; transactional outbox (persist-then-dispatch); runtime signals persisted separately from platform events; idempotent consumers; replay/fold; recovery tests that kill and restart mid-turn and require identical folded state. Drizzle ORM setup. (V2 sections 6.2, 6.9.)

Depends on: Phase 1 (event schema). Can proceed in parallel with Phase 2.

### Phase 4: Workflow Engine
Scope: XState (or equivalent) deterministic state machine; explicit turn states (`created → sent → waiting → result_seen → validating → completed / repair_sent / failed / timed_out / cancelled`); orphan-result handling; guards over objection status, iteration caps, budget caps; the planning workflow of V2 section 6.3. (V2 section 6.3.)

Depends on: Phases 1-3.

### Phase 5: LLM Boundary Components
Scope: Prompt Builder (immutable hash-identified prompt files, versioned role prompts, state-built context); Extraction and Validation (TOON parse, Zod validate, one bounded repair, `TurnFailed`); Objection Engine (merge/dedupe as non-destructive clustering, severity rubric enforcement, adversarial reviewer role prompt). (V2 sections 6.4-6.6.)

Depends on: Phases 1, 4.

### Phase 6: Frontier Review, Dashboard, Cost Ledger
Scope: frontier review turn and objection conversion (V2 section 6.7); dashboard over read models with drill-down chain and `NotificationSink` (V2 section 6.8); cost ledger with versioned provider session-log adapters, budget caps, orchestration-health metrics (V2 section 6.10).

Depends on: Phases 1-5 (dashboard and ledger read persisted state; frontier review is a workflow step).

### Phase 7: Implementation Agents and MVP End-to-End
Scope: worktree isolation, branch naming, cleanup, merge ordering, `ImplementationBlocked` escalation (V2 section 7); the MVP roadmap from V2 section 13 item 7: one workflow (plan → review → gate → human) with two agents, end to end.

Depends on: all previous phases.

Cross-cutting, not a phase: the four Remaining Open Questions in V2 section 11 are assigned to phases where they must be answered (dedup quality → Phase 5, concurrency limits → Phase 2, reviewer pool composition → Phase 5, redaction policy → Phase 6). Each phase doc carries its assigned open questions so they cannot be lost.

## 4. Phase 1 Technical Document: Required Content

`docs/phases/phase-1-contracts-and-schemas.md` is written now with maximum detail. Its required sections:

1. **Goal and non-goals.** Contracts only; no runtime behavior, no Herdr calls, no persistence engine. Non-goal: implementing consumers.
2. **Artifacts and directory layout.** `runs/<workflowId>/<iterationId>/<turnId>/` with `prompt.md`, `result.toon`, `repair-prompt.md`; atomic write protocol (`result.tmp` then rename); permission and ownership expectations.
3. **Result envelope contract.** Fields: `workflowId`, `iterationId`, `turnId`, `schemaVersion`, `nonce`, plus role payload. Rejection rules: envelope mismatch, missing nonce, stale turn.
4. **Platform event schema.** Full enumeration of v1 events (`TurnCompleted`, `TurnFailed`, `AgentTimedOut`, `ObjectionRaised`, `ObjectionResolved`, `ConsensusReached`, `HumanApproved`, `HumanRejected`, `ImplementationBlocked`, `BudgetCapReached`, `IterationCapReached`, `OrphanResultSeen`), each with ID format, correlation fields, and payload schema. Separate enumeration of runtime signals (`HerdrStatusChanged`, `ResultFileSeen`, `DeadlineExpired`, `SnapshotReconciled`) with provenance fields.
5. **Role result schemas.** One TOON schema per role: planner proposal, reviewer objections, resolution verification, frontier report. Each with a worked TOON example and its Zod type.
6. **Objection schema.** Fields, severity rubric table (verbatim from V2 section 6.6 so reviewers and validators share one source), status state machine with allowed transitions, evidence requirements and `evidence_missing` marker, cluster representation (cluster ID, member objection IDs preserved, max-severity rule).
7. **Decision schema.** Fields plus provenance block; requirement references.
8. **Requirements schema.** Stable IDs, source path, content hash, priority, external identifier.
9. **Versioning policy.** `schemaVersion` semantics, additive-change rules, how a breaking schema change is rolled out across planner (persistent session) and reviewers (ephemeral).
10. **Validation and repair protocol.** Zod-per-schema, exactly one bounded repair prompt, repair prompt content requirements, second-failure `TurnFailed` semantics.
11. **Test plan.** Fixture-based round-trip tests (TOON serialize → parse → Zod validate), negative fixtures for every rejection rule, envelope-mismatch cases.
12. **Assigned open questions.** None from V2 section 11 land in Phase 1, but the doc records the versioning question ("how aggressively can schemas evolve before planner session continuity breaks") as a Phase 1-owned decision.

## 5. Execution Steps (this turn's scope and next)

1. Create `docs/phases/README.md` with the phase index table (phase, title, status, depends-on, V2 sections covered).
2. Create `docs/phases/phase-1-contracts-and-schemas.md` with all twelve sections above, fully detailed, with worked TOON examples and Zod type sketches drawn from V2 sections 5, 6.2, 6.6, 6.9, and 8.
3. Create the six skeleton docs for Phases 2-7: goal paragraph, scope bullet list, dependencies, V2 section references, assigned open questions, and a "Status: skeleton, to be detailed" marker.
4. Stop. Phases 2-7 get detailed one at a time in later turns, after the Phase 1 doc is reviewed, per the task's "one by one" instruction.

## 6. Risks

- **Drift between phase docs and V2.** Mitigated by referencing V2 section numbers instead of duplicating rationale, and by keeping the severity rubric as the single verbatim exception (validators need it inline).
- **Phase granularity wrong.** Phases 2 and 3 are parallelizable and could merge; kept separate because the adapter (external boundary) and persistence (internal source of truth) have different review audiences. Reviewers can object with evidence if the split is wrong.
- **Over-detailing Phase 1 before review.** Accepted deliberately: the task explicitly asks for "as much details as possible" on the first phase doc.
