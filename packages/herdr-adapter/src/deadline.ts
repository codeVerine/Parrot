import { RuntimeSignalSchema, signalId, type RuntimeSignal } from "@platform/contracts";
import type { RepairAttempt } from "@platform/contracts";

export type PersistedDeadline = { turnId: string; deadline: string; attempt: RepairAttempt };
type DeadlineEntry = PersistedDeadline & { timer: NodeJS.Timeout };

/**
 * Called when a deadline timer fires. Implementations may re-arm the turn and
 * return without emitting, or emit {@link DeadlineExpired} via the manager's emit.
 */
export type DeadlineExpireHandler = (
  turnId: string,
  deadline: Date,
  attempt: RepairAttempt,
) => void | Promise<void>;

export class TurnDeadlineManager {
  private readonly entries = new Map<string, DeadlineEntry>();
  constructor(
    private readonly emit: (signal: RuntimeSignal) => void,
    persisted: PersistedDeadline[] = [],
    private readonly onExpire?: DeadlineExpireHandler,
  ) {
    for (const entry of persisted) this.arm(entry.turnId, new Date(entry.deadline), entry.attempt);
  }

  arm(turnId: string, deadline: Date, attempt: RepairAttempt) {
    this.cancel(turnId);
    const timer = setTimeout(() => {
      this.entries.delete(turnId);
      if (this.onExpire) {
        void Promise.resolve(this.onExpire(turnId, deadline, attempt)).catch(() => {
          this.emit(expiredSignal(turnId, deadline, attempt));
        });
        return;
      }
      this.emit(expiredSignal(turnId, deadline, attempt));
    }, Math.max(0, deadline.getTime() - Date.now()));
    this.entries.set(turnId, { turnId, deadline: deadline.toISOString(), attempt, timer });
  }
  cancel(turnId: string) { const entry = this.entries.get(turnId); if (entry) { clearTimeout(entry.timer); this.entries.delete(turnId); } }
  rearm(turnId: string, deadline: Date) { this.arm(turnId, deadline, "repair"); }
  snapshot(): PersistedDeadline[] { return [...this.entries.values()].map(({ timer: _timer, ...entry }) => entry); }
  dispose() { for (const entry of this.entries.values()) clearTimeout(entry.timer); this.entries.clear(); }

  /** Emit a DeadlineExpired observation (used after idle probes decide the agent is truly stalled). */
  emitExpired(turnId: string, deadline: Date, attempt: RepairAttempt) {
    this.emit(expiredSignal(turnId, deadline, attempt));
  }
}

function expiredSignal(turnId: string, deadline: Date, attempt: RepairAttempt): RuntimeSignal {
  return RuntimeSignalSchema.parse({ signalId: signalId(), kind: "DeadlineExpired", classification: "observation", observedAt: new Date().toISOString(), source: "deadline_timer", workflowId: null, iterationId: null, turnId, agentId: null, deadline: deadline.toISOString(), attempt });
}
