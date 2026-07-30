<!-- generated-by: gsd-doc-writer -->
# Documentation

This index separates current operator/developer documentation from historical
design and planning evidence.

## Current documentation

- [Getting Started](GETTING-STARTED.md): prerequisites, installation, first run,
  and troubleshooting.
- [Architecture](ARCHITECTURE.md): live package boundaries, data flow, durable
  state, and runtime isolation.
- [Development](DEVELOPMENT.md): repository workflow and focused package
  commands.
- [Testing](TESTING.md): full and focused validation commands.
- [Configuration](CONFIGURATION.md): CLI environment variables and typed library
  defaults.
- [Phase map](phases/README.md): implementation status and phase-specific design
  contracts.

The root [README](../README.md) is the concise operator entry point.

## Historical and planning records

- [Architecture v0.2](../Multi-Agent-Orchestration-Architecture-v0.2.md) is the
  design baseline from which phases were derived. When it differs from live
  code, current documentation and implementation win.
- [Architecture v0.1](../Multi-Agent-Orchestration-Architecture-v0.1.md) is
  superseded by v0.2 and retained for decision history.
- `approved-plans/` contains immutable proposal artifacts from earlier planning
  workflows. They describe decisions at approval time, not necessarily the
  current command surface.
- [UI implementation plan](../output/ui-imp-plan.md) is a historical proposal.
  The shipped dashboard is currently a Vite client plus a library HTTP API, not
  the complete command surface proposed there.
- [Phase 7 retirement record](../task.md) records the live parity gate and
  completed composition-root migration.
- [To-do](../todo.md) records shipped work and the remaining deferred items.

## Source of truth

For runtime behavior, precedence is:

1. live source and tests;
2. current documents in this directory;
3. phase documents;
4. architecture drafts and approved plans.

Documentation state was reconciled with the repository on 2026-07-30.
