/**
 * Hunk matching engine: locates quoted context in the target file and applies
 * replacements, with layered tolerance (fuzz levels, normalization levels,
 * loose anchor alignment) and strict refusal to silently relocate edits.
 */
import { buildCandidateHunkLineSets, hunkToChunks, normalizeLineForMatch } from "./candidates.ts";
import { generateHunkDiagnostic } from "./diagnostics.ts";
import { parseHunkHeaderLineNumber } from "./parse.ts";
import type { PatchHunk } from "./types.ts";

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
		// Whether this candidate quotes any existing-file line (context or removal).
		// Pure-insertion hunks never do; used to gate fuzz-degraded insertions below.
		const candidateQuotesExistingLines = candidateLines.some((l) => !l.startsWith("+"));
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
				// A pure-insertion remainder produced by fuzz dropping context lines is
				// not a real insertion: the quoted context failed to locate, and blindly
				// inserting at the cursor silently relocates the edit. Only hunks that
				// were pure insertions from the start may take this path.
				if (candidateQuotesExistingLines) continue;
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
	const normalized = normalizeTextForEngine(originalContent);
	const nextText = applyHunksToLines(normalized, hunks, filePath);
	return nextText.join("\n");
}

/** Engine input contract: lines without terminators, trailing "" for final newline. */
function normalizeTextForEngine(content: string): string[] {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.length === 0 ? [] : normalized.split("\n");
}

export function applyHunksToLines(lines: string[], hunks: PatchHunk[], filePath: string): string[] {
	let fileLines = [...lines];
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

	return fileLines;
}
