import type { EscalationNotification, NotificationSink } from "@platform/workflow-engine";
import type { HumanLoopConfig } from "../config.js";
import type { HumanAttentionRequest, HumanNotificationSink } from "../types.js";

/** Map frontier TurnFailed to a human-attention request (never silent pass). */
export function frontierFailedAttention(
  workflowId: string,
  config: HumanLoopConfig,
  reason = "frontier_turn_failed",
): HumanAttentionRequest {
  return {
    workflowId,
    kind: "frontier_failed",
    summary: reason,
    dashboardDeepLink: `${config.dashboardDeepLinkBase}/${workflowId}`,
  };
}

/** Adapt Phase 4 NotificationSink to the Phase 6 HumanNotificationSink. */
export function adaptEscalationSink(
  human: HumanNotificationSink,
  config: HumanLoopConfig,
): NotificationSink {
  return {
    notifyEscalation(notification: EscalationNotification): void | Promise<void> {
      const kind =
        notification.reason === "budget_cap" || notification.reason.includes("budget")
          ? "budget_pause"
          : "escalation";
      return human.notify({
        workflowId: notification.workflowId,
        kind,
        summary: notification.reason,
        dashboardDeepLink: `${config.dashboardDeepLinkBase}/${notification.workflowId}`,
        openObjectionIds: notification.openObjectionIds,
      });
    },
  };
}

export function approvalRequestedAttention(
  workflowId: string,
  config: HumanLoopConfig,
  openObjectionIds: string[] = [],
): HumanAttentionRequest {
  return {
    workflowId,
    kind: "approval_requested",
    summary: "Human approval requested",
    dashboardDeepLink: `${config.dashboardDeepLinkBase}/${workflowId}`,
    openObjectionIds,
  };
}
