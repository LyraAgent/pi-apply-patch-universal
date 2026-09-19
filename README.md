# pi-apply-patch-universal

English | [中文文档](README_ZH.md)

Universal, configurable Codex-style `apply_patch` extension for [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono).  
Works seamlessly with Claude, Gemini, DeepSeek, GPT, and custom API relays.

## Features

- **Universal Model Support**: Compatible with all models in `~/.pi/agent/models.json` (Claude, Gemini, DeepSeek, GPT).
- **Compact-Patch Steering**: prompt guidelines instruct the model to keep 2-3 lines of context per hunk, anchor with `@@`, and split large refactorings — eliminating the long-generation gateway timeouts at their source.
- **Grammar-Constrained Sampling**: the official Codex Lark grammar is attached to the tool; providers with OpenAI grammar-tool support decode structurally valid patches, while all other providers are unaffected.
- **Line-Numbered Colored Diff UI**: Rich TUI rendering powered by Pi's native `renderDiff`, displaying colored unified diffs with exact line numbers and per-file `+X -Y` counters.
- **Live Streaming Progress**: Real-time counter preview while the model streams patch arguments, memoized per tool call to stay cheap on long patches.
- **Cancellation-Safe Atomicity**: `AbortSignal` checkpoints run before and between file operations; cancelling mid-apply rolls every modified file back via snapshots, leaving zero on-disk residue.
- **Stream-Truncation Detection**: a patch cut off before `*** End Patch` is reported distinctly (with guidance to split smaller) instead of failing with a confusing hunk error.
- **Per-Line Ending Preservation**: untouched lines keep their exact CRLF/LF/CR terminators — including a missing final newline — so mixed-ending files are never rewritten wholesale; changed lines adopt the file's preferred (first) ending, mirroring Codex's `SourceFile` semantics.
- **EOF Blank-Context Tolerance**: a trailing blank context line standing in for the file's final newline is retried without it, so trailing additions land in the right place.
- **No Silent Relocation**: when quoted context cannot be located, the patch fails with a diagnostic instead of quietly inserting the change somewhere else.
- **Self-Healing Diagnostics**: hunk failures include the closest match with line numbers plus concrete advice, letting the model recover in a single retry.
- **Interactive TUI Configuration**: Manage active providers and models with `/apply-patch`.
- **Native Edit Protection**: Automatically hides and blocks native `edit`/`write` tools when active, and restores them when switching away.
- **Shell Detour Guard**: bash/powershell commands invoking `apply_patch` (heredocs, `applypatch`/`apply-patch` misspellings) are blocked with guidance to use the native tool call.
- **Resilient Arguments**: `input`/`patch`/`diff`/`content` argument keys — and raw strings — are normalized before validation, absorbing per-provider quirks.
- **Path Sandbox**: Restricts patch operations to the current workspace by default (`allowAbsolutePaths: false`), including symlink-escape checks.
- **Forgiving Markers**: Auto-corrects a mis-prefixed `+*** End Patch` so the marker is never written into your file.
- **Tolerant File Headers**: `*** Update File:` and friends are recognized despite indentation, missing/extra spaces, extra asterisks, backticked paths, or a stray diff prefix — so a later file's hunks are never absorbed into the previous file.
- **Drift-Corrected Line Hints**: `@@ -L,N @@` hints from later hunks are rebased by the net size change of earlier hunks in the same file, then verified by content, so multi-hunk patches do not drift.
- **Comment-Tolerant Fallback**: When every strict pass fails, a final pass anchors on real code and tolerates paraphrased or truncated doc comments — but only when the alignment is unique, and it reports any `-` line it could not find instead of skipping it.
- **Standard JSON Tool Calling**: Full compatibility with OpenAI-compatible proxies and aggregators (One-API, New-API, CLIProxy).

## Installation

```bash
pi install git:github.com/LyraAgent/pi-apply-patch-universal
```

Reload Pi after installation:
```text
/reload
```

## Configuration

### 1. Interactive Menu
Inside your Pi session, run:
```text
/apply-patch
```
Use the arrow keys and spacebar to toggle active providers and individual models automatically discovered from `~/.pi/agent/models.json`.

### 2. Configuration File (`~/.pi/agent/pi-apply-patch.json`)
Settings are persisted in `~/.pi/agent/pi-apply-patch.json`. You can also create or edit it manually:

```json
{
  "providers": ["cliproxy", "openai"],
  "models": ["anthropic/claude-3-7-sonnet"],
  "disableNativeEdit": true,
  "allowAbsolutePaths": false,
  "addFileOnExisting": "overwrite",
  "moveOnExisting": "error"
}
```

#### Field Details

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `providers` | `string[]` | `[]` | **Provider-level matching**. All models under the specified provider IDs (e.g., `"cliproxy"`, `"openai"`, `"aio"`) will automatically activate `apply_patch`. |
| `models` | `string[]` | `[]` | **Model-level granular matching**. Enables `apply_patch` for specific models. Accepts full reference `provider/model_id` (e.g., `"openai/gpt-4o"`), bare `model_id`, or `provider:model_id`. Useful for enabling patch mode only on top-tier coding models while keeping others on standard tools. |
| `disableNativeEdit` | `boolean` | `true` | **Tool exclusivity policy**. When `true`, hides and blocks built-in `edit` and `write` tools whenever `apply_patch` is active, compelling the LLM to use token-efficient diff patches and avoiding accidental full-file rewrites. Switching to non-target models automatically restores native tools. Set to `false` to keep all tools available concurrently. |
| `allowAbsolutePaths` | `boolean` | `false` | **Path traversal sandbox**. When `false` (recommended), strictly restricts all patch operations within the current working directory (`cwd`) to prevent accidental edits outside your project root. Set to `true` only if you explicitly need cross-directory patch operations. |
| `addFileOnExisting` | `"overwrite" \| "error"` | `"overwrite"` | **Add File collision policy**. `"overwrite"` lets `*** Add File:` replace a file that already exists (common when a previous run left a half-written file behind); the resulting diff shows the replaced lines and rollback restores the original content if a later action in the same patch fails. `"error"` restores the strict Codex behavior and fails with guidance to use `*** Update File:` or `*** Delete File:` instead. |
| `moveOnExisting` | `"error" \| "overwrite"` | `"error"` | **Move destination collision policy**. `"error"` refuses a `*** Move to:` whose destination already exists. `"overwrite"` replaces the destination file, matching upstream Codex semantics; directories still fail rather than being recursively removed. |

#### Activation Logic
- A model is **active** if it matches any entry in `models` **OR** its provider is in `providers`.
- If both `providers` and `models` are empty `[]`, the extension remains completely inactive (safe default).

## Patch Syntax

```text
*** Begin Patch
*** Add File: src/hello.py
+def greet(name: str) -> str:
+    return f"Hello, {name}!"
*** Update File: src/main.py
@@ def main():
-    print("old")
+    print(greet("world"))
*** Delete File: obsolete.txt
*** End Patch
```

`*** Begin Patch` and `*** End Patch` must stand alone on their own lines. A stray diff prefix (`+*** End Patch`) is auto-corrected instead of being written into the target file, but only when no correctly formatted end marker is present — file bodies that legitimately contain the marker text are preserved.

### Matching behavior

Hunks are located by content, not by trusting line numbers. `@@ -L,N +L,N @@` is treated as a hint: it is rebased by the net line change of earlier hunks in the same file, searched outward from there, and then falls back to a full-file scan. A hunk that only matches after ignoring comment differences is applied only when that alignment is unique in the file; comment lines the patch omitted are preserved, and a `-` line that cannot be found is reported rather than silently skipped.

Line endings are preserved per line: untouched lines keep their exact terminators (including a missing final newline), while changed and inserted lines use the file's preferred (first) ending, and a changed final line always receives a terminator — matching Codex's behavior.

A patch is atomic: if any operation fails, every earlier operation is rolled back and the error lists which ones were reverted, so you can resend them unchanged and rework only the failing file. Cancelling the agent mid-apply is equally safe — snapshots restore everything the patch had already touched.

## Acknowledgements

Built upon and enhanced from **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)** and **[matsuzaka-yuki/pi-apply-patch-plus](https://github.com/matsuzaka-yuki/pi-apply-patch-plus)**.  
Special thanks to **[@WufeiHalf](https://github.com/WufeiHalf)** for the configurable architecture and interactive TUI settings design.

## License

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
