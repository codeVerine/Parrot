<!-- generated-by: gsd-doc-writer -->
# @platform/llm-boundary

Prompt and result boundary for Parrot's model-backed roles. It owns versioned
prompt pins, injection-delimited codebase evidence, role-aware prompt assembly,
TOON extraction, schema and evidence rules, bounded repair verdicts, objection
clustering, and objection lifecycle helpers.

## Usage

```ts
import {
  PromptBuilder,
  ResultExtractor,
  withLlmBoundaryConfig,
} from "@platform/llm-boundary";
```

Prompt bodies are pinned and deterministic. Repository text and model-produced
natural language must remain clearly marked as untrusted evidence.

## Commands

```bash
pnpm --filter @platform/llm-boundary build
pnpm --filter @platform/llm-boundary typecheck
pnpm --filter @platform/llm-boundary test
```
