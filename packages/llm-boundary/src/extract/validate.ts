import {
  ResultEnvelopeSchema,
  parseToon,
  rejectEnvelopeMismatch,
  rejectMissingNonce,
  rejectStaleTurn,
  repairFailure,
  validateMergeStructure,
  type MergeResult,
  type ResultEnvelope,
} from "@platform/contracts";
import { sha256Hex } from "../hash.js";
import type { ExtractionVerdict, LlmBoundaryConfig, TurnType, ValidateResultInput } from "../types.js";
import { envelopeRoleForTurnType, schemaForTurnType } from "./schemas.js";
import { truncateDiagnostics } from "./verdict.js";

export type ExtractorOptions = {
  config: LlmBoundaryConfig;
};

export class ResultExtractor {
  private readonly config: LlmBoundaryConfig;

  constructor(options: ExtractorOptions) {
    this.config = options.config;
  }

  validate(
    input: ValidateResultInput & {
      originalTurnType?: TurnType;
      inputObjectionIds?: readonly string[];
    },
  ): ExtractionVerdict {
    const attempt = input.turn.attempt;
    const fail = (reason: string, diagnostics?: string): ExtractionVerdict => {
      if (attempt === "primary") {
        return {
          outcome: "needsRepair",
          reason,
          diagnostics: truncateDiagnostics(
            diagnostics ?? reason,
            this.config.repairDiagnosticsMaxChars,
          ),
        };
      }
      return { outcome: "failed", reason: reason || repairFailure.secondFailure };
    };

    const text = typeof input.bytes === "string" ? input.bytes : input.bytes.toString("utf8");
    const resultHash = input.contentHash ?? sha256Hex(text);

    let parsed: unknown;
    try {
      parsed = parseToon(text);
    } catch (error) {
      return fail("toon_parse_failed", error instanceof Error ? error.message : String(error));
    }

    const envelopeParsed = ResultEnvelopeSchema.safeParse(parsed);
    if (!envelopeParsed.success) {
      return fail("envelope_invalid", envelopeParsed.error.message);
    }
    const envelope: ResultEnvelope = envelopeParsed.data;

    if (!this.config.acceptedSchemaVersions.includes(envelope.schemaVersion)) {
      return fail(
        "unsupported_schema_version",
        `schemaVersion ${envelope.schemaVersion} not in ${this.config.acceptedSchemaVersions.join(",")}`,
      );
    }

    const mismatch = rejectEnvelopeMismatch(envelope, input.turn);
    if (mismatch) return fail("envelope_mismatch", mismatch);

    const missingNonce = rejectMissingNonce(envelope);
    if (missingNonce) return fail("missing_nonce", missingNonce);

    if (envelope.nonce !== input.turn.nonce) {
      return fail("wrong_nonce", "Result envelope nonce does not match the active turn.");
    }

    const stale = rejectStaleTurn(envelope, input.turn.turnId);
    if (stale) return fail("stale_turn", stale);

    const expectedEnvelopeRole = envelopeRoleForTurnType(
      input.turn.turnType,
      input.originalTurnType,
    );
    if (envelope.role !== expectedEnvelopeRole) {
      return fail(
        "role_mismatch",
        `Expected envelope role ${expectedEnvelopeRole}, got ${envelope.role}`,
      );
    }

    const rolePayload = normalizePayload(envelope.payload, expectedEnvelopeRole);
    const schema = schemaForTurnType(input.turn.turnType, input.originalTurnType);
    const validated = schema.safeParse(rolePayload);
    if (!validated.success) {
      return fail("schema_invalid", validated.error.message);
    }

    const evidenceIssue = checkEvidenceRules(validated.data, rolePayload, input.inputObjectionIds ?? []);
    if (evidenceIssue) return fail("evidence_rules", evidenceIssue);

    const isMerge =
      input.turn.turnType === "objection_merge" || input.originalTurnType === "objection_merge";
    if (isMerge) {
      const merge = validated.data as MergeResult;
      const issues = validateMergeStructure(merge, input.inputObjectionIds ?? []);
      if (issues.length > 0) {
        return fail(
          "merge_structure_invalid",
          issues.map((issue) => JSON.stringify(issue)).join("; "),
        );
      }
    }

    return {
      outcome: "valid",
      payload: validated.data,
      resultHash,
      role: envelope.role,
    };
  }
}

function normalizePayload(payload: Record<string, unknown>, role: string): Record<string, unknown> {
  if (!("role" in payload)) {
    return { role, ...payload };
  }
  return payload;
}

function checkEvidenceRules(
  payload: unknown,
  rawPayload: Record<string, unknown>,
  inputObjectionIds: readonly string[],
): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const role = (payload as { role?: string }).role;

  if (role === "reviewer") {
    const reviewerPayload = payload as {
      objections?: Array<{ id: string; evidence: string[]; evidence_missing?: boolean }>;
      cleanRationale?: string;
    };
    const objections = reviewerPayload.objections;
    if (!objections) return null;
    for (const objection of objections) {
      if (objection.evidence.length === 0 && objection.evidence_missing !== true) {
        return `Objection ${objection.id} has empty evidence without evidence_missing: true`;
      }
    }
    if (objections.length === 0 && !reviewerPayload.cleanRationale?.trim()) {
      return "Reviewer returned zero objections without a cleanRationale";
    }
    return null;
  }

  if (role === "planner") {
    const addressed = (
      payload as {
        objectionsAddressed?: Array<{ objectionId: string; resolutionStrategy: string; evidence: string }>;
      }
    ).objectionsAddressed;
    if (!addressed || addressed.length === 0) return null;
    // Index into the pre-transform payload to tell a fresh structured addressal apart
    // from a bare-ID legacy entry (same post-parse shape, but not evidence-checked - it
    // predates this rule and must still validate on resume).
    const rawAddressed = Array.isArray(rawPayload.objectionsAddressed) ? rawPayload.objectionsAddressed : [];
    for (const [index, addressal] of addressed.entries()) {
      if (typeof rawAddressed[index] === "string") continue;
      if (addressal.resolutionStrategy === "revised_plan" && addressal.evidence.trim().length === 0) {
        return `Objection addressal ${addressal.objectionId} has resolutionStrategy revised_plan with empty evidence`;
      }
      if (!inputObjectionIds.includes(addressal.objectionId)) {
        return `Objection addressal references ${addressal.objectionId}, which is not among the turn's input objection IDs`;
      }
    }
    return null;
  }

  return null;
}
