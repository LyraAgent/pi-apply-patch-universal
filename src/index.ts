/**
 * Lightweight configurable apply_patch for Pi.
 *
 * - /apply-patch  open config panel (writes ~/.pi/agent/pi-apply-patch.json)
 * - On matched provider/model: enable apply_patch, optionally hide edit/write
 * - Off match: hide apply_patch, restore edit/write if this extension removed them
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTargetModel, loadConfig } from "./config.ts";
import { APPLY_PATCH_CONSTRAINED_SAMPLING } from "./grammar.ts";
import { assessToolCall } from "./gate.ts";
import { applyPatch, prepareApplyPatchArguments } from "./patch/index.ts";
import { renderApplyPatchCall, renderApplyPatchResult } from "./render.ts";
import { openApplyPatchSettings } from "./settings-ui.ts";

const NATIVE_EDIT_TOOLS = ["edit", "write"] as const;

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description:
			"Complete Codex-style patch text from '*** Begin Patch' through '*** End Patch'. Use '*** Add File:', '*** Update File:', or '*** Delete File:' headers. In Add File, prefix every content line (including blank lines) with '+'. In Update File hunks, prefix unchanged, removed, and added lines with ' ', '-', and '+' respectively. '*** End Patch' must stand alone on its own line with no '+' or '-' prefix.",
	}),
});

const APPLY_PATCH_DESCRIPTION = [
	"Apply one atomic Codex-style patch across multiple files. Paths are relative to the current working directory unless absolute paths are enabled.",
	"",
	"Key rules:",
	"- Keep context minimal: include only 2-3 lines of unchanged context around changes. Do not quote large blocks of unchanged code.",
	"- Wrap all operations in '*** Begin Patch' and '*** End Patch' standing alone on their own line without '+' or '-' prefixes.",
	"- Add: '*** Add File: <path>'; prefix every content line, including blank lines, with '+'. By default an existing file at that path is overwritten; configure addFileOnExisting to make it an error instead.",
	"- Update: '*** Update File: <path>'; use one or more '@@' hunks with space-prefixed context, '-' removals, and '+' additions. '@@ <existing line>' narrows the hunk search to after that line; standard '@@ -L,N +L,N @@' ranges are also accepted.",
	"- Move: place '*** Move to: <new path>' immediately after an Update File header. Move destinations must not already exist unless moveOnExisting is set to 'overwrite'.",
	"- Delete: '*** Delete File: <path>' with no body.",
	"- Optional '*** End of File' makes the preceding hunk prefer the file end.",
	"- Do not target one path more than once.",
	"- For large multi-file changes, split work into focused, smaller patches to prevent generation timeouts.",
	"",
	"Example:",
	"*** Begin Patch",
	"*** Add File: src/new.py",
	"+def hello():",
	"+    print('hello')",
	"*** Update File: src/main.py",
	"@@ def run():",
	"-    old()",
	"+    hello()",
	"*** Delete File: obsolete.py",
	"*** End Patch",
].join("\n");

const APPLY_PATCH_PROMPT_GUIDELINES = [
	"When using apply_patch, keep context hunks minimal: include only 2-3 lines of unchanged context before and after changes. Avoid quoting large unchanged code blocks to prevent stream timeouts.",
	"Use '@@ <unique context line>' or line-number headers (e.g. '@@ -L,N +L,N @@') to locate hunks instead of repeating extensive surrounding context.",
	"For extensive multi-file changes or large refactorings, emit separate focused patches per file or logical change to prevent generation timeouts.",
	"Ensure '*** Begin Patch' and '*** End Patch' are standalone on their own lines without diff prefixes.",
	"Do not waste tokens re-reading files after calling apply_patch on them: the tool call fails loudly if it did not work.",
	"Only use the exact tool name 'apply_patch'. Never try 'applypatch' or 'apply-patch', and never route patches through the shell.",
];

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
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: "apply_patch: Apply atomic Codex-style unified patches across files",
		promptGuidelines: APPLY_PATCH_PROMPT_GUIDELINES,
		parameters: APPLY_PATCH_PARAMS,
		constrainedSampling: APPLY_PATCH_CONSTRAINED_SAMPLING,
		executionMode: "sequential",
		prepareArguments: prepareApplyPatchArguments,
		renderCall: renderApplyPatchCall,
		renderResult: renderApplyPatchResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
					addFileOnExisting: config.addFileOnExisting,
					moveOnExisting: config.moveOnExisting,
					signal,
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
		return assessToolCall(event, isTargetModel(ctx.model, config), config);
	});
}
