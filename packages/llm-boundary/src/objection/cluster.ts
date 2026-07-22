import type { MergeResult, ObjectionSeverity } from "@platform/contracts";
import { untrusted, type ClusteredObjection, type MergePostProcessResult, type ObjectionView } from "../types.js";

const SEVERITY_RANK: Record<ObjectionSeverity, number> = {
  minor: 1,
  major: 2,
  blocking: 3,
};

export function maxSeverity(severities: readonly ObjectionSeverity[]): ObjectionSeverity {
  let best: ObjectionSeverity = "minor";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[best]) best = severity;
  }
  return best;
}

/**
 * Deterministic post-processing of a validated merge result.
 * LLM severity is ignored; cluster severity is member maximum.
 * Every input objection is preserved (clustered or standalone).
 */
export function postProcessMerge(
  merge: MergeResult,
  objections: readonly ObjectionView[],
): MergePostProcessResult {
  const byId = new Map(objections.map((item) => [item.id, item]));
  const clusteredIds = new Set<string>();
  const clusters: ClusteredObjection[] = [];

  for (const proposal of merge.clusters) {
    const members = proposal.objectionIds
      .map((id) => byId.get(id))
      .filter((item): item is ObjectionView => item !== undefined);

    for (const member of members) clusteredIds.add(member.id);

    const evidence = members.flatMap((member) => member.evidence);
    clusters.push({
      clusterId: proposal.clusterId,
      objectionIds: members.map((member) => member.id),
      severity: maxSeverity(members.map((member) => member.severity)),
      representativeClaim: untrusted(proposal.representativeClaim),
      ...(proposal.mergeRationale
        ? { mergeRationale: untrusted(proposal.mergeRationale) }
        : {}),
      evidence,
      members,
    });
  }

  const standalone = objections.filter((item) => !clusteredIds.has(item.id));
  return { clusters, standalone };
}

/** Property helper: every input id still retrievable after clustering. */
export function allObjectionIdsPreserved(
  objections: readonly ObjectionView[],
  result: MergePostProcessResult,
): boolean {
  const retained = new Set<string>([
    ...result.standalone.map((item) => item.id),
    ...result.clusters.flatMap((cluster) => cluster.objectionIds),
  ]);
  return objections.every((item) => retained.has(item.id));
}

export function allEvidencePreserved(
  objections: readonly ObjectionView[],
  result: MergePostProcessResult,
): boolean {
  const evidence = new Set<string>([
    ...result.standalone.flatMap((item) => item.evidence),
    ...result.clusters.flatMap((cluster) => cluster.evidence),
  ]);
  return objections.every((item) => item.evidence.every((entry) => evidence.has(entry)));
}
