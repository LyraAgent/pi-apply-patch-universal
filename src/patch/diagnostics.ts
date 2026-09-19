/** Rich self-healing diagnostics for hunk match failures. */
import { parseHunkHeaderLineNumber } from "./parse.ts";
import { buildCandidateHunkLineSets, hunkToChunks, normalizeLineForMatch } from "./candidates.ts";
import type { PatchHunk } from "./types.ts";

export function generateHunkDiagnostic(
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

	const targetLine = hintLine ?? (bestIndex >= 0 ? bestIndex + 1 : undefined);
	const targetHint = targetLine !== undefined ? ` around line ${targetLine}` : "";
	const actionableAdvice =
		`\n\nActionable Advice:\n` +
		`1. Use 'read' to inspect the actual file content${targetHint}.\n` +
		`2. Keep context hunks minimal (2-3 lines of context around changes) to avoid drift.\n` +
		`3. Verify exact indentation, comments, and line endings.`;

	return `Patch context not found in ${filePath}\n\nFailed at Hunk #${hunkIndex + 1}${headerInfo}:\nExpected context:\n${expectedFormatted}\n\n${closestDiagnostic}${actionableAdvice}`;
}
