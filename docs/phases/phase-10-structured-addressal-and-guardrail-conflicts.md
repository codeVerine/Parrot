# Phase 10: Structured Addressal and Guardrail Conflicts

**Status: implemented**

Phase 10 replaces prose objection handling with a machine-checkable binding, and
routes genuine design impossibilities to the human instead of burning iterations
on a workaround the guardrails forbid.

Two defects from the observed run:

1. `objectionsAddressed` is a bare list of IDs. A weak planner claims an
   objection is handled with vague prose in the proposal, and a weak reviewer
   either accepts blindly or re-raises out of confusion. Nothing binds an
   objection to the change that resolves it.
2. The planner spent three iterations working around a tension it had already
   detected - every way to make the gate machine-verifiable required a
   forbidden schema change. That insight surfaced in revision 4; as a
   first-class escalation it could have surfaced in revision 2.

It changes **one role-result schema** (planner, backward compatibly) and adds
**one new platform event kind** (`GuardrailConflict`). No SQL migration. V2
sections: 6.4, 6.6.

Packages consume:

- `@platform/contracts` - `PlannerResultSchema`, event catalog.
- `@platform/llm-boundary` - extraction rules, prompt builder example envelope,
  role prompt registry.
- `@platform/workflow-engine` - planning transitions, escalation effect.
- `@platform/persistence` - `decisions` table.
- `@platform/orchestrator` - review loop planner step, CLI.

## 1. Goal and Non-Goals

**Goal.** Every claimed objection resolution carries a strategy, quoted
evidence, and an explicit guardrail-exception flag; and any resolution that
concedes or needs a guardrail exception halts the loop immediately.

**Non-goals.**

- No semantic verification that the quoted evidence actually resolves the
  objection. That remains the reviewer's job (and the existing
  `resolution_verification` turn's).
- No new turn type. The addressal rides the existing planner result.
- No guardrail engine. A guardrail conflict is asserted by the planner and
  adjudicated by the human, not evaluated by the machine.

## 2. Structured Addressal Schema

### 2.1 Contract

```ts
export const ObjectionAddressalSchema = z.object({
  objectionId: z.string().min(1),
  resolutionStrategy: z.enum(["revised_plan", "retracted", "conceded"]),
  evidence: z.string().min(1),           // exact quote from proposal.md or pasted code
  requiresGuardrailException: z.boolean(),
});
```

`PlannerResultSchema.objectionsAddressed` becomes
`z.array(z.union([ObjectionAddressalSchema, LegacyIdString]))`, where
`LegacyIdString` is a bare ID string transformed into
`{ objectionId, resolutionStrategy: "revised_plan", evidence: "",
requiresGuardrailException: false }`.

The legacy branch exists so `resume.ts` can still re-read a `result.toon`
written before this phase. Without it, resuming an older workflow throws
`Durable state inconsistency: completed planner turn … has an invalid result`.
The branch is removable once no pre-Phase-10 run needs resuming.

| Strategy | Meaning | Loop action |
|---|---|---|
| `revised_plan` | The proposal changed; evidence quotes the change. | resolve objection |
| `retracted` | The objection rests on a premise the planner disproves; evidence cites the disproof. | resolve objection |
| `conceded` | The planner cannot resolve it within the constraints. | escalate, no reviewer round |

### 2.2 Validation

`checkEvidenceRules` in the extractor is extended to planner payloads:

- `revised_plan` with empty evidence -> `evidence_rules` failure. On a primary
  attempt this becomes `needsRepair`, so the existing bounded-repair path
  re-prompts once before failing the turn.
- An `objectionId` not present in the turn's `inputObjectionIds` -> failure.
  The review loop passes the currently open objection IDs on planner turns
  (`runTurn` already forwards `inputObjectionIds`; today only the merge turn
  uses it).

This makes vague prose a validation error rather than a reviewer's problem.

### 2.3 Prompt

Role prompt `planner@1.2.0` (following `1.1.0` from Phase 8) documents the four
fields, requires an exact quote in `evidence`, and adds the guardrail rule: if
satisfying an objection would require violating a guardrail, set
`requiresGuardrailException: true` and stop - do not build a workaround. The
builder's example envelope shows one structured addressal so the shape is
unambiguous. Pin default moves to `1.2.0`; `1.0.0` and `1.1.0` stay registered.

### 2.4 Durable record

Each addressal is persisted through the existing `decisions` table -
`decision: "objection_addressal"`, `chosen: <strategy>`, `reason: <evidence>`,
`objectionIds: [id]` - which already carries `objection_ids_toon`. No schema
change, and it gives the Phase 9 stalemate report both sides' evidence.

## 3. Guardrail Conflict Escalation

A `guardrailConflict` escalation is distinct from a `deviationRequest`: a
deviation asks to change the plan, a guardrail conflict reports that the
objection and the guardrails cannot both be satisfied.

New event:

```
GuardrailConflict { objectionIds: string[], detail: string }
```

It folds to `escalated`, like `ImplementationBlocked`. A new planning input
`guardrailConflict` and an engine method `reportGuardrailConflict` mirror
`reportImplementationBlocked`: append event, `notifyEscalation(reason:
"guardrail_conflict")`, persist status `escalated`.

### 3.1 Loop wiring

The review loop's planner step becomes:

1. Partition the addressals. Any entry with `requiresGuardrailException: true`
   or `resolutionStrategy: "conceded"` -> call `reportGuardrailConflict`,
   notify the human, and return. **No reviewer round is dispatched** - the
   round would be pure waste.
2. Otherwise resolve each `revised_plan` / `retracted` objection as today, with
   `resolution` set to `"<strategy>: <evidence excerpt>"` and the event carrying
   `iterationId` and `turnId`.
3. Persist every addressal to `decisions` regardless of branch.

The escalation reuses the Phase 9 `onStalemate` resolver and report path so a
guardrail conflict is not a dead end either: the human accepts the objection as
a hard block, waives it, or aborts. `ReviewLoopResult.escalation.reason` gains
the `"guardrail_conflict"` value.

## 4. Configuration Surface

| Setting | Default | Effect |
|---|---|---|
| `rolePromptPins.planner` | `1.2.0` | Repinned by this phase. |
| legacy addressal branch | enabled | Accepts pre-Phase-10 planner results on resume. |
| `escalationNotificationTarget` | existing | Reused; reason string is `guardrail_conflict`. |

## 5. Test Plan

- Contract: a bare-ID array and a structured array both parse; the bare-ID form
  normalizes to `revised_plan` with empty evidence.
- Extraction: `revised_plan` with empty evidence yields `needsRepair` on the
  primary attempt and `failed` on repair; an addressal for an ID absent from
  `inputObjectionIds` fails.
- Loop: a `conceded` addressal escalates with `GuardrailConflict` and dispatches
  zero reviewer turns; `requiresGuardrailException: true` does the same; a
  clean `revised_plan` resolves the objection and proceeds to review.
- Persistence: one `decisions` row per addressal, carrying the objection ID and
  evidence.
- Resume: a workflow whose newest planner `result.toon` uses the legacy bare-ID
  form still rehydrates.

## 6. Assigned Open Questions

- **Evidence provenance.** `evidence` is a free-text quote. Requiring a
  `proposal.md` line anchor would make it checkable, but needs the planner to
  emit stable anchors; deferred.
- **Retracted-vs-rejected.** `retracted` currently resolves the objection on the
  planner's word alone. Routing it through the existing
  `resolution_verification` turn is the natural upgrade once cost data justifies
  the extra turn.

## 7. Dependencies and Interfaces

**Depends on.**

- Phase 1: `PlannerResultSchema`, event catalog.
- Phase 3: `decisions`, `events`, fold projection.
- Phase 4: planning transitions, escalation effect.
- Phase 5: extraction rules, bounded repair, role prompt pinning.
- Phase 8: `planner@1.1.0` (this phase supersedes the pin) and the injected
  context that makes cited evidence real.
- Phase 9: escalation report and human override path.

**Provides.**

- An explicit objection -> change binding, machine-rejected when vague.
- A first-class route from "this objection cannot be satisfied within the
  guardrails" to a human, without an iteration spent building a forbidden
  workaround.
