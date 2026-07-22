# Phase 5: LLM Boundary Components

**Status: implemented**

The LLM boundary owns every structured LLM input and output. The
implementation is `@platform/llm-boundary` under `packages/llm-boundary`.
It provides Prompt Builder, Extraction & Validation, and the Objection
Engine (deterministic merge post-processing and lifecycle helpers). All
inputs and outputs use Phase 1 schemas and the TOON boundary; no raw chat
prose becomes workflow state. V2 sections: 6.4, 6.5, and 6.6 (merge /
lifecycle pieces). It depends on Phase 1 contracts, Phase 3 turn rows
(prompt hash / nonce / prompt-version), and Phase 4 lifecycle hooks.

Components are libraries invoked by the orchestration layer that wraps
the Phase 4 workflow engine. They never write the `events` table and
never make orchestration decisions.

## 1. Goal and Non-Goals

**Goal.** Three components that own every LLM input/output boundary:

1. **Prompt Builder** — immutable, hash-identified `prompt.md` files from
   folded state + versioned role prompts.
2. **Extraction & Validation** — TOON parse, envelope checks, Zod role
   validation, one bounded repair verdict, then `failed`.
3. **Objection Engine** — non-destructive cluster post-processing,
   severity-as-member-max, lifecycle transition checks. The merge *call*
   itself is a first-class turn through the standard protocol.

Every semantic-judgement step is an explicit, schema-validated LLM call
(V2 §9). No markdown, JSON, or free text crosses an internal LLM boundary
as executable instruction text (V2 §6.5).

**Non-goals.**

- No orchestration decisions or event writing (Phase 4 / Phase 3).
- No agent delivery (`AgentRuntime.send` is Phase 2).
- No frontier-review or dashboard logic (Phase 6; they reuse this
  package's builder and validator).
- No provider session-log parsing (Phase 6).
- No live LLM HTTP clients — role → provider/model is configuration for
  the runtime that delivers turns; this package stays fixture-testable.

## 2. Component Boundary and Invocation Model

```
Orchestration layer (wraps Phase 4 engine + Phase 2 runtime)
    │
    ├─ buildPrompt(turnType, state, …)  → Prompt Builder
    │       writes prompt.md, returns { promptHash, promptVersion, nonce, path }
    │
    ├─ AgentRuntime.send(…)             → Phase 2 (not this package)
    │
    ├─ validateResult(bytes, turn, …)   → Extraction & Validation
    │       returns Verdict { valid | needsRepair | failed }
    │       orchestrator maps to ValidationVerdict → engine.applyValidation
    │
    └─ applyMergeClusters(…) / lifecycle helpers → Objection Engine
            deterministic post-process of a validated merge result
```

The Phase 4 engine itself does not call these APIs; the orchestration
layer does, then feeds verdicts and objection updates into engine methods.

| Component | Inputs | Outputs | Invoking step | Engine emits from verdict |
|---|---|---|---|---|
| Prompt Builder | folded state, turn identity, role-prompt pin, turn type | `prompt.md` bytes + hash + version + nonce | turn creation | none (artifacts only) |
| Extraction & Validation | raw bytes + hash, turn expectation, attempt | `Verdict` | after `ResultFileSeen` → validating | `TurnCompleted` / repair / `TurnFailed` |
| Objection Engine (merge post) | validated merge payload + source objections | clusters with member-max severity | after merge turn `valid` | none from clusters; see §5.2 persistence |
| Objection Engine (lifecycle) | current status + requested status | accept/reject | planner / verifier / human paths | only via wired Phase 4 APIs (§5.3) |

## 3. Prompt Builder

source: V2 sections 5, 6.4, 7, 10

### 3.1 Artifact rules

- Full prompt written to `prompt.md` under
  `runs/<workflowId>/<iterationId>/<turnId>/`.
- File is immutable after write; identified by content hash (sha256 hex).
- Nonce and result-path instructions are embedded in every prompt.
- Large content never travels through terminal input.
- Builder creates the turn directory with restrictive permissions
  (`0o700`) when writing.

### 3.2 Versioned role prompts

Registry entry: `{ rolePromptId, version, contentHash, body }`.

Every built prompt records `(rolePromptId, version)` for the turn row's
prompt-version column. Changing a role prompt is a version bump, never an
in-place edit. The builder refuses an unknown or hash-mismatched pin.

### 3.3 Context from state, not history

Input is folded workflow state and DB projections, never transcripts.

| Turn type | Context |
|---|---|
| `planner_propose` | task, requirements, empty or prior proposal summary |
| `planner_revise` | proposal, open objections (as quoted evidence), human messages |
| `reviewer_review` | proposal, requirements; first round: no merged objection state; later: merged clusters as quoted evidence. Never the reviewer's own prior verdicts. |
| `adversarial_review` | same as review + falsify-assumptions instruction |
| `resolution_verification` | objection + planner response evidence (quoted); fresh session |
| `objection_merge` | candidate objections entirely as quoted-evidence blocks |
| `repair` | failure reason, expected schema, original nonce — nothing else new |
| `compacted_state_refresh` | proposal summary, open objections, recent decisions, requirements delta |

### 3.4 Injection defense

source: V2 sections 6.5, 10

Every natural-language field from prior LLM output (claims, review prose,
evidence text) renders inside explicit quoted-evidence blocks keyed by the
**per-turn nonce** (the same nonce from §3.1):

```
<<<EVIDENCE nonce="<turnNonce>" id="<id>" field="<field>">>>
...untrusted text (delimiter tokens neutralized)...
<<<END_EVIDENCE nonce="<turnNonce>">>>
```

A forged `<<<END_EVIDENCE>>>` inside untrusted text cannot close the block:
the scanner strips only sentinel-matched pairs. In addition, literal
`<<<EVIDENCE` / `<<<END_EVIDENCE` tokens inside payloads are neutralized
before embedding (`«EVIDENCE»` / `«END_EVIDENCE»`). The scanner flags raw
delimiter tokens in untrusted values and asserts that breakout fragments
after a forged close do not appear in instruction position.

The builder never places reviewer prose in instruction position. Applies
with full force to `objection_merge` and `planner_revise`.

### 3.5 Determinism

Same folded-state snapshot + same role-prompt version + same nonce →
byte-identical `prompt.md` and hash. The turn nonce is random in
production, so hashes differ across turns by design. Golden fixtures and
determinism tests **pin a fixed nonce**; they do not claim cross-turn
hash stability.

### 3.6 Turn-type catalog

| Turn type | Role prompt | Result schema |
|---|---|---|
| `planner_propose` | planner | `PlannerResultSchema` |
| `planner_revise` | planner | `PlannerResultSchema` |
| `reviewer_review` | reviewer | `ReviewerResultSchema` |
| `adversarial_review` | adversarial | `ReviewerResultSchema` |
| `resolution_verification` | verifier | `ResolutionResultSchema` |
| `objection_merge` | merge | `MergeResultSchema` |
| `repair` | (derived) | same as original turn type |
| `compacted_state_refresh` | planner-compact | `PlannerResultSchema` |

Frontier report prompts are Phase 6 but reuse this registry and builder
(`frontier_report` is registered for completeness so Phase 6 can build
without a catalog gap).

Startup completeness checks every catalogued turn type **except**
`repair`, which derives its result schema from `originalTurnType`. A
non-repair catalog entry without a registered result schema is a
**startup error**, not a runtime surprise.

## 4. Extraction & Validation

source: V2 section 6.5; Phase 1 envelope/repair; Phase 2 §5.6 boundary

### 4.1 Pipeline

1. Raw bytes + content hash from adapter (file-safety already done).
2. TOON parse (`parseToon`).
3. Envelope shape (`ResultEnvelopeSchema`).
4. Envelope rejection rules: mismatch, missing/wrong nonce, stale turn,
   unsupported `schemaVersion` (platform accepts `v1` in this phase).
5. Role check against expected turn type.
6. Zod validation against the turn-type result schema.
7. Reviewer-specific: empty `evidence` requires `evidence_missing: true`.

### 4.2 Verdict union

```ts
type ExtractionVerdict =
  | { outcome: "valid"; payload: unknown; resultHash: string }
  | { outcome: "needsRepair"; reason: string; diagnostics: string }
  | { outcome: "failed"; reason: string };
```

- Primary attempt failure → `needsRepair` (diagnostics are untrusted;
  repair prompt quotes them).
- Repair attempt failure → `failed`.
- Exactly one repair (`MAX_REPAIR_ATTEMPTS = 1`). Repair count lives on
  the turn row (`attempt: "primary" | "repair"`), not in component memory.

Mapper to Phase 4 `ValidationVerdict`:

| Extraction | Engine |
|---|---|
| `valid` | `{ outcome: "success", resultHash }` |
| `needsRepair` / `failed` | `{ outcome: "failure", reason }` |

### 4.3 Boundary split (restated)

| Check | Owner |
|---|---|
| symlink, ownership, world-writable, stale mtime, path escape, oversize | Phase 2 adapter |
| TOON parse, envelope, nonce, stale turn, schemaVersion, role Zod | Phase 5 |
| Platform event emission | Phase 4 engine only |

### 4.4 No free-text passthrough

Natural-language fields inside validated TOON stay data. Downstream
consumers receive them as `UntrustedText` (`{ kind: "untrusted"; value }`)
so prompt builder and dashboard cannot accidentally treat them as
instructions.

## 5. Objection Engine

source: V2 section 6.6

### 5.1 Severity rubric

| Severity | Meaning |
|---|---|
| `blocking` | Violates a hard requirement, creates credible security/data-loss risk, makes the plan infeasible, or leaves a core claim untestable. |
| `major` | Likely causes meaningful rework, missed edge cases, operational fragility, or degraded user-visible behavior, but does not invalidate the plan. |
| `minor` | Local improvement, wording issue, optional simplification, or polish that should not block approval. |

Schema shape enforces the enum. Rubric semantics live in review /
verification prompts. Confidence metadata may attach but never closes an
objection or satisfies a gate.

### 5.2 Objection-merge turn

Mechanics: first-class turn through the standard protocol. Merge failure
degrades to unmerged standalone objections (default on) — merging is an
optimization, never a correctness dependency.

**Merge result schema** (Phase 1 additive shape used by this package):

- `role: "merge"`
- `clusters[]`: `clusterId`, `objectionIds` (min length 2),
  `representativeClaim`, optional `mergeRationale`
- Structural rules validated with the input ID set: member IDs ⊆ input
  IDs, pairwise-disjoint clusters, no invented IDs, no singleton clusters
- Objections omitted from every cluster remain standalone
- LLM-emitted severity (if present) is **ignored**; post-processing
  recomputes severity as member maximum

**Deterministic post-processing** (Objection Engine, not the LLM):

- Cluster severity = max(member severities)
- Evidence links carried from members
- Every original objection record preserved untouched

**Cluster persistence.** Clusters are a **projection recomputed on demand**
from preserved objection records + the latest validated merge result (or
empty clusters after merge-failure degrade). They are not written to a
dedicated DB table and are not folded into event-sourced workflow state.
Recovery/replay reconstructs objection membership from events; clustering
is re-derived when the orchestration layer needs it. This matches the
non-destructive rule: originals remain the source of truth.

### 5.3 Lifecycle

Allowed transitions use Phase 1 `LEGAL_OBJECTION_TRANSITIONS` /
`isLegalObjectionTransition`. This package validates transition legality;
it does not persist status.

**Wired today (Phase 4 engine surface):**

| Transition / path | Phase 4 API / event |
|---|---|
| raise new objection | `raiseObjection` → `ObjectionRaised` (fold status `open`) |
| resolve | `resolveObjection` → `ObjectionResolved` |
| waive open objections | `HumanApproved` with waiver → fold marks waived |
| verifier reject (helper) | keeps logical status `open`; no dedicated event |

**Not wired yet (cross-phase dependency):** `open → accepted/rejected` and
`* → superseded` have Phase 1 legal transitions and Objection Engine
helpers, but no platform event kind or Phase 4 engine API that records
those statuses in the fold. Do not assume fold state tracks `accepted`,
`rejected`, or `superseded` until a later phase adds events + engine
methods. Until then, treat those helper checks as library validation only.

The consensus gate remains a Phase 4 guard over folded open objections.
The Objection Engine never gates.

### 5.4 Adversarial role

At least one reviewer per round uses the adversarial role prompt
(config: `adversarialCount`, minimum 1 when enabled). Same evidence
requirements; task is to falsify assumptions.

## 6. Configuration Surface

| Key | Type | Default | Consuming section |
|---|---|---|---|
| `rolePromptPins` | map role → `{ id, version }` | built-in v1 pins | §3.2 |
| `providerModelByRole` | map role → `{ provider, model }` | stubs | consumed by Phase 2 turn-delivery runtime when selecting provider/model for a role; this package does not call HTTP |
| `reviewerCountPerRound` | positive int | `2` | §5.4 / Phase 4 |
| `adversarialCount` | positive int | `1` | §5.4 |
| `compactedStateCadenceIterations` | positive int | `3` | §3.3 |
| `clusteringBatchSize` | positive int | `32` | §5.2 |
| `mergeFailureDegrade` | boolean | `true` | §5.2 |
| `repairDiagnosticsMaxChars` | positive int | `2000` | §4.2 |
| `acceptedSchemaVersions` | string[] | `["v1"]` | §4.1 |

## 7. Test Plan

Package tests under `packages/llm-boundary/test/`:

- Builder determinism (golden bytes/hash per turn type, merge included).
- Injection scanner: instruction-shaped reviewer prose only inside
  sentinel-matched evidence delimiters for review, revise, and merge
  prompts; negative fixture with forged `<<<END_EVIDENCE>>>` breakout.
- Extraction round-trips for each role schema; negative fixtures for
  envelope rules and Zod violations; verdict union coverage;
  turn-type→schema completeness at startup.
- Merge structural rules: invented IDs, overlaps, singletons rejected;
  empty cluster list valid.
- Merge degradation + severity always recomputed as member max.
- Repair protocol: primary → `needsRepair`; repair → `failed`; repair
  prompt content requirements.
- Clustering non-destructiveness: every input ID + evidence retained.
- Lifecycle: legal transitions accepted, illegal rejected; verifier
  reject keeps `open`.
- All LLM calls faked via fixtures; no live-model dependence.

## 8. Assigned Open Questions

- **Dedup aggressiveness (V2 §11 q1):** corpus of recorded objection sets
  with human-labeled clusters; tune merge prompt versions against
  over/under-merge rates. Non-destructive representation keeps bad
  merges reversible.
- **Reviewer pool composition (V2 §11 q3):** track per-reviewer yield,
  uniqueness, and verification survival in DB; composition is documented
  config per task type, not hard-coded logic.

## 9. Dependencies and Interfaces

**Depends on.**

- Phase 1: envelope, repair constants, role result schemas (including
  merge), objection lifecycle, TOON codec.
- Phase 3: turn row fields for prompt hash, nonce, prompt version, attempt.
- Phase 4: invocation hooks — build at turn creation, validate after
  result, merge as explicit workflow step, resolution verification turn.

**Provides to Phase 6.** Builder + validator for frontier report turns;
`UntrustedText` marking for dashboard escaping.

**Provides to Phase 7.** Implementation-agent turn types reuse the
registry; `ImplementationBlocked` deviation payloads validate through
the same extraction pipeline.
