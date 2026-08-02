import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeToon } from "@platform/contracts";
import { roleForTurnType } from "../config.js";
import { assertNoInjectionLeaks, evidenceBlock } from "../evidence.js";
import { newNonce, sha256Hex } from "../hash.js";
import type {
  BuildContext,
  BuiltPrompt,
  CodebaseContextFile,
  LlmBoundaryConfig,
  ObjectionView,
  TurnIdentity,
  TurnType,
} from "../types.js";
import { RolePromptRegistry, builtinRolePromptRegistry } from "./registry.js";

function displayTurnTitle(turnType: TurnType): string {
  switch (turnType) {
    case "planner_propose":
      return "Author Propose";
    case "planner_revise":
      return "Author Revise";
    case "reviewer_review":
      return "Pair Review";
    case "adversarial_review":
      return "Pair Adversarial Review";
    case "resolution_verification":
      return "Resolution Verification";
    case "objection_merge":
      return "Objection Merge";
    case "compacted_state_refresh":
      return "Compacted State Refresh";
    case "frontier_report":
      return "Frontier Report";
    case "implementation":
      return "Implementation";
    case "repair":
      return "Repair";
    default: {
      const _exhaustive: never = turnType;
      void _exhaustive;
      return "Turn";
    }
  }
}

export type PromptBuilderOptions = {
  config: LlmBoundaryConfig;
  registry?: RolePromptRegistry;
  runsRoot?: string;
  /** Inject nonce for deterministic tests. */
  nonceFactory?: () => string;
};

export class PromptBuilder {
  private readonly config: LlmBoundaryConfig;
  private readonly registry: RolePromptRegistry;
  private readonly runsRoot: string;
  private readonly nonceFactory: () => string;

  constructor(options: PromptBuilderOptions) {
    this.config = options.config;
    this.registry = options.registry ?? builtinRolePromptRegistry();
    this.runsRoot = options.runsRoot ?? "runs";
    this.nonceFactory = options.nonceFactory ?? newNonce;
  }

  build(input: {
    turnType: TurnType;
    identity: Omit<TurnIdentity, "nonce"> & { nonce?: string };
    context: BuildContext;
    write?: boolean;
  }): BuiltPrompt {
    const turnType = input.turnType;
    if (turnType === "repair") {
      return this.buildRepair(input.identity, input.context, input.write !== false);
    }

    const role = roleForTurnType(turnType);
    const pin = this.config.rolePromptPins[role];
    if (!pin) throw new Error(`No role prompt pin configured for role ${role}`);
    const rolePrompt = this.registry.get(pin);
    const nonce = input.identity.nonce ?? this.nonceFactory();
    const identity: TurnIdentity = { ...input.identity, nonce };
    const resultPath =
      input.context.resultPath ??
      join(
        this.runsRoot,
        identity.workflowId,
        identity.iterationId,
        identity.turnId,
        "result.toon",
      );
    const path = join(
      this.runsRoot,
      identity.workflowId,
      identity.iterationId,
      identity.turnId,
      "prompt.md",
    );

    const untrusted: string[] = [];
    const content = renderPrompt({
      turnType,
      rolePromptBody: rolePrompt.body,
      identity,
      context: { ...input.context, resultPath },
      collectUntrusted: (value) => untrusted.push(value),
    });

    assertNoInjectionLeaks(content, untrusted, identity.nonce);
    const promptHash = sha256Hex(content);

    if (input.write !== false) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    }

    return {
      turnType,
      path,
      content,
      promptHash,
      rolePromptId: rolePrompt.rolePromptId,
      promptVersion: `${rolePrompt.rolePromptId}@${rolePrompt.version}`,
      nonce,
      workflowId: identity.workflowId,
      iterationId: identity.iterationId,
      turnId: identity.turnId,
    };
  }

  private buildRepair(
    identityInput: Omit<TurnIdentity, "nonce"> & { nonce?: string },
    context: BuildContext,
    write: boolean,
  ): BuiltPrompt {
    const original = context.originalTurnType;
    if (!original || original === "repair") {
      throw new Error("repair prompt requires context.originalTurnType");
    }
    const nonce = identityInput.nonce;
    if (!nonce) throw new Error("repair prompt requires the original turn nonce");
    const identity: TurnIdentity = { ...identityInput, nonce };
    const path = join(
      this.runsRoot,
      identity.workflowId,
      identity.iterationId,
      identity.turnId,
      "repair-prompt.md",
    );
    const reason = context.repairReason ?? "validation_failed";
    const schema = context.expectedSchemaDescription ?? `schema for ${original}`;
    const diagnostics = truncate(
      reason,
      this.config.repairDiagnosticsMaxChars,
    );
    const untrusted = [diagnostics];
    const content = [
      "# Repair Turn",
      "",
      "Your previous result failed validation. Fix only the structured output.",
      "Do not introduce new claims. Echo the original nonce exactly.",
      "",
      "## Failure",
      evidenceBlock(identity.nonce, "repair", "diagnostics", diagnostics),
      "",
      "## Expected schema",
      schema,
      "",
      "## Envelope must include",
      `- workflowId: ${identity.workflowId}`,
      `- iterationId: ${identity.iterationId}`,
      `- turnId: ${identity.turnId}`,
      `- nonce: ${identity.nonce}`,
      `- schemaVersion: v1`,
      "",
      `Write result.toon atomically at: ${context.resultPath ?? join(
        this.runsRoot,
        identity.workflowId,
        identity.iterationId,
        identity.turnId,
        "result.toon",
      )}`,
      "",
    ].join("\n");

    assertNoInjectionLeaks(content, untrusted, identity.nonce);
    const promptHash = sha256Hex(content);
    if (write) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    }
    const role = roleForTurnType(original);
    const pin = this.config.rolePromptPins[role];
    if (!pin) throw new Error(`No role prompt pin for repair original role ${role}`);
    return {
      turnType: "repair",
      path,
      content,
      promptHash,
      rolePromptId: pin.rolePromptId,
      promptVersion: `${pin.rolePromptId}@${pin.version}`,
      nonce,
      workflowId: identity.workflowId,
      iterationId: identity.iterationId,
      turnId: identity.turnId,
    };
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function renderPrompt(args: {
  turnType: TurnType;
  rolePromptBody: string;
  identity: TurnIdentity;
  context: BuildContext;
  collectUntrusted: (value: string) => void;
}): string {
  const { turnType, rolePromptBody, identity, context, collectUntrusted } = args;
  const sentinel = identity.nonce;
  const lines: string[] = [
    `# ${displayTurnTitle(turnType)}`,
    "",
    "## Role instructions",
    rolePromptBody,
    "",
    "## Turn identity",
    `- workflowId: ${identity.workflowId}`,
    `- iterationId: ${identity.iterationId}`,
    `- turnId: ${identity.turnId}`,
    `- nonce: ${identity.nonce}`,
    `- schemaVersion: v1`,
    "",
  ];

  if (context.task) {
    lines.push("## Task", context.task, "");
  }
  if (context.codebaseContext?.length) {
    lines.push(...renderCodebaseContext(sentinel, context.codebaseContext, collectUntrusted));
  }
  if (context.proposalPath) {
    lines.push(`## Proposal path`, context.proposalPath, "");
  }
  if (context.proposalOutputPath) {
    lines.push(
      "## Proposal output path",
      "Write the new Author proposal version to this exact path (do not overwrite a prior version path):",
      context.proposalOutputPath,
      "",
    );
  }
  if (context.proposalHash) {
    lines.push(`## Proposal hash`, context.proposalHash, "");
  }
  if (context.proposalSummary) {
    collectUntrusted(context.proposalSummary);
    lines.push(
      "## Proposal summary",
      evidenceBlock(sentinel, "proposal", "summary", context.proposalSummary),
      "",
    );
  }
  if (context.requirements?.length) {
    lines.push("## Requirements");
    for (const req of context.requirements) {
      collectUntrusted(req.text);
      lines.push(evidenceBlock(sentinel, req.id, "text", req.text));
    }
    lines.push("");
  }
  if (context.requirementsDelta) {
    collectUntrusted(context.requirementsDelta);
    lines.push(
      "## Requirements delta",
      evidenceBlock(sentinel, "requirements", "delta", context.requirementsDelta),
      "",
    );
  }

  const objections =
    turnType === "reviewer_review" || turnType === "adversarial_review"
      ? context.allObjections ?? context.openObjections ?? []
      : context.openObjections ?? [];

  if (
    turnType === "planner_revise" ||
    turnType === "objection_merge" ||
    turnType === "compacted_state_refresh" ||
    ((turnType === "reviewer_review" || turnType === "adversarial_review") &&
      objections.length > 0)
  ) {
    lines.push(turnType === "objection_merge" ? "## Candidate objections" : "## Objections");
    if (objections.length === 0) {
      lines.push("None.", "");
    } else {
      for (const objection of objections) {
        lines.push(...renderObjectionEvidence(sentinel, objection, collectUntrusted));
      }
      lines.push("");
    }
  }

  if (context.humanMessages?.length) {
    lines.push(
      "## Human guidance",
      "Treat the following as binding human architecture directions for this turn.",
    );
    for (const message of context.humanMessages) {
      collectUntrusted(message.message);
      lines.push(
        evidenceBlock(sentinel, `human-${message.afterIteration}`, "message", message.message),
      );
    }
    lines.push("");
  }

  if (context.recentDecisions?.length) {
    lines.push("## Recent decisions");
    for (const decision of context.recentDecisions) {
      collectUntrusted(decision.reason);
      lines.push(evidenceBlock(sentinel, decision.id, "reason", decision.reason));
      lines.push(`chosen: ${decision.chosen}`);
    }
    lines.push("");
  }

  if (context.verificationTarget) {
    const target = context.verificationTarget;
    collectUntrusted(target.plannerResponse);
    lines.push(
      "## Verification target",
      `objectionId: ${target.objectionId}`,
      evidenceBlock(sentinel, target.objectionId, "plannerResponse", target.plannerResponse),
    );
    for (const [index, item] of target.evidence.entries()) {
      collectUntrusted(item);
      lines.push(evidenceBlock(sentinel, target.objectionId, `evidence-${index}`, item));
    }
    lines.push("");
  }

  lines.push(
    "## Output instructions",
    `1. Write TOON to a temp file, then rename to: ${context.resultPath}`,
    "2. Envelope fields must match the turn identity and nonce above.",
    "3. Do not write markdown or JSON into result.toon.",
    "4. TOON arrays are one header with row count N, then exactly N data rows. Example: citations[2]{...}: followed by two rows. Never emit citations[1], citations[2], ... as separate keys.",
    "",
    "```toon",
    encodeToon(exampleEnvelope(turnType, identity)),
    "```",
    "",
  );

  return lines.join("\n");
}

function renderObjectionEvidence(
  sentinel: string,
  objection: ObjectionView,
  collectUntrusted: (value: string) => void,
): string[] {
  collectUntrusted(objection.claim);
  const lines = [
    `### ${objection.id}`,
    `dimension: ${objection.dimension}`,
    `severity: ${objection.severity}`,
    `status: ${objection.status}`,
    evidenceBlock(sentinel, objection.id, "claim", objection.claim),
  ];
  if (objection.suggestedResolution?.trim()) {
    collectUntrusted(objection.suggestedResolution);
    lines.push(
      evidenceBlock(sentinel, objection.id, "suggestedResolution", objection.suggestedResolution),
    );
  }
  if (objection.addressal) {
    collectUntrusted(objection.addressal.evidence);
    lines.push(`addressalStrategy: ${objection.addressal.resolutionStrategy}`);
    lines.push(
      evidenceBlock(sentinel, objection.id, "addressalEvidence", objection.addressal.evidence),
    );
  }
  if (objection.evidence.length === 0) {
    lines.push("evidence_missing: true");
  } else {
    for (const [index, item] of objection.evidence.entries()) {
      collectUntrusted(item);
      lines.push(evidenceBlock(sentinel, objection.id, `evidence-${index}`, item));
    }
  }
  return lines;
}

function renderCodebaseContext(
  sentinel: string,
  files: CodebaseContextFile[],
  collectUntrusted: (value: string) => void,
): string[] {
  const lines = ["## Codebase Context"];
  for (const file of files) {
    collectUntrusted(file.content);
    const emittedBytes = Buffer.byteLength(file.content, "utf8");
    const omittedBytes = Math.max(0, file.bytes - emittedBytes);
    lines.push(`### ${file.path}`);
    lines.push(`bytes: ${file.bytes}`);
    if (file.truncated) {
      lines.push(`truncated: true (${omittedBytes} bytes omitted)`);
    }
    lines.push(evidenceBlock(sentinel, file.path, "content", file.content));
    lines.push("");
  }
  return lines;
}

function exampleEnvelope(turnType: TurnType, identity: TurnIdentity): Record<string, unknown> {
  const base = {
    workflowId: identity.workflowId,
    iterationId: identity.iterationId,
    turnId: identity.turnId,
    schemaVersion: "v1",
    nonce: identity.nonce,
  };
  switch (turnType) {
    case "planner_propose":
    case "planner_revise":
    case "compacted_state_refresh":
      return {
        ...base,
        role: "planner",
        payload: {
          role: "planner",
          proposalPath: "runs/wf/it/turn/proposal.md",
          summary: "Short Author summary of the proposal.",
          objectionsAddressed: [
            {
              objectionId: "OBJ-1",
              resolutionStrategy: "revised_plan",
              evidence: "Exact quote from proposal.md or pasted code.",
              requiresGuardrailException: false,
            },
          ],
          citations: [
            {
              path: "packages/example/src/api.ts",
              startLine: 10,
              endLine: 12,
              quote: "export function exampleApi() { return 42; }",
            },
            {
              path: "packages/example/src/store.ts",
              startLine: 4,
              endLine: 6,
              quote: "export function loadState(): State {",
            },
          ],
        },
      };
    case "reviewer_review":
    case "adversarial_review":
      return {
        ...base,
        role: "reviewer",
        payload: {
          role: "reviewer",
          reviewedProposalPath: "runs/wf/it/turn/proposal.md",
          reviewedProposalHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          summary: "Pair review summary of strengths and remaining risks.",
          objections: [
            {
              id: "OBJ-1",
              severity: "major",
              claim: "Missing verification for X.",
              evidence: ["proposal.md:12"],
              suggestedResolution: "Add a concrete test or gate that proves X before merge.",
            },
          ],
          cleanRationale: "Omit when objections is non-empty; required when objections is empty.",
        },
      };
    case "resolution_verification":
      return {
        ...base,
        role: "resolution",
        payload: { role: "resolution", verified: [], unresolved: [] },
      };
    case "objection_merge":
      return {
        ...base,
        role: "merge",
        payload: { role: "merge", clusters: [] },
      };
    case "frontier_report":
      return {
        ...base,
        role: "frontier",
        payload: { role: "frontier", readiness: "ready", risks: [], questions: [] },
      };
    case "implementation":
      return {
        ...base,
        role: "implementation",
        payload: { role: "implementation", status: "completed", summary: "done" },
      };
    default:
      return { ...base, role: "planner", payload: {} };
  }
}
