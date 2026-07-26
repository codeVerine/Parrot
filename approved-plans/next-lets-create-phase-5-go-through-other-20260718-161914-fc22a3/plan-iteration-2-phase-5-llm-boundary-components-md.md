# Plan (iteration 2): Expand Phase 5 (LLM Boundary Components) into a Full Technical Document

## 0. Changes from Iteration 1

- **OBJ-001 (major)**: the turn-type catalog omitted the objection merge/dedupe turn even though section 4.5 required merge/dedupe to be an LLM call validated like any other turn. Resolved by making the merge turn a first-class turn type end to end: the catalog in 4.3 now includes **objection-merge**, section 4.5 specifies its prompt spec, input payload, and result schema, and the merge-result schema is added to the Phase 1 role result schemas as an additive revision under the Phase 1 versioning policy (same mechanism as the Phase 4 plan's `UsageRecorded` event - the approved Phase 1 enumeration lists four role result schemas and does not include a merge result). The merge turn runs through the standard turn protocol (prompt file, envelope, nonce, Zod validation, single bounded repair), so V2 section 9's requirement - semantic judgement steps are explicit schema-validated LLM calls - holds mechanically, not by assertion. Sections 3, 4.3, 4.5, 4.7, and 6 updated; test plan gains merge-turn fixtures.

## 1. Context and Sources

Per the approved phase split (`approved-plans/task-20260718-043855-83ecd8/plan.md`), Phase 5 is **LLM Boundary Components**: Prompt Builder (immutable hash-identified prompt files, versioned role prompts, state-built context); Extraction & Validation (TOON parse, Zod validate, one bounded repair, `TurnFailed`); Objection Engine (non-destructive merge/dedupe clustering, severity rubric enforcement, adversarial reviewer role prompt). Depends on Phases 1 and 4. (V2 sections 6.4, 6.5, 6.6, plus 2, 5, 7, 9, 10, 11.)

The previous phase artifacts, all verified present in the checkout:

- `approved-plans/task-20260718-043855-83ecd8/plan.md` - phase split; Phase 1 doc spec (twelve v1 platform events, role result schemas, objection/decision schemas, repair protocol, versioning policy).
- `approved-plans/task-20260718-065524-90fca8/plan.md` - Phase 2 doc spec; runtime-signal taxonomy; the validation-boundary split (adapter does file-safety only; envelope rejection rules require parsing and belong to Extraction & Validation); repair-turn delivery mechanics.
- `approved-plans/now-lets-phase-three-document-create-it-so-20260718-073939-066171/plan-phase-3-event-log-persistence-md-full-spec.md` - Phase 3 doc spec; the rule that only the workflow engine writes `events`; turn rows carry prompt hash, nonce, and prompt-version reference.
- `approved-plans/now-lets-create-next-phase-document-i-think-20260718-074737-1f04c6/plan-iteration-2-phase-4-workflow-engine-md-corrects.md` - Phase 4 doc spec; turn lifecycle hooks Phase 5 plugs into (when prompts are built, when validation verdicts feed back, when the objection-merge step runs); `UsageRecorded` additive event revision.

Current repo state: `docs/phases/` still does not exist; none of the four approved executions have landed. Same posture as every plan since Phase 2: if `docs/phases/` is absent at execution time, backfill the Phase 1-4 docs per the four approved plans (verified filenames above) first, then write the Phase 5 doc. Nothing here contradicts the approved plans; contested details are cited, not invented. This plan makes one deliberate additive contract change: the objection-merge result schema added to the Phase 1 role result schemas (section 4.5), under the Phase 1 versioning policy.

Inline duplication exceptions in the Phase 5 doc, each with a "source:" marker: the severity rubric table (source: V2 section 6.6 via the Phase 1 doc - validators and review prompts need it inline), the objection status enum, and the turn-protocol steps 1-5 relevant to prompt/result handling (source: V2 section 5).

## 2. Deliverables

```
docs/
  phases/
    README.md                            (index; Phase 5 status set to "detailed")
    phase-1-contracts-and-schemas.md     (backfill if absent; includes UsageRecorded and merge-result-schema additive revisions)
    phase-2-herdr-runtime-adapter.md     (backfill if absent)
    phase-3-event-log-and-persistence.md (backfill if absent)
    phase-4-workflow-engine.md           (backfill if absent)
    phase-5-llm-boundary-components.md   (full detail - the deliverable of this task)
    phase-6-frontier-review-dashboard-cost.md (skeleton, if absent)
    phase-7-implementation-agents-and-mvp.md  (skeleton, if absent)
```

No source code in this turn. Documentation only.

## 3. Contracts Consumed from Phases 1-4

The Phase 5 doc consumes, and may not redefine:

- **Role result schemas and envelope** (Phase 1): planner proposal, reviewer objections, resolution verification, frontier report schemas with Zod types - plus the objection-merge result schema added by this plan as an additive revision (section 4.5); envelope fields and rejection rules (envelope mismatch, missing/wrong nonce, stale turn, `schemaVersion`); the repair protocol (exactly one bounded repair, repair prompt content requirements, second failure semantics).
- **Objection and decision schemas** (Phase 1): severity enum and rubric, status state machine, evidence rules and `evidence_missing`, cluster representation (cluster ID, preserved member IDs, max-severity rule).
- **Validation-boundary split** (Phase 2 section 5.6): the adapter delivers raw bytes plus hash after file-safety checks only; every parse-dependent check is Phase 5's. The Phase 5 doc restates the split from its side so neither component assumes the other performs a check.
- **Turn artifact layout** (Phase 1/2): `prompt.md` immutable and hash-identified, `repair-prompt.md` in the same turn directory, same turnId on repair, atomic writes.
- **Sole-event-writer rule** (Phase 3): Phase 5 components return verdicts and structured results to the workflow engine; they never write platform events themselves.
- **Turn lifecycle hooks** (Phase 4): prompt construction at turn creation, validation verdict feeding the `validating → completed | repair_sent | failed` transitions, objection-merge as an explicit workflow step, resolution verification as a distinct turn type.

## 4. Required Content of `phase-5-llm-boundary-components.md`

### 4.1 Goal and Non-Goals

- Goal: the three components that own every LLM input and output boundary - Prompt Builder, Extraction & Validation, Objection Engine. Every semantic-judgement step is an explicit, schema-validated LLM call owned by a component (V2 section 9); no markdown, JSON, or free text ever crosses an internal LLM boundary (V2 section 6.5).
- Non-goals: no orchestration decisions (Phase 4 owns transitions and guards), no agent delivery (Phase 2 owns `send`), no event writing (Phase 3 rule), no frontier-review or dashboard logic (Phase 6 - though both reuse this phase's builder and validator infrastructure), no session-log parsing (Phase 6 provider adapters).

### 4.2 Component Boundary and Invocation Model

All three components are libraries invoked synchronously by Phase 4 workflow steps. Data flow per turn: engine requests prompt → builder writes `prompt.md`, returns hash + prompt version → engine drives adapter `send` → adapter delivers result bytes + hash → engine invokes Extraction & Validation → verdict returns to the engine, which makes the transition and emits the events. The objection-merge step is exactly this shape (section 4.5). A single diagram plus a table: component, inputs, outputs, invoking workflow step, events the engine emits from its verdicts.

### 4.3 Prompt Builder

- **Artifact rules** (source: V2 section 5): full prompt written to `prompt.md`; immutable; content-hash identified; nonce and result-path instructions embedded; restrictive per-turn permissions; large content never through terminal input.
- **Versioned role prompts**: a role-prompt registry - role prompt ID, semver version, content hash; every built prompt records `(rolePromptId, version)` into the turn row (the prompt-version reference column from the Phase 3 schema). Changing a role prompt is a version bump, never an edit in place.
- **Context built from state, not history** (V2 sections 2, 6.4): input is folded workflow state and DB projections, never transcripts. Reviewer context: current proposal, requirements, open objections, resolution evidence - never the reviewer's own earlier verdicts (fresh sessions, anti-anchoring, V2 section 7). First review round: independent, no merged objection state; later rounds: merged state included (V2 section 11 resolved question 2).
- **Planner compacted state prompt** (V2 section 7): periodically generated from the database to refresh the persistent planner session; cadence is a config value; content spec: current proposal summary, open objections, recent decisions with provenance, requirements delta.
- **Turn-type catalog**, one prompt spec per type: planner propose, planner revise (embeds objection IDs the planner must respond to), reviewer review, adversarial review, resolution verification, **objection-merge** (input rendering and output contract per section 4.5), repair (content requirements per the Phase 1 repair protocol: what failed, the expected schema, the original nonce - and nothing else new), compacted state refresh. Frontier report prompts are Phase 6 but use this registry and builder.
- **Injection defense** (V2 sections 6.5, 10): every natural-language field from prior LLM output (claims, review prose, evidence text) is rendered inside explicit quoted-evidence blocks; the builder never places reviewer prose in instruction position. Applies to the objection-merge prompt with full force: it is composed almost entirely of prior reviewer prose, every field of which renders as quoted evidence. The doc includes the concrete template convention (delimiter format, evidence-block header) so the rule is mechanical, not stylistic.
- **Determinism**: same state + same role-prompt version → byte-identical prompt file and hash. Required for audit and for the golden-fixture tests in 4.7.

### 4.4 Extraction & Validation

- **Pipeline**: raw bytes + hash from adapter → TOON parse → envelope checks (Phase 1 rejection rules: envelope mismatch, missing/wrong nonce, stale turn, unsupported `schemaVersion`) → Zod validation against the role result schema for the turn type → typed result to the engine. The turn-type-to-schema mapping table includes every catalog entry from 4.3, objection-merge included; a catalog turn type without a registered result schema is a startup error, not a runtime surprise.
- **Failure handling**: any parse/envelope/schema failure on the primary attempt produces a repair verdict; the engine sends the single bounded repair (`repair-prompt.md`, same turnId, per Phase 2 section 5.7 delivery mechanics). Failure on the repair attempt produces a `TurnFailed` verdict; the engine emits the event. Exactly one repair, never more - the count lives in the turn row, not component memory, so restarts cannot reset it.
- **Verdict type**: a closed union returned to the engine - `valid(payload)`, `needsRepair(reason, diagnostics)`, `failed(reason)` - with the rule that diagnostics fed into repair prompts are themselves treated as untrusted quoted content.
- **Boundary restatement** (source: Phase 2 plan section 5.6): file-safety checks (symlink, ownership, world-writable, stale mtime, path escape, oversize) are the adapter's; everything requiring parsing is here. Table of check → owner so the split is auditable.
- **No free-text passthrough**: natural-language fields inside validated TOON stay data; downstream consumers (prompt builder, dashboard) receive them marked as untrusted strings.

### 4.5 Objection Engine

- **Inputs**: validated reviewer objection payloads (Phase 1 schema). Outputs: objection state updates and cluster proposals returned to the engine, which emits `ObjectionRaised` / `ObjectionResolved`.
- **Severity rubric enforcement**: rubric table inline (source: V2 section 6.6 via Phase 1 doc); validators reject severities without rubric-consistent claims only via schema shape, while rubric semantics are enforced by review prompts and the resolution-verification turn - the doc is explicit about which layer enforces what.
- **The objection-merge turn** (closes OBJ-001; V2 sections 6.6 and 9):
  - *Mechanics*: a first-class turn through the standard protocol - the engine opens a merge turn, the builder renders the objection-merge prompt (turn type in 4.3), delivery and result collection run through the same adapter path, Extraction & Validation validates against the merge result schema, single bounded repair applies, second failure is `TurnFailed` for the merge turn and the workflow proceeds with unmerged objections (stated degradation rule: merging is an optimization, never a correctness dependency).
  - *Prompt spec*: instruction block (cluster near-identical objections, preserve all IDs, never drop or rewrite claims) plus the candidate objections rendered entirely as quoted-evidence blocks (ID, dimension, severity, claim, evidence refs); no reviewer prose in instruction position.
  - *Result schema* (added to the Phase 1 role result schemas as an additive revision, with revision note, under the Phase 1 versioning policy): list of clusters, each with proposed cluster ID, member objection IDs (must partition a subset of the input IDs - no invented IDs, no duplicates across clusters), a representative claim marked as untrusted text, and optional merge rationale; objections omitted from every cluster remain standalone. Zod-enforced structural rules: member IDs ⊆ input IDs, pairwise-disjoint clusters, minimum cluster size two.
  - *Deterministic post-processing*, in the Objection Engine, not the LLM: cluster severity computed as member maximum (never taken from the LLM output), evidence links carried over from members, every original objection record preserved untouched. A structurally valid but semantically bad merge is therefore always reversible.
  - *Model choice*: cheap model per config (provider/model per role table in 4.6 already includes the merge call).
- **Non-destructive clustering invariants**: clusters preserve every original objection ID and evidence link; cluster severity is the member maximum unless a deterministic rule or explicit human waiver lowers it; no objection record is ever mutated or deleted by clustering.
- **Lifecycle operations**: allowed status transitions (Phase 1 state machine) mapped to who may trigger them - planner responses, resolution-verification verdicts, human waivers. The consensus gate itself is a Phase 4 guard over folded objection state; the Objection Engine never gates.
- **Resolution verification**: fresh reviewer session per verification (V2 section 6.6); verification turn type from 4.3; a resolution rejected by the verifier keeps the objection `open` with the verifier's evidence attached.
- **Adversarial role**: at least one reviewer per round runs the adversarial role prompt - falsify assumptions under the same evidence requirements, not contrary prose (V2 sections 6.6, 7). Config: adversarial count, minimum one.
- **Confidence metadata**: may be attached, never closes an objection, never satisfies a gate (V2 section 6.6).

### 4.6 Configuration Surface

Single table: key, type, default, consuming section. Minimum: role-prompt version pins per role, provider/model per role (planner, reviewer, adversarial, verifier, objection-merge), reviewer count per round, adversarial count (min 1), compacted-state-prompt cadence, clustering batch size, merge-failure degradation toggle (proceed unmerged - default on), repair diagnostics length limit.

### 4.7 Test Plan

- Builder determinism: same folded state + role-prompt version → identical bytes and hash (golden fixtures per turn type, objection-merge included).
- Injection fixtures: reviewer prose containing instruction-shaped text ("ignore previous instructions", tool-call syntax) appears only inside quoted-evidence blocks in built prompts - asserted for review, revise, and objection-merge prompts; a scanner test asserts no untrusted string lands outside evidence delimiters.
- Extraction round-trips: valid fixture per role schema including the merge result; negative fixtures per envelope rejection rule and per Zod schema violation; verdict union coverage; turn-type-to-schema completeness check (every 4.3 catalog entry has a schema).
- Merge-schema structural rules: invented member IDs rejected, overlapping clusters rejected, singleton clusters rejected, empty cluster list valid (nothing merged).
- Merge degradation: merge-turn `TurnFailed` leaves all objections standalone and the workflow advancing; severity always recomputed as member max regardless of LLM output.
- Repair protocol: primary failure → `needsRepair` exactly once; repair failure → `failed`; repair count survives simulated restart (turn-row backed); repair prompt content matches the Phase 1 requirements.
- Clustering non-destructiveness: property test - after any clustering result, every input objection ID and evidence link is still retrievable; cluster severity equals member max absent an explicit lowering rule.
- Lifecycle: every allowed status transition accepted, every disallowed one rejected; verifier rejection keeps `open`.
- Rubric and schema enforcement: severity values outside the enum rejected; `evidence_missing` marker required when evidence array is empty.
- All LLM calls faked via recorded fixtures; no live-model dependence in the phase test suite.

### 4.8 Assigned Open Questions

Two of the four V2 section 11 open questions land here, recorded with a measurement approach:

- **Dedup aggressiveness (question 1)**: how hard to merge without losing distinct concerns. Approach: corpus of recorded objection sets, human-labeled ground-truth clusters, measure over/under-merge rates per merge-prompt version; the merge prompt version is tuned against this corpus, and the non-destructive representation means a bad merge is always reversible.
- **Reviewer pool composition (question 3)**: which providers/roles per task type. Approach: track per-reviewer objection yield, uniqueness (objections no other reviewer raised), and verification survival rate in the DB (Phase 3 tables already carry the data); composition becomes a documented config default per task type, not code.

### 4.9 Dependencies and Interfaces to Other Phases

- Depends on Phase 1 (schemas, envelope, repair protocol, rubric - including the merge-result additive revision), Phase 4 (invocation hooks, verdict consumption, the objection-merge workflow step), and transitively Phase 2/3 mechanics (delivery, turn rows, prompt-version column).
- Provides to Phase 6: the builder + validator infrastructure for frontier report turns; untrusted-string marking the dashboard's escaping relies on.
- Provides to Phase 7: implementation-agent prompt turn types reuse the registry; `ImplementationBlocked` deviation requests are validated through the same extraction pipeline.

## 5. Execution Steps

1. If `docs/phases/` is absent: create `README.md` and backfill Phases 1-4 from the four verified sources listed in section 1 (the backfilled Phase 1 doc includes both additive revisions: `UsageRecorded` and the objection-merge result schema, each with its revision note), and create the Phase 6-7 skeletons. If present: backfill only what is missing and apply the revisions.
2. Write `docs/phases/phase-5-llm-boundary-components.md` with the nine sections of section 4 above, citing Phase 1-4 doc sections for schemas, boundary split, event rules, and lifecycle hooks.
3. Update `README.md` index: Phase 5 → "detailed".
4. Stop. No code.

## 6. Risks

- **Backfill debt at maximum**: four approved executions have not landed; this turn may write six detailed docs. Flagged for the human explicitly: executing the backlog is now cheaper than one more deferral, and Phase 6 planning should not start before `docs/phases/` exists.
- **Second additive Phase 1 revision**: the merge-result schema follows the `UsageRecorded` precedent (additive rule, revision note). Two revisions before Phase 1 is even backfilled is a signal the backfill must land soon; both revisions are contained in the same backfill write, so no doc ever exists in the unrevised state.
- **Injection defense as convention**: quoting rules fail silently if only prose. Mitigated: the template convention is specified mechanically and the scanner test in 4.7 makes violations fail CI, not review; the merge prompt - built almost entirely from untrusted reviewer prose - is explicitly in the scanner's fixture set.
- **Clustering quality unknown** (open question 1): bounded by non-destructive representation and deterministic post-processing - worst case is reversible over-merge surfaced to the human, never lost objections, never LLM-assigned severity.
- **Role-prompt drift**: version pins recorded per turn make any output attributable to an exact prompt version; tuning happens by version bump with the 4.8 corpus, so quality changes are measurable, not vibes.
- **Duplication drift**: rubric, status enum, and turn-protocol excerpts carry "source:" markers to V2 6.6/5 and the Phase 1 doc.
