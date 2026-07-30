# Platform Phases

This table reports the state of the live workspace packages as of 2026-07-30.
“Implemented” means the phase's package behavior and deterministic tests exist;
it does not imply that every assigned operational follow-up is closed.

| Phase | Title | Status | Depends on | V2 sections |
|---|---|---|---|---|
| 1 | Contracts and Schemas | implemented | none | 5, 6.2, 6.6, 6.9, 8 |
| 2 | Herdr Runtime Adapter | implemented | Phase 1 | 3, 5, 6.1, 6.2, 10 |
| 3 | Event Log and Persistence | implemented | Phase 1, Phase 2 | 6.2, 6.9 |
| 4 | Workflow Engine | implemented | Phase 1, Phase 2, Phase 3 | 6.3, 6.6 |
| 5 | LLM Boundary Components | implemented | Phase 1, Phase 3, Phase 4 | 6.4, 6.5, 6.6 |
| 6 | Frontier Review, Dashboard, Cost | implemented | Phase 3, Phase 4, Phase 5 | 6.7, 6.8, 6.10 |
| 7 | Implementation Agents and MVP | implemented | Phase 1 through Phase 6 | 7, 8 |
| 8 | Repo Context and Evidence Citations | implemented | Phase 5, Phase 7 | 6.4, 6.5 |
| 9 | Objection Stalemate Escalation | implemented | Phase 1, Phase 3, Phase 4, Phase 6, Phase 7 | 6.3, 6.6 |
| 10 | Structured Addressal and Guardrail Conflicts | implemented | Phase 8, Phase 9 | 6.4, 6.6 |
| 11 | Reviewer Clean Rationale | implemented | Phase 1, Phase 5 | 6.4, 6.5 |
| 12 | Proposal-Diff Signal and Frontier Re-invoke (churn deferred) | implemented | Phase 1, Phase 3, Phase 4, Phase 6, Phase 7, Phase 9, Phase 10 | 6.3, 6.6, 6.7 |

Phase documents are implementation boundaries. The
[current architecture](../ARCHITECTURE.md) describes the live system.
Architecture v0.2 remains the historical rationale baseline, and approved plans
remain the evidence for phase-specific decisions.

Known deferred work:

- Phase 12: proposal diffing and frontier re-invocation are active; plan-churn
  detection is intentionally not wired into the loop.
