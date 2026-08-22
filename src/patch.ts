/**
 * Minimal Codex apply_patch parser/applier.
 * Patch language mirrors OpenAI Codex / cookbook format.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PatchActionKind = "add" | "update" | "delete";

export interface PatchHunk {
	header?: string;
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
				const headerText = bodyLine.slice(2).trim();
				current = { header: headerText.length > 0 ? headerText : undefined, lines: [] };
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

function addText(action: PatchAction): string {
	return action.hunks
		.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map(stripMarker))
		.join("\n");
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeLineForMatch(line: string, level: number): string {
	if (level === 1) {
		return line;
	}
	if (level === 2) {
		return line.trimEnd();
	}
	if (level === 3) {
		return line.trim();
	}
	return line
		.normalize("NFKC")
		.trim()
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
		.replace(/\s+/g, " ");
}

function hunkToChunks(hunkLines: string[]): { oldChunk: string[]; newChunk: string[] } {
	const oldChunk: string[] = [];
	const newChunk: string[] = [];
	for (const line of hunkLines) {
		if (line.startsWith("+")) {
			newChunk.push(line.slice(1));
		} else if (line.startsWith("-")) {
			oldChunk.push(line.slice(1));
		} else if (line.startsWith(" ")) {
			oldChunk.push(line.slice(1));
			newChunk.push(line.slice(1));
		} else {
			oldChunk.push(line);
			newChunk.push(line);
		}
	}
	return { oldChunk, newChunk };
}

function generateHunkDiagnostic(
	fileLines: string[],
	hunk: PatchHunk,
	filePath: string,
	hunkIndex: number,
): string {
	const { oldChunk } = hunkToChunks(hunk.lines);
	const headerInfo = hunk.header ? ` (${hunk.header})` : "";

	const expectedFormatted = hunk.lines
		.map((l) => {
			if (l.startsWith("+")) return `  |+ ${l.slice(1)}`;
			if (l.startsWith("-")) return `  |- ${l.slice(1)}`;
			if (l.startsWith(" ")) return `  |  ${l.slice(1)}`;
			return `  |  ${l}`;
		})
		.join("\n");

	if (fileLines.length === 0) {
		return `Patch context not found in ${filePath}\n\nFailed at Hunk #${hunkIndex + 1}${headerInfo}:\nExpected context:\n${expectedFormatted}\n\n(Target file is empty)`;
	}

	if (oldChunk.length === 0) {
		return `Patch context not found in ${filePath}\n\nFailed at Hunk #${hunkIndex + 1}${headerInfo}:\nExpected context:\n${expectedFormatted}`;
	}

	let bestScore = -1;
	let bestIndex = -1;

	const normOld = oldChunk.map((l) => normalizeLineForMatch(l, 4));

	for (let i = 0; i < fileLines.length; i++) {
		let matches = 0;
		const maxLen = Math.min(normOld.length, fileLines.length - i);
		for (let j = 0; j < maxLen; j++) {
			if (normalizeLineForMatch(fileLines[i + j]!, 4) === normOld[j]) {
				matches++;
			}
		}
		const score = matches / oldChunk.length;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	let closestDiagnostic = "(No similar context found in file)";
	if (bestScore > 0.1 && bestIndex >= 0) {
		const contextRadius = 2;
		const startLine = Math.max(0, bestIndex - contextRadius);
		const endLine = Math.min(fileLines.length - 1, bestIndex + oldChunk.length + contextRadius);

		const actualLinesFormatted: string[] = [];
		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			const content = fileLines[lineNum]!;
			const relIndex = lineNum - bestIndex;
			let isMismatch = false;
			if (relIndex >= 0 && relIndex < normOld.length) {
				isMismatch = normalizeLineForMatch(content, 4) !== normOld[relIndex];
			}
			const lineNumStr = String(lineNum + 1).padStart(4, " ");
			const marker = isMismatch ? " <-- mismatch" : "";
			actualLinesFormatted.push(`  | ${lineNumStr}: ${content}${marker}`);
		}
		closestDiagnostic = `Closest match in file (around line ${bestIndex + 1}, similarity ${Math.round(bestScore * 100)}%):\n${actualLinesFormatted.join("\n")}`;
	}

	return `Patch context not found in ${filePath}\n\nFailed at Hunk #${hunkIndex + 1}${headerInfo}:\nExpected context:\n${expectedFormatted}\n\n${closestDiagnostic}`;
}

function applyHunkWithFuzz(
	fileLines: string[],
	hunk: PatchHunk,
	cursor: number,
	filePath: string,
	hunkIndex: number,
): { nextLines: string[]; newCursor: number } {
	const rawLines = hunk.lines;

	for (let fuzz = 0; fuzz <= 2; fuzz++) {
		let startIdx = 0;
		let endIdx = rawLines.length;

		let leadingDropped = 0;
		while (leadingDropped < fuzz && startIdx < endIdx) {
			const l = rawLines[startIdx]!;
			if (l.startsWith(" ") || (!l.startsWith("+") && !l.startsWith("-"))) {
				startIdx++;
				leadingDropped++;
			} else {
				break;
			}
		}

		let trailingDropped = 0;
		while (trailingDropped < fuzz && endIdx > startIdx) {
			const l = rawLines[endIdx - 1]!;
			if (l.startsWith(" ") || (!l.startsWith("+") && !l.startsWith("-"))) {
				endIdx--;
				trailingDropped++;
			} else {
				break;
			}
		}

		const subHunkLines = rawLines.slice(startIdx, endIdx);
		const { oldChunk } = hunkToChunks(subHunkLines);

		if (oldChunk.length === 0) {
			const { newChunk } = hunkToChunks(subHunkLines);
			const insertAt = Math.max(0, Math.min(cursor, fileLines.length));
			const nextLines = [...fileLines];
			nextLines.splice(insertAt, 0, ...newChunk);
			return { nextLines, newCursor: insertAt + newChunk.length };
		}

		if (oldChunk.length > fileLines.length) {
			continue;
		}

		const maxStart = fileLines.length - oldChunk.length;

		for (let level = 1; level <= 4; level++) {
			const normOld = oldChunk.map((l) => normalizeLineForMatch(l, level));

			const checkAt = (idx: number): boolean => {
				for (let j = 0; j < normOld.length; j++) {
					if (normalizeLineForMatch(fileLines[idx + j]!, level) !== normOld[j]) return false;
				}
				return true;
			};

			const buildReplacementLines = (matchStart: number): string[] => {
				const replacement: string[] = [];
				let oldOffset = 0;
				for (const rawLine of subHunkLines) {
					if (rawLine.startsWith("+")) {
						replacement.push(rawLine.slice(1));
					} else if (rawLine.startsWith("-")) {
						oldOffset++;
					} else if (rawLine.startsWith(" ")) {
						replacement.push(fileLines[matchStart + oldOffset]!);
						oldOffset++;
					} else {
						replacement.push(fileLines[matchStart + oldOffset]!);
						oldOffset++;
					}
				}
				return replacement;
			};

			const clampedCursor = Math.max(0, Math.min(cursor, maxStart));
			for (let i = clampedCursor; i <= maxStart; i++) {
				if (checkAt(i)) {
					const replacement = buildReplacementLines(i);
					const nextLines = [...fileLines];
					nextLines.splice(i, oldChunk.length, ...replacement);
					return { nextLines, newCursor: i + replacement.length };
				}
			}

			for (let i = 0; i < clampedCursor; i++) {
				if (checkAt(i)) {
					const replacement = buildReplacementLines(i);
					const nextLines = [...fileLines];
					nextLines.splice(i, oldChunk.length, ...replacement);
					return { nextLines, newCursor: i + replacement.length };
				}
			}
		}
	}

	throw new Error(generateHunkDiagnostic(fileLines, hunk, filePath, hunkIndex));
}

export function applyHunksToContent(
	originalContent: string,
	hunks: PatchHunk[],
	filePath: string,
): string {
	const normalized = normalizeText(originalContent);
	let fileLines = normalized.length === 0 ? [] : normalized.split("\n");
	let cursor = 0;

	for (const [hunkIndex, hunk] of hunks.entries()) {
		const result = applyHunkWithFuzz(fileLines, hunk, cursor, filePath, hunkIndex);
		fileLines = result.nextLines;
		cursor = result.newCursor;
	}

	return fileLines.join("\n");
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
			const raw = await readFile(absolutePath, "utf8");
			const lineEnding = detectLineEnding(raw);
			const originalNormalized = normalizeText(raw);
			const contentNormalized = applyHunksToContent(originalNormalized, action.hunks, action.path);
			const finalDiskContent = restoreLineEndings(contentNormalized, lineEnding);
			await writeFile(absolutePath, finalDiskContent, "utf8");
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
			const diffResult = generateNumberedDiff(originalNormalized, contentNormalized);
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
