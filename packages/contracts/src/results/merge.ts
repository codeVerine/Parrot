import { z } from "zod";

/** LLM-facing merge payload. Severity is never trusted from this output. */
export const MergeClusterProposalSchema = z.object({
  clusterId: z.string().min(1),
  /** Min size enforced here; validateMergeStructure checks ID set rules. */
  objectionIds: z.array(z.string().min(1)).min(2),
  representativeClaim: z.string().min(1),
  mergeRationale: z.string().optional(),
  /** Ignored by post-processing; retained only for additive decode compat. */
  severity: z.enum(["blocking", "major", "minor"]).optional(),
});

export const MergeResultSchema = z.object({
  role: z.literal("merge"),
  clusters: z.array(MergeClusterProposalSchema),
});

export type MergeClusterProposal = z.infer<typeof MergeClusterProposalSchema>;
export type MergeResult = z.infer<typeof MergeResultSchema>;

export type MergeStructureIssue =
  | { code: "invented_id"; clusterId: string; objectionId: string }
  | { code: "duplicate_across_clusters"; objectionId: string };

/**
 * Structural rules for merge results against the candidate input ID set.
 * Empty cluster list is valid (nothing merged).
 * Cluster size ≥ 2 is owned by MergeClusterProposalSchema.min(2).
 */
export function validateMergeStructure(
  result: MergeResult,
  inputObjectionIds: ReadonlySet<string> | readonly string[],
): MergeStructureIssue[] {
  const input = inputObjectionIds instanceof Set
    ? inputObjectionIds
    : new Set(inputObjectionIds);
  const issues: MergeStructureIssue[] = [];
  const seen = new Set<string>();

  for (const cluster of result.clusters) {
    for (const objectionId of cluster.objectionIds) {
      if (!input.has(objectionId)) {
        issues.push({ code: "invented_id", clusterId: cluster.clusterId, objectionId });
      }
      if (seen.has(objectionId)) {
        issues.push({ code: "duplicate_across_clusters", objectionId });
      } else {
        seen.add(objectionId);
      }
    }
  }

  return issues;
}
