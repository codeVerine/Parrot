import type { HerdrAgent } from "./client/types.js";

export const STATUS_NORMALIZATION = {
  idle: { normalized: "idle", completionCandidate: false, resultCheckRequested: false },
  working: { normalized: "working", completionCandidate: false, resultCheckRequested: false },
  blocked: { normalized: "blocked", completionCandidate: false, resultCheckRequested: false },
  done: { normalized: "idle", completionCandidate: true, resultCheckRequested: true },
  unknown: { normalized: "unknown", completionCandidate: false, resultCheckRequested: false },
} as const;

export type NormalizedStatus = (typeof STATUS_NORMALIZATION)[keyof typeof STATUS_NORMALIZATION]["normalized"];
export type NormalizedAgentStatus = { agentId: string | null; paneId: string; rawStatus: keyof typeof STATUS_NORMALIZATION; normalizedStatus: NormalizedStatus; completionCandidate: boolean; resultCheckRequested: boolean };

export function normalizeStatus(agent: Pick<HerdrAgent, "pane_id" | "agent_status">, agentId: string | null = null): NormalizedAgentStatus {
  const rawStatus = agent.agent_status ?? "unknown";
  const entry = STATUS_NORMALIZATION[rawStatus];
  return { agentId, paneId: agent.pane_id, rawStatus, normalizedStatus: entry.normalized, completionCandidate: entry.completionCandidate, resultCheckRequested: entry.resultCheckRequested };
}
