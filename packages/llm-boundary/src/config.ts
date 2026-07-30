import type { LlmBoundaryConfig, RoleName } from "./types.js";

export const DEFAULT_LLM_BOUNDARY_CONFIG: LlmBoundaryConfig = {
  rolePromptPins: {
    planner: { rolePromptId: "planner", version: "1.2.0" },
    reviewer: { rolePromptId: "reviewer", version: "1.1.0" },
    adversarial: { rolePromptId: "adversarial", version: "1.1.0" },
    verifier: { rolePromptId: "verifier", version: "1.0.0" },
    merge: { rolePromptId: "merge", version: "1.0.0" },
    "planner-compact": { rolePromptId: "planner-compact", version: "1.0.0" },
    frontier: { rolePromptId: "frontier", version: "1.1.0" },
    implementation: { rolePromptId: "implementation", version: "1.0.0" },
  },
  providerModelByRole: {
    planner: { provider: "anthropic", model: "claude" },
    reviewer: { provider: "openai", model: "codex" },
    adversarial: { provider: "openai", model: "codex" },
    verifier: { provider: "openai", model: "codex" },
    merge: { provider: "openai", model: "cheap" },
    "planner-compact": { provider: "anthropic", model: "claude" },
    frontier: { provider: "anthropic", model: "claude" },
    implementation: { provider: "anthropic", model: "claude" },
  },
  reviewerCountPerRound: 2,
  adversarialCount: 1,
  compactedStateCadenceIterations: 3,
  clusteringBatchSize: 32,
  mergeFailureDegrade: true,
  repairDiagnosticsMaxChars: 2000,
  acceptedSchemaVersions: ["v1"],
};

export function withLlmBoundaryConfig(
  overrides: Partial<LlmBoundaryConfig> = {},
): LlmBoundaryConfig {
  return {
    ...DEFAULT_LLM_BOUNDARY_CONFIG,
    ...overrides,
    rolePromptPins: {
      ...DEFAULT_LLM_BOUNDARY_CONFIG.rolePromptPins,
      ...overrides.rolePromptPins,
    },
    providerModelByRole: {
      ...DEFAULT_LLM_BOUNDARY_CONFIG.providerModelByRole,
      ...overrides.providerModelByRole,
    },
    acceptedSchemaVersions:
      overrides.acceptedSchemaVersions ?? DEFAULT_LLM_BOUNDARY_CONFIG.acceptedSchemaVersions,
  };
}

export function roleForTurnType(turnType: string): RoleName {
  switch (turnType) {
    case "planner_propose":
    case "planner_revise":
      return "planner";
    case "reviewer_review":
      return "reviewer";
    case "adversarial_review":
      return "adversarial";
    case "resolution_verification":
      return "verifier";
    case "objection_merge":
      return "merge";
    case "compacted_state_refresh":
      return "planner-compact";
    case "frontier_report":
      return "frontier";
    case "implementation":
      return "implementation";
    case "repair":
      throw new Error("repair turn type requires originalTurnType to resolve role");
    default:
      throw new Error(`Unknown turn type: ${turnType}`);
  }
}
