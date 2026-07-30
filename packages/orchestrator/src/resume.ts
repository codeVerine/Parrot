import { readFileSync } from "node:fs";
import type { TurnState } from "@platform/persistence";
import {
  FrontierResultSchema,
  ImplementationResultSchema,
  PlannerResultSchema,
  ResolutionResultSchema,
  ResultEnvelopeSchema,
  parseToon,
} from "@platform/contracts";
import type { ObjectionView } from "@platform/llm-boundary";
import type { WorkflowEngine, WorkflowPhase } from "@platform/workflow-engine";
import type { PersistenceStore } from "@platform/persistence";

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
  proposalSummary?: string;
  frontierReadiness: "ready" | "not_ready" | null;
  /** Set to 0 on resume: mid-loop frontier findings may not have been ingested when
   * the process died, so don't skip the frontier on resume. One extra turn is harmless. */
  lastFrontierIteration: number;
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

  return {
    workflowId,
    task: str(row.task),
    workspaceId: str(row.workspace_id),
    phase: state.phase,
    iteration: currentIteration(store, workflowId),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    views,
    ...(artifacts.proposalPath ? { finalProposalPath: artifacts.proposalPath } : {}),
    ...(artifacts.proposalSummary ? { proposalSummary: artifacts.proposalSummary } : {}),
    frontierReadiness: artifacts.frontierReadiness,
    lastFrontierIteration: 0,
  };
}

/** Rebuild the objection view map the loop keeps in memory from the persisted rows. */
export function rehydrateViews(store: PersistenceStore, workflowId: string): Map<string, ObjectionView> {
  const views = new Map<string, ObjectionView>();
  for (const row of store.listObjections(workflowId)) {
    const id = str(row.objection_id);
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
    });
  }
  return views;
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
  proposalSummary?: string;
  frontierReadiness: "ready" | "not_ready" | null;
};

/**
 * Re-read completed planner and frontier turn result files.
 * Strategy: find the highest iteration with completed turns, then validate
 * every completed turn at that iteration. If ANY artifact at the newest
 * iteration is missing or invalid, throw. Older iterations may be skipped
 * (stale work).
 */
function reuseTurnArtifacts(store: PersistenceStore, workflowId: string): ReusedArtifacts {
  const result: ReusedArtifacts = { frontierReadiness: null };
  const turns = [...store.listTurns(workflowId)]
    .filter((t) => str(t.state) === "completed");

  // Find the highest iteration number among all completed turns.
  const prefix = `${workflowId}-iter-`;
  let maxIter = -1;
  for (const turn of turns) {
    const id = str(turn.iteration_id);
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > maxIter) maxIter = n;
  }
  if (maxIter < 0) return result;

  // Collect completed turns at the highest iteration and one representative
  // per role from older iterations (as fallback).
  const newestTurns: typeof turns = [];
  for (const turn of turns) {
    const id = str(turn.iteration_id);
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (n === maxIter) newestTurns.push(turn);
  }

  // Validate every completed turn at the newest iteration. If any artifact
  // is missing or invalid, it is a durable inconsistency — do not fall back.
  const newestValidByRole = new Map<string, (typeof turns)[number]>();
  for (const turn of newestTurns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    const envelope = readEnvelope(str(turn.result_path), identity);
    if (!envelope) {
      throw new Error(
        `Durable state inconsistency: completed turn ${identity.turnId} at iteration ${maxIter} has a missing or corrupt result artifact.`,
      );
    }
    const role = envelope.role;
    if (role === "planner" || role === "frontier") {
      newestValidByRole.set(role, turn);
    }
  }

  // Validate and extract planner/frontier payloads from the newest iteration.
  for (const [role, turn] of newestValidByRole) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    const envelope = readEnvelope(str(turn.result_path), identity)!;
    if (role === "planner") {
      const planner = PlannerResultSchema.safeParse({ role: "planner", ...envelope.payload });
      if (!planner.success) {
        throw new Error(
          `Durable state inconsistency: completed planner turn ${identity.turnId} has an invalid result.`,
        );
      }
      result.proposalPath = planner.data.proposalPath;
      result.proposalSummary = planner.data.summary;
    } else if (role === "frontier") {
      const frontier = FrontierResultSchema.safeParse({ role: "frontier", ...envelope.payload });
      if (!frontier.success) {
        throw new Error(
          `Durable state inconsistency: completed frontier turn ${identity.turnId} has an invalid result.`,
        );
      }
      result.frontierReadiness = frontier.data.readiness;
    }
  }

  // If the newest iteration has no planner/frontier artifact, fall back to
  // the newest older iteration that does — but only if its artifact is valid.
  if (!result.proposalPath || result.frontierReadiness === null) {
    for (const turn of turns) {
      const id = str(turn.iteration_id);
      if (!id.startsWith(prefix)) continue;
      const n = Number(id.slice(prefix.length));
      if (n >= maxIter) continue; // already processed
      const identity = {
        workflowId: str(turn.workflow_id),
        iterationId: str(turn.iteration_id),
        turnId: str(turn.turn_id),
        nonce: str(turn.nonce),
      };
      const envelope = readEnvelope(str(turn.result_path), identity);
      if (!envelope) continue; // older iteration, skip corrupt
      if (envelope.role === "planner" && !result.proposalPath) {
        const planner = PlannerResultSchema.safeParse({ role: "planner", ...envelope.payload });
        if (planner.success) {
          result.proposalPath = planner.data.proposalPath;
          result.proposalSummary = planner.data.summary;
        }
      } else if (envelope.role === "frontier" && result.frontierReadiness === null) {
        const frontier = FrontierResultSchema.safeParse({ role: "frontier", ...envelope.payload });
        if (frontier.success) result.frontierReadiness = frontier.data.readiness;
      }
    }
  }

  return result;
}

/**
 * A cleanly completed implementation turn for the post-review iteration, if one already
 * ran before the interruption - so a resume at the `approved` phase can skip straight to
 * verification instead of re-implementing. Returns null when none is reusable.
 */
export function reuseImplementation(
  store: PersistenceStore,
  workflowId: string,
  iterationId: string,
): { turnId: string; summary: string } | null {
  const turns = [...store.listTurns(workflowId)]
    // Implementation and verification intentionally share the post-review
    // iteration id. Inspect the persisted role so a completed verification
    // turn cannot hide reusable implementation work.
    .filter((t) => str(t.iteration_id) === iterationId && str(t.state) === "completed")
    .sort((a, b) => str(b.updated_at).localeCompare(str(a.updated_at)));

  for (const turn of turns) {
    const identity = {
      workflowId: str(turn.workflow_id),
      iterationId: str(turn.iteration_id),
      turnId: str(turn.turn_id),
      nonce: str(turn.nonce),
    };
    const envelope = readEnvelope(str(turn.result_path), identity);
    if (!envelope) {
      // We can identify implementation rows by the stable production agent id;
      // verification corruption is handled by verificationCompleted below.
      if (str(turn.agent_id) === "implementation") {
        throw new Error(
          `Durable state inconsistency: completed implementation turn ${identity.turnId} has a missing or corrupt result artifact.`,
        );
      }
      continue;
    }
    if (envelope.role !== "implementation") continue;

    const impl = ImplementationResultSchema.safeParse({ role: "implementation", ...envelope.payload });
    if (!impl.success) {
      throw new Error(
        `Durable state inconsistency: completed implementation turn ${identity.turnId} has an invalid result.`,
      );
    }
    if (impl.data.status === "completed" && !impl.data.deviationRequest) {
      return { turnId: str(turn.turn_id), summary: impl.data.summary };
    }
    // The newest implementation was valid but blocked/requested a deviation;
    // do not fall back to an older implementation.
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
    const envelope = readEnvelope(str(turn.result_path), identity);
    if (!envelope) {
      if (str(turn.agent_id) === "verifier") {
        throw new Error(
          `Durable state inconsistency: completed verification turn ${identity.turnId} has a missing or corrupt result artifact.`,
        );
      }
      continue;
    }
    if (envelope.role !== "resolution") continue;

    const parsed = ResolutionResultSchema.safeParse({ role: "resolution", ...envelope.payload });
    if (!parsed.success) {
      throw new Error(
        `Durable state inconsistency: completed verification turn ${identity.turnId} has an invalid result.`,
      );
    }
    // The newest verification is authoritative. It is complete only if there
    // are no unresolved findings and the target turn is verified.
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

function readEnvelope(
  resultPath: string,
  identity?: { workflowId: string; iterationId: string; turnId: string; nonce: string },
): { role: string; payload: Record<string, unknown> } | null {
  if (!resultPath) return null;
  try {
    const parsed = ResultEnvelopeSchema.safeParse(parseToon(readFileSync(resultPath, "utf8")));
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
