# pi-apply-patch-universal

[English](README.md) | 简体中文

适用于 [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono) 的通用、高可配置 Codex 风格 `apply_patch` 扩展插件。  
完美适配 Claude、Gemini、DeepSeek、GPT 系列及各类自定义中转 / 聚合网关。

## 特性

- **全模型通用**：支持 `~/.pi/agent/models.json` 中的任意模型（Claude、Gemini、DeepSeek、GPT、通义千问等）。
- **零报错语法引导**：内置清晰的格式规范与示例，杜绝模型首次新建文件漏加 `+` 等语法报错。
- **交互式配置面板**：在终端输入 `/apply-patch` 即可图形化勾选启用的渠道与模型。
- **原生工具智能屏蔽与还原**：激活时可选隐藏并拦截原生 `edit`/`write` 工具；切回未配置模型时自动无缝还原。
- **工作区安全防护**：默认禁止补丁路径逃逸出当前工作区（`allowAbsolutePaths: false`）。
- **标准 JSON 工具协议**：采用标准 JSON 函数调用格式，100% 兼容不支持流式 Lark 语法的各类中转站与代理。

## 安装

```bash
pi install git:github.com/LyraAgent/pi-apply-patch-universal
```

安装后在 Pi 中输入命令重载：
```text
/reload
```

## 配置

### 1. 交互式菜单（推荐）
在 Pi 会话中运行：
```text
/apply-patch
```

### 2. 手动修改配置文件（`~/.pi/agent/pi-apply-patch.json`）
```json
{
  "providers": ["cliproxy", "openai"],
  "models": ["anthropic/claude-3-7-sonnet"],
  "disableNativeEdit": true,
  "allowAbsolutePaths": false
}
```

| 字段 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `providers` | 开启此 Provider 列表下的所有模型 | `[]` |
| `models` | 针对特定模型开启（`provider/model_id` 或 `model_id`） | `[]` |
| `disableNativeEdit` | 激活时隐藏并拦截原生 `edit` 与 `write` | `true` |
| `allowAbsolutePaths` | 是否允许补丁修改当前工作区以外的文件 | `false` |

## 补丁语法规范

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

## 致谢

本项目基于 **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)** 进行优化与增强。  
感谢 **[@WufeiHalf](https://github.com/WufeiHalf)** 提供的可配置架构与交互式 TUI 设置面板设计。

## 开源协议

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
