import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedPane } from "./registry.js";

const execFileAsync = promisify(execFile);

type HerdrAgent = {
  agent?: string | null;
  agent_status?: string;
  cwd?: string | null;
  pane_id: string;
  terminal_id?: string;
  workspace_id: string;
};

type AgentListResponse = {
  result: {
    agents: HerdrAgent[];
  };
};

export async function checkHerdrStatus(): Promise<void> {
  await runHerdr(["status"]);
}

export async function resolveTarget(role: "planner" | "reviewer"): Promise<ResolvedPane> {
  const { stdout } = await runHerdr(["agent", "list"]);
  const parsed = JSON.parse(stdout) as AgentListResponse;
  const agents = parsed.result.agents ?? [];
  const matches = agents.filter((agent) => agent.agent === role);

  if (matches.length !== 1) {
    const candidates = agents
      .map((agent) => {
        const label = agent.agent ?? "(no agent label)";
        return `- ${label} pane=${agent.pane_id} terminal=${agent.terminal_id ?? "unknown"} cwd=${agent.cwd ?? "unknown"}`;
      })
      .join("\n");

    throw new Error(
      `Expected exactly one Herdr agent named "${role}", found ${matches.length}.\n` +
        `Rename the intended pane with: herdr agent rename <target> ${role}\n\n` +
        `Current candidates:\n${candidates || "(none)"}`,
    );
  }

  const match = matches[0];
  return {
    role,
    paneId: match.pane_id,
    agent: match.agent ?? null,
    cwd: match.cwd ?? null,
    workspaceId: match.workspace_id,
  };
}

export async function sendInstruction(paneId: string, text: string): Promise<void> {
  await runHerdr(["agent", "send", paneId, text]);
  await runHerdr(["pane", "send-keys", paneId, "enter"]);
}

export async function notify(title: string, body?: string): Promise<void> {
  const args = ["notification", "show", title, "--sound", "request"];
  if (body) {
    args.push("--body", body);
  }
  await runHerdr(args);
}

async function runHerdr(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("herdr", args, { maxBuffer: 1024 * 1024 * 10 });
  } catch (error) {
    if (error instanceof Error && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      const stdout = String((error as { stdout?: unknown }).stdout ?? "").trim();
      throw new Error(stderr || stdout || error.message);
    }
    throw error;
  }
}
