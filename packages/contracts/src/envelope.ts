import { z } from "zod";

export const SchemaVersionSchema = z.string().regex(/^v\d+$/, "schemaVersion must use v<major>");

export const ResultEnvelopeSchema = z.object({
  workflowId: z.string().min(1),
  iterationId: z.string().min(1),
  turnId: z.string().min(1),
  schemaVersion: SchemaVersionSchema,
  nonce: z.string().min(1),
  role: z.string().min(1),
  payload: z.record(z.unknown()),
});

export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

export type EnvelopeExpectation = {
  workflowId: string;
  iterationId: string;
  turnId: string;
  nonce: string;
};

export function rejectEnvelopeMismatch(
  envelope: Pick<ResultEnvelope, "workflowId" | "iterationId" | "turnId">,
  expected: Pick<EnvelopeExpectation, "workflowId" | "iterationId" | "turnId">,
): string | null {
  const fields = ["workflowId", "iterationId", "turnId"] as const;
  const mismatch = fields.find((field) => envelope[field] !== expected[field]);
  return mismatch ? `Envelope field ${mismatch} does not match the active turn.` : null;
}

export function rejectMissingNonce(envelope: Pick<ResultEnvelope, "nonce">): string | null {
  return envelope.nonce.trim() ? null : "Result envelope is missing its turn nonce.";
}

export function rejectStaleTurn(
  envelope: Pick<ResultEnvelope, "turnId">,
  activeTurnId: string,
): string | null {
  return envelope.turnId === activeTurnId ? null : "Result belongs to a stale turn.";
}
