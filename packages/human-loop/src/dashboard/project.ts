import { parseToon } from "@platform/contracts";
import type { PersistenceStore } from "@platform/persistence";
import type { FoldedState, WorkflowEngineConfig } from "@platform/workflow-engine";
import { accessSync, constants } from "node:fs";
import {
  DASHBOARD_DTO_VERSION,
  markClaim,
  type CostSummaryDto,
  type DecisionDto,
  type DrillDownLinks,
  type EscalationViewDto,
  type FrontierReportDto,
  type ObjectionDto,
  type TimelineEventDto,
  type TranscriptRefDto,
  type WorkflowSummaryDto,
} from "./models.js";

export type DashboardSnapshot = {
  summary: WorkflowSummaryDto;
  openObjections: ObjectionDto[];
  resolvedObjections: ObjectionDto[];
  decisions: DecisionDto[];
  timeline: TimelineEventDto[];
  cost: CostSummaryDto;
  frontier: FrontierReportDto;
  escalation: EscalationViewDto;
  transcripts: TranscriptRefDto[];
  links: DrillDownLinks;
};

export function projectDashboard(input: {
  store: PersistenceStore;
  workflowId: string;
  folded: FoldedState;
  config: WorkflowEngineConfig;
  sensitive?: boolean;
}): DashboardSnapshot {
  const { store, workflowId, folded, config } = input;
  const sensitive = input.sensitive ?? false;

  const summary: WorkflowSummaryDto = {
    dtoVersion: DASHBOARD_DTO_VERSION,
    workflowId,
    phase: folded.phase,
    iterationCount: folded.iterationCount,
    maxIterations: config.maxIterations,
    budgetCap: config.budgetCap,
    spendTotal: folded.spendTotal,
    degradedMode: folded.degradedMode,
    consensusReached: folded.consensusReached,
    humanDecision: folded.humanDecision,
  };

  const objectionRows = store.listObjections(workflowId);
  const decisionRows = store.listDecisions(workflowId);
  const artifactRows = store.listArtifacts(workflowId);
  const usageRows = store.listUsage(workflowId);

  const decisions: DecisionDto[] = decisionRows.map((row) => {
    const payload = safeObject(row.payload_toon);
    const objectionIds = stringArray(
      pickArray(parseMaybeToon(row.objection_ids_toon), "objectionIds") ??
        payload.objectionIds ??
        payload.objections,
    );
    const evidenceIds = stringArray(payload.evidenceIds ?? payload.evidence);
    const transcriptArtifactIds = stringArray(payload.transcriptArtifactIds);
    return {
      dtoVersion: DASHBOARD_DTO_VERSION,
      decisionId: String(row.decision_id),
      chosen: String(row.chosen ?? payload.chosen ?? ""),
      reason: markClaim(String(row.reason ?? payload.reason ?? "")),
      objectionIds,
      evidenceIds,
      transcriptArtifactIds,
    };
  });

  const decisionByObjection = new Map<string, string[]>();
  for (const decision of decisions) {
    for (const objectionId of decision.objectionIds) {
      const list = decisionByObjection.get(objectionId) ?? [];
      list.push(decision.decisionId);
      decisionByObjection.set(objectionId, list);
    }
  }

  const objections: ObjectionDto[] = objectionRows.map((row) => {
    const payload = safeObject(row.payload_toon);
    const id = String(row.objection_id);
    const evidenceIds = stringArray(
      pickArray(parseMaybeToon(row.evidence_toon), "evidence") ??
        payload.evidence ??
        payload.evidenceIds,
    );
    const transcriptArtifactIds = stringArray(payload.transcriptArtifactIds);
    const status = String(row.status ?? folded.objections[id]?.status ?? "open");
    return {
      dtoVersion: DASHBOARD_DTO_VERSION,
      id,
      severity: String(row.severity ?? folded.objections[id]?.severity ?? "minor"),
      status,
      claim: markClaim(String(row.claim ?? payload.claim ?? "")),
      evidenceIds,
      decisionIds: decisionByObjection.get(id) ?? [],
      transcriptArtifactIds,
      ...(row.cluster_id ? { clusterId: String(row.cluster_id) } : {}),
    };
  });

  // Also surface folded objections not yet in the objections table.
  for (const [id, foldedObjection] of Object.entries(folded.objections)) {
    if (objections.some((item) => item.id === id)) continue;
    objections.push({
      dtoVersion: DASHBOARD_DTO_VERSION,
      id,
      severity: foldedObjection.severity,
      status: foldedObjection.status,
      claim: markClaim(""),
      evidenceIds: [],
      decisionIds: decisionByObjection.get(id) ?? [],
      transcriptArtifactIds: [],
    });
  }

  const openObjections = objections.filter((item) => item.status === "open");
  const resolvedObjections = objections.filter((item) => item.status !== "open");

  const timeline: TimelineEventDto[] = store.listEvents({ workflowId, limit: null }).map((event) => ({
    dtoVersion: DASHBOARD_DTO_VERSION,
    sequence: event.sequence,
    kind: String(event.kind),
    occurredAt: event.occurredAt,
    eventId: event.eventId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.iterationId ? { iterationId: event.iterationId } : {}),
  }));

  const cost: CostSummaryDto = {
    dtoVersion: DASHBOARD_DTO_VERSION,
    workflowId,
    spendTotal: folded.spendTotal,
    inputTokens: sumInt(usageRows, "input_tokens"),
    outputTokens: sumInt(usageRows, "output_tokens"),
    cacheTokens: sumInt(usageRows, "cache_tokens"),
    pricingVersions: [...new Set(usageRows.map((row) => String(row.pricing_version)))],
    recordCount: usageRows.length,
  };

  const frontierArtifacts = artifactRows.filter((row) => String(row.kind) === "frontier_result");
  let frontier: FrontierReportDto = {
    dtoVersion: DASHBOARD_DTO_VERSION,
    readiness: null,
    risks: [],
    questions: [],
    artifactIds: frontierArtifacts.map((row) => String(row.artifact_id)),
  };
  if (frontierArtifacts.length > 0) {
    const meta = safeObject(frontierArtifacts[frontierArtifacts.length - 1].metadata_toon);
    if (meta.readiness === "ready" || meta.readiness === "not_ready") {
      frontier = {
        ...frontier,
        readiness: meta.readiness,
        risks: stringArray(meta.risks).map(markClaim),
        questions: stringArray(meta.questions).map(markClaim),
      };
    }
  }

  const openIds = openObjections.map((item) => item.id);
  const escalation: EscalationViewDto = {
    dtoVersion: DASHBOARD_DTO_VERSION,
    phase: folded.phase,
    reason:
      folded.phase === "escalated"
        ? folded.budgetCapReached
          ? "budget_cap"
          : folded.iterationCapReached
            ? "iteration_cap"
            : "escalated"
        : null,
    openObjectionIds: openIds,
  };

  const transcripts: TranscriptRefDto[] = artifactRows
    .filter((row) => String(row.kind) === "transcript" || String(row.kind) === "session_log")
    .map((row) => {
      const path = String(row.path);
      return {
        dtoVersion: DASHBOARD_DTO_VERSION,
        artifactId: String(row.artifact_id),
        path,
        contentHash: String(row.content_hash),
        locallyReadable: isLocallyReadable(path),
        sensitive,
      };
    });

  const links: DrillDownLinks = {
    summaryWorkflowId: workflowId,
    objectionIds: objections.map((item) => item.id),
    decisionIds: decisions.map((item) => item.decisionId),
    evidenceIds: [...new Set(objections.flatMap((item) => item.evidenceIds))],
    transcriptArtifactIds: transcripts.map((item) => item.artifactId),
  };

  return {
    summary,
    openObjections,
    resolvedObjections,
    decisions,
    timeline,
    cost,
    frontier,
    escalation,
    transcripts,
    links,
  };
}

/** Assert every ID in the drill-down chain resolves. */
export function assertDrillDownIntegrity(snapshot: DashboardSnapshot): void {
  const objectionIds = new Set(snapshot.links.objectionIds);
  const decisionIds = new Set(snapshot.links.decisionIds);
  const transcriptIds = new Set(snapshot.links.transcriptArtifactIds);

  for (const objection of [...snapshot.openObjections, ...snapshot.resolvedObjections]) {
    if (!objectionIds.has(objection.id)) {
      throw new Error(`Objection ${objection.id} missing from links`);
    }
    for (const decisionId of objection.decisionIds) {
      if (!decisionIds.has(decisionId)) {
        throw new Error(`Broken link: objection ${objection.id} → decision ${decisionId}`);
      }
    }
    for (const artifactId of objection.transcriptArtifactIds) {
      if (!transcriptIds.has(artifactId)) {
        throw new Error(`Broken link: objection ${objection.id} → transcript ${artifactId}`);
      }
    }
  }

  for (const decision of snapshot.decisions) {
    if (!decisionIds.has(decision.decisionId)) {
      throw new Error(`Decision ${decision.decisionId} missing from links`);
    }
    for (const objectionId of decision.objectionIds) {
      if (!objectionIds.has(objectionId)) {
        throw new Error(`Broken link: decision ${decision.decisionId} → objection ${objectionId}`);
      }
    }
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = parseToon(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseMaybeToon(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return parseToon(value);
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
}

function pickArray(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function sumInt(rows: ReadonlyArray<Readonly<Record<string, unknown>>>, key: string): number {
  return rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
}

function isLocallyReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
