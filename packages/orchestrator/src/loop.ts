import type { FrontierResult, PlannerResult, ReviewerResult } from "@platform/contracts";
import { blockingFindings, escalationAttention, findingsFromReport, frontierFailedAttention } from "@platform/human-loop";
import type { CodebaseContextFile, ObjectionView } from "@platform/llm-boundary";
import { stalemateObjectionIds, type FoldedState, type WorkflowEngineConfig, type WorkflowPhase } from "@platform/workflow-engine";
import type { Composition } from "./composition.js";
import { buildStalemateReport } from "./escalation-report.js";
import {
  humanMessagesContextArgs,
  humanMessagesFromFeedback,
  normalizeStalemateResolution,
  persistHumanGuidance,
  stalemateFeedbackDecision,
  type HumanMessage,
  type StalemateChoice,
  type StalemateResolution,
} from "./human-guidance.js";
import {
  isMajorRestructuring,
  loadProposalAtIteration,
} from "./proposal-diff.js";
import { assertProposalFresh, readProposalHash } from "./proposal-integrity.js";
import type { ResumeSeed } from "./resume.js";
import { readFileSync } from "node:fs";
import { hashProposalFile } from "./turn.js";

export type { StalemateChoice, StalemateResolution, HumanMessage } from "./human-guidance.js";

export type HumanDecision = { decision: "approved" | "rejected"; waiveOpenObjections?: boolean; comment?: string };

export type PairReviewSummary = {
  agentId: string;
  summary: string;
};

export type HumanDecisionResolver = (ctx: {
  workflowId: string;
  openObjectionIds: string[];
  /** Open objections with claim/severity for human-facing prompts. */
  openObjections: ObjectionView[];
  frontierReadiness: "ready" | "not_ready" | null;
  proposalPath?: string;
  proposalHash?: string;
  proposalSummary?: string;
  /** Pair summaries for the current Author proposal iteration only. */
  pairReviewSummaries?: PairReviewSummary[];
}) => HumanDecision | Promise<HumanDecision>;

export type StalemateResolver = (ctx: {
  workflowId: string;
  objectionIds: string[];
  report: string;
  reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn";
  proposalPath?: string;
  proposalHash?: string;
  proposalSummary?: string;
  openObjections?: ObjectionView[];
}) => StalemateChoice | StalemateResolution | Promise<StalemateChoice | StalemateResolution>;

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
  /**
   * Called on an objection stalemate (open + resolved-then-reraised), a planner-reported
   * guardrail conflict (an addressal that concedes or needs a guardrail exception), or plan
   * churn. Defaults to "abort".
   */
  onStalemate?: StalemateResolver;
  adversarial?: boolean;
  maxIterations?: number;
  config?: Partial<WorkflowEngineConfig>;
  /**
   * Continue an interrupted workflow from its recovered state instead of starting a
   * fresh one. When set, `startWorkflow` is skipped (the engine state is already folded
   * from the event log) and the loop's scratch is seeded from the database.
   */
  resume?: ResumeSeed;
  /** Emit one concise line after each planner/reviewer/frontier turn completes. */
  onProgress?: (line: string) => void;
  /** Mid-loop frontier re-invoke when the planner restructures the proposal. */
  frontierReinvoke?: {
    disabled?: boolean;
    headingChangeRatio?: number;
    similarityFloor?: number;
  };
  /**
   * Reserved for a future churn detection heuristic.
   *
   * Churn detection is intentionally **deferred**: similarity-based heuristics
   * have not yet separated the motivating reversion from ordinary revisions on
   * real proposals. This config is accepted as a **no-op** so callers passing
   * legacy config do not fail validation.
   */
  churnDetection?: {
    scoreFloor?: number;
    churnMargin?: number;
    disabled?: boolean;
  };
};

export type ReviewLoopResult = {
  phase: WorkflowPhase;
  iterations: number;
  openObjectionIds: string[];
  frontierReadiness: "ready" | "not_ready" | null;
  finalProposalPath?: string;
  finalProposalHash?: string;
  failedTurnId?: string;
  frontierFailed?: boolean;
  escalation?: { reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn"; objectionIds: string[] };
  /** Binding human guidance collected during this run (and rehydrated on resume). */
  humanMessages: HumanMessage[];
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

  if (input.reviewerAgentIds.length === 0) {
    throw new Error(
      "runReviewLoop requires at least one Pair agent in reviewerAgentIds (fail-closed).",
    );
  }

  const maxIterationsCap = input.maxIterations ?? input.resume?.maxIterations ?? 5;
  let maxIterations = maxIterationsCap;

  const views = input.resume ? input.resume.views : new Map<string, ObjectionView>();
  let frontierReadiness: "ready" | "not_ready" | null = input.resume ? input.resume.frontierReadiness : null;
  let finalProposalPath: string | undefined = input.resume?.finalProposalPath;
  let finalProposalHash: string | undefined = input.resume?.finalProposalHash;
  let proposalSummary: string | undefined = input.resume?.proposalSummary;
  let pairReviewSummaries: PairReviewSummary[] = input.resume?.pairReviewSummaries
    ? [...input.resume.pairReviewSummaries]
    : [];
  let lastFrontierIteration = input.resume?.lastFrontierIteration ?? 0;
  const codebaseContext = input.codebaseContext ?? [];
  const codebaseContextArgs = codebaseContext.length > 0 ? { codebaseContext } : {};
  let iteration = input.resume ? input.resume.iteration : 1;
  const frontierReinvokeDisabled = input.frontierReinvoke?.disabled === true;
  // Defaults calibrated against the cited corpus (see
  // docs/phases/phase-12-plan-churn-and-frontier-reinvoke.md section 5):
  // iteration 2's borderline 0.489 similarity should NOT fire (set floor at
  // 0.4 so 0.489 sits above it); iteration 3's 0.765 heading-change ratio
  // should fire (set threshold at 0.7 so 0.765 clears it).
  const frontierHeadingChangeRatio = input.frontierReinvoke?.headingChangeRatio ?? 0.7;
  const frontierSimilarityFloor = input.frontierReinvoke?.similarityFloor ?? 0.4;
  const humanMessages: HumanMessage[] = input.resume?.humanMessages
    ? [...input.resume.humanMessages]
    : humanMessagesFromFeedback(comp.store, workflowId);
  const guidanceArgs = () => humanMessagesContextArgs(humanMessages);

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
    humanMessages: [...humanMessages],
    ...(finalProposalPath ? { finalProposalPath } : {}),
    ...(finalProposalHash ? { finalProposalHash } : {}),
    ...extra,
  });

  const ensureProposalFresh = (): string | null => {
    if (!finalProposalPath || !finalProposalHash) {
      return "Cannot approve or implement without a hashed Author proposal of record";
    }
    const check = assertProposalFresh({
      proposalPath: finalProposalPath,
      expectedHash: finalProposalHash,
    });
    return check.ok ? null : check.reason;
  };

  const commitApproval = (opts?: {
    waiveOpenObjections?: boolean;
    comment?: string;
  }): boolean => {
    const stale = ensureProposalFresh();
    if (stale) {
      input.onProgress?.(`[human] refused stale proposal: ${compactProgress(stale)}`);
      return false;
    }
    engine.humanDecision({
      workflowId,
      decision: "approved",
      ...(opts?.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
      ...(opts?.comment ? { comment: opts.comment } : {}),
    });
    return true;
  };

  /**
   * Common resolution for an escalation that should not dead-end the run: ask
   * `onStalemate` (reused for objection stalemate, guardrail conflict, and plan
   * churn) and act on it.
   * "continue" means the loop should re-read phase and keep going.
   */
  const resolveEscalation = async (
    reason: "objection_stalemate" | "guardrail_conflict" | "plan_churn",
    objectionIds: string[],
    reportOverride?: string,
  ): Promise<"continue" | ReviewLoopResult> => {
    const report = reportOverride ?? buildStalemateReport(comp.store, workflowId, objectionIds, reason === "plan_churn" ? "objection_stalemate" : reason);
    const rawChoice = input.onStalemate
      ? await input.onStalemate({
          workflowId,
          objectionIds,
          report,
          reason,
          ...(finalProposalPath ? { proposalPath: finalProposalPath } : {}),
          ...(finalProposalHash ? { proposalHash: finalProposalHash } : {}),
          ...(proposalSummary ? { proposalSummary } : {}),
          openObjections: openViews(),
        })
      : "abort";
    const { choice, guidance } = normalizeStalemateResolution(rawChoice);
    if (guidance) {
      persistHumanGuidance({
        store: comp.store,
        workflowId,
        decision: stalemateFeedbackDecision(choice),
        guidance,
        iterationId: `${workflowId}-iter-${iteration}`,
        messages: humanMessages,
        afterIteration: iteration,
      });
    }

    if (choice === "accept_mitigation") {
      if (!commitApproval({ waiveOpenObjections: true })) {
        return finalize();
      }
      return "continue";
    }
    if (choice === "accept_objection") {
      // Reviewer side wins: keep objections open, bump stalemate threshold and
      // maxIterations, return to planner_turn for another revision round.
      engine.continueAfterStalemate({ workflowId, objectionIds });
      maxIterations += 1;
      iteration += 1;
      return "continue";
    }
    // Abort: the human is not in the loop, so the durable record stands but
    // no notification fired. Emit one now so the dashboard / herdr sink sees
    // the escalation. The request uses the same `escalation` kind and
    // configured dashboard base that the engine's `adaptEscalationSink`
    // would have produced, so a sink cannot distinguish this re-emit from a
    // synchronous engine notification.
    await comp.humanSink.notify(
      escalationAttention(workflowId, comp.humanLoopConfig, reason, objectionIds),
    );
    return finalize({ escalation: { reason, objectionIds } });
  };

  /**
   * After `evaluateObjectionGate`, `escalated` may mean either the iteration cap or a
   * stalemate (an objection resolved once and re-raised) - the fold only sets
   * `iterationCapReached` for the former, so that flag disambiguates.
   */
  const handleGateResult = async (gate: FoldedState): Promise<"continue" | ReviewLoopResult> => {
    if (gate.phase === "planner_turn") {
      iteration += 1;
      return "continue";
    }
    if (gate.phase !== "escalated") return "continue"; // -> iteration_cap_check
    if (gate.iterationCapReached) {
      await comp.humanSink.notify(
        escalationAttention(workflowId, comp.humanLoopConfig, "iteration_cap", openIds()),
      );
      return finalize();
    }

    const stalemateIds = stalemateObjectionIds(gate);
    if (stalemateIds.length === 0) return finalize();
    return resolveEscalation("objection_stalemate", stalemateIds);
  };

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
        const inputObjectionIds = openIds();
        const planner = await comp.runTurn({
          turnType: iteration === 1 ? "planner_propose" : "planner_revise",
          workflowId,
          iterationId,
          agentId: input.plannerAgentId,
          context: {
            task: input.task,
            openObjections: openViews(),
            // Revise must re-open the prior plan of record; without this path the
            // planner only sees objections and may invent a shallow new proposal.
            ...(iteration > 1 && finalProposalPath
              ? {
                  proposalPath: finalProposalPath,
                  ...(proposalSummary ? { proposalSummary } : {}),
                }
              : {}),
            ...codebaseContextArgs,
            ...guidanceArgs(),
          },
          iterationNumber: iteration,
          inputObjectionIds,
        });
        if (planner.status !== "valid") {
          input.onProgress?.(`[author iter ${iteration}] failed: ${compactProgress(planner.reason)}`);
          return finalize({ failedTurnId: planner.turnId });
        }
        const plannerPayload = planner.payload as PlannerResult;
        input.onProgress?.(`[author iter ${iteration}] ${compactProgress(plannerPayload.summary)}`);
        finalProposalPath = plannerPayload.proposalPath;
        proposalSummary = plannerPayload.summary;
        try {
          finalProposalHash = hashProposalFile(plannerPayload.proposalPath);
        } catch {
          input.onProgress?.(`[author iter ${iteration}] failed: proposal file unreadable for hashing`);
          return finalize({ failedTurnId: planner.turnId });
        }

        const addressals = plannerPayload.objectionsAddressed;
        const liveState = engine.getState(workflowId);

        // Legacy bare-ID addressals come from a pre-Phase-10 result.toon
        // that resume rehydrated; the schema normalized the bare string to
        // a synthetic `{resolutionStrategy: "revised_plan", evidence: ""}`
        // entry. They have no real strategy or evidence and would otherwise
        // be persisted as `revised_plan / (no evidence)` decisions, polluting
        // the durable trail. The marker is set by `LegacyObjectionIdSchema`
        // in @platform/contracts and is not JSON-serializable, so the
        // transport stays clean while the in-memory loop can distinguish.
        const liveAddressals = addressals.filter((a) => !isLegacyAddressal(a));

        // Persist only addressals that target an open objection in the
        // loop's view map. A planner that "addresses" an objection the loop
        // already resolved, or one that was never raised, would otherwise
        // be saved as a real revised_plan / (no evidence) decision and
        // pollute the durable trail. The conflict branch below only fires
        // for addressals with a live objection (the planner had to address
        // a real open objection to concede it), so this filter is safe.
        for (const addressal of liveAddressals) {
          if (!views.has(addressal.objectionId)) continue;
          if (liveState.objections[addressal.objectionId]?.status !== "open") continue;
          comp.store.saveDecision({
            decisionId: `${planner.turnId}-${addressal.objectionId}`,
            workflowId,
            iterationId,
            turnId: planner.turnId,
            decision: "objection_addressal",
            chosen: addressal.resolutionStrategy,
            alternatives: [],
            reason: addressal.evidence || "(no evidence)",
            objectionIds: [addressal.objectionId],
          });
        }

        // A conceded objection or one that needs a guardrail exception is a design
        // impossibility, not a revision - escalate immediately with zero reviewer
        // turns dispatched rather than let the loop burn an iteration on a workaround
        // the guardrails forbid.
        const conflicts = liveAddressals.filter(
          (a) => a.requiresGuardrailException || a.resolutionStrategy === "conceded",
        );
        if (conflicts.length > 0) {
          const conflictIds = conflicts.map((c) => c.objectionId);
          const detail = conflicts
            .map((c) => `${c.objectionId} (${c.resolutionStrategy}): ${c.evidence || "(no evidence)"}`)
            .join("; ");
          engine.reportGuardrailConflict({
            workflowId,
            objectionIds: conflictIds,
            detail,
            iterationId,
            turnId: planner.turnId,
            agentId: input.plannerAgentId,
            notify: false,
          });
          const outcome = await resolveEscalation("guardrail_conflict", conflictIds);
          if (outcome !== "continue") return outcome;
          break;
        }

        // Plan churn detection is intentionally deferred. See the comment on
        // ReviewLoopInput.churnDetection and the Phase 12 doc. The integration
        // slot is kept here so a future heuristic can plug in without reshaping
        // the planner->reviewer transition.

        // Resolve only objections that are not already resolved. Skip legacy
        // bare-ID addressals: a pre-Phase-10 result.toon rehydrated via
        // resume has no real strategy or evidence, so resolving an open
        // objection on its word would silently close a debate the planner
        // never actually addressed. The conflict branch above already
        // skipped them; this branch must too.
        for (const addressal of liveAddressals) {
          const { objectionId } = addressal;
          if (views.has(objectionId) && liveState.objections[objectionId]?.status === "open") {
            const evidence = addressal.evidence || "(no evidence)";
            engine.resolveObjection({
              workflowId,
              objectionId,
              resolution: `${addressal.resolutionStrategy}: ${evidence}`,
              iterationId,
              turnId: planner.turnId,
            });
            // Update only the status in the persisted objection row (preserve provenance).
            comp.store.updateObjectionStatus(workflowId, objectionId, "resolved");
            // Retain the view as resolved with addressal evidence for the next Pair prompt.
            const prior = views.get(objectionId)!;
            views.set(objectionId, {
              ...prior,
              status: "resolved",
              addressal: {
                resolutionStrategy: addressal.resolutionStrategy,
                evidence,
              },
            });
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
        if (!finalProposalHash) {
          const hashed = readProposalHash(proposalPath);
          if (!hashed) {
            return finalize({
              failedTurnId: undefined,
              // Surface as a failed planning step without a clean gate.
            });
          }
          finalProposalHash = hashed;
        }
        // Current-iteration Pair summaries only (matches resume recovery).
        pairReviewSummaries = [];
        for (const [i, agentId] of input.reviewerAgentIds.entries()) {
          const isAdversarial = input.adversarial === true && i === input.reviewerAgentIds.length - 1;
          const reviewer = await comp.runTurn({
            turnType: isAdversarial ? "adversarial_review" : "reviewer_review",
            workflowId,
            iterationId,
            agentId,
            context: {
              proposalPath,
              proposalHash: finalProposalHash,
              ...(proposalSummary ? { proposalSummary } : {}),
              openObjections: openViews(),
              allObjections: [...views.values()],
              ...codebaseContextArgs,
              ...guidanceArgs(),
            },
            expectedProposalPath: proposalPath,
            expectedProposalHash: finalProposalHash,
          });
          if (reviewer.status !== "valid") {
            input.onProgress?.(
              `[${isAdversarial ? "pair-adversarial" : "pair"} iter ${iteration}] failed: ${compactProgress(reviewer.reason)}`,
            );
            // Fail-closed: a missing/malformed/stale Pair review must not open a clean gate.
            return finalize({ failedTurnId: reviewer.turnId });
          }
          const reviewerPayload = reviewer.payload as ReviewerResult;
          if (reviewerPayload.summary?.trim()) {
            pairReviewSummaries.push({
              agentId,
              summary: reviewerPayload.summary.trim(),
            });
          }
          input.onProgress?.(
            `[${isAdversarial ? "pair-adversarial" : "pair"} iter ${iteration}] objections=${reviewerPayload.objections.length}` +
              (reviewerPayload.objections.length === 0 && reviewerPayload.cleanRationale?.trim()
                ? ", cleanRationale=present"
                : ""),
          );
          for (const objection of reviewerPayload.objections) {
            // Skip if this exact objection ID is already persisted from the same reviewer turn.
            const existingView = views.get(objection.id);
            if (existingView && existingView.turnId === reviewer.turnId) continue;

            const suggested = objection.suggestedResolution?.trim();
            raiseObjection(comp, workflowId, iterationId, reviewer.turnId, agentId, {
              id: objection.id,
              severity: objection.severity,
              dimension: "review",
              claim: objection.claim,
              evidence: objection.evidence,
              evidenceMissing: objection.evidence_missing === true,
              ...(suggested ? { suggestedResolution: suggested } : {}),
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
              ...(suggested ? { suggestedResolution: suggested } : {}),
            });
          }
        }
        // Frontier re-invoke: if the planner restructured the proposal while objections
        // remain open and the frontier has not already run this iteration, dispatch a
        // mid-loop frontier turn and convert blocking findings to objections.
        if (
          !frontierReinvokeDisabled &&
          iteration >= 2 &&
          lastFrontierIteration < iteration
        ) {
          const openObjectionViews = openViews();
          if (openObjectionViews.length > 0) {
            const prev = loadProposalAtIteration(comp.store, workflowId, iteration - 1);
            if (prev && finalProposalPath) {
              const currentText = readProposalTextOrNull(finalProposalPath);
              // A missing current proposal is not a restructuring signal; skip
              // silently so a transient read failure cannot dispatch a frontier
              // turn against an empty comparison.
              if (currentText !== null && isMajorRestructuring(prev.text, currentText, {
                headingChangeRatio: frontierHeadingChangeRatio,
                similarityFloor: frontierSimilarityFloor,
              })) {
                const frontierIterationId = `${workflowId}-iter-${iteration}`;
                lastFrontierIteration = iteration;
                const frontier = await comp.runTurn({
                  turnType: "frontier_report",
                  workflowId,
                  iterationId: frontierIterationId,
                  agentId: input.frontierAgentId,
                  context: {
                    proposalPath: finalProposalPath,
                    ...(proposalSummary ? { proposalSummary } : {}),
                    allObjections: [...views.values()],
                    ...codebaseContextArgs,
                    ...guidanceArgs(),
                  },
                  iterationNumber: iteration,
                });
                if (frontier.status === "valid") {
                  const midLoopPayload = frontier.payload as FrontierResult;
                  input.onProgress?.(frontierProgressLine(iteration, midLoopPayload));
                  frontierReadiness = midLoopPayload.readiness;
                  ingestFrontierFindings(
                    comp,
                    workflowId,
                    frontierIterationId,
                    frontier,
                    views,
                    input.frontierAgentId,
                  );
                }
              }
            }
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
        // Suppress the engine's escalation notification on this step. The
        // gate can fire either an ObjectionStalemate (resolved-then-reraised)
        // or an IterationCapReached notification; in both cases the loop is
        // the one that will prompt the human interactively, and re-emitting
        // the engine's notification would duplicate the human-attention
        // request before the prompt lands. The loop's resolveEscalation
        // re-emits an `escalation` request via escalationAttention only
        // when the resolver returns "abort"; accept_mitigation /
        // accept_objection therefore produce zero notifications.
        const gate = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId, notify: false });
        const outcome = await handleGateResult(gate);
        if (outcome !== "continue") return outcome;
        break; // -> planner_turn (next iteration) or iteration_cap_check
      }

      case "iteration_cap_check":
      case "frontier_review": {
        lastFrontierIteration = iteration;
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
            ...guidanceArgs(),
          },
        });
        if (frontier.status !== "valid") {
          input.onProgress?.(`[frontier iter ${iteration}] failed: ${compactProgress(frontier.reason)}`);
          await comp.humanSink.notify(
            frontierFailedAttention(workflowId, comp.humanLoopConfig, "frontier_turn_failed"),
          );
          return finalize({ failedTurnId: frontier.turnId, frontierFailed: true });
        }
        const frontierPayload = frontier.payload as FrontierResult;
        frontierReadiness = frontierPayload.readiness;
        input.onProgress?.(frontierProgressLine(iteration, frontierPayload));

        const frontierBlockingCount = blockingFindings(
          findingsFromReport(frontierPayload, { turnId: frontier.turnId }),
        ).length;
        // The mid-loop frontier re-invoke runs in collect_objections (not this
        // case) and does not call reportFrontier; only the terminal
        // iteration_cap_check / frontier_review path advances the engine.
        // Ingestion runs after reportFrontier so the reducer's cap-binding
        // guard does not reject when the frontier itself raises the first
        // blocking objections at the iteration cap.
        engine.reportFrontier(workflowId, frontierBlockingCount > 0);
        ingestFrontierFindings(
          comp,
          workflowId,
          iterationId,
          frontier,
          views,
          input.frontierAgentId,
        );
        break;
      }

      case "frontier_to_objections": {
        const gate = engine.advancePlanning(workflowId, "evaluateObjectionGate", { nextIterationId, notify: false });
        const outcome = await handleGateResult(gate);
        if (outcome !== "continue") return outcome;
        break;
      }

      case "await_human":
        engine.advancePlanning(workflowId, "requestHuman");
        break;

      case "human_decision": {
        const decision = await input.decide({
          workflowId,
          openObjectionIds: openIds(),
          openObjections: openViews(),
          frontierReadiness,
          ...(finalProposalPath ? { proposalPath: finalProposalPath } : {}),
          ...(finalProposalHash ? { proposalHash: finalProposalHash } : {}),
          ...(proposalSummary ? { proposalSummary } : {}),
          ...(pairReviewSummaries.length > 0 ? { pairReviewSummaries } : {}),
        });
        if (decision.comment?.trim()) {
          persistHumanGuidance({
            store: comp.store,
            workflowId,
            decision: decision.decision,
            guidance: decision.comment,
            iterationId: `${workflowId}-iter-${iteration}`,
            messages: humanMessages,
            afterIteration: iteration,
          });
        }
        if (decision.decision === "approved") {
          if (
            !commitApproval({
              ...(decision.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
              ...(decision.comment ? { comment: decision.comment } : {}),
            })
          ) {
            return finalize();
          }
        } else {
          engine.humanDecision({
            workflowId,
            decision: decision.decision,
            ...(decision.waiveOpenObjections ? { waiveOpenObjections: true } : {}),
            ...(decision.comment ? { comment: decision.comment } : {}),
          });
        }
        break;
      }

      case "approved":
      case "rejected":
        return finalize();

      case "escalated": {
        // Resume after Ctrl+C at a stalemate prompt leaves phase=escalated. Re-offer the
        // human choice instead of treating that as a terminal exit.
        const state = engine.getState(workflowId);
        if (state.iterationCapReached) return finalize();
        const stalemateIds = stalemateObjectionIds(state);
        if (stalemateIds.length === 0) return finalize();
        const outcome = await resolveEscalation("objection_stalemate", stalemateIds);
        if (outcome !== "continue") return outcome;
        break;
      }

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
    suggestedResolution?: string;
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
    ...(objection.suggestedResolution
      ? { suggestedResolution: objection.suggestedResolution }
      : {}),
    status: "open",
    raisedBy: agentId,
  });
}

function compactProgress(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function frontierProgressLine(iteration: number, payload: FrontierResult): string {
  return `[frontier iter ${iteration}] readiness=${payload.readiness}, risks=${payload.risks.length}, questions=${payload.questions.length}`;
}

function readProposalTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Type guard: an addressal is "legacy" when the schema transform set a
 * non-enumerable `__legacy` marker on it. This happens only when a pre-
 * Phase-10 result.toon is rehydrated via resume; fresh planner results
 * never carry the marker. Legacy entries have empty evidence and a
 * synthetic `revised_plan` strategy and must not be persisted as real
 * decisions or treated as a planner's intentional concession.
 */
function isLegacyAddressal(addressal: { [k: string]: unknown }): boolean {
  return addressal.__legacy === true;
}

/**
 * Convert a frontier turn's blocking findings into objections, recording
 * them in the engine and the loop's scratch view map. Skips findings the
 * loop already ingested for this turn id (idempotent across mid-loop and
 * terminal invocations). Returns the count ingested in this call.
 */
function ingestFrontierFindings(
  comp: Composition,
  workflowId: string,
  iterationId: string,
  frontier: { turnId: string; payload: unknown },
  views: Map<string, ObjectionView>,
  frontierAgentId: string,
): number {
  const payload = frontier.payload as FrontierResult;
  const blocking = blockingFindings(findingsFromReport(payload, { turnId: frontier.turnId }));
  for (const finding of blocking) {
    const existingView = views.get(finding.id);
    if (existingView && existingView.turnId === frontier.turnId) continue;
    raiseObjection(comp, workflowId, iterationId, frontier.turnId, frontierAgentId, {
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
      raisedBy: frontierAgentId,
      turnId: frontier.turnId,
    });
  }
  return blocking.length;
}
