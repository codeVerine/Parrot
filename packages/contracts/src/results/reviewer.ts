import { z } from "zod";
export const ReviewerResultSchema = z.object({ role: z.literal("reviewer"), objections: z.array(z.object({ id: z.string().min(1), severity: z.enum(["blocking", "major", "minor"]), claim: z.string().min(1), evidence: z.array(z.string()), evidence_missing: z.boolean().optional() })), cleanRationale: z.string().min(1).optional() });
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;
