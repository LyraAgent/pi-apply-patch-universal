/**
 * Parser for the Codex-style patch envelope: markers, file headers, hunks.
 * Mirrors the official grammar in codex-rs/core/assets/tools/apply_patch.lark,
 * deliberately more lenient where LLMs routinely stray.
 */
import type { PatchAction, PatchActionKind, PatchHunk } from "./types.ts";

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
			// The end marker has not been consumed yet (the inner loop only peeked at
			// it), so sawEnd is still false here. Distinguish by position: a terminator
			// line still ahead means the patch text itself is complete and the action
			// is simply malformed; running off the end means the stream was cut.
			if (index < lines.length) {
				throw new Error(`Patch action has no hunks: ${action.path}`);
			}
			throw new Error(
				`Patch appears truncated or incomplete for ${action.path} (stream ended before '*** End Patch'). ` +
					"If the output hit a token limit or timed out, split the change into smaller patches with 2-3 lines of context.",
			);
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
