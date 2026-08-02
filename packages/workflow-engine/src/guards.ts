import type { FoldedState, HumanAutoRule, WorkflowEngineConfig } from "./types.js";

export function openObjectionIds(state: FoldedState): string[] {
  return Object.values(state.objections)
    .filter((objection) => objection.status === "open")
    .map((objection) => objection.objectionId)
    .sort();
}

export function hasOpenObjections(state: FoldedState): boolean {
  return openObjectionIds(state).length > 0;
}

/** Open objections that meet or exceed the workflow's stalemate re-raise threshold. */
export function stalemateObjectionIds(state: FoldedState): string[] {
  const threshold = state.stalemateReraiseThreshold ?? 1;
  return Object.values(state.objections)
    .filter((objection) => objection.status === "open" && objection.reraiseCount >= threshold)
    .map((objection) => objection.objectionId)
    .sort();
}

export function underIterationCap(state: FoldedState, config: WorkflowEngineConfig): boolean {
  return state.iterationCount < config.maxIterations;
}

export function underBudgetCap(state: FoldedState, config: WorkflowEngineConfig): boolean {
  if (config.budgetCap === null) return true;
  return state.spendTotal < config.budgetCap;
}

export function frontierHasBlockingFindings(state: FoldedState): boolean {
  return state.frontierBlocking;
}

export type HumanRuleMatch = { action: HumanAutoRule["action"]; rule: HumanAutoRule } | { action: "ask_human"; rule: null };

export function evaluateHumanRulePredicate(predicate: string, state: FoldedState): boolean {
  switch (predicate) {
    case "noOpenObjections":
      return !hasOpenObjections(state);
    case "hasOpenObjections":
      return hasOpenObjections(state);
    case "always":
      return true;
    default:
      return false;
  }
}

/** Absent matching rule means ask the human. */
export function humanRuleAllows(state: FoldedState, config: WorkflowEngineConfig): HumanRuleMatch {
  for (const rule of config.humanAutoRules) {
    if (evaluateHumanRulePredicate(rule.predicate, state)) {
      return { action: rule.action, rule };
    }
  }
  return { action: "ask_human", rule: null };
}

/** Mechanical traceability: every guard field maps to at least one event kind. */
export const GUARD_INPUT_EVENTS = {
  objectionStatus: ["ObjectionRaised", "ObjectionResolved", "HumanApproved"],
  iterationCount: ["IterationCapReached", "ObjectionRaised", "TurnCompleted"],
  spendTotal: ["UsageRecorded"],
  frontierBlocking: ["ObjectionRaised", "TurnCompleted"],
  humanDecision: ["HumanApproved", "HumanRejected", "ConsensusReached"],
  degradedMode: ["ImplementationBlocked"],
  stalemateReraiseThreshold: ["StalemateContinued", "ObjectionStalemate"],
} as const;
