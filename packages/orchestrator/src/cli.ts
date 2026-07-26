import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argv, cwd as processCwd, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  defaultHerdrSocketPath,
  discoverHerdrSocket,
  HerdrAgentRuntime,
  HerdrCommandLine,
  LineSocketTransport,
  Protocol16SocketClient,
  type AgentHandle,
} from "@platform/herdr-adapter";
import { PersistenceStore } from "@platform/persistence";
import { createComposition } from "./composition.js";
import { createHerdrRunner } from "./herdr-runner.js";
import { runReviewLoop, type HumanDecision } from "./loop.js";
import {
  reuseImplementation,
  selectResumeWorkflowId,
  verificationCompleted,
  type ResumeSeed,
} from "./resume.js";

type RoleSpec = { id: string; provider: string; role: string; worktreeRequired: boolean };

const ROLE_SPECS: RoleSpec[] = [
  { id: "planner", provider: env.PARROT_PLANNER_PROVIDER ?? "claude", role: "planner", worktreeRequired: false },
  { id: "reviewer", provider: env.PARROT_REVIEWER_PROVIDER ?? "codex", role: "reviewer", worktreeRequired: false },
  { id: "frontier", provider: env.PARROT_FRONTIER_PROVIDER ?? "claude", role: "frontier", worktreeRequired: false },
  { id: "implementation", provider: env.PARROT_IMPL_PROVIDER ?? "claude", role: "implementation", worktreeRequired: true },
  { id: "verifier", provider: env.PARROT_VERIFIER_PROVIDER ?? "codex", role: "verifier", worktreeRequired: false },
];

async function main(): Promise<void> {
  // The directory agents operate in and every relative path is anchored to. `pnpm`
  // rewrites process.cwd() to the package dir, so INIT_CWD (the shell's dir when the
  // user invoked parrot) is the correct default; PARROT_PROJECT_DIR overrides it.
  const projectDir = resolve(env.PARROT_PROJECT_DIR ?? env.INIT_CWD ?? processCwd());
  const resumeRequest = parseResumeRequest(argv.slice(2));
  const herdrBin = env.HERDR_BIN ?? "herdr";
  const socketPath = await resolveSocketPath(herdrBin);

  const client = new Protocol16SocketClient(new LineSocketTransport(socketPath));
  const cli = new HerdrCommandLine(herdrBin);
  const runtime = await HerdrAgentRuntime.create({ client, cli });

  const workspaceId = env.PARROT_WORKSPACE ?? (await resolveFocusedWorkspace(client));

  // Spawn every agent into a dedicated tab so they do not split the caller's terminal
  // pane down to an unreadable size. PARROT_TAB reuses an existing tab if provided.
  const tabId = env.PARROT_TAB ?? (await client.createTab(workspaceId, "parrot agents", 10_000));

  const handles = new Map<string, AgentHandle>();
  for (const spec of ROLE_SPECS) {
    handles.set(
      spec.id,
      await runtime.start({
        provider: spec.provider,
        role: spec.role,
        workspaceId,
        tabId,
        cwd: projectDir,
        worktreeRequired: spec.worktreeRequired,
      }),
    );
  }

  // Absolute so the paths embedded in each agent's command resolve no matter what
  // directory the agent's shell starts in.
  const runsRoot = resolve(projectDir, env.PARROT_RUNS_ROOT ?? "runs");
  const store = new PersistenceStore({ path: env.PARROT_DB ?? resolve(runsRoot, "parrot.db") });
  const turnMaxMs = env.PARROT_TURN_MAX_MS
    ? Number(env.PARROT_TURN_MAX_MS)
    : env.PARROT_TURN_TIMEOUT_MS
      ? Number(env.PARROT_TURN_TIMEOUT_MS)
      : undefined;
  const turnIdleMs = env.PARROT_TURN_IDLE_TIMEOUT_MS ? Number(env.PARROT_TURN_IDLE_TIMEOUT_MS) : undefined;
  const runner = createHerdrRunner({
    runtime,
    handles,
    ...(turnMaxMs ? { maxMs: turnMaxMs } : {}),
    ...(turnIdleMs ? { idleTimeoutMs: turnIdleMs } : {}),
  });
  const comp = createComposition({
    store,
    runner,
    humanLoopConfig: { notificationSink: "herdr" },
    runsRoot,
  });

  // Resume an interrupted workflow from its persisted state, or start a fresh run. On
  // resume the task comes from the stored workflow row (not the CLI args) and the loop
  // re-enters at the recovered phase instead of replanning from iteration 1.
  let workflowId: string;
  let task: string;
  let resumeSeed: ResumeSeed | undefined;
  if (resumeRequest.requested) {
    workflowId = selectResumeWorkflowId(store, resumeRequest.workflowId);
    resumeSeed = comp.resumeWorkflow(workflowId);
    task = resumeSeed.task;
    console.log(`Resuming workflow ${workflowId} at phase=${resumeSeed.phase}, iteration=${resumeSeed.iteration}.`);
  } else {
    workflowId = env.PARROT_WORKFLOW ?? `wf-${Date.now()}`;
    task = await readTask(resumeRequest.rest, projectDir);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const decide = async (ctx: {
    openObjectionIds: string[];
    frontierReadiness: "ready" | "not_ready" | null;
  }): Promise<HumanDecision> => {
    const answer = (
      await rl.question(
        `Frontier readiness=${ctx.frontierReadiness ?? "-"}, open objections=${ctx.openObjectionIds.length}. approve/reject? `,
      )
    )
      .trim()
      .toLowerCase();
    const approved = answer.startsWith("a");
    return { decision: approved ? "approved" : "rejected", waiveOpenObjections: ctx.openObjectionIds.length > 0 };
  };

  try {
    const review = await runReviewLoop(comp, {
      workflowId,
      workspaceId: resumeSeed?.workspaceId ?? workspaceId,
      task,
      plannerAgentId: "planner",
      reviewerAgentIds: ["reviewer"],
      frontierAgentId: "frontier",
      decide,
      ...(resumeSeed ? { resume: resumeSeed } : {}),
    });
    console.log(`Review loop finished: phase=${review.phase}, iterations=${review.iterations}`);

    if (review.phase === "approved") {
      const iterationId = `${workflowId}-impl`;

      // On resume, reuse a completed implementation turn instead of re-running it.
      const reused = reuseImplementation(store, workflowId, iterationId);
      let implTurnId: string | undefined;
      let implSummary: string | undefined;
      if (reused) {
        implTurnId = reused.turnId;
        implSummary = reused.summary;
        console.log("Implementation: reused (completed before interruption)");
      } else {
        const impl = await comp.runImplementation({
          workflowId,
          iterationId,
          agentId: "implementation",
          task,
          ...(review.finalProposalPath ? { proposalPath: review.finalProposalPath } : {}),
        });
        console.log(`Implementation: ${impl.status}`);
        if (impl.status === "completed") {
          implTurnId = impl.turnId;
          implSummary = impl.summary;
        }
      }

      if (implTurnId !== undefined && implSummary !== undefined) {
        if (verificationCompleted(store, workflowId, iterationId, implTurnId)) {
          console.log("Verification: reused (completed before interruption)");
          store.updatePostReviewStage(workflowId, "complete");
        } else {
          const verify = await comp.runVerification({
            workflowId,
            iterationId,
            agentId: "verifier",
            targetTurnId: implTurnId,
            summary: implSummary,
            evidence: [],
          });
          console.log(`Verification: ${verify.status}`);
        }
      }
    }
    await comp.flush();
  } finally {
    rl.close();
    await runtime.close();
  }
}

/**
 * Locate the Herdr daemon socket without manual setup: explicit override first, then
 * ask the running daemon, then the conventional default-session path. A manual
 * HERDR_SOCKET always wins so custom/named sessions stay addressable.
 */
async function resolveSocketPath(herdrBin: string): Promise<string> {
  if (env.HERDR_SOCKET) return env.HERDR_SOCKET;
  const discovered = await discoverHerdrSocket(herdrBin);
  if (discovered) return discovered;
  const fallback = defaultHerdrSocketPath();
  if (existsSync(fallback)) return fallback;
  throw new Error(
    "Could not find a running Herdr daemon. Launch `herdr` first, or set HERDR_SOCKET to its socket path (see `herdr status server`).",
  );
}

async function resolveFocusedWorkspace(client: Protocol16SocketClient): Promise<string> {
  const snapshot = await client.sessionSnapshot(10_000);
  const id = snapshot.workspace_id;
  if (!id) throw new Error("No focused Herdr workspace found; set PARROT_WORKSPACE to an id from `herdr workspace list`.");
  return id;
}

/**
 * Detect a resume request from `--resume [workflowId]` in the CLI args or the
 * `PARROT_RESUME` env var, and return the remaining args (the task input for a fresh
 * run). A bare `--resume` / truthy `PARROT_RESUME` auto-selects the newest resumable
 * workflow; an explicit id targets one run.
 */
function parseResumeRequest(args: string[]): { requested: boolean; workflowId?: string; rest: string[] } {
  const rest: string[] = [];
  let requested = false;
  let workflowId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--resume") {
      requested = true;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        workflowId = next;
        i += 1;
      }
      continue;
    }
    rest.push(args[i]!);
  }
  const envResume = env.PARROT_RESUME;
  if (envResume !== undefined) {
    requested = true;
    const trimmed = envResume.trim();
    if (trimmed && !["1", "true", "auto", "yes", "on"].includes(trimmed.toLowerCase())) {
      workflowId = workflowId ?? trimmed;
    }
  }
  return { requested, ...(workflowId ? { workflowId } : {}), rest };
}

async function readTask(args: string[], projectDir: string): Promise<string> {
  if (args.length === 0) {
    throw new Error("Usage: parrot-orchestrate <task.md | prompt text ...>");
  }
  const parts: string[] = [];
  for (const arg of args) {
    // Resolve against the invocation dir so `task.md` is found even though pnpm runs
    // us from the package dir. A non-existent arg is treated as literal prompt text.
    const candidate = resolve(projectDir, arg);
    if (existsSync(candidate)) parts.push(await readFile(candidate, "utf8"));
    else parts.push(arg);
  }
  const task = parts.join("\n\n").trim();
  if (!task) throw new Error("Empty task input.");
  return task;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
