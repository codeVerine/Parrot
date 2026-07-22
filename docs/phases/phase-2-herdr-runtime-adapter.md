# Phase 2: Herdr Runtime Adapter

**Status: implemented**

## 5.1 Goal and non-goals

The adapter is the only component that speaks Herdr-specific APIs. It implements `AgentRuntime`, emits runtime signals, and never decides workflow facts. It has no workflow state machine, persistence, prompt construction, TOON parsing, or LLM dependency. Herdr is accessed through its socket API and CLI only.

## 5.2 Interface contract

```ts
interface AgentRuntime {
  start(spec: AgentSpec): Promise<AgentHandle>;
  send(id: AgentId, turn: TurnRequest): Promise<DeliveryReceipt>;
  wait(id: AgentId, turnId: TurnId, timeoutMs: number): Promise<RuntimeSignal>;
  result(id: AgentId, turnId: TurnId): Promise<TurnResult>;
  onStatus(handler: (e: StatusEvent) => void): void;
  resync(): Promise<AgentStatus[]>;
  interrupt(id: AgentId): Promise<void>;
  stop(id: AgentId): Promise<void>;
}
```

`start` maps provider, role, workspace, worktree, and environment to Herdr. `send` delivers a short instruction referencing the immutable prompt and returns the turn ID plus prompt hash. Repair sends reuse the turn ID, reference `repair-prompt.md`, and are bounded to one attempt. `wait` passes explicit timeouts to Herdr. `result` performs file-safety checks and returns bytes plus hash; it never parses TOON. `interrupt` and `stop` are idempotent and late artifacts remain observable as orphan candidates. There is no `read()` method; pane text is debug output only.

## 5.3 Startup checks

Startup runs `herdr api schema --json`, pins protocol 16, schema version 1, and exactly 23 event variants, then runs `herdr integration status`. Production fails closed when required integrations are absent. Development emits `DegradedModeEntered` and disables restore, session-log audit, and usage extraction. Herdr remains an external socket/CLI dependency.

## 5.4 Identity mapping

The in-memory map owns `AgentId <-> pane_id`, `workflowId <-> workspace_id`, and optional provider session identity. `pane_id` is never the platform agent identity. Pane exit, detection, and respawn update the mapping. During reconciliation, a matching provider session remaps to the existing agent ID; a genuinely new pane receives a generated platform ID and is never keyed from its pane ID. Persistence of this shape belongs to Phase 3.

## 5.5 Status normalization

| Herdr raw status | Canonical status | Hints |
|---|---|---|
| `idle` | `idle` | none |
| `working` | `working` | none |
| `blocked` | `blocked` | none |
| `done` | `idle` | completion candidate and early result check |
| `unknown` | `unknown` | none |

Status is a heuristic. `done` can accelerate an artifact check but never completes a turn without the matching artifact.

## 5.6 Result watching and safety

The adapter watches the turn directory for `result.toon`, ignores `result.tmp` and partials, hashes bytes before parsing, and falls back to polling after watcher failure. It rejects symlinks, unexpected ownership, world-writable directories, stale mtimes, canonical path escapes, and oversized files. Safety reads use one `O_NOFOLLOW` file descriptor and `fstat`/read from that descriptor, so the path cannot be swapped between the check and read. Same-second filesystem timestamps are accepted at the send-time boundary. Deliberate watcher shutdown is a distinct outcome and is never reported as `ResultWatchFailed`. These checks precede TOON parsing. Extraction owns envelope and schema validation.

## 5.7 Deadlines and repair

The primary timer starts after delivery acknowledgment. Expiry emits observation signal `DeadlineExpired` with `primary` or `repair`; the workflow engine may derive `AgentTimedOut`. Past-due sends do not start a result wait that could be mistaken for a watch fault. Working-to-idle without an artifact can trigger an early check and grace timer. Deadline records can reconstruct timers after restart. Cancellation, timeout, genuine watch failure, and shutdown stop active watchers; late artifacts remain bounded orphan candidates and are rediscovered by reconciliation.

## 5.8 Reconciliation

Reconnect runs `session.snapshot` and `agent.list`, diffs and updates the identity map, binds newly discovered agents without deriving identity from `pane_id`, scans known turn artifacts, and emits `SnapshotReconciled`. Bounded retry failure emits `ReconnectFailed`. Herdr subscriptions have no replay cursor, so finished agents, dead panes, status changes, and missed result files are recoverable through reconciliation. Worktree state is not reconstructed here because the Phase 1 signal contract does not carry a worktree delta; the adapter consumes worktree events so a later state projection can own that addition.

## 5.9 Event subscription

The pinned schema contains exactly these 23 variants: `workspace_created`, `workspace_updated`, `workspace_closed`, `workspace_renamed`, `workspace_moved`, `workspace_focused`, `worktree_created`, `worktree_opened`, `worktree_removed`, `tab_created`, `tab_closed`, `tab_renamed`, `tab_moved`, `tab_focused`, `pane_created`, `pane_closed`, `pane_focused`, `pane_moved`, `pane_output_changed`, `pane_exited`, `pane_agent_detected`, `pane_agent_status_changed`, and `layout_updated`. Adapter policy consumes identity, status, pane-death, and worktree lifecycle events; UI and pane-output events are ignored for orchestration. Re-verify this list when the Herdr pin changes.

## 5.10 Configuration

The adapter configures protocol and schema pins, required integrations, production/development mode, turn deadline, grace timer, artifact size limit, watch debounce, polling interval, operation timeout, reconnect backoff, signal history/queue limits, and orphan-turn retention. Defaults are conservative and explicit; no Herdr wait relies on an undocumented default.

## 5.11 Failure-path mapping

| Failure path | Signal | Group |
|---|---|---|
| spawn | `AgentSpawnFailed` | fault |
| send | `TurnDeliveryFailed` | fault |
| watcher | `ResultWatchFailed` | fault |
| safety rejection | `ArtifactRejected` | fault |
| timeout | `DeadlineExpired` | observation |
| reconnect | `ReconnectFailed` | fault |
| protocol mismatch | `ProtocolMismatch` | fault |
| degraded development mode | `DegradedModeEntered` | fault |

Every adapter error class is represented in `signalmap.ts`; the adapter does not silently discard an internal failure.

## 5.12 Tests

Tests use an in-process protocol-16 fake. They cover startup pinning, missing integrations, pane remapping and new-agent reconciliation, raw status normalization, all six artifact rejection reasons, same-second freshness, TOCTOU-resistant reads, repair and shutdown watcher bounding, optimistic busy rejection, deadline expiry and restart re-derivation, cancellation/orphan recovery, bounded signal history, reconnect reconciliation, error mapping, and result hash/signal correlation. The real-binary schema test is enabled only with `HERDR_PIN_TEST=1`.

## 5.13 Open question

The concurrency limit before Herdr session management degrades remains assigned to Phase 2. A real-Herdr scale test should measure session latency and event delay; its result becomes a configuration default.

## 5.14 Dependencies

Phase 2 consumes the Phase 1 envelope, IDs, repair constants, event list, signal taxonomy, and artifact layout. It provides runtime signals and `AgentRuntime` to persistence and the workflow engine.
