import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeToon } from "@platform/contracts";
import {
  PromptBuilder,
  ResultExtractor,
  ObjectionEngine,
  withLlmBoundaryConfig,
  type ObjectionView,
  type TurnType,
} from "../src/index.js";

export function tempRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "llm-boundary-"));
}

export function createBoundary(runsRoot?: string) {
  const config = withLlmBoundaryConfig();
  const root = runsRoot ?? tempRunsRoot();
  return {
    config,
    runsRoot: root,
    builder: new PromptBuilder({
      config,
      runsRoot: root,
      nonceFactory: () => "fixed-nonce-001",
    }),
    extractor: new ResultExtractor({ config }),
    objections: new ObjectionEngine(config),
  };
}

export const sampleObjections: ObjectionView[] = [
  {
    id: "OBJ-1",
    dimension: "correctness",
    severity: "blocking",
    claim: "Missing auth check on delete.",
    evidence: ["src/api.ts:10"],
    status: "open",
    raisedBy: "reviewer-1",
    turnId: "turn-r1",
  },
  {
    id: "OBJ-2",
    dimension: "correctness",
    severity: "major",
    claim: "Delete endpoint lacks authorization.",
    evidence: ["src/api.ts:12", "REQ-3"],
    status: "open",
    raisedBy: "reviewer-2",
    turnId: "turn-r2",
  },
  {
    id: "OBJ-3",
    dimension: "style",
    severity: "minor",
    claim: "Rename helper for clarity.",
    evidence: [],
    evidence_missing: true,
    status: "open",
    raisedBy: "reviewer-1",
    turnId: "turn-r1",
  },
];

export function envelopeBytes(args: {
  turnType?: TurnType;
  workflowId?: string;
  iterationId?: string;
  turnId?: string;
  nonce?: string;
  schemaVersion?: string;
  role?: string;
  payload: Record<string, unknown>;
}): string {
  return encodeToon({
    workflowId: args.workflowId ?? "wf-1",
    iterationId: args.iterationId ?? "it-1",
    turnId: args.turnId ?? "turn-1",
    schemaVersion: args.schemaVersion ?? "v1",
    nonce: args.nonce ?? "fixed-nonce-001",
    role: args.role ?? "planner",
    payload: args.payload,
  });
}
