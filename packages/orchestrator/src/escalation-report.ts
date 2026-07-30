import { parseToon } from "@platform/contracts";
import type { PersistenceStore } from "@platform/persistence";

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function decodeEvidence(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const decoded = parseToon(String(value)) as { evidence?: unknown };
    return Array.isArray(decoded.evidence) ? decoded.evidence.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function decodeObjectionIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const decoded = parseToon(String(value)) as { objectionIds?: unknown };
    return Array.isArray(decoded.objectionIds) ? decoded.objectionIds.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** `${workflowId}-iter-N` -> `N`; falls back to the raw id for anything else. */
function iterationNumber(iterationId: string | undefined): string {
  if (!iterationId) return "unknown";
  const match = /-iter-(\d+)$/.exec(iterationId);
  return match ? match[1]! : iterationId;
}

/**
 * Compose a human-readable stalemate report: per objection, the claim/evidence/severity
 * from its current row, the planner's addressal (if a Phase 10 structured addressal was
 * persisted), and the raise -> resolve -> re-raise timeline. The `objections` row is
 * lossy on re-raise (status is overwritten in place); the event log is the durable
 * history the timeline is built from.
 */
export function buildStalemateReport(
  store: PersistenceStore,
  workflowId: string,
  objectionIds: readonly string[],
  reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn" = "objection_stalemate",
): string {
  const objectionRows = new Map(store.listObjections(workflowId).map((row) => [str(row.objection_id), row]));
  const events = store.listEvents({ workflowId });
  const addressals = store
    .listDecisions(workflowId)
    .filter((row) => str(row.decision) === "objection_addressal");

  const sections = objectionIds.map((id) => {
    const row = objectionRows.get(id);
    const lines: string[] = [
      `### ${id}`,
      `severity: ${row ? str(row.severity) : "unknown"}`,
      `raisedBy: ${row ? str(row.raised_by) : "unknown"}`,
      `claim: ${row ? str(row.claim) : "(unavailable)"}`,
    ];

    const evidence = row ? decodeEvidence(row.evidence_toon) : [];
    if (evidence.length > 0) {
      lines.push("evidence:");
      for (const item of evidence) lines.push(`  - ${item}`);
    }

    const addressal = addressals.find((decision) => decodeObjectionIds(decision.objection_ids_toon).includes(id));
    if (addressal) {
      lines.push(`addressal: ${str(addressal.chosen)} - ${str(addressal.reason)}`);
    }

    lines.push("timeline:");
    for (const entry of events) {
      if (entry.event.kind !== "ObjectionRaised" && entry.event.kind !== "ObjectionResolved") continue;
      const payload = entry.event.payload as { objectionId: string; resolution?: string };
      if (payload.objectionId !== id) continue;
      const iteration = iterationNumber(entry.event.iterationId);
      const turnId = entry.event.turnId ?? "unknown";
      lines.push(
        entry.event.kind === "ObjectionRaised"
          ? `  - iteration ${iteration} (turn ${turnId}): raised`
          : `  - iteration ${iteration} (turn ${turnId}): resolved - ${payload.resolution ?? ""}`,
      );
    }

    return lines.join("\n");
  });

  const header =
    reason === "guardrail_conflict"
      ? `Guardrail conflict: ${objectionIds.length} objection(s) cannot be resolved within guardrails.`
      : `Objection stalemate: ${objectionIds.length} objection(s) resolved once and re-raised.`;

  return [
    header,
    ...sections,
  ].join("\n\n");
}

/**
 * Compose a human-readable plan churn report: the two iteration ids, measured
 * similarity and configured threshold, and added/removed section headings.
 */
export function buildChurnReport(
  fromIterationId: string,
  toIterationId: string,
  similarity: number,
  detail: string,
  margin: number,
  headings?: { added: string[]; removed: string[] },
  components?: {
    previous: { simAll: number; simHeadings: number; simSteps: number; score: number };
    prior: { simAll: number; simHeadings: number; simSteps: number; score: number };
  },
): string {
  const lines = [
    `Plan churn detected: iteration ${iterationNumber(toIterationId)} more similar to ${iterationNumber(fromIterationId)} than to its predecessor.`,
    `sim(N, N-2): ${(similarity * 100).toFixed(1)}% (margin: ${(margin * 100).toFixed(0)}%)`,
    detail,
  ];
  if (components) {
    lines.push(
      `components (N,N-1): all=${components.previous.simAll.toFixed(3)}, headings=${components.previous.simHeadings.toFixed(3)}, steps=${components.previous.simSteps.toFixed(3)}, score=${components.previous.score.toFixed(3)}`,
      `components (N,N-2): all=${components.prior.simAll.toFixed(3)}, headings=${components.prior.simHeadings.toFixed(3)}, steps=${components.prior.simSteps.toFixed(3)}, score=${components.prior.score.toFixed(3)}`,
    );
  }
  if (headings) {
    lines.push("");
    lines.push("headings delta:");
    if (headings.added.length === 0 && headings.removed.length === 0) {
      lines.push("  (none)");
    }
    if (headings.added.length > 0) {
      for (const h of headings.added) lines.push(`  + ${h}`);
    }
    if (headings.removed.length > 0) {
      for (const h of headings.removed) lines.push(`  - ${h}`);
    }
  }
  return lines.join("\n");
}
