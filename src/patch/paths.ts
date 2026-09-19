/** Path resolution and workspace-escape safety for patch targets. */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cleanPatchPath } from "./parse.ts";
import type { ApplyPatchOptions } from "./types.ts";

export function isMissingPathError(error: unknown): boolean {
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
