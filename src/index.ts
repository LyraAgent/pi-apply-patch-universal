/**
 * Lightweight configurable apply_patch for Pi.
 *
 * - /apply-patch  open config panel (writes ~/.pi/agent/pi-apply-patch.json)
 * - On matched provider/model: enable apply_patch, optionally hide edit/write
 * - Off match: hide apply_patch, restore edit/write if this extension removed them
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isTargetModel, loadConfig } from "./config.js";
import {
	applyPatch,
	type ApplyPatchFileDiff,
	type ApplyPatchProgress,
	type ApplyPatchResult,
} from "./patch.js";
import { parseApplyPatchInputProgress } from "./progress.js";
import { openApplyPatchSettings } from "./settings-ui.js";

const NATIVE_EDIT_TOOLS = ["edit", "write"] as const;

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description:
			"Complete Codex-style patch text from '*** Begin Patch' through '*** End Patch'. Use '*** Add File:', '*** Update File:', or '*** Delete File:' headers. In Add File, prefix every content line (including blank lines) with '+'. In Update File hunks, prefix unchanged, removed, and added lines with ' ', '-', and '+' respectively.",
	}),
});

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface ApplyPatchRenderFile {
	path: string;
	moveTo?: string;
	operation: "add" | "delete" | "update";
	added: number;
	removed: number;
	done?: boolean;
}

function operationCode(operation: "add" | "delete" | "update"): "A" | "D" | "U" {
	if (operation === "add") return "A";
	if (operation === "delete") return "D";
	return "U";
}

function formatTarget(file: Pick<ApplyPatchRenderFile, "path" | "moveTo">): string {
	return file.moveTo ? `${file.path} -> ${file.moveTo}` : file.path;
}

function formatCounterLine(
	theme: ThemeLike,
	file: ApplyPatchRenderFile,
	options?: { currentFile?: string; showDone?: boolean; includePath?: boolean },
): string {
	const includePath = options?.includePath ?? true;
	let line = `${theme.fg("toolDiffAdded", `+${file.added}`)} ${theme.fg("toolDiffRemoved", `-${file.removed}`)} ${theme.fg("warning", operationCode(file.operation))}`;
	if (includePath) {
		line += ` ${theme.fg("accent", formatTarget(file))}`;
	}
	if (options?.showDone && file.done) {
		line += theme.fg("muted", " ✓");
	} else if (options?.currentFile && options.currentFile === file.path) {
		line += theme.fg("warning", " ← applying");
	}
	return line;
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export default function piApplyPatch(pi: ExtensionAPI) {
	const removedNative = new Set<string>();

	const enforce = (ctx: ExtensionContext) => {
		const config = loadConfig();
		const active = isTargetModel(ctx.model, config);
		const current = pi.getActiveTools();
		const available = new Set(pi.getAllTools().map((t) => t.name));
		const next = current.filter((name) => {
			if (name === "apply_patch") return active;
			if (active && config.disableNativeEdit && (NATIVE_EDIT_TOOLS as readonly string[]).includes(name)) {
				removedNative.add(name);
				return false;
			}
			return true;
		});

		if (active && available.has("apply_patch") && !next.includes("apply_patch")) {
			next.push("apply_patch");
		}

		if (!active && removedNative.size > 0) {
			for (const name of removedNative) {
				if (available.has(name) && !next.includes(name)) next.push(name);
			}
			removedNative.clear();
		}

		// When active and disableNativeEdit flips off, put edit/write back if we hold them
		if (active && !config.disableNativeEdit && removedNative.size > 0) {
			for (const name of removedNative) {
				if (available.has(name) && !next.includes(name)) next.push(name);
			}
			removedNative.clear();
		}

		if (!arraysEqual(current, next)) pi.setActiveTools(next);
	};

	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description:
			"Apply one atomic Codex-style patch across multiple files. Paths are relative to the current working directory unless absolute paths are enabled.\n\nFormat:\n- Wrap all operations in '*** Begin Patch' and '*** End Patch'.\n- Add: '*** Add File: <path>'; prefix every content line, including blank lines, with '+'.\n- Update: '*** Update File: <path>'; use one or more '@@' hunks with space-prefixed context, '-' removals, and '+' additions. '@@ <existing line>' narrows the hunk search to after that line; standard '@@ -L,N +L,N @@' ranges are also accepted.\n- Move: place '*** Move to: <new path>' immediately after an Update File header.\n- Delete: '*** Delete File: <path>' with no body.\n- Optional '*** End of File' makes the preceding hunk prefer the file end.\n- Do not target one path more than once. Add and Move destinations must not already exist.\n\nExample:\n*** Begin Patch\n*** Add File: src/new.py\n+def hello():\n+    print('hello')\n*** Update File: src/main.py\n@@ def run():\n-    old()\n+    hello()\n*** Delete File: obsolete.py\n*** End Patch",
		parameters: APPLY_PATCH_PARAMS,
		renderCall(args, theme) {
			const input = typeof args?.input === "string" ? args.input : "";
			const progress = parseApplyPatchInputProgress(input);

			let text = theme.fg("toolTitle", theme.bold("apply_patch"));
			if (progress.totalOperations > 0) {
				text += theme.fg(
					"muted",
					` (${progress.totalOperations} file${progress.totalOperations === 1 ? "" : "s"})`,
				);
			}
			if (progress.files.length > 0) {
				text += `\n${progress.files.map((file) => formatCounterLine(theme, file, { includePath: true })).join("\n")}`;
			}

			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ApplyPatchResult | ApplyPatchProgress | undefined;
			const textBlock = result.content.find((block) => block.type === "text");
			const baseText = textBlock?.type === "text" ? textBlock.text : "";

			if (isPartial) {
				if (expanded && details?.diff && details.diff.length > 0) {
					return new Text(renderDiff(details.diff), 0, 0);
				}

				if (!expanded && details?.stage === "apply_progress" && Array.isArray(details.files)) {
					if (details.files.length > 0) {
						const count = details.totalOperations ?? details.files.length;
						const title = `${theme.fg("toolTitle", theme.bold("apply_patch"))}${theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`)}`;
						const lines = details.files
							.map((file) => formatCounterLine(theme, file, { includePath: true }))
							.join("\n");
						return new Text(`${title}\n${lines}`, 0, 0);
					}
					const total = details.totalOperations ?? details.files.length;
					const done = details.completedOperations ?? 0;
					return new Text(theme.fg("warning", `Applying patch ${done}/${total}...`), 0, 0);
				}

				return new Text(theme.fg("warning", baseText || "Applying patch..."), 0, 0);
			}

			if (details?.diff && details.diff.length > 0) {
				if (expanded) {
					return new Text(renderDiff(details.diff), 0, 0);
				}
				if (Array.isArray(details.fileDiffs) && details.fileDiffs.length > 0) {
					const count = details.fileDiffs.length;
					const title = `${theme.fg("toolTitle", theme.bold("apply_patch"))}${theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`)}`;
					const lines = details.fileDiffs
						.map((file) => formatCounterLine(theme, file, { includePath: true }))
						.join("\n");
					return new Text(`${title}\n${lines}`, 0, 0);
				}
			}

			return new Text(baseText, 0, 0);
		},
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const config = loadConfig();
			if (!isTargetModel(ctx.model, config)) {
				throw new Error(
					"apply_patch is disabled for this model. Run /apply-patch to configure targets.",
				);
			}

			onUpdate?.({
				content: [{ type: "text" as const, text: "Validating apply_patch payload..." }],
				details: { stage: "validate" },
			});

			const result = await applyPatch(
				params.input,
				{
					cwd: ctx.cwd,
					allowAbsolutePaths: config.allowAbsolutePaths,
				},
				(progress) => {
					onUpdate?.({
						content: [
							{
								type: "text" as const,
								text: `Applying patch ${progress.completedOperations}/${progress.totalOperations}...`,
							},
						],
						details: progress,
					});
				},
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `${result.summary}\nFiles: ${result.files.join(", ")}`,
					},
				],
				details: result,
			};
		},
	});

	pi.registerCommand("apply-patch", {
		description: "Configure apply_patch targets (providers/models from models.json)",
		handler: async (_args, ctx) => {
			await openApplyPatchSettings(ctx, () => enforce(ctx));
			enforce(ctx);
		},
	});

	pi.on("session_start", (_e, ctx) => enforce(ctx));
	pi.on("session_switch", (_e, ctx) => enforce(ctx));
	pi.on("session_fork", (_e, ctx) => enforce(ctx));
	pi.on("model_select", (_e, ctx) => enforce(ctx));
	pi.on("before_agent_start", (_e, ctx) => {
		enforce(ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		const config = loadConfig();
		const active = isTargetModel(ctx.model, config);

		if (event.toolName === "apply_patch" && !active) {
			return {
				block: true,
				reason: "apply_patch only enabled for configured providers/models. Run /apply-patch.",
			};
		}

		if (
			active &&
			config.disableNativeEdit &&
			(event.toolName === "edit" || event.toolName === "write")
		) {
			return {
				block: true,
				reason: "Native edit/write disabled on this model. Use apply_patch.",
			};
		}
	});
}
