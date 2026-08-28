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
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";

function cleanProgressPath(raw: string): string {
	let cleaned = raw.trim();
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

/**
 * Best-effort parser for live/partial apply_patch input.
 * Works on incomplete tool-call payloads while arguments stream in.
 */
export function parseApplyPatchInputProgress(input: string): ApplyPatchInputProgress {
	const normalized = input.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const files: ApplyPatchInputProgressFile[] = [];

	let inPatch = false;
	let ended = false;
	let current: ApplyPatchInputProgressFile | undefined;

	for (const line of lines) {
		if (!inPatch) {
			if (line.includes(BEGIN)) inPatch = true;
			continue;
		}

		// A '+' or '-' prefixed end marker is also treated as the end here; `includes`
		// covers it, matching the tolerant behavior of the real parser.
		if (line.trim() === END || line.includes(END)) {
			ended = true;
			break;
		}

		if (line.startsWith(ADD)) {
			current = {
				path: cleanProgressPath(line.slice(ADD.length)),
				operation: "add",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		if (line.startsWith(DELETE)) {
			current = {
				path: cleanProgressPath(line.slice(DELETE.length)),
				operation: "delete",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		if (line.startsWith(UPDATE)) {
			current = {
				path: cleanProgressPath(line.slice(UPDATE.length)),
				operation: "update",
				added: 0,
				removed: 0,
			};
			files.push(current);
			continue;
		}

		const moveMatch = line.match(/^\*\*\* (?:Move to|Move File to|Rename to): (.+)$/i);
		if (moveMatch && current?.operation === "update") {
			current.moveTo = cleanProgressPath(moveMatch[1]!);
			continue;
		}

		if (!current) continue;
		if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;

		if (current.operation === "add") {
			current.added += 1;
			continue;
		}

		if (current.operation === "update") {
			if (line.startsWith("+")) {
				current.added += 1;
			} else if (line.startsWith("-")) {
				current.removed += 1;
			}
		}
	}

	return {
		totalOperations: files.length,
		files,
		ended,
	};
}