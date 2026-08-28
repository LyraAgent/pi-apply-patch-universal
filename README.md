# pi-apply-patch-universal

English | [中文文档](README_ZH.md)

Universal, configurable Codex-style `apply_patch` extension for [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono).  
Works seamlessly with Claude, Gemini, DeepSeek, GPT, and custom API relays.

## Features

- **Universal Model Support**: Compatible with all models in `~/.pi/agent/models.json` (Claude, Gemini, DeepSeek, GPT).
- **Line-Numbered Colored Diff UI**: Rich TUI rendering powered by Pi's native `renderDiff`, displaying colored unified diffs with exact line numbers and per-file `+X -Y` counters.
- **Live Streaming Progress**: Real-time counter preview while the model streams patch arguments.
- **Zero-Error Prompt Guidelines**: Explicit formatting rules and examples prevent syntax retries.
- **Interactive TUI Configuration**: Manage active providers and models with `/apply-patch`.
- **Native Edit Protection**: Automatically hides and blocks native `edit`/`write` tools when active, and restores them when switching away.
- **Path Sandbox**: Restricts patch operations to the current workspace by default (`allowAbsolutePaths: false`).
- **Forgiving Markers**: Auto-corrects a mis-prefixed `+*** End Patch` so the marker is never written into your file.
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
  "addFileOnExisting": "overwrite"
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

## Acknowledgements

Built upon and enhanced from **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)** and **[matsuzaka-yuki/pi-apply-patch-plus](https://github.com/matsuzaka-yuki/pi-apply-patch-plus)**.  
Special thanks to **[@WufeiHalf](https://github.com/WufeiHalf)** for the configurable architecture and interactive TUI settings design.

## License

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
