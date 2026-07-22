# Phase 6: Frontier Review, Dashboard, and Cost

**Status: implemented**

Phase 6 closes the loop to the human. The implementation is
`@platform/human-loop` under `packages/human-loop` (frontier conversion,
dashboard projections, notification sinks, cost ledger, redaction) plus
`@platform/dashboard` under `packages/dashboard` (React + Vite UI over the
read/decision API). V2 sections: 6.7, 6.8, and 6.10. It depends on
Phases 1–5; it introduces no new platform event kinds or role-result
schemas.

Packages consume:

- `@platform/contracts` — `FrontierResultSchema`
- `@platform/workflow-engine` — `reportFrontier`, `submitUsage`,
  `humanDecision`, `NotificationSink.notifyEscalation`,
  `frontierPanelSize`
- `@platform/llm-boundary` — `frontier_report` turn type, Prompt Builder,
  Extraction & Validation, `UntrustedText`
- `@platform/persistence` — `usage_ledger`, `artifacts`, `human_feedback`,
  and the tables dashboard projections read

## 1. Goal and Non-Goals

**Goal.** Three components that finish the human end of the MVP loop:

1. **Frontier review** — after zero open objections, attack the consensus;
   blocking findings become ordinary objections and re-enter the loop.
2. **Dashboard** — structured read models only; drill-down to transcript
   references; approve / reject / waive posting back to the engine.
3. **Cost ledger** — measure token cost and orchestration health from day
   one; feed usage facts into the Phase 4 budget seam.

**Non-goals.**

- No orchestration decisions or event writing (Phase 4 sole writer of
  `events`).
- No new LLM-boundary machinery (reuses Phase 5 end to end).
- No schema or event catalog revisions (frontier report and
  `UsageRecorded` already exist).
- No implementation-agent / worktree concerns (Phase 7).

## 2. Frontier Review

source: V2 section 6.7; Phase 4 workflow steps 6–7; Phase 5 turn catalog

### 2.1 Placement and trigger

Runs only after the objection gate passes (Phase 4 phase
`iteration_cap_check` → `frontier_review`). Input: final proposal and
**full** objection history (including resolved and waived), so the
frontier reviewer sees what was already litigated. Output: Phase 1
`FrontierResultSchema`:

```ts
{ role: "frontier", readiness: "ready" | "not_ready", risks: string[], questions: string[] }
```

Natural-language fields (`risks`, `questions`) are untrusted data per
Phase 5 marking rules.

### 2.2 Turn mechanics

Standard turn protocol via Phase 5:

- Role prompt `frontier` / turn type `frontier_report` (already in the
  Phase 5 registry).
- Objection history rendered as quoted-evidence blocks with per-turn
  sentinel nonce (Phase 5 §3.4).
- Validation + single bounded repair as usual.
- **Frontier `TurnFailed` escalates to the human** — a failed frontier
  review never silently passes the gate. Orchestration maps failure to
  Phase 4 `escalated` + `NotificationSink.notifyEscalation`.

### 2.3 Role posture

Detect remaining engineering uncertainty and **attack the consensus**
rather than bless it (V2 sections 7, 10). The role prompt includes the
false-consensus mitigation rationale (frontier models share training
data and fail together).

### 2.4 Finding conversion

Blocking findings do not stall in the report. Each becomes an ordinary
`ObjectionRaised` through the engine (`raiseObjection`) and re-enters
the objection loop, bounded by the existing iteration cap
(`underIterationCap`). Non-blocking risks and questions flow to the
dashboard frontier summary only.

Phase 4 `reportFrontier(workflowId, blocking)` records
`frontierBlocking` and advances planning; orchestration is responsible
for raising one objection per blocking finding before / as it re-enters
the gate.

### 2.5 Panel mode

Workflow config `frontierPanelSize` (default `1`, Phase 4 §9) declares
one reviewer or an N-reviewer panel. When N > 1:

- Each panel member runs an independent frontier turn.
- **Deterministic contradiction rule** (no LLM adjudicates between
  panel members):
  - Divergent `readiness` verdicts always surface as objections.
  - Mutually exclusive risk claims (same normalized risk key asserted
    and denied, or contradictory severity implications) always surface
    as objections.
- Contradictions are first-class findings converted to objections and
  presented to the human — not summary footnotes.

## 3. Dashboard Read Models

source: V2 section 6.8

### 3.1 Consumption rule

Structured read models only: SQLite projections, TOON-backed artifacts,
versioned API DTOs. **Never** an LLM call. **Never** raw chat prose as
data.

### 3.2 Read-model catalog

| Model | Primary fields | Source | Refresh trigger |
|---|---|---|---|
| Workflow summary | workflowId, phase, iterationCount, caps, spendTotal, degradedMode | `workflows` + folded state / events | on event dispatch / poll |
| Open objections | id, severity, status, claim (untrusted), clusterId? | `objections` + merge projection | on `ObjectionRaised` / resolve / waive |
| Resolved objections | same + resolution text | `objections` + decisions | same |
| Cluster view | clusterId, member IDs, member-max severity | recomputed Phase 5 projection (not a table) | after merge turn |
| Decisions | decisionId, chosen, reason (untrusted), provenance IDs | `decisions` | on decision write |
| Timeline | sequence, kind, occurredAt, correlation | `events` | outbox / poll |
| Cost summary | spendTotal, token totals, pricing versions | `usage_ledger` + folded spend | on ledger write / `UsageRecorded` |
| Frontier report view | readiness, risks, questions, turn artifact refs | last validated frontier result artifact | after frontier turn |
| Escalation view | reason, openObjectionIds, paused phase | folded state + last escalation notify | on escalate |

### 3.3 Drill-down chain

source: V2 section 6.8

Every claim is navigable:

```
summary → objection → decision → evidence → transcript reference
```

Link integrity is a **schema property**: each level stores the IDs of
the next. A broken link is a data bug, not a rendering bug. Dashboard
tests assert every rendered ID resolves against the seeded DB.

### 3.4 Transcript references

Phase 3 `artifacts` rows store path + content hash (and kind metadata).

| Concern | Rule |
|---|---|
| Path expiry | Hash lets a moved log be re-verified when rediscovered |
| Local-only access | Dashboard renders the reference (path, hash, size, provider) by default; content only when the file is locally readable |
| Secrets / redaction | §5 policy |
| Retention | Platform stores references/hashes only; retention window governs re-read sweeps (§5) |

### 3.5 Untrusted rendering

Every natural-language field is escaped on render. Phase 5
`UntrustedText` (`{ kind: "untrusted"; value }`) is the contract: the
dashboard never interprets, executes, or unescapes marked strings.
Objection claims, decision reasons, frontier risks/questions: quoted
display only.

### 3.6 Human decision surface

Approve, reject, and approval-with-waived-objections (explicit waiver
per open objection — V2 §6.6) post to the Phase 4 engine via
`humanDecision`. The engine emits `HumanApproved` / `HumanRejected`
(and `ConsensusReached` on clean approval). Comments persist to
`human_feedback` (Phase 3).

### 3.7 Stack

React + Vite (V2 section 12). Read-only API over the Phase 3 DB plus
one narrow write endpoint for decisions. DTOs are versioned
(`v<major>`). Anything needing new data is a Phase 3 projection or a
Phase 4 event — never dashboard-side orchestration logic.

## 4. NotificationSink

source: V2 section 6.8; Phase 4 escalation delivery

Phase 4 already requires `NotificationSink.notifyEscalation` for
budget/iteration/fault escalations. Phase 6 owns the richer human-
attention surface and Herdr (or Slack/Discord) implementations.

### 4.1 Interface

```ts
type HumanAttentionKind =
  | "approval_requested"
  | "escalation"
  | "budget_pause"
  | "frontier_failed";

type HumanAttentionRequest = {
  workflowId: string;
  kind: HumanAttentionKind;
  summary: string;
  dashboardDeepLink: string;
  openObjectionIds?: string[];
};

interface HumanNotificationSink {
  notify(request: HumanAttentionRequest): void | Promise<void>;
}
```

The Phase 4 `notifyEscalation` hook is adapted by a thin wrapper that
maps engine escalations into `HumanAttentionRequest` (kind
`escalation` / `budget_pause`). Approval-requested notifies fire when
the workflow enters `await_human` / `human_decision` (Phase 4 steps 8–9).

### 4.2 Herdr implementation

`notification show --sound request` (V2 §6.8). The sink interface keeps
Herdr replaceable; Slack/Discord are future implementations of the same
interface, not new seams.

### 4.3 Delivery semantics

Best-effort and **non-durable by design**. The durable fact is the
workflow's paused / awaiting state in the event log. A missed
notification never loses a decision request: the dashboard shows it; a
**re-notify** command re-emits from current folded state.

## 5. Cost Ledger

source: V2 section 6.10; Phase 3 `usage_ledger`; Phase 4 §5 usage seam

### 5.1 Provider adapters

One versioned adapter per provider (Anthropic, OpenAI, Google AI — V2
§12). Adapters parse session logs found via Phase 2 identity-map
`agent_session_path`. Adapter version is recorded with every parsed
record.

Format drift is expected: an **unparseable log is a logged degradation**
(usage unknown for that session), **never a workflow failure**. Result
files remain the canonical contract (V2 §10).

### 5.2 Extraction fields

source: V2 §6.10 via Phase 3 schema

`usage_ledger` columns consumed / written:

| Field | Role |
|---|---|
| `message_id` | UNIQUE — dedup of replayed / re-read records |
| `cache_tokens` / `input_tokens` / `output_tokens` | recorded separately |
| `cost` | computed from pricing table |
| `pricing_version` | version used for the calculation |
| `wall_clock_ms`, `retry_count`, `repair_count`, `timeout_count`, `startup_ms` | orchestration health |
| `provider`, correlation IDs, `payload_toon`, `recorded_at` | audit |

### 5.3 Flow

1. Adapter parses incrementally (on turn completion and on a sweep
   cadence).
2. Writes `usage_ledger` rows (duplicate `message_id` is a no-op).
3. Submits usage facts through Phase 4 `submitUsage`.
4. Engine dedups by message ID against folded state, appends
   `UsageRecorded`, folds `spendTotal`, and on cap crossing emits
   `BudgetCapReached`, moves to `escalated`, and notifies (V2 §6.10:
   pause and notify, never continue silently).

**Role split (do not conflate):**

| Store | Role |
|---|---|
| `usage_ledger` | audit / reporting |
| `events` (`UsageRecorded`) | enforcement path for `underBudgetCap` |

### 5.4 Pricing tables

Versioned data files. Recomputation never overwrites an existing ledger
row: `usage_ledger.message_id` is UNIQUE, so a same-id re-price is a
no-op. A pricing correction **must** write a new row under a distinct
message ID — `${originalMessageId}@${pricingVersion}` via
`pricingCorrectionMessageId` — so historical cost stays auditable.

Corrections are **audit-only**: they do not emit `UsageRecorded` /
`submitUsage`. Enforcement spend stays the original fold; re-folding the
corrected amount would double-count `spendTotal`.

### 5.5 Health metrics

Wall-clock duration per turn/workflow, retry count, repair count,
timeout count, and agent startup time — sourced from platform events
and turn rows, reported alongside token cost because token cost alone
does not explain orchestration health (V2 §6.10).

## 6. Redaction and Retention Policy

source: V2 section 11 open question 4 (assigned here)

Policy decision (revisable by config; measurement-free by nature):

1. **Transcript content never leaves the machine that owns it.** The
   dashboard renders references (path, hash, size, provider) by default
   and content only when the file is locally readable and the workflow
   is not marked sensitive.
2. **Pattern-based secret scanning** runs before any transcript excerpt
   is rendered or exported. Matches render as redaction markers with a
   count, never the match text. Scanner rules are config, versioned.
3. **Retention.** Transcripts are provider/Herdr-owned files. The
   platform stores references and hashes only. A retention-window
   config governs how long usage-extraction sweeps keep re-reading
   them. Expired references stay valid as audit records (hash proves
   what was referenced).
4. **Export** (any path that copies content off-machine) requires
   explicit human action and runs the same scanner.

## 7. Configuration Surface

| Key | Type | Default | Consuming section |
|---|---|---|---|
| `frontierPanelSize` | positive int | `1` (Phase 4) | §2.5 |
| `frontierRolePromptPin` | `{ id, version }` | Phase 5 frontier pin | §2.2 |
| `frontierProviderModel` | `{ provider, model }` | Phase 5 stub | §2.2 |
| `notificationSink` | `"herdr" \| "noop" \| …` | `"herdr"` | §4 |
| `reNotifyCommand` | string | CLI binding | §4.3 |
| `ledgerSweepCadenceMs` | positive int | `60_000` | §5.3 |
| `pricingTableVersion` | string | pinned at deploy | §5.4 |
| `adapterVersionByProvider` | map | pinned at deploy | §5.1 |
| `secretScannerRulesetVersion` | string | pinned at deploy | §6 |
| `transcriptRetentionWindowMs` | positive int \| null | deploy default | §6 |
| `dashboardBind` | `{ host, port }` | `{ host: "127.0.0.1", port: 8787 }` (API; Vite UI stays on 5173 and proxies `/api`) | §3.7 |
| `sensitiveWorkflowDefault` | boolean | `false` | §6 |

## 8. Test Plan

- **Frontier:** blocking finding → `ObjectionRaised` + re-enter loop;
  iteration cap still binds; frontier `TurnFailed` escalates; panel
  contradiction fixtures (divergent readiness, exclusive risk claims)
  surface as objections; report schema round-trip via Phase 5 fixtures.
- **Dashboard:** projection tests per catalog entry against seeded DBs;
  drill-down link integrity; escaping tests (instruction-shaped and
  HTML/script-shaped objection claims render inert); decision posting
  emits the right events including per-objection waivers; DTO version
  checks.
- **NotificationSink:** fake sink captures requests per kind;
  missed-notification test — workflow remains awaiting and dashboard
  shows the request with zero notifies delivered; re-notify works.
- **Ledger:** recorded session-log fixtures per provider/adapter
  version; duplicate message ID idempotent end-to-end (ledger row + no
  second `UsageRecorded`); pricing-version correction produces new
  audit ledger records without changing enforced `spendTotal`;
  unparseable log degrades without workflow failure;
  cap-crossing integration through Phase 4 `submitUsage` (pause +
  notify); health metrics from a replayed event log.
- **Redaction:** scanner fixtures redact in render/export; sensitive
  flag suppresses content; expired-reference view still shows hash +
  metadata.
- All LLM calls faked via fixtures; no live-model dependence.

## 9. Assigned Open Questions

- **Transcript redaction (V2 §11 q4):** policy recorded in §6
  (references-first, versioned scanner, explicit export). Revisable by
  config; conservative default fails safe.
- **Reviewer pool composition (V2 §11 q3):** owned by Phase 5 (§8); not
  re-opened here. Dashboard may *display* per-reviewer yield metrics
  once persisted, but composition defaults remain Phase 5 config.

## 10. Dependencies and Interfaces

**Depends on.**

- Phase 1: frontier report schema, objection/decision contracts,
  `UsageRecorded`.
- Phase 2: `agent_session_path` / identity map for session-log access.
- Phase 3: `usage_ledger`, `artifacts`, `human_feedback`, projection
  source tables.
- Phase 4: frontier / human / usage seams, `NotificationSink`,
  `escalated` / `await_human` states.
- Phase 5: builder/validator for frontier turns; `UntrustedText` for
  dashboard escaping.

**Provides to Phase 7.**

- Approval surface that triggers the implementation workflow
  (`HumanApproved` handoff).
- Cost/health metrics covering implementation agents identically (same
  ledger, same adapters).

Completes the V2 §13 MVP loop's human end: plan → review → gate →
human happens through this phase's surfaces.
