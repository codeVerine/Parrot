<!-- generated-by: gsd-doc-writer -->
# @platform/herdr-adapter

Herdr protocol-16 runtime adapter for Parrot. It validates daemon compatibility,
maps workflow roles to panes, submits prompts reliably, watches result artifacts,
normalizes runtime signals, enforces deadlines, and reconciles after reconnects.

## Usage

```ts
import {
  HerdrAgentRuntime,
  LineSocketTransport,
  Protocol16SocketClient,
} from "@platform/herdr-adapter";

const client = new Protocol16SocketClient(
  new LineSocketTransport("/path/to/herdr.sock"),
);
```

Runtime status never completes a turn by itself. The orchestrator still requires
the expected, validated result artifact.

## Commands

```bash
pnpm --filter @platform/herdr-adapter build
pnpm --filter @platform/herdr-adapter typecheck
pnpm --filter @platform/herdr-adapter test
```
