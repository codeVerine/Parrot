<!-- generated-by: gsd-doc-writer -->
# @platform/human-loop

Human-facing services for Parrot: frontier finding conversion, escalation
notifications, versioned dashboard read models and HTTP API, human decisions,
provider cost ingestion, health metrics, redaction, and retention policy.

## Usage

```ts
import {
  createDashboardApi,
  createNotificationSink,
  projectDashboard,
} from "@platform/human-loop";
```

The dashboard API binds to `127.0.0.1:8787` by default. It is a library surface;
the main Parrot CLI does not start it automatically.

## Commands

```bash
pnpm --filter @platform/human-loop build
pnpm --filter @platform/human-loop typecheck
pnpm --filter @platform/human-loop test
```
