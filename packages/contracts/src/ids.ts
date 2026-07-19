import { randomUUID } from "node:crypto";

type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type WorkflowId = Brand<string, "WorkflowId">;
export type IterationId = Brand<string, "IterationId">;
export type TurnId = Brand<string, "TurnId">;
export type AgentId = Brand<string, "AgentId">;
export type EventId = Brand<string, "EventId">;
export type SignalId = Brand<string, "SignalId">;

function createId<T>(kind: string, value?: string): T {
  const id = value ?? `${kind}-${randomUUID()}`;
  if (!id.trim() || id.includes("\0")) {
    throw new Error(`${kind} must be a non-empty safe identifier.`);
  }
  return id as T;
}

export const workflowId = (value?: string) => createId<WorkflowId>("workflow", value);
export const iterationId = (value?: string) => createId<IterationId>("iteration", value);
export const turnId = (value?: string) => createId<TurnId>("turn", value);
export const agentId = (value?: string) => createId<AgentId>("agent", value);
export const eventId = (value?: string) => createId<EventId>("event", value);
export const signalId = (value?: string) => createId<SignalId>("signal", value);
