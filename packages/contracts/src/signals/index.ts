import { z } from "zod";
import { AgentSpawnFailedSchema, ArtifactRejectedSchema, DegradedModeEnteredSchema, FAULT_KINDS, ProtocolMismatchSchema, ReconnectFailedSchema, ResultWatchFailedSchema, TurnDeliveryFailedSchema } from "./fault.js";
import { DeadlineExpiredSchema, HerdrStatusChangedSchema, OBSERVATION_KINDS, ResultFileSeenSchema, SnapshotReconciledSchema } from "./observation.js";

export { SIGNAL_SOURCES, SignalEnvelopeSchema, SignalCorrelationSchema, SignalSourceSchema, type SignalSource } from "./envelope.js";
export { RAW_HERDR_STATUSES, CANONICAL_STATUSES, AttemptSchema, OBSERVATION_KINDS, HerdrStatusChangedSchema, ResultFileSeenSchema, DeadlineExpiredSchema, SnapshotReconciledSchema } from "./observation.js";
export { ARTIFACT_REJECTION_REASONS, FAULT_KINDS, AgentSpawnFailedSchema, TurnDeliveryFailedSchema, ResultWatchFailedSchema, ArtifactRejectedSchema, ReconnectFailedSchema, ProtocolMismatchSchema, DegradedModeEnteredSchema } from "./fault.js";

// Fault means the adapter failed or refused. Observation means the adapter
// observed something; DeadlineExpired is intentionally an observation.
export const SIGNAL_KINDS = [...OBSERVATION_KINDS, ...FAULT_KINDS] as const;
export const RuntimeSignalSchema = z.discriminatedUnion("kind", [
  HerdrStatusChangedSchema,
  ResultFileSeenSchema,
  DeadlineExpiredSchema,
  SnapshotReconciledSchema,
  AgentSpawnFailedSchema,
  TurnDeliveryFailedSchema,
  ResultWatchFailedSchema,
  ArtifactRejectedSchema,
  ReconnectFailedSchema,
  ProtocolMismatchSchema,
  DegradedModeEnteredSchema,
]);
export type RuntimeSignal = z.infer<typeof RuntimeSignalSchema>;
export type ObservationSignal = Extract<RuntimeSignal, { classification: "observation" }>;
export type FaultSignal = Extract<RuntimeSignal, { classification: "fault" }>;
