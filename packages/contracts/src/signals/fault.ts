import { z } from "zod";
import { SignalEnvelopeSchema } from "./envelope.js";
import { AttemptSchema } from "./observation.js";

const FaultBase = SignalEnvelopeSchema.extend({ classification: z.literal("fault") });

export const AgentSpawnFailedSchema = FaultBase.extend({
  kind: z.literal("AgentSpawnFailed"),
  reason: z.enum(["spawn_error", "integration_missing", "unsupported_provider"]),
  provider: z.string().min(1),
  rawError: z.string().min(1),
});

export const TurnDeliveryFailedSchema = FaultBase.extend({
  kind: z.literal("TurnDeliveryFailed"),
  reason: z.enum(["pane_dead", "agent_not_idle", "transport_error"]),
  turnId: z.string().min(1),
  attempt: AttemptSchema,
  rawError: z.string().min(1),
});

export const ResultWatchFailedSchema = FaultBase.extend({
  kind: z.literal("ResultWatchFailed"),
  artifactPath: z.string().min(1),
  rawError: z.string().min(1),
});

export const ARTIFACT_REJECTION_REASONS = ["symlink", "ownership", "world_writable", "stale_mtime", "path_escape", "oversize"] as const;
export const ArtifactRejectedSchema = FaultBase.extend({
  kind: z.literal("ArtifactRejected"),
  reason: z.enum(ARTIFACT_REJECTION_REASONS),
  artifactPath: z.string().min(1),
  observed: z.string().optional(),
  limit: z.string().optional(),
});

export const ReconnectFailedSchema = FaultBase.extend({
  kind: z.literal("ReconnectFailed"),
  attempts: z.number().int().nonnegative(),
  rawError: z.string().min(1),
});

export const ProtocolMismatchSchema = FaultBase.extend({
  kind: z.literal("ProtocolMismatch"),
  expectedProtocol: z.number().int(),
  observedProtocol: z.number().int().nullable(),
  expectedSchemaVersion: z.number().int(),
  observedSchemaVersion: z.number().int().nullable(),
});

export const DegradedModeEnteredSchema = FaultBase.extend({
  kind: z.literal("DegradedModeEntered"),
  missingIntegrations: z.array(z.string()),
  disabledCapabilities: z.array(z.string()),
});

export const FAULT_KINDS = ["AgentSpawnFailed", "TurnDeliveryFailed", "ResultWatchFailed", "ArtifactRejected", "ReconnectFailed", "ProtocolMismatch", "DegradedModeEntered"] as const;
