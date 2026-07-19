import { z } from "zod";

export const SIGNAL_SOURCES = ["herdr_event", "fs_watch", "deadline_timer", "reconcile", "adapter_internal"] as const;
export const SignalSourceSchema = z.enum(SIGNAL_SOURCES);
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SignalCorrelationSchema = z.object({
  workflowId: z.string().min(1).nullable(),
  iterationId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
});

export const SignalEnvelopeSchema = z.object({
  signalId: z.string().min(1),
  observedAt: z.string().datetime(),
  source: SignalSourceSchema,
  workflowId: z.string().min(1).nullable(),
  iterationId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
});

export type SignalEnvelope = z.infer<typeof SignalEnvelopeSchema>;
