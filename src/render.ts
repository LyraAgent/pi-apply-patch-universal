/**
 * TUI rendering for the apply_patch tool: call preview with streaming progress,
 * and result rendering with collapsed counters / expanded diff views.
 */
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { operationCode, prepareApplyPatchArguments } from "./patch/index.ts";
import type {
	ApplyPatchFileDiff,
	ApplyPatchProgress,
	ApplyPatchResult,
} from "./patch/index.ts";
import { parseApplyPatchInputProgress } from "./progress.ts";

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

/**
 * Memoized streaming progress: parse the partial input only when it actually
 * grew for this tool call. Mirrors Codex's throttled argument-diff events
 * (500ms buffer) without touching the TUI layer.
 */
const progressCache = new Map<
	string,
	{ len: number; progress: ReturnType<typeof parseApplyPatchInputProgress> }
>();

function getInputProgress(toolCallId: string, input: string) {
	const cached = progressCache.get(toolCallId);
	if (cached && cached.len === input.length) return cached.progress;
	const progress = parseApplyPatchInputProgress(input);
	if (progressCache.size > 16) progressCache.clear();
	progressCache.set(toolCallId, { len: input.length, progress });
	return progress;
}

/** Streaming call preview: file counters parsed from the partial input. */
export function renderApplyPatchCall(
	args: unknown,
	theme: ThemeLike,
	context?: { toolCallId?: string },
): Text {
	// Streaming args may not be schema-shaped yet (or may use a sibling key
	// like `patch`); normalize defensively for display only.
	const input = prepareApplyPatchArguments(args).input;
	const progress = getInputProgress(context?.toolCallId ?? "_", input);

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
}

/** Result rendering: collapsed per-file counters, or the full diff when expanded. */
export function renderApplyPatchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: ThemeLike,
): Text {
	const details = result.details as ApplyPatchResult | ApplyPatchProgress | undefined;
	const textBlock = result.content.find((block) => block.type === "text");
	const baseText = textBlock?.type === "text" ? textBlock.text ?? "" : "";

	if (options.isPartial) {
		if (options.expanded && details?.diff && details.diff.length > 0) {
			return new Text(renderDiff(details.diff), 0, 0);
		}

		if (!options.expanded && details?.stage === "apply_progress" && Array.isArray(details.files)) {
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
		if (options.expanded) {
			return new Text(renderDiff(details.diff), 0, 0);
		}
		if (Array.isArray(details.fileDiffs) && details.fileDiffs.length > 0) {
			const count = details.fileDiffs.length;
			const title = `${theme.fg("toolTitle", theme.bold("apply_patch"))}${theme.fg("muted", ` (${count} file${count === 1 ? "" : "s"})`)}`;
			const lines = details.fileDiffs
				.map((file: ApplyPatchFileDiff) => formatCounterLine(theme, file, { includePath: true }))
				.join("\n");
			return new Text(`${title}\n${lines}`, 0, 0);
		}
	}

	return new Text(baseText, 0, 0);
}
