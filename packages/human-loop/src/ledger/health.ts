import type { FoldedState } from "@platform/workflow-engine";
import type { PersistenceStore } from "@platform/persistence";

export type HealthMetrics = {
  workflowId: string;
  turnCount: number;
  completedTurns: number;
  failedTurns: number;
  timedOutTurns: number;
  repairAttempts: number;
  timeoutEvents: number;
  spendTotal: number;
  wallClockMsTotal: number;
  retryCountTotal: number;
  startupMsTotal: number;
};

/** Derive orchestration health from turn rows + usage_ledger + folded spend. */
export function deriveHealthMetrics(input: {
  store: PersistenceStore;
  workflowId: string;
  folded: FoldedState;
}): HealthMetrics {
  const turns = input.store.listTurns(input.workflowId);
  const usage = input.store.listUsage(input.workflowId);
  const events = input.store.listEvents({ workflowId: input.workflowId, limit: null });

  return {
    workflowId: input.workflowId,
    turnCount: turns.length,
    completedTurns: turns.filter((row) => String(row.state) === "completed").length,
    failedTurns: turns.filter((row) => String(row.state) === "failed").length,
    timedOutTurns: turns.filter((row) => String(row.state) === "timed_out").length,
    repairAttempts: turns.filter((row) => String(row.attempt) === "repair").length,
    timeoutEvents: events.filter((event) => event.kind === "AgentTimedOut").length,
    spendTotal: input.folded.spendTotal,
    // Per-turn health is stored on at most one usage row; take max per turn then sum.
    wallClockMsTotal: sumHealthOncePerTurn(usage, "wall_clock_ms"),
    retryCountTotal: sumHealthOncePerTurn(usage, "retry_count"),
    startupMsTotal: sumHealthOncePerTurn(usage, "startup_ms"),
  };
}

function sumHealthOncePerTurn(
  usage: ReadonlyArray<Readonly<Record<string, unknown>>>,
  column: string,
): number {
  const byTurn = new Map<string, number>();
  for (const row of usage) {
    const key = String(row.turn_id ?? row.usage_id);
    const value = Number(row[column] ?? 0);
    byTurn.set(key, Math.max(byTurn.get(key) ?? 0, value));
  }
  return [...byTurn.values()].reduce((sum, value) => sum + value, 0);
}
