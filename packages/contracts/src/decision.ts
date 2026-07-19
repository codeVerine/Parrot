import { z } from "zod";
export const DecisionSchema = z.object({
  decision: z.string().min(1),
  chosen: z.string().min(1),
  alternatives: z.array(z.string()),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.object({ workflowId: z.string().min(1), iterationId: z.string().min(1), turnId: z.string().min(1), objectionIds: z.array(z.string()) }),
});
export type Decision = z.infer<typeof DecisionSchema>;
