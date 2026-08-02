import type { TurnState } from "@platform/persistence";
import {
  FrontierResultSchema,
  PlannerResultSchema,
  isProposalContentHash,
  parseToon,
} from "@platform/contracts";
import type { ObjectionView } from "@platform/llm-boundary";
import {
  isRichPairPrompt,
  ResultExtractor,
  withLlmBoundaryConfig,
} from "@platform/llm-boundary";
import type { WorkflowEngine, WorkflowPhase } from "@platform/workflow-engine";
import type { PersistenceStore } from "@platform/persistence";
import {
  loadCompletedResult,
  parseImplementationPayload,
  parseResolutionPayload,
} from "./completed-result.js";
import { humanMessagesFromFeedback } from "./human-guidance.js";
import { repairObjectionProjection } from "./objection-projection.js";
import {
  assertProposalFresh,
  readApprovedProposalBinding,
  readProposalHash,
} from "./proposal-integrity.js";

/**
 * A persisted turn that can be adopted on resume without re-dispatching it.
 * Eligible states: waiting, validating, completed.
 */
export type ResumableTurn = {
  turnId: string;
  workflowId: string;
  iterationId: string;
  agentId: string;
  state: Extract<TurnState, "waiting" | "validating" | "completed">;
  attempt: "primary" | "repair";
  nonce: string;
  promptPath: string;
  promptHash: string;
  promptVersion: string;
  resultPath: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Everything the review loop needs to continue an interrupted workflow instead of
 * starting a fresh one. The engine's folded state (phase, iteration, objections) is
 * recovered from the event log; this carries the loop's in-memory scratch that is not
 * in folded state - the objection views and the last proposal/frontier artifacts,
 * re-read from the completed turns' result files.
 */
export type ResumeSeed = {
  workflowId: string;
  task: string;
  workspaceId: string;
  phase: WorkflowPhase;
  iteration: number;
  /** The iteration cap this workflow was started with, so a resume keeps the same bound. */
  maxIterations?: number;
  views: Map<string, ObjectionView>;
  finalProposalPath?: string;
  finalProposalHash?: string;
  proposalSummary?: string;
  /** Pair summaries from the newest iteration only (matches live loop). */
  pairReviewSummaries?: Array<{ agentId: string; summary: string }>;
  frontierReadiness: "ready" | "not_ready" | null;
  /** Set to 0 on resume: mid-loop frontier findings may not have been ingested when
   * the process died, so don't skip the frontier on resume. One extra turn is harmless. */
  lastFrontierIteration: number;
  /** Binding human guidance rehydrated from human_feedback. */
  humanMessages?: Array<{ afterIteration: number; message: string }>;
};

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/**
 * Resolve which workflow to resume. An explicit id must exist; otherwise pick the most
 * recently updated workflow that has not reached a terminal review outcome.
 */
export function selectResumeWorkflowId(store: PersistenceStore, explicitId?: string): string {
  if (explicitId) {
    if (!store.getWorkflow(explicitId)) {
      throw new Error(`No workflow "${explicitId}" found in the database to resume.`);
    }
    return explicitId;
  }
  const candidates = store.listResumableWorkflows();
  const newest = candidates[0];
  if (!newest) {
    throw new Error(
      "No resumable workflow found (every workflow is approved, rejected, or escalated). " +
        "Start a fresh run, or pass an explicit id with --resume <workflowId>.",
    );
  }
  return str(newest.workflow_id);
}

/**
 * Recover folded state (this also caches it in the engine) and rebuild the loop scratch
 * from the database. `engine.recover` replays the full event log for the workflow.
 */
export function buildResumeSeed(engine: WorkflowEngine, store: PersistenceStore, workflowId: string): ResumeSeed {
  const row = store.getWorkflow(workflowId);
  if (!row) throw new Error(`No workflow "${workflowId}" found in the database to resume.`);

  // Restore the exact planning phase from the durable snapshot (the event log cannot -
  // planning micro-transitions are snapshot-only), and derive the loop's iteration
  // counter from the highest iteration id in the turn log rather than the folded
  // `iterationCount`, which double-counts (seen-iteration tracking plus the gate's own
  // increment) and is not a reliable iteration number.
  const state = engine.rehydrateFromSnapshot(workflowId);
  const views = rehydrateViews(store, workflowId);
  const artifacts = reuseTurnArtifacts(store, workflowId);
  const maxIterations = decodeMaxIterations(row.config_toon);
  const humanMessages = humanMessagesFromFeedback(store, workflowId);

  return {
    workflowId,
    task: str(row.task),
    workspaceId: str(row.workspace_id),
    phase: state.phase,
    iteration: currentIteration(store, workflowId),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    views,
    ...(artifacts.proposalPath ? { finalProposalPath: artifacts.proposalPath } : {}),
    ...(artifacts.proposalHash ? { finalProposalHash: artifacts.proposalHash } : {}),
    ...(artifacts.proposalSummary ? { proposalSummary: artifacts.proposalSummary } : {}),
    ...(artifacts.pairReviewSummaries && artifacts.pairReviewSummaries.length > 0
      ? { pairReviewSummaries: artifacts.pairReviewSummaries }
      : {}),
    frontierReadiness: artifacts.frontierReadiness,
    lastFrontierIteration: 0,
    ...(humanMessages.length > 0 ? { humanMessages } : {}),
  };
}

/** Rebuild the objection view map the loop keeps in memory from the persisted rows. */
export function rehydrateViews(store: PersistenceStore, workflowId: string): Map<string, ObjectionView> {
  repairObjectionProjection(store, workflowId);
  const addressals = latestAddressalsByObjection(store, workflowId);
  const views = new Map<string, ObjectionView>();
  for (const row of store.listObjections(workflowId)) {
    const id = str(row.objection_id);
    const addressal = addressals.get(id);
    views.set(id, {
      id,
      dimension: str(row.dimension),
      severity: str(row.severity) as ObjectionView["severity"],
      claim: str(row.claim),
      evidence: decodeEvidence(row.evidence_toon),
      status: str(row.status) as ObjectionView["status"],
      raisedBy: str(row.raised_by),
      turnId: str(row.turn_id),
      ...(row.evidence_missing ? { evidence_missing: true } : {}),
      ...(typeof row.suggested_resolution === "string" && row.suggested_resolution.trim()
        ? { suggestedResolution: String(row.suggested_resolution).trim() }
        : {}),
      ...(addressal ? { addressal } : {}),
    });
  }
  return views;
}

/** Latest Author addressal decision per objection (listDecisions is created_at ASC). */
function latestAddressalsByObjection(
  store: PersistenceStore,
  workflowId: string,
): Map<string, { resolutionStrategy: string; evidence: string }> {
  const map = new Map<string, { resolutionStrategy: string; evidence: string }>();
  for (const row of store.listDecisions(workflowId)) {
    if (str(row.decision) !== "objection_addressal") continue;
    const strategy = str(row.chosen);
    const evidence = str(row.reason) || "(no evidence)";
    for (const objectionId of decodeObjectionIds(row.objection_ids_toon)) {
      map.set(objectionId, { resolutionStrategy: strategy, evidence });
    }
  }
  return map;
}

function decodeObjectionIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const decoded = parseToon(String(value)) as { objectionIds?: unknown };
    return Array.isArray(decoded.objectionIds) ? decoded.objectionIds.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

/** Highest `-iter-N` iteration number present in the turn log (the iteration the run was on). */
function currentIteration(store: PersistenceStore, workflowId: string): number {
  const prefix = `${workflowId}-iter-`;
  let max = 1;
  for (const turn of store.listTurns(workflowId)) {
    const id = str(turn.iteration_id);
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

function decodeMaxIterations(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const config = parseToon(String(value)) as { maxIterations?: unknown };
    return typeof config.maxIterations === "number" ? config.maxIterations : undefined;
  } catch {
    return undefined;
  }
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

type ReusedArtifacts = {
  proposalPath?: string;
  proposalHash?: string;
  proposalSummary?: string;
  pairReviewSummaries?: Array<{ agentId: string; summary: string }>;
  frontierReadiness: "ready" | "not_ready" | null;
};

/**
 * Re-read completed planner, Pair, and frontier turn result files.
 * Strategy: find the highest iteration with completed turns, then validate
 * every completed turn at that iteration. If ANY artifact at the newest
 * iteration is missing or invalid, throw. Older iterations may be skipped
 * (stale work).
 */
function reuseTurnArtifacts(store: PersistenceStore, workflowId: string): ReusedArtifacts {
  const result: ReusedArtifacts = { frontierReadiness: null };
  const turns = [...store.listTurns(workflowId)]
    .filter((t) => str(t.state) === "completed");

  const prefix = `${workflowId}-iter-`;
  let maxIter = -1;
  for (const turn of turns) {
    const id = str(turn.iteration_id);
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > maxIter) maxIter = n;
  }
  if (maxIter < 0) return result;

  const newestTurns: typeof turns = [];
  for (const turn of turns) {
    const id = str(turn.iteration_id);
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (n === maxIter) newestTurns.push(turn);
  }

  const extractor = new ResultExtractor({ config: withLlmBoundaryConfig() });
  const pairSummaries: Array<{ agentId: string; summary: string }> = [];
  let plannerTurn: (typeof turns)[number] | undefined;
  let frontierTurn: (typeof turns)[number] | undefined;
  const pairTurns: Array<(typeof turns)[number]> = [];

  for (const turn of newestTurns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    const loaded = loadCompletedResult(store, {
      workflowId,
      turnId: identity.turnId,
      resultPath: str(turn.result_path),
      identity,
    });
    if (loaded.role === "planner") plannerTurn = turn;
    else if (loaded.role === "frontier") frontierTurn = turn;
    else if (loaded.role === "reviewer") pairTurns.push(turn);
  }

  if (plannerTurn) {
    const identity = {
      workflowId: str(plannerTurn.workflow_id),
      iterationId: str(plannerTurn.iteration_id),
      turnId: str(plannerTurn.turn_id),
      nonce: str(plannerTurn.nonce),
    };
    const loaded = loadCompletedResult(store, {
      workflowId,
      turnId: identity.turnId,
      resultPath: str(plannerTurn.result_path),
      identity,
    });
    const planner = PlannerResultSchema.safeParse({ role: "planner", ...loaded.payload });
    if (!planner.success) {
      throw new Error(
        `Durable state inconsistency: completed planner turn ${identity.turnId} has an invalid result.`,
      );
    }
    result.proposalPath = planner.data.proposalPath;
    result.proposalSummary = planner.data.summary;
    const hash = readProposalHash(planner.data.proposalPath);
    if (hash) result.proposalHash = hash;
  }

  if (frontierTurn) {
    const identity = {
      workflowId: str(frontierTurn.workflow_id),
      iterationId: str(frontierTurn.iteration_id),
      turnId: str(frontierTurn.turn_id),
      nonce: str(frontierTurn.nonce),
    };
    const loaded = loadCompletedResult(store, {
      workflowId,
      turnId: identity.turnId,
      resultPath: str(frontierTurn.result_path),
      identity,
    });
    const frontier = FrontierResultSchema.safeParse({ role: "frontier", ...loaded.payload });
    if (!frontier.success) {
      throw new Error(
        `Durable state inconsistency: completed frontier turn ${identity.turnId} has an invalid result.`,
      );
    }
    result.frontierReadiness = frontier.data.readiness;
  }

  // Validate every Pair artifact under its persisted prompt version — not just the last one.
  for (const turn of pairTurns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    const loaded = loadCompletedResult(store, {
      workflowId,
      turnId: identity.turnId,
      resultPath: str(turn.result_path),
      identity,
    });
    const promptVersion = str(turn.prompt_version);
    const turnType = promptVersion.startsWith("adversarial@")
      ? ("adversarial_review" as const)
      : ("reviewer_review" as const);
    const verdict = extractor.validate({
      bytes: loaded.resultBytes,
      turn: {
        ...identity,
        turnType,
        attempt: (str(turn.attempt) === "repair" ? "repair" : "primary") as "primary" | "repair",
      },
      promptVersion,
      ...(result.proposalPath ? { expectedProposalPath: result.proposalPath } : {}),
      ...(result.proposalHash ? { expectedProposalHash: result.proposalHash } : {}),
    });
    if (verdict.outcome !== "valid") {
      throw new Error(
        `Durable state inconsistency: completed Pair turn ${identity.turnId} failed semantic validation: ${verdict.reason}`,
      );
    }
    const reviewer = verdict.payload as {
      summary?: string;
      reviewedProposalPath?: string;
      reviewedProposalHash?: string;
    };
    if (reviewer.summary?.trim()) {
      pairSummaries.push({
        agentId: str(turn.agent_id) || "reviewer",
        summary: reviewer.summary.trim(),
      });
    }
    if (isRichPairPrompt(promptVersion)) {
      const path = reviewer.reviewedProposalPath?.trim() ?? "";
      const hash = reviewer.reviewedProposalHash?.trim() ?? "";
      if (!path || !isProposalContentHash(hash)) {
        throw new Error(
          `Durable state inconsistency: completed Pair turn ${identity.turnId} missing proposal identity.`,
        );
      }
      if (result.proposalPath && path !== result.proposalPath) {
        throw new Error(
          `Durable state inconsistency: Pair turn ${identity.turnId} reviewed ${path}, Author proposal is ${result.proposalPath}.`,
        );
      }
      if (result.proposalHash && hash !== result.proposalHash) {
        throw new Error(
          `Durable state inconsistency: Pair turn ${identity.turnId} hash ${hash} does not match Author proposal hash ${result.proposalHash}.`,
        );
      }
      if (!result.proposalHash) result.proposalHash = hash;
    }
  }
  if (pairSummaries.length > 0) {
    result.pairReviewSummaries = pairSummaries;
  }

  // If the newest iteration has no planner/frontier artifact, fall back to
  // the newest older iteration that does — but only if its artifact is valid.
  if (!result.proposalPath || result.frontierReadiness === null) {
    const olderTurns = turns
      .filter((turn) => {
        const id = str(turn.iteration_id);
        if (!id.startsWith(prefix)) return false;
        const n = Number(id.slice(prefix.length));
        return Number.isInteger(n) && n < maxIter;
      })
      .sort((a, b) => {
        const aIteration = Number(str(a.iteration_id).slice(prefix.length));
        const bIteration = Number(str(b.iteration_id).slice(prefix.length));
        if (aIteration !== bIteration) return bIteration - aIteration;
        return str(b.updated_at).localeCompare(str(a.updated_at));
      });

    for (const turn of olderTurns) {
      const id = str(turn.iteration_id);
      const promptVersion = str(turn.prompt_version);
      const needsPlanner = !result.proposalPath && promptVersion.startsWith("planner@");
      const needsFrontier =
        result.frontierReadiness === null && promptVersion.startsWith("frontier@");
      if (!needsPlanner && !needsFrontier) continue;

      const identity = {
        workflowId: str(turn.workflow_id),
        iterationId: id,
        turnId: str(turn.turn_id),
        nonce: str(turn.nonce),
      };
      const loaded = loadCompletedResult(store, {
        workflowId,
        turnId: identity.turnId,
        resultPath: str(turn.result_path),
        identity,
      });
      if (needsPlanner) {
        const planner = PlannerResultSchema.safeParse({ role: "planner", ...loaded.payload });
        if (!planner.success || loaded.role !== "planner") {
          throw new Error(
            `Durable state inconsistency: completed planner turn ${identity.turnId} has an invalid result.`,
          );
        }
        result.proposalPath = planner.data.proposalPath;
        result.proposalSummary = planner.data.summary;
        const hash = readProposalHash(planner.data.proposalPath);
        if (hash) result.proposalHash = hash;
      } else if (needsFrontier) {
        const frontier = FrontierResultSchema.safeParse({ role: "frontier", ...loaded.payload });
        if (!frontier.success || loaded.role !== "frontier") {
          throw new Error(
            `Durable state inconsistency: completed frontier turn ${identity.turnId} has an invalid result.`,
          );
        }
        result.frontierReadiness = frontier.data.readiness;
      }
      if (result.proposalPath && result.frontierReadiness !== null) break;
    }
  }

  return result;
}

/**
 * A cleanly completed implementation turn for the post-review iteration, if one already
 * ran before the interruption - so a resume at the `approved` phase can skip straight to
 * verification instead of re-implementing. Returns null when none is reusable.
 *
 * Fail-closed: requires the caller's approved proposal identity, a matching
 * persisted approved_proposal artifact, and TurnCompleted.resultHash integrity.
 */
export function reuseImplementation(
  store: PersistenceStore,
  workflowId: string,
  iterationId: string,
  binding: { proposalPath: string; proposalHash: string },
): { turnId: string; summary: string } | null {
  const path = binding.proposalPath?.trim() ?? "";
  const hash = binding.proposalHash?.trim() ?? "";
  if (!path || !hash) {
    throw new Error("reuseImplementation requires proposalPath and proposalHash of the approved Author proposal");
  }
  const fresh = assertProposalFresh({ proposalPath: path, expectedHash: hash });
  if (!fresh.ok) {
    throw new Error(`Cannot reuse implementation: ${fresh.reason}`);
  }

  const turns = [...store.listTurns(workflowId)]
    .filter((t) => str(t.iteration_id) === iterationId && str(t.state) === "completed")
    .sort((a, b) => str(b.updated_at).localeCompare(str(a.updated_at)));

  for (const turn of turns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    let loaded;
    try {
      loaded = loadCompletedResult(store, {
        workflowId,
        turnId: identity.turnId,
        resultPath: str(turn.result_path),
        identity,
      });
    } catch (error) {
      if (str(turn.agent_id) === "implementation") throw error;
      continue;
    }
    if (loaded.role !== "implementation") continue;

    const impl = parseImplementationPayload(loaded.payload);
    if (!impl.success) {
      throw new Error(
        `Durable state inconsistency: completed implementation turn ${identity.turnId} has an invalid result.`,
      );
    }
    if (impl.data.status === "completed" && !impl.data.deviationRequest) {
      const bound = readApprovedProposalBinding(store, workflowId, identity.turnId);
      if (!bound) {
        throw new Error(
          `Durable state inconsistency: completed implementation turn ${identity.turnId} has no approved_proposal binding.`,
        );
      }
      if (bound.proposalPath !== path || bound.proposalHash !== hash) {
        throw new Error(
          `Durable state inconsistency: implementation turn ${identity.turnId} bound to ${bound.proposalPath}@${bound.proposalHash}, expected ${path}@${hash}.`,
        );
      }
      return { turnId: str(turn.turn_id), summary: impl.data.summary };
    }
    return null;
  }
  return null;
}

const ELIGIBLE_RESUME_STATES = new Set<string>(["waiting", "validating", "completed"]);

/**
 * Collect the newest eligible turn candidate for each (workflowId, iterationId, agentId)
 * combination. These can be adopted by runTurn on resume without re-dispatching.
 */
export function collectResumeCandidates(store: PersistenceStore, workflowId: string): ResumableTurn[] {
  const latest = new Map<string, ResumableTurn>();
  for (const row of store.listTurns(workflowId)) {
    const state = str(row.state);
    if (!ELIGIBLE_RESUME_STATES.has(state)) continue;
    const key = `${str(row.workflow_id)}:${str(row.iteration_id)}:${str(row.agent_id)}`;
    const existing = latest.get(key);
    if (existing && existing.updatedAt >= str(row.updated_at)) continue;
    latest.set(key, {
      turnId: str(row.turn_id),
      workflowId: str(row.workflow_id),
      iterationId: str(row.iteration_id),
      agentId: str(row.agent_id),
      state: state as ResumableTurn["state"],
      attempt: str(row.attempt) as "primary" | "repair",
      nonce: str(row.nonce),
      promptPath: str(row.prompt_path),
      promptHash: str(row.prompt_hash),
      promptVersion: str(row.prompt_version),
      resultPath: str(row.result_path),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    });
  }
  return [...latest.values()];
}

/** Whether a verification (resolution) turn already completed for the post-review iteration. */
export function verificationCompleted(store: PersistenceStore, workflowId: string, iterationId: string, targetTurnId?: string): boolean {
  const turns = [...store.listTurns(workflowId)]
    .filter((t) => str(t.iteration_id) === iterationId && str(t.state) === "completed")
    .sort((a, b) => str(b.updated_at).localeCompare(str(a.updated_at)));

  for (const turn of turns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    let loaded;
    try {
      loaded = loadCompletedResult(store, {
        workflowId,
        turnId: identity.turnId,
        resultPath: str(turn.result_path),
        identity,
      });
    } catch (error) {
      if (str(turn.agent_id) === "verifier") throw error;
      continue;
    }
    if (loaded.role !== "resolution") continue;

    const parsed = parseResolutionPayload(loaded.payload);
    if (!parsed.success) {
      throw new Error(
        `Durable state inconsistency: completed verification turn ${identity.turnId} has an invalid result.`,
      );
    }
    if (parsed.data.unresolved.length > 0) return false;
    if (targetTurnId && !parsed.data.verified.includes(targetTurnId)) return false;
    return true;
  }
  return false;
}

/**
 * One-use registry of persisted turn candidates that can be adopted on resume.
 * A candidate is consumed (removed) when runTurn() matches it.
 */
export class ResumeTurnRegistry {
  private readonly candidates = new Map<string, ResumableTurn>();

  constructor(store: PersistenceStore, workflowId: string) {
    for (const candidate of collectResumeCandidates(store, workflowId)) {
      const key = `${candidate.workflowId}:${candidate.iterationId}:${candidate.agentId}`;
      this.candidates.set(key, candidate);
    }
  }

  consume(workflowId: string, iterationId: string, agentId: string): ResumableTurn | undefined {
    const key = `${workflowId}:${iterationId}:${agentId}`;
    const candidate = this.candidates.get(key);
    if (candidate) this.candidates.delete(key);
    return candidate;
  }
}
