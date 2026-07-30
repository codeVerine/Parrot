import { readFileSync } from "node:fs";
import { PlannerResultSchema, ResultEnvelopeSchema, parseToon } from "@platform/contracts";
import type { PersistenceStore } from "@platform/persistence";

const MAX_PROPOSAL_BYTES = 64 * 1024;

const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

function tokenSet(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return new Set();
  return new Set(normalized.split(/\s+/));
}

export function proposalSimilarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((token) => setB.has(token)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** High-signal execution steps: unordered list items and numbered steps only. */
export function sectionSteps(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length > 0);
}

export type WeightedProposalSimilarity = {
  simAll: number;
  simHeadings: number;
  simSteps: number;
  score: number;
  /** Normalized weights applied to each component (sum to 1). */
  weights: { all: number; headings: number; steps: number };
  /** Which structural components were present on either side (both absent -> excluded). */
  used: { headings: boolean; steps: boolean };
};

/**
 * Compare the whole proposal and its high-signal structural components. Steps
 * carry the most weight because they describe the execution strategy, while
 * headings provide a weaker phase/section signal and all text is a fallback.
 */
export function weightedProposalSimilarity(a: string, b: string): WeightedProposalSimilarity {
  const simAll = proposalSimilarity(a, b);
  const headingsA = sectionHeadings(a);
  const headingsB = sectionHeadings(b);
  const stepsA = sectionSteps(a);
  const stepsB = sectionSteps(b);

  // Exclude empty-vs-empty components; include any component present on either
  // side so missing structure is penalized (sim=0) instead of silently ignored.
  const useHeadings = headingsA.length > 0 || headingsB.length > 0;
  const useSteps = stepsA.length > 0 || stepsB.length > 0;

  const simHeadings = proposalSimilarity(headingsA.join("\n"), headingsB.join("\n"));
  const simSteps = proposalSimilarity(stepsA.join("\n"), stepsB.join("\n"));

  const base = { steps: 0.5, headings: 0.3, all: 0.2 };
  const active = {
    steps: useSteps ? base.steps : 0,
    headings: useHeadings ? base.headings : 0,
    all: base.all,
  };
  const total = active.steps + active.headings + active.all;
  const weights = {
    steps: active.steps / total,
    headings: active.headings / total,
    all: active.all / total,
  };
  return {
    simAll,
    simHeadings,
    simSteps,
    score: weights.steps * simSteps + weights.headings * simHeadings + weights.all * simAll,
    weights,
    used: { headings: useHeadings, steps: useSteps },
  };
}

// Descriptive alias for callers that prefer the metric's full name.
export const sectionWeightedSimilarity = weightedProposalSimilarity;

export function sectionHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^#{1,6}\s+(.+)/.exec(line);
    if (!match) continue;
    let heading = match[1]!.trim().toLowerCase();
    heading = heading.replace(/^\d+(?:\.\d+)*\.?\s*/, "");
    headings.push(heading);
  }
  return headings;
}

function headingSet(headings: string[]): Set<string> {
  if (headings.length === 0) return new Set();
  return new Set(headings);
}

export function headingChangeRatio(prev: string[], next: string[]): number {
  const total = prev.length + next.length;
  if (total === 0) return 0;
  const prevSet = headingSet(prev);
  const nextSet = headingSet(next);
  const added = next.filter((h) => !prevSet.has(h)).length;
  const removed = prev.filter((h) => !nextSet.has(h)).length;
  return (added + removed) / total;
}

export type RestructuringOptions = {
  headingChangeRatio?: number;
  similarityFloor?: number;
};

export function isMajorRestructuring(
  prev: string,
  next: string,
  opts: RestructuringOptions = {},
): boolean {
  const headingChange = opts.headingChangeRatio ?? 0.4;
  const similarityFloor = opts.similarityFloor ?? 0.5;

  const prevHeadings = sectionHeadings(prev);
  const nextHeadings = sectionHeadings(next);

  if (prevHeadings.length > 0 && nextHeadings.length > 0) {
    if (headingChangeRatio(prevHeadings, nextHeadings) >= headingChange) {
      return true;
    }
  }

  return proposalSimilarity(prev, next) < similarityFloor;
}

export type ProposalSnapshot = {
  path: string;
  text: string;
};

export function loadProposalAtIteration(
  store: PersistenceStore,
  workflowId: string,
  iterationNumber: number,
): ProposalSnapshot | null {
  const iterationId = `${workflowId}-iter-${iterationNumber}`;
  const turns = [...store.listTurns(workflowId)]
    .filter((row) => str(row.iteration_id) === iterationId && str(row.state) === "completed")
    .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));

  for (const row of turns) {
    const resultPath = str(row.result_path);
    if (!resultPath) continue;
    let envelope: { role: string; payload: Record<string, unknown> };
    try {
      const parsed = ResultEnvelopeSchema.safeParse(parseToon(readFileSync(resultPath, "utf8")));
      if (!parsed.success) continue;
      envelope = parsed.data;
    } catch {
      continue;
    }
    if (envelope.role !== "planner") continue;
    const planner = PlannerResultSchema.safeParse({ role: "planner", ...envelope.payload });
    if (!planner.success) continue;
    const proposalPath = planner.data.proposalPath;
    if (!proposalPath) continue;
    let proposalText: string;
    try {
      proposalText = readFileSync(proposalPath, "utf8");
    } catch {
      return null;
    }
    if (Buffer.byteLength(proposalText, "utf8") > MAX_PROPOSAL_BYTES) {
      proposalText = proposalText.slice(0, MAX_PROPOSAL_BYTES);
    }
    return { path: proposalPath, text: proposalText };
  }

  return null;
}

export function addedRemovedHeadings(prev: string, next: string): { added: string[]; removed: string[] } {
  const prevHeadings = sectionHeadings(prev);
  const nextHeadings = sectionHeadings(next);
  const prevSet = headingSet(prevHeadings);
  const nextSet = headingSet(nextHeadings);
  const added = nextHeadings.filter((h) => !prevSet.has(h));
  const removed = prevHeadings.filter((h) => !nextSet.has(h));
  return { added, removed };
}
