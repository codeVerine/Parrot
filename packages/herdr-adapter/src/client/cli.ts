import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrSchema, IntegrationStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export interface HerdrCli {
  schema(timeoutMs: number): Promise<HerdrSchema>;
  integrationStatus(timeoutMs: number): Promise<IntegrationStatus>;
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

  private async run(args: string[], timeoutMs: number): Promise<unknown> {
    const result = await execFileAsync(this.executable, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const output = result.stdout.trim();
    return JSON.parse(output);
  }
}
