# Multi-Agent Orchestration Platform Architecture

**Version:** 0.1 (Draft)

> **Historical document.** Superseded by architecture v0.2 and retained for
> decision history. It does not describe the current command, package, event, or
> persistence surfaces. See `docs/ARCHITECTURE.md` for the live architecture.

## 1. Vision

This document describes an architecture for a multi-agent software
engineering platform built on top of Herdr.

The objective is **not** to automate coding, but to automate the
repetitive coordination work between AI agents while keeping a human
engineer responsible for the final architectural decisions.

Primary goals:

-   Remove manual copy/paste between agents.
-   Preserve long-running conversations with specialist agents.
-   Minimize LLM cost by separating orchestration from reasoning.
-   Escalate to frontier models only when necessary.
-   Present humans with concise engineering decisions instead of raw
    transcripts.
-   Keep the system modular so Herdr can later be replaced if required.

------------------------------------------------------------------------

# 2. Design Principles

## Deterministic orchestration

Workflow execution should be deterministic.

Examples:

-   waiting for agents
-   retries
-   routing
-   state transitions
-   persistence
-   dashboard generation

These should never require an LLM.

LLMs should only be called for semantic reasoning.

------------------------------------------------------------------------

## Long-lived agents

Planner, reviewer and implementation agents should maintain persistent
context throughout a project.

Herdr is responsible for maintaining those sessions.

------------------------------------------------------------------------

## Event-driven

The platform should never poll agent status.

Instead:

Herdr → emits event

Workflow → reacts

This reduces latency and unnecessary work.

------------------------------------------------------------------------

## Human remains architect

Humans approve important decisions.

The platform filters information instead of replacing engineering
judgement.

------------------------------------------------------------------------

# 3. High Level Architecture

                    Herdr
                      │
              Socket API / CLI
                      │
            Herdr Runtime Adapter
                      │
                  Event Bus
                      │
              Workflow Engine
                      │
            ┌─────────┴─────────┐
            │                   │
    Conversation Router   Consensus Engine
            │                   │
            └─────────┬─────────┘
                      │
              Decision Engine
                      │
            ┌─────────┴─────────┐
            │                   │
     Frontier Review      Dashboard
            │                   │
            └─────────┬─────────┘
                      │
                     User

------------------------------------------------------------------------

# 4. Components

## 4.1 Herdr Runtime Adapter

Purpose:

Abstract Herdr behind a clean interface.

Responsibilities:

-   Subscribe to socket events
-   Read pane output
-   Send prompts
-   Query agent state
-   Restore sessions

Suggested interface:

``` ts
interface AgentRuntime {
  subscribe(handler)
  send(agentId, message)
  read(agentId)
  status(agentId)
}
```

No other component should know Herdr-specific APIs.

------------------------------------------------------------------------

## 4.2 Event Bus

Everything becomes an event.

Examples:

-   PlannerFinished
-   ReviewerFinished
-   ConsensusReached
-   AgentBlocked
-   HumanApproved
-   HumanRejected
-   WorkflowFailed

Benefits:

-   loose coupling
-   replay capability
-   future integrations
-   testing

------------------------------------------------------------------------

## 4.3 Workflow Engine

Responsible only for state transitions.

Example workflow:

1.  Planner completes.
2.  Send plan to reviewers.
3.  Wait for all reviews.
4.  Run consensus.
5.  If consensus below threshold:
    -   send review back to planner.
6.  Otherwise:
    -   frontier review.
7.  Generate dashboard.
8.  Wait for human decision.
9.  Trigger implementation workflow.

The workflow engine never analyses code.

------------------------------------------------------------------------

## 4.4 Conversation Router

Responsible for prompt construction.

Responsibilities:

-   extract latest response
-   trim unnecessary history
-   inject role prompts
-   maintain conversation metadata
-   prevent context explosion

Example:

Planner response

↓

Build review prompt

↓

Send to Codex reviewer

------------------------------------------------------------------------

## 4.5 Consensus Engine

Determines semantic agreement.

Rather than:

"Do they agree?"

Produce structured information:

``` json
{
  "architecture": 0.96,
  "performance": 0.88,
  "security": 1.00,
  "testing": 0.83,
  "overall": 0.92
}
```

Future enhancement:

Track decision evolution over time.

------------------------------------------------------------------------

## 4.6 Decision Engine

Consumes:

-   workflow state
-   consensus
-   human rules

Outputs:

-   Continue debate
-   Escalate
-   Ask human
-   Start implementation

This should be deterministic.

------------------------------------------------------------------------

## 4.7 Frontier Review

Runs only once.

Input:

-   final proposal
-   disagreements
-   review history

Output (JSON):

-   implementation readiness
-   remaining risks
-   questions for human
-   confidence
-   executive summary

Markdown should never be returned internally.

------------------------------------------------------------------------

## 4.8 Dashboard Generator

Consumes JSON only.

Produces:

-   summary
-   consensus chart
-   risks
-   timeline
-   decisions
-   approve/reject
-   comments

The dashboard should never depend on an LLM.

------------------------------------------------------------------------

## 4.9 Persistence

SQLite is sufficient initially.

Suggested tables:

-   workflows
-   events
-   agents
-   conversations
-   iterations
-   consensus
-   decisions
-   human_feedback

------------------------------------------------------------------------

# 5. Agent Roles

## Planner

Examples:

-   Claude
-   GPT-5.5

Creates implementation strategy.

------------------------------------------------------------------------

## Reviewer

Examples:

-   Codex
-   Gemini

Critiques:

-   correctness
-   performance
-   maintainability
-   edge cases

------------------------------------------------------------------------

## Frontier Reviewer

Invoked only after consensus.

Purpose:

Detect remaining engineering uncertainty.

------------------------------------------------------------------------

## Implementation Agents

Receive approved plan.

Never redesign architecture.

------------------------------------------------------------------------

# 6. Event Flow

    Planner finished

    ↓

    Herdr event

    ↓

    Workflow engine

    ↓

    Conversation router

    ↓

    Reviewer

    ↓

    Consensus

    ↓

    Decision engine

    ↓

    Planner (if needed)

    ↓

    Consensus reached

    ↓

    Frontier review

    ↓

    Dashboard

    ↓

    Human approval

    ↓

    Implementation

------------------------------------------------------------------------

# 7. Why Not Use an LLM as the Manager?

An LLM manager would:

-   consume unnecessary tokens
-   introduce non-determinism
-   be harder to debug
-   make retries unpredictable

Instead:

Deterministic software performs orchestration.

LLMs perform reasoning only.

------------------------------------------------------------------------

# 8. Structured Decisions

Instead of storing chat logs, store decisions.

Example:

``` json
{
  "decision":"Buffer size",
  "chosen":"2000ms",
  "alternatives":["500ms","1000ms"],
  "reason":"Reduced underruns.",
  "confidence":0.96
}
```

Benefits:

-   searchable
-   auditable
-   dashboard-friendly
-   reusable

------------------------------------------------------------------------

# 9. Future Enhancements

-   Multiple reviewer pools.
-   Domain-specific reviewers (security, performance, UX).
-   Automatic PR generation.
-   Git worktree integration.
-   Plugin architecture.
-   Slack/Discord notifications.
-   Mobile dashboard.
-   Decision knowledge graph.
-   Metrics and cost reporting.

------------------------------------------------------------------------

# 10. Risks

-   Infinite debate loops.
-   Context growth.
-   Reviewer bias.
-   False consensus.
-   Event ordering.
-   Agent failure recovery.

Mitigations:

-   max iteration count
-   confidence thresholds
-   deterministic state machine
-   event persistence
-   replay support

------------------------------------------------------------------------

# 11. Open Questions

1.  How should consensus be measured?
2.  Should reviewers vote independently or sequentially?
3.  Should planner see all reviewer feedback or merged feedback?
4.  How are contradictory frontier reviews handled?
5.  Should implementation agents be allowed to challenge architecture?
6.  What is the optimal human intervention threshold?
7.  Should decisions become a long-term organizational knowledge base?

------------------------------------------------------------------------

# 12. Suggested Technology Stack

-   Runtime: Herdr
-   Language: TypeScript
-   Backend: Node.js
-   Event Bus: EventEmitter initially (upgrade to NATS/Redis if needed)
-   Database: SQLite
-   ORM: Drizzle or Prisma
-   Dashboard: React + Vite
-   State Machine: XState (optional)
-   Validation: Zod
-   LLM Providers: OpenAI, Anthropic, Google AI
-   Deployment: Docker

------------------------------------------------------------------------

# 13. Next Phase

After validating this architecture, define:

1.  Event schema.
2.  Workflow state machine.
3.  JSON contracts.
4.  Consensus prompt specification.
5.  Dashboard schema.
6.  Plugin system.
7.  MVP implementation roadmap.
