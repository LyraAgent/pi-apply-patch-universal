import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, describe, it } from "node:test";
import {
	applyPatch,
	combineFileDiffs,
	generateNumberedDiff,
	parseApplyPatch,
} from "../src/patch.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-universal-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("generateNumberedDiff", () => {
	it("generates line numbers for addition", () => {
		const diff = generateNumberedDiff("", "line1\nline2\nline3");
		assert.equal(diff.firstChangedLine, 1);
		assert.equal(
			diff.diff,
			"+1 line1\n+2 line2\n+3 line3",
		);
	});

	it("generates line numbers for removal", () => {
		const diff = generateNumberedDiff("line1\nline2", "");
		assert.equal(diff.firstChangedLine, 1);
		assert.equal(
			diff.diff,
			"-1 line1\n-2 line2",
		);
	});

	it("generates line numbers and context for modification", () => {
		const oldContent = "c1\nc2\nold\nc3\nc4";
		const newContent = "c1\nc2\nnew1\nnew2\nc3\nc4";
		const diff = generateNumberedDiff(oldContent, newContent, 2);
		assert.equal(diff.firstChangedLine, 3);
		assert.equal(
			diff.diff,
			" 1 c1\n 2 c2\n-3 old\n+3 new1\n+4 new2\n 4 c3\n 5 c4",
		);
	});

	it("uses bounded memory for large numbered diffs", () => {
		const oldLines = Array.from({ length: 1_100 }, (_, index) => `line ${index + 1}`);
		const newLines = [...oldLines];
		newLines[549] = "line 550 updated";

		const diff = generateNumberedDiff(oldLines.join("\n"), newLines.join("\n"), 2);
		assert.equal(diff.firstChangedLine, 550);
		assert.ok(diff.diff.includes("- 550 line 550"));
		assert.ok(diff.diff.includes("+ 550 line 550 updated"));
		assert.ok(diff.diff.includes(" 549 line 549"));
		assert.ok(diff.diff.includes(" 551 line 551"));
	});
});

describe("parseApplyPatch", () => {
	it("parses multi-file patch with Add, Update, and Delete", () => {
		const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: src/a.ts
+const a = 1;
*** Update File: src/b.ts
@@
-const b = 0;
+const b = 2;
*** Delete File: src/c.ts
*** End Patch`);

		assert.equal(parsed.actions.length, 3);
		assert.equal(parsed.actions[0]?.kind, "add");
		assert.equal(parsed.actions[1]?.kind, "update");
		assert.equal(parsed.actions[2]?.kind, "delete");
	});
});

describe("applyPatch execution with diff line numbers", () => {
	it("executes multi-file patch and returns diffs with line numbers", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "app.ts"), "const v = 1;\nconsole.log(v);\n", "utf8");
		await writeFile(path.join(cwd, "old.ts"), "obsolete\n", "utf8");

		const progressEvents: any[] = [];
		const result = await applyPatch(
			`*** Begin Patch
*** Add File: new.ts
+export const greeting = "hello";
*** Update File: app.ts
@@
-const v = 1;
+const v = 2;
*** Delete File: old.ts
*** End Patch`,
			{ cwd },
			(progress) => progressEvents.push(progress),
		);

		assert.equal(result.filesChanged, 3);
		assert.equal(result.files.length, 3);
		assert.equal(result.fileDiffs.length, 3);

		// Verify fileDiffs have line numbers
		const addDiff = result.fileDiffs.find((f) => f.path === "new.ts");
		assert.ok(addDiff);
		assert.equal(addDiff.operation, "add");
		assert.equal(addDiff.added, 1);
		assert.equal(addDiff.removed, 0);
		assert.ok(addDiff.diff.includes("+1 export const greeting = \"hello\";"));

		const updateDiff = result.fileDiffs.find((f) => f.path === "app.ts");
		assert.ok(updateDiff);
		assert.equal(updateDiff.operation, "update");
		assert.equal(updateDiff.added, 1);
		assert.equal(updateDiff.removed, 1);
		assert.ok(updateDiff.diff.includes("-1 const v = 1;"));
		assert.ok(updateDiff.diff.includes("+1 const v = 2;"));

		// Verify disk state
		assert.equal(await readFile(path.join(cwd, "new.ts"), "utf8"), "export const greeting = \"hello\";\n");
		assert.equal(await readFile(path.join(cwd, "app.ts"), "utf8"), "const v = 2;\nconsole.log(v);\n");
		await assert.rejects(async () => await readFile(path.join(cwd, "old.ts"), "utf8"));

		// Verify progress events were emitted
		assert.ok(progressEvents.length > 0);
	});

	it("rolls back previous files when later hunk fails", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "f1.ts"), "original f1\n", "utf8");

		await assert.rejects(
			async () => {
				await applyPatch(
					`*** Begin Patch
*** Add File: f2.ts
+new content
*** Update File: f1.ts
@@
-non-existent context
+replacement
*** End Patch`,
					{ cwd },
				);
			},
			/Patch context not found/
		);

		// f1 should remain unchanged
		assert.equal(await readFile(path.join(cwd, "f1.ts"), "utf8"), "original f1\n");
		// f2 should be cleaned up / rolled back
		await assert.rejects(async () => await readFile(path.join(cwd, "f2.ts"), "utf8"));
	});

	it("tolerates blank lines without leading space and un-prefixed context lines in update", async () => {
		const cwd = await makeTempDir();
		await writeFile(
			path.join(cwd, "model.ts"),
			"export interface User {\n\tname: string;\n\n\tage: number;\n}\n",
			"utf8",
		);

		// Notice the completely empty line \n\n without leading space, and un-prefixed context line
		const patchText = `*** Begin Patch
*** Update File: model.ts
@@
export interface User {
\tname: string;

-\tage: number;
+\tage: number;
+\temail: string;
}
*** End Patch`;

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const updated = await readFile(path.join(cwd, "model.ts"), "utf8");
		assert.equal(
			updated,
			"export interface User {\n\tname: string;\n\n\tage: number;\n\temail: string;\n}\n",
		);
	});

	it("tolerates a '+' prefixed end marker instead of writing it into the file", async () => {
		const cwd = await makeTempDir();

		const result = await applyPatch(
			`*** Begin Patch
*** Add File: generate.py
+print("hello")
+*** End Patch`,
			{ cwd },
		);

		assert.equal(result.filesChanged, 1);
		assert.equal(await readFile(path.join(cwd, "generate.py"), "utf8"), 'print("hello")\n');
	});

	it("keeps literal end-marker text inside file bodies when a real end marker follows", async () => {
		const cwd = await makeTempDir();

		const result = await applyPatch(
			`*** Begin Patch
*** Add File: docs.md
+Finish patches with:
+*** End Patch
*** End Patch`,
			{ cwd },
		);

		assert.equal(result.filesChanged, 1);
		assert.equal(
			await readFile(path.join(cwd, "docs.md"), "utf8"),
			"Finish patches with:\n*** End Patch\n",
		);
	});

	it("tolerates markdown code fences wrapping the patch", async () => {
		const cwd = await makeTempDir();
		await writeFile(path.join(cwd, "test.txt"), "hello world\n", "utf8");

		const patchText = `Here is the patch you requested:
\`\`\`patch
*** Begin Patch
*** Update File: test.txt
@@
-hello world
+hello universe
*** End Patch
\`\`\`
Done!`;

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		assert.equal(await readFile(path.join(cwd, "test.txt"), "utf8"), "hello universe\n");
	});

	it("tolerates add file with blank lines without + prefix", async () => {
		const cwd = await makeTempDir();

		const patchText = `*** Begin Patch
*** Add File: created.ts
+function fn1() {
+\treturn 1;
+}

+function fn2() {
+\treturn 2;
+}
*** End Patch`;

		const result = await applyPatch(patchText, { cwd });
		assert.equal(result.filesChanged, 1);
		const content = await readFile(path.join(cwd, "created.ts"), "utf8");
		assert.equal(content, "function fn1() {\n\treturn 1;\n}\n\nfunction fn2() {\n\treturn 2;\n}\n");
	});
});