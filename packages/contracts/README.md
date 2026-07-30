<!-- generated-by: gsd-doc-writer -->
# @platform/contracts

Shared runtime contracts for Parrot. This private package defines branded IDs,
the platform event and signal catalogs, TOON encoding/decoding, objection and
decision schemas, and result schemas for every agent role.

## Usage

```ts
import {
  PlannerResultSchema,
  ResultEnvelopeSchema,
  encodeToon,
  parseToon,
} from "@platform/contracts";
```

All package-to-package payloads should use these exports rather than duplicating
local shapes. Schema evolution is additive by default; compatibility transforms
belong beside the owning schema.

## Commands

```bash
pnpm --filter @platform/contracts build
pnpm --filter @platform/contracts typecheck
pnpm --filter @platform/contracts test
```
