/**
 * Minimal Codex apply_patch parser/applier.
 * Patch language mirrors OpenAI Codex / cookbook format.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type PatchActionKind = "add" | "update" | "delete";

export interface PatchHunk {
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

function normalizePatchText(input: string): string[] {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function parseHeader(line: string): { kind: PatchActionKind; path: string } | undefined {
	const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
	if (!match) return undefined;
	return { kind: match[1]!.toLowerCase() as PatchActionKind, path: match[2]!.trim() };
}

function ensurePatchLine(action: PatchAction, line: string): void {
	if (line === "\\ No newline at end of file") return;
	if (action.kind === "add" && !line.startsWith("+")) {
		throw new Error(`Add File lines must start with '+': ${action.path}`);
	}
	if (action.kind === "delete" && !(line.startsWith("-") || line.startsWith(" "))) {
		throw new Error(`Delete File lines must start with '-' or space: ${action.path}`);
	}
	if (
		action.kind === "update" &&
		!(line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
	) {
		throw new Error(`Update File lines must start with '+', '-', or space: ${action.path}`);
	}
}

export function parseApplyPatch(input: string): { actions: PatchAction[] } {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("apply_patch input must be a non-empty string.");
	}
	const lines = normalizePatchText(input);
	let index = 0;
	while (index < lines.length && lines[index]!.trim() === "") index++;
	if (lines[index] !== "*** Begin Patch") throw new Error("Patch must start with '*** Begin Patch'.");
	index++;

	const actions: PatchAction[] = [];
	let sawEnd = false;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line === "*** End Patch") {
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
			if (bodyLine === "*** End Patch" || parseHeader(bodyLine)) break;
			if (bodyLine.startsWith("*** Move to: ")) {
				action.moveTo = bodyLine.slice("*** Move to: ".length).trim();
				if (!action.moveTo) throw new Error(`Move target empty for ${action.path}.`);
				if (action.kind !== "update") throw new Error("Only Update File may include '*** Move to:'.");
				index++;
				continue;
			}
			if (bodyLine.startsWith("@@")) {
				if (current.lines.length > 0) action.hunks.push(current);
				current = { lines: [] };
				index++;
				continue;
			}
			ensurePatchLine(action, bodyLine);
			current.lines.push(bodyLine);
			index++;
		}
		if (current.lines.length > 0) action.hunks.push(current);
		if (action.kind !== "delete" && action.hunks.length === 0 && !action.moveTo) {
			throw new Error(`Patch action has no hunks: ${action.path}`);
		}
		actions.push(action);
	}
	if (!sawEnd) throw new Error("Patch must end with '*** End Patch'.");
	if (actions.length === 0) throw new Error("Patch contains no file actions.");
	return { actions };
}

function cleanPatchPath(pathValue: string): string {
	let cleaned = pathValue.trim();
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
		(cleaned.startsWith("'") && cleaned.endsWith("'"))
	) {
		cleaned = cleaned.slice(1, -1);
	}
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
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

function hunkOldText(hunk: PatchHunk): string {
	return hunk.lines
		.filter((line) => line.startsWith("-") || line.startsWith(" "))
		.map(stripMarker)
		.join("\n");
}

function hunkNewText(hunk: PatchHunk): string {
	return hunk.lines
		.filter((line) => line.startsWith("+") || line.startsWith(" "))
		.map(stripMarker)
		.join("\n");
}

function addText(action: PatchAction): string {
	return action.hunks
		.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith("+")).map(stripMarker))
		.join("\n");
}

function replaceUnique(content: string, oldText: string, newText: string, path: string): string | undefined {
	const first = content.indexOf(oldText);
	if (first < 0) return undefined;
	if (content.indexOf(oldText, first + oldText.length) >= 0) {
		throw new Error(`Patch context is ambiguous in ${path}`);
	}
	return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

function replaceOnce(content: string, oldText: string, newText: string, path: string): string {
	if (oldText.length === 0) return `${content}${newText}`;
	const candidates: Array<[string, string]> = [[oldText, newText]];
	if (!oldText.endsWith("\n")) candidates.push([`${oldText}\n`, newText]);
	const crlfOld = oldText.replace(/\n/g, "\r\n");
	const crlfNew = newText.replace(/\n/g, "\r\n");
	candidates.push([crlfOld, crlfNew]);
	if (!crlfOld.endsWith("\r\n")) candidates.push([`${crlfOld}\r\n`, crlfNew]);
	for (const [candidateOld, candidateNew] of candidates) {
		const next = replaceUnique(content, candidateOld, candidateNew, path);
		if (next !== undefined) return next;
	}
	throw new Error(`Patch context not found in ${path}`);
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

export async function applyPatch(
	input: string,
	options: ApplyPatchOptions,
): Promise<{ files: string[]; summary: string }> {
	const parsed = parseApplyPatch(input);
	const files: string[] = [];
	const snapshots = new Map<string, FileSnapshot>();

	const snap = async (pathValue: string) => {
		const absolutePath = resolvePatchPath(pathValue, options);
		if (!snapshots.has(absolutePath)) snapshots.set(absolutePath, await snapshotPath(absolutePath));
	};

	try {
		for (const action of parsed.actions) {
			await snap(action.path);
			if (action.moveTo) await snap(action.moveTo);

			if (action.kind === "add") {
				const absolutePath = resolvePatchPath(action.path, options);
				await mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, addText(action), "utf8");
				files.push(action.path);
				continue;
			}

			if (action.kind === "delete") {
				const absolutePath = resolvePatchPath(action.path, options);
				await rm(absolutePath, { force: false });
				files.push(action.path);
				continue;
			}

			const absolutePath = resolvePatchPath(action.path, options);
			let content = await readFile(absolutePath, "utf8");
			for (const hunk of action.hunks) {
				content = replaceOnce(content, hunkOldText(hunk), hunkNewText(hunk), action.path);
			}
			await writeFile(absolutePath, content, "utf8");
			if (action.moveTo) {
				const absoluteMoveTo = resolvePatchPath(action.moveTo, options);
				await mkdir(dirname(absoluteMoveTo), { recursive: true });
				await rename(absolutePath, absoluteMoveTo);
			}
			files.push(action.moveTo ? `${action.path} -> ${action.moveTo}` : action.path);
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
	};
}
