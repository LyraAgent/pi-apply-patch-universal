import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, describe, it } from "node:test";
import { applyPatch } from "../src/patch.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-universal-extra-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("advanced patch resilience & diagnostics", () => {
	it("handles Windows CRLF line endings and preserves disk line endings", async () => {
		const cwd = await makeTempDir();
		const crlfOriginal = "line1\r\nline2\r\nline3\r\n";
		await writeFile(path.join(cwd, "crlf.txt"), crlfOriginal, "utf8");
		const patchText = [
			"*** Begin Patch",
			"*** Update File: crlf.txt",
			"@@",
			" line1",
			"-line2",
			"+line2 modified",
			" line3",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "crlf.txt"), "utf8");
		assert.equal(updated, "line1\r\nline2 modified\r\nline3\r\n");
	});

	it("handles multiple hunks in one file with line offset drift", async () => {
		const cwd = await makeTempDir();
		const initialContent = [
			"section 1 start",
			"line 1.1",
			"line 1.2",
			"section 1 end",
			"section 2 start",
			"line 2.1",
			"line 2.2",
			"section 2 end",
			"section 3 start",
			"line 3.1",
			"line 3.2",
			"section 3 end",
		].join("\n") + "\n";

		await writeFile(path.join(cwd, "multi.txt"), initialContent, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: multi.txt",
			"@@ section 1",
			" section 1 start",
			"+line 1.0 added",
			" line 1.1",
			" line 1.2",
			" section 1 end",
			"@@ section 2",
			" section 2 start",
			"-line 2.1",
			"+line 2.1 changed",
			" line 2.2",
			" section 2 end",
			"@@ section 3",
			" section 3 start",
			" line 3.1",
			"-line 3.2",
			" section 3 end",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "multi.txt"), "utf8");
		const expected = [
			"section 1 start",
			"line 1.0 added",
			"line 1.1",
			"line 1.2",
			"section 1 end",
			"section 2 start",
			"line 2.1 changed",
			"line 2.2",
			"section 2 end",
			"section 3 start",
			"line 3.1",
			"section 3 end",
		].join("\n") + "\n";
		assert.equal(updated, expected);
	});

	it("handles CSS comments and special characters", async () => {
		const cwd = await makeTempDir();
		const cssContent = `.track-card {
  /* - M7 实测兼容处理 */
  display: flex;
  gap: 8px;
  padding: 10px;
}
`;
		await writeFile(path.join(cwd, "tracks.css"), cssContent, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: tracks.css",
			"@@",
			" .track-card {",
			"   /* - M7 实测兼容处理 */",
			"   display: flex;",
			"-  gap: 8px;",
			"+  gap: 12px;",
			"   padding: 10px;",
			" }",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "tracks.css"), "utf8");
		assert.ok(updated.includes("gap: 12px;"));
		assert.ok(updated.includes("/* - M7 实测兼容处理 */"));
	});

	it("handles trailing whitespace and unicode variations in context", async () => {
		const cwd = await makeTempDir();
		// original has trailing spaces after semicolon
		const original = "const title = \"hello\";   \nconst count = 10;\n";
		await writeFile(path.join(cwd, "fuzzy.ts"), original, "utf8");

		// patch context doesn't have trailing spaces
		const patchText = [
			"*** Begin Patch",
			"*** Update File: fuzzy.ts",
			"@@",
			" const title = \"hello\";",
			"-const count = 10;",
			"+const count = 20;",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "fuzzy.ts"), "utf8");
		assert.equal(updated, "const title = \"hello\";   \nconst count = 20;\n");
	});

	it("provides rich diagnostic error with closest match when context is mismatched", async () => {
		const cwd = await makeTempDir();
		const original = `function calculateTotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`;
		await writeFile(path.join(cwd, "calc.js"), original, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: calc.js",
			"@@ calculateTotal",
			" function calculateTotal(items) {",
			"   let sum = 0;",
			"   for (const item of elements) {",
			"-    sum += item.cost;",
			"+    sum += item.totalPrice;",
			"   }",
			"   return sum;",
			" }",
			"*** End " + "Patch",
		].join("\n");

		let errorCaught: Error | undefined;
		try {
			await applyPatch(patchText, { cwd });
		} catch (err) {
			errorCaught = err as Error;
		}

		assert.ok(errorCaught);
		assert.ok(errorCaught.message.includes("Patch context not found in calc.js"));
		assert.ok(errorCaught.message.includes("Failed at Hunk #1 (calculateTotal)"));
		assert.ok(errorCaught.message.includes("Expected context:"));
		assert.ok(errorCaught.message.includes("Closest match in file"));
		assert.ok(errorCaught.message.includes("<-- mismatch"));
	});

	it("enforces path sandbox and blocks escaping cwd by default", async () => {
		const cwd = await makeTempDir();
		const outsideDir = await makeTempDir();
		await writeFile(path.join(outsideDir, "secret.txt"), "secret data\n", "utf8");

		const relOutside = path.relative(cwd, path.join(outsideDir, "secret.txt")).replace(/\\/g, "/");
		const patchText = [
			"*** Begin Patch",
			`*** Update File: ${relOutside}`,
			"@@",
			"-secret data",
			"+hacked data",
			"*** End " + "Patch",
		].join("\n");

		// By default (allowAbsolutePaths: false), path escapes must throw
		await assert.rejects(
			async () => await applyPatch(patchText, { cwd, allowAbsolutePaths: false }),
			/Patch path escapes cwd/,
		);

		// When allowAbsolutePaths: true, cross-directory patch is allowed
		const result = await applyPatch(patchText, { cwd, allowAbsolutePaths: true });
		assert.equal(result.filesChanged, 1);
		assert.equal(await readFile(path.join(outsideDir, "secret.txt"), "utf8"), "hacked data\n");
	});

	it("rolls back Move (Rename) operations when a subsequent file in the patch fails", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "old_name.ts"), "export const a = 1;\n", "utf8");
		await writeFile(path.join(cwd, "second.ts"), "const b = 2;\n", "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: old_name.ts",
			"*** Move to: new_name.ts",
			"@@",
			"-export const a = 1;",
			"+export const a = 100;",
			"*** Update File: second.ts",
			"@@",
			"-non_existent_context_to_trigger_failure",
			"+anything",
			"*** End " + "Patch",
		].join("\n");

		await assert.rejects(
			async () => await applyPatch(patchText, { cwd }),
			/Patch context not found/,
		);

		// old_name.ts should still exist at original path with original content
		assert.equal(await readFile(path.join(cwd, "old_name.ts"), "utf8"), "export const a = 1;\n");
		// new_name.ts should NOT exist
		await assert.rejects(async () => await readFile(path.join(cwd, "new_name.ts"), "utf8"));
	});

	it("rolls back Delete operations when a subsequent file in the patch fails", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "to_delete.txt"), "important data\n", "utf8");
		await writeFile(path.join(cwd, "other.txt"), "other data\n", "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Delete File: to_delete.txt",
			"*** Update File: other.txt",
			"@@",
			"-invalid context line",
			"+replacement",
			"*** End " + "Patch",
		].join("\n");

		await assert.rejects(
			async () => await applyPatch(patchText, { cwd }),
			/Patch context not found/,
		);

		// to_delete.txt must be restored with original content
		assert.equal(await readFile(path.join(cwd, "to_delete.txt"), "utf8"), "important data\n");
	});

	it("handles pure insertion hunk and pure deletion hunk", async () => {
		const cwd = await makeTempDir();
		const original = "line1\nline2\nline3\n";
		await writeFile(path.join(cwd, "insert_delete.txt"), original, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: insert_delete.txt",
			"@@",
			" line1",
			"+line1.5 inserted",
			" line2",
			"-line3",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "insert_delete.txt"), "utf8");
		assert.equal(updated, "line1\nline1.5 inserted\nline2\n");
	});

	it("handles replacement at file start (line 1) and file end (last line)", async () => {
		const cwd = await makeTempDir();
		const original = "FIRST_LINE\nmiddle\nLAST_LINE\n";
		await writeFile(path.join(cwd, "boundary.txt"), original, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: boundary.txt",
			"@@",
			"-FIRST_LINE",
			"+NEW_FIRST_LINE",
			" middle",
			"-LAST_LINE",
			"+NEW_LAST_LINE",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "boundary.txt"), "utf8");
		assert.equal(updated, "NEW_FIRST_LINE\nmiddle\nNEW_LAST_LINE\n");
	});

	it("handles 100% full file content rewrite via patch", async () => {
		const cwd = await makeTempDir();
		const original = "old A\nold B\nold C\n";
		await writeFile(path.join(cwd, "full.txt"), original, "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: full.txt",
			"@@",
			"-old A",
			"-old B",
			"-old C",
			"+new A",
			"+new B",
			"+new C",
			"+new D",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "full.txt"), "utf8");
		assert.equal(updated, "new A\nnew B\nnew C\nnew D\n");
	});

	it("handles multi-line markdown blockquotes where continuation lines lack '-' prefix", async () => {
		const cwd = await makeTempDir();
		const docContent = [
			"# Design Specification",
			"",
			"> M2 修正记录：`WEAVER` 由 `#2E9BE0` 调深为 `#1C7FC0`。",
			"> 原因是这三个主色要画 halo 与道具线条，属非文本图形。",
			"> 另外 `#2E9BE0` 是 2.1 节 M1 已经废弃掉的旧 `--sky-500`。",
			"",
			"## Next Section",
		].join("\n") + "\n";

		await mkdir(path.join(cwd, "docs"), { recursive: true });
		await writeFile(path.join(cwd, "docs/spec.md"), docContent, "utf8");

		// Notice line 2 and 3 start with "> " without explicit "-"
		const patchText = [
			"*** Begin Patch",
			"*** Update File: docs/spec.md",
			"@@ -3,3 +3,1 @@",
			"-> M2 修正记录：`WEAVER` 由 `#2E9BE0` 调深为 `#1C7FC0`。",
			"> 原因是这三个主色要画 halo 与道具线条，属非文本图形。",
			"> 另外 `#2E9BE0` 是 2.1 节 M1 已经废弃掉的旧 `--sky-500`。",
			"+> M2 修正记录：`WEAVER` 调整为樱粉色 `#DB497E`。",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "docs/spec.md"), "utf8");
		const expected = [
			"# Design Specification",
			"",
			"> M2 修正记录：`WEAVER` 调整为樱粉色 `#DB497E`。",
			"",
			"## Next Section",
		].join("\n") + "\n";
		assert.equal(updated, expected);
	});

	it("handles hunk lines containing literal \\n escaped newlines", async () => {
		const cwd = await makeTempDir();
		const docContent = [
			"# Title",
			"> line 1",
			"> line 2",
			"> line 3",
			"# End",
		].join("\n") + "\n";

		await writeFile(path.join(cwd, "escaped.md"), docContent, "utf8");

		// Hunk line literally containing \n inside a single line
		const patchText = [
			"*** Begin Patch",
			"*** Update File: escaped.md",
			"@@",
			"-> line 1\\n> line 2\\n> line 3",
			"+> line 1 replacement\\n> line 2 replacement",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "escaped.md"), "utf8");
		const expected = [
			"# Title",
			"> line 1 replacement",
			"> line 2 replacement",
			"# End",
		].join("\n") + "\n";
		assert.equal(updated, expected);
	});

	it("preserves a UTF-8 BOM while matching the first line", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "bom.txt"), "\uFEFFfirst\r\nsecond\r\n", "utf8");

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: bom.txt",
				"@@ -1,2 +1,2 @@",
				"-first",
				"+updated",
				" second",
				"*** End Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(await readFile(path.join(cwd, "bom.txt"), "utf8"), "\uFEFFupdated\r\nsecond\r\n");
	});

	it("uses a zero-length hunk header to position pure insertions", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "insert.txt"), "one\ntwo\nthree\n", "utf8");

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: insert.txt",
				"@@ -2,0 +3,1 @@",
				"+inserted",
				"*** End Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(await readFile(path.join(cwd, "insert.txt"), "utf8"), "one\ntwo\ninserted\nthree\n");
	});

	it("overwrites an existing Add File target by default and refuses in error mode", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "existing.txt"), "stale half-written file\n", "utf8");

		const result = await applyPatch(
			[
				"*** Begin Patch",
				"*** Add File: existing.txt",
				"+replacement",
				"*** End Patch",
			].join("\n"),
			{ cwd },
		);
		assert.equal(await readFile(path.join(cwd, "existing.txt"), "utf8"), "replacement\n");
		const addDiff = result.fileDiffs[0]!;
		assert.equal(addDiff.operation, "add");
		assert.equal(addDiff.added, 1);
		assert.equal(addDiff.removed, 1);

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Add File: existing.txt",
					"+second attempt",
					"*** End Patch",
				].join("\n"),
				{ cwd, addFileOnExisting: "error" },
			),
			/Add File refuses to overwrite existing path[\s\S]*Update File/,
		);
		assert.equal(await readFile(path.join(cwd, "existing.txt"), "utf8"), "replacement\n");
	});

	it("rolls back an overwritten Add File target when a later action fails", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "existing.txt"), "original\n", "utf8");
		await writeFile(path.join(cwd, "other.txt"), "other\n", "utf8");

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Add File: existing.txt",
					"+replacement",
					"*** Update File: other.txt",
					"@@",
					"-missing context",
					"+nope",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Patch context not found/,
		);
		assert.equal(await readFile(path.join(cwd, "existing.txt"), "utf8"), "original\n");
		assert.equal(await readFile(path.join(cwd, "other.txt"), "utf8"), "other\n");
	});

	it("refuses to overwrite an existing Move target", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "source.txt"), "source\n", "utf8");
		await writeFile(path.join(cwd, "target.txt"), "keep move target\n", "utf8");
		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: source.txt",
					"*** Move to: target.txt",
					"@@",
					"-source",
					"+updated source",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Move target already exists/,
		);
		assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "source\n");
		assert.equal(await readFile(path.join(cwd, "target.txt"), "utf8"), "keep move target\n");
	});

	it("rejects conflicting operations before modifying any file", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "same.txt"), "original\n", "utf8");

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: same.txt",
					"@@",
					"-original",
					"+first",
					"*** Delete File: same.txt",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Multiple patch operations target the same path/,
		);
		assert.equal(await readFile(path.join(cwd, "same.txt"), "utf8"), "original\n");

		await writeFile(path.join(cwd, "source.txt"), "source\n", "utf8");
		await writeFile(path.join(cwd, "other.txt"), "other\n", "utf8");
		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: source.txt",
					"*** Move to: other.txt",
					"@@",
					"-source",
					"+moved",
					"*** Delete File: other.txt",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Move target conflicts with another patch operation/,
		);
		assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "source\n");
		assert.equal(await readFile(path.join(cwd, "other.txt"), "utf8"), "other\n");
	});

	it("blocks workspace escape through directory symlinks", async (t) => {
		const cwd = await makeTempDir();
		const outside = await makeTempDir();
		await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
		try {
			await symlink(outside, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				t.skip("creating symlinks is not permitted in this environment");
				return;
			}
			throw error;
		}

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: linked/secret.txt",
					"@@",
					"-secret",
					"+escaped",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Patch path escapes cwd through symlink/,
		);
		assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "secret\n");
	});

	it("uses Codex-style @@ change context to disambiguate repeated blocks", async () => {
		const cwd = await makeTempDir();
		await writeFile(
			path.join(cwd, "context.txt"),
			"fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n",
			"utf8",
		);

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: context.txt",
				"@@ fn b",
				"-x=10",
				"+x=11",
				"*** End Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(
			await readFile(path.join(cwd, "context.txt"), "utf8"),
			"fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n",
		);
	});

	it("does not mistake numeric semantic context for a line-number header", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "numeric-context.txt"), "item-123\nvalue=1\nvalue=1\n", "utf8");

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: numeric-context.txt",
				"@@ item-123",
				"-value=1",
				"+value=2",
				"*** EndPatch".replace("EndPatch", "End Patch"),
			].join("\n"),
			{ cwd },
		);

		assert.equal(
			await readFile(path.join(cwd, "numeric-context.txt"), "utf8"),
			"item-123\nvalue=2\nvalue=1\n",
		);
	});

	it("uses End of File to select the final repeated block", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "eof.txt"), "start\nrepeat\nmiddle\nrepeat\n", "utf8");

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: eof.txt",
				"@@",
				"-repeat",
				"+final",
				"*** End of File",
				"*** End Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(await readFile(path.join(cwd, "eof.txt"), "utf8"), "start\nrepeat\nmiddle\nfinal\n");
	});

	it("appends pure insertions marked End of File", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "append.txt"), "first\nsecond\n", "utf8");

		await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: append.txt",
				"@@",
				"+third",
				"*** End of File",
				"*** EndPatch".replace("EndPatch", "End Patch"),
			].join("\n"),
			{ cwd },
		);

		assert.equal(await readFile(path.join(cwd, "append.txt"), "utf8"), "first\nsecond\nthird\n");
	});

	it("uses @@ -L,N @@ line number hint to anchor search in large documents", async () => {
		const cwd = await makeTempDir();
		// Generate 200 lines
		const lines: string[] = [];
		for (let i = 1; i <= 200; i++) {
			lines.push(`item_${i}_value = ${i};`);
		}
		await writeFile(path.join(cwd, "large.txt"), lines.join("\n") + "\n", "utf8");

		const patchText = [
			"*** Begin Patch",
			"*** Update File: large.txt",
			"@@ -150,3 +150,3 @@",
			" item_149_value = 149;",
			"-item_150_value = 150;",
			"+item_150_value = 99999;",
			" item_151_value = 151;",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "large.txt"), "utf8");
		assert.ok(updated.includes("item_150_value = 99999;"));
	});
});

describe("multi-file header state machine", () => {
	it("closes the previous file when a later header is indented or oddly spaced", async () => {
		const cwd = await makeTempDir();
		await mkdir(path.join(cwd, "src"), { recursive: true });
		await writeFile(
			path.join(cwd, "src", "site.css"),
			".nav-brand {\n\tcolor: red;\n}\n",
			"utf8",
		);
		await writeFile(
			path.join(cwd, "src", "nav-tools.tsx"),
			[
				"export function NavTools() {",
				"\treturn (",
				"\t\t<button",
				"\t\t\ttype=\"button\"",
				"\t\t\taria-pressed={bgm.on}",
				"\t\t/>",
				"\t)",
				"}",
			].join("\n") + "\n",
			"utf8",
		);

		// Second header is indented, which previously failed to match and made the
		// TSX hunk get searched inside site.css.
		const patchText = [
			"*** Begin Patch",
			"*** Update File: src/site.css",
			"@@",
			"-\tcolor: red;",
			"+\tcolor: blue;",
			"  *** Update File: src/nav-tools.tsx",
			"@@",
			" \t\t\ttype=\"button\"",
			"-\t\t\taria-pressed={bgm.on}",
			"+\t\t\taria-pressed={bgm.on}",
			"+\t\t\tonClick={() => setBgmOn(!bgm.on)}",
			"*** End " + "Patch",
		].join("\n");

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 2);
		assert.ok(
			(await readFile(path.join(cwd, "src", "site.css"), "utf8")).includes("color: blue;"),
		);
		assert.ok(
			(await readFile(path.join(cwd, "src", "nav-tools.tsx"), "utf8")).includes(
				"onClick={() => setBgmOn(!bgm.on)}",
			),
		);
	});

	it("accepts missing space, extra asterisks, and backticked paths in headers", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "a.txt"), "a\n", "utf8");
		await writeFile(path.join(cwd, "b.txt"), "b\n", "utf8");
		await writeFile(path.join(cwd, "c.txt"), "c\n", "utf8");

		const result = await applyPatch(
			[
				"*** Begin Patch",
				"***Update File: a.txt",
				"@@",
				"-a",
				"+a2",
				"**** Update File: `b.txt`",
				"@@",
				"-b",
				"+b2",
				"*** Update File : c.txt",
				"@@",
				"-c",
				"+c2",
				"*** End " + "Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(result.filesChanged, 3);
		assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "a2\n");
		assert.equal(await readFile(path.join(cwd, "b.txt"), "utf8"), "b2\n");
		assert.equal(await readFile(path.join(cwd, "c.txt"), "utf8"), "c2\n");
	});

	it("treats a prefixed header as content when it is part of a file body", async () => {
		const cwd = await makeTempDir();

		const result = await applyPatch(
			[
				"*** Begin Patch",
				"*** Add File: guide.md",
				"+Headers look like this:",
				"+*** Update File: example.ts",
				"+and they must stand alone.",
				"*** End " + "Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(result.filesChanged, 1);
		assert.equal(
			await readFile(path.join(cwd, "guide.md"), "utf8"),
			"Headers look like this:\n*** Update File: example.ts\nand they must stand alone.\n",
		);
	});

	it("tolerates blank lines between file sections", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "a.txt"), "a\n", "utf8");
		await writeFile(path.join(cwd, "b.txt"), "b\n", "utf8");

		const result = await applyPatch(
			[
				"*** Begin Patch",
				"",
				"*** Update File: a.txt",
				"@@",
				"-a",
				"+a2",
				"",
				"*** Update File: b.txt",
				"@@",
				"-b",
				"+b2",
				"*** End " + "Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(result.filesChanged, 2);
		assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "a2\n");
		assert.equal(await readFile(path.join(cwd, "b.txt"), "utf8"), "b2\n");
	});
});

describe("line-number drift and comment tolerance", () => {
	it("rebases later hunk line hints by the net size change of earlier hunks", async () => {
		const cwd = await makeTempDir();
		// Two identical blocks: only a correctly rebased hint picks the right one.
		const lines: string[] = [];
		for (let i = 1; i <= 40; i++) lines.push(`filler ${i}`);
		lines.push("target();");
		for (let i = 41; i <= 80; i++) lines.push(`filler ${i}`);
		lines.push("target();");
		for (let i = 81; i <= 100; i++) lines.push(`filler ${i}`);
		await writeFile(path.join(cwd, "drift.ts"), lines.join("\n") + "\n", "utf8");

		// Hunk 1 inserts 30 lines well before the second "target();" at line 82.
		const inserted = Array.from({ length: 30 }, (_, i) => `+added ${i + 1}`);
		const result = await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: drift.ts",
				"@@ -41,1 +41,31 @@",
				"-target();",
				"+target();",
				...inserted,
				// Header still uses original-file numbering for the second target.
				"@@ -82,1 +112,1 @@",
				"-target();",
				"+target_second();",
				"*** End " + "Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(result.filesChanged, 1);
		const updated = (await readFile(path.join(cwd, "drift.ts"), "utf8")).split("\n");
		// The first target keeps its name; only the second one was renamed.
		assert.equal(updated[40], "target();");
		assert.equal(updated.filter((l) => l === "target_second();").length, 1);
		assert.equal(updated.filter((l) => l === "target();").length, 1);
		// The rename landed after the inserted block, i.e. at the second occurrence.
		assert.ok(updated.indexOf("target_second();") > updated.indexOf("added 30"));
	});

	it("applies a hunk whose quoted doc comment is paraphrased or truncated", async () => {
		const cwd = await makeTempDir();
		await writeFile(
			path.join(cwd, "store.ts"),
			[
				"/**",
				" * 挂载时的整体排布。",
				" * 负 delay 的意思是提前若干毫秒开始。",
				" * 这一段注释模型没有完整抄下来。",
				" */",
				"function layout(items: Item[]) {",
				"\treturn items;",
				"}",
			].join("\n") + "\n",
			"utf8",
		);

		const result = await applyPatch(
			[
				"*** Begin Patch",
				"*** Update File: store.ts",
				"@@ -73,19 +76,33 @@",
				" /**",
				"  * 挂载时的整体排布。",
				"  */",
				" function layout(items: Item[]) {",
				"-\treturn items;",
				"+\treturn items.slice();",
				" }",
				"*** End " + "Patch",
			].join("\n"),
			{ cwd },
		);

		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "store.ts"), "utf8");
		assert.ok(updated.includes("return items.slice();"));
		// Comment lines the patch omitted are preserved, not deleted.
		assert.ok(updated.includes(" * 负 delay 的意思是提前若干毫秒开始。"));
		assert.ok(updated.includes(" * 这一段注释模型没有完整抄下来。"));
	});

	it("refuses comment-tolerant alignment when the anchors are ambiguous", async () => {
		const cwd = await makeTempDir();
		// The paraphrased comment sits too deep for edge fuzzing to drop, so only the
		// comment-tolerant pass could match it - and it matches both blocks.
		const block = [
			"function f() {",
			"\tconst a = 1;",
			"\tconst b = 2;",
			"\t// note about c",
			"\tconst c = 3;",
			"\treturn c;",
			"}",
		].join("\n");
		await writeFile(path.join(cwd, "dup.ts"), `${block}\n\n${block}\n`, "utf8");

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: dup.ts",
					"@@",
					" function f() {",
					" \tconst a = 1;",
					" \tconst b = 2;",
					" \t// paraphrased note about c",
					" \tconst c = 3;",
					"-\treturn c;",
					"+\treturn c + 1;",
					" }",
					"*** End " + "Patch",
				].join("\n"),
				{ cwd },
			),
			/Patch context not found/,
		);
		assert.equal(await readFile(path.join(cwd, "dup.ts"), "utf8"), `${block}\n\n${block}\n`);
	});

	it("reports removal lines that comment-tolerant alignment could not find", async () => {
		const cwd = await makeTempDir();
		await writeFile(
			path.join(cwd, "keep.ts"),
			["function f() {", "\treturn 1;", "}"].join("\n") + "\n",
			"utf8",
		);

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: keep.ts",
					"@@",
					" function f() {",
					"-\t// this comment does not exist in the file",
					"-\treturn 1;",
					"+\treturn 2;",
					" }",
					"*** End " + "Patch",
				].join("\n"),
				{ cwd },
			),
			/would have been skipped/,
		);
			assert.equal(
				await readFile(path.join(cwd, "keep.ts"), "utf8"),
				["function f() {", "\treturn 1;", "}"].join("\n") + "\n",
			);
		});
	});

	describe("cancellation, truncation & diagnostics resilience", () => {
		it("aborts mid-apply and rolls back files that had already been modified", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "a.txt"), "original a\n", "utf8");
			await writeFile(path.join(cwd, "b.txt"), "original b\n", "utf8");

			const controller = new AbortController();
			await assert.rejects(
				applyPatch(
					[
						"*** Begin Patch",
						"*** Update File: a.txt",
						"@@",
						"-original a",
						"+updated a",
						"*** Update File: b.txt",
						"@@",
						"-original b",
						"+updated b",
						"*** End Patch",
					].join("\n"),
					{ cwd, signal: controller.signal },
					(progress) => {
						// Abort once the first file has been applied so rollback is exercised.
						if (progress.completedOperations >= 1) {
							controller.abort(new Error("user cancelled mid-apply"));
						}
					},
				),
				/apply_patch aborted: user cancelled mid-apply/,
			);

			assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "original a\n");
			assert.equal(await readFile(path.join(cwd, "b.txt"), "utf8"), "original b\n");
		});

		it("rejects a pre-aborted signal before touching any file", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "a.txt"), "original a\n", "utf8");

			const controller = new AbortController();
			controller.abort();

			await assert.rejects(
				applyPatch(
					[
						"*** Begin Patch",
						"*** Update File: a.txt",
						"@@",
						"-original a",
						"+updated a",
						"*** End Patch",
					].join("\n"),
					{ cwd, signal: controller.signal },
				),
				/apply_patch aborted/,
			);
			assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "original a\n");
		});

		it("reports 'no hunks' (not truncation) when End Patch is present with an empty action", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "test.ts"), "const x = 1;\n", "utf8");

			await assert.rejects(
				applyPatch(
					["*** Begin Patch", "*** Update File: test.ts", "*** End Patch"].join("\n"),
					{ cwd },
				),
				/Patch action has no hunks: test\.ts/,
			);
		});

		it("rejects truncated patch with unclosed hunk when End Patch is missing", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "test.ts"), "const x = 1;\n", "utf8");

			await assert.rejects(
				applyPatch(
					[
						"*** Begin Patch",
						"*** Update File: test.ts",
						"@@",
						"-const x = 1;",
						"+const x = 2;",
						"*** Update File: truncated.ts",
						"@@",
					].join("\n"),
					{ cwd },
				),
				/Patch appears truncated or incomplete/,
			);
		});

		it("accepts a move-only update action even when End Patch is omitted", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "origin.ts"), "content\n", "utf8");

			await applyPatch(
				["*** Begin Patch", "*** Update File: origin.ts", "*** Move to: renamed.ts"].join("\n"),
				{ cwd },
			);

			await assert.rejects(() => readFile(path.join(cwd, "origin.ts"), "utf8"));
			assert.equal(await readFile(path.join(cwd, "renamed.ts"), "utf8"), "content\n");
		});

		it("tolerates EOF newline mismatch when pattern has trailing empty line", async () => {
			const cwd = await makeTempDir();
			// File without trailing newline
			await writeFile(path.join(cwd, "no_eof_nl.txt"), "line1\nline2", "utf8");

			const patchText = [
				"*** Begin Patch",
				"*** Update File: no_eof_nl.txt",
				"@@",
				" line1",
				"-line2",
				"+line2 modified",
				" ",
				"*** End Patch",
			].join("\n");

			const result = await applyPatch(patchText, { cwd });
			assert.equal(result.filesChanged, 1);
			const updated = await readFile(path.join(cwd, "no_eof_nl.txt"), "utf8");
			assert.equal(updated, "line1\nline2 modified");
		});

		it("strips a trailing blank context line even when additions follow it", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "tail.txt"), "line1", "utf8");

			await applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: tail.txt",
					"@@",
					" line1",
					" ",
					"+appended",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			);

			// The blank context line stood for the missing final newline; the
			// addition must land after the located context, not at the file top.
			assert.equal(await readFile(path.join(cwd, "tail.txt"), "utf8"), "line1\nappended");
		});

		it("rejects instead of silently relocating when quoted context cannot be located", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "relocate.txt"), "alpha\nbeta\n", "utf8");

			await assert.rejects(
				applyPatch(
					[
						"*** Begin Patch",
						"*** Update File: relocate.txt",
						"@@",
						" nonexistent context line",
						"+added",
						"*** End Patch",
					].join("\n"),
					{ cwd },
				),
				/Patch context not found/,
			);
			assert.equal(await readFile(path.join(cwd, "relocate.txt"), "utf8"), "alpha\nbeta\n");
		});

		it("includes actionable advice in hunk failure diagnostic", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");

			await assert.rejects(
				applyPatch(
					[
						"*** Begin Patch",
						"*** Update File: sample.txt",
						"@@",
						" completely nonexistent line 1",
						" completely nonexistent line 2",
						" completely nonexistent line 3",
						"-beta",
						"+beta updated",
						"*** End Patch",
					].join("\n"),
					{ cwd },
				),
				/Actionable Advice/,
			);
		});
	});

	describe("input validation & filesystem error paths", () => {
		it("rejects empty or whitespace-only input", async () => {
			const cwd = await makeTempDir();
			await assert.rejects(applyPatch("", { cwd }), /must be a non-empty string/);
			await assert.rejects(applyPatch("   \n  ", { cwd }), /must be a non-empty string/);
		});

		it("rejects input without a Begin Patch marker", async () => {
			const cwd = await makeTempDir();
			await assert.rejects(
				applyPatch("*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch", { cwd }),
				/Patch must start with '\*\*\* Begin Patch'/,
			);
		});

		it("rejects update on a nonexistent file with a readable error", async () => {
			const cwd = await makeTempDir();
			await assert.rejects(
				applyPatch(
					"*** Begin Patch\n*** Update File: missing.ts\n@@\n-a\n+b\n*** End Patch",
					{ cwd },
				),
				/ENOENT|no such file/,
			);
		});

		it("rejects delete on a nonexistent file", async () => {
			const cwd = await makeTempDir();
			await assert.rejects(
				applyPatch("*** Begin Patch\n*** Delete File: missing.ts\n*** End Patch", { cwd }),
				/ENOENT|no such file/,
			);
		});

		it("rejects an Add File with no content lines", async () => {
			const cwd = await makeTempDir();
			await assert.rejects(
				applyPatch(
					"*** Begin Patch\n*** Add File: empty.txt\n*** End Patch",
					{ cwd },
				),
				/Patch action has no hunks: empty\.txt/,
			);
		});

		it("move to the same path applies the content update without renaming", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "same.ts"), "old\n", "utf8");

			await applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: same.ts",
					"*** Move to: same.ts",
					"@@",
					"-old",
					"+new",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			);

			assert.equal(await readFile(path.join(cwd, "same.ts"), "utf8"), "new\n");
		});

		it("normalizes lone-CR line endings to LF on update", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "cr.txt"), "alpha\rbeta\rgamma\r", "utf8");

			await applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: cr.txt",
					"@@",
					"-beta",
					"+BETA",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			);

			// normalizeText converts lone CR to LF and detectLineEnding falls back to LF
			assert.equal(await readFile(path.join(cwd, "cr.txt"), "utf8"), "alpha\nBETA\ngamma\n");
		});

		it("emits one progress event per operation in order", async () => {
			const cwd = await makeTempDir();
			await writeFile(path.join(cwd, "p1.txt"), "a\n", "utf8");
			await writeFile(path.join(cwd, "p2.txt"), "b\n", "utf8");

			const events: number[] = [];
			await applyPatch(
				[
					"*** Begin Patch",
					"*** Update File: p1.txt",
					"@@",
					"-a",
					"+a2",
					"*** Update File: p2.txt",
					"@@",
					"-b",
					"+b2",
					"*** End Patch",
				].join("\n"),
				{ cwd },
				(progress) => events.push(progress.completedOperations),
			);

			assert.deepEqual(events, [0, 1, 2]);
		});
	});
