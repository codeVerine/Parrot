import type { HumanAutoRule, WorkflowEngineConfig } from "./types.js";

export const DEFAULT_WORKFLOW_CONFIG: WorkflowEngineConfig = {
  maxIterations: 5,
  budgetCap: null,
  reviewerCountPerRound: 2,
  adversarialReviewerEnabled: true,
  frontierPanelSize: 1,
  humanAutoRules: [],
  escalationNotificationTarget: "human",
  defaultRepairDeadlineMs: 300_000,
};

export function withWorkflowConfig(partial: Partial<WorkflowEngineConfig> = {}): WorkflowEngineConfig {
  return {
    ...DEFAULT_WORKFLOW_CONFIG,
    ...partial,
    humanAutoRules: partial.humanAutoRules ?? DEFAULT_WORKFLOW_CONFIG.humanAutoRules,
  };
}

export function parseHumanAutoRules(value: unknown): HumanAutoRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter((rule): rule is HumanAutoRule => {
    if (!rule || typeof rule !== "object") return false;
    const candidate = rule as HumanAutoRule;
    return typeof candidate.id === "string"
      && typeof candidate.version === "number"
      && typeof candidate.predicate === "string"
      && (candidate.action === "approve" || candidate.action === "reject" || candidate.action === "escalate");
  });
}
