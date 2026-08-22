/**
 * Lightweight configurable apply_patch for Pi.
 *
 * - /apply-patch  open config panel (writes ~/.pi/agent/pi-apply-patch.json)
 * - On matched provider/model: enable apply_patch, optionally hide edit/write
 * - Off match: hide apply_patch, restore edit/write if this extension removed them
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTargetModel, loadConfig } from "./config.js";
import { applyPatch } from "./patch.js";
import { openApplyPatchSettings } from "./settings-ui.js";

const NATIVE_EDIT_TOOLS = ["edit", "write"] as const;

const APPLY_PATCH_PARAMS = Type.Object({
	input: Type.String({
		description:
			"The entire contents of the apply_patch command beginning with '*** Begin Patch' and ending with '*** End Patch'. Every line in '*** Add File: <path>' MUST start with '+'. In '*** Update File: <path>', use '@@' context blocks, ' ' for unchanged context, '-' for deletions, and '+' for additions.",
	}),
});

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
			"Apply a Codex-style multi-file patch to create, modify, or delete files. Input must start with '*** Begin Patch' and end with '*** End Patch'.\n\nRules:\n- Add File: each line of content MUST begin with '+' (e.g. +code)\n- Update File: use @@ context markers, ' ' for unchanged lines, '-' for deletions, '+' for additions\n- Delete File: *** Delete File: <path>\n- Move/Rename: *** Update File: <old> followed by *** Move to: <new>\n\nExample:\n*** Begin Patch\n*** Add File: src/new.py\n+def hello():\n+    print('hello')\n*** Update File: src/main.py\n@@ def run():\n-    old()\n+    hello()\n*** Delete File: obsolete.py\n*** End Patch",
		parameters: APPLY_PATCH_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig();
			if (!isTargetModel(ctx.model, config)) {
				throw new Error(
					"apply_patch is disabled for this model. Run /apply-patch to configure targets.",
				);
			}
			const result = await applyPatch(params.input, {
				cwd: ctx.cwd,
				allowAbsolutePaths: config.allowAbsolutePaths,
			});
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
