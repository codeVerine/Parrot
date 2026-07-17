import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { askRoundGate, askTimeoutGate } from "./gate.js";
import { checkHerdrStatus, notify, resolveTarget, sendInstruction } from "./herdr.js";
import { plannerPrompt, repairPrompt, reviewerPrompt } from "./prompts.js";
import {
  applyReviewerPayload,
  createInitialState,
  currentObjections,
  openBlockingObjections,
  openObjections,
  writeStateAtomic,
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

async function main(): Promise<void> {
  const taskPath = process.argv[2];
  if (!taskPath) {
    throw new Error("Usage: pnpm exec tsx src/orchestrate.ts <task.md>");
  }

  await checkHerdrStatus();

  const runId = createRunId();
  const runDir = resolve("runs", runId);
  const statePath = resolve(runDir, "state.json");
  await mkdir(runDir, { recursive: true });

  const panes = {
    planner: await resolveTarget("planner"),
    reviewer: await resolveTarget("reviewer"),
  };

  let state = createInitialState(runId, panes);
  await writeStateAtomic(statePath, state);
  printResolvedPanes(state);

  const task = await readFile(resolve(taskPath), "utf8");
  const maxIterations = Number(process.env.PARROT_MAX_ITERATIONS ?? DEFAULT_MAX_ITERATIONS);
  const timeoutMs = Number(process.env.PARROT_TURN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    state.iteration = iteration;
    await writeStateAtomic(statePath, state);

    const planner = await runPlannerTurn({ state, statePath, task, iteration, timeoutMs });
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
    await notify(`Parrot: round ${iteration} done`).catch((error) => {
      console.warn(`Notification failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    const blockers = openBlockingObjections(state);
    const choice = await askRoundGate(blockers.length > 0);
    if (choice === "approve") {
      console.log(`Approved. Final plan: ${planner.payload.planPath}`);
      return;
    }
    if (choice === "quit") {
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
    `Read ${args.promptPath} and write the requested result.json. turnId=${args.identity.turnId}`,
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
    `Read ${repairPath} and write the corrected result.json. turnId=${repairIdentity.turnId}`,
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
    resultPath: resolve(dir, "result.json"),
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
