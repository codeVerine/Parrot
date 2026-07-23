import type { FrontierResult, PlannerResult, ReviewerResult } from "@platform/contracts";
import { blockingFindings, findingsFromReport } from "@platform/human-loop";
import type { ObjectionView } from "@platform/llm-boundary";
import type { WorkflowEngineConfig, WorkflowPhase } from "@platform/workflow-engine";
import type { Composition } from "./composition.js";

export type HumanDecisionResolver = (ctx: {
  workflowId: string;
  openObjectionIds: string[];
  frontierReadiness: "ready" | "not_ready" | null;
}) => { decision: "approved" | "rejected"; waiveOpenObjections?: boolean; comment?: string };

export type ReviewLoopInput = {
  workflowId: string;
  workspaceId: string;
  task: string;
  plannerAgentId: string;
  /** One turn per id; the last runs as an adversarial review when `adversarial` is set. */
  reviewerAgentIds: string[];
  frontierAgentId: string;
  decide: HumanDecisionResolver;
  adversarial?: boolean;
  maxIterations?: number;
  config?: Partial<WorkflowEngineConfig>;
};

export type ReviewLoopResult = {
  phase: WorkflowPhase;
  iterations: number;
  openObjectionIds: string[];
  frontierReadiness: "ready" | "not_ready" | null;
  finalProposalPath?: string;
  failedTurnId?: string;
  frontierFailed?: boolean;
};

/**
 * Drive the review loop to a terminal planning phase: plan, review, merge gate,
 * frontier, human decision. Reaches parity with the legacy MVP loop against the
 * packaged engine, LLM boundary, and human loop.
 */
export async function runReviewLoop(
  comp: Composition,
  input: ReviewLoopInput,
): Promise<ReviewLoopResult> {
  const { engine } = comp;
  const { workflowId } = input;
  const maxIterations = input.maxIterations ?? 5;
  const views = new Map<string, ObjectionView>();
  let frontierReadiness: "ready" | "not_ready" | null = null;
  let finalProposalPath: string | undefined;

  comp.startWorkflow({
    workflowId,
    workspaceId: input.workspaceId,
    task: input.task,
    config: { ...input.config, maxIterations },
  });

  const openIds = (): string[] => {
    const folded = engine.getState(workflowId);
    return Object.values(folded.objections)
      .filter((o) => o.status === "open")
      .map((o) => o.objectionId);
  };
  const openViews = (): ObjectionView[] => {
    const open = new Set(openIds());
    return [...views.values()].filter((v) => open.has(v.id));
  };
  const finalize = (extra: Partial<ReviewLoopResult> = {}): ReviewLoopResult => ({
    phase: engine.getState(workflowId).phase,
    iterations: engine.getState(workflowId).iterationCount + 1,
    openObjectionIds: openIds(),
    frontierReadiness,
    ...(finalProposalPath ? { finalProposalPath } : {}),
    ...extra,
  });

  for (let n = 1; n <= maxIterations; n += 1) {
    const iterationId = `${workflowId}-iter-${n}`;
    const nextIterationId = `${workflowId}-iter-${n + 1}`;

    const planner = await comp.runTurn({
      turnType: n === 1 ? "planner_propose" : "planner_revise",
      workflowId,
      iterationId,
      agentId: input.plannerAgentId,
      context: { task: input.task, openObjections: openViews() },
      iterationNumber: n,
    });
    if (planner.status !== "valid") return finalize({ failedTurnId: planner.turnId });
    const plannerPayload = planner.payload as PlannerResult;
    finalProposalPath = plannerPayload.proposalPath;

    for (const objectionId of plannerPayload.objectionsAddressed) {
      if (views.has(objectionId)) {
        engine.resolveObjection({ workflowId, objectionId, resolution: "addressed by planner" });
      }
    }

    engine.advancePlanning(workflowId, "plannerCompleted");
    engine.advancePlanning(workflowId, "reviewersSpawned");

    for (const [i, agentId] of input.reviewerAgentIds.entries()) {
      const isAdversarial = input.adversarial === true && i === input.reviewerAgentIds.length - 1;
      const reviewer = await comp.runTurn({
        turnType: isAdversarial ? "adversarial_review" : "reviewer_review",
        workflowId,
        iterationId,
        agentId,
        context: {
          proposalPath: plannerPayload.proposalPath,
          proposalSummary: plannerPayload.summary,
          openObjections: openViews(),
          allObjections: [...views.values()],
        },
      });
      if (reviewer.status !== "valid") continue;
      for (const objection of (reviewer.payload as ReviewerResult).objections) {
        raiseObjection(comp, workflowId, iterationId, reviewer.turnId, agentId, {
          id: objection.id,
          severity: objection.severity,
          dimension: "review",
          claim: objection.claim,
          evidence: objection.evidence,
          evidenceMissing: objection.evidence_missing === true,
        });
        views.set(objection.id, {
          id: objection.id,
          dimension: "review",
          severity: objection.severity,
          claim: objection.claim,
          evidence: objection.evidence,
          status: "open",
          raisedBy: agentId,
          turnId: reviewer.turnId,
          ...(objection.evidence_missing === true ? { evidence_missing: true } : {}),
        });
      }
    }

    engine.advancePlanning(workflowId, "objectionsCollected");
    engine.advancePlanning(workflowId, "mergeCompleted");

    const gate = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId });
    if (gate.phase === "escalated") return finalize();
    if (gate.phase === "planner_turn") continue;

    // Clean gate -> frontier review.
    const frontier = await comp.runTurn({
      turnType: "frontier_report",
      workflowId,
      iterationId,
      agentId: input.frontierAgentId,
      context: {
        proposalPath: plannerPayload.proposalPath,
        proposalSummary: plannerPayload.summary,
        allObjections: [...views.values()],
      },
    });
    if (frontier.status !== "valid") {
      comp.humanSink.notify({
        workflowId,
        kind: "frontier_failed",
        summary: "frontier_turn_failed",
        dashboardDeepLink: `/workflows/${workflowId}`,
      });
      return finalize({ failedTurnId: frontier.turnId, frontierFailed: true });
    }
    const frontierPayload = frontier.payload as FrontierResult;
    frontierReadiness = frontierPayload.readiness;

    const blocking = blockingFindings(findingsFromReport(frontierPayload, { turnId: frontier.turnId }));
    if (blocking.length > 0) {
      engine.reportFrontier(workflowId, true);
      for (const finding of blocking) {
        raiseObjection(comp, workflowId, iterationId, frontier.turnId, input.frontierAgentId, {
          id: finding.id,
          severity: "blocking",
          dimension: "frontier",
          claim: finding.claim.value,
          evidence: finding.evidence,
          evidenceMissing: false,
        });
        views.set(finding.id, {
          id: finding.id,
          dimension: "frontier",
          severity: "blocking",
          claim: finding.claim.value,
          evidence: finding.evidence,
          status: "open",
          raisedBy: input.frontierAgentId,
          turnId: frontier.turnId,
        });
      }
      const gate2 = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId });
      if (gate2.phase === "escalated") return finalize();
      continue;
    }

    engine.reportFrontier(workflowId, false);
    if (engine.getState(workflowId).phase === "await_human") {
      engine.advancePlanning(workflowId, "requestHuman");
    }
    if (engine.getState(workflowId).phase === "human_decision") {
      const decision = input.decide({ workflowId, openObjectionIds: openIds(), frontierReadiness });
      engine.humanDecision({
        workflowId,
        decision: decision.decision,
        ...(decision.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
        ...(decision.comment ? { comment: decision.comment } : {}),
      });
    }
    return finalize();
  }

  return finalize();
}

function raiseObjection(
  comp: Composition,
  workflowId: string,
  iterationId: string,
  turnId: string,
  agentId: string,
  objection: {
    id: string;
    severity: "blocking" | "major" | "minor";
    dimension: string;
    claim: string;
    evidence: string[];
    evidenceMissing: boolean;
  },
): void {
  comp.engine.raiseObjection({
    workflowId,
    objectionId: objection.id,
    severity: objection.severity,
    iterationId,
    turnId,
    agentId,
  });
  comp.store.saveObjection({
    objectionId: objection.id,
    workflowId,
    iterationId,
    turnId,
    dimension: objection.dimension,
    severity: objection.severity,
    claim: objection.claim,
    evidence: objection.evidence,
    evidenceMissing: objection.evidenceMissing,
    status: "open",
    raisedBy: agentId,
  });
}
