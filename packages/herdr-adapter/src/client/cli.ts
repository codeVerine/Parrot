import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HerdrSchema, IntegrationStatus } from "./types.js";

const execFileAsync = promisify(execFile);

/** Conventional default-session socket path, honoring XDG_CONFIG_HOME. */
export function defaultHerdrSocketPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "herdr", "herdr.sock");
}

/**
 * Ask the running daemon for its own socket path via `herdr status server --json`.
 * Returns null when the binary is missing or no server is running, so callers can
 * fall back to {@link defaultHerdrSocketPath} or a manual override.
 */
export async function discoverHerdrSocket(executable = "herdr", timeoutMs = 10_000): Promise<string | null> {
  try {
    const result = await execFileAsync(executable, ["status", "server", "--json"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(result.stdout) as { running?: boolean; socket?: string };
    return parsed.running && parsed.socket ? parsed.socket : null;
  } catch {
    return null;
  }
}

export interface HerdrCli {
  schema(timeoutMs: number): Promise<HerdrSchema>;
  integrationStatus(timeoutMs: number): Promise<IntegrationStatus>;
  paneRun(paneId: string, command: string, timeoutMs: number): Promise<void>;
}

export class HerdrCommandLine implements HerdrCli {
  constructor(private readonly executable = "herdr") {}
  schema(timeoutMs: number) { return this.run(["api", "schema", "--json"], timeoutMs) as Promise<HerdrSchema>; }
  async integrationStatus(timeoutMs: number): Promise<IntegrationStatus> {
    const result = await execFileAsync(this.executable, ["integration", "status"], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const integrations = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const name = line.split(":", 1)[0];
      return { name, installed: !line.includes("not installed") };
    });
    return { integrations };
  }
  async paneRun(paneId: string, command: string, timeoutMs: number): Promise<void> {
    await execFileAsync(this.executable, ["pane", "run", paneId, command], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  }

  private async run(args: string[], timeoutMs: number): Promise<unknown> {
    const result = await execFileAsync(this.executable, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const output = result.stdout.trim();
    return JSON.parse(output);
  }
}
