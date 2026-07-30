# Phase 11: Reviewer Clean Rationale

**Status: implemented**

Phase 11 closes the iter-1 no-op: in the observed run the reviewer returned zero
objections without reasoning about the parity precondition or the
destructive-delete risk, so both risks were caught only later by the frontier. A
clean pass that carries no reasoning is indistinguishable from a reviewer that
did not review.

The rule is extraction-enforced, not prompt-advised: a zero-objection reviewer
reply without a `cleanRationale` is rejected as malformed, and the existing
bounded-repair path re-prompts once before failing the turn.

It changes **one role-result schema** (reviewer, additively) and **no platform
event kinds**. No SQL migration. V2 sections: 6.4, 6.5.

Packages consume:

- `@platform/contracts` - `ReviewerResultSchema`.
- `@platform/llm-boundary` - extraction evidence rules, role prompt registry,
  prompt builder example envelope.

## 1. Goal and Non-Goals

**Goal.** Every clean bill of health cites each acceptance criterion and
guardrail by name and explains why the plan satisfies it, so a no-objection
reply forces explicit per-criterion reasoning instead of a rubber stamp.

**Non-goals.**

- No semantic verification of the rationale itself. A vacuous rationale is the
  frontier's and the human's problem; this phase only makes silence a
  validation error.
- No change to objection-bearing replies. A non-empty objection list validates
  exactly as before; `cleanRationale` is accepted but never required there.
- No new turn type and no new event kind. The requirement rides the existing
  reviewer result and the existing repair path.

## 2. Contract and Validation

### 2.1 Schema

`ReviewerResultSchema` gains one optional field:

```ts
export const ReviewerResultSchema = z.object({
  role: z.literal("reviewer"),
  objections: z.array(/* unchanged */),
  cleanRationale: z.string().min(1).optional(),
});
```

Additive and backward compatible at the schema level: objection-bearing
results from before this phase still parse. The schema is shared by
`reviewer_review` and `adversarial_review`; both roles get the requirement
(the adversarial prompt already states "same evidence requirements as a
reviewer").

### 2.2 Evidence rule

`checkEvidenceRules` in the extractor (`extract/validate.ts`) extends its
reviewer branch: after the per-objection evidence loop, if the objections
array is empty and `cleanRationale` is missing or whitespace-only, fail with

```
Reviewer returned zero objections without a cleanRationale
```

On a primary attempt this is `needsRepair` with reason `evidence_rules`, so
the turn engine's bounded repair re-prompts the reviewer once with the
diagnostics; a second violation fails the turn. "Rejected as a malformed
reply, re-prompt" is therefore free - no new machinery.

### 2.3 Prompt

Role prompt `reviewer@1.1.0` (following `reviewer@1.0.0`) adds:

> If you return zero objections, include a `cleanRationale` field that cites
> each acceptance criterion and guardrail by name and explains why the plan
> satisfies it. An empty objection list without `cleanRationale` is rejected
> as a malformed reply.

`adversarial@1.1.0` adds the analogous line. Pin defaults move to `1.1.0`;
`1.0.0` stays registered so persisted turn `promptVersion`s resolve. The
prompt builder's reviewer example envelope shows `cleanRationale` alongside an
empty objections array - agents imitate the example, so the field must appear
there.

## 3. Resume Compatibility

`adoptResumeCandidate` re-validates persisted result bytes against the current
rules. A completed pre-phase reviewer turn whose clean pass lacked
`cleanRationale` now fails validation, and for `completed` candidates the
adoption path throws `Durable state inconsistency`. The window is narrow -
reachable only when the interruption lands between reviewer-turn completion
and the `objectionsCollected` transition on a pre-phase workflow - and the
recovery is a fresh run. This mirrors the accepted edge Phase 10 documented
for its legacy planner branch, in the opposite direction (Phase 10 kept old
results valid; this phase deliberately invalidates old clean passes because
the whole point is to reject them).

## 4. Configuration Surface

| Setting | Default | Effect |
|---|---|---|
| `rolePromptPins.reviewer` | `1.1.0` | Repinned by this phase. |
| `rolePromptPins.adversarial` | `1.1.0` | Repinned by this phase. |
| `repairDiagnosticsMaxChars` | existing | Reused; the diagnostics tell the reviewer exactly why the clean pass was rejected. |

## 5. Test Plan

- Contract: a reviewer result with `cleanRationale` parses; the field round-trips.
- Extraction: zero objections + no rationale -> `needsRepair` with
  `evidence_rules` on primary, `failed` on repair; zero objections +
  whitespace-only rationale -> same; zero objections + rationale -> `valid`;
  non-empty objections + no rationale -> `valid`.
- Builder: the reviewer example envelope contains `cleanRationale`; pin
  defaults assert `reviewer@1.1.0` and `adversarial@1.1.0`, and `1.0.0`
  entries remain resolvable.

## 6. Assigned Open Questions

- **Rationale quality floor.** A one-word rationale passes. Requiring per-
  criterion structure (a list of `{ criterion, justification }` entries) is
  the natural upgrade if real runs show reviewers gaming the field; deferred
  until a run demonstrates the need.

## 7. Dependencies and Interfaces

**Depends on.**

- Phase 1: `ReviewerResultSchema`.
- Phase 5: extraction evidence rules, bounded repair, role prompt pinning,
  example envelope.

**Provides.**

- A clean pass that must argue for itself, at the cost of one schema field
  and one evidence rule.
