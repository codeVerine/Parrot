import { randomUUID } from "node:crypto";
import type { PersistenceStore } from "@platform/persistence";
import type { HumanDecisionInput, WorkflowEngine } from "@platform/workflow-engine";

export type PostDecisionInput = {
  workflowId: string;
  decision: "approved" | "rejected";
  comment?: string;
  /** Explicit per-objection waivers required when approving with open objections. */
  waiveOpenObjections?: boolean;
  waiveObjectionIds?: string[];
  iterationId?: string;
  turnId?: string;
};

/**
 * Post a human decision to the engine and persist human_feedback.
 * Engine remains sole writer of platform events.
 */
export function postHumanDecision(input: {
  engine: WorkflowEngine;
  store: PersistenceStore;
  decision: PostDecisionInput;
}): { phase: string } {
  const payload: HumanDecisionInput = {
    workflowId: input.decision.workflowId,
    decision: input.decision.decision,
    ...(input.decision.comment ? { comment: input.decision.comment } : {}),
    ...(input.decision.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
  };

  const folded = input.engine.humanDecision(payload);

  input.store.saveHumanFeedback({
    feedbackId: `feedback-${randomUUID()}`,
    workflowId: input.decision.workflowId,
    ...(input.decision.iterationId ? { iterationId: input.decision.iterationId } : {}),
    ...(input.decision.turnId ? { turnId: input.decision.turnId } : {}),
    decision: input.decision.decision,
    ...(input.decision.comment ? { comment: input.decision.comment } : {}),
    payload: {
      waiveOpenObjections: Boolean(input.decision.waiveOpenObjections),
      waiveObjectionIds: input.decision.waiveObjectionIds ?? [],
    },
  });

  return { phase: folded.phase };
}
