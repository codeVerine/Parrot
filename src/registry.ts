import { writeFile, rename } from "node:fs/promises";
import type { NewObjection, ObjectionStatus, PriorObjectionStatus, Severity } from "./schemas.js";

export type ResolvedPane = {
  role: "planner" | "reviewer";
  paneId: string;
  agent: string | null;
  cwd: string | null;
  workspaceId: string;
};

export type ObjectionRecord = {
  id: string;
  claim: string;
  evidence: string[];
  severity: Severity;
  raisedBy: "reviewer";
  firstSeenIteration: number;
};

export type StatusTransition = {
  objectionId: string;
  status: ObjectionStatus;
  byRole: "reviewer" | "orchestrator";
  iteration: number;
  rationale?: string;
};

export type State = {
  runId: string;
  iteration: number;
  panes: Record<"planner" | "reviewer", ResolvedPane>;
  objections: ObjectionRecord[];
  statusTransitions: StatusTransition[];
};

export type ObjectionView = ObjectionRecord & {
  status: ObjectionStatus;
  rationale?: string;
};

export function createInitialState(runId: string, panes: State["panes"]): State {
  return {
    runId,
    iteration: 0,
    panes,
    objections: [],
    statusTransitions: [],
  };
}

export async function writeStateAtomic(path: string, state: State): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

export function currentObjections(state: State): ObjectionView[] {
  return state.objections.map((objection) => {
    const transition = [...state.statusTransitions]
      .reverse()
      .find((item) => item.objectionId === objection.id);

    return {
      ...objection,
      status: transition?.status ?? "open",
      rationale: transition?.rationale,
    };
  });
}

export function openObjections(state: State): ObjectionView[] {
  return currentObjections(state).filter((objection) => objection.status === "open");
}

export function openBlockingObjections(state: State): ObjectionView[] {
  return openObjections(state).filter((objection) => objection.severity === "blocking");
}

export function applyReviewerPayload(
  state: State,
  iteration: number,
  priorStatuses: PriorObjectionStatus[],
  newObjections: NewObjection[],
): void {
  const knownIds = new Set(state.objections.map((objection) => objection.id));

  for (const prior of priorStatuses) {
    if (!knownIds.has(prior.id)) {
      continue;
    }

    state.statusTransitions.push({
      objectionId: prior.id,
      status: prior.status,
      byRole: "reviewer",
      iteration,
      rationale: prior.rationale,
    });
  }

  for (const objection of newObjections) {
    const id = nextObjectionId(state);
    state.objections.push({
      id,
      claim: objection.claim,
      evidence: objection.evidence,
      severity: objection.severity,
      raisedBy: "reviewer",
      firstSeenIteration: iteration,
    });
    state.statusTransitions.push({
      objectionId: id,
      status: "open",
      byRole: "reviewer",
      iteration,
      rationale: "New objection.",
    });
  }
}

function nextObjectionId(state: State): string {
  const used = new Set(state.objections.map((objection) => objection.id));
  let index = state.objections.length + 1;

  while (true) {
    const id = `OBJ-${String(index).padStart(3, "0")}`;
    if (!used.has(id)) {
      return id;
    }
    index += 1;
  }
}
