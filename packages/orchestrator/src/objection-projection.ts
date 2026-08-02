import { readFileSync } from "node:fs";
import { parseToon } from "@platform/contracts";
import type { PersistenceStore } from "@platform/persistence";

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

type RaisedObjection = {
  severity: "blocking" | "major" | "minor";
  iterationId: string;
  turnId: string;
  raisedBy: string;
  status: "open" | "resolved" | "waived";
};

type ReviewerObjection = {
  id?: unknown;
  claim?: unknown;
  evidence?: unknown;
  severity?: unknown;
  evidence_missing?: unknown;
  suggestedResolution?: unknown;
};

/**
 * Rebuild any objections rows missing for this workflow from its event log and
 * the raising turn's result.toon. Needed when older DBs used a global
 * objection_id primary key and cross-workflow ID collisions stole rows.
 */
export function repairObjectionProjection(store: PersistenceStore, workflowId: string): void {
  const existing = new Set(
    store.listObjections(workflowId).map((row) => str(row.objection_id)),
  );
  const raised = new Map<string, RaisedObjection>();

  for (const entry of store.listEvents({ workflowId })) {
    const { event } = entry;
    if (event.kind === "ObjectionRaised") {
      const payload = event.payload as { objectionId: string; severity: RaisedObjection["severity"] };
      raised.set(payload.objectionId, {
        severity: payload.severity,
        iterationId: str(event.iterationId),
        turnId: str(event.turnId),
        raisedBy: str(event.agentId) || "reviewer",
        status: "open",
      });
      continue;
    }
    if (event.kind === "ObjectionResolved") {
      const payload = event.payload as { objectionId: string };
      const current = raised.get(payload.objectionId);
      if (current) current.status = "resolved";
      continue;
    }
    if (event.kind === "HumanApproved") {
      for (const current of raised.values()) {
        if (current.status === "open") current.status = "waived";
      }
    }
  }

  for (const [objectionId, meta] of raised) {
    if (existing.has(objectionId)) continue;
    if (!meta.iterationId || !meta.turnId) continue;
    const turn = store.getTurn(meta.turnId);
    if (!turn || str(turn.workflow_id) !== workflowId) continue;

    const details = loadObjectionFromResult(str(turn.result_path), objectionId);
    store.saveObjection({
      objectionId,
      workflowId,
      iterationId: meta.iterationId,
      turnId: meta.turnId,
      dimension: "review",
      severity: details?.severity ?? meta.severity,
      claim: details?.claim ?? `(restored from event log; claim unavailable for ${objectionId})`,
      evidence: details?.evidence ?? [],
      evidenceMissing: details?.evidenceMissing ?? details?.claim === undefined,
      ...(details?.suggestedResolution
        ? { suggestedResolution: details.suggestedResolution }
        : {}),
      status: meta.status,
      raisedBy: meta.raisedBy,
    });
  }
}

function loadObjectionFromResult(
  resultPath: string,
  objectionId: string,
): {
  claim: string;
  evidence: string[];
  severity?: RaisedObjection["severity"];
  evidenceMissing: boolean;
  suggestedResolution?: string;
} | null {
  if (!resultPath) return null;
  try {
    const envelope = parseToon(readFileSync(resultPath, "utf8")) as {
      payload?: { objections?: ReviewerObjection[] };
    };
    const match = envelope.payload?.objections?.find((item) => str(item.id) === objectionId);
    if (!match) return null;
    const severity = match.severity;
    const suggested =
      typeof match.suggestedResolution === "string" ? match.suggestedResolution.trim() : "";
    return {
      claim: str(match.claim) || `(claim missing in result for ${objectionId})`,
      evidence: Array.isArray(match.evidence) ? match.evidence.map((item) => String(item)) : [],
      ...(severity === "blocking" || severity === "major" || severity === "minor"
        ? { severity }
        : {}),
      evidenceMissing: match.evidence_missing === true,
      ...(suggested ? { suggestedResolution: suggested } : {}),
    };
  } catch {
    return null;
  }
}
