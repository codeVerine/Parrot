# Phase 8: Repo Context and Evidence Citations

**Status: implemented**

Phase 8 removes the root cause of the "unbuildable verifier" trap observed in a
real planner<->reviewer<->frontier run: a weak planner asked to design tooling
hallucinates APIs (`turn_type` on turn rows, `saveDecision` on approval, a
persisted runner discriminator) because it has no view of the codebase and no
obligation to prove an interface exists before depending on it.

Two complementary defenses, both landing at the Phase 5 boundary:

1. **Cite-or-block** - a versioned planner role-prompt revision that makes an
   uncited dependency on an existing code artifact a blocking-severity defect.
2. **Codebase context injection** - the composition root resolves files named in
   the task, and the Prompt Builder renders them as quoted evidence in a
   `## Codebase Context` block, so even a weak model reads correct field names
   instead of guessing them.

It introduces **no new platform event kinds** and **no new role-result schemas**.
It adds one optional `BuildContext` field, two role-prompt versions, and one
orchestrator-side resolver. V2 sections: 6.4, 6.5.

Packages consume:

- `@platform/llm-boundary` - Prompt Builder, role prompt registry and pins,
  evidence blocks and injection defense (`assertNoInjectionLeaks`).
- `@platform/orchestrator` - composition root, review loop, CLI project-dir
  resolution.

## 1. Goal and Non-Goals

**Goal.** A planner (and frontier, and reviewer) turn whose prompt contains the
actual source of every file the task names, plus a prompt-level rule that turns
an unverified interface assumption into a blocking defect rather than a
revision.

**Non-goals.**

- No repository indexing, embeddings, or semantic retrieval. File selection is
  literal: mentioned in the task, resolvable on disk.
- No agent-side tool use for reading files. Context arrives in the prompt so it
  is captured in the prompt hash and replays deterministically.
- No result-schema change. Citations are enforced by prompt and reviewer
  severity, not by a machine-checked field (Phase 10 adds the structured
  addressal binding).
- No mutation of the target repository.

## 2. Cite-or-Block Role Prompts

source: Phase 5 section 3.2 (versioned role prompts)

The registry is content-hash pinned and versions are immutable. Phase 8 **adds**
entries and repins; it never edits an existing body.

| Role prompt | Old pin | New pin | Added rules |
|---|---|---|---|
| `planner` | `1.0.0` | `1.2.0` | cite-or-block; context guard; structured addressal binding |
| `frontier` | `1.0.0` | `1.1.0` | context guard |

**Cite-or-block (planner).** Before proposing any script, tool, or gate
mechanism that depends on an existing code artifact - DB schema, store method,
event kind, persisted field - the planner must cite the source file and line
number proving the assumed interface exists. Proposing a verifier that reads a
field which does not exist is a blocking-severity defect, not a revision.

**Context guard (planner, frontier).** Only APIs and schemas present in the
`## Codebase Context` block may be used in proposed scripts, gates, or code
changes. Fields and methods may not be invented.

`1.0.0` entries stay registered so turns recorded against the old pin still
resolve their prompt for audit and replay.

## 3. Codebase Context Injection

### 3.1 Boundary surface

`BuildContext` gains one optional field:

```ts
export type CodebaseContextFile = {
  path: string;      // repo-relative, deterministic
  content: string;   // possibly truncated
  bytes: number;     // original size
  truncated: boolean;
};
// BuildContext += codebaseContext?: CodebaseContextFile[]
```

The Prompt Builder renders `## Codebase Context` after `## Task` when the field
is non-empty. Each file is an evidence block keyed by its path, with a trailing
`truncated: true (N bytes omitted)` marker when clipped.

The builder does not decide which turns receive context. It renders what the
caller passes; the review loop decides. This keeps the builder pure and the
policy in one place.

### 3.2 Injection defense

File contents are **untrusted text**. Every file is passed through
`collectUntrusted` and wrapped with `evidenceBlock(sentinel, path, "content",
…)`, so the existing Phase 5 defenses apply unchanged: per-turn sentinel
nonces, delimiter neutralization, and `assertNoInjectionLeaks` rejecting any
untrusted span that escapes an evidence block. A malicious or accidental
`<<<END_EVIDENCE>>>` inside a source file cannot close the block.

### 3.3 Resolution rules (composition root)

A new orchestrator module resolves context; the loop and builder stay
filesystem-free.

```ts
resolveCodebaseContext(input: {
  projectDir: string;
  task: string;
  maxFiles?: number;        // default 12
  maxBytesPerFile?: number; // default 8 KiB
  maxTotalBytes?: number;   // default 48 KiB
}): CodebaseContextFile[]
```

| Step | Rule |
|---|---|
| Mention extraction | Backticked tokens plus bare tokens matching a path-like pattern with an extension. Dedup, preserving first-mention order. |
| Path safety | `resolve(projectDir, mention)`, then `realpath`, then reject unless still inside `projectDir`. Defeats `../` traversal and symlink escape. |
| Exclusions | Directories, `node_modules/`, `.git/`, `dist/`, `runs/`. |
| Bare-name fallback | A mention with no separator (`loop.ts`) is matched against one `git ls-files` listing, exact basename, at most two hits, sorted. No filesystem walk; honors `.gitignore`. |
| Binary skip | A NUL byte in the first 4 KiB rejects the file. |
| Truncation | Head `maxBytesPerFile` bytes per file; stop admitting files at `maxTotalBytes`. |
| Ordering | First-mention order, so the prompt (and therefore the prompt hash) is deterministic for a fixed task and worktree. |

### 3.4 Turn coverage

Context is injected into `planner_propose`, `planner_revise`,
`reviewer_review`, `adversarial_review`, and `frontier_report`. The reviewer
gets it because objection evidence should be checkable against real source, not
recalled API shapes.

Resolution runs once per run (planning does not modify the repo) and the
resulting array is reused for every turn, so all turns of one run see identical
context.

## 4. Configuration Surface

| Setting | Default | Effect |
|---|---|---|
| `PARROT_CONTEXT_MAX_BYTES` | `49152` | Total context budget across files. |
| `PARROT_CONTEXT_MAX_FILES` | `12` | Cap on admitted files. |
| `PARROT_CONTEXT_DISABLE` | unset | `1` skips resolution entirely (no `## Codebase Context` block). |
| `rolePromptPins.planner` | `1.2.0` | Includes the Phase 8 rules and Phase 10 addressal contract. |
| `rolePromptPins.frontier` | `1.1.0` | Repinned by this phase. |

The CLI logs one line per run: `Codebase context: N files, K KB`.

## 5. Test Plan

- Prompt builder: identical `codebaseContext` yields identical content and
  prompt hash; every file appears inside a sentinel-matched evidence block;
  absent field emits no `## Codebase Context` heading.
- Injection: a file containing a forged `<<<END_EVIDENCE>>>` is neutralized and
  the build does not throw a leak assertion.
- Resolver: `../../etc/passwd` and a symlink pointing outside `projectDir` are
  both rejected; `node_modules` paths are skipped; per-file and total byte caps
  hold; binary file skipped; first-mention ordering stable across runs.
- Registry: `planner@1.0.0`, `planner@1.1.0`, and `planner@1.2.0` resolve; pin
  defaults are `1.2.0`.

## 6. Assigned Open Questions

- **Bare-name ambiguity.** Two hits for `config.ts` are both injected today.
  Whether to prefer the shortest path, or to drop ambiguous mentions entirely,
  is deferred until a real run shows which is noisier.
- **Per-role budgets.** All roles currently share one byte budget. A reviewer
  may deserve more context than a frontier summariser; deferred until token
  cost data exists in the ledger.

## 7. Dependencies and Interfaces

**Depends on.**

- Phase 5: Prompt Builder, role prompt registry and pinning, evidence blocks,
  `assertNoInjectionLeaks`, determinism contract.
- Phase 7: composition root and CLI project-directory resolution.

**Provides.**

- A prompt-level guarantee that proposed tooling references real interfaces,
  and the raw material (real source in-prompt) that makes the guarantee
  satisfiable by weak models.
- The precondition for Phase 10: an addressal that cites evidence can cite
  something the planner actually read.
