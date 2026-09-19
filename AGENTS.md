# AGENTS.md — pi-apply-patch-universal

Conventions and architecture for developers and AI agents working on this repository.

## Architecture

- `src/index.ts`: Extension entry point — tool registration, `/apply-patch` command, tool policy enforcement, and `tool_call` gating. Pure assembly; rendering and engine logic live elsewhere.
- `src/render.ts`: TUI renderers for the apply_patch tool (streaming call preview, collapsed counters, expanded diff).
- `src/config.ts`: Configuration loading/saving (`~/.pi/agent/pi-apply-patch.json`), `models.json` catalog loading, and target model matching.
- `src/progress.ts`: Best-effort streaming parser for live tool call argument progress.
- `src/settings-ui.ts`: Interactive TUI selection dialog for `/apply-patch`.
- `src/patch/`: Standalone Codex patch engine (no Pi dependencies — unit-testable in isolation):
  - `types.ts` shared type definitions
  - `args.ts` LLM tool-argument normalization (`input`/`patch`/`diff`/`content`)
  - `parse.ts` patch envelope parsing (markers, tolerant file headers, hunks)
  - `paths.ts` target path resolution and cwd/symlink escape safety
  - `line-endings.ts` line-ending detection/normalization/restoration
  - `candidates.ts` line normalization + hunk candidate generation (incl. EOF blank-context stripping)
  - `diagnostics.ts` self-healing hunk failure diagnostics
  - `match.ts` hunk matching engine (fuzz levels, loose anchor alignment)
  - `diff.ts` numbered diff generation
  - `apply.ts` atomic applyPatch orchestration with snapshot rollback
  - `index.ts` public API barrel

Relative imports use explicit `.ts` extensions so `node --test` resolves them without a build step.

## Core Philosophy

1. **Lightweight & Reversible**: Single tool, zero prompt pollution, clean tool restoration on model switch.
2. **Universal Compatibility**: Standard JSON function calling schema, zero reliance on non-standard stream hijacking.
3. **Safety by Default**: Prevent CWD escape, rollback on partial failures.
