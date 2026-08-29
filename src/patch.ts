/**
 * Minimal Codex apply_patch parser/applier.
 * Patch language mirrors OpenAI Codex / cookbook format.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PatchActionKind = "add" | "update" | "delete";

export interface PatchHunk {
	header?: string;
	lines: string[];
	endOfFile?: boolean;
}

export interface PatchAction {
	kind: PatchActionKind;
	path: string;
	moveTo?: string;
	hunks: PatchHunk[];
}

/**
 * What to do when '*** Add File:' targets a path that already exists on disk.
 * - "overwrite": replace the file content (identical content is a no-op).
 * - "error": refuse and explain how to use Update File / Delete File instead.
 */
export type AddFileOnExisting = "overwrite" | "error";

export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths?: boolean;
	addFileOnExisting?: AddFileOnExisting;
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

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
/** '*** End Patch' that was mistakenly given a diff prefix, e.g. '+*** End Patch'. */
const PREFIXED_END_MARKER = /^\s*[+\-]\s*\*\*\* End Patch\s*$/;

function normalizePatchText(input: string): string[] {
	const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

	// Strip prose or markdown fences before '*** Begin Patch'.
	const beginIndex = lines.findIndex((line) => line.includes(BEGIN_MARKER));
	const body = beginIndex >= 0 ? lines.slice(beginIndex) : [...lines];
	if (beginIndex >= 0) {
		const beginLine = body[0]!;
		body[0] = beginLine.slice(beginLine.indexOf(BEGIN_MARKER));
	}

	// Prefer the first well-formed standalone end marker.
	let endIndex = body.findIndex((line, index) => index > 0 && line.trim().startsWith(END_MARKER));
	if (endIndex < 0) {
		// Tolerate '+*** End Patch': without this the marker is parsed as a content
		// line and written into the target file. Scan from the end so file bodies that
		// legitimately contain the marker text keep it verbatim.
		for (let index = body.length - 1; index > 0; index--) {
			if (PREFIXED_END_MARKER.test(body[index]!)) {
				endIndex = index;
				break;
			}
		}
	}
	if (endIndex > 0) return [...body.slice(0, endIndex), END_MARKER];
	return body;
}

/**
 * File headers are matched tolerantly: models routinely emit a leading indent,
 * a missing or repeated space after '***', extra asterisks, a space before the
 * colon, or a stray '+'/'-' diff prefix. Rejecting those variants is not a
 * harmless strictness, because an unrecognized header is absorbed into the
 * previous file's hunks and its body is then searched in the wrong file.
 */
const FILE_HEADER_PATTERN =
	/^(?<prefix>\s*[+-]\s*|\s+)?\*{3,}\s*(?<kind>Add|Update|Delete|Create|Remove)(?:\s+(?:File|to))?\s*:?\s*(?<path>.+)$/i;

interface ParsedFileHeader {
	kind: PatchActionKind;
	path: string;
	/** True when the header carried a '+'/'-' diff prefix, which is ambiguous with file content. */
	prefixed: boolean;
}

function parseFileHeader(line: string): ParsedFileHeader | undefined {
	const match = line.match(FILE_HEADER_PATTERN);
	if (!match?.groups) return undefined;
	const kindRaw = match.groups.kind!.toLowerCase();
	let kind: PatchActionKind;
	if (kindRaw === "create" || kindRaw === "add") kind = "add";
	else if (kindRaw === "delete" || kindRaw === "remove") kind = "delete";
	else kind = "update";
	const prefix = match.groups.prefix ?? "";
	return {
		kind,
		path: cleanPatchPath(match.groups.path!),
		prefixed: /[+-]/.test(prefix),
	};
}

function parseHeader(line: string): { kind: PatchActionKind; path: string } | undefined {
	const parsed = parseFileHeader(line);
	return parsed ? { kind: parsed.kind, path: parsed.path } : undefined;
}

function nextMeaningfulLine(lines: string[], from: number): string | undefined {
	for (let i = from; i < lines.length; i++) {
		if (lines[i]!.trim() !== "") return lines[i];
	}
	return undefined;
}

/**
 * A '+'/'-' prefixed header is ambiguous: it may be a mis-prefixed header, or a
 * literal line of documentation about patch syntax. Only treat it as a header
 * when what follows cannot be file content, i.e. a new hunk or another header.
 */
function prefixedHeaderStartsNewFile(lines: string[], headerIndex: number): boolean {
	const next = nextMeaningfulLine(lines, headerIndex + 1);
	if (next === undefined) return false;
	if (next.startsWith("@@")) return true;
	if (next.trim() === END_MARKER) return false;
	const nextHeader = parseFileHeader(next);
	return nextHeader !== undefined && !nextHeader.prefixed;
}

export function parseHunkHeaderLineNumber(header?: string): number | undefined {
	if (!header) return undefined;
	// Only a leading unified-diff range is a line anchor; semantic contexts may contain "-123".
	const match = header.match(/^\s*-(\d+)(?:,\d+)?(?:\s+\+\d+(?:,\d+)?)?/);
	if (match) {
		const num = parseInt(match[1]!, 10);
		if (!Number.isNaN(num) && num > 0) return num;
	}
	const matchPlain = header.match(/^(\d+)/);
	if (matchPlain) {
		const num = parseInt(matchPlain[1]!, 10);
		if (!Number.isNaN(num) && num > 0) return num;
	}
	return undefined;
}

export function parseApplyPatch(input: string): { actions: PatchAction[] } {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("apply_patch input must be a non-empty string.");
	}
	const lines = normalizePatchText(input);
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index++;
	if (!lines[index] || !lines[index]!.trim().startsWith(BEGIN_MARKER)) {
		throw new Error("Patch must start with '*** Begin Patch'.");
	}
	index++;

	/** Resolve whether the line at `at` opens a new file section. */
	const headerAt = (at: number): ParsedFileHeader | undefined => {
		const parsed = parseFileHeader(lines[at]!);
		if (!parsed) return undefined;
		if (parsed.prefixed && !prefixedHeaderStartsNewFile(lines, at)) return undefined;
		return parsed;
	};

	const actions: PatchAction[] = [];
	let sawEnd = false;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line.trim() === END_MARKER) {
			sawEnd = true;
			break;
		}
		if (line.trim() === "") {
			index++;
			continue;
		}
		const header = headerAt(index);
		if (!header || !header.path) throw new Error(`Expected patch file header at line ${index + 1}.`);
		const action: PatchAction = { kind: header.kind, path: header.path, hunks: [] };
		let current: PatchHunk = { lines: [] };
		index++;
		while (index < lines.length) {
			const bodyLine = lines[index]!;
			// A new file header always closes the current file's hunks.
			if (bodyLine.trim() === END_MARKER || headerAt(index)) break;
			if (bodyLine === "*** End of File" || bodyLine.startsWith("*** End of File")) {
				current.endOfFile = true;
				index++;
				continue;
			}
			if (current.endOfFile && bodyLine.trim() === "") {
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
					// Mark as un-prefixed so candidate generators can test both context and continuation
					current.lines.push(`?${bodyLine}`);
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
	if (cleaned.startsWith("`") && cleaned.endsWith("`")) cleaned = cleaned.slice(1, -1).trim();
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	cleaned = cleaned.replace(/\\/g, "/");
	return cleaned;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as NodeJS.ErrnoException).code === "ENOENT" ||
			(error as NodeJS.ErrnoException).code === "ENOTDIR")
	);
}

function isInsidePath(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertNoSymlinkEscape(cwd: string, absolute: string, pathValue: string): void {
	const realCwd = realpathSync(cwd);
	const rel = relative(cwd, absolute);
	let current = cwd;

	for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
		current = resolve(current, segment);
		try {
			lstatSync(current);
			const realCurrent = realpathSync(current);
			if (!isInsidePath(realCwd, realCurrent)) {
				throw new Error(`Patch path escapes cwd through symlink: ${pathValue}`);
			}
		} catch (error) {
			if (isMissingPathError(error)) break;
			throw error;
		}
	}
}

export function resolvePatchPath(pathValue: string, options: ApplyPatchOptions): string {
	const cleaned = cleanPatchPath(pathValue);
	const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(options.cwd, cleaned);
	const cwd = resolve(options.cwd);
	if (!isInsidePath(cwd, absolute) && !options.allowAbsolutePaths) {
		throw new Error(`Patch path escapes cwd: ${pathValue}`);
	}
	if (!options.allowAbsolutePaths) {
		assertNoSymlinkEscape(cwd, absolute, pathValue);
	}
	return absolute;
}

function stripMarker(line: string): string {
	if (line === "\\ No newline at end of file") return "";
	const marker = line[0];
	return marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line;
}

function addText(action: PatchAction): string {
	const lines = action.hunks.flatMap((hunk) =>
		hunk.lines.filter((line) => line.startsWith("+")).map(stripMarker),
	);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
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
		} else if (line.startsWith("?")) {
			// Unprefixed line default: treat as context
			oldChunk.push(line.slice(1));
			newChunk.push(line.slice(1));
		} else {
			oldChunk.push(line);
			newChunk.push(line);
		}
	}
	return { oldChunk, newChunk };
}

function expandLiteralNewlines(lines: string[]): string[] {
	const result: string[] = [];
	for (const line of lines) {
		if (!line.includes("\\n")) {
			result.push(line);
			continue;
		}
		const prefix = line[0] ?? " ";
		const parts = line.slice(1).split("\\n");
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			if (i === 0) {
				result.push(`${prefix}${part}`);
			} else if (part.startsWith("+") || part.startsWith("-") || part.startsWith(" ")) {
				result.push(part);
			} else {
				result.push(`${prefix}${part}`);
			}
		}
	}
	return result;
}

function buildCandidateHunkLineSets(rawLines: string[]): string[][] {
	const candidates: string[][] = [];

	// Candidate A: Continuation mode (unprefixed '?' inside '-' or '+' block inherits that operation)
	let hasUnprefixed = rawLines.some((l) => l.startsWith("?"));
	if (hasUnprefixed) {
		const candCont: string[] = [];
		let inMinusBlock = false;
		for (const l of rawLines) {
			if (l.startsWith("-")) {
				inMinusBlock = true;
				candCont.push(l);
			} else if (l.startsWith("+")) {
				inMinusBlock = false;
				candCont.push(l);
			} else if (l.startsWith("?")) {
				// Unprefixed line immediately following '-' before any '+' is continuation of delete block
				if (inMinusBlock) {
					candCont.push(`-${l.slice(1)}`);
				} else {
					candCont.push(` ${l.slice(1)}`);
				}
			} else {
				candCont.push(l);
			}
		}
		candidates.push(candCont);
	}

	// Candidate B: Context mode (all unprefixed '?' treated as context ' ')
	const candContext = rawLines.map((l) => (l.startsWith("?") ? ` ${l.slice(1)}` : l));
	candidates.push(candContext);

	// Candidate C & D: Expanded literal newlines if any line has `\n`
	const hasEscapedNewlines = rawLines.some((l) => l.includes("\\n"));
	if (hasEscapedNewlines) {
		candidates.push(expandLiteralNewlines(candidates[0]!));
		if (candidates[1]) {
			candidates.push(expandLiteralNewlines(candidates[1]));
		}
	}

	return candidates;
}

function generateHunkDiagnostic(
	fileLines: string[],
	hunk: PatchHunk,
	filePath: string,
	hunkIndex: number,
): string {
	const candLines = buildCandidateHunkLineSets(hunk.lines)[0]!;
	const { oldChunk } = hunkToChunks(candLines);
	const headerInfo = hunk.header ? ` (${hunk.header})` : "";
	const hintLine = parseHunkHeaderLineNumber(hunk.header);

	const expectedFormatted = candLines
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
		let score = matches / oldChunk.length;
		if (hintLine !== undefined) {
			const dist = Math.abs(i - (hintLine - 1));
			if (dist <= 5) score += 0.2;
			else if (dist <= 20) score += 0.1;
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestScore <= 0.1 && hintLine !== undefined) {
		bestIndex = Math.max(0, Math.min(hintLine - 1, fileLines.length - 1));
		bestScore = 0.15;
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
		const simPercent = Math.min(100, Math.round(bestScore * 100));
		closestDiagnostic = `Closest match in file (around line ${bestIndex + 1}, similarity ${simPercent}%):\n${actualLinesFormatted.join("\n")}`;
	}

	return `Patch context not found in ${filePath}\n\nFailed at Hunk #${hunkIndex + 1}${headerInfo}:\nExpected context:\n${expectedFormatted}\n\n${closestDiagnostic}`;
}

function findChangeContextEnd(
	fileLines: string[],
	header: string | undefined,
	cursor: number,
): number | undefined {
	if (!header || parseHunkHeaderLineNumber(header) !== undefined) return undefined;

	for (let level = 1; level <= 4; level++) {
		const normalizedHeader = normalizeLineForMatch(header, level);
		for (let i = Math.max(0, cursor); i < fileLines.length; i++) {
			if (normalizeLineForMatch(fileLines[i]!, level) === normalizedHeader) return i + 1;
		}
	}
	return undefined;
}

function isNonAnchorLine(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return true;
	// Comment-only lines in the common curly/hash/dash families. Models frequently
	// paraphrase or truncate doc comments, so these make poor match anchors.
	return /^(?:\/\/|\/\*|\*\/|\*|#|--|<!--|-->)/.test(trimmed);
}

/**
 * Last-resort alignment used only after every strict pass has failed.
 *
 * Models routinely paraphrase or truncate doc comments in the context they
 * quote, which makes a strictly contiguous match impossible even though the
 * surrounding code is unambiguous. This pass matches only "anchor" lines (real
 * code) and tolerates comment/blank lines that exist on just one side:
 * file-only comments are preserved verbatim, patch-only comments are dropped.
 * Anchors must still match exactly, and the caller enforces uniqueness, so a
 * paraphrased comment can no longer relocate an edit to the wrong code.
 */
function alignHunkLoosely(
	fileLines: string[],
	subHunkLines: string[],
	start: number,
): { end: number; replacement: string[]; droppedRemovals: string[] } | undefined {
	const eq = (a: string, b: string) => normalizeLineForMatch(a, 4) === normalizeLineForMatch(b, 4);
	const replacement: string[] = [];
	const droppedRemovals: string[] = [];
	let i = start;

	for (const rawLine of subHunkLines) {
		const marker = rawLine[0];
		const isAdd = marker === "+";
		const isRemove = marker === "-";
		const text =
			marker === "+" || marker === "-" || marker === " " || marker === "?"
				? rawLine.slice(1)
				: rawLine;

		if (isAdd) {
			replacement.push(text);
			continue;
		}

		const patchLineIsAnchor = !isNonAnchorLine(text);
		// Keep comment/blank lines the file has but the patch omitted.
		while (
			patchLineIsAnchor &&
			i < fileLines.length &&
			!eq(fileLines[i]!, text) &&
			isNonAnchorLine(fileLines[i]!)
		) {
			replacement.push(fileLines[i]!);
			i++;
		}

		if (i < fileLines.length && eq(fileLines[i]!, text)) {
			if (!isRemove) replacement.push(fileLines[i]!);
			i++;
			continue;
		}

		// Anchors carry the real meaning of the hunk and must match exactly.
		if (patchLineIsAnchor) return undefined;

		// A comment/blank line the patch quoted but the file does not have. Drop it
		// rather than inventing content. A dropped '-' means the intended deletion
		// did not happen, so it is reported instead of being applied silently.
		if (isRemove) droppedRemovals.push(text);
	}

	return { end: i, replacement, droppedRemovals };
}

function findLooseHunkMatches(
	fileLines: string[],
	subHunkLines: string[],
): Array<{ start: number; end: number; replacement: string[]; droppedRemovals: string[] }> {
	const consumed = subHunkLines.filter((l) => !l.startsWith("+"));
	const anchors = consumed.filter((l) => !isNonAnchorLine(l.slice(1)));
	// Two anchors keep the match specific enough to trust without strict context.
	if (anchors.length < 2) return [];

	const normalizedFirstAnchor = normalizeLineForMatch(anchors[0]!.slice(1), 4);
	const matches: Array<{
		start: number;
		end: number;
		replacement: string[];
		droppedRemovals: string[];
	}> = [];
	for (let start = 0; start < fileLines.length; start++) {
		if (normalizeLineForMatch(fileLines[start]!, 4) !== normalizedFirstAnchor) continue;
		// Alignment starts at the first anchor, so leading patch-only comment lines
		// are dropped and leading file-only comment lines stay outside the range.
		const aligned = alignHunkLoosely(fileLines, subHunkLines, start);
		if (aligned) matches.push({ start, ...aligned });
	}
	return matches;
}

function applyHunkWithFuzz(
	fileLines: string[],
	hunk: PatchHunk,
	cursor: number,
	filePath: string,
	hunkIndex: number,
	lineOffset = 0,
): { nextLines: string[]; newCursor: number } {
	const candidateLineSets = buildCandidateHunkLineSets(hunk.lines);
	const rawHintLine = parseHunkHeaderLineNumber(hunk.header);
	// Header line numbers describe the pre-patch file. Earlier hunks in the same
	// file have already shifted every later line by their net size change, so the
	// hint must be rebased or later hunks in a multi-hunk patch drift out of range.
	const hintLine = rawHintLine === undefined ? undefined : Math.max(1, rawHintLine + lineOffset);
	const changeContextEnd = findChangeContextEnd(fileLines, hunk.header, cursor);
	const searchCursor = changeContextEnd ?? cursor;

	for (const candidateLines of candidateLineSets) {
		for (let fuzz = 0; fuzz <= 2; fuzz++) {
			let startIdx = 0;
			let endIdx = candidateLines.length;

			let leadingDropped = 0;
			while (leadingDropped < fuzz && startIdx < endIdx) {
				const l = candidateLines[startIdx]!;
				if (l.startsWith(" ") || (!l.startsWith("+") && !l.startsWith("-"))) {
					startIdx++;
					leadingDropped++;
				} else {
					break;
				}
			}

			let trailingDropped = 0;
			while (trailingDropped < fuzz && endIdx > startIdx) {
				const l = candidateLines[endIdx - 1]!;
				if (l.startsWith(" ") || (!l.startsWith("+") && !l.startsWith("-"))) {
					endIdx--;
					trailingDropped++;
				} else {
					break;
				}
			}

			const subHunkLines = candidateLines.slice(startIdx, endIdx);
			const { oldChunk } = hunkToChunks(subHunkLines);
			if (oldChunk.length === 0) {
				const { newChunk } = hunkToChunks(subHunkLines);
				const insertionHeader = hunk.header?.match(/-(\d+),0(?:\s|$)/);
				const hintedIndex = insertionHeader ? Number.parseInt(insertionHeader[1]!, 10) : undefined;
				const logicalEnd = fileLines.at(-1) === "" ? fileLines.length - 1 : fileLines.length;
				const insertionCursor = hunk.endOfFile
					? logicalEnd
					: (hintedIndex ?? changeContextEnd ?? cursor);
				const insertAt = Math.max(0, Math.min(insertionCursor, fileLines.length));
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

				// If hintLine exists, test spiral search around hintLine first
				if (hintLine !== undefined) {
					const hintIdx = Math.max(0, Math.min(hintLine - 1, maxStart));
					const maxRadius = Math.min(100, Math.max(hintIdx, maxStart - hintIdx));
					for (let r = 0; r <= maxRadius; r++) {
						const plusIdx = hintIdx + r;
						if (plusIdx <= maxStart && checkAt(plusIdx)) {
							const replacement = buildReplacementLines(plusIdx);
							const nextLines = [...fileLines];
							nextLines.splice(plusIdx, oldChunk.length, ...replacement);
							return { nextLines, newCursor: plusIdx + replacement.length };
						}
						const minusIdx = hintIdx - r;
						if (r > 0 && minusIdx >= 0 && minusIdx <= maxStart && checkAt(minusIdx)) {
							const replacement = buildReplacementLines(minusIdx);
							const nextLines = [...fileLines];
							nextLines.splice(minusIdx, oldChunk.length, ...replacement);
							return { nextLines, newCursor: minusIdx + replacement.length };
						}
					}
				}

				// End-of-file chunks should prefer the final possible match, mirroring Codex.
				if (hunk.endOfFile) {
					const logicalEnd = fileLines.at(-1) === "" ? fileLines.length - 1 : fileLines.length;
					const eofStart = logicalEnd - oldChunk.length;
					if (eofStart >= searchCursor && eofStart <= maxStart && checkAt(eofStart)) {
						const replacement = buildReplacementLines(eofStart);
						const nextLines = [...fileLines];
						nextLines.splice(eofStart, oldChunk.length, ...replacement);
						return { nextLines, newCursor: eofStart + replacement.length };
					}
				}

				// Normal sequential search from the semantic context or prior hunk.
				const clampedCursor = Math.max(0, Math.min(searchCursor, maxStart));
				for (let i = clampedCursor; i <= maxStart; i++) {
					if (checkAt(i)) {
						const replacement = buildReplacementLines(i);
						const nextLines = [...fileLines];
						nextLines.splice(i, oldChunk.length, ...replacement);
						return { nextLines, newCursor: i + replacement.length };
					}
				}

				// Preserve legacy fallback only when no semantic @@ context was resolved.
				for (let i = changeContextEnd === undefined ? 0 : clampedCursor; i < clampedCursor; i++) {
					if (checkAt(i)) {
						const replacement = buildReplacementLines(i);
						const nextLines = [...fileLines];
						nextLines.splice(i, oldChunk.length, ...replacement);
						return { nextLines, newCursor: i + replacement.length };
					}
				}
			}
		}
	}

	// Every strict pass failed. Retry with comment/blank-line tolerance, requiring
	// the anchor alignment to be unique so a paraphrased comment cannot silently
	// move the edit somewhere else.
	for (const candidateLines of candidateLineSets) {
		const matches = findLooseHunkMatches(fileLines, candidateLines);
		if (matches.length === 0) continue;
		const forward = matches.filter((m) => m.start >= searchCursor);
		const pool = forward.length > 0 ? forward : matches;
		if (pool.length > 1) continue;
		const match = pool[0]!;
		if (match.droppedRemovals.length > 0) {
			throw new Error(
				`${generateHunkDiagnostic(fileLines, hunk, filePath, hunkIndex)}\n\n` +
					"The surrounding code was located, but these '-' lines are not present in the file " +
					`and would have been skipped:\n${match.droppedRemovals.map((l) => `  |- ${l}`).join("\n")}\n` +
					"Re-read the file and quote the removed lines exactly.",
			);
		}
		const nextLines = [...fileLines];
		nextLines.splice(match.start, match.end - match.start, ...match.replacement);
		return { nextLines, newCursor: match.start + match.replacement.length };
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
	// Net lines added/removed by hunks already applied to this file. Header line
	// numbers refer to the original file, so later hints need this correction.
	let lineOffset = 0;

	for (const [hunkIndex, hunk] of hunks.entries()) {
		const before = fileLines.length;
		const result = applyHunkWithFuzz(fileLines, hunk, cursor, filePath, hunkIndex, lineOffset);
		fileLines = result.nextLines;
		cursor = result.newCursor;
		lineOffset += fileLines.length - before;
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
	} catch (error) {
		if (isMissingPathError(error)) return { absolutePath, existed: false };
		throw error;
	}
}

async function readExistingFile(absolutePath: string): Promise<string | undefined> {
	try {
		return await readFile(absolutePath, "utf8");
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

function pathEntryExists(absolutePath: string): boolean {
	try {
		lstatSync(absolutePath);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
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

function pathConflictKey(absolutePath: string): string {
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

function validateActionPathConflicts(actions: PatchAction[], options: ApplyPatchOptions): void {
	type PathOwner = { index: number; display: string };
	const sources = new Map<string, PathOwner>();
	const moveTargets = new Map<string, PathOwner>();

	for (const [index, action] of actions.entries()) {
		const absoluteSource = pathConflictKey(resolvePatchPath(action.path, options));
		const priorSource = sources.get(absoluteSource);
		if (priorSource !== undefined) {
			throw new Error(
				`Multiple patch operations target the same path: ${action.path} (already targeted by ${priorSource.display})`,
			);
		}
		sources.set(absoluteSource, { index, display: action.path });

		if (action.moveTo) {
			const absoluteTarget = pathConflictKey(resolvePatchPath(action.moveTo, options));
			const priorMove = moveTargets.get(absoluteTarget);
			if (priorMove !== undefined) {
				throw new Error(
					`Multiple move operations target the same path: ${action.moveTo} (already targeted by ${priorMove.display})`,
				);
			}
			moveTargets.set(absoluteTarget, { index, display: action.moveTo });
		}
	}

	for (const [absoluteTarget, target] of moveTargets) {
		const source = sources.get(absoluteTarget);
		if (source !== undefined && source.index !== target.index) {
			throw new Error(
				`Move target conflicts with another patch operation: ${target.display} (also targeted by ${source.display})`,
			);
		}
	}
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

function generateLinearNumberedDiff(
	oldLines: string[],
	newLines: string[],
	contextLines: number,
	lineNumWidth: number,
): { diff: string; firstChangedLine: number | undefined } {
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	if (prefix === oldLines.length && prefix === newLines.length) {
		return { diff: "", firstChangedLine: undefined };
	}

	const output: string[] = [];
	const contextStart = Math.max(0, prefix - contextLines);
	if (contextStart > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	for (let i = contextStart; i < prefix; i++) {
		output.push(` ${String(i + 1).padStart(lineNumWidth, " ")} ${oldLines[i]}`);
	}
	for (let i = prefix; i < oldLines.length - suffix; i++) {
		output.push(`-${String(i + 1).padStart(lineNumWidth, " ")} ${oldLines[i]}`);
	}
	for (let i = prefix; i < newLines.length - suffix; i++) {
		output.push(`+${String(i + 1).padStart(lineNumWidth, " ")} ${newLines[i]}`);
	}

	const suffixToShow = Math.min(contextLines, suffix);
	for (let i = 0; i < suffixToShow; i++) {
		const oldIndex = oldLines.length - suffix + i;
		output.push(` ${String(oldIndex + 1).padStart(lineNumWidth, " ")} ${oldLines[oldIndex]}`);
	}
	if (suffix > suffixToShow) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);

	return { diff: output.join("\n"), firstChangedLine: prefix + 1 };
}

export function generateNumberedDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
	const newLines = newContent.length === 0 ? [] : newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;

	// The exact LCS matrix is quadratic. Keep rendering bounded for generated or very large files.
	if (oldLines.length * newLines.length > 1_000_000) {
		return generateLinearNumberedDiff(oldLines, newLines, contextLines, lineNumWidth);
	}

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
	validateActionPathConflicts(parsed.actions, options);
	const addFileOnExisting: AddFileOnExisting = options.addFileOnExisting ?? "overwrite";
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
				const existingContent = await readExistingFile(absolutePath);
				if (existingContent !== undefined && addFileOnExisting === "error") {
					throw new Error(
						`Add File refuses to overwrite existing path: ${action.path}\n` +
							"Use '*** Update File:' to modify it, '*** Delete File:' first to replace it, " +
							'or set "addFileOnExisting": "overwrite" in the apply_patch config.',
					);
				}
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, newContent, "utf8");
				files.push(action.path);
				const oldContent = existingContent ?? "";
				const diffResult = generateNumberedDiff(normalizeText(oldContent), newContent);
				const added = action.hunks.reduce(
					(sum, h) => sum + h.lines.filter((l) => l.startsWith("+")).length,
					0,
				);
				const removed = countContentLines(normalizeText(oldContent));
				fileDiffs.push({
					path: action.path,
					operation: "add",
					added,
					removed,
					diff: diffResult.diff,
					firstChangedLine: diffResult.firstChangedLine,
				});
				progressFile.added = added;
				progressFile.removed = removed;
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
			const absoluteMoveTo = action.moveTo
				? resolvePatchPath(action.moveTo, options)
				: undefined;
			if (
				absoluteMoveTo !== undefined &&
				absoluteMoveTo !== absolutePath &&
				pathEntryExists(absoluteMoveTo)
			) {
				throw new Error(`Move target already exists: ${action.moveTo}`);
			}

			const raw = await readFile(absolutePath, "utf8");
			const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
			const rawWithoutBom = bom ? raw.slice(1) : raw;
			const lineEnding = detectLineEnding(rawWithoutBom);
			const originalNormalized = normalizeText(rawWithoutBom);
			const contentNormalized = applyHunksToContent(originalNormalized, action.hunks, action.path);
			const finalDiskContent = bom + restoreLineEndings(contentNormalized, lineEnding);
			await writeFile(absolutePath, finalDiskContent, "utf8");
			if (absoluteMoveTo !== undefined && absoluteMoveTo !== absolutePath) {
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
		const message = error instanceof Error ? error.message : String(error);
		let rollbackFailure: string | undefined;
		try {
			await restoreSnapshots([...snapshots.values()]);
		} catch (rollbackError) {
			rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
		}
		if (rollbackFailure) {
			throw new Error(
				`${message}\nRollback encountered an additional error: ${rollbackFailure} ` +
					`Completed before failure: ${files.join(", ") || "none"}.`,
			);
		}
		// The patch is atomic, so the caller needs to know which operations were fine:
		// resend them unchanged and only rework the one that failed.
		const reverted =
			files.length > 0
				? `Reverted ${files.length} operation${files.length === 1 ? "" : "s"} that had applied cleanly: ${files.join(", ")}. ` +
					"Resend those unchanged and fix only the failing file."
				: "No operation had been applied yet.";
		throw new Error(`${message}\nPartial apply rolled back. ${reverted}`);
	}

	return {
		files,
		summary: `Applied patch: ${parsed.actions.map(actionSummary).join(", ")}`,
		filesChanged: fileDiffs.length,
		fileDiffs,
		diff: combineFileDiffs(fileDiffs),
	};
}
