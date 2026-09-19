export type ProgressOperationKind = "add" | "update" | "delete";

export interface ApplyPatchInputProgressFile {
	path: string;
	moveTo?: string;
	operation: ProgressOperationKind;
	added: number;
	removed: number;
}

export interface ApplyPatchInputProgress {
	totalOperations: number;
	files: ApplyPatchInputProgressFile[];
	ended: boolean;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

function cleanProgressPath(raw: string): string {
	let cleaned = raw.trim();
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

// No '+'/'-' prefix tolerance here on purpose: inside an Add File body such
// prefixed lines are *content* (e.g. docs quoting patch syntax), and the real
// parser guards that case with prefixedHeaderStartsNewFile. Indentation before
// the asterisks is tolerated, matching the real parser.
const FILE_HEADER_REGEX =
	/^(?:\s+)?\*{3,}\s*(Add|Update|Delete|Create|Remove)(?:\s+(?:File|to))?\s*:?\s*(.+)$/i;

const MOVE_TO_REGEX = /^\*{3,}\s*(?:Move to|Move File to|Rename to)\s*:?\s*(.+)$/i;

/**
 * High-performance, low-allocation streaming parser for live/partial apply_patch input.
 * Scans line boundaries directly without creating an array of all lines in the document.
 */
export function parseApplyPatchInputProgress(input: string): ApplyPatchInputProgress {
	if (typeof input !== "string" || input.length === 0) {
		return { totalOperations: 0, files: [], ended: false };
	}

	const files: ApplyPatchInputProgressFile[] = [];
	let inPatch = false;
	let ended = false;
	let current: ApplyPatchInputProgressFile | undefined;

	let lineStart = 0;
	const len = input.length;

	while (lineStart < len) {
		// Treat '\n' and lone '\r' (old-Mac endings) both as terminators; '\r\n'
		// terminates at the '\r' and the trailing '\r' is stripped below.
		let lineEnd = input.indexOf("\n", lineStart);
		const crIdx = input.indexOf("\r", lineStart);
		if (crIdx !== -1 && (lineEnd === -1 || crIdx < lineEnd)) {
			lineEnd = crIdx + 1 < len && input[crIdx + 1] === "\n" ? crIdx + 1 : crIdx;
		}
		const hasNewline = lineEnd !== -1;
		if (!hasNewline) lineEnd = len;

		let line = input.slice(lineStart, lineEnd);
		if (line.endsWith("\r")) {
			line = line.slice(0, -1);
		}

		if (!inPatch) {
			if (line.includes(BEGIN)) {
				inPatch = true;
			}
			if (!hasNewline) break;
			lineStart = lineEnd + 1;
			continue;
		}

		// Check for end marker (tolerant of diff prefix '+*** End Patch' or whitespace)
		if (line.includes(END)) {
			ended = true;
			break;
		}

		// Fast path for header detection
		if (line.includes("***")) {
			const headerMatch = line.match(FILE_HEADER_REGEX);
			if (headerMatch) {
				const kindRaw = headerMatch[1]!.toLowerCase();
				let operation: ProgressOperationKind;
				if (kindRaw === "create" || kindRaw === "add") operation = "add";
				else if (kindRaw === "delete" || kindRaw === "remove") operation = "delete";
				else operation = "update";

				current = {
					path: cleanProgressPath(headerMatch[2]!),
					operation,
					added: 0,
					removed: 0,
				};
				files.push(current);

				if (!hasNewline) break;
				lineStart = lineEnd + 1;
				continue;
			}

			const moveMatch = line.match(MOVE_TO_REGEX);
			if (moveMatch && current?.operation === "update") {
				current.moveTo = cleanProgressPath(moveMatch[1]!);
				if (!hasNewline) break;
				lineStart = lineEnd + 1;
				continue;
			}
		}

		if (current) {
			// Skip diff hunk headers or git headers
			if (!line.startsWith("@@") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
				if (current.operation === "add") {
					current.added += 1;
				} else if (current.operation === "update") {
					if (line.startsWith("+")) {
						current.added += 1;
					} else if (line.startsWith("-")) {
						current.removed += 1;
					}
				}
			}
		}

		if (!hasNewline) break;
		lineStart = lineEnd + 1;
	}

	return {
		totalOperations: files.length,
		files,
		ended,
	};
}