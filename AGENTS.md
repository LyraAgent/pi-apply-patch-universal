# AGENTS.md — pi-apply-patch-universal

Conventions and architecture for developers and AI agents working on this repository.

## Architecture

- `src/index.ts`: Extension entry point, registers `apply_patch` tool, `/apply-patch` command, tool policy enforcement, and `tool_call` gating.
- `src/config.ts`: Configuration loading/saving (`~/.pi/agent/pi-apply-patch.json`), `models.json` catalog loading, and target model matching.
- `src/patch.ts`: Standalone Codex patch parser, hunk applicator, line-numbered diff generator, rollback mechanism, and path validation.
- `src/progress.ts`: Best-effort streaming parser for live tool call argument progress.
- `src/settings-ui.ts`: Interactive TUI selection dialog for `/apply-patch`.

## Core Philosophy

1. **Lightweight & Reversible**: Single tool, zero prompt pollution, clean tool restoration on model switch.
2. **Universal Compatibility**: Standard JSON function calling schema, zero reliance on non-standard stream hijacking.
3. **Safety by Default**: Prevent CWD escape, rollback on partial failures.
