import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeToon } from "@platform/contracts";
import { roleForTurnType } from "../config.js";
import { assertNoInjectionLeaks, evidenceBlock } from "../evidence.js";
import { newNonce, sha256Hex } from "../hash.js";
import type {
  BuildContext,
  BuiltPrompt,
  LlmBoundaryConfig,
  ObjectionView,
  TurnIdentity,
  TurnType,
} from "../types.js";
import { RolePromptRegistry, builtinRolePromptRegistry } from "./registry.js";

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
    `# ${titleFor(turnType)}`,
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
  if (context.proposalPath) {
    lines.push(`## Proposal path`, context.proposalPath, "");
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
    lines.push("## Human messages");
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

function titleFor(turnType: TurnType): string {
  return turnType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
          proposalPath: "path/to/proposal.md",
          summary: "Short summary.",
          objectionsAddressed: [],
        },
      };
    case "reviewer_review":
    case "adversarial_review":
      return {
        ...base,
        role: "reviewer",
        payload: { role: "reviewer", objections: [] },
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
