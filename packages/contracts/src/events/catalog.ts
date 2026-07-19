import { z } from "zod";

const CorrelationSchema = z.object({
  workflowId: z.string().min(1),
  iterationId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

const BaseEventSchema = CorrelationSchema.extend({
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
});

const event = <K extends string>(kind: K, payload: z.ZodRawShape = {}) =>
  BaseEventSchema.extend({ kind: z.literal(kind), payload: z.object(payload) });

// The first twelve entries are the approved Phase 1 catalog. The last two are
// additive revisions approved by the Phase 4 and Phase 7 plans respectively.
export const EVENT_KINDS = [
  "TurnCompleted",
  "TurnFailed",
  "AgentTimedOut",
  "ObjectionRaised",
  "ObjectionResolved",
  "ConsensusReached",
  "HumanApproved",
  "HumanRejected",
  "ImplementationBlocked",
  "BudgetCapReached",
  "IterationCapReached",
  "OrphanResultSeen",
  "UsageRecorded",
  "VerificationCompleted",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const EventSchemas = {
  TurnCompleted: event("TurnCompleted", { resultHash: z.string().min(1) }),
  TurnFailed: event("TurnFailed", { reason: z.string().min(1) }),
  AgentTimedOut: event("AgentTimedOut", { deadline: z.string().datetime() }),
  ObjectionRaised: event("ObjectionRaised", { objectionId: z.string().min(1), severity: z.enum(["blocking", "major", "minor"]) }),
  ObjectionResolved: event("ObjectionResolved", { objectionId: z.string().min(1), resolution: z.string().min(1) }),
  ConsensusReached: event("ConsensusReached", { objectionIds: z.array(z.string()) }),
  HumanApproved: event("HumanApproved", { comment: z.string().optional() }),
  HumanRejected: event("HumanRejected", { comment: z.string().min(1) }),
  ImplementationBlocked: event("ImplementationBlocked", { reason: z.string().min(1) }),
  BudgetCapReached: event("BudgetCapReached", { cap: z.number().nonnegative() }),
  IterationCapReached: event("IterationCapReached", { cap: z.number().int().positive() }),
  OrphanResultSeen: event("OrphanResultSeen", { artifactPath: z.string().min(1), contentHash: z.string().min(1) }),
  UsageRecorded: event("UsageRecorded", { inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cost: z.number().nonnegative() }),
  VerificationCompleted: event("VerificationCompleted", {
    attempt: z.number().int().positive(),
    outcome: z.enum(["passed", "failed"]),
    commands: z.array(z.object({ command: z.string().min(1), contentHash: z.string().min(1), exitCode: z.number().int() })),
    logArtifacts: z.array(z.object({ path: z.string().min(1), contentHash: z.string().min(1) })),
  }),
} satisfies Record<EventKind, z.ZodTypeAny>;

export const EventSchema = z.discriminatedUnion(
  "kind",
  EVENT_KINDS.map((kind) => EventSchemas[kind]) as unknown as [z.ZodDiscriminatedUnionOption<"kind">, ...z.ZodDiscriminatedUnionOption<"kind">[]],
);

export type PlatformEvent = z.infer<typeof EventSchema>;
export { CorrelationSchema, BaseEventSchema };
