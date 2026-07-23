import { readFile } from "node:fs/promises";
import { argv, env, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
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

type RoleSpec = { id: string; provider: string; role: string; worktreeRequired: boolean };

const ROLE_SPECS: RoleSpec[] = [
  { id: "planner", provider: env.PARROT_PLANNER_PROVIDER ?? "claude", role: "planner", worktreeRequired: false },
  { id: "reviewer", provider: env.PARROT_REVIEWER_PROVIDER ?? "codex", role: "reviewer", worktreeRequired: false },
  { id: "frontier", provider: env.PARROT_FRONTIER_PROVIDER ?? "claude", role: "frontier", worktreeRequired: false },
  { id: "implementation", provider: env.PARROT_IMPL_PROVIDER ?? "claude", role: "implementation", worktreeRequired: true },
  { id: "verifier", provider: env.PARROT_VERIFIER_PROVIDER ?? "codex", role: "verifier", worktreeRequired: false },
];

async function main(): Promise<void> {
  const task = await readTask(argv.slice(2));
  const socketPath = env.HERDR_SOCKET;
  if (!socketPath) throw new Error("Set HERDR_SOCKET to the Herdr daemon socket path.");

  const workspaceId = env.PARROT_WORKSPACE ?? "workspace-1";
  const workflowId = env.PARROT_WORKFLOW ?? `wf-${Date.now()}`;

  const client = new Protocol16SocketClient(new LineSocketTransport(socketPath));
  const cli = new HerdrCommandLine(env.HERDR_BIN ?? "herdr");
  const runtime = await HerdrAgentRuntime.create({ client, cli });

  const handles = new Map<string, AgentHandle>();
  for (const spec of ROLE_SPECS) {
    handles.set(
      spec.id,
      await runtime.start({
        provider: spec.provider,
        role: spec.role,
        workspaceId,
        worktreeRequired: spec.worktreeRequired,
      }),
    );
  }

  const store = new PersistenceStore({ path: env.PARROT_DB ?? "runs/parrot.db" });
  const runner = createHerdrRunner({ runtime, handles });
  const comp = createComposition({
    store,
    runner,
    humanLoopConfig: { notificationSink: "herdr" },
    runsRoot: env.PARROT_RUNS_ROOT ?? "runs",
  });

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
      workspaceId,
      task,
      plannerAgentId: "planner",
      reviewerAgentIds: ["reviewer"],
      frontierAgentId: "frontier",
      decide,
    });
    console.log(`Review loop finished: phase=${review.phase}, iterations=${review.iterations}`);

    if (review.phase === "approved") {
      const iterationId = `${workflowId}-impl`;
      const impl = await comp.runImplementation({
        workflowId,
        iterationId,
        agentId: "implementation",
        task,
        ...(review.finalProposalPath ? { proposalPath: review.finalProposalPath } : {}),
      });
      console.log(`Implementation: ${impl.status}`);
      if (impl.status === "completed") {
        const verify = await comp.runVerification({
          workflowId,
          iterationId,
          agentId: "verifier",
          targetTurnId: impl.turnId,
          summary: impl.summary,
          evidence: [],
        });
        console.log(`Verification: ${verify.status}`);
      }
    }
    await comp.flush();
  } finally {
    rl.close();
    await runtime.close();
  }
}

async function readTask(args: string[]): Promise<string> {
  if (args.length === 0) {
    throw new Error("Usage: parrot-orchestrate <task.md | prompt text ...>");
  }
  const parts: string[] = [];
  for (const arg of args) {
    try {
      parts.push(await readFile(arg, "utf8"));
    } catch {
      parts.push(arg);
    }
  }
  const task = parts.join("\n\n").trim();
  if (!task) throw new Error("Empty task input.");
  return task;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
});
