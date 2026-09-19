/** Shared type definitions for the Codex-style patch engine. */

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

/**
 * What to do when '*** Move to:' targets a path that already exists on disk.
 * - "error": refuse (default; the tool description promises this to models).
 * - "overwrite": replace the destination, matching Codex semantics.
 */
export type MoveOnExisting = "error" | "overwrite";

export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths?: boolean;
	addFileOnExisting?: AddFileOnExisting;
	moveOnExisting?: MoveOnExisting;
	signal?: AbortSignal;
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
