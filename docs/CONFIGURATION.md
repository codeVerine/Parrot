<!-- generated-by: gsd-doc-writer -->
# Configuration

## CLI environment

The packaged CLI reads the following variables directly:

| Variable | Type | Default | Notes |
|---|---|---|---|
| `PARROT_PROJECT_DIR` | path | invocation directory | Target git repository and base for relative paths |
| `PARROT_RUNS_ROOT` | path | `runs` | Resolved from the target directory |
| `PARROT_DB` | path | `<runs-root>/parrot.db` | SQLite database |
| `PARROT_WORKFLOW` | string | `wf-<timestamp>` | Fresh runs only |
| `PARROT_RESUME` | boolean-like or ID | unset | Truthy keywords select the newest resumable workflow |
| `PARROT_WORKSPACE` | string | focused Herdr workspace | Overrides stored/focused workspace selection |
| `PARROT_TAB` | string | new `parrot agents` tab | Reuses an existing tab |
| `PARROT_WORKTREE_ROOT` | path | sibling `.parrot-worktrees/<repo>` | Relative values resolve from the target repository |
| `PARROT_PLANNER_PROVIDER` | string | `claude` | Herdr provider ID |
| `PARROT_REVIEWER_PROVIDER` | string | `codex` | Herdr provider ID |
| `PARROT_FRONTIER_PROVIDER` | string | `claude` | Herdr provider ID |
| `PARROT_IMPL_PROVIDER` | string | `claude` | Herdr provider ID |
| `PARROT_VERIFIER_PROVIDER` | string | `codex` | Herdr provider ID |
| `PARROT_CONTEXT_DISABLE` | `"1"` | unset | Disables repository context |
| `PARROT_CONTEXT_MAX_FILES` | non-negative integer | `12` | Invalid values fall back to the resolver default |
| `PARROT_CONTEXT_MAX_BYTES` | non-negative integer | `49152` | Total context limit; invalid values fall back |
| `PARROT_TURN_IDLE_TIMEOUT_MS` | milliseconds | Herdr runner default | Resets when agent activity is observed |
| `PARROT_TURN_MAX_MS` | milliseconds | Herdr runner default | Absolute turn deadline |
| `PARROT_TURN_TIMEOUT_MS` | milliseconds | unset | Deprecated alias used only when `PARROT_TURN_MAX_MS` is absent |
| `HERDR_BIN` | executable | `herdr` | Used for CLI operations and socket discovery |
| `HERDR_SOCKET` | path | discovered/default socket | Highest-precedence socket selection |

## Workflow engine defaults

`DEFAULT_WORKFLOW_CONFIG` in `@platform/workflow-engine`:

| Field | Default |
|---|---:|
| `maxIterations` | `5` |
| `budgetCap` | `null` |
| `reviewerCountPerRound` | `2` |
| `adversarialReviewerEnabled` | `true` |
| `frontierPanelSize` | `1` |
| `humanAutoRules` | `[]` |
| `escalationNotificationTarget` | `"human"` |
| `defaultRepairDeadlineMs` | `300000` |

The current CLI passes one reviewer agent and does not enable its adversarial
mode. Library callers can configure the broader engine/loop surface.

## Review-loop defaults

| Field | Default | State |
|---|---:|---|
| `maxIterations` | `5` | active |
| `frontierReinvoke.disabled` | `false` | active |
| `frontierReinvoke.headingChangeRatio` | `0.7` | active |
| `frontierReinvoke.similarityFloor` | `0.4` | active |
| `churnDetection.*` | n/a | accepted but ignored; detection deferred |

Frontier re-invocation also requires iteration 2 or later, an open objection, a
previous proposal, a readable current proposal, and no frontier turn already
recorded for that iteration.

## LLM boundary defaults

`DEFAULT_LLM_BOUNDARY_CONFIG` pins:

| Role | Prompt version | Provider/model label |
|---|---|---|
| planner | `1.2.0` | `anthropic/claude` |
| reviewer | `1.1.0` | `openai/codex` |
| adversarial | `1.1.0` | `openai/codex` |
| frontier | `1.1.0` | `anthropic/claude` |
| implementation | `1.0.0` | `anthropic/claude` |
| verifier | `1.0.0` | `openai/codex` |
| merge | `1.0.0` | `openai/cheap` |
| planner-compact | `1.0.0` | `anthropic/claude` |

Other defaults include one adversarial reviewer, three-iteration compacted-state
cadence, a 32-item clustering batch, one bounded repair path, 2,000 characters
of repair diagnostics, and accepted result schema version `v1`.

## Herdr adapter defaults

The adapter pins protocol `16` and schema version `1`. Important defaults:

- required integrations: `claude`, `codex`;
- supported providers: `claude`, `codex`, `gemini`;
- turn deadline: 120 seconds;
- grace timer: 5 seconds;
- result artifact limit: 4 MiB;
- operation timeout: 10 seconds;
- result poll interval: 250 ms;
- signal history: 1,000;
- queued signals: 100;
- retained orphan turns: 1,000.

The packaged CLI's Herdr runner can override effective turn deadlines through the
environment variables above.

## Persistence defaults

| Field | Default |
|---|---:|
| path | `runs/parrot.db` |
| SQLite synchronous mode | `NORMAL` |
| busy timeout | `5000` ms |
| outbox batch size | `50` |
| retry backoff | `250` ms |
| signal retention | unlimited (`null`) |

## Human-loop defaults

The library default notification sink is `noop`; the packaged CLI overrides it
to `herdr`.

| Field | Default |
|---|---|
| dashboard deep-link base | `http://127.0.0.1:5173/workflows` |
| dashboard bind | `127.0.0.1:8787` |
| ledger sweep cadence | 60 seconds |
| pricing table version | `v1` |
| transcript retention | 30 days |
| sensitive workflow default | `false` |
| secret scanner ruleset | `secrets-v1` |

## Secrets

Parrot does not load a repository-specific `.env` file and does not define
provider API-key variables. Provider authentication belongs to Herdr and the
installed provider CLIs. Do not commit credentials, session logs, `runs/`, or
custom database files.
