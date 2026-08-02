import { readFileSync } from "node:fs";
import {
  ImplementationResultSchema,
  ResolutionResultSchema,
  ResultEnvelopeSchema,
  parseToon,
} from "@platform/contracts";
import { sha256Hex } from "@platform/llm-boundary";
import type { PersistenceStore } from "@platform/persistence";

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

export type TurnIdentityFields = {
  workflowId: string;
  iterationId: string;
  turnId: string;
  nonce: string;
};

export type LoadedCompletedResult = {
  resultBytes: string;
  resultHash: string;
  role: string;
  payload: Record<string, unknown>;
};

/**
 * Load a completed turn's result.toon with fail-closed integrity:
 * envelope identity match + TurnCompleted.resultHash match.
 * Missing completion hash fails closed (no silent trust of disk bytes).
 */
export function loadCompletedResult(
  store: PersistenceStore,
  input: {
    workflowId: string;
    turnId: string;
    resultPath: string;
    identity: TurnIdentityFields;
    /** When true (default), missing TurnCompleted.hash is a durable inconsistency. */
    requireCompletionHash?: boolean;
  },
): LoadedCompletedResult {
  const requireHash = input.requireCompletionHash !== false;
  let resultBytes: string;
  try {
    resultBytes = readFileSync(input.resultPath, "utf8");
  } catch {
    throw new Error(
      `Durable state inconsistency: completed turn ${input.turnId} result file missing at ${input.resultPath}.`,
    );
  }

  const expectedHash = turnCompletedHash(store, input.workflowId, input.turnId);
  if (!expectedHash) {
    if (requireHash) {
      throw new Error(
        `Durable state inconsistency: completed turn ${input.turnId} has no TurnCompleted.resultHash.`,
      );
    }
  } else {
    const actual = sha256Hex(resultBytes);
    if (actual !== expectedHash) {
      throw new Error(
        `Durable state inconsistency: completed turn ${input.turnId} result bytes do not match TurnCompleted.resultHash.`,
      );
    }
  }

  const envelope = parseEnvelope(resultBytes, input.identity);
  if (!envelope) {
    throw new Error(
      `Durable state inconsistency: completed turn ${input.turnId} has a missing or corrupt result artifact.`,
    );
  }

  return {
    resultBytes,
    resultHash: expectedHash ?? sha256Hex(resultBytes),
    role: envelope.role,
    payload: envelope.payload,
  };
}

export function turnCompletedHash(
  store: PersistenceStore,
  workflowId: string,
  turnId: string,
): string | null {
  for (const entry of store.listEvents({ workflowId, limit: null })) {
    if (entry.event.kind !== "TurnCompleted") continue;
    if (str(entry.event.turnId) !== turnId) continue;
    const payload = entry.event.payload as { resultHash?: unknown };
    if (typeof payload.resultHash === "string" && payload.resultHash.length > 0) {
      return payload.resultHash;
    }
  }
  return null;
}

export function turnCompletedHashes(
  store: PersistenceStore,
  workflowId: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of store.listEvents({ workflowId, limit: null })) {
    if (entry.event.kind !== "TurnCompleted") continue;
    const id = str(entry.event.turnId);
    const payload = entry.event.payload as { resultHash?: unknown };
    if (id && typeof payload.resultHash === "string" && payload.resultHash.length > 0) {
      map.set(id, payload.resultHash);
    }
  }
  return map;
}

export function parseEnvelope(
  resultBytes: string,
  identity?: TurnIdentityFields,
): { role: string; payload: Record<string, unknown> } | null {
  try {
    const parsed = ResultEnvelopeSchema.safeParse(parseToon(resultBytes));
    if (!parsed.success) return null;
    const data = parsed.data;
    if (identity) {
      if (data.workflowId !== identity.workflowId) return null;
      if (data.iterationId !== identity.iterationId) return null;
      if (data.turnId !== identity.turnId) return null;
      if (data.nonce !== identity.nonce) return null;
    }
    return { role: data.role, payload: data.payload };
  } catch {
    return null;
  }
}

export function parseImplementationPayload(payload: Record<string, unknown>) {
  return ImplementationResultSchema.safeParse({ role: "implementation", ...payload });
}

export function parseResolutionPayload(payload: Record<string, unknown>) {
  return ResolutionResultSchema.safeParse({ role: "resolution", ...payload });
}
