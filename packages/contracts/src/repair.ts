export const MAX_REPAIR_ATTEMPTS = 1 as const;
export const REPAIR_ARTIFACT_NAME = "repair-prompt.md" as const;

export type RepairAttempt = "primary" | "repair";

export const repairFailure = {
  validation: "validation_failed",
  secondFailure: "second_validation_failed",
} as const;
