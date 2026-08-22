import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
