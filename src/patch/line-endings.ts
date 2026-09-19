/** Line-ending detection, normalization, and restoration utilities. */

export type LineEnding = "\r\n" | "\n" | "\r";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Per-line view of a source file, mirroring Codex's `SourceFile`:
 * - `lines` is the engine line model (normalized texts, plus a trailing ""
 *   element iff the file ends with a terminator);
 * - `endings[i]` is the terminator that followed `lines[i]` in the original
 *   bytes (`null` for an unterminated final line and for the trailing ""
 *   marker);
 * - `preferred` is the first ending found, used for inserted/replaced lines.
 */
export interface SourceLines {
	lines: string[];
	endings: Array<LineEnding | null>;
	preferred: LineEnding;
}

export function parseSourceLines(content: string): SourceLines {
	const texts: string[] = [];
	const endings: Array<LineEnding | null> = [];
	let preferred: LineEnding | null = null;
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		let ending: LineEnding | null = null;
		if (ch === "\r") {
			ending = content[i + 1] === "\n" ? "\r\n" : "\r";
		} else if (ch === "\n") {
			ending = "\n";
		}
		if (ending === null) continue;
		if (preferred === null) preferred = ending;
		texts.push(content.slice(start, i));
		endings.push(ending);
		i += ending.length - 1;
		start = i + 1;
	}
	if (start < content.length) {
		texts.push(content.slice(start));
		endings.push(null);
	}
	const terminated = endings.length > 0 && endings[endings.length - 1] !== null;
	const lines = terminated ? [...texts, ""] : texts;
	return {
		lines,
		endings: terminated ? [...endings, null] : endings,
		preferred: preferred ?? "\n",
	};
}

/**
 * Rebuilds file content after the engine spliced `nextLines`:
 * lines preserved from the original (common prefix/suffix) keep their exact
 * original terminators — including a missing final newline — while changed or
 * inserted lines use `preferred`. A changed final line always receives a
 * terminator (Codex appends the trailing newline on update).
 */
export function rebuildPreservingEndings(
	originalLines: string[],
	nextLines: string[],
	endings: Array<LineEnding | null>,
	preferred: LineEnding,
): string {
	let prefix = 0;
	while (
		prefix < originalLines.length &&
		prefix < nextLines.length &&
		originalLines[prefix] === nextLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < originalLines.length - prefix &&
		suffix < nextLines.length - prefix &&
		originalLines[originalLines.length - 1 - suffix] ===
			nextLines[nextLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const nextReal = nextLines[nextLines.length - 1] === "" ? nextLines.length - 1 : nextLines.length;
	const out: string[] = [];
	for (let i = 0; i < nextReal; i++) {
		const text = nextLines[i]!;
		let preservedIdx: number | undefined;
		if (i < prefix) preservedIdx = i;
		else if (i >= nextLines.length - suffix) {
			preservedIdx = originalLines.length - (nextLines.length - i);
		}
		const isFinal = i === nextReal - 1;
		let ending: LineEnding | null;
		if (preservedIdx !== undefined) {
			ending = endings[preservedIdx] ?? null;
		} else {
			ending = preferred;
		}
		// Interior lines must terminate; only a preserved unterminated final line
		// may stay unterminated.
		if (!isFinal && ending === null) ending = preferred;
		out.push(text + (ending ?? ""));
	}
	return out.join("");
}
