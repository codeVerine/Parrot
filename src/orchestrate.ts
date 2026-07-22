import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { encodeToon } from "@platform/contracts";
import { askRoundGate, askTimeoutGate } from "./gate.js";
import { checkHerdrStatus, notify, resolveTarget, sendInstruction } from "./herdr.js";
import { plannerPrompt, repairPrompt, reviewerPrompt } from "./prompts.js";
import {
  applyReviewerPayload,
  createInitialState,
  currentObjections,
  openObjections,
  writeStateAtomic,
  type ObjectionView,
  type State,
} from "./registry.js";
import type { PlannerResult, ReviewerResult, Role, TurnIdentity } from "./schemas.js";
import { prepareResultPath, waitForResult } from "./waitResult.js";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ITERATIONS = 5;

type TurnPaths = {
  dir: string;
  promptPath: string;
  resultPath: string;
  planPath?: string;
};

type HumanMessage = {
  afterIteration: number;
  message: string;
};

type TaskInput = {
  task: string;
  artifactSlug: string;
  sourceDescription: string;
};

async function main(): Promise<void> {
  const taskInput = await readTaskInput(process.argv.slice(2));

  await checkHerdrStatus();

  const runId = createRunId();
  const runDir = resolve("runs", runId);
  const statePath = resolve(runDir, "state.toon");
  await mkdir(runDir, { recursive: true });

  const panes = {
    planner: await resolveTarget("planner"),
    reviewer: await resolveTarget("reviewer"),
  };

  let state = createInitialState(runId, panes);
  await writeStateAtomic(statePath, state);
  printResolvedPanes(state);

  let maxIterations = Number(process.env.PARROT_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS);
  const timeoutMs = Number(process.env.PARROT_TURN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const humanMessages: HumanMessage[] = [];
  console.log(`Task input: ${taskInput.sourceDescription}`);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    state.iteration = iteration;
    await writeStateAtomic(statePath, state);

    const planner = await runPlannerTurn({
      state,
      statePath,
      task: taskInput.task,
      iteration,
      timeoutMs,
      humanMessages,
    });
    if (!planner) {
      return;
    }

    const missingResponses = missingAddressedObjections(state, planner);
    if (missingResponses.length > 0) {
      console.log(`Planner did not address open objections: ${missingResponses.join(", ")}`);
      const choice = await askTimeoutGate();
      if (choice === "retry") {
        iteration -= 1;
        continue;
      }
      return;
    }

    const reviewer = await runReviewerTurn({ state, statePath, iteration, timeoutMs });
    if (!reviewer) {
      return;
    }

    applyReviewerPayload(
      state,
      iteration,
      reviewer.payload.priorObjectionStatuses,
      reviewer.payload.newObjections,
    );
    await writeStateAtomic(statePath, state);

    printRoundSummary(state);
    printRoundArtifacts({ runId: state.runId, iteration, planner, statePath });
    await notify(`Parrot: round ${iteration} done`).catch((error) => {
      console.warn(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    const open = openObjections(state);
    const iterationCapReached = iteration >= maxIterations;
    if (open.length > 0 && !iterationCapReached) {
      const counts = objectionCounts(open);
      console.log(
        `Open objections remain (${open.length}: ${counts.blocking} blocking, ` +
          `${counts.major} major, ${counts.minor} minor). Continuing automatically.`,
      );
      continue;
    }

    const choice = await askRoundGate(open.length);
    if (choice.action === "approve") {
      const approved = await publishApprovedPlan({
        artifactSlug: taskInput.artifactSlug,
        task: taskInput.task,
        state,
        planner,
        openObjections: open,
      });
      printApprovalSummary({ approved, openObjections: open });
      return;
    }
    if (choice.action === "message") {
      humanMessages.push({ afterIteration: iteration, message: choice.message });
      console.log("Message recorded. It will be included in the next planner turn.");
      if (iterationCapReached) {
        maxIterations += 1;
      }
      continue;
    }
    if (choice.action === "continue" && iterationCapReached) {
      maxIterations += 1;
      console.log("Continuing for one more round.");
      continue;
    }
    if (choice.action === "continue") {
      continue;
    }
    if (choice.action === "quit") {
      console.log("Stopped by user.");
      return;
    }
  }

  console.log(`Iteration cap reached (${maxIterations}).`);
  printRoundSummary(state);
}

async function runPlannerTurn(args: {
  state: State;
  statePath: string;
  task: string;
  iteration: number;
  timeoutMs: number;
  humanMessages: HumanMessage[];
}): Promise<PlannerResult | null> {
  const paths = turnPaths(args.state.runId, args.iteration, "planner");
  await mkdir(paths.dir, { recursive: true });

  const identity = createTurnIdentity(args.state.runId, args.iteration, "planner");
  await writeFile(
    paths.promptPath,
    plannerPrompt({
      task: args.task,
      identity,
      promptPath: paths.promptPath,
      planPath: paths.planPath!,
      resultPath: paths.resultPath,
      openObjections: openObjections(args.state),
      humanMessages: args.humanMessages,
    }),
    "utf8",
  );

  return sendAndWait<PlannerResult>({
    role: "planner",
    paneId: args.state.panes.planner.paneId,
    identity,
    promptPath: paths.promptPath,
    resultPath: paths.resultPath,
    timeoutMs: args.timeoutMs,
  });
}

async function runReviewerTurn(args: {
  state: State;
  statePath: string;
  iteration: number;
  timeoutMs: number;
}): Promise<ReviewerResult | null> {
  const paths = turnPaths(args.state.runId, args.iteration, "reviewer");
  const plannerPaths = turnPaths(args.state.runId, args.iteration, "planner");
  await mkdir(paths.dir, { recursive: true });

  const identity = createTurnIdentity(args.state.runId, args.iteration, "reviewer");
  await writeFile(
    paths.promptPath,
    reviewerPrompt({
      identity,
      promptPath: paths.promptPath,
      planPath: plannerPaths.planPath!,
      resultPath: paths.resultPath,
      objections: currentObjections(args.state),
    }),
    "utf8",
  );

  return sendAndWait<ReviewerResult>({
    role: "reviewer",
    paneId: args.state.panes.reviewer.paneId,
    identity,
    promptPath: paths.promptPath,
    resultPath: paths.resultPath,
    timeoutMs: args.timeoutMs,
  });
}

async function sendAndWait<T>(args: {
  role: Role;
  paneId: string;
  identity: TurnIdentity;
  promptPath: string;
  resultPath: string;
  timeoutMs: number;
}): Promise<T | null> {
  let sentAt = await prepareResultPath(args.resultPath);
  await sendInstruction(
    args.paneId,
    `Read ${args.promptPath} and write the requested result.toon. turnId=${args.identity.turnId}`,
  );

  let outcome = await waitForResult<T>(args.resultPath, args.identity, sentAt, args.timeoutMs);
  if (outcome.ok) {
    return outcome.result;
  }

  if (outcome.reason === "timeout") {
    const choice = await askTimeoutGate();
    if (choice !== "retry") {
      return null;
    }
    return sendAndWait<T>(args);
  }

  const repairIdentity = { ...args.identity, turnId: createTurnId() };
  const repairPath = resolve(dirname(args.promptPath), "repair-prompt.md");
  await writeFile(
    repairPath,
    repairPrompt({
      identity: repairIdentity,
      promptPath: repairPath,
      resultPath: args.resultPath,
      validationError: outcome.message,
    }),
    "utf8",
  );

  sentAt = await prepareResultPath(args.resultPath);
  await sendInstruction(
    args.paneId,
    `Read ${repairPath} and write the corrected result.toon. turnId=${repairIdentity.turnId}`,
  );
  outcome = await waitForResult<T>(args.resultPath, repairIdentity, sentAt, args.timeoutMs);
  if (outcome.ok) {
    return outcome.result;
  }

  console.error(`Second ${args.role} result failure: ${outcome.message}`);
  return null;
}

function turnPaths(runId: string, iteration: number, role: Role): TurnPaths {
  const dir = resolve("runs", runId, `iter-${iteration}`, role);
  return {
    dir,
    promptPath: resolve(dir, "prompt.md"),
    resultPath: resolve(dir, "result.toon"),
    planPath: role === "planner" ? resolve(dir, "plan.md") : undefined,
  };
}

function createTurnIdentity(runId: string, iteration: number, role: Role): TurnIdentity {
  return {
    runId,
    iteration,
    role,
    turnId: createTurnId(),
  };
}

function createRunId(): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function createTurnId(): string {
  return randomBytes(8).toString("hex");
}

async function publishApprovedPlan(args: {
  artifactSlug: string;
  task: string;
  state: State;
  planner: PlannerResult;
  openObjections: ObjectionView[];
}): Promise<ApprovedPlan> {
  const dir = resolve("approved-plans", `${args.artifactSlug}-${args.state.runId}`);
  const planFileName = approvedPlanFileName({
    artifactSlug: args.artifactSlug,
    task: args.task,
    plannerSummary: args.planner.payload.summary,
  });
  const planPath = resolve(dir, planFileName);
  const approvalPath = resolve(dir, "approval.toon");

  await mkdir(dir, { recursive: true });
  await copyFile(args.planner.payload.planPath, planPath);
  await writeFile(
    approvalPath,
    encodeToon({
      runId: args.state.runId,
      iteration: args.state.iteration,
      approvedAt: new Date().toISOString(),
      finalPlanPath: planPath,
      sourcePlanPath: args.planner.payload.planPath,
      openObjections: {
        total: args.openObjections.length,
        blocking: args.openObjections.filter((objection) => objection.severity === "blocking").length,
        major: args.openObjections.filter((objection) => objection.severity === "major").length,
        minor: args.openObjections.filter((objection) => objection.severity === "minor").length,
      },
    }),
    "utf8",
  );

  return {
    dir,
    planPath,
    approvalPath,
    sourcePlanPath: args.planner.payload.planPath,
    runId: args.state.runId,
    iteration: args.state.iteration,
  };
}

type ApprovedPlan = {
  dir: string;
  planPath: string;
  approvalPath: string;
  sourcePlanPath: string;
  runId: string;
  iteration: number;
};

async function readTaskInput(args: string[]): Promise<TaskInput> {
  if (args.length === 0) {
    throw new Error("Usage: pnpm exec tsx src/orchestrate.ts <prompt text | task.md> [more prompt text]");
  }

  const files: Array<{ path: string; content: string }> = [];
  const promptParts: string[] = [];

  for (const arg of args) {
    const file = await tryReadTaskFile(arg);
    if (file) {
      files.push(file);
    } else {
      promptParts.push(arg);
    }
  }

  const prompt = promptParts.join(" ").trim();
  const sections = [
    ...files.map((file) => [`## Task File: ${file.path}`, file.content.trim()].join("\n\n")),
    ...(prompt ? [["## Invocation Prompt", prompt].join("\n\n")] : []),
  ];

  if (sections.length === 0) {
    throw new Error("Provide a prompt, a readable task file, or both.");
  }

  const artifactSlug =
    files.length > 0 ? taskSlug(files[0].path) : slugFromText(prompt) || "prompt";

  return {
    task: sections.join("\n\n").trim(),
    artifactSlug,
    sourceDescription: describeTaskInput(files.map((file) => file.path), prompt),
  };
}

async function tryReadTaskFile(path: string): Promise<{ path: string; content: string } | null> {
  const resolvedPath = resolve(path);

  try {
    return {
      path: resolvedPath,
      content: await readFile(resolvedPath, "utf8"),
    };
  } catch (error) {
    if (isMissingFileError(error) || isDirectoryError(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isDirectoryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EISDIR";
}

function describeTaskInput(files: string[], prompt: string): string {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(`file${files.length === 1 ? "" : "s"} ${files.join(", ")}`);
  }
  if (prompt) {
    parts.push("inline prompt");
  }
  return parts.join(" + ");
}

function taskSlug(taskPath: string): string {
  const name = basename(taskPath, extname(taskPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return name || "approved-plan";
}

function approvedPlanFileName(args: {
  artifactSlug: string;
  task: string;
  plannerSummary: string;
}): string {
  const slug = slugFromText(args.plannerSummary) || slugFromText(args.task) || args.artifactSlug;
  return `plan-${slug}.md`;
}

function slugFromText(text: string): string {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "for",
    "in",
    "of",
    "on",
    "the",
    "this",
    "to",
    "with",
  ]);
  const genericWords = new Set(["implementation", "plan", "proposal", "summary"]);
  const words = text
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !stopWords.has(word) && !genericWords.has(word))
    .slice(0, 8);

  return words.join("-");
}

function missingAddressedObjections(state: State, planner: PlannerResult): string[] {
  const addressed = new Set(planner.payload.addressedObjections.map((item) => item.id));
  return openObjections(state)
    .map((objection) => objection.id)
    .filter((id) => !addressed.has(id));
}

function printResolvedPanes(state: State): void {
  console.log("Resolved Herdr panes:");
  for (const pane of Object.values(state.panes)) {
    console.log(`- ${pane.role}: pane=${pane.paneId} agent=${pane.agent ?? "unknown"} cwd=${pane.cwd ?? "unknown"}`);
  }
}

function printRoundSummary(state: State): void {
  const rows = currentObjections(state);
  if (rows.length === 0) {
    console.log("No objections.");
    return;
  }

  console.table(
    rows.map((objection) => ({
      id: objection.id,
      severity: objection.severity,
      status: objection.status,
      claim: objection.claim,
    })),
  );
}

function printRoundArtifacts(args: {
  runId: string;
  iteration: number;
  planner: PlannerResult;
  statePath: string;
}): void {
  const plannerPaths = turnPaths(args.runId, args.iteration, "planner");
  const reviewerPaths = turnPaths(args.runId, args.iteration, "reviewer");

  console.log("Round artifacts:");
  console.log(`- Planner plan: ${args.planner.payload.planPath}`);
  console.log(`- Planner result: ${plannerPaths.resultPath}`);
  console.log(`- Reviewer result: ${reviewerPaths.resultPath}`);
  console.log(`- Run state: ${args.statePath}`);
}

function printApprovalSummary(args: {
  approved: ApprovedPlan;
  openObjections: ObjectionView[];
}): void {
  const counts = objectionCounts(args.openObjections);

  console.log("Approved plan ready:");
  console.log(`- Final plan: ${args.approved.planPath}`);
  console.log(`- Approval metadata: ${args.approved.approvalPath}`);
  console.log(`- Source planner plan: ${args.approved.sourcePlanPath}`);
  console.log(`- Run artifacts: ${resolve("runs", args.approved.runId)}`);

  if (args.openObjections.length === 0) {
    console.log("Approved after consensus: no open objections remain.");
    return;
  }

  console.log(
    `Approved with ${args.openObjections.length} open objection(s): ` +
      `${counts.blocking} blocking, ${counts.major} major, ${counts.minor} minor.`,
  );
}

function objectionCounts(objections: ObjectionView[]): {
  blocking: number;
  major: number;
  minor: number;
} {
  return {
    blocking: objections.filter((objection) => objection.severity === "blocking").length,
    major: objections.filter((objection) => objection.severity === "major").length,
    minor: objections.filter((objection) => objection.severity === "minor").length,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
