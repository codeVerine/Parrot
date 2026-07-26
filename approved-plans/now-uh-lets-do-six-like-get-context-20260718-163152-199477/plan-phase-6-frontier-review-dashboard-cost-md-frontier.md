# Plan (iteration 1): Expand Phase 6 (Frontier Review, Dashboard, Cost Ledger) into a Full Technical Document

## 1. Context and Sources

Per the approved phase split (`approved-plans/task-20260718-043855-83ecd8/plan.md`), Phase 6 covers three components: the frontier review turn and objection conversion (V2 section 6.7); the dashboard over read models with drill-down chain and `NotificationSink` (V2 section 6.8); the cost ledger with versioned provider session-log adapters, budget caps, and orchestration-health metrics (V2 section 6.10). Depends on Phases 1-5 (dashboard and ledger read persisted state; frontier review is a workflow step).

The previous phase artifacts, all verified present in the checkout:

- `approved-plans/task-20260718-043855-83ecd8/plan.md` - phase split; Phase 1 doc spec (twelve v1 platform events, role result schemas including the frontier report, objection/decision schemas).
- `approved-plans/task-20260718-065524-90fca8/plan.md` - Phase 2 doc spec; identity map carrying `agent_session_id`/`agent_session_path`; session logs parsed only by versioned provider adapters, never the canonical channel.
- `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` - Phase 3 doc spec; `usage_ledger` schema (message-ID dedup key, separate token columns, pricing version, health counters); `artifacts` and read-source tables the dashboard projects.
- `approved-plans/now-lets-create-next-phase-document-i-think-20260718-074737-1f04c6/plan-iteration-2-phase-4-workflow-engine-md-corrects.md` - Phase 4 doc spec; workflow steps 6-9 (frontier turn, finding conversion, human decision); the usage-input seam: Phase 6 submits usage facts, the engine appends `UsageRecorded` and emits `BudgetCapReached` on cap crossing; escalation states.
- `approved-plans/next-lets-create-phase-5-go-through-other-20260718-161914-fc22a3/plan-iteration-2-phase-5-llm-boundary-components-md.md` - Phase 5 doc spec; role-prompt registry and builder/validator infrastructure the frontier turn reuses; untrusted-string marking the dashboard's escaping relies on; injection-defense template convention.

Current repo state: `docs/phases/` still does not exist; none of the five approved executions have landed. Same posture as every plan since Phase 2: if `docs/phases/` is absent at execution time, backfill the Phase 1-5 docs per the five approved plans (verified filenames above) first, then write the Phase 6 doc. The backfilled Phase 1 doc carries both approved additive revisions (`UsageRecorded`, objection-merge result schema). Nothing here contradicts the approved plans; this plan introduces no new contract revisions - the frontier report schema is already in the Phase 1 enumeration and the usage/budget seam is already defined by the Phase 4 plan.

Inline duplication exceptions in the Phase 6 doc, each with a "source:" marker: the drill-down chain (source: V2 section 6.8), the usage_ledger field list (source: V2 section 6.10 via the Phase 3 doc), and the frontier output field list (source: V2 section 6.7 via the Phase 1 frontier report schema).

## 2. Deliverables

```
docs/
  phases/
    README.md                            (index; Phase 6 status set to "detailed")
    phase-1-contracts-and-schemas.md     (backfill if absent, incl. both additive revisions)
    phase-2-herdr-runtime-adapter.md     (backfill if absent)
    phase-3-event-log-and-persistence.md (backfill if absent)
    phase-4-workflow-engine.md           (backfill if absent)
    phase-5-llm-boundary-components.md   (backfill if absent)
    phase-6-frontier-review-dashboard-cost.md (full detail - the deliverable of this task)
    phase-7-implementation-agents-and-mvp.md  (skeleton, if absent)
```

No source code in this turn. Documentation only.

## 3. Contracts Consumed from Phases 1-5

The Phase 6 doc consumes, and may not redefine:

- **Frontier report schema** (Phase 1): implementation readiness, remaining risks, questions for the human, executive summary - with Zod type and TOON example.
- **Objection contract** (Phase 1): frontier blocking findings and panel contradictions become ordinary objections; no special frontier objection type.
- **Session-log access** (Phase 2): `agent_session_path` from the identity map; logs are audit/usage input only, never the canonical data channel; provider formats are provider-owned and drift independently (V2 sections 5, 10).
- **Persistence** (Phase 3): `usage_ledger` (unique provider message ID, cache/input/output token columns, pricing version, wall-clock/retry/repair/timeout/startup counters), `artifacts` (transcript path + content hash), plus the tables dashboard read models project.
- **Workflow seams** (Phase 4): frontier turn placement after the zero-open-objections gate; finding-to-objection conversion re-entering the loop under the same iteration cap; the usage-input seam (ledger submits facts, engine dedups by message ID, appends `UsageRecorded`, folds `spendTotal`, emits `BudgetCapReached` crossing the cap); `escalated`/paused workflow states; `HumanApproved`/`HumanRejected` and the approval-with-waived-objections path.
- **LLM boundary infrastructure** (Phase 5): the frontier prompt is a role-prompt registry entry built by the Prompt Builder and validated by Extraction & Validation with the single bounded repair; natural-language fields arrive marked as untrusted strings.

## 4. Required Content of `phase-6-frontier-review-dashboard-cost.md`

### 4.1 Goal and Non-Goals

- Goal: the three components that close the loop to the human - frontier review (attack the consensus), dashboard (filter information, never replace judgement, V2 section 2), cost ledger (measure cost and orchestration health from day one).
- Non-goals: no orchestration decisions (Phase 4), no new LLM boundary machinery (reuses Phase 5 end to end), no schema or event changes (all contracts exist), no implementation-agent concerns (Phase 7).

### 4.2 Frontier Review

- **Placement and trigger** (source: V2 section 6.7): runs only after the objection gate passes (Phase 4 workflow step 6). Input: final proposal and full objection history (including resolved/waived, so the frontier reviewer sees what was already litigated). Output: the Phase 1 frontier report schema.
- **Turn mechanics**: standard turn protocol via Phase 5 - frontier role prompt added to the role-prompt registry (versioned like every other role prompt), objection history rendered as quoted evidence per the injection-defense convention, validation and single bounded repair as usual. Frontier `TurnFailed` escalates to the human (a failed frontier review never silently passes the gate).
- **Role posture**: detects remaining engineering uncertainty and attacks the consensus rather than blessing it (V2 section 7); prompt spec includes the false-consensus mitigation rationale (V2 section 10).
- **Finding conversion**: blocking findings do not stall in the report - each becomes an `ObjectionRaised` through the engine and re-enters the objection loop, bounded by the existing iteration cap. Non-blocking risks and questions flow to the dashboard summary.
- **Panel mode**: workflow config declares one reviewer or an N-reviewer panel. If N > 1: contradictions between panel reports are first-class findings converted to objections and presented to the human, not summary footnotes. The doc specifies the deterministic contradiction rule: divergent readiness verdicts or mutually exclusive risk claims between panel members always surface; no LLM adjudicates between panel members.

### 4.3 Dashboard Read Models

- **Consumption rule** (source: V2 section 6.8): structured read models only - SQLite projections, TOON-backed artifacts, API DTOs. Never an LLM call, never raw chat prose as data.
- **Read model catalog**, one definition per model (fields, source tables, refresh trigger): workflow summary (state, iteration, caps), open/resolved objection lists (with cluster views preserving member IDs), decision list with provenance, timeline (from platform events), cost summary (from usage_ledger), frontier report view, escalation view (open objection list attached to the paused state).
- **Drill-down chain**, every claim navigable: summary → objection → decision → evidence → transcript reference. Link integrity is a schema property: each level stores the IDs of the next, so a broken link is a data bug, not a rendering bug.
- **Transcript references**: path plus content hash (Phase 3 `artifacts`); the doc specifies handling for path expiry (hash lets a moved log be re-verified), local-only access (dashboard renders the reference, not the content, when the file is remote/absent), secrets and redaction (4.5), retention.
- **Untrusted rendering**: every natural-language field is escaped on render; the Phase 5 untrusted-string marking is the contract - the dashboard never interprets, executes, or unescapes marked strings. Objection claims, decision reasons, frontier prose: all quoted display only.
- **Approve/reject with comments**: the human decision surface. Approval, rejection, and approval-with-waived-objections (explicit waiver per objection, V2 section 6.6) post back to the engine, which emits `HumanApproved`/`HumanRejected` and the waiver status transitions. Comments persist to `human_feedback` (Phase 3).
- **Stack**: React + Vite (V2 section 12), read-only API over the Phase 3 DB plus a narrow decision-posting endpoint; DTOs versioned.

### 4.4 NotificationSink

- Interface: `notify(request)` where request carries workflow ID, kind (approval requested, escalation, budget pause), summary line, dashboard deep link. Emitted by the engine at workflow steps that require human attention (Phase 4 steps 8 and 10).
- Herdr implementation: `notification show --sound request` (source: V2 section 6.8). The sink interface keeps Herdr replaceable; Slack/Discord sinks are future implementations of the same interface, not new seams.
- Delivery is best-effort and non-durable by design: the durable fact is the workflow's paused/awaiting state in the event log; a missed notification never loses a decision request (the dashboard shows it; a re-notify command exists).

### 4.5 Cost Ledger

- **Provider adapters**: one versioned adapter per provider (Anthropic, OpenAI, Google AI - V2 section 12), parsing session logs found via `agent_session_path`. Adapter version recorded with every parsed record. Format drift is expected: an unparseable log is a logged degradation (usage unknown for that session), never a workflow failure - result files remain the contract (V2 section 10).
- **Extraction fields** (source: V2 section 6.10 via Phase 3 schema): provider message ID (dedup of replayed/re-read records), cache/input/output tokens separately, computed cost, pricing version used for the calculation.
- **Flow**: adapter parses incrementally (per turn completion and on a sweep cadence) → writes `usage_ledger` rows → submits usage facts through the Phase 4 seam → engine dedups by message ID against folded state, appends `UsageRecorded`, folds `spendTotal`, emits `BudgetCapReached` when a reduction crosses the cap and pauses the workflow with notification (V2 section 6.10: pause and notify, never continue silently). The ledger table is audit/reporting; the event log is enforcement - both roles stated so they are not conflated (Phase 4 plan section 4.5 rule).
- **Pricing tables**: versioned data files; recomputation never overwrites - a pricing correction produces new records with the new pricing version, keeping historical cost auditable.
- **Health metrics**: wall-clock duration per turn/workflow, retry count, repair count, timeout count, agent startup time - sourced from platform events and turn rows, reported alongside token cost because token cost alone does not explain orchestration health (V2 section 6.10).

### 4.6 Redaction and Retention Policy (assigned open question)

V2 section 11 remaining question 4 lands here: redaction policy for transcripts referenced by the dashboard. The doc records the policy decision:

- Transcript content never leaves the machine that owns it; the dashboard renders references (path, hash, size, provider) by default and content only when the file is locally readable and the workflow is not marked sensitive.
- Pattern-based secret scanning runs before any transcript excerpt is rendered or exported; matches render as redaction markers with a count, never the match text. Scanner rules are config, versioned.
- Retention: transcripts are provider/Herdr-owned files - the platform stores references and hashes only, and a retention window config governs how long usage-extraction sweeps keep re-reading them; expired references stay valid as audit records (hash proves what was referenced).
- Export (any path that copies content off-machine) requires explicit human action and runs the same scanner; this is recorded as the policy default, revisable by config, and flagged as the measurement-free decision it is (policy, not benchmark).

### 4.7 Configuration Surface

Single table: key, type, default, consuming section. Minimum: frontier panel size N (default 1), frontier provider/model and role-prompt version pin, notification sink selection, re-notify command binding, ledger sweep cadence, pricing table version, adapter version pins per provider, secret-scanner ruleset version, retention window, dashboard bind address/port, sensitive-workflow flag default.

### 4.8 Test Plan

- Frontier: finding-to-objection conversion (blocking finding produces `ObjectionRaised` and re-enters the loop; iteration cap still binds); frontier `TurnFailed` escalates; panel contradiction fixtures (divergent readiness, exclusive risk claims) surface as objections; report schema round-trip via Phase 5 fixtures.
- Dashboard: read-model projection tests per catalog entry against seeded DBs; drill-down link integrity (every rendered ID resolves); escaping tests - instruction-shaped and HTML/script-shaped text in objection claims renders inert (extends the Phase 5 scanner fixtures to the render layer); decision posting emits the right events including per-objection waivers; DTO version checks.
- NotificationSink: fake sink captures requests per escalation kind; missed-notification test - workflow remains awaiting and dashboard shows the request without any notification delivered; re-notify works.
- Ledger: recorded session-log fixtures per provider and adapter version; duplicate message ID idempotent end to end (ledger row and no second `UsageRecorded`); pricing-version recording and correction-produces-new-records; unparseable log degrades without workflow failure; cap-crossing integration test through the Phase 4 seam (pause + notify); health metrics derived correctly from a replayed event log.
- Redaction: scanner fixtures (keys, tokens, obvious secrets) redact in render and export paths; sensitive-workflow flag suppresses content rendering; expired-reference view still shows hash and metadata.
- All LLM calls faked via recorded fixtures; no live-model dependence.

### 4.9 Dependencies and Interfaces to Other Phases

- Depends on: Phase 1 (frontier report, objection schemas), Phase 2 (session paths), Phase 3 (usage_ledger, artifacts, read sources), Phase 4 (workflow seams, events), Phase 5 (builder/validator, untrusted marking).
- Provides to Phase 7: the approval surface that triggers the implementation workflow (`HumanApproved` handoff); cost/health metrics covering implementation agents identically (same ledger, same adapters).
- Completes the V2 section 13 MVP loop's human end: plan → review → gate → human happens through this phase's surfaces.

## 5. Execution Steps

1. If `docs/phases/` is absent: create `README.md` and backfill Phases 1-5 from the five verified sources in section 1 (Phase 1 doc includes both additive revisions), and create the Phase 7 skeleton. If present: backfill only what is missing.
2. Write `docs/phases/phase-6-frontier-review-dashboard-cost.md` with the nine sections of section 4 above, citing Phase 1-5 doc sections throughout.
3. Update `README.md` index: Phase 6 → "detailed".
4. Stop. No code.

## 6. Risks

- **Backfill debt now spans five approved plans**: this turn may write seven documents. Repeated flag, now at its sharpest: only Phase 7 remains unplanned, so executing the backlog immediately after this approval means the full doc set lands in one pass; deferring again means the Phase 7 turn carries the entire load.
- **Provider log format drift** (V2 section 10): contained by versioned adapters, adapter-version stamps on records, and the degradation rule (unknown usage, never workflow failure). The enforcement path stays sound because budget facts flow only through validated `UsageRecorded` events.
- **Redaction policy is judgement, not measurement**: recorded explicitly as a revisable policy decision with versioned scanner rules; the conservative default (references only, scan before any content render/export) fails safe.
- **Dashboard scope creep**: bounded by the consumption rule - read models only, one narrow write endpoint (decisions). Anything needing new data is a Phase 3 projection or a Phase 4 event, never dashboard-side logic.
- **Notification reliability**: made a non-risk structurally - the durable awaiting state lives in the event log; sinks are best-effort by declared design.
- **Duplication drift**: drill-down chain, ledger fields, and frontier output list carry "source:" markers to V2 6.7/6.8/6.10 and the Phase 1/3 docs.
