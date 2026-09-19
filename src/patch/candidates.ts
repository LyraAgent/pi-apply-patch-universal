/**
 * Low-level line normalization and hunk candidate generation shared by the
 * matching engine and its diagnostics.
 */
import type { PatchHunk } from "./types.ts";

export function normalizeLineForMatch(line: string, level: number): string {
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

export function hunkToChunks(hunkLines: string[]): { oldChunk: string[]; newChunk: string[] } {
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

export function expandLiteralNewlines(lines: string[]): string[] {
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

export function buildCandidateHunkLineSets(rawLines: string[]): string[][] {
	const candidates: string[][] = [];

	// Candidate A: Continuation mode (unprefixed '?' inside '-' or '+' block inherits that operation)
	const hasUnprefixed = rawLines.some((l) => l.startsWith("?"));
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

	// Codex-style EOF tolerance: models routinely end an update hunk with a blank
	// context line that stands for the file's final newline, which the target file
	// may not actually have (no trailing newline). Retry each candidate with that
	// line dropped from both sides. Only blank *context* lines are stripped — a
	// blank '-' line is a real deletion and must not be silently skipped.
	const stripped: string[][] = [];
	for (const cand of candidates) {
		let lastNonAddIdx = -1;
		for (let i = cand.length - 1; i >= 0; i--) {
			if (!cand[i]!.startsWith("+")) {
				lastNonAddIdx = i;
				break;
			}
		}
		if (lastNonAddIdx < 0) continue;
		const line = cand[lastNonAddIdx]!;
		const marker = line[0];
		const content = marker === " " || marker === "?" ? line.slice(1) : line;
		if (content !== "" || marker !== " ") continue;
		const variant = [...cand.slice(0, lastNonAddIdx), ...cand.slice(lastNonAddIdx + 1)];
		const duplicate = [...candidates, ...stripped].some(
			(c) => c.length === variant.length && c.every((l, i) => l === variant[i]),
		);
		if (!duplicate) stripped.push(variant);
	}
	return [...candidates, ...stripped];
}

export type { PatchHunk };
