# pi-apply-patch-universal

[English](README.md) | 简体中文

适用于 [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono) 的通用、高可配置 Codex 风格 `apply_patch` 扩展插件。  
完美适配 Claude、Gemini、DeepSeek、GPT 系列及各类自定义中转 / 聚合网关。

## 特性

- **全模型通用**：支持 `~/.pi/agent/models.json` 中的任意模型（Claude、Gemini、DeepSeek、GPT、通义千问等）。
- **彩色行号 Diff 渲染与实时进度**：深度集成 Pi 原生 `renderDiff`，在终端中展示带有精确行号与词级高亮的彩色 Diff 补丁，折叠状态下直观展示逐文件 `+X -Y` 增减计数。
- **流式参数实时解析**：在模型生成工具调用参数时即时解析并展示文件变动进度。
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
通过上下方向键和空格键，快速勾选从 `~/.pi/agent/models.json` 自动读取的渠道和模型列表。

### 2. 配置文件说明（`~/.pi/agent/pi-apply-patch.json`）
菜单设置会自动保存至 `~/.pi/agent/pi-apply-patch.json`，你也可以直接手动编辑此文件：

```json
{
  "providers": ["cliproxy", "openai"],
  "models": ["anthropic/claude-3-7-sonnet"],
  "disableNativeEdit": true,
  "allowAbsolutePaths": false
}
```

#### 字段详解

| 字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `providers` | `string[]` | `[]` | **按渠道批量开启**。只要模型归属于列表中的 Provider ID（例如 `"cliproxy"`、`"openai"`、`"aio"` 等），该渠道下的所有模型都会自动启用 `apply_patch`。 |
| `models` | `string[]` | `[]` | **按模型精准开启**。针对特定高智商模型单独启用。支持 `provider/model_id`（如 `"cliproxy/claude-sonnet-4-6"`）、裸 `model_id` 或 `provider:model_id` 格式。适合在同一渠道下仅给强力代码模型开启补丁能力。 |
| `disableNativeEdit` | `boolean` | `true` | **原生工具智能屏蔽与保护**。为 `true` 时，在当前模型激活 `apply_patch` 期间，自动隐藏并拦截原生的 `edit` 和 `write` 工具，强迫大模型统一使用极省 Token 的局部增量 Diff，彻底杜绝模型偷懒全文件重写；切回未配置模型时自动无缝还原。设为 `false` 则三者共存。 |
| `allowAbsolutePaths` | `boolean` | `false` | **工作区路径沙箱防护**。为 `false`（推荐）时，所有补丁操作严格限制在当前工作区目录（`cwd`）内部，防止大模型因相对路径逃逸或绝对路径误改系统敏感文件。仅在确需跨目录修改项目外文件时设为 `true`。 |

#### 匹配规则
- **激活条件（或关系）**：当前模型的 Provider 命中 `providers` 列表，**或** 模型 ID 命中 `models` 列表。
- **安全默认**：当 `providers` 与 `models` 均为空数组 `[]` 时，扩展处于完全休眠状态，不影响任何默认工具。

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

本项目基于 **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)** 与 **[matsuzaka-yuki/pi-apply-patch-plus](https://github.com/matsuzaka-yuki/pi-apply-patch-plus)** 进行优化与增强。  
感谢 **[@WufeiHalf](https://github.com/WufeiHalf)** 提供的可配置架构与交互式 TUI 设置面板设计。

## 开源协议

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
