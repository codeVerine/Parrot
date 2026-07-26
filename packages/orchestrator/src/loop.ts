import type { FrontierResult, PlannerResult, ReviewerResult } from "@platform/contracts";
import { blockingFindings, findingsFromReport } from "@platform/human-loop";
import type { CodebaseContextFile, ObjectionView } from "@platform/llm-boundary";
import type { WorkflowEngineConfig, WorkflowPhase } from "@platform/workflow-engine";
import type { Composition } from "./composition.js";
import type { ResumeSeed } from "./resume.js";

export type HumanDecision = { decision: "approved" | "rejected"; waiveOpenObjections?: boolean; comment?: string };

export type HumanDecisionResolver = (ctx: {
  workflowId: string;
  openObjectionIds: string[];
  frontierReadiness: "ready" | "not_ready" | null;
}) => HumanDecision | Promise<HumanDecision>;

export type ReviewLoopInput = {
  workflowId: string;
  workspaceId: string;
  task: string;
  codebaseContext?: CodebaseContextFile[];
  plannerAgentId: string;
  /** One turn per id; the last runs as an adversarial review when `adversarial` is set. */
  reviewerAgentIds: string[];
  frontierAgentId: string;
  decide: HumanDecisionResolver;
  adversarial?: boolean;
  maxIterations?: number;
  config?: Partial<WorkflowEngineConfig>;
  /**
   * Continue an interrupted workflow from its recovered state instead of starting a
   * fresh one. When set, `startWorkflow` is skipped (the engine state is already folded
   * from the event log) and the loop's scratch is seeded from the database.
   */
  resume?: ResumeSeed;
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
 * frontier, human decision. Implemented as a dispatcher over the engine's folded
 * `phase` so a fresh run (enters at `planner_turn`, iteration 1) and a resumed run
 * (enters at the recovered phase) share one code path. The interrupted turn re-runs;
 * turns completed before the interruption live in folded state and are not re-executed.
 */
export async function runReviewLoop(
  comp: Composition,
  input: ReviewLoopInput,
): Promise<ReviewLoopResult> {
  const { engine } = comp;
  const { workflowId } = input;
  const maxIterations = input.maxIterations ?? input.resume?.maxIterations ?? 5;

  const views = input.resume ? input.resume.views : new Map<string, ObjectionView>();
  let frontierReadiness: "ready" | "not_ready" | null = input.resume ? input.resume.frontierReadiness : null;
  let finalProposalPath: string | undefined = input.resume?.finalProposalPath;
  let proposalSummary: string | undefined = input.resume?.proposalSummary;
  const codebaseContext = input.codebaseContext ?? [];
  const codebaseContextArgs = codebaseContext.length > 0 ? { codebaseContext } : {};
  // The loop owns its iteration counter (1-based, +1 per planner round). It is NOT
  // derived from the engine's folded `iterationCount`, which double-counts and is not a
  // usable iteration number. On resume it starts at the interrupted iteration.
  let iteration = input.resume ? input.resume.iteration : 1;

  if (!input.resume) {
    comp.startWorkflow({
      workflowId,
      workspaceId: input.workspaceId,
      task: input.task,
      config: { ...input.config, maxIterations },
    });
  }

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
    iterations: iteration,
    openObjectionIds: openIds(),
    frontierReadiness,
    ...(finalProposalPath ? { finalProposalPath } : {}),
    ...extra,
  });

  // Steps that run after the planner (reviewers, frontier) need the current proposal.
  // On a fresh run it is set by the planner step; on a resume that re-enters past the
  // planner it comes from the reused planner result file (the seed).
  const requireProposal = (phase: WorkflowPhase): string => {
    if (!finalProposalPath) {
      throw new Error(
        `Cannot resume at phase "${phase}": no completed planner proposal was found to reuse. ` +
          "The workflow may be too incomplete to resume; start a fresh run instead.",
      );
    }
    return finalProposalPath;
  };

  for (;;) {
    const phase = engine.getState(workflowId).phase;
    const iterationId = `${workflowId}-iter-${iteration}`;
    const nextIterationId = `${workflowId}-iter-${iteration + 1}`;

    switch (phase) {
      case "planner_turn": {
        if (iteration > maxIterations) return finalize();
        const planner = await comp.runTurn({
          turnType: iteration === 1 ? "planner_propose" : "planner_revise",
          workflowId,
          iterationId,
          agentId: input.plannerAgentId,
          context: { task: input.task, openObjections: openViews(), ...codebaseContextArgs },
          iterationNumber: iteration,
        });
        if (planner.status !== "valid") return finalize({ failedTurnId: planner.turnId });
        const plannerPayload = planner.payload as PlannerResult;
        finalProposalPath = plannerPayload.proposalPath;
        proposalSummary = plannerPayload.summary;

        // Resolve only objections that are not already resolved.
        const state = engine.getState(workflowId);
        for (const objectionId of plannerPayload.objectionsAddressed) {
          if (views.has(objectionId) && state.objections[objectionId]?.status === "open") {
            engine.resolveObjection({ workflowId, objectionId, resolution: "addressed by planner" });
            // Update only the status in the persisted objection row (preserve provenance).
            comp.store.updateObjectionStatus(objectionId, "resolved");
            views.delete(objectionId);
          }
        }

        engine.advancePlanning(workflowId, "plannerCompleted");
        engine.advancePlanning(workflowId, "reviewersSpawned");
        break;
      }

      // Transient state between the two planner->reviewer transitions; only reachable if
      // an interruption landed exactly here. Finish the pending transition.
      case "spawn_reviewers":
        engine.advancePlanning(workflowId, "reviewersSpawned");
        break;

      case "collect_objections": {
        const proposalPath = requireProposal(phase);
        for (const [i, agentId] of input.reviewerAgentIds.entries()) {
          const isAdversarial = input.adversarial === true && i === input.reviewerAgentIds.length - 1;
          const reviewer = await comp.runTurn({
            turnType: isAdversarial ? "adversarial_review" : "reviewer_review",
            workflowId,
            iterationId,
            agentId,
            context: {
              proposalPath,
              ...(proposalSummary ? { proposalSummary } : {}),
              openObjections: openViews(),
              allObjections: [...views.values()],
              ...codebaseContextArgs,
            },
          });
          if (reviewer.status !== "valid") continue;
          for (const objection of (reviewer.payload as ReviewerResult).objections) {
            // Skip if this exact objection ID is already persisted from the same reviewer turn.
            const existingView = views.get(objection.id);
            if (existingView && existingView.turnId === reviewer.turnId) continue;

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
        break;
      }

      // Transient state between objectionsCollected and mergeCompleted.
      case "merge_objections":
        engine.advancePlanning(workflowId, "mergeCompleted");
        break;

      case "objection_gate": {
        const gate = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId });
        if (gate.phase === "escalated") return finalize();
        if (gate.phase === "planner_turn") iteration += 1; // loop back for another round
        break; // -> planner_turn (next iteration) or iteration_cap_check
      }

      case "iteration_cap_check":
      case "frontier_review": {
        const proposalPath = requireProposal(phase);
        const frontier = await comp.runTurn({
          turnType: "frontier_report",
          workflowId,
          iterationId,
          agentId: input.frontierAgentId,
          context: {
            proposalPath,
            ...(proposalSummary ? { proposalSummary } : {}),
            allObjections: [...views.values()],
            ...codebaseContextArgs,
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
          // Persist all blocking objections before calling reportFrontier.
          for (const finding of blocking) {
            // Skip if this exact finding was already persisted from the same frontier turn.
            const existingView = views.get(finding.id);
            if (existingView && existingView.turnId === frontier.turnId) continue;

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
          engine.reportFrontier(workflowId, true);
        } else {
          engine.reportFrontier(workflowId, false);
        }
        break;
      }

      case "frontier_to_objections": {
        const gate = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId });
        if (gate.phase === "escalated") return finalize();
        if (gate.phase === "planner_turn") iteration += 1; // loop back for another round
        break;
      }

      case "await_human":
        engine.advancePlanning(workflowId, "requestHuman");
        break;

      case "human_decision": {
        const decision = await input.decide({ workflowId, openObjectionIds: openIds(), frontierReadiness });
        engine.humanDecision({
          workflowId,
          decision: decision.decision,
          ...(decision.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
          ...(decision.comment ? { comment: decision.comment } : {}),
        });
        break;
      }

      case "approved":
      case "rejected":
      case "escalated":
        return finalize();

      default: {
        const _exhaustive: never = phase;
        void _exhaustive;
        return finalize();
      }
    }
  }
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
