import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PersistenceStore } from "@platform/persistence";
import type { WorkflowEngine } from "@platform/workflow-engine";
import type { HumanLoopConfig } from "../config.js";
import { postHumanDecision } from "./decisions.js";
import { projectDashboard } from "./project.js";

export type DashboardApiOptions = {
  store: PersistenceStore;
  engine: WorkflowEngine;
  config: HumanLoopConfig;
  /** Resolve engine config for a workflow (caps etc.). */
  configFor: (workflowId: string) => import("@platform/workflow-engine").WorkflowEngineConfig;
  sensitiveWorkflowIds?: ReadonlySet<string>;
};

/**
 * Narrow HTTP API: GET read models, POST decisions.
 * React+Vite UI consumes these DTOs; this keeps the dashboard stack testable
 * without requiring a browser in package tests.
 *
 * Ships raw UntrustedText for claims/reasons — React text nodes escape once.
 * Do not pre-escape for React consumers (that double-escapes).
 */
export function createDashboardApi(options: DashboardApiOptions) {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, options);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  return {
    server,
    listen(): Promise<{ host: string; port: number }> {
      const { host, port } = options.config.dashboardBind;
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ host, port }));
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardApiOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${options.config.dashboardBind.host}`);
  const match = /^\/api\/v1\/workflows\/([^/]+)(?:\/(decision))?$/.exec(url.pathname);
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const workflowId = decodeURIComponent(match[1]);
  const action = match[2];

  if (req.method === "GET" && !action) {
    const folded = options.engine.getState(workflowId);
    const snapshot = projectDashboard({
      store: options.store,
      workflowId,
      folded,
      config: options.configFor(workflowId),
      sensitive:
        options.sensitiveWorkflowIds?.has(workflowId) ??
        options.config.sensitiveWorkflowDefault,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot));
    return;
  }

  if (req.method === "POST" && action === "decision") {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw) as {
      decision: "approved" | "rejected";
      comment?: string;
      waiveOpenObjections?: boolean;
      waiveObjectionIds?: string[];
    };
    const result = postHumanDecision({
      engine: options.engine,
      store: options.store,
      decision: {
        workflowId,
        decision: parsed.decision,
        ...(parsed.comment ? { comment: parsed.comment } : {}),
        ...(parsed.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
        ...(parsed.waiveObjectionIds ? { waiveObjectionIds: parsed.waiveObjectionIds } : {}),
      },
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
