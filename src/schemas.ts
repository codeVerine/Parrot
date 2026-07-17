import { z } from "zod";

export const RoleSchema = z.enum(["planner", "reviewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const SeveritySchema = z.enum(["blocking", "major", "minor"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ObjectionStatusSchema = z.enum(["open", "resolved"]);
export type ObjectionStatus = z.infer<typeof ObjectionStatusSchema>;

export const EnvelopeSchema = z.object({
  runId: z.string().min(1),
  iteration: z.number().int().positive(),
  role: RoleSchema,
  turnId: z.string().min(1),
});

export const AddressedObjectionSchema = z.object({
  id: z.string().min(1),
  response: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});

export const PlannerPayloadSchema = z.object({
  planPath: z.string().min(1),
  summary: z.string().min(1),
  addressedObjections: z.array(AddressedObjectionSchema),
});

export const PriorObjectionStatusSchema = z.object({
  id: z.string().min(1),
  status: ObjectionStatusSchema,
  rationale: z.string().min(1),
});

export const NewObjectionSchema = z.object({
  severity: SeveritySchema,
  claim: z.string().min(1),
  evidence: z.array(z.string()),
});

export const ReviewerPayloadSchema = z.object({
  priorObjectionStatuses: z.array(PriorObjectionStatusSchema),
  newObjections: z.array(NewObjectionSchema),
});

export const PlannerResultSchema = EnvelopeSchema.extend({
  role: z.literal("planner"),
  payload: PlannerPayloadSchema,
});

export const ReviewerResultSchema = EnvelopeSchema.extend({
  role: z.literal("reviewer"),
  payload: ReviewerPayloadSchema,
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type PlannerResult = z.infer<typeof PlannerResultSchema>;
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;
export type PlannerPayload = z.infer<typeof PlannerPayloadSchema>;
export type ReviewerPayload = z.infer<typeof ReviewerPayloadSchema>;
export type NewObjection = z.infer<typeof NewObjectionSchema>;
export type PriorObjectionStatus = z.infer<typeof PriorObjectionStatusSchema>;

export type TurnIdentity = {
  runId: string;
  iteration: number;
  role: Role;
  turnId: string;
};

export function schemaForRole(role: Role) {
  return role === "planner" ? PlannerResultSchema : ReviewerResultSchema;
}
