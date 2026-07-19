import type { SIGNAL_KINDS } from "@platform/contracts";
import { AgentSpawnError, ArtifactRejectedError, DegradedModeError, ProtocolMismatchError, ReconnectError, ResultWatchError, TurnDeliveryError } from "./errors.js";

export type SignalKind = (typeof SIGNAL_KINDS)[number];
export const FAILURE_SIGNAL_MAP = [
  { error: AgentSpawnError, errorName: "AgentSpawnError", path: "spawn", kind: "AgentSpawnFailed" },
  { error: TurnDeliveryError, errorName: "TurnDeliveryError", path: "send", kind: "TurnDeliveryFailed" },
  { error: ResultWatchError, errorName: "ResultWatchError", path: "watch", kind: "ResultWatchFailed" },
  { error: ArtifactRejectedError, errorName: "ArtifactRejectedError", path: "safety", kind: "ArtifactRejected" },
  { error: ReconnectError, errorName: "ReconnectError", path: "reconnect", kind: "ReconnectFailed" },
  { error: ProtocolMismatchError, errorName: "ProtocolMismatchError", path: "protocol", kind: "ProtocolMismatch" },
  { error: DegradedModeError, errorName: "DegradedModeError", path: "degraded", kind: "DegradedModeEntered" },
] as const;

export const TIMEOUT_SIGNAL_MAPPING = { path: "turn_timeout", kind: "DeadlineExpired", group: "observation", attempt: ["primary", "repair"] as const } as const;
