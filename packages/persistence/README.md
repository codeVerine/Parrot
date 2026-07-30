<!-- generated-by: gsd-doc-writer -->
# @platform/persistence

SQLite persistence for Parrot. The package owns the schema, event and signal
storage, workflow snapshots, turn/artifact/objection/decision records, usage
rows, agent sessions, outbox dispatch, event folding, and recovery helpers.

Use Node.js `22.13.0` through 22.x, or `23.4.0` and newer, for the stable
`node:sqlite` API.

## Usage

```ts
import { PersistenceStore } from "@platform/persistence";

const store = new PersistenceStore({ path: "runs/parrot.db" });
```

The append-only event log is the recovery authority. Snapshots are normalized
folded state, not a replacement for replay.

## Commands

```bash
pnpm --filter @platform/persistence build
pnpm --filter @platform/persistence typecheck
pnpm --filter @platform/persistence test
```
