import type { SignalKind } from "./signalmap.js";

export class AdapterError extends Error {
  constructor(message: string, readonly code: string, readonly signalKind: SignalKind) { super(message); this.name = new.target.name; }
}

export class AgentSpawnError extends AdapterError {
  static readonly signalKind = "AgentSpawnFailed";
  constructor(readonly reason: "spawn_error" | "integration_missing" | "unsupported_provider", readonly provider: string, message: string) { super(message, reason, "AgentSpawnFailed"); }
}
export class TurnDeliveryError extends AdapterError {
  static readonly signalKind = "TurnDeliveryFailed";
  constructor(readonly reason: "pane_dead" | "agent_not_idle" | "transport_error", readonly turnId: string, readonly attempt: "primary" | "repair", message: string) { super(message, reason, "TurnDeliveryFailed"); }
}
export class ResultWatchError extends AdapterError { static readonly signalKind = "ResultWatchFailed"; constructor(readonly artifactPath: string, message: string) { super(message, "watch_failed", "ResultWatchFailed"); } }
export class ArtifactRejectedError extends AdapterError {
  static readonly signalKind = "ArtifactRejected";
  constructor(readonly reason: "symlink" | "ownership" | "world_writable" | "stale_mtime" | "path_escape" | "oversize", readonly artifactPath: string, readonly observed?: string, readonly limit?: string) { super(`Artifact rejected (${reason}): ${artifactPath}`, reason, "ArtifactRejected"); }
}
export class ReconnectError extends AdapterError { static readonly signalKind = "ReconnectFailed"; constructor(readonly attempts: number, message: string) { super(message, "reconnect_failed", "ReconnectFailed"); } }
export class ProtocolMismatchError extends AdapterError { static readonly signalKind = "ProtocolMismatch"; constructor(readonly expectedProtocol: number, readonly observedProtocol: number | null, readonly expectedSchemaVersion: number, readonly observedSchemaVersion: number | null) { super(`Expected Herdr protocol ${expectedProtocol}/schema ${expectedSchemaVersion}, observed ${observedProtocol ?? "missing"}/${observedSchemaVersion ?? "missing"}.`, "protocol_mismatch", "ProtocolMismatch"); } }
export class DegradedModeError extends AdapterError { static readonly signalKind = "DegradedModeEntered"; constructor(readonly missingIntegrations: string[], readonly disabledCapabilities: string[], message: string) { super(message, "degraded_mode", "DegradedModeEntered"); } }
