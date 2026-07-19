import { z } from "zod";

export const ObjectionSeveritySchema = z.enum(["blocking", "major", "minor"]);
export type ObjectionSeverity = z.infer<typeof ObjectionSeveritySchema>;
export const ObjectionStatusSchema = z.enum(["open", "accepted", "rejected", "superseded", "resolved", "waived"]);
export type ObjectionStatus = z.infer<typeof ObjectionStatusSchema>;

export const LEGAL_OBJECTION_TRANSITIONS: Record<ObjectionStatus, readonly ObjectionStatus[]> = {
  open: ["accepted", "rejected", "superseded", "resolved", "waived"],
  accepted: ["resolved", "superseded", "waived"],
  rejected: ["open", "superseded"],
  superseded: [],
  resolved: ["superseded"],
  waived: ["superseded"],
};

export function isLegalObjectionTransition(from: ObjectionStatus, to: ObjectionStatus): boolean {
  return LEGAL_OBJECTION_TRANSITIONS[from].includes(to);
}

export const ObjectionSchema = z.object({
  id: z.string().min(1),
  dimension: z.string().min(1),
  severity: ObjectionSeveritySchema,
  claim: z.string().min(1),
  evidence: z.array(z.string()),
  evidence_missing: z.boolean().optional(),
  status: ObjectionStatusSchema,
  raisedBy: z.string().min(1),
  turnId: z.string().min(1),
});

export const ObjectionClusterSchema = z.object({
  clusterId: z.string().min(1),
  objectionIds: z.array(z.string().min(1)).min(1),
  severity: ObjectionSeveritySchema,
});
