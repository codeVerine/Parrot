import type { MergeResult } from "@platform/contracts";
import type { LlmBoundaryConfig, MergePostProcessResult, ObjectionView } from "../types.js";
import {
  allEvidencePreserved,
  allObjectionIdsPreserved,
  postProcessMerge,
} from "./cluster.js";
import { applyObjectionTransition, type LifecycleActor } from "./lifecycle.js";
import type { ObjectionStatus } from "@platform/contracts";

export class ObjectionEngine {
  constructor(private readonly config: LlmBoundaryConfig) {}

  /**
   * Apply a validated merge payload. On structural emptiness, returns all
   * objections as standalone. Callers handle merge-turn TurnFailed via
   * `config.mergeFailureDegrade` (proceed unmerged).
   */
  cluster(merge: MergeResult, objections: readonly ObjectionView[]): MergePostProcessResult {
    const batch = objections.slice(0, this.config.clusteringBatchSize);
    const result = postProcessMerge(merge, batch);
    if (!allObjectionIdsPreserved(batch, result) || !allEvidencePreserved(batch, result)) {
      throw new Error("merge post-process violated non-destructive invariants");
    }
    return result;
  }

  /** Degradation path when merge turn failed: every objection stays standalone. */
  degradeUnmerged(objections: readonly ObjectionView[]): MergePostProcessResult {
    return { clusters: [], standalone: [...objections] };
  }

  transition(input: {
    current: ObjectionStatus;
    requested: ObjectionStatus | "verifier_reject";
    actor: LifecycleActor;
  }) {
    return applyObjectionTransition(input);
  }
}
