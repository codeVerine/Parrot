# Parrot User Interface Plan (iteration 2)

Based on `Multi-Agent-Orchestration-Architecture-v0.2.md` (version 0.2) and the current MVP in `src/`. Revises the iteration 1 plan to resolve OBJ-001 (read-model contract ordering) and OBJ-002 (gate compare-and-set primitive).

## 1. Context and Constraints

The architecture defines hard constraints that shape every UI decision:

- The Dashboard "consumes JSON only; never depends on an LLM" (section 6.8). All UI surfaces are pure renderers over structured state.
- The human remains the architect: the UI's job is to present concise engineering decisions, not raw transcripts, while keeping transcripts reachable as audit evidence.
- Every claim must support drill-down along the chain: summary -> objection -> decision -> evidence -> transcript reference.
- Natural-language fields inside JSON are untrusted. Every UI surface must escape them and never render them as markup or instructions.
- Human approval requests flow through a `NotificationSink` abstraction (Herdr `notification show` today, Slack/Discord later).
- The declared stack already picks React + Vite for the dashboard and TypeScript/Node for everything else.

Current reality: Parrot is a `tsx`-launched CLI (`pnpm orchestrate`) with a blocking human gate after each review round, state in `runs/<runId>/state.json`, and no SQLite yet. The UI plan therefore has two surfaces, sequenced so each phase is useful on its own:

1. A polished CLI, because that is how the orchestrator is driven today and will remain the operator surface.
2. A local web dashboard, because objection lists, timelines, and evidence drill-down outgrow a terminal quickly.

A full TUI (blessed/ink style) is deliberately rejected: it duplicates the dashboard's job at higher cost, and Herdr already owns the terminal multiplexing experience. The CLI stays line-oriented and script-friendly; anything visual goes to the dashboard.

## 2. Read Model First (resolves OBJ-001)

The shared read model is the foundation of both surfaces, so it moves to the front of the plan and the front of Phase 1. Before any CLI subcommand is implemented, `src/readmodel.ts` defines Zod schemas for every document a UI can consume:

- `RunSummary`: id, task first line, state (`running | gate_pending | approved | rejected | failed`), iteration count, open objection counts by severity, startedAt, updatedAt.
- `RunDetail`: RunSummary plus iterations, each with its turns (role, state, artifact paths and hashes, timestamps, repair count) and gate outcomes.
- `ObjectionView`: the section 6.6 objection object plus status history entries (`{ status, turnId, at }`) and raising/resolving turn references.
- `TurnView`: turn identity, prompt path and hash, result path and hash, validation outcome, repair attempts, timestamps.
- `GateRequest`: runId, iteration, requestedAt, summary, open objection ids grouped by severity, resolving commands.
- `GateResolution`: decision (`approved | rejected`), comment, resolvedBy (`cli | dashboard`), resolvedAt.

Rules:

- These schemas are the only data contract. CLI `--json` output parses its own response through the schema before printing (cheap self-check, catches projection drift immediately). The Phase 2 HTTP API returns the same documents byte-for-byte.
- Schemas carry a `schemaVersion` field from day one, matching the result-envelope convention in the turn protocol (architecture section 5).
- The projection code that derives these documents from `runs/<runId>/state.json` lives beside the schemas and is the single reader used by both the CLI and, later, the dashboard server. When SQLite (architecture 6.9) lands, only this projection layer changes.

This ordering directly resolves OBJ-001: Phase 1 implementers receive the contract before implementing `--json`, and CLI/dashboard drift is prevented structurally because Phase 2 imports the identical schemas rather than re-deriving them.

## 3. CLI Design

### 3.1 Command structure

Replace the single `pnpm orchestrate` entry with a `parrot` command (still `tsx`-backed, exposed via a `bin` entry) using subcommands:

```
parrot run [--task <file|->] [--max-iterations N] [--auto-open]
parrot status [<runId>] [--json]
parrot runs [--json]
parrot objections [<runId>] [--open|--all] [--json]
parrot show <runId> <iteration> <role>        # prints prompt/result paths and summary
parrot approve <runId> [--comment "..."]
parrot reject <runId> --comment "..."
parrot dashboard [--port 4780]
```

Rules:

- Every read command accepts `--json` and emits the exact read-model documents from section 2. Human-readable output is a rendering of the same document, never a separate query path.
- Human-readable output goes to stdout, diagnostics to stderr, and exit codes are meaningful: 0 success, 1 failure, 2 gate pending, 3 validation/repair failure. This lets shell automation and CI wrap Parrot without parsing prose.
- Color via a tiny helper gated on `process.stdout.isTTY` and `NO_COLOR`. No color library dependency needed at this scale.

### 3.2 Live run output

`parrot run` renders a compact, append-only event line per state transition rather than a spinner-driven screen (append-only survives scrollback, copy/paste, and CI logs):

```
19:43:12  run 20260717-194338  iter 1  planner   sent        prompt 4.1 KB
19:44:03  run 20260717-194338  iter 1  planner   completed   plan.md written
19:44:05  run 20260717-194338  iter 1  reviewer  sent
19:45:22  run 20260717-194338  iter 1  reviewer  completed   2 objections (1 blocking)
19:45:22  run 20260717-194338  iter 1  gate      waiting     parrot approve 20260717-194338
```

Each line: timestamp, correlation identity, state, one factual detail. Severity gets color when TTY: blocking red, major yellow, minor dim. The gate line always prints the exact command to continue, so the operator never has to remember syntax.

### 3.3 Human gate: durable request, exclusive-create resolution (resolves OBJ-002)

The current design blocks the orchestrator process on the gate. Keep the blocking behavior as the default interactive mode but make the gate state durable and addressable, with a real first-writer-wins primitive:

**Gate request.** When a round completes, the orchestrator writes `runs/<runId>/gate/<iteration>/request.json` (a `GateRequest` document, written with the existing tmp+rename helper) before notifying. The gate is then resolvable from any terminal or from the dashboard.

**Gate resolution: exclusive create, not rename.** OBJ-002 is correct that tmp+rename is atomic replacement, not compare-and-set: two writers both succeed and the last rename wins. Resolution therefore uses a different primitive:

- Resolving a gate means creating `runs/<runId>/gate/<iteration>/resolution.json` with the POSIX exclusive-create flag: `fs.writeFile(path, json, { flag: "wx" })` (O_CREAT | O_EXCL). The kernel guarantees exactly one creator; every other attempt fails with `EEXIST` regardless of timing.
- On `EEXIST`, the losing surface reads the existing `GateResolution` and reports "already resolved: approved by dashboard at 19:52:10". No retry, no overwrite path exists in the code.
- The resolution file is written in full in the single exclusive-create call (these documents are well under one page), so there is no torn-write window between create and content. The orchestrator additionally validates the file against the `GateResolution` schema before acting; an unparseable resolution is a hard error surfaced to the human, never silently ignored.
- One resolution file per iteration (path includes the iteration) so a stale approve against an earlier round cannot resolve a later gate: `parrot approve` resolves the gate identified by the current `request.json`, and the orchestrator only honors a resolution whose path matches the iteration it is waiting on.
- Scope note: O_EXCL is a same-filesystem, local-process guarantee, which matches Parrot's single-machine design. If gates ever move to a shared store (SQLite per architecture 6.9), the primitive becomes a conditional INSERT with a unique constraint on (runId, iteration), preserving identical first-writer-wins semantics.

**Interactive mode.** When `stdin.isTTY`, `parrot run` also offers an inline prompt: `[a]pprove / [r]eject / [o]bjections / [q]uit (keeps gate open)`. `o` prints the open objection table without leaving the prompt. Inline approval goes through the same exclusive-create path as `parrot approve`, so it cannot race the dashboard either.

**Rejection requires a comment.** `parrot reject` requires `--comment` because a rejection without guidance gives the planner nothing to iterate on; the comment is injected into the next planner prompt as quoted human feedback. Approval and rejection append a `HumanApproved` / `HumanRejected` record into state, preserving the decision provenance model of architecture section 8.

### 3.4 Objection rendering

`parrot objections` prints a table designed around the objection schema in architecture 6.6:

```
ID       SEV       STATUS    DIM           CLAIM (truncated 80 cols)         EVIDENCE
OBJ-042  blocking  open      performance   The 2000ms buffer causes visi...  2 refs
OBJ-043  minor     resolved  style         Naming inconsistency in the a...  1 ref
```

`parrot objections --json` emits `ObjectionView` documents. A `parrot show`-style detail view prints one objection with full claim, every evidence reference, status history, and the turn that raised it. Claims are printed as plain text with control characters stripped; this is the CLI's escaping duty for untrusted fields.

## 4. Web Dashboard

### 4.1 Architecture

- `parrot dashboard` starts a small Node HTTP server (Fastify or bare `node:http`; no framework requirement at this size) serving the built Vite/React app plus a read-only JSON API on localhost.
- The API serves the section 2 read-model documents produced by the same projection layer the CLI uses. It performs no other writes than gate resolution (see 4.4). Server-Sent Events push state changes to the browser; SSE is chosen over WebSocket because the data flow is one-directional and SSE reconnects trivially.
- The React app is static, has zero external network dependencies, and renders untrusted strings only through React's default text escaping. No `dangerouslySetInnerHTML`, no markdown rendering of agent prose in v1. If markdown rendering is added later it must go through a sanitizer with a strict allowlist.

### 4.2 Pages

1. **Runs list** (home). Table of `RunSummary` rows: id, task summary, state, iteration count, open blocking count, started/updated timestamps. Gate-pending rows are visually loud; that is the state where a human is the bottleneck.
2. **Run detail**. Three-panel layout:
   - Left: iteration timeline. Each iteration node shows planner turn, reviewer turns, gate outcome. Current position highlighted.
   - Center: the current proposal summary and the objection board, grouped by status (open first, ordered by severity), each card showing id, severity chip, dimension, claim, and evidence links.
   - Right: detail pane for whatever is selected (objection, turn, decision).
3. **Turn detail** (in the right pane or routed page). Shows the `TurnView`: prompt file path and hash, result summary, validation outcome, repair attempts, timestamps, and raw artifact links that open the actual `prompt.md` / `result.json` content in a read-only viewer. This is the drill-down terminus required by architecture 6.8: summary -> objection -> decision -> evidence -> transcript reference.
4. **Decisions log**. Table of structured decisions (architecture section 8) with chosen option, alternatives, reason, and provenance links back into runs and objections. This page is small now but is the seed of the long-term knowledge base.
5. **Cost / health** (deferred until the usage ledger exists, but reserve the route). Per-run tokens, cost, retries, repairs, timeouts.

### 4.3 Objection board interaction

- Filter chips: severity, status, dimension, reviewer.
- Clicking evidence like `src/player/buffer.ts:120` copies the reference and, when a configured editor URL scheme is present (`vscode://file/...`), opens it. The dashboard never renders file contents from evidence paths directly; it links.
- Objection status history is rendered as a small lifecycle trail (open -> accepted -> resolved) with the turn ids that caused each transition, matching the auditable-convergence rule in architecture 6.6.

### 4.4 Approve/reject from the dashboard

The gate card on the run detail page shows the `GateRequest` summary, open objection counts, and Approve / Reject buttons with a required comment box on reject. This is the only write path in the API, and it calls the same gate-resolution function the CLI uses: exclusive create of `resolution.json` with `flag: "wx"` (section 3.3). On `EEXIST` the API returns 409 with the existing `GateResolution`, and the UI shows "already resolved by cli at ...". First writer wins is enforced by the kernel, not by application convention.

### 4.5 Visual language

- Severity is the primary color signal and must be consistent across CLI and dashboard: blocking red, major amber, minor gray. Status uses shape/weight, not color, so severity color is never ambiguous.
- Light and dark themes via `prefers-color-scheme`; monospace only for ids, paths, and hashes.
- Timestamps render relative ("4m ago") with absolute time on hover; correlation ids are always click-to-copy.
- Empty states are written, not blank: a run with zero open objections says "No open objections. Gate is deterministic: ready for frontier review / human approval."

## 5. Notifications

Implement the `NotificationSink` interface from architecture 6.8 now, with two sinks:

- `HerdrNotificationSink`: current `notification show --sound request` behavior on gate requests and terminal failures.
- `ConsoleNotificationSink`: prints to the orchestrator terminal; used in development mode and tests.

Notification content is one sentence plus the resolving command or dashboard URL: "Run 20260717-194338 iteration 2 needs a decision: 0 blocking, 2 major. parrot approve 20260717-194338". Sinks are fire-and-forget; a notification failure never blocks the workflow.

## 6. Phasing

**Phase 1: Read model + CLI (immediate).** In order: (1) `src/readmodel.ts` Zod schemas and the state.json projection layer, (2) subcommand structure with `--json` backed by those schemas, (3) event-line output, (4) durable gate request + exclusive-create resolution, (5) NotificationSink extraction. The read model is the first deliverable of Phase 1, not a Phase 2 artifact, so every `--json` flag ships with its contract already defined.

**Phase 2: Dashboard server + app (next).** HTTP server with SSE importing the Phase 1 schemas and projection layer unchanged, runs list and run detail pages, objection board, gate approve/reject via the shared resolution function. React + Vite per the declared stack.

**Phase 3: Depth (after SQLite/event log land).** Turn drill-down to artifact viewer with hashes, decisions log page, cost/health page fed by the usage ledger, timeline reconstruction from the durable event log, and migration of the projection layer (only) from state.json to SQLite, including moving gate resolution to a unique-constraint INSERT.

Each phase is shippable alone; nothing in Phase 1 is thrown away by Phase 2 because both import the same schemas and projection code.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Dashboard and CLI resolve the same gate concurrently | Exclusive create (`O_CREAT\|O_EXCL` via `flag: "wx"`) of a per-iteration `resolution.json`; kernel guarantees one winner; losers get `EEXIST` and display the existing resolution |
| Stale approval resolves the wrong round | Resolution path is scoped to the iteration; orchestrator honors only the resolution matching the gate it is waiting on |
| Agent prose used for injection through the UI | React text escaping only, no HTML/markdown rendering of agent fields, CLI strips control characters |
| Dashboard drifts from orchestrator state semantics | Read-model schemas and projection layer built in Phase 1 are imported unchanged by Phase 2; CLI validates its own `--json` output against the schemas |
| Terminal output unusable in CI/scrollback | Append-only event lines, no cursor movement, `NO_COLOR` and TTY detection |
| Dashboard scope creep before persistence exists | Phase gating: drill-down and cost pages wait for SQLite and the ledger |
