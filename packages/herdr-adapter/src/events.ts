import { RuntimeSignalSchema, signalId, type RuntimeSignal } from "@platform/contracts";
import type { HerdrEvent, HerdrAgent } from "./client/types.js";
import { IdentityMap } from "./identity.js";
import { normalizeStatus } from "./status.js";

export const EVENT_POLICY = {
  workspace_created: "ignored", workspace_updated: "ignored", workspace_closed: "consumed", workspace_renamed: "ignored", workspace_moved: "ignored", workspace_focused: "ignored",
  worktree_created: "consumed", worktree_opened: "consumed", worktree_removed: "consumed", tab_created: "ignored", tab_closed: "ignored", tab_renamed: "ignored", tab_moved: "ignored", tab_focused: "ignored",
  pane_created: "consumed", pane_closed: "consumed", pane_focused: "ignored", pane_moved: "ignored", pane_output_changed: "ignored", pane_exited: "consumed", pane_agent_detected: "consumed", pane_agent_status_changed: "consumed", layout_updated: "ignored",
} as const;

export type StatusSignalHandler = (signal: RuntimeSignal) => void;

export function consumeEvent(event: HerdrEvent, identity: IdentityMap, emit: StatusSignalHandler): RuntimeSignal | null {
  switch (event.type) {
    case "pane_agent_status_changed": {
      if (!event.pane_id) return null;
      const current = identity.byPane(event.pane_id);
      const normalized = normalizeStatus({ pane_id: event.pane_id, agent_status: event.agent_status }, current?.agentId ?? null);
      identity.updateFromHerdr({ pane_id: event.pane_id, workspace_id: event.workspace_id ?? current?.workflowId ?? "", agent_status: normalized.rawStatus, agent: event.agent as string | null | undefined }, normalized.normalizedStatus);
      const signal = makeStatusSignal(event, normalized.agentId, normalized.normalizedStatus, normalized.completionCandidate, normalized.resultCheckRequested);
      emit(signal); return signal;
    }
    case "pane_agent_detected": {
      if (!event.pane_id) return null;
      const current = identity.byPane(event.pane_id);
      if (current) identity.updateFromHerdr({ pane_id: event.pane_id, workspace_id: event.workspace_id ?? current.workflowId, agent: event.agent }, current.status);
      return null;
    }
    case "pane_exited": {
      const current = event.pane_id ? identity.removePane(event.pane_id) : null;
      if (!current || !event.pane_id) return null;
      const signal = makeStatusSignal({ ...event, agent_status: "unknown" }, current.agentId, "unknown", false, false);
      emit(signal); return signal;
    }
    default:
      return null;
  }
}

function makeStatusSignal(event: HerdrEvent, agent: string | null, normalizedStatus: "idle" | "working" | "blocked" | "unknown", completionCandidate: boolean, resultCheckRequested: boolean) {
  return RuntimeSignalSchema.parse({ signalId: signalId(), kind: "HerdrStatusChanged", classification: "observation", observedAt: new Date().toISOString(), source: "herdr_event", workflowId: event.workspace_id ?? null, iterationId: null, turnId: null, agentId: agent, rawStatus: event.agent_status ?? "unknown", normalizedStatus, hints: { completionCandidate, resultCheckRequested } });
}

export function isKnownHerdrEventType(value: string): value is HerdrEvent["type"] { return value in EVENT_POLICY; }
