import { resolve } from "node:path";
import type { ObjectionView } from "./registry.js";
import type { TurnIdentity } from "./schemas.js";

export function plannerPrompt(args: {
  task: string;
  identity: TurnIdentity;
  promptPath: string;
  planPath: string;
  resultPath: string;
  openObjections: ObjectionView[];
}): string {
  return [
    "# Planner Turn",
    "",
    "Read this prompt and produce a concrete implementation plan.",
    "",
    "## Task",
    args.task,
    "",
    "## Open Objections To Address",
    args.openObjections.length === 0
      ? "None."
      : args.openObjections
          .map((objection) =>
            [
              `- ${objection.id} [${objection.severity}] ${objection.claim}`,
              `  Evidence: ${objection.evidence.length ? objection.evidence.join("; ") : "none"}`,
            ].join("\n"),
          )
          .join("\n"),
    "",
    "## Output Instructions",
    `1. Write the full plan to: ${resolve(args.planPath)}`,
    "2. Address every open objection ID explicitly in the JSON result.",
    `3. Write JSON first to ${resolve(resultTmpPath(args.resultPath))}, then rename it to ${resolve(args.resultPath)}.`,
    "4. Do not write markdown into result.json. It must match this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        runId: args.identity.runId,
        iteration: args.identity.iteration,
        role: "planner",
        turnId: args.identity.turnId,
        payload: {
          planPath: resolve(args.planPath),
          summary: "Short summary of the plan.",
          addressedObjections: args.openObjections.map((objection) => ({
            id: objection.id,
            response: "How the plan addressed this objection.",
            evidence: [],
          })),
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `Prompt path: ${resolve(args.promptPath)}`,
  ].join("\n");
}

export function reviewerPrompt(args: {
  identity: TurnIdentity;
  promptPath: string;
  planPath: string;
  resultPath: string;
  objections: ObjectionView[];
}): string {
  return [
    "# Reviewer Turn",
    "",
    "Review the planner's proposal. Focus on correctness, feasibility, edge cases, maintainability, and evidence.",
    "",
    `Plan path: ${resolve(args.planPath)}`,
    "",
    "## Prior Objections",
    args.objections.length === 0
      ? "None."
      : args.objections
          .map((objection) =>
            [
              `- ${objection.id} [${objection.severity}] status=${objection.status}`,
              `  Claim: ${objection.claim}`,
              `  Evidence: ${objection.evidence.length ? objection.evidence.join("; ") : "none"}`,
            ].join("\n"),
          )
          .join("\n"),
    "",
    "## Output Instructions",
    "1. Mark each prior objection as open or resolved. Do not rename or delete prior objections.",
    "2. Add new objections only when they have concrete evidence or a clear missing-evidence rationale.",
    `3. Write JSON first to ${resolve(resultTmpPath(args.resultPath))}, then rename it to ${resolve(args.resultPath)}.`,
    "4. Do not write markdown into result.json. It must match this shape:",
    "",
    "```json",
    JSON.stringify(
      {
        runId: args.identity.runId,
        iteration: args.identity.iteration,
        role: "reviewer",
        turnId: args.identity.turnId,
        payload: {
          priorObjectionStatuses: args.objections.map((objection) => ({
            id: objection.id,
            status: objection.status,
            rationale: "Why this objection is open or resolved.",
          })),
          newObjections: [],
        },
      },
      null,
      2,
    ),
    "```",
    "",
    `Prompt path: ${resolve(args.promptPath)}`,
  ].join("\n");
}

export function repairPrompt(args: {
  identity: TurnIdentity;
  promptPath: string;
  resultPath: string;
  validationError: string;
}): string {
  return [
    "Your previous result.json was invalid.",
    "",
    "Fix only the JSON result. Do not revise the substantive work unless needed to satisfy the schema.",
    "",
    "Validation error:",
    args.validationError,
    "",
    "The corrected result must use this envelope:",
    "```json",
    JSON.stringify(
      {
        runId: args.identity.runId,
        iteration: args.identity.iteration,
        role: args.identity.role,
        turnId: args.identity.turnId,
        payload: {},
      },
      null,
      2,
    ),
    "```",
    `Write JSON first to ${resolve(resultTmpPath(args.resultPath))}, then rename it to ${resolve(args.resultPath)}.`,
    `Prompt path: ${resolve(args.promptPath)}`,
  ].join("\n");
}

function resultTmpPath(resultPath: string): string {
  return resultPath.replace(/\.json$/, ".tmp");
}
