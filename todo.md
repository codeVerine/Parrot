# TODO

Prioritized for handoff to an implementation agent. Tiers:

- **P0 - Critical:** active run-killers / data-loss bugs. Do first.
- **P1 - Loop quality:** prevents wasted iterations and burnt provider quota
  (all surfaced by a real run's log review). High value.
- **P2 - Observability & DX:** nice-to-have, non-blocking.
- **Done:** shipped this cycle; kept for context, not for implementation
  (deferred follow-ups called out inline).

Within P1 the order is dependency-aware: root-cause fixes and shared signals
(context injection, proposal diff) come before the items that build on them.

## Suggested implementation order

1. Enter-key submit race (P0) - transport reliability.
2. Adopt-late-result on resume (P0) - salvage completed-but-late turns.
3. Planner cite evidence + engine repo-context injection (P1) - kills the
   hallucinated-API / unbuildable-verifier trap at the root.
4. Hard escalation on objection re-raise (P1) - loop circuit breaker.
5. Structured objection addressal + guardrailConflict escalation (P1).
6. Reviewer cleanRationale (P1) - cheap no-op prevention.
7. Plan churn / oscillation detection (P1) - builds the proposal-diff signal.
8. Re-invoke frontier after restructurings (P1) - reuses the diff signal.
9. Per-turn progress in orchestrator terminal (P2).
10. Lazy / on-demand agent spawning (P2).
11. Portable / global `parrot` command (P2).

---

# P0 - Critical

## Enter key intermittently not submitted (paste/submit race)

**Priority:** P0 - **Status:** implemented.

Before this fix, a prior attempt split the single `pane.send_input {text, keys:["Enter"]}` into two
frames - `pane.send_text` then `pane.send_keys {keys:["Enter"]}`
(`packages/herdr-adapter/src/client/socket.ts:107-117`) - so the Enter lands
outside the bracketed-paste block. This fixed the common case, but the prompt
could still stay in the planner's input box without submitting. Submission now
uses atomic `herdr pane run`; the socket-only fallback verifies the pasted marker
and retries Enter with bounded acknowledgement checks.

**Why P0:** a dropped Enter wedges the entire turn - the agent sits idle with the
prompt unsubmitted until the turn deadline expires. It kills real runs at turn
start and is the single most damaging operational bug.

**Suspected race:** the two frames are independent requests with no guarantee the
agent TUI (Claude Code) has finished ingesting/rendering the pasted block before
the Enter keystroke arrives. If Enter lands while the TUI is still processing the
bracketed paste, it can be absorbed into the paste buffer (or hit an input line
not yet committed), so nothing submits and the agent stays idle. There is also no
acknowledgement that submission actually happened and no retry - a single dropped
Enter wedges the whole turn until its deadline expires. Larger prompts (more paste
to ingest) likely widen the window, so it looks intermittent.

**Wanted:** make submit reliable and self-verifying, not fire-and-forget.

**Notes / implementation sketch:**
- **Settle before Enter:** after `send_text`, wait for the paste to land before
  sending Enter - either a short delay or, better, poll the pane content
  (`pane.read` / `agent.read {target, source:"visible"}`) until the pasted text is
  present in the input line, then send Enter.
- **Confirm submission:** after Enter, verify the input box cleared / the agent
  went busy (read the pane again, or watch for the agent's activity signal). If the
  prompt text is still sitting in the input box, the Enter was dropped.
- **Retry:** if not submitted, re-send `pane.send_keys {keys:["Enter"]}` a bounded
  number of times with a small backoff before giving up, instead of silently
  waiting out the turn deadline.
- Consider whether a trailing newline in the paste vs. a separate Enter, or
  disabling bracketed paste for the send, is more robust per provider TUI.
- Reproduce with a large planner prompt against a real Herdr daemon (the failure is
  size/timing dependent, so a live repro with a big task is the reliable trigger).

## Adopt-late-result on resume

**Priority:** P0 - **Status:** implemented. Follow-up to the shipped idle timeout;
safety net for the Enter-race bug above.

**Problem it fixes:** before this fix, a turn that stayed fully silent until a single end-of-turn
write (like the planner that sat idle on the Enter race, then wrote everything at
once) got no mid-turn activity, so the idle-reset could not save it, and the result
that landed after the cutoff was re-run from scratch on resume - discarding
completed work. Resume now validates the persisted result against its stored turn
identity and adopts it when valid; missing, invalid, or semantically incomplete
results take a fresh bounded verification path. A real run lost a validated planner
result this way.

**Wanted:** when re-entering a `waiting` turn whose `result.toon` now exists and
validates against the stored nonce/turnId, ingest it (re-attach to the same turn id
via the turn engine's validation path) instead of minting a new turn and
re-dispatching. Salvages completed-but-late work.

**Notes:**
- Needs `runTurn` to accept a pre-existing turn identity rather than always calling
  `newId()`; on resume, look up the interrupted turn's stored `nonce`/`turnId`/
  `result_path`, re-extract via `ResultExtractor`, and only re-dispatch if the file
  is missing or fails validation.

---

# P1 - Loop quality (from a real run's log review)

Source: inspection of a real planner<->reviewer<->frontier run that spun for 4
iterations on an OBJ-00x "machine-verifiable parity" debate. The debate was a
design tension (the reviewer demanded machine-verifiable parity while the
guardrails forbade the schema/event changes needed to provide it), not a planning
defect - so it should have escalated to the human early instead of looping. Two
distinct failure modes drove the waste: (a) weak agents hallucinating APIs /
producing unbuildable tooling, and (b) no loop-level circuit breaker on
re-raises, churn, or guardrail conflicts. The items below are concrete fixes;
items 3-5 (root cause + circuit breaker) are implemented, the rest proposed.

## Planner must cite codebase evidence; engine injects repo context

**Priority:** P1 (root cause - do before the other loop fixes) - **Status:**
implemented. Combines a prompt-guard (cite-or-block) with an engine-side context
injection - two complementary defenses against hallucinated schemas.
Design: `docs/phases/phase-8-repo-context-and-evidence-citations.md`.

**Problem it fixes:** rev 3's verifier assumed `turn_type` on turn rows,
`saveDecision` on approval, and a persisted runner discriminator - none of which
exist. A weak model will hallucinate APIs whenever asked to design tooling,
producing the multi-iteration "unbuildable verifier" trap.

**Wanted:**
- **Cite-or-block (planner prompt):** "Before proposing any new script, tool, or
  gate mechanism that depends on existing code artifacts (DB schemas, store
  methods, event types, persisted fields), you must cite the source file and line
  number proving the assumed interface exists. Proposing a verifier that reads a
  field that does not exist is a blocking-severity defect, not a revision."
- **Context injection (engine):** before calling the planner or frontier, the
  engine greps the codebase for files named in the task (e.g. `package.json`,
  `schema.ts`, `loop.ts`) and includes their contents in a `## Codebase Context`
  block in the prompt. Add a prompt guard: "You may only propose scripts, gates,
  or code changes that use the APIs and schemas provided in the Codebase Context
  block. Do not invent fields or methods."

**Why both:** the citation requirement forces the planner to check before
proposing (catching impossibility early); the injected context lets even a weak
model use correct field names from a pasted schema instead of guessing.

**Notes:**
- Injection wiring goes in the prompt `BuildContext` path (`loop.ts:90,113-118,
  157-161`); resolve file list from task mentions, bounded by a size cap so the
  block does not blow the context window.

## Hard escalation on objection re-raise (engine-enforced)

**Priority:** P1 - **Status:** implemented. Loop rule enforced by the workflow
engine on objection IDs. Design:
`docs/phases/phase-9-objection-stalemate-escalation.md`.

**Problem it fixes:** the loop spun 3 iterations on risk-1/2/3. A weak planner
keeps patching a fundamentally flawed concept; a weak reviewer keeps re-raising
it. Nothing capped the wasted attempts.

**Wanted:** if an objection ID is `open` in iteration N, marked `addressed` by the
planner in N+1, then re-raised `open` in N+2, the engine hard-stops the loop - it
does not ask for iteration N+3. It escalates to the human with the full objection
history and both sides' evidence: "Objection [ID] has been addressed and
re-raised. The agents are in a stalemate. Please review." The human decides:
accept the planner's mitigation, accept the objection as a hard block, or reframe
the requirement.

**Why:** caps wasted iterations at exactly 1 failed mitigation attempt before a
human intervenes. Would have cut iterations 3 and 4 of the observed run.

**Notes:**
- The objection ledger already tracks per-ID state transitions
  (`store.listObjections`, the `views` map in `loop.ts`); the re-raise detector is
  a state-transition check (open@N -> addressed@N+1 -> open@N+2) at the
  objection-gate step, feeding the existing human-escalation path.

## Structured objection addressal + guardrail-conflict escalation

**Priority:** P1 - **Status:** implemented. Forces a strict objection-addressal
schema and a new escalation type distinct from `deviationRequest`. Design:
`docs/phases/phase-10-structured-addressal-and-guardrail-conflicts.md`.

**Problem it fixes:** weak planners answer objections with vague prose ("I have
handled the transport risk by...") instead of concrete bindings, so weak reviewers
either accept blindly or re-raise out of confusion. Separately, rev 4's §0
correctly found that every way to make the gate machine-verifiable was a guardrail
violation and reverted to human observation - an insight that could have landed in
rev 2 if the tension had been surfaced as a first-class escalation rather than
worked around.

**Wanted:**
- **Strict addressal schema (planner):** for each objection ID in
  `objectionsAddressed`, provide:
  - `objectionId`: [ID]
  - `resolutionStrategy`: [revised_plan | retracted | conceded]
  - `evidence`: exact quote from `proposal.md` or pasted code
  - `requiresGuardrailException`: [true | false]
- **Engine check:** if `requiresGuardrailException` is true, or
  `resolutionStrategy` is `conceded`, the engine immediately halts and escalates to
  the human, bypassing another review round.
- **Guardrail-conflict escalation type:** when the planner determines that
  satisfying an objection would require violating a guardrail (e.g.
  "machine-verifiable parity needs a new persisted field = new schema = forbidden"),
  emit a `guardrailConflict` escalation immediately instead of iterating on a
  workaround. This is distinct from `deviationRequest` and triggers human review of
  the objection-vs-guardrail tension.

**Why:** forces explicit objection->change binding (no vague prose), and routes
genuine design impossibilities straight to the human instead of burning
iterations building a workaround that the guardrails forbid.

## Reviewer must justify a clean bill of health (cleanRationale)

**Priority:** P1 (cheap win) - **Status:** implemented. Extraction-enforced clean
pass with reviewer prompt guidance. Design: `docs/phases/phase-11-reviewer-clean-rationale.md`.

**Problem it fixes:** the iter-1 no-op. The reviewer returned zero objections
without reasoning about the parity precondition or the destructive-delete risk,
so risk-1/risk-2 were caught only later by the frontier.

**Wanted:** "If you return zero objections, you must include a `cleanRationale`
field that cites each acceptance criterion and guardrail by name and explains why
the plan satisfies it. An empty objection list without `cleanRationale` is
rejected as a malformed reply."

**Notes:**
- Add `cleanRationale` to the reviewer result schema; the engine rejects an
  empty-objection reply that omits it (treat as malformed, re-prompt), so a clean
  pass forces explicit per-criterion / per-guardrail reasoning.

## Plan churn / oscillation detection

**Priority:** P1 (builds the shared proposal-diff signal) - **Status:** implemented.
Loop rule uses section-weighted proposal similarity and escalates A→B→A
reversions before another reviewer/frontier turn. Design:
`docs/phases/phase-12-plan-churn-and-frontier-reinvoke.md`.

**Problem it fixes:** iteration 4 reverted to the iteration 1 approach. Weak
models oscillate between two bad ideas as the context window fills, without
realizing they are circling.

**Wanted:** the engine computes a semantic diff (or simple hash / token overlap)
between `proposal.md` in iteration N and iteration N-2. If N substantially reverts
to N-2 (e.g. >70% similar on the core execution steps), halt the loop and escalate
to the human.

**Why:** catches circular debate instantly, without requiring the weak models to
notice they are going in circles.

**Notes:**
- Compare the newest completed planner proposal against the one two iterations
  back (both retrievable by iteration via `store.listTurns` + result files);
  threshold and similarity metric configurable. This diff is reused by the frontier
  re-invoke rule below.

## Re-invoke the frontier after major plan restructurings

**Priority:** P1 (depends on the churn-detector diff signal) - **Status:**
implemented. The loop re-invokes frontier after a detected restructuring.
Design: `docs/phases/phase-12-plan-churn-and-frontier-reinvoke.md`.

**Problem it fixes:** the frontier ran only on iteration 1. Its original risk-2
("parity run still pending") was about process state, not about whether machine
verification was even possible; the deeper "impossible within guardrails" insight
emerged only through the reviewer's iter-3 source analysis. A stronger model
re-invoked earlier might have reached it in iter-2, collapsing the debate.

**Wanted:** the frontier runs not only on iteration 1 but also after any iteration
where the planner changes the gate mechanism or phase structure. Its stronger
model can identify guardrail conflicts (like "machine-verifiable parity requires
forbidden schema changes") that the evidence-focused reviewer frames as mere
implementability gaps.

**Notes:**
- Trigger a frontier turn when a restructuring is detected (gate-mechanism or
  phase-structure change between consecutive proposals - shares the diff signal
  with the churn detector above), in addition to the existing iteration-1 gate.

---

# P2 - Observability & DX

## Per-turn progress in the orchestrator terminal

**Priority:** P2 - **Status:** proposed.

**Problem:** while agents run, the orchestrator terminal (where `parrot next
<task> orchestrate` was launched) shows no live progress. Current output is only
coarse phase-level lines printed *after* a whole stage finishes
(`packages/orchestrator/src/cli.ts:104,115,125` - "Review loop finished",
"Implementation: ...", "Verification: ..."). To see what's happening the user
has to switch into each agent's pane individually.

**Wanted:** after each turn, print a brief update in the orchestrator terminal -
a short summary or the last message from each agent - so the user gets an
overview of the whole run from one place, without visiting each pane.

**Notes / implementation sketch:**
- Each turn's result already carries a summary (`result.toon` -> the turn
  result surfaced by the runner / composition); print that per turn, tagged with
  role + iteration (e.g. `[planner iter 2] <summary>`).
- Alternatively / additionally, pull the agent's last message via Herdr
  `pane.read` / `agent.read {target, source: "recent"|"visible"}` after the turn
  completes, and print a trimmed tail.
- Hook the print into the turn-completion path (composition / `runReviewLoop`
  callback), not just the stage boundaries, so every planner/reviewer/frontier/
  impl/verify turn emits one line.
- Keep it concise (one short block per turn); full detail stays in each pane.

## Lazy / on-demand agent spawning

**Priority:** P2 - **Status:** proposed.

**Problem:** `parrot next <task> orchestrate` spawns all 5 agent panes up front
(`packages/orchestrator/src/cli.ts:51-63` loops over `ROLE_SPECS` and calls
`runtime.start` for planner, reviewer, frontier, implementation, verifier before
the loop runs). Most are idle for a long time - the dev (implementation) agent,
verifier, frontier, etc. are not needed at launch. This wastes panes/processes
and clutters the tab.

**Wanted:** spawn each agent only on its first use, then keep it alive and reuse
it for later iterations. Spawn order follows the loop, one at a time:

1. Spawn **planner** first (needed immediately).
2. Spawn **reviewer** only once planning is done.
3. Spawn **frontier** only when the frontier gate is reached.
4. Spawn **implementation** (dev) agent only when implementation starts.
5. Spawn **verifier** only when verification starts.

Same rule for every role: no agent is spawned until the moment it is first
needed; once spawned it stays alive (cached handle) for the rest of the run.

**Notes / implementation sketch:**
- Replace the eager `for (const spec of ROLE_SPECS)` spawn loop with lazy
  resolution: a `getHandle(roleId)` that spawns on first request and memoizes in
  the `handles` map, so callers (`createHerdrRunner`, composition) trigger the
  spawn on first turn for that role.
- Keep the dedicated-tab behavior (`createTab`) and `PARROT_TAB` reuse.
- Preserve worktree setup for the implementation role (`worktreeRequired: true`).

## Run parrot against any project (portable / global command)

**Priority:** P2 - **Status:** proposed.

**Problem:** after the package refactor there is no `parrot` command - the only
runnable entry is the orchestrator package CLI, invoked with a long
`pnpm --filter @platform/orchestrator exec tsx src/cli.ts ...` from inside this
repo. Running it against a *different* project today requires setting
`PARROT_PROJECT_DIR=/abs/path` (agents' cwd, task path, and `runs/`/`parrot.db`
all anchor there via `cli.ts:40,72-73`) on every invocation. Clunky and easy to
get wrong; the stale root `pnpm orchestrate` script still points at the old
pre-refactor monolith (`src/orchestrate.ts`), adding confusion.

**Wanted:** a real `parrot` command usable from any project directory, so the user
can `cd` into a target repo and run `parrot task.md` / `parrot --resume` with the
project auto-detected (no `PARROT_PROJECT_DIR` needed - `INIT_CWD`/cwd already
resolves to the invocation dir).

**Notes / implementation sketch:**
- Rename the bin `parrot-orchestrate` -> `parrot`
  (`packages/orchestrator/package.json:13`); `pnpm build`, then
  `pnpm --filter @platform/orchestrator link --global` for a global `parrot`.
  Caveat: the linked bin runs built `dist/`, so it needs a rebuild after code
  changes.
- Alternatively add a root `package.json` script (e.g. `"parrot": "pnpm --filter
  @platform/orchestrator exec tsx src/cli.ts"`) for a dev-mode `pnpm parrot -- ...`
  that always runs live source (no rebuild), for use inside this repo.
- Confirm the target-project defaults are sane: `runs/` + `parrot.db` land in the
  target repo by default; document `PARROT_RUNS_ROOT`/`PARROT_DB` to relocate them.
- Repoint or remove the stale root `pnpm orchestrate` script so there is one
  obvious entrypoint.
- Preconditions to document: `herdr` daemon running, a focused/`PARROT_WORKSPACE`
  workspace, and the target project being a git repo (implementation agent needs a
  worktree, `worktreeRequired: true`).

---

# Done (shipped this cycle - context only, not for implementation)

## Idle-based turn timeout (reset the clock on agent activity)

**Status:** implemented. Replaced the fixed 15-min wall-clock turn deadline with an
idle timeout that resets on agent activity, bounded by an absolute cap.

**Problem it fixed:** a turn was killed at a hard 15-min deadline computed once at
dispatch, even when the agent was actively working (or would produce a valid result
minutes later). A real run lost a completed planner turn this way - the result landed
7 min after the deadline and was discarded.

**Design (shipped):**
- `ResultFileWatcher` already `fsWatch`es the whole turn dir; its callback now fires an
  `onActivity` hook on every real write (proposal.md, partial result, etc.). Poll-timer
  wakeups do not count as activity.
- `HerdrAgentRuntime.send` arms the turn deadline at `now + idleMs` and re-arms it (up to
  the absolute cap = `TurnRequest.deadline`) on each activity, reusing the existing
  `TurnDeadlineManager`. No new signal kinds. Absent `idleMs` = old fixed-deadline
  behavior (so unit tests are unchanged).
- `createHerdrRunner`: `idleTimeoutMs` (default 10 min) + `maxMs` (default 45 min);
  `runtime.wait` uses the cap. Env: `PARROT_TURN_IDLE_TIMEOUT_MS`, `PARROT_TURN_MAX_MS`
  (`PARROT_TURN_TIMEOUT_MS` kept as a `maxMs` alias).
- On expiry, `runtime.result` re-reads the disk, so a result that lands just before the
  cutoff is still adopted (a cheap final re-check, inherent to the existing flow).

**Follow-up promoted to P0:** the "adopt-late-result on resume" limitation (a fully-silent
turn that writes everything at the very end gets no mid-turn activity, so idle-reset cannot
save it) is now its own P0 item above.

## Session resume (orchestration-level)

**Status:** implemented; provider-session reattach deferred.

**Problem it fixed:** when an agent hit its provider usage limit (e.g. Claude's 5-hour
window) mid-run, it stopped responding, the turn deadline expired, and the orchestrator
errored out. There was no way to continue: re-launching minted a new workflow id
(`cli.ts:44`) and `runReviewLoop` unconditionally called `startWorkflow` (`loop.ts:55`),
which re-inited folded state and overwrote the persisted snapshot (`engine.ts:118-138`) -
discarding all the planner<->reviewer<->frontier back-and-forth.

**Scope shipped:** orchestration resume only. Agents restart as fresh provider processes
but receive all prior objections/plans as prompt context.

**Design (implemented):**
- Select the workflow to resume: `PARROT_RESUME=<id>` / `--resume [id]`, else
  auto-pick the newest non-terminal workflow via `store.listResumableWorkflows()`.
- Recover instead of reset: `engine.recover(workflowId)` folds the event log; skip
  `startWorkflow`.
- Rehydrate the loop's in-memory scratch from the DB: objection `views` from
  `store.listObjections`; `finalProposalPath`/summary and `frontierReadiness` by
  re-reading the newest completed planner/frontier turn result files
  (`ResultEnvelopeSchema` + `Planner/FrontierResultSchema`).
- Phase-driven re-entry: `runReviewLoop` is a dispatcher on
  `engine.getState().phase` (`WorkflowPhase`), so fresh (starts at `planner_turn`,
  iteration 1) and resumed runs share one path; the interrupted turn re-runs, and
  earlier completed turns (already in folded state) are not re-executed.
- Post-review: on resume at `approved`, reuse a completed implementation turn and
  skip to verification; otherwise re-run implementation.

**Deferred / follow-up:**
- Provider-session reattach (persist `AgentHandle.sessionId/sessionPath`, add a
  reader, translate to provider resume argv at `runtime.ts:69`/`config.ts:35`).
- Live end-to-end re-verification against a real Herdr daemon after an induced
  mid-run stall.
