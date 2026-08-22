# pi-apply-patch-universal

English | [中文文档](README_ZH.md)

Universal, configurable Codex-style `apply_patch` extension for [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono).  
Works seamlessly with Claude, Gemini, DeepSeek, GPT, and custom API relays.

## Features

- **Universal Model Support**: Compatible with all models in `~/.pi/agent/models.json` (Claude, Gemini, DeepSeek, GPT).
- **Zero-Error Prompt Guidelines**: Explicit formatting rules and examples prevent syntax retries.
- **Interactive TUI Configuration**: Manage active providers and models with `/apply-patch`.
- **Native Edit Protection**: Automatically hides and blocks native `edit`/`write` tools when active, and restores them when switching away.
- **Path Sandbox**: Restricts patch operations to the current workspace by default (`allowAbsolutePaths: false`).
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
Run inside Pi:
```text
/apply-patch
```

### 2. Manual Config (`~/.pi/agent/pi-apply-patch.json`)
```json
{
  "providers": ["cliproxy", "openai"],
  "models": ["anthropic/claude-3-7-sonnet"],
  "disableNativeEdit": true,
  "allowAbsolutePaths": false
}
```

| Field | Description | Default |
| :--- | :--- | :--- |
| `providers` | Enable for all models under these provider IDs | `[]` |
| `models` | Enable for specific `provider/model_id` or `model_id` | `[]` |
| `disableNativeEdit` | Hide and block native `edit` & `write` when active | `true` |
| `allowAbsolutePaths` | Allow patches outside working directory | `false` |

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

## Acknowledgements

Built upon and enhanced from **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)**.  
Special thanks to **[@WufeiHalf](https://github.com/WufeiHalf)** for the configurable architecture and interactive TUI settings design.

## License

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
