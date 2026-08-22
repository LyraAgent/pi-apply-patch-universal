/**
 * Minimal Codex apply_patch parser/applier.
 * Patch language mirrors OpenAI Codex / cookbook format.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PatchActionKind = "add" | "update" | "delete";

export interface PatchHunk {
	lines: string[];
}

export interface PatchAction {
	kind: PatchActionKind;
	path: string;
	moveTo?: string;
	hunks: PatchHunk[];
}

export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths?: boolean;
}

export interface ApplyPatchFileDiff {
	path: string;
	moveTo?: string;
	operation: PatchActionKind;
	added: number;
	removed: number;
	diff: string;
	firstChangedLine?: number;
}

export interface ApplyPatchProgressFile {
	path: string;
	moveTo?: string;
	operation: PatchActionKind;
	added: number;
	removed: number;
	done: boolean;
}

export interface ApplyPatchProgress {
	stage: "apply_progress";
	totalOperations: number;
	completedOperations: number;
	currentFile?: string;
	files: ApplyPatchProgressFile[];
	fileDiffs: ApplyPatchFileDiff[];
	diff: string;
}

export interface ApplyPatchResult {
	files: string[];
	summary: string;
	filesChanged: number;
	fileDiffs: ApplyPatchFileDiff[];
	diff: string;
}

function normalizePatchText(input: string): string[] {
	let text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	// Strip markdown code fences if model wrapped the patch in ```...```
	const beginIdx = text.indexOf("*** Begin Patch");
	if (beginIdx >= 0) {
		text = text.slice(beginIdx);
	}
	const endIdx = text.indexOf("*** End Patch");
	if (endIdx >= 0) {
		text = text.slice(0, endIdx + "*** End Patch".length);
	}
	return text.split("\n");
}

function parseHeader(line: string): { kind: PatchActionKind; path: string } | undefined {
	const match = line.match(/^\*\*\* (Add|Update|Delete|Create|Remove) (?:File:?|to:?)\s*(.+)$/i);
	if (!match) return undefined;
	let kindRaw = match[1]!.toLowerCase();
	let kind: PatchActionKind;
	if (kindRaw === "create" || kindRaw === "add") kind = "add";
	else if (kindRaw === "delete" || kindRaw === "remove") kind = "delete";
	else kind = "update";
	return { kind, path: cleanPatchPath(match[2]!) };
}

export function parseApplyPatch(input: string): { actions: PatchAction[] } {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("apply_patch input must be a non-empty string.");
	}
	const lines = normalizePatchText(input);
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index++;
	if (!lines[index] || !lines[index]!.startsWith("*** Begin Patch")) {
		throw new Error("Patch must start with '*** Begin Patch'.");
	}
	index++;

	const actions: PatchAction[] = [];
	let sawEnd = false;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line.trim() === "*** End Patch") {
			sawEnd = true;
			break;
		}
		const header = parseHeader(line);
		if (!header || !header.path) throw new Error(`Expected patch file header at line ${index + 1}.`);
		const action: PatchAction = { kind: header.kind, path: header.path, hunks: [] };
		let current: PatchHunk = { lines: [] };
		index++;
		while (index < lines.length) {
			const bodyLine = lines[index]!;
			if (bodyLine.trim() === "*** End Patch" || parseHeader(bodyLine)) break;
			if (bodyLine === "*** End of File" || bodyLine.startsWith("*** End of File")) {
				index++;
				continue;
			}
			const moveMatch = bodyLine.match(/^\*\*\* (?:Move to|Move File to|Rename to): (.+)$/i);
			if (moveMatch) {
				action.moveTo = cleanPatchPath(moveMatch[1]!);
				if (!action.moveTo) throw new Error(`Move target empty for ${action.path}.`);
				if (action.kind !== "update") throw new Error("Only Update File may include '*** Move to:'.");
				index++;
				continue;
			}
			if (bodyLine.startsWith("--- ") || bodyLine.startsWith("+++ ")) {
				index++;
				continue;
			}
			if (bodyLine.startsWith("@@")) {
				if (current.lines.length > 0) action.hunks.push(current);
				current = { lines: [] };
				index++;
				continue;
			}
			if (bodyLine === "\\ No newline at end of file") {
				index++;
				continue;
			}

			// Tolerant line normalization for LLMs:
			if (action.kind === "add") {
				current.lines.push(bodyLine.startsWith("+") ? bodyLine : `+${bodyLine}`);
			} else if (action.kind === "update") {
				if (bodyLine.startsWith("+") || bodyLine.startsWith("-")) {
					current.lines.push(bodyLine);
				} else if (bodyLine.startsWith(" ")) {
					current.lines.push(bodyLine);
				} else {
					// Blank line or un-prefixed context line: treat as context
					current.lines.push(` ${bodyLine}`);
				}
			} else if (action.kind === "delete") {
				if (bodyLine.startsWith("-") || bodyLine.startsWith(" ")) {
					current.lines.push(bodyLine);
				} else {
					current.lines.push(`-${bodyLine}`);
				}
			}
			index++;
		}
		if (current.lines.length > 0) action.hunks.push(current);
		if (action.kind !== "delete" && action.hunks.length === 0 && !action.moveTo) {
			throw new Error(`Patch action has no hunks: ${action.path}`);
		}
		actions.push(action);
	}
	// If model omitted *** End Patch at EOF, accept it if actions were parsed
	if (!sawEnd && actions.length === 0) {
		throw new Error("Patch must end with '*** End Patch'.");
	}
	if (actions.length === 0) throw new Error("Patch contains no file actions.");
	return { actions };
}

export function cleanPatchPath(pathValue: string): string {
	let cleaned = pathValue.trim();
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
		(cleaned.startsWith("'") && cleaned.endsWith("'"))
	) {
		cleaned = cleaned.slice(1, -1);
	}
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	cleaned = cleaned.replace(/\\/g, "/");
	return cleaned;
}

export function resolvePatchPath(pathValue: string, options: ApplyPatchOptions): string {
	const cleaned = cleanPatchPath(pathValue);
	const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(options.cwd, cleaned);
	const cwd = resolve(options.cwd);
	const rel = relative(cwd, absolute);
	const insideCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	if (!insideCwd && !options.allowAbsolutePaths) {
		throw new Error(`Patch path escapes cwd: ${pathValue}`);
	}
	return absolute;
}

function stripMarker(line: string): string {
	if (line === "\\ No newline at end of file") return "";
	const marker = line[0];
	return marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line;
}

function hunkOldText(hunk: PatchHunk): string {
	return hunk.lines
		.filter((line) => line.startsWith("-") || line.startsWith(" "))
		.map(stripMarker)
		.join("\n");
}

function hunkNewText(hunk: PatchHunk): string {
	return hunk.lines
		.filter((line) => line.startsWith("+") || line.startsWith(" "))
		.map(stripMarker)
		.join("\n");
}

function addText(action: PatchAction): string {
	return action.hunks
		.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map(stripMarker))
		.join("\n");
}

function replaceUnique(content: string, oldText: string, newText: string, path: string): string | undefined {
	const first = content.indexOf(oldText);
	if (first < 0) return undefined;
	if (content.indexOf(oldText, first + oldText.length) >= 0) {
		throw new Error(`Patch context is ambiguous in ${path}`);
	}
	return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

function replaceOnce(content: string, oldText: string, newText: string, path: string): string {
	if (oldText.length === 0) return `${content}${newText}`;
	const candidates: Array<[string, string]> = [[oldText, newText]];
	if (!oldText.endsWith("\n")) candidates.push([`${oldText}\n`, newText]);
	const crlfOld = oldText.replace(/\n/g, "\r\n");
	const crlfNew = newText.replace(/\n/g, "\r\n");
	candidates.push([crlfOld, crlfNew]);
	if (!crlfOld.endsWith("\r\n")) candidates.push([`${crlfOld}\r\n`, crlfNew]);
	for (const [candidateOld, candidateNew] of candidates) {
		const next = replaceUnique(content, candidateOld, candidateNew, path);
		if (next !== undefined) return next;
	}

	// Fuzzy fallback: line-by-line matching with trailing whitespace tolerance
	const fuzzy = replaceFuzzyLines(content, oldText, newText);
	if (fuzzy !== undefined) return fuzzy;

	throw new Error(`Patch context not found in ${path}`);
}

function replaceFuzzyLines(content: string, oldText: string, newText: string): string | undefined {
	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	if (oldLines.length === 0) return undefined;

	const normContent = contentLines.map((l) => l.trimEnd());
	const normOld = oldLines.map((l) => l.trimEnd());

	const matchIndices: number[] = [];
	for (let i = 0; i <= normContent.length - normOld.length; i++) {
		let match = true;
		for (let j = 0; j < normOld.length; j++) {
			if (normContent[i + j] !== normOld[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			matchIndices.push(i);
		}
	}

	if (matchIndices.length === 1) {
		const matchIndex = matchIndices[0]!;
		contentLines.splice(matchIndex, oldLines.length, ...newLines);
		return contentLines.join("\n");
	}

	return undefined;
}

interface FileSnapshot {
	absolutePath: string;
	existed: boolean;
	data?: Buffer;
}

async function snapshotPath(absolutePath: string): Promise<FileSnapshot> {
	try {
		return { absolutePath, existed: true, data: await readFile(absolutePath) };
	} catch {
		return { absolutePath, existed: false };
	}
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
	for (const snapshot of [...snapshots].reverse()) {
		if (snapshot.existed) {
			await mkdir(dirname(snapshot.absolutePath), { recursive: true });
			await writeFile(snapshot.absolutePath, snapshot.data ?? Buffer.alloc(0));
		} else if (existsSync(snapshot.absolutePath)) {
			await rm(snapshot.absolutePath, { force: true, recursive: true });
		}
	}
}

function actionSummary(action: PatchAction): string {
	if (action.kind === "add") return `create ${action.path}`;
	if (action.kind === "delete") return `delete ${action.path}`;
	if (action.moveTo) return `update ${action.path} -> ${action.moveTo}`;
	return `update ${action.path}`;
}

function operationCode(kind: PatchActionKind): "A" | "D" | "U" {
	if (kind === "add") return "A";
	if (kind === "delete") return "D";
	return "U";
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

export function generateNumberedDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
	const newLines = newContent.length === 0 ? [] : newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;

	type Segment = { type: "equal" | "add" | "remove"; lines: string[] };
	const lcs = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			if (oldLines[i] === newLines[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
			else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const segments: Segment[] = [];
	let i = 0;
	let j = 0;
	const push = (type: Segment["type"], line: string) => {
		const last = segments[segments.length - 1];
		if (last && last.type === type) last.lines.push(line);
		else segments.push({ type, lines: [line] });
	};

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			push("equal", oldLines[i]!);
			i += 1;
			j += 1;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			push("remove", oldLines[i]!);
			i += 1;
		} else {
			push("add", newLines[j]!);
			j += 1;
		}
	}
	while (i < oldLines.length) {
		push("remove", oldLines[i]!);
		i += 1;
	}
	while (j < newLines.length) {
		push("add", newLines[j]!);
		j += 1;
	}

	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let firstChangedLine: number | undefined;
	let lastWasChange = false;

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]!;
		if (segment.type === "add" || segment.type === "remove") {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of segment.lines) {
				if (segment.type === "add") {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum += 1;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextIsChange =
			index < segments.length - 1 &&
			(segments[index + 1]!.type === "add" || segments[index + 1]!.type === "remove");
		if (lastWasChange || nextIsChange) {
			let linesToShow = segment.lines;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, linesToShow.length - contextLines);
				linesToShow = linesToShow.slice(skipStart);
			}
			if (!nextIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}
			for (const line of linesToShow) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += segment.lines.length;
			newLineNum += segment.lines.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export function combineFileDiffs(fileDiffs: ApplyPatchFileDiff[]): string {
	return fileDiffs
		.map((fileDiff) => {
			const target = fileDiff.moveTo ? `${fileDiff.path} -> ${fileDiff.moveTo}` : fileDiff.path;
			const header = `@@ +${fileDiff.added} -${fileDiff.removed} ${operationCode(fileDiff.operation)} ${target}`;
			return [header, fileDiff.diff].filter(Boolean).join("\n");
		})
		.join("\n\n");
}

export async function applyPatch(
	input: string,
	options: ApplyPatchOptions,
	onProgress?: (progress: ApplyPatchProgress) => void,
): Promise<ApplyPatchResult> {
	const parsed = parseApplyPatch(input);
	const files: string[] = [];
	const fileDiffs: ApplyPatchFileDiff[] = [];
	const snapshots = new Map<string, FileSnapshot>();

	const snap = async (pathValue: string) => {
		const absolutePath = resolvePatchPath(pathValue, options);
		if (!snapshots.has(absolutePath)) snapshots.set(absolutePath, await snapshotPath(absolutePath));
	};

	const progressFiles: ApplyPatchProgressFile[] = parsed.actions.map((act) => ({
		path: act.path,
		moveTo: act.moveTo,
		operation: act.kind,
		added: 0,
		removed: 0,
		done: false,
	}));

	const emitProgress = (completedOperations: number, currentFileIndex?: number) => {
		onProgress?.({
			stage: "apply_progress",
			totalOperations: parsed.actions.length,
			completedOperations,
			currentFile: currentFileIndex !== undefined ? progressFiles[currentFileIndex]?.path : undefined,
			files: progressFiles.map((f) => ({ ...f })),
			fileDiffs: [...fileDiffs],
			diff: combineFileDiffs(fileDiffs),
		});
	};

	if (parsed.actions.length > 0) {
		emitProgress(0, 0);
	}

	try {
		for (const [opIndex, action] of parsed.actions.entries()) {
			const progressFile = progressFiles[opIndex]!;
			await snap(action.path);
			if (action.moveTo) await snap(action.moveTo);

			if (action.kind === "add") {
				const absolutePath = resolvePatchPath(action.path, options);
				const newContent = addText(action);
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, newContent, "utf8");
				files.push(action.path);
				const added = action.hunks.reduce(
					(sum, h) => sum + h.lines.filter((l) => l.startsWith("+")).length,
					0,
				);
				const diffResult = generateNumberedDiff("", newContent);
				fileDiffs.push({
					path: action.path,
					operation: "add",
					added,
					removed: 0,
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
				});
				progressFile.added = added;
				progressFile.done = true;
				emitProgress(opIndex + 1, opIndex);
				continue;
			}

			if (action.kind === "delete") {
				const absolutePath = resolvePatchPath(action.path, options);
				const oldContent = await readFile(absolutePath, "utf8");
				await rm(absolutePath, { force: false });
				files.push(action.path);
				const removed = countContentLines(oldContent);
				const diffResult = generateNumberedDiff(oldContent, "");
				fileDiffs.push({
					path: action.path,
					operation: "delete",
					added: 0,
					removed,
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
				});
				progressFile.removed = removed;
				progressFile.done = true;
				emitProgress(opIndex + 1, opIndex);
				continue;
			}

			const absolutePath = resolvePatchPath(action.path, options);
			const original = await readFile(absolutePath, "utf8");
			let content = original;
			for (const hunk of action.hunks) {
				content = replaceOnce(content, hunkOldText(hunk), hunkNewText(hunk), action.path);
			}
			await writeFile(absolutePath, content, "utf8");
			if (action.moveTo) {
				const absoluteMoveTo = resolvePatchPath(action.moveTo, options);
				await mkdir(dirname(absoluteMoveTo), { recursive: true });
				await rename(absolutePath, absoluteMoveTo);
			}
			files.push(action.moveTo ? `${action.path} -> ${action.moveTo}` : action.path);
			const added = action.hunks.reduce(
				(sum, h) => sum + h.lines.filter((l) => l.startsWith("+")).length,
				0,
			);
			const removed = action.hunks.reduce(
				(sum, h) => sum + h.lines.filter((l) => l.startsWith("-")).length,
				0,
			);
			const diffResult = generateNumberedDiff(original, content);
			fileDiffs.push({
				path: action.path,
				moveTo: action.moveTo,
				operation: "update",
				added,
				removed,
				diff: diffResult.diff,
				firstChangedLine: diffResult.firstChangedLine,
			});
			progressFile.added = added;
			progressFile.removed = removed;
			progressFile.done = true;
			emitProgress(opIndex + 1, opIndex);
		}
	} catch (error) {
		const applied = files.join(", ") || "none";
		const message = error instanceof Error ? error.message : String(error);
		await restoreSnapshots([...snapshots.values()]);
		throw new Error(
			`${message}\nPartial apply rolled back. Completed before failure: ${applied}.`,
		);
	}

	return {
		files,
		summary: `Applied patch: ${parsed.actions.map(actionSummary).join(", ")}`,
		filesChanged: fileDiffs.length,
		fileDiffs,
		diff: combineFileDiffs(fileDiffs),
	};
}
