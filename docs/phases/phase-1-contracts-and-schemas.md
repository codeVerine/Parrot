# Phase 1: Contracts and Schemas

**Status: implemented**

## 1. Goal and non-goals

Define the stable contracts used by the platform. This phase owns identifiers, result envelopes, platform events, runtime signals, role results, objections, decisions, requirements, versioning, repair constants, and TOON encoding. It does not implement Herdr, persistence, workflow transitions, or LLM calls.

## 2. Turn artifact layout

Each turn uses `runs/<workflowId>/<iterationId>/<turnId>/` with immutable `prompt.md`, agent-written `result.toon`, and optional `repair-prompt.md`. Agents write `result.tmp`, close it, and atomically rename it. The platform creates private directories, canonicalizes paths, and records hashes. Agent-written files remain untrusted input.

## 3. Result envelope

An envelope contains `workflowId`, `iterationId`, `turnId`, `schemaVersion` (`v<major>`), `nonce`, `role`, and a role payload. Named predicates expose the shared rejection rules: `rejectEnvelopeMismatch`, `rejectMissingNonce`, and `rejectStaleTurn`. Parsing and role validation are separate from adapter file-safety checks.

## 4. Platform events

The approved v1 event catalog is exactly: `TurnCompleted`, `TurnFailed`, `AgentTimedOut`, `ObjectionRaised`, `ObjectionResolved`, `ConsensusReached`, `HumanApproved`, `HumanRejected`, `ImplementationBlocked`, `BudgetCapReached`, `IterationCapReached`, `OrphanResultSeen`, `UsageRecorded`, and `VerificationCompleted`. Every event has `eventId`, `occurredAt`, and `workflowId`; other correlation fields are present when applicable. The first twelve come from the Phase 1 approval, `UsageRecorded` is an approved Phase 4 additive revision, and `VerificationCompleted` is an approved Phase 7 additive revision.

## 5. Role result schemas

Zod schemas cover planner proposals, reviewer objections, resolution verification, frontier reports, implementation results, and objection merges. Role results are encoded as TOON and validated at the LLM boundary. Natural-language fields are data, never executable orchestration instructions.

The canonical TOON codec lives in `packages/contracts/src/toon/` and is
consumed by the root orchestrator and persistence package. There is no second
platform TOON dialect.

## 6. Runtime signals

Signals are observations, not platform events. The common envelope has a unique `signalId`, `observedAt`, source (`herdr_event`, `fs_watch`, `deadline_timer`, `reconcile`, or `adapter_internal`), and nullable workflow, iteration, turn, and agent correlations.

Observation kinds are `HerdrStatusChanged`, `ResultFileSeen`, `DeadlineExpired`, and `SnapshotReconciled`. Fault kinds are `AgentSpawnFailed`, `TurnDeliveryFailed`, `ResultWatchFailed`, `ArtifactRejected`, `ReconnectFailed`, `ProtocolMismatch`, and `DegradedModeEntered`. A fault means the adapter failed or refused; an observation means the adapter observed something. `DeadlineExpired` is intentionally an observation.

## 7. Objections

Severity is `blocking`, `major`, or `minor`. Status is `open`, `accepted`, `rejected`, `superseded`, `resolved`, or `waived`, with legal transitions exported as data. Objections preserve evidence or explicitly mark `evidence_missing`. Clusters preserve every member ID and use the maximum severity.

## 8. Decisions

Decisions record the chosen option, alternatives, reason, optional confidence, and provenance containing workflow, iteration, turn, and objection references.

## 9. Requirements

Imported requirements have stable IDs, source path, content hash, priority, optional external ID, and text. Objections and decisions reference these stable records rather than copied prose.

## 10. Versioning policy

Schema versions use `v<major>`. Adding optional fields or union members is additive. Removing or retyping fields is breaking. `isAdditiveSchemaChange` provides a checkable predicate for migrations and approved additive revisions.

## 11. Validation and repair

Each role schema is validated independently. A malformed result gets one bounded repair prompt using `repair-prompt.md`; a second validation failure becomes `TurnFailed`. `MAX_REPAIR_ATTEMPTS` is one. The adapter only enforces file safety; extraction owns envelope, nonce, stale-turn, schema-version, and role parsing.

## 12. Test plan and open questions

Contract tests cover TOON round trips, envelope predicates, the fourteen-event catalog, eleven-signal taxonomy, objection transitions, and additive versioning. Phase 1 records the schema-evolution question: how aggressively schemas may evolve before persistent planner continuity requires a major version.
