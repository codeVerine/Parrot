import { z } from "zod";

export const ReviewerObjectionItemSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["blocking", "major", "minor"]),
  claim: z.string().min(1),
  evidence: z.array(z.string()),
  evidence_missing: z.boolean().optional(),
  /** Required under reviewer@1.2.0+ semantic validation; optional for legacy resume. */
  suggestedResolution: z.string().optional(),
});

/**
 * Base Zod contract stays permissive so completed results from older reviewer
 * prompt versions still parse on resume. Fresh Pair turns (reviewer@1.2.0 /
 * adversarial@1.2.0) enforce rich fields in semantic validation.
 */
export const ReviewerResultSchema = z.object({
  role: z.literal("reviewer"),
  reviewedProposalPath: z.string().optional(),
  reviewedProposalHash: z.string().optional(),
  summary: z.string().optional(),
  objections: z.array(ReviewerObjectionItemSchema),
  cleanRationale: z.string().min(1).optional(),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;
export type ReviewerObjectionItem = z.infer<typeof ReviewerObjectionItemSchema>;

const HEX64 = /^[0-9a-f]{64}$/;

export function isProposalContentHash(value: string): boolean {
  return HEX64.test(value);
}
