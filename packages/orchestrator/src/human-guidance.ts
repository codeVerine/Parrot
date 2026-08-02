import { randomUUID } from "node:crypto";
import type { PersistenceStore } from "@platform/persistence";

export type HumanMessage = { afterIteration: number; message: string };

export type StalemateChoice = "accept_mitigation" | "accept_objection" | "abort";

export type StalemateResolution = {
  choice: StalemateChoice;
  guidance?: string;
};

/** Accept bare choice strings (tests) or `{ choice, guidance }` (CLI). */
export function normalizeStalemateResolution(
  value: StalemateChoice | StalemateResolution,
): StalemateResolution {
  if (typeof value === "string") return { choice: value };
  return {
    choice: value.choice,
    ...(value.guidance ? { guidance: value.guidance } : {}),
  };
}

export function stalemateFeedbackDecision(choice: StalemateChoice): string {
  if (choice === "accept_mitigation") return "stalemate_accept_mitigation";
  if (choice === "accept_objection") return "stalemate_continue";
  return "stalemate_abort";
}

/** Parse `…-iter-N` → N; otherwise 0. */
export function iterationNumberFromId(iterationId: string | null | undefined): number {
  if (!iterationId) return 0;
  const match = /(?:^|-)iter-(\d+)$/.exec(iterationId);
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function humanMessagesFromFeedback(
  store: PersistenceStore,
  workflowId: string,
): HumanMessage[] {
  const messages: HumanMessage[] = [];
  for (const row of store.listHumanFeedback(workflowId)) {
    const comment = row.comment;
    if (typeof comment !== "string") continue;
    const trimmed = comment.trim();
    if (!trimmed) continue;
    messages.push({
      afterIteration: iterationNumberFromId(
        row.iteration_id === null || row.iteration_id === undefined
          ? undefined
          : String(row.iteration_id),
      ),
      message: trimmed,
    });
  }
  return messages;
}

export function persistHumanGuidance(input: {
  store: PersistenceStore;
  workflowId: string;
  decision: string;
  guidance: string;
  iterationId?: string;
  messages: HumanMessage[];
  afterIteration: number;
}): void {
  const trimmed = input.guidance.trim();
  if (!trimmed) return;
  input.store.saveHumanFeedback({
    feedbackId: `feedback-${randomUUID()}`,
    workflowId: input.workflowId,
    ...(input.iterationId ? { iterationId: input.iterationId } : {}),
    decision: input.decision,
    comment: trimmed,
  });
  input.messages.push({ afterIteration: input.afterIteration, message: trimmed });
}

export function humanMessagesContextArgs(
  messages: readonly HumanMessage[],
): { humanMessages: HumanMessage[] } | Record<string, never> {
  return messages.length > 0 ? { humanMessages: [...messages] } : {};
}
