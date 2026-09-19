/**
 * applyPatch orchestration: parses the patch, validates target conflicts,
 * snapshots files, applies actions atomically with rollback, and reports
 * numbered diffs.
 */
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { combineFileDiffs, generateNumberedDiff } from "./diff.ts";
import { normalizeText, parseSourceLines, rebuildPreservingEndings } from "./line-endings.ts";
import { applyHunksToLines } from "./match.ts";
import { isMissingPathError, resolvePatchPath } from "./paths.ts";
import { parseApplyPatch } from "./parse.ts";
import type {
	AddFileOnExisting,
	ApplyPatchFileDiff,
	ApplyPatchOptions,
	ApplyPatchProgress,
	ApplyPatchProgressFile,
	ApplyPatchResult,
	PatchAction,
} from "./types.ts";

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

	const checkAborted = () => {
		if (options.signal?.aborted) {
			const reason = options.signal.reason;
			const detail =
				reason instanceof Error ? reason.message : reason ? String(reason) : "operation was aborted";
			throw new Error(`apply_patch aborted: ${detail}`);
		}
	};

	checkAborted();
	if (parsed.actions.length > 0) {
		emitProgress(0, 0);
	}

	try {
		for (const [opIndex, action] of parsed.actions.entries()) {
			checkAborted();
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
				if (options.moveOnExisting !== "overwrite") {
					throw new Error(`Move target already exists: ${action.moveTo}`);
				}
				// Codex overwrites existing move destinations. Directories still fail
				// naturally (EISDIR) rather than being recursively removed.
				await rm(absoluteMoveTo, { force: true });
			}

			const raw = await readFile(absolutePath, "utf8");
			const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
			const rawWithoutBom = bom ? raw.slice(1) : raw;
			const source = parseSourceLines(rawWithoutBom);
			const nextLines = applyHunksToLines(source.lines, action.hunks, action.path);
			const contentNormalized = nextLines.join("\n");
			const finalDiskContent =
				bom +
				rebuildPreservingEndings(source.lines, nextLines, source.endings, source.preferred);
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
			const originalNormalized = source.lines.join("\n");
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
