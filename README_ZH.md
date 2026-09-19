# pi-apply-patch-universal

[English](README.md) | 简体中文

适用于 [Pi (pi-coding-agent)](https://github.com/badlogic/pi-mono) 的通用、高可配置 Codex 风格 `apply_patch` 扩展插件。  
完美适配 Claude、Gemini、DeepSeek、GPT 系列及各类自定义中转 / 聚合网关。

## 特性

- **全模型通用**：支持 `~/.pi/agent/models.json` 中的任意模型（Claude、Gemini、DeepSeek、GPT、通义千问等）。
- **紧凑补丁引导**：通过 prompt 守则指导模型每个 Hunk 只保留 2-3 行上下文、用 `@@` 锚点定位、大改动拆分提交——从源头消灭长生成导致的网关超时。
- **语法约束采样**：内置 Codex 官方 Lark 语法；支持 OpenAI 语法约束工具的后端直接解码出结构合法的补丁，其余后端不受影响。
- **彩色行号 Diff 渲染与实时进度**：深度集成 Pi 原生 `renderDiff`，在终端中展示带有精确行号与词级高亮的彩色 Diff 补丁，折叠状态下直观展示逐文件 `+X -Y` 增减计数。
- **流式参数实时解析**：在模型生成工具调用参数时即时解析并展示文件变动进度，按工具调用记忆化，长补丁高频渲染零额外开销。
- **可取消的原子安全**：执行前与每个文件操作间设置 `AbortSignal` 检查点；中途取消即通过快照回滚所有已修改文件，磁盘零残留。
- **流式截断检测**：输出在 `*** End Patch` 之前被截断的补丁会被单独识别并给出"拆小重发"指引，而不是抛出令人困惑的 Hunk 匹配错误。
- **逐行行尾保留**：未触碰的行逐字节保留原始 CRLF/LF/CR 行尾（含缺失的末尾换行），混合行尾文件绝不被整体重写；修改/插入行采用文件首选（首个）行尾，与 Codex `SourceFile` 语义一致。
- **EOF 空上下文容错**：补丁末尾代表文件结束换行的空上下文行会被自动剥离重试，尾部新增内容精准落位。
- **拒绝静默重定位**：引用的上下文无法定位时直接报诊断错误，而不是把改动悄悄插到别处。
- **自愈式诊断**：Hunk 失败信息附带最接近匹配的行号与可执行建议，模型一轮即可自纠。
- **交互式配置面板**：在终端输入 `/apply-patch` 即可图形化勾选启用的渠道与模型。
- **原生工具智能屏蔽与还原**：激活时可选隐藏并拦截原生 `edit`/`write` 工具；切回未配置模型时自动无缝还原。
- **Shell 绕路拦截**：通过 bash/powershell 调用 `apply_patch`（heredoc、`applypatch`/`apply-patch` 等误拼）会被拦截并引导直接使用原生工具调用。
- **参数弹性规整**：`input`/`patch`/`diff`/`content` 参数键与裸字符串在校验前统一归一化，吸收各渠道的差异。
- **工作区安全防护**：默认禁止补丁路径逃逸出当前工作区（`allowAbsolutePaths: false`），含符号链接逃逸检查。
- **标记容错**：误写成 `+*** End Patch` 时自动纠正，绝不会把结束标记当成正文写进目标文件。
- **文件头容错状态机**：`*** Update File:` 等文件头在带缩进、空格多余或缺失、星号超过三个、路径包反引号、误带 diff 前缀的情况下仍能识别，避免后一个文件的 Hunk 被归类到前一个文件。
- **多 Hunk 行号漂移校准**：同一文件内后续 Hunk 的 `@@ -L,N @@` 行号会自动叠加之前 Hunk 的净增减量，再由内容比对确认，不再越往后越容易落空。
- **注释容错兼容层**：所有严格匹配失败后，最后一轮以真实代码行为锚点，容忍注释被改写或截断；仅当定位唯一时才应用，且找不到的 `-` 行会明确报告而不是静默跳过。
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
  "allowAbsolutePaths": false,
  "addFileOnExisting": "overwrite",
  "moveOnExisting": "error"
}
```

#### 字段详解

| 字段 | 类型 | 默认值 | 详细说明 |
| :--- | :--- | :--- | :--- |
| `providers` | `string[]` | `[]` | **按渠道批量开启**。只要模型归属于列表中的 Provider ID（例如 `"cliproxy"`、`"openai"`、`"aio"` 等），该渠道下的所有模型都会自动启用 `apply_patch`。 |
| `models` | `string[]` | `[]` | **按模型精准开启**。针对特定高智商模型单独启用。支持 `provider/model_id`（如 `"cliproxy/claude-sonnet-4-6"`）、裸 `model_id` 或 `provider:model_id` 格式。适合在同一渠道下仅给强力代码模型开启补丁能力。 |
| `disableNativeEdit` | `boolean` | `true` | **原生工具智能屏蔽与保护**。为 `true` 时，在当前模型激活 `apply_patch` 期间，自动隐藏并拦截原生的 `edit` 和 `write` 工具，强迫大模型统一使用极省 Token 的局部增量 Diff，彻底杜绝模型偷懒全文件重写；切回未配置模型时自动无缝还原。设为 `false` 则三者共存。 |
| `allowAbsolutePaths` | `boolean` | `false` | **工作区路径沙箱防护**。为 `false`（推荐）时，所有补丁操作严格限制在当前工作区目录（`cwd`）内部，防止大模型因相对路径逃逸或绝对路径误改系统敏感文件。仅在确需跨目录修改项目外文件时设为 `true`。 |
| `addFileOnExisting` | `"overwrite" \| "error"` | `"overwrite"` | **新增文件冲突策略**。为 `"overwrite"` 时，`*** Add File:` 允许覆盖已存在的同名文件（常见于上一次运行留下的半截文件）；覆盖会在 diff 中如实展示被替换的行，且同一补丁中后续操作失败时会回滚还原原始内容。设为 `"error"` 则恢复 Codex 严格行为，报错并提示改用 `*** Update File:` 或 `*** Delete File:`。 |
| `moveOnExisting` | `"error" \| "overwrite"` | `"error"` | **Move 目标冲突策略**。`"error"` 拒绝移动到已存在的目标路径；`"overwrite"` 覆盖目标文件（对齐 Codex 官方语义），目录目标仍会报错而不会被递归删除。 |

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

`*** Begin Patch` 与 `*** End Patch` 必须独占一行。若误写成带前缀的 `+*** End Patch`，解析器会自动纠正，而不会把该行写进目标文件；仅当补丁中不存在格式正确的结束标记时才启用该纠错，因此正文中确实包含该标记文本的文件不会被误伤。

### 匹配策略

Hunk 定位以内容为准，不盲信行号。`@@ -L,N +L,N @@` 仅作为提示：先按同文件内已应用 Hunk 的净增减量重定基准，再从该位置向两侧扩散搜索，最后退化为全文滑窗扫描。只有忽略注释差异才能匹配的 Hunk，仅在全文定位唯一时才会应用；补丁未引用的注释行会原样保留，而找不到的 `-` 行会报错而非静默跳过。

行尾逐行保留：未触碰的行保持其原始终止符（含缺失的末尾换行），修改与插入行采用文件首选（首个）行尾，被修改的末行总是补上终止符——与 Codex 行为一致。

补丁是原子的：任一操作失败则全部回滚，错误信息会列出被回滚的成功操作，方便原样重发这些文件、只修正失败的那一个。生成中途取消同样安全——快照会还原补丁已触碰的一切。

## 致谢

本项目基于 **[WufeiHalf/pi-apply_patch](https://github.com/WufeiHalf/pi-apply_patch)** 与 **[matsuzaka-yuki/pi-apply-patch-plus](https://github.com/matsuzaka-yuki/pi-apply-patch-plus)** 进行优化与增强。  
感谢 **[@WufeiHalf](https://github.com/WufeiHalf)** 提供的可配置架构与交互式 TUI 设置面板设计。

## 开源协议

[MIT License](LICENSE) © 2026 LyraAgent, WufeiHalf
