/** Numbered diff generation for results and progress rendering. */
import type { ApplyPatchFileDiff, PatchActionKind } from "./types.ts";

export function operationCode(kind: PatchActionKind): "A" | "D" | "U" {
	if (kind === "add") return "A";
	if (kind === "delete") return "D";
	return "U";
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

function generateLinearNumberedDiff(
	oldLines: string[],
	newLines: string[],
	contextLines: number,
	lineNumWidth: number,
): { diff: string; firstChangedLine: number | undefined } {
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	if (prefix === oldLines.length && prefix === newLines.length) {
		return { diff: "", firstChangedLine: undefined };
	}

	const output: string[] = [];
	const contextStart = Math.max(0, prefix - contextLines);
	if (contextStart > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	for (let i = contextStart; i < prefix; i++) {
		output.push(` ${String(i + 1).padStart(lineNumWidth, " ")} ${oldLines[i]}`);
	}
	for (let i = prefix; i < oldLines.length - suffix; i++) {
		output.push(`-${String(i + 1).padStart(lineNumWidth, " ")} ${oldLines[i]}`);
	}
	for (let i = prefix; i < newLines.length - suffix; i++) {
		output.push(`+${String(i + 1).padStart(lineNumWidth, " ")} ${newLines[i]}`);
	}

	const suffixToShow = Math.min(contextLines, suffix);
	for (let i = 0; i < suffixToShow; i++) {
		const oldIndex = oldLines.length - suffix + i;
		output.push(` ${String(oldIndex + 1).padStart(lineNumWidth, " ")} ${oldLines[oldIndex]}`);
	}
	if (suffix > suffixToShow) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);

	return { diff: output.join("\n"), firstChangedLine: prefix + 1 };
}

export function generateNumberedDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.length === 0 ? [] : oldContent.split("\n");
	const newLines = newContent.length === 0 ? [] : newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length, 1)).length;

	// The exact LCS matrix is quadratic. Keep rendering bounded for generated or very large files.
	if (oldLines.length * newLines.length > 1_000_000) {
		return generateLinearNumberedDiff(oldLines, newLines, contextLines, lineNumWidth);
	}

	type Segment = { type: "equal" | "add" | "remove"; lines: string[] };
	const lcs = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			if (oldLines[i] === newLines[j]) lcs[i][j] = lcs[i + 1][j + 1] + 1;
			else lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const segments: Segment[] = [];
	let i = 0;
	let j = 0;
	const push = (type: Segment["type"], line: string) => {
		const last = segments[segments.length - 1];
		if (last && last.type === type) last.lines.push(line);
		else segments.push({ type, lines: [line] });
	};

	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			push("equal", oldLines[i]!);
			i += 1;
			j += 1;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			push("remove", oldLines[i]!);
			i += 1;
		} else {
			push("add", newLines[j]!);
			j += 1;
		}
	}
	while (i < oldLines.length) {
		push("remove", oldLines[i]!);
		i += 1;
	}
	while (j < newLines.length) {
		push("add", newLines[j]!);
		j += 1;
	}

	const output: string[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;
	let firstChangedLine: number | undefined;
	let lastWasChange = false;

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]!;
		if (segment.type === "add" || segment.type === "remove") {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of segment.lines) {
				if (segment.type === "add") {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum += 1;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextIsChange =
			index < segments.length - 1 &&
			(segments[index + 1]!.type === "add" || segments[index + 1]!.type === "remove");
		if (lastWasChange || nextIsChange) {
			let linesToShow = segment.lines;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, linesToShow.length - contextLines);
				linesToShow = linesToShow.slice(skipStart);
			}
			if (!nextIsChange && linesToShow.length > contextLines) {
				skipEnd = linesToShow.length - contextLines;
				linesToShow = linesToShow.slice(0, contextLines);
			}

			if (skipStart > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipStart;
				newLineNum += skipStart;
			}
			for (const line of linesToShow) {
				output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += segment.lines.length;
			newLineNum += segment.lines.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export function combineFileDiffs(fileDiffs: ApplyPatchFileDiff[]): string {
	return fileDiffs
		.map((fileDiff) => {
			const target = fileDiff.moveTo ? `${fileDiff.path} -> ${fileDiff.moveTo}` : fileDiff.path;
			const header = `@@ +${fileDiff.added} -${fileDiff.removed} ${operationCode(fileDiff.operation)} ${target}`;
			return [header, fileDiff.diff].filter(Boolean).join("\n");
		})
		.join("\n\n");
}
