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

	it("refuses to overwrite existing Add File and Move targets", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "existing.txt"), "keep add target\n", "utf8");

		await assert.rejects(
			applyPatch(
				[
					"*** Begin Patch",
					"*** Add File: existing.txt",
					"+replacement",
					"*** End Patch",
				].join("\n"),
				{ cwd },
			),
			/Add File refuses to overwrite existing path/,
		);
		assert.equal(await readFile(path.join(cwd, "existing.txt"), "utf8"), "keep add target\n");

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
