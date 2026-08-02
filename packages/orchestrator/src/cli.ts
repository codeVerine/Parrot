#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { argv, cwd as processCwd, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { agentId } from "@platform/contracts";
import {
  defaultHerdrSocketPath,
  discoverHerdrSocket,
  HerdrAgentRuntime,
  HerdrCommandLine,
  LineSocketTransport,
  parsePermissionMode,
  providerArgvForPermissionMode,
  Protocol16SocketClient,
  reclaimEmptyRootPane,
  type AgentHandle,
} from "@platform/herdr-adapter";
import { PersistenceStore } from "@platform/persistence";
import type { ObjectionView } from "@platform/llm-boundary";
import {
  findStoredAgent,
  workflowRoleAgentKey,
  workflowRoleAgentName,
} from "./agent-session.js";
import { resolveCodebaseContext } from "./codebase-context.js";
import {
  askOptionalGuidance,
  askUntilValid,
  formatDecisionPrompt,
  formatStalematePrompt,
  parseDecisionInput,
  parseStalemateInput,
} from "./cli-format.js";
import { createComposition } from "./composition.js";
import { createHerdrRunner } from "./herdr-runner.js";
import { runReviewLoop, type HumanDecision, type StalemateChoice, type StalemateResolution } from "./loop.js";
import { assertProposalFresh } from "./proposal-integrity.js";
import { ensureWorktree } from "./worktree.js";
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
  { id: "verifier", provider: env.PARROT_VERIFIER_PROVIDER ?? "codex", role: "verifier", worktreeRequired: true },
];

function printHelp(): void {
  stdout.write(
    [
      "Usage:",
      "  parrot [--resume [workflowId]] <task.md | prompt text ...>",
      "",
      "Notes:",
      "  - Run inside (or point PARROT_PROJECT_DIR at) a git repo.",
      "  - Requires a running Herdr daemon unless using --help/--version.",
      "",
    ].join("\n"),
  );
}

function printVersion(): void {
  // Keep this simple: the authoritative version lives in package.json.
  stdout.write("parrot\n");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function worktreeEvidence(worktreePath: string): string[] {
  const branch = (() => { try { return git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return "(unknown)"; } })();
  const head = (() => { try { return git(worktreePath, ["rev-parse", "HEAD"]); } catch { return "(unknown)"; } })();
  const status = (() => { try { return git(worktreePath, ["status", "--porcelain=v1"]); } catch { return "(unavailable)"; } })();
  const diffNames = (() => { try { return git(worktreePath, ["diff", "--name-status"]); } catch { return "(unavailable)"; } })();
  const diffStat = (() => { try { return git(worktreePath, ["diff", "--stat"]); } catch { return "(unavailable)"; } })();
  return [
    `worktree: ${worktreePath}`,
    `branch: ${branch}`,
    `head: ${head}`,
    `git status --porcelain=v1:\n${status || "(clean)"}`,
    `git diff --name-status:\n${diffNames || "(none)"}`,
    `git diff --stat:\n${diffStat || "(none)"}`,
  ];
}

async function main(): Promise<void> {
  const rawArgs = argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs[0] === "help") {
    printHelp();
    return;
  }
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    printVersion();
    return;
  }

  // The directory agents operate in and every relative path is anchored to. `pnpm`
  // rewrites process.cwd() to the package dir, so INIT_CWD (the shell's dir when the
  // user invoked parrot) is the correct default; PARROT_PROJECT_DIR overrides it.
  const projectDir = resolve(env.PARROT_PROJECT_DIR ?? env.INIT_CWD ?? processCwd());
  const resumeRequest = parseResumeRequest(rawArgs);

  // Absolute so the paths embedded in each agent's command resolve no matter what
  // directory the agent's shell starts in.
  const runsRoot = resolve(projectDir, env.PARROT_RUNS_ROOT ?? "runs");
  const store = new PersistenceStore({ path: env.PARROT_DB ?? resolve(runsRoot, "parrot.db") });

  // Select the workflow before starting any role panes so resume-time provider-session
  // reattach is scoped to the correct workflow.
  const workflowId = resumeRequest.requested
    ? selectResumeWorkflowId(store, resumeRequest.workflowId)
    : env.PARROT_WORKFLOW ?? `wf-${Date.now()}`;

  const herdrBin = env.HERDR_BIN ?? "herdr";
  const socketPath = await resolveSocketPath(herdrBin);
  const client = new Protocol16SocketClient(new LineSocketTransport(socketPath));
  const cli = new HerdrCommandLine(herdrBin);
  // Default: auto-approve edits/FS inside each agent's cwd (project or worktree);
  // outside that tree providers still prompt (Claude/Gemini) or sandbox-deny (Codex).
  // Override with PARROT_PERMISSION_MODE=ask|bypass.
  const permissionMode = parsePermissionMode(env.PARROT_PERMISSION_MODE);
  const runtime = await HerdrAgentRuntime.create({
    client,
    cli,
    config: { providerArgv: providerArgvForPermissionMode(permissionMode) },
  });

  const storedWorkspaceId = resumeRequest.requested
    ? String(store.readRows("workflows").find((row) => String(row.workflow_id) === workflowId)?.workspace_id ?? "")
    : "";
  const workspaceId =
    env.PARROT_WORKSPACE ??
    (storedWorkspaceId.trim() ? storedWorkspaceId : await resolveFocusedWorkspace(client));

  // Spawn agents into one dedicated tab so they do not split the caller's terminal
  // pane down to an unreadable size. Individual role panes are started lazily;
  // PARROT_TAB reuses an existing tab if provided.
  //
  // Herdr 0.7.3 `agent.start` always splits (defaults to right), so a fresh tab's
  // root shell would otherwise stay empty beside the first agent. We reclaim that
  // empty root after the first fresh start; later roles then split as intended.
  const createdTab = env.PARROT_TAB
    ? null
    : await client.createTab(workspaceId, "parrot agents", 10_000);
  const tabId = createdTab?.tabId ?? env.PARROT_TAB;
  if (!tabId) throw new Error("missing parrot tab id");
  let reclaimedRootPane = false;

  const worktreeRoot = env.PARROT_WORKTREE_ROOT ? resolve(projectDir, env.PARROT_WORKTREE_ROOT) : undefined;

  const specsById = new Map(ROLE_SPECS.map((spec) => [spec.id, spec]));
  const handles = new Map<string, Promise<AgentHandle>>();
  const getHandle = async (id: string): Promise<AgentHandle> => {
    const cached = handles.get(id);
    if (cached) return cached;
    const spec = specsById.get(id);
    if (!spec) throw new Error(`No role specification for ${id}`);
    const agentKey = workflowRoleAgentKey(workflowId, spec.id);
    const usesWorkflowWorktree = spec.worktreeRequired === true;
    const cwd = usesWorkflowWorktree
      ? ensureWorktree({ projectDir, workflowId, ...(worktreeRoot ? { worktreeRoot } : {}) }).path
      : projectDir;
    const storedAgent = resumeRequest.requested
      ? findStoredAgent(store, workflowId, spec.id, spec.provider, workspaceId)
      : undefined;
    const agentSpec = {
      id: agentId(agentKey),
      provider: spec.provider,
      role: spec.role,
      name: workflowRoleAgentName(workflowId, spec.provider, spec.id),
      workspaceId,
      tabId,
      cwd,
      worktreeRequired: spec.worktreeRequired,
      ...(storedAgent ? { resume: storedAgent.resume } : {}),
    };
    const starting = storedAgent
      ? runtime.attach({ ...agentSpec, paneId: storedAgent.paneId }).then(async (attached) => {
          if (attached) return { handle: attached, freshStart: false as const };
          return { handle: await runtime.start(agentSpec), freshStart: true as const };
        })
      : runtime.start(agentSpec).then((handle) => ({ handle, freshStart: true as const }));
    const cachedStart = starting.then(async ({ handle, freshStart }) => {
      if (
        createdTab &&
        !reclaimedRootPane &&
        freshStart &&
        handle.paneId !== createdTab.rootPaneId
      ) {
        reclaimedRootPane = true;
        await reclaimEmptyRootPane(client, createdTab.rootPaneId, handle.paneId, 10_000).catch(() => {
          // Best-effort: an already-closed root must not fail agent startup.
        });
      }
      store.saveAgent({
        agentId: agentKey,
        paneId: handle.paneId,
        workspaceId,
        provider: spec.provider,
        role: spec.role,
        sessionId: handle.sessionId,
        sessionPath: handle.sessionPath,
        status: "idle",
      });
      return handle;
    });
    handles.set(id, cachedStart);
    try {
      return await cachedStart;
    } catch (error) {
      handles.delete(id);
      throw error;
    }
  };

  const turnMaxMs = env.PARROT_TURN_MAX_MS
    ? Number(env.PARROT_TURN_MAX_MS)
    : env.PARROT_TURN_TIMEOUT_MS
      ? Number(env.PARROT_TURN_TIMEOUT_MS)
      : undefined;
  const turnIdleMs = env.PARROT_TURN_IDLE_TIMEOUT_MS ? Number(env.PARROT_TURN_IDLE_TIMEOUT_MS) : undefined;
  const runner = createHerdrRunner({
    runtime,
    getHandle,
    onNotice: (message) => console.log(message),
    ...(turnMaxMs ? { maxMs: turnMaxMs } : {}),
    ...(turnIdleMs ? { idleTimeoutMs: turnIdleMs } : {}),
  });
  const comp = createComposition({
    store,
    runner,
    humanLoopConfig: { notificationSink: "herdr" },
    runsRoot,
    projectDir,
  });

  // Resume an interrupted workflow from its persisted state, or start a fresh run. On
  // resume the task comes from the stored workflow row (not the CLI args) and the loop
  // re-enters at the recovered phase instead of replanning from iteration 1.
  let task: string;
  let resumeSeed: ResumeSeed | undefined;
  if (resumeRequest.requested) {
    resumeSeed = comp.resumeWorkflow(workflowId);
    task = resumeSeed.task;
    console.log(`Resuming workflow ${workflowId} at phase=${resumeSeed.phase}, iteration=${resumeSeed.iteration}.`);
  } else {
    task = await readTask(resumeRequest.rest, projectDir);
  }

  const contextDisabled = env.PARROT_CONTEXT_DISABLE === "1";
  const contextMaxFiles = parseNonNegativeInt(env.PARROT_CONTEXT_MAX_FILES);
  const contextMaxBytes = parseNonNegativeInt(env.PARROT_CONTEXT_MAX_BYTES);
  const codebaseContext = contextDisabled
    ? []
    : resolveCodebaseContext({
        projectDir,
        task,
        ...(contextMaxFiles !== undefined ? { maxFiles: contextMaxFiles } : {}),
        ...(contextMaxBytes !== undefined ? { maxTotalBytes: contextMaxBytes } : {}),
      });
  const codebaseContextBytes = codebaseContext.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  console.log(`Codebase context: ${codebaseContext.length} files, ${formatKilobytes(codebaseContextBytes)} KB`);

  const rl = createInterface({ input: stdin, output: stdout });
  const decide = async (ctx: {
    openObjectionIds: string[];
    openObjections: ObjectionView[];
    frontierReadiness: "ready" | "not_ready" | null;
    proposalPath?: string;
    proposalHash?: string;
    proposalSummary?: string;
    pairReviewSummaries?: Array<{ agentId: string; summary: string }>;
  }): Promise<HumanDecision> => {
    const decision = await askUntilValid({
      prompt: formatDecisionPrompt({
        openObjections: ctx.openObjections,
        frontierReadiness: ctx.frontierReadiness,
        ...(ctx.proposalPath ? { proposalPath: ctx.proposalPath } : {}),
        ...(ctx.proposalHash ? { proposalHash: ctx.proposalHash } : {}),
        ...(ctx.proposalSummary ? { proposalSummary: ctx.proposalSummary } : {}),
        ...(ctx.pairReviewSummaries ? { pairReviewSummaries: ctx.pairReviewSummaries } : {}),
      }),
      question: (message) => rl.question(message),
      parse: parseDecisionInput,
      invalidHint: "Unrecognized input. Valid options: 1 (approve), 2 (reject).",
      writeLine: (message) => stdout.write(`${message}\n`),
    });
    const guidance = await askOptionalGuidance({
      question: (message) => rl.question(message),
      writeLine: (message) => stdout.write(`${message}\n`),
    });
    return {
      decision,
      waiveOpenObjections: ctx.openObjectionIds.length > 0,
      ...(guidance ? { comment: guidance } : {}),
    };
  };

  const onStalemate = async (ctx: {
    objectionIds: string[];
    report: string;
    reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn";
    proposalPath?: string;
    proposalHash?: string;
    proposalSummary?: string;
    openObjections?: ObjectionView[];
  }): Promise<StalemateResolution> => {
    const choice: StalemateChoice = await askUntilValid({
      prompt: formatStalematePrompt({
        objectionIds: ctx.objectionIds,
        report: ctx.report,
        reason: ctx.reason,
        ...(ctx.openObjections ? { openObjections: ctx.openObjections } : {}),
        ...(ctx.proposalPath ? { proposalPath: ctx.proposalPath } : {}),
        ...(ctx.proposalHash ? { proposalHash: ctx.proposalHash } : {}),
        ...(ctx.proposalSummary ? { proposalSummary: ctx.proposalSummary } : {}),
      }),
      question: (message) => rl.question(message),
      parse: parseStalemateInput,
      invalidHint: "Unrecognized input. Valid options: 1 (accept mitigation), 2 (continue planning), 3 (abort).",
      writeLine: (message) => stdout.write(`${message}\n`),
    });
    const guidance = await askOptionalGuidance({
      question: (message) => rl.question(message),
      writeLine: (message) => stdout.write(`${message}\n`),
    });
    return {
      choice,
      ...(guidance ? { guidance } : {}),
    };
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
      onStalemate,
      onProgress: (line) => console.log(line),
      codebaseContext,
      ...(resumeSeed ? { resume: resumeSeed } : {}),
    });
    console.log(`Review loop finished: phase=${review.phase}, iterations=${review.iterations}`);
    if (review.escalation) {
      console.log(`Escalation: ${review.escalation.reason} (${review.escalation.objectionIds.join(", ")})`);
    }

    if (review.phase === "approved") {
      if (!review.finalProposalPath || !review.finalProposalHash) {
        console.error("Refusing implementation: approved review is missing Author proposal path/hash");
        exit(1);
      }
      const fresh = assertProposalFresh({
        proposalPath: review.finalProposalPath,
        expectedHash: review.finalProposalHash,
      });
      if (!fresh.ok) {
        console.error(`Refusing implementation: ${fresh.reason}`);
        exit(1);
      }
      const iterationId = `${workflowId}-impl`;

      // On resume, reuse a completed implementation turn instead of re-running it.
      const reused = reuseImplementation(store, workflowId, iterationId, {
        proposalPath: review.finalProposalPath,
        proposalHash: review.finalProposalHash,
      });
      let implTurnId: string | undefined;
      let implSummary: string | undefined;
      if (reused) {
        implTurnId = reused.turnId;
        implSummary = reused.summary;
        console.log("[implementation post-review] reused (completed before interruption)");
      } else {
        const impl = await comp.runImplementation({
          workflowId,
          iterationId,
          agentId: "implementation",
          task,
          proposalPath: review.finalProposalPath,
          proposalHash: review.finalProposalHash,
          ...(review.humanMessages.length > 0 ? { humanMessages: review.humanMessages } : {}),
        });
        console.log(`[implementation post-review] status=${impl.status}`);
        if (impl.status === "completed") {
          implTurnId = impl.turnId;
          implSummary = impl.summary;
        } else if (impl.status === "deviation") {
          console.log(`Deviation request: ${impl.deviationRequest}`);
        } else if (impl.status === "blocked") {
          console.log(`Implementation blocked: ${impl.summary}`);
        } else {
          console.log(`Implementation failed: ${impl.reason}`);
        }
      }

      if (implTurnId !== undefined && implSummary !== undefined) {
        if (verificationCompleted(store, workflowId, iterationId, implTurnId)) {
          console.log("[verification post-review] reused (completed before interruption)");
          store.updatePostReviewStage(workflowId, "complete");
        } else {
          const worktree = ensureWorktree({ projectDir, workflowId, ...(worktreeRoot ? { worktreeRoot } : {}) });
          const verify = await comp.runVerification({
            workflowId,
            iterationId,
            agentId: "verifier",
            targetTurnId: implTurnId,
            summary: implSummary,
            evidence: worktreeEvidence(worktree.path),
          });
          console.log(`[verification post-review] status=${verify.status}`);
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
    throw new Error("Usage: parrot <task.md | prompt text ...>");
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

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function formatKilobytes(bytes: number): string {
  const kb = bytes / 1024;
  const text = kb.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
