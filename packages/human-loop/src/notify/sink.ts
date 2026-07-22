import { spawn } from "node:child_process";
import type { FoldedState } from "@platform/workflow-engine";
import type { HumanLoopConfig } from "../config.js";
import type { HumanAttentionKind, HumanAttentionRequest, HumanNotificationSink } from "../types.js";

export function createMemorySink(): HumanNotificationSink & {
  requests: HumanAttentionRequest[];
} {
  const requests: HumanAttentionRequest[] = [];
  return {
    requests,
    notify(request) {
      requests.push(request);
    },
  };
}

export function createNoopSink(): HumanNotificationSink {
  return { notify() {} };
}

/**
 * Herdr implementation: `notification show --sound request`.
 * Best-effort: spawn failures are swallowed (durable state is the event log).
 */
export function createHerdrSink(config: Pick<HumanLoopConfig, "herdrBin">): HumanNotificationSink {
  return {
    async notify(request: HumanAttentionRequest): Promise<void> {
      const message = `[${request.kind}] ${request.workflowId}: ${request.summary} ${request.dashboardDeepLink}`;
      await new Promise<void>((resolve) => {
        const child = spawn(
          config.herdrBin,
          ["notification", "show", "--sound", "request", message],
          { stdio: "ignore" },
        );
        child.on("error", () => resolve());
        child.on("exit", () => resolve());
      });
    },
  };
}

export function createNotificationSink(
  config: HumanLoopConfig,
): HumanNotificationSink {
  switch (config.notificationSink) {
    case "herdr":
      return createHerdrSink(config);
    case "memory":
      return createMemorySink();
    default:
      return createNoopSink();
  }
}

/** Rebuild a human-attention request from durable folded state (§4.3). */
export function attentionRequestFromFolded(input: {
  folded: FoldedState;
  config: HumanLoopConfig;
}): HumanAttentionRequest | null {
  const { folded, config } = input;
  const openObjectionIds = Object.values(folded.objections)
    .filter((item) => item.status === "open")
    .map((item) => item.objectionId);
  const deepLink = `${config.dashboardDeepLinkBase}/${folded.workflowId}`;

  if (folded.phase === "escalated") {
    const kind: HumanAttentionKind = folded.budgetCapReached ? "budget_pause" : "escalation";
    const summary = folded.budgetCapReached
      ? "budget_cap"
      : folded.iterationCapReached
        ? "iteration_cap"
        : "escalated";
    return {
      workflowId: folded.workflowId,
      kind,
      summary,
      dashboardDeepLink: deepLink,
      openObjectionIds,
    };
  }

  if (folded.phase === "await_human" || folded.phase === "human_decision") {
    return {
      workflowId: folded.workflowId,
      kind: "approval_requested",
      summary: "Human approval requested",
      dashboardDeepLink: deepLink,
      openObjectionIds,
    };
  }

  return null;
}

/**
 * Re-emit attention from current folded state (missed-notify recovery).
 * Returns null when folded phase does not require human attention.
 */
export function renotifyFromState(input: {
  sink: HumanNotificationSink;
  folded: FoldedState;
  config: HumanLoopConfig;
}): HumanAttentionRequest | null {
  const request = attentionRequestFromFolded(input);
  if (!request) return null;
  void input.sink.notify(request);
  return request;
}
