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

/**
 * Build an `escalation` attention request from a reason and objection ids.
 * Mirrors what the engine's `adaptEscalationSink` produces for non-budget
 * escalations so a loop that suppresses the engine's notification
 * (`reportGuardrailConflict({ notify: false })`) can re-emit the request
 * with the configured dashboard base and consistent kind / summary.
 */
export function escalationAttention(
  workflowId: string,
  config: HumanLoopConfig,
  reason: string,
  openObjectionIds: string[] = [],
): HumanAttentionRequest {
  return {
    workflowId,
    kind: "escalation",
    summary: reason,
    dashboardDeepLink: `${config.dashboardDeepLinkBase}/${workflowId}`,
    openObjectionIds,
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
