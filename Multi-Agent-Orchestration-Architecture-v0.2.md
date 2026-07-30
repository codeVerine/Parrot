# Multi-Agent Orchestration Platform Architecture

**Version:** 0.2 (Draft)

> **Design baseline, not live reference.** Phases 1-12 were derived from this
> draft, but implementation has since added resume, codebase evidence,
> stalemate/guardrail escalation, proposal-diff frontier re-invocation, portable
> CLI entrypoints, and worktree-backed implementation/verification. See
> `docs/ARCHITECTURE.md` and `docs/phases/README.md` for current state.

**Changes from 0.1:** Incorporates verified Herdr 0.7.3 (protocol 16) capabilities, replaces numeric consensus with objection tracking, replaces pane reading with turn-scoped TOON result artifacts, adds durable event log, defines the turn protocol, merges the Decision Engine into the Workflow Engine, and resolves most of the v0.1 open questions.

## 1. Vision

This document describes an architecture for a multi-agent software
engineering platform built on top of Herdr.

The objective is **not** to automate coding, but to automate the
repetitive coordination work between AI agents while keeping a human
engineer responsible for the final architectural decisions.

Primary goals:

- Remove manual copy/paste between agents.
- Preserve design continuity where it helps (planner) and enforce
  independence where it helps (reviewers).
- Minimize LLM cost by separating orchestration from reasoning.
- Escalate to frontier models only when necessary.
- Present humans with concise engineering decisions instead of raw
  transcripts, while keeping transcripts available as audit evidence.
- Keep the system modular so Herdr can later be replaced if required.

---

# 2. Design Principles

## Deterministic orchestration

Workflow execution is deterministic. Waiting, retries, routing, state
transitions, persistence, and dashboard generation never require an
LLM. LLMs are called only for semantic reasoning, and every LLM
boundary produces schema-validated TOON unless an external contract
requires another format.

## Result artifacts over runtime status

Pane output and runtime status are observability hints, not
orchestration inputs. For Claude Code, Codex, and Gemini, Herdr status
derives from screen-manifest heuristics even with integrations
installed. Orchestration consumes turn-scoped, schema-validated TOON
artifacts written by agents to known paths. Provider session logs are
retained as audit evidence and parsed only by versioned adapters.

## Event-driven with deadline fallback

The platform never polls agent status. Herdr pushes events; the
workflow reacts. However, events are treated as a best-effort signal:
every turn carries a deadline timer, and a missed deadline synthesizes
an `AgentTimedOut` event. After any reconnect, the adapter reconciles
state via `session.snapshot` and `agent.list` before resuming.

## Persistent planner, ephemeral reviewers

The planner maintains a long-lived session because it benefits from
accumulated decision context. Reviewers are spawned fresh for each
review round. A reviewer receives the current proposal, requirements,
open objections, and resolution evidence, but never its own earlier
verdicts. This avoids anchoring bias and keeps review context small
and cheap.

## Persist then dispatch

SQLite is the source of truth. Every platform event is appended to the
event log in the same transaction as the state change that caused it.
In-process dispatch exists only to wake workers; replay and recovery
always read from the log. Herdr subscriptions have no replay cursor,
so nothing durable may depend on having observed a live Herdr event.

## Human remains architect

Humans approve important decisions. The platform filters information
instead of replacing engineering judgement, and every summary links
back to its underlying evidence.

---

# 3. Verified Herdr Facts (0.7.3, protocol 16)

These facts are load-bearing for the design and were verified against
the local binary (`herdr api schema --json`) and herdr.dev docs.

**Agent status.** Herdr status schemas include `idle | working | blocked
| done | unknown`. The platform's canonical orchestration states are
`idle | working | blocked | unknown`; `done` is treated as a
presentation-level concept with undocumented semantics. Orchestration
must not depend on `done`. The adapter stores the raw Herdr status for
audit/debugging, but normalizes runtime status before it reaches workflow
guards. `done` is treated only as a completion candidate, equivalent to
an idle-like hint; it never completes a turn without the matching result
artifact.

**Integration authority.** Herdr distinguishes two integration
categories (herdr.dev/docs/integrations/):

| Category | Agents | Effect |
|---|---|---|
| Lifecycle authority | Pi, OMP, Kimi, OpenCode, Kilo, Hermes, MastraCode | Hooks author `idle`/`working`/`blocked` |
| Session identity only | Claude Code, Codex, Copilot, Devin, Droid, Qoder, Cursor | Hooks report session references for restore; state comes from screen-manifest detection |

Claude Code and Codex are session-identity integrations. Gemini has no
integration at all. For this platform's agent roster, runtime status is
always heuristic. Integrations are mandatory for production operation
because session identity (`agent_session_id`, `agent_session_path`)
enables restore and audit access to provider session logs.

**Events.** `events.subscribe` pushes 23 event types including
`pane_agent_status_changed`, `pane_exited`, and worktree lifecycle
events. There is no cursor, replay, or documented disconnect recovery.
`session.snapshot` provides full current state for reconciliation.

**Waits.** `events.wait`, `pane.wait_for_output`, and
`agent wait --status` all accept `timeout_ms`. Defaults are
undocumented; the platform always passes explicit timeouts.

**Worktrees.** Native `worktree create/open/remove` API with matching
events.

**Notifications.** `notification show` with sound and position options.

**License.** Herdr is dual-licensed: AGPL-3.0-or-later and commercial.
The platform communicates with Herdr only over the socket API and does
not embed or modify it. This boundary is recorded deliberately; obtain
a legal interpretation before distributing or operating a modified or
embedded derivative.

**Version pinning.** The adapter checks the protocol version at startup
and refuses to run on an untested protocol. It also runs a full
`herdr integration status` and, outside explicit development mode,
verifies that required integrations are installed (not merely up to
date).

---

# 4. High Level Architecture

                         Herdr
                           │
                    Socket API / CLI
                           │
                 Herdr Runtime Adapter ──── result files (fs watch)
                           │
                  Durable Event Log (SQLite)
                           │
                   Workflow Engine (state machine + guards)
                           │
            ┌──────────────┼──────────────┐
            │              │              │
      Prompt Builder  Extraction &   Objection
                      Validation      Engine
            │              │              │
            └──────────────┼──────────────┘
                           │
                   Frontier Review
                           │
                      Dashboard
                           │
                         User

The v0.1 Decision Engine is gone as a component: it was a set of
deterministic guard conditions and now lives inside the Workflow
Engine's state machine.

---

# 5. The Turn Protocol

Every agent interaction is a turn with a stable identity:
`workflowId / iterationId / turnId`. Filesystem layout mirrors this:

    runs/<workflowId>/<iterationId>/<turnId>/
      prompt.md        (immutable, hash-identified)
      result.toon      (written by the agent)
      repair-prompt.md (only if repair was needed)

Protocol:

1. **Prompt Builder** writes the full prompt to `prompt.md`. Large
   content never travels through terminal input. The file is immutable
   and identified by content hash. Paths are scoped per turn with
   restrictive permissions so one turn cannot overwrite another's
   artifacts. Each turn also receives a random nonce that must be echoed
   in the result envelope.
2. **Adapter** sends one short instruction via `agent.send`: read the
   prompt file, respond by writing `result.toon` at the given path,
   matching the given output schema. `send` returns a
   `DeliveryReceipt` correlated to the turn.
3. Agents write results atomically: write `result.tmp`, fsync/close if
   available, then rename to `result.toon`. Partial files are ignored.
   The result envelope includes `workflowId`, `iterationId`, `turnId`,
   `schemaVersion`, and the turn nonce. A result whose envelope does not
   match the active turn is rejected.
4. **Adapter** watches for `result.toon` (fs watch), subscribes to
   `pane_agent_status_changed` as an accelerator hint, and starts the
   turn deadline timer.
5. `result.toon` appears: the adapter rejects symlinks, unexpected file
   ownership, world-writable artifact directories, stale mtimes, path
   escapes, and oversized files before parsing. The artifact hash is
   recorded before validation. **Extraction & Validation** parses TOON
   into structured data and validates it with Zod. On failure, exactly
   one bounded repair prompt is sent. A second failure emits
   `TurnFailed`.
6. A `working → idle` or `working → done` transition without a result
   file triggers an early result check, then a short grace timer, then
   `TurnFailed`. It is a completion candidate, never proof.
7. Deadline expiry emits `AgentTimedOut`.
8. Cancellation and interrupt paths move the turn to `cancelled` or
   `timed_out`; any later result becomes an orphan artifact and cannot
   satisfy a retry.
9. Completion is correlated by turn path, envelope, nonce, and artifact
   hash, never by status transition
   alone, so retries, reconnects, and delayed events cannot satisfy the
   wrong request.

Provider session logs (via `agent_session_path`) are parsed only by
versioned provider adapters, for two purposes: audit transcripts and
usage extraction. They are never the canonical data channel, because
their formats are provider-owned and change independently of Herdr.

Trust boundary: agent-written files are treated as untrusted input even
when the process runs as the same OS user. The platform owns artifact
directory creation, path canonicalization, permission checks, size
limits, and hash capture. For higher-trust deployments this is adequate;
for hostile or multi-tenant agents the same protocol must run inside
per-agent sandboxes or separate OS identities.

---

# 6. Components

## 6.1 Herdr Runtime Adapter

Abstracts Herdr behind a runtime interface. No other component knows
Herdr-specific APIs.

``` ts
interface AgentRuntime {
  start(spec: AgentSpec): Promise<AgentHandle>
  send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt>
  wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal>
  result(id: AgentId, turnId: TurnId): Promise<TurnResult>
  onStatus(handler: (e: StatusEvent) => void): void
  resync(): Promise<AgentStatus[]>
  interrupt(id: AgentId): Promise<void>
  stop(id: AgentId): Promise<void>
}
```

Responsibilities:

- Startup checks: protocol version, full integration status, required
  integrations present. Production mode refuses to run without required
  integrations. Development mode may continue without them, but disables
  restore guarantees and marks all session-log features as unavailable.
- Identity mapping: Herdr speaks `pane_id`/`workspace_id`; the platform
  speaks `agentId`/`workflowId`. Panes die and respawn, so `pane_id` is
  never used as agent identity. The adapter owns the mapping table.
- Reconnect reconciliation via `session.snapshot` + `agent.list`.
- Turn deadline timers and `AgentTimedOut` synthesis.
- Result-file watching and delivery.
- Raw status normalization: Herdr `done` is preserved in runtime signal
  metadata but reduced to a non-authoritative idle-like completion hint
  before any workflow guard sees it.

There is no `read()` in the orchestration interface. Pane text is a
display and debugging concern only.

## 6.2 Durable Event Log

The log separates external observations from platform decisions:

- **Runtime signals** are raw or synthetic observations from Herdr, file
  watchers, deadline timers, and reconnect reconciliation. Examples:
  `HerdrStatusChanged`, `ResultFileSeen`, `DeadlineExpired`,
  `SnapshotReconciled`.
- **Platform events** are deterministic workflow facts derived from
  state plus runtime signals. Examples: `TurnCompleted`,
  `ObjectionRaised`, `ConsensusReached`, `HumanApproved`,
  `AgentTimedOut`.

Platform events are appended to SQLite in the same transaction as the
state change that caused them (transactional outbox). Runtime signals are
also persisted with provenance, but are never treated as workflow facts
until reduced by the state machine. Consumers are idempotent; every event
carries a unique ID and correlation IDs (`workflowId`, `iterationId`,
`turnId`, `agentId`). Replay folds the log. In-process dispatch only
wakes workers.

## 6.3 Workflow Engine

A deterministic state machine (XState or equivalent) with guard
conditions. Guards consume workflow state, objection status, and human
rules. It never analyses code and never calls an LLM.

Turn states are explicit so retries and late artifacts remain safe:

    created → sent → waiting → result_seen → validating
      → completed
      → repair_sent → waiting
      → failed | timed_out | cancelled

A result observed after `failed`, `timed_out`, or `cancelled` is recorded
as `orphan_result_seen` and linked to the original turn for audit, but it
cannot advance the workflow or satisfy a retry.

Example planning workflow:

1. Planner turn completes with a proposal.
2. Spawn fresh reviewers; send review turns.
3. Collect reviewer objections (all rounds bounded by deadlines).
4. Objection Engine merges and dedupes.
5. Guard: any open `blocking` objections → send objections to planner,
   next iteration (bounded by max iteration count).
6. Guard: none open → frontier review turn.
7. Frontier blocking findings convert to objections → back to step 5.
8. Otherwise generate dashboard, request human decision, notify.
9. Human approval triggers the implementation workflow.
10. Iteration cap or budget cap reached → escalate to human with the
    open objection list. Never loop silently.

## 6.4 Prompt Builder

Constructs prompts as immutable, hash-identified files (see turn
protocol). Injects role prompts, current proposal, open objections, and
evidence. Role prompts are versioned, and every turn records which
prompt version produced its output. Trims by construction rather than
by history editing: reviewers get fresh context every round, so context
explosion cannot occur on the review path.

## 6.5 Extraction & Validation

Owns every LLM output boundary. TOON is the default artifact format for
agent results and local workflow artifacts; Zod schemas validate the
parsed data for each artifact type. One bounded repair attempt, then
`TurnFailed`. No markdown, JSON, or free text ever crosses an internal
LLM boundary. Natural-language fields inside TOON are still treated as
untrusted data: prompt builders quote them as evidence, dashboards
render them with escaping, and no downstream prompt may paste reviewer
prose as executable instruction text.

## 6.6 Objection Engine

Replaces the v0.1 numeric consensus. Consensus scores from LLMs are
uncalibrated pseudo-precision; routing on them is routing on noise.
Instead, reviews produce structured objections:

``` toon
id: OBJ-042
dimension: performance
severity: blocking
claim: The 2000ms buffer causes visible latency on seek.
evidence[2]: "src/player/buffer.ts:120","requirement REQ-14"
status: open
raisedBy: reviewer-codex
turnId: ...
```

``` ts
type ObjectionSeverity = "blocking" | "major" | "minor";
type ObjectionStatus =
  | "open" | "accepted" | "rejected"
  | "superseded" | "resolved" | "waived";
```

Severity is not free-form reviewer taste. Review prompts and validators
use this rubric:

| Severity | Meaning |
|---|---|
| `blocking` | Violates a hard requirement, creates credible security/data-loss risk, makes the plan infeasible, or leaves a core claim untestable. |
| `major` | Likely causes meaningful rework, missed edge cases, operational fragility, or degraded user-visible behavior, but does not invalidate the plan. |
| `minor` | Local improvement, wording issue, optional simplification, or polish that should not block approval. |

Rules:

- Objections require evidence (code references, requirement references,
  reproduction steps) or an explicit `evidence_missing` marker.
- The consensus gate is deterministic: zero open objections of any
  severity. Human approval may still waive open objections explicitly,
  but that path is approval-with-objections, not consensus.
- Confidence values may be attached as metadata but never close an
  objection and never satisfy a gate.
- The planner must respond to objection IDs; a reviewer (fresh session)
  verifies each resolution. This makes the debate loop convergent and
  auditable instead of a vague re-agreement check.
- Merging and deduplication of near-identical objections is a cheap LLM
  call, validated like any other turn, but it is non-destructive. The
  system forms objection clusters, preserves every original objection ID
  and evidence link, and uses the maximum severity in the cluster unless
  a deterministic rule or human waiver lowers it.

Mitigating false consensus (frontier models share training data and
fail together): at least one reviewer runs an adversarial role prompt
whose task is to falsify assumptions, not to produce contrary prose,
under the same evidence requirements.

## 6.7 Frontier Review

Runs after the objection gate passes. Input: final proposal and
objection history. Output (TOON): implementation readiness,
remaining risks, questions for the human, executive summary. Blocking
findings do not stall in the report; they convert to objections and
re-enter the loop, bounded by the iteration cap. Contradictions between
frontier reviews are themselves presented to the human as objections.
The workflow config declares whether frontier review is one reviewer or
an N-reviewer panel; if N > 1, contradictions are first-class findings,
not summary footnotes.

## 6.8 Dashboard

Consumes structured read models only; never depends on an LLM. The
dashboard may render TOON-backed artifacts, SQLite projections, or API
DTOs, but it never consumes raw chat prose as data. Shows summary, open
and resolved objections, decisions, timeline, cost, and approve/reject
with comments. Every claim supports drill-down along the durable chain:

    summary → objection → decision → evidence → transcript reference

Transcript references store path plus content hash, and account for
path expiry, local-only access, secrets, retention, and redaction.
Human approval requests are pushed through a `NotificationSink`
interface; the Herdr implementation uses
`notification show --sound request`, but the sink keeps Herdr
replaceable and allows Slack/Discord later.

## 6.9 Persistence

SQLite (WAL mode) as source of truth. Tables:

- workflows, iterations, turns
- runtime_signals
- events (append-only log)
- agents (identity mapping, session references)
- requirements
- objections, decisions, human_feedback
- artifacts (prompt/result paths + hashes)
- usage_ledger

Where persistence needs opaque structured payloads, TOON is preferred
over JSON unless the database, API boundary, or integration requires
JSON. File-backed workflow state, approval metadata, and import/export
artifacts use `.toon` by default.

Requirements are first-class because objections and decisions depend on
stable references. Imported requirements store source path, content
hash, priority, and external identifier when available.

## 6.10 Cost Ledger

Cost is a stated goal, so it is measured from day one. Versioned
provider adapters parse session logs for usage: message IDs for
deduplication of replayed records; cache, input, and output tokens
recorded separately; the pricing version used for each cost calculation
stored alongside. Per-workflow budget caps pause the workflow and
notify the human rather than silently continuing. The ledger also tracks
wall-clock duration, retry count, repair count, timeout count, and agent
startup time, because token cost alone does not explain orchestration
health.

---

# 7. Agent Roles

## Planner (persistent)

Claude or similar. Creates and revises the implementation strategy.
Long-lived Herdr session; restored via native session identity. The
planner periodically receives a compacted state prompt generated from
the database rather than relying indefinitely on transcript memory; this
preserves continuity without letting stale assumptions accumulate.

## Reviewers (ephemeral)

Codex, Gemini, or similar. Spawned per round via `agent start`,
destroyed after. Receive proposal, requirements, open objections, and
resolution evidence only. At least one runs the adversarial role.
Critique correctness, performance, maintainability, edge cases, with
evidence requirements as above.

## Frontier Reviewer

Invoked only after the objection gate. Detects remaining engineering
uncertainty and attacks the consensus rather than blessing it.

## Implementation Agents

Receive the approved plan. Worktree isolation is mandatory for
concurrent writing agents and configurable for single-agent work.
Herdr's worktree API handles creation, but the platform owns branch
naming, cleanup, dependency bootstrap, port allocation, merge ordering,
conflict handling, and shared external resources.

Implementation agents never redesign architecture silently. When a plan
proves ambiguous or infeasible, they emit `ImplementationBlocked` with
a structured deviation request, which routes to the planner or the
human by workflow rule. Challenging the architecture is allowed only
through this escalation path.

---

# 8. Structured Decisions

Store decisions, not chat logs (transcripts remain as audit evidence,
referenced by hash):

``` toon
decision: Buffer size
chosen: 2000ms
alternatives[2]: 500ms,1000ms
reason: Reduced underruns.
confidence: 0.96
provenance:
  workflowId: ...
  turnId: ...
  objections[1]: OBJ-042
```

Decisions carry provenance: which agent, which iteration, which
objections they resolved, and links to evidence. This makes them
searchable, auditable, dashboard-friendly, and reusable, and lays the
foundation for a long-term organizational knowledge base.

---

# 9. Why Not Use an LLM as the Manager?

An LLM manager would consume unnecessary tokens, introduce
non-determinism, be harder to debug, and make retries unpredictable.
Deterministic software performs orchestration; LLMs perform reasoning
only. Where a step genuinely requires semantic judgement (objection
deduplication, review, frontier analysis), it is an explicit,
schema-validated LLM call owned by a component, never an implicit
management decision.

---

# 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Infinite debate loops | Objection lifecycle + iteration cap + escalation to human with open objection list |
| Context growth | Ephemeral reviewers, prompt files built from state (not history), persistent planner only |
| Reviewer bias / anchoring | Fresh reviewer sessions per round; reviewers never see their own past verdicts |
| False consensus | Adversarial reviewer role, evidence requirements, frontier review prompted to attack |
| Status misdetection | Result artifacts as the completion signal; status is a hint; deadlines everywhere |
| Event loss (Herdr has no replay) | Persist-then-dispatch log; snapshot reconciliation on reconnect |
| Agent hang (no event ever fires) | Per-turn deadline timers, synthesized `AgentTimedOut` |
| Duplicate/out-of-order events | Unique event IDs, idempotent consumers, correlation by turnId |
| Provider format drift | Session logs parsed only by versioned provider adapters; result files are the contract |
| Cost runaway | Usage ledger + per-workflow budget caps |
| Screen-manifest drift after agent UI updates | Herdr manifest updates (`manifest_check`), plus the platform's independence from status accuracy |
| Artifact tampering or stale result files | Nonce-bound result envelopes, atomic writes, canonical path checks, hashes before parse, late results recorded as orphans |
| Prompt injection through structured TOON fields | Treat natural-language fields as quoted evidence, escape dashboard rendering, never paste reviewer prose as instructions |
| Replay/recovery divergence | Persist runtime signals and platform events separately; recovery tests kill/restart mid-turn and require the same folded state |
| Missing integrations in local development | Production fails closed; explicit development mode can run with restore/session-log features disabled |

---

# 11. Resolved Questions (from v0.1)

1. **How should consensus be measured?** Not by scores. Zero open
   objections of any severity, with objection lifecycle tracking.
2. **Independent or sequential reviewers?** Independent first round to
   avoid anchoring; later rounds see the merged objection state to
   converge.
3. **All reviewer feedback or merged?** Planner receives merged,
   deduplicated objections. Raw feedback amplifies context growth and
   noise.
4. **Contradictory frontier reviews?** Contradictions become objections
   and are surfaced to the human; they never gate silently.
5. **Can implementation agents challenge architecture?** Only via
   `ImplementationBlocked` escalation with a structured deviation
   request. Never silent workarounds.
6. **Human intervention threshold?** Any of: iteration cap reached with
   open objections, budget cap reached, frontier review flags,
   or explicit `AgentBlocked`/`ImplementationBlocked` without a rule.
7. **Decisions as long-term knowledge base?** Yes; the provenance model
   in §8 is designed for it. Cross-project reuse remains future work.

## Remaining Open Questions

1. Objection deduplication quality: how aggressively to merge without
   losing distinct concerns?
2. Concurrency limits: how many workflows/agents per machine before
   Herdr session management degrades?
3. Reviewer pool composition per task type.
4. Redaction policy for transcripts referenced by the dashboard.

---

# 12. Technology Stack

- Runtime: Herdr (pinned version; protocol check at startup; note
  dual AGPL/commercial license, socket-API boundary only)
- Language: TypeScript, Node.js
- Database: SQLite (WAL), Drizzle ORM
- Event log: SQLite table + transactional outbox (in-process dispatch
  wakes workers; NATS/Redis only if multi-process becomes real)
- State machine: XState
- Validation: Zod (every LLM boundary)
- Dashboard: React + Vite
- LLM providers: Anthropic, OpenAI, Google AI (versioned adapters for
  session-log parsing and usage extraction)
- Deployment: Docker

---

# 13. Next Phase (contracts first)

The contracts are the architecture. Define, in order:

1. Event schema (platform events, IDs, correlation fields).
2. Turn artifact contracts: prompt file header, TOON result schemas per role
   (proposal, review/objections, frontier report), repair protocol.
3. Objection and decision schemas (this document's §6.6 and §8 as the
   starting point).
4. Workflow state machine definition with guards.
5. Herdr adapter contract against protocol 16, including startup
   checks and identity mapping.
6. Dashboard read-model schema.
7. MVP roadmap: one workflow (plan → review → gate → human) with two
   agents, end to end, before any generalization.
