import { z } from "zod";

export const ObjectionAddressalSchema = z.object({
  objectionId: z.string().min(1),
  resolutionStrategy: z.enum(["revised_plan", "retracted", "conceded"]),
  evidence: z.string().min(1), // exact quote from proposal.md or pasted code
  requiresGuardrailException: z.boolean(),
}).strict();
export type ObjectionAddressal = z.infer<typeof ObjectionAddressalSchema>;

/**
 * Structured citation of an existing repository interface the plan depends on.
 * Optional on PlannerResult so pre-citation result.toon files still resume.
 * The orchestrator verifies each citation against the working tree.
 */
export const CodeCitationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** Exact quote from the cited lines; min length blocks trivial one-char matches. */
  quote: z.string().min(10),
}).strict().refine((value) => value.startLine <= value.endLine, {
  message: "startLine must be <= endLine",
});
export type CodeCitation = z.infer<typeof CodeCitationSchema>;

/**
 * Pre-Phase-10 planner results wrote a bare objection ID with no strategy
 * or evidence. Normalize so resume.ts can still re-read a result.toon
 * written before this phase, but mark the entry as legacy so callers
 * (e.g. the review loop) can avoid persisting it as a real decision.
 *
 * The marker rides on the parsed object as a non-enumerable field so the
 * JSON round-trip stays clean. The structured schema's `evidence` field
 * has `min(1)`, so a legacy entry's empty evidence would never validate
 * against it; the union is what allows the entry to parse at all.
 */
const LegacyObjectionIdSchema = z.string().min(1).transform((objectionId): ObjectionAddressal & { __legacy: true } => {
  const entry = {
    objectionId,
    resolutionStrategy: "revised_plan" as const,
    evidence: "",
    requiresGuardrailException: false,
  };
  Object.defineProperty(entry, "__legacy", { value: true, enumerable: false });
  return entry as ObjectionAddressal & { __legacy: true };
});

export const PlannerResultSchema = z.object({
  role: z.literal("planner"),
  proposalPath: z.string().min(1),
  summary: z.string().min(1),
  objectionsAddressed: z.array(z.union([ObjectionAddressalSchema, LegacyObjectionIdSchema])),
  citations: z.array(CodeCitationSchema).optional(),
});
export type PlannerResult = z.infer<typeof PlannerResultSchema>;
