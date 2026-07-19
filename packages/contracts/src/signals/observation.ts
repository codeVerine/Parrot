import { z } from "zod";
import { SignalEnvelopeSchema } from "./envelope.js";

export const RAW_HERDR_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
export const CANONICAL_STATUSES = ["idle", "working", "blocked", "unknown"] as const;
export const AttemptSchema = z.enum(["primary", "repair"]);

const ObservationBase = SignalEnvelopeSchema.extend({
  classification: z.literal("observation"),
});

export const HerdrStatusChangedSchema = ObservationBase.extend({
  kind: z.literal("HerdrStatusChanged"),
  rawStatus: z.enum(RAW_HERDR_STATUSES),
  normalizedStatus: z.enum(CANONICAL_STATUSES),
  hints: z.object({ completionCandidate: z.boolean(), resultCheckRequested: z.boolean() }),
});

export const ResultFileSeenSchema = ObservationBase.extend({
  kind: z.literal("ResultFileSeen"),
  artifactPath: z.string().min(1),
  size: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const DeadlineExpiredSchema = ObservationBase.extend({
  kind: z.literal("DeadlineExpired"),
  deadline: z.string().datetime(),
  attempt: AttemptSchema,
});

export const SnapshotReconciledSchema = ObservationBase.extend({
  kind: z.literal("SnapshotReconciled"),
  delta: z.object({
    agentsAdded: z.array(z.string()),
    agentsRemoved: z.array(z.string()),
    statusesCorrected: z.array(z.string()),
    missedResultsFound: z.array(z.string()),
  }),
});

export const OBSERVATION_KINDS = ["HerdrStatusChanged", "ResultFileSeen", "DeadlineExpired", "SnapshotReconciled"] as const;
