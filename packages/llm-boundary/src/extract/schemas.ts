import {
  FrontierResultSchema,
  ImplementationResultSchema,
  MergeResultSchema,
  PlannerResultSchema,
  ResolutionResultSchema,
  ReviewerResultSchema,
} from "@platform/contracts";
import type { ZodTypeAny } from "zod";
import type { TurnType } from "../types.js";

const TURN_RESULT_SCHEMAS: Record<Exclude<TurnType, "repair">, ZodTypeAny> = {
  planner_propose: PlannerResultSchema,
  planner_revise: PlannerResultSchema,
  reviewer_review: ReviewerResultSchema,
  adversarial_review: ReviewerResultSchema,
  resolution_verification: ResolutionResultSchema,
  objection_merge: MergeResultSchema,
  compacted_state_refresh: PlannerResultSchema,
  frontier_report: FrontierResultSchema,
  implementation: ImplementationResultSchema,
};

const TURN_ROLES: Record<Exclude<TurnType, "repair">, string> = {
  planner_propose: "planner",
  planner_revise: "planner",
  reviewer_review: "reviewer",
  adversarial_review: "reviewer",
  resolution_verification: "resolution",
  objection_merge: "merge",
  compacted_state_refresh: "planner",
  frontier_report: "frontier",
  implementation: "implementation",
};

export function assertTurnSchemaCatalogComplete(): void {
  const missing = (Object.keys(TURN_RESULT_SCHEMAS) as Array<keyof typeof TURN_RESULT_SCHEMAS>).filter(
    (key) => !TURN_RESULT_SCHEMAS[key],
  );
  if (missing.length > 0) {
    throw new Error(`Turn types missing result schemas: ${missing.join(", ")}`);
  }
}

export function schemaForTurnType(turnType: TurnType, originalTurnType?: TurnType): ZodTypeAny {
  const resolved = turnType === "repair" ? originalTurnType : turnType;
  if (!resolved || resolved === "repair") {
    throw new Error("schemaForTurnType(repair) requires originalTurnType");
  }
  const schema = TURN_RESULT_SCHEMAS[resolved];
  if (!schema) throw new Error(`No result schema registered for turn type ${resolved}`);
  return schema;
}

export function envelopeRoleForTurnType(turnType: TurnType, originalTurnType?: TurnType): string {
  const resolved = turnType === "repair" ? originalTurnType : turnType;
  if (!resolved || resolved === "repair") {
    throw new Error("envelopeRoleForTurnType(repair) requires originalTurnType");
  }
  return TURN_ROLES[resolved];
}

export function cataloguedTurnTypes(): Array<Exclude<TurnType, "repair">> {
  return Object.keys(TURN_RESULT_SCHEMAS) as Array<Exclude<TurnType, "repair">>;
}

// Fail fast at module load.
assertTurnSchemaCatalogComplete();
